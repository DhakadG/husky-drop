// share-index jobs (design spec §2, §4, §8.3): walk a share's Drive tree in
// bounded chunks, keep per-folder stats in R2, pre-warm thumbnails into the
// media cache ladder, and answer folder stats without touching Drive.
//
// Storage (KV writes are the scarce resource - spec §8.1):
//   KV  share-index:jobs        { jobs: [last 20 records] } - written when a
//                               job starts and when it ends, never per chunk
//   KV  share-stats:<slug>      { r2Key, generatedAt, complete, lastFullAt,
//                               needsReindex?, changed? } - start/finish only
//   R2  stats/<slug>.json       folders: { <folderId>: {name, path, parent,
//                               root, files, photos, videos, bytes, oldest,
//                               newest, subfolders, cover} }
//   R2  stats/<slug>.files.json files: [{id, f (folder), n, s, m, t, r, th, w}]
//   R2  stats/<slug>.job.json   the running job's cursor + progress (per chunk)
//
// Every chunk stops after ~INDEX_CHUNK subrequests (40 by default, under
// the Free plan's 50), writes what it has so already-walked folders show
// real numbers, saves its cursor and re-invokes itself. Paid raises the
// chunk size; the code never asks which plan it is on.

import { driveFileMeta, driveFileMetaCached, driveListFolder, driveTrashFile } from "./drive.js";
import { previewIndex } from "./previews.js";
import { cleanText, json, sha256 } from "./util.js";
import { mediaRev, mediaThumbs } from "./media-cache.js";
import { appLog } from "./applog.js";
import { dispatchSharePreviews } from "./share-previews.js";
import { liveStub } from "./store.js";

export const JOBS_KEY = "share-index:jobs";
const JOBS_KEPT = 20;
const MAX_CHUNKS = 5000;
const SKIP_FOLDERS = /^_(archive|compressed|previews)$/;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const isPhoto = (mime) => /^image\//.test(mime || "");
const isVideo = (mime) => /^video\//.test(mime || "");

export const chunkBudget = (env) => Math.max(8, Math.min(9000, Number(env.INDEX_CHUNK) || 40));
// Wall-clock cap per chunk. Background work (ctx.waitUntil) is cut off at
// 30 s, so a chunk must hand over well before that whatever the plan's
// subrequest limit allows.
export const chunkMs = (env) => Math.max(3000, Math.min(25_000, Number(env.INDEX_CHUNK_MS) || 20_000));
const makeBudget = (env, reserve) => {
  const b = { left: chunkBudget(env) - reserve, deadline: Date.now() + chunkMs(env) };
  b.ok = (need = 1) => b.left >= need && Date.now() < b.deadline;
  return b;
};
export const statsPointerKey = (slug) => `share-stats:${slug}`;
const foldersKey = (slug) => `stats/${slug}.json`;
const filesKey = (slug) => `stats/${slug}.files.json`;
const jobKey = (slug) => `stats/${slug}.job.json`;
export const loadJobs = async (env) => ((await env.KV.get(JOBS_KEY, "json")) || {}).jobs || [];
export const saveJobs = (env, jobs) => env.KV.put(JOBS_KEY, JSON.stringify({ jobs: jobs.slice(0, JOBS_KEPT) }));

// Chunks of different shares run in parallel, and each wrote back the whole
// list it had read at its start (KV has no compare-and-set, and reads may be
// a minute stale): a job's "done" was overwritten with "running" and it
// stayed running for days. Changes are now sent as ops - {add: job} or
// {patch: {id, ...fields}} - and applied by the LiveTracker Durable Object
// to a fresh read, one batch at a time.
export async function applyJobOps(env, ops) {
  const jobs = await loadJobs(env);
  for (const op of ops) {
    if (op.add && !jobs.some((j) => j.id === op.add.id)) jobs.unshift(op.add);
    if (op.patch) Object.assign(jobs.find((j) => j.id === op.patch.id) || {}, op.patch);
  }
  await saveJobs(env, jobs);
  return { ok: true };
}
async function jobOp(env, op) {
  if (!env.LIVE_TRACKER) return applyJobOps(env, [op]);
  const r = await liveStub(env).fetch("https://live.internal/share-index-jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(op) });
  if (!r.ok) throw new Error(`job list update failed (${r.status})`);
}
export const activeJobFor = (jobs, slug) => jobs.find((j) => j.slug === slug && j.status === "running") || null;

// ---- blobs ----
async function readJson(env, key) {
  const obj = await env.MEDIA_BUCKET?.get(key).catch(() => null);
  return obj ? obj.json().catch(() => null) : null;
}
const writeJson = (env, key, value) => env.MEDIA_BUCKET.put(key, JSON.stringify(value), { httpMetadata: { contentType: "application/json" } });

export async function loadStats(env, slug) {
  const pointer = await env.KV.get(statsPointerKey(slug), "json");
  if (!pointer?.r2Key) return { pointer, folders: null };
  const blob = await readJson(env, pointer.r2Key);
  return { pointer, folders: blob?.folders || null, generatedAt: blob?.generatedAt || pointer.generatedAt };
}
export const loadFiles = async (env, slug) => (await readJson(env, filesKey(slug)))?.files || [];

// Per-folder numbers from the file list (direct files only; the read path
// sums subtrees). Cover = newest photo with a thumbnail, else newest video.
export function folderStatsFrom(files, folderId, previous = {}) {
  const own = { ...previous, files: 0, photos: 0, videos: 0, bytes: 0, oldest: 0, newest: 0, cover: null };
  let rank = 0;
  for (const f of files) {
    if (f.f !== folderId) continue;
    own.files += 1;
    own.bytes += f.s || 0;
    if (isPhoto(f.m)) own.photos += 1;
    if (isVideo(f.m)) own.videos += 1;
    if (f.t && (!own.oldest || f.t < own.oldest)) own.oldest = f.t;
    if (f.t > own.newest) own.newest = f.t;
    const r = f.th ? (isPhoto(f.m) ? 2 : isVideo(f.m) ? 1 : 0) : 0;
    if (r && (r > rank || (r === rank && f.t > (own.cover?.t || 0)))) {
      rank = r;
      own.cover = { id: f.id, r: f.r, t: f.t };
    }
  }
  return own;
}

const fileRow = (f, folderId, prev) => {
  const r = mediaRev(f);
  return {
    id: f.id,
    f: folderId,
    n: cleanText(f.name || "", 200),
    s: Number(f.size) || 0,
    m: cleanText(f.mimeType || "", 100),
    t: Date.parse(f.modifiedTime || f.createdTime) || 0,
    r,
    th: f.thumbnailLink ? 1 : 0,
    // Warm marker survives a re-walk as long as the bytes did not change.
    w: prev && prev.r === r ? prev.w || 0 : 0,
    // Duration from Drive when it has finished processing the video; Drive
    // documents durationMillis as "may not be available immediately upon
    // upload", so a missing one is pending (dp), not final.
    d: Number(f.videoMediaMetadata?.durationMillis) || prev?.d || 0,
  };
};

// ---- job records ----
// Starts (or, when this share is already indexing, tops up) a job. The lock
// is per share (spec §4): other shares index independently.
export async function planShareIndex(env, ctx, share, { trigger = "manual", full = true, changed = [] } = {}) {
  if (!env.MEDIA_BUCKET) return { job: null, started: false, reason: "MEDIA_BUCKET not bound" };
  const jobs = await loadJobs(env);
  const active = activeJobFor(jobs, share.slug);
  if (active) {
    if (changed.length) {
      const state = (await readJson(env, jobKey(share.slug))) || {};
      state.changed = [...new Set([...(state.changed || []), ...changed])].slice(0, 2000);
      await writeJson(env, jobKey(share.slug), state);
    }
    return { job: active, started: false, reason: "already indexing" };
  }
  const isFull = full || !changed.length;
  const job = { id: `si-${Date.now().toString(36)}-${share.slug.slice(0, 12)}`, slug: share.slug, status: "running", trigger, full: isFull, createdAt: Date.now(), startedAt: Date.now() };
  await writeJson(env, jobKey(share.slug), {
    id: job.id,
    chunks: 0,
    updatedAt: Date.now(),
    progress: { folders: 0, files: 0, warmed: 0 },
    changed: isFull ? [] : changed.slice(0, 2000),
    phase: "walk",
    queue: isFull ? (share.folderIds || []).map((id, i) => ({ id, path: share.folderNames?.[i] || `Folder ${i + 1}`, parent: "", root: true })) : [],
    pageToken: "",
    warmAt: 0,
  });
  await jobOp(env, { add: job });
  appLog(env, ctx, { area: "share-index", message: `share ${share.slug}: ${isFull ? "full walk" : `targeted (${changed.length} changes)`} started (${trigger})` });
  return { job, started: true };
}

// One bounded chunk. Schedules the next one itself; the nightly cron picks
// up anything that was dropped (spec §8.3).
export async function runShareIndexChunk(env, ctx, jobId, request) {
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "running") return job || null;
  const finish = async (status, error) => {
    job.status = status;
    job.finishedAt = Date.now();
    if (error) job.error = cleanText(error, 200);
    const { id, finishedAt, progress, chunks } = job;
    await jobOp(env, { patch: { id, status, finishedAt, ...(error ? { error: job.error } : {}), ...(progress ? { progress } : {}), ...(chunks ? { chunks } : {}) } });
    return job;
  };
  const share = await env.KV.get(`share:${job.slug}`, "json");
  if (!share || !env.MEDIA_BUCKET) return finish("failed", !share ? "share gone" : "MEDIA_BUCKET not bound");
  const cur = await readJson(env, jobKey(job.slug));
  if (!cur || cur.id !== job.id) return finish("failed", "job cursor missing");
  const budget = makeBudget(env, 8); // blob reads + writes, job record
  try {
    const { pointer, folders } = await loadStats(env, job.slug);
    const state = { folders: folders || {}, files: await loadFiles(env, job.slug) };
    dropRemovedRoots(state, share.folderIds || []);
    // Changes folded into a running job (change feed while it walks or
    // warms) are applied whatever phase it is in; a folder they add is
    // queued and walked before the job may complete.
    if (cur.changed.length) await applyChanges(env, cur, state, budget);
    if (cur.queue.length && cur.phase !== "walk") cur.phase = "walk";
    if (cur.phase === "walk") await walkChunk(env, cur, state, budget);
    if (cur.phase === "warm") await warmChunk(env, cur, state, budget);
    // Preview entries that never got a duration (runs before the runner
    // reported one) are described from the preview file itself - one KV
    // write per chunk, only while there is something to backfill.
    if (state.previewsDirty) await env.KV.put("previews:index", JSON.stringify(state.previews));
    cur.chunks += 1;
    cur.updatedAt = Date.now();
    cur.progress.files = state.files.length;
    const complete = (cur.phase === "done" && !cur.changed.length && !cur.queue.length) || cur.chunks >= MAX_CHUNKS;
    // Stats are whole once the walk is over; warming thumbnails afterwards
    // does not change a single number, so readers need not wait for it.
    const walked = cur.phase !== "walk" || !!pointer?.complete;
    const generatedAt = Date.now();
    await Promise.all([
      writeJson(env, foldersKey(job.slug), { slug: job.slug, generatedAt, complete: walked, folders: state.folders }),
      writeJson(env, filesKey(job.slug), { slug: job.slug, generatedAt, files: state.files }),
      writeJson(env, jobKey(job.slug), cur),
    ]);
    // KV pointer: once when the blob first exists, once when the walk ends.
    if (!pointer?.r2Key || complete || (walked && !pointer?.complete)) {
      await env.KV.put(statsPointerKey(job.slug), JSON.stringify({ ...(pointer || {}), r2Key: foldersKey(job.slug), generatedAt, complete: walked, ...(walked && job.full && !pointer?.lastFullAt ? { lastFullAt: generatedAt } : {}), ...(complete && job.full ? { lastFullAt: generatedAt } : {}), ...(complete ? { needsReindex: false, changed: [] } : {}) }));
    }
    if (!complete) {
      scheduleNextChunk(env, ctx, job, request);
      return job;
    }
    job.progress = cur.progress;
    job.chunks = cur.chunks;
    await finish("done");
    appLog(env, ctx, { area: "share-index", message: `share ${job.slug}: indexed ${Object.keys(state.folders).length} folders, ${state.files.length} files, ${cur.progress.warmed} thumbnails warmed in ${cur.chunks} chunk(s)` });
    // Step 3 (spec §4): RAW / oversized previews are pixel work, so they go
    // to the GitHub runner; it exits at once when nothing is pending.
    if (job.full && env.GITHUB_TOKEN) ctx?.waitUntil?.(dispatchSharePreviews(env).catch(() => {}));
  } catch (error) {
    await finish("failed", error.message);
    appLog(env, ctx, { level: "error", area: "share-index", message: `share ${job.slug}: chunk failed`, detail: error.message });
  }
  return job;
}

// Continuation: the Worker calls its own continue route through the SELF
// service binding - a fresh invocation with a fresh subrequest budget. (A
// plain fetch() to our own hostname is refused by Cloudflare, error 1042.)
function scheduleNextChunk(env, ctx, job, request) {
  const origin = request ? new URL(request.url).origin : env.SELF_ORIGIN || "";
  if (!ctx?.waitUntil || !env.ADMIN_TOKEN || !origin) return;
  const target = env.SELF?.fetch ? env.SELF : globalThis;
  ctx.waitUntil(
    target.fetch(`${origin}/api/admin/share-index/jobs/${encodeURIComponent(job.id)}/continue`, { method: "POST", headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } })
      .then((r) => { if (!r.ok) console.warn("share-index continue refused", r.status); })
      .catch((error) => console.warn("share-index continue failed", String(error?.message || error))),
  );
}

// ---- phase: walk (queued folders, page by page; each page = 1 subrequest) ----
async function walkChunk(env, cur, state, budget) {
  while (cur.queue.length && budget.ok(1)) {
    const node = cur.queue[0];
    if (!cur.pageToken) {
      // Fresh walk of this folder: its old direct files are replaced as the
      // pages come in; its subfolder list is rebuilt.
      cur.prevRows = Object.fromEntries(state.files.filter((f) => f.f === node.id).map((f) => [f.id, f]));
      state.files = state.files.filter((f) => f.f !== node.id);
      state.folders[node.id] = { ...(state.folders[node.id] || {}), name: node.path.split("/").pop(), path: node.path, parent: node.parent, root: !!node.root, subfolders: [] };
    }
    const page = await driveListFolder(env, node.id, cur.pageToken, { pageSize: 1000 });
    budget.left -= 1;
    for (const f of page.files || []) {
      if (f.mimeType === FOLDER_MIME) {
        if (SKIP_FOLDERS.test(f.name)) continue;
        state.folders[node.id].subfolders.push(f.id);
        if (!cur.queue.some((q) => q.id === f.id)) cur.queue.push({ id: f.id, path: `${node.path}/${f.name}`, parent: node.id });
        continue;
      }
      state.files.push(fileRow(f, node.id, cur.prevRows?.[f.id]));
    }
    cur.pageToken = page.nextPageToken || "";
    if (!cur.pageToken) {
      state.folders[node.id] = folderStatsFrom(state.files, node.id, state.folders[node.id]);
      cur.progress.folders += 1;
      cur.queue.shift();
      cur.prevRows = undefined;
    }
  }
  if (!cur.queue.length) {
    pruneUnreachable(state);
    cur.phase = "warm";
    cur.warmAt = 0;
  }
}

// A folder taken out of the share keeps root: true from earlier walks, so
// nothing would ever prune it; its files kept feeding the preview runners and
// kept its media out of the orphan sweep.
export function dropRemovedRoots(state, folderIds) {
  let dropped = false;
  for (const [id, folder] of Object.entries(state.folders)) {
    if (folder.root && !folderIds.includes(id)) {
      folder.root = false;
      dropped = true;
    }
  }
  if (dropped) pruneUnreachable(state);
}

// Folders that no root reaches any more (moved out, trashed) are dropped
// along with their files.
function pruneUnreachable(state) {
  const reachable = new Set();
  const stack = Object.entries(state.folders).filter(([, v]) => v.root).map(([k]) => k);
  while (stack.length) {
    const id = stack.pop();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const sub of state.folders[id]?.subfolders || []) if (state.folders[sub]) stack.push(sub);
  }
  for (const id of Object.keys(state.folders)) if (!reachable.has(id)) delete state.folders[id];
  state.files = state.files.filter((f) => reachable.has(f.f));
}

// ---- phase: targeted (spec §3.1) - only the ids the change feed named ----
async function applyChanges(env, cur, state, budget) {
  while (cur.changed.length && budget.ok(2)) {
    const id = cur.changed.shift();
    const meta = await driveFileMeta(env, id);
    budget.left -= 1;
    const parent = meta?.parents?.find((p) => state.folders[p]) || "";
    const gone = !meta?.id || meta.trashed || !parent;
    if (state.folders[id] || meta?.mimeType === FOLDER_MIME) {
      for (const folder of Object.values(state.folders)) folder.subfolders = (folder.subfolders || []).filter((s) => s !== id);
      if (gone || SKIP_FOLDERS.test(meta?.name || "")) {
        if (!state.folders[id]?.root) pruneUnreachable(state);
      } else {
        state.folders[parent].subfolders.push(id);
        // New or moved folder: (re)walk its subtree.
        cur.queue.push({ id, path: `${state.folders[parent].path}/${meta.name}`, parent });
      }
      continue;
    }
    const prev = state.files.find((f) => f.id === id);
    const touched = new Set(prev ? [prev.f] : []);
    state.files = state.files.filter((f) => f.id !== id);
    if (!gone) {
      state.files.push(fileRow(meta, parent, prev));
      touched.add(parent);
    }
    for (const folderId of touched) if (state.folders[folderId]) state.folders[folderId] = folderStatsFrom(state.files, folderId, state.folders[folderId]);
  }
  if (!cur.changed.length && !cur.queue.length && cur.phase === "walk") {
    cur.phase = "warm";
    cur.warmAt = 0;
  }
}

// ---- phase: warm (spec §4 step 2) - thumbnails into R2, lo always, hi when large ----
// A few files at a time: each one is a Drive round trip, and doing them one
// after another made a 23k-file library take hours instead of minutes.
const WARM_PARALLEL = 6;
async function warmChunk(env, cur, state, budget) {
  const files = state.files;
  while (cur.warmAt < files.length && budget.ok(4 * WARM_PARALLEL)) {
    const batch = [];
    while (cur.warmAt < files.length && batch.length < WARM_PARALLEL) {
      const f = files[cur.warmAt];
      cur.warmAt += 1;
      if (isVideo(f.m) && !f.d) batch.push(f);
      else if (!f.w && f.th && (isPhoto(f.m) || isVideo(f.m))) batch.push(f);
    }
    await Promise.all(batch.map(async (f) => {
      if (isVideo(f.m)) await backfillDuration(env, state, f, budget);
      if (f.w || !f.th || !(isPhoto(f.m) || isVideo(f.m))) return;
      // Thumbnails are warmed as WebP by the GitHub runner (dispatched when
      // this job completes); the Worker only fills JPEG on a live cold miss.
      f.w = 1;
    }));
  }
  if (cur.warmAt >= files.length) cur.phase = "done";
}

// A video tile shows "video" instead of a length when Drive never described
// the original and the preview was made before durations were reported.
// The 720p preview is a plain MP4 Drive is happy to describe, so ask once.
async function backfillDuration(env, state, f, budget) {
  if (f.d) return;
  // Drive may have finished processing since the walk listed this file.
  const own = await driveFileMetaCached(env, f.id);
  budget.left -= 1;
  const ownMs = Number(own?.videoMediaMetadata?.durationMillis) || 0;
  if (ownMs) {
    f.d = ownMs;
    return;
  }
  if (!state.previews) state.previews = await previewIndex(env);
  const entry = state.previews.files[f.id];
  if (!entry?.id) return;
  if (entry.ms) {
    f.d = entry.ms;
    return;
  }
  const meta = await driveFileMetaCached(env, entry.id);
  budget.left -= 1;
  const ms = Number(meta?.videoMediaMetadata?.durationMillis) || 0;
  if (!ms) return;
  entry.ms = ms;
  if (!entry.w && meta.videoMediaMetadata.width) {
    entry.w = Number(meta.videoMediaMetadata.width) || 0;
    entry.h = Number(meta.videoMediaMetadata.height) || 0;
  }
  f.d = ms;
  state.previewsDirty = true;
}

// ---- read path (spec §2.5): KV pointer -> R2 blob, never Drive ----
// Folder ids never reach the client: keys are the same stable fid the
// listing uses, so the gallery can decorate its folder cards.
export async function folderFid(env, folderId) {
  return (await sha256(`fid:${folderId}:${env.SHARE_SIGNING_KEY || env.ADMIN_TOKEN || "dev"}`)).slice(0, 16);
}

export function subtreeTotals(folders, id, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  const own = folders[id];
  const total = { files: own?.files || 0, photos: own?.photos || 0, videos: own?.videos || 0, bytes: own?.bytes || 0, folders: 0, oldest: own?.oldest || 0, newest: own?.newest || 0 };
  memo.set(id, total); // cycle guard
  for (const sub of own?.subfolders || []) {
    if (!folders[sub]) continue;
    const t = subtreeTotals(folders, sub, memo);
    total.files += t.files;
    total.photos += t.photos;
    total.videos += t.videos;
    total.bytes += t.bytes;
    total.folders += 1 + t.folders;
    if (t.oldest && (!total.oldest || t.oldest < total.oldest)) total.oldest = t.oldest;
    if (t.newest > total.newest) total.newest = t.newest;
  }
  return total;
}

// Public stats for one share: every folder, keyed by fid, with subtree
// totals and a cover thumbnail URL. One call per page load. Names are not
// included - the listing already carries them, escaped on render.
export async function shareStatsPayload(env, share) {
  const { pointer, folders, generatedAt } = await loadStats(env, share.slug);
  if (!pointer?.r2Key || !folders) return { indexed: false, folders: {} };
  const memo = new Map();
  const out = {};
  for (const [id, folder] of Object.entries(folders)) {
    const totals = subtreeTotals(folders, id, memo);
    const cover = folder.cover?.id ? (await mediaThumbs(env, share, { id: folder.cover.id, rev: folder.cover.r })).thumbs.base : "";
    out[await folderFid(env, id)] = { ...totals, cover };
  }
  return { indexed: true, generatedAt, complete: pointer.complete !== false, folders: out };
}

// Summary for the folders the viewer is looking at, from the blob - the
// replacement for the Drive walk in shareSummary. null = not indexed yet.
export async function summaryFromStats(env, share, folderIds) {
  const { pointer, folders, generatedAt } = await loadStats(env, share.slug);
  if (!pointer?.r2Key || !folders || pointer.complete === false) return null;
  const memo = new Map();
  const sum = { files: 0, folders: 0, bytes: 0, images: 0, videos: 0, indexedAt: generatedAt };
  for (const id of folderIds) {
    if (!folders[id]) return null;
    const t = subtreeTotals(folders, id, memo);
    sum.files += t.files;
    sum.folders += t.folders;
    sum.bytes += t.bytes;
    sum.images += t.photos;
    sum.videos += t.videos;
  }
  return sum;
}

// ---- admin ----
export async function listShareIndexJobs(env) {
  const jobs = await loadJobs(env);
  const active = jobs.filter((j) => j.status === "running");
  const progress = await Promise.all(active.map((j) => readJson(env, jobKey(j.slug))));
  return json({
    jobs: jobs.map((j) => ({ ...j, progress: j.progress || progress[active.indexOf(j)]?.progress, chunks: j.chunks ?? progress[active.indexOf(j)]?.chunks })),
    chunk: chunkBudget(env),
    bucket: !!env.MEDIA_BUCKET,
  });
}

export async function shareIndexStatus(env, slug) {
  const [pointer, jobs] = await Promise.all([env.KV.get(statsPointerKey(slug), "json"), loadJobs(env)]);
  const active = activeJobFor(jobs, slug);
  const cur = active ? await readJson(env, jobKey(slug)) : null;
  return { pointer: pointer || null, active: active && { ...active, progress: cur?.progress, chunks: cur?.chunks }, last: jobs.find((j) => j.slug === slug && j.status !== "running") || null };
}

// Admin "which folders have no stats" (loose-ends spec §4): subfolders a
// parent lists that never got walked, plus folders that are simply empty -
// the two reasons a tile is icon-only after a completed index.
export async function shareIndexGaps(env, slug) {
  const { folders } = await loadStats(env, slug);
  if (!folders) return { indexed: false, missing: [], empty: [] };
  const missing = [];
  const empty = [];
  for (const [id, folder] of Object.entries(folders)) {
    for (const sub of folder.subfolders || []) if (!folders[sub]) missing.push({ id: sub, parent: folder.path });
    if (!folder.files && !(folder.subfolders || []).length) empty.push({ id, path: folder.path });
  }
  return { indexed: true, folders: Object.keys(folders).length, missing, empty };
}

// Used by the change feed: every file and folder id this share knows.
export async function knownIds(env, slug) {
  const [{ folders }, files] = await Promise.all([loadStats(env, slug), loadFiles(env, slug)]);
  return { folderIds: new Set(Object.keys(folders || {})), fileIds: new Set(files.map((f) => f.id)) };
}

// ---- dedupe (admin) ----
// Identical files (same Drive md5 + size) inside one folder subtree of an
// indexed share: the oldest copy stays, the rest go to Drive's trash (30-day
// recoverable), and a targeted job drops them from the index. Name-only
// matches are reported, never touched. dryRun lists without trashing.
export async function dedupeShareFolder(env, ctx, request, { slug, folder, dryRun = true, limit = 200 }) {
  const share = await env.KV.get(`share:${slug}`, "json");
  if (!share) return { error: "share not found", status: 404 };
  const { folders } = await loadStats(env, slug);
  if (!folders) return { error: "share is not indexed yet", status: 409 };
  const rootId = folders[folder] ? folder : Object.keys(folders).find((id) => folders[id].path === folder || folders[id].name === folder);
  if (!rootId) return { error: "folder not found in the index", status: 404 };
  const inTree = new Set([rootId]);
  const stack = [rootId];
  while (stack.length) for (const sub of folders[stack.pop()]?.subfolders || []) if (folders[sub] && !inTree.has(sub)) { inTree.add(sub); stack.push(sub); }
  const rows = (await loadFiles(env, slug)).filter((f) => inTree.has(f.f));
  const byContent = new Map();
  const byName = new Map();
  for (const f of rows) {
    if (!f.r.startsWith("m")) {
      const k = `${f.r}|${f.s}`;
      if (!byContent.has(k)) byContent.set(k, []);
      byContent.get(k).push(f);
    }
    const nk = `${f.n.toLowerCase()}|${f.s}`;
    if (!byName.has(nk)) byName.set(nk, []);
    byName.get(nk).push(f);
  }
  const groups = [...byContent.values()].filter((g) => g.length > 1).map((g) => g.sort((a, b) => a.t - b.t));
  const nameOnly = [...byName.values()].filter((g) => g.length > 1 && new Set(g.map((f) => f.r)).size > 1).map((g) => g.map((f) => ({ id: f.id, name: f.n, size: f.s, at: f.t })));
  const doomed = groups.flatMap((g) => g.slice(1)).slice(0, limit);
  const bytes = doomed.reduce((t, f) => t + f.s, 0);
  let trashed = 0;
  const failed = [];
  if (!dryRun) {
    for (const f of doomed) {
      if (await driveTrashFile(env, f.id)) trashed += 1;
      else failed.push(f.n);
    }
    if (trashed) {
      const { job, started } = await planShareIndex(env, ctx, share, { trigger: "dedupe", full: false, changed: doomed.map((f) => f.id) });
      if (started && job) ctx?.waitUntil?.(runShareIndexChunk(env, ctx, job.id, request));
      appLog(env, ctx, { area: "share-index", message: `dedupe ${slug} / ${folders[rootId].path}: trashed ${trashed} duplicate copies (${(bytes / 1e6).toFixed(0)} MB)${failed.length ? `, ${failed.length} failed` : ""}` });
    }
  }
  return {
    folder: { id: rootId, path: folders[rootId].path },
    scanned: rows.length,
    groups: groups.length,
    duplicates: doomed.length,
    bytes,
    trashed,
    failed,
    sample: groups.slice(0, 25).map((g) => g.map((f) => ({ id: f.id, name: f.n, size: f.s, at: f.t, keep: f === g[0] }))),
    nameOnly: nameOnly.slice(0, 25),
    dryRun,
  };
}
