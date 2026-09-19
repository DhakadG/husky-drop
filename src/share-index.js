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

import { driveFileMeta, driveFileMetaCached, driveListFolder } from "./drive.js";
import { previewIndex } from "./previews.js";
import { cleanText, json, sha256 } from "./util.js";
import { mediaRev, mediaThumbs, warmMedia } from "./media-cache.js";
import { appLog } from "./applog.js";

export const JOBS_KEY = "share-index:jobs";
const JOBS_KEPT = 20;
const MAX_CHUNKS = 5000;
const SKIP_FOLDERS = /^_(archive|compressed|previews)$/;
const FOLDER_MIME = "application/vnd.google-apps.folder";
const isPhoto = (mime) => /^image\//.test(mime || "");
const isVideo = (mime) => /^video\//.test(mime || "");
// Photos this large get the 1600px tier warmed too (spec §4: "high-res for
// anything actually large enough to matter").
const HI_RES_BYTES = 3 * 1024 * 1024;

export const chunkBudget = (env) => Math.max(8, Math.min(9000, Number(env.INDEX_CHUNK) || 40));
export const statsPointerKey = (slug) => `share-stats:${slug}`;
const foldersKey = (slug) => `stats/${slug}.json`;
const filesKey = (slug) => `stats/${slug}.files.json`;
const jobKey = (slug) => `stats/${slug}.job.json`;
export const loadJobs = async (env) => ((await env.KV.get(JOBS_KEY, "json")) || {}).jobs || [];
export const saveJobs = (env, jobs) => env.KV.put(JOBS_KEY, JSON.stringify({ jobs: jobs.slice(0, JOBS_KEPT) }));
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
    d: prev?.d || 0,
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
  jobs.unshift(job);
  await saveJobs(env, jobs);
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
    await saveJobs(env, jobs);
    return job;
  };
  const share = await env.KV.get(`share:${job.slug}`, "json");
  if (!share || !env.MEDIA_BUCKET) return finish("failed", !share ? "share gone" : "MEDIA_BUCKET not bound");
  const cur = await readJson(env, jobKey(job.slug));
  if (!cur || cur.id !== job.id) return finish("failed", "job cursor missing");
  const budget = { left: chunkBudget(env) - 8 }; // blob reads + writes, job record
  try {
    const { pointer, folders } = await loadStats(env, job.slug);
    const state = { folders: folders || {}, files: await loadFiles(env, job.slug) };
    if (cur.phase === "walk" && cur.changed.length) await applyChanges(env, cur, state, budget);
    if (cur.phase === "walk") await walkChunk(env, cur, state, budget);
    if (cur.phase === "warm") await warmChunk(env, cur, state, budget);
    // Preview entries that never got a duration (runs before the runner
    // reported one) are described from the preview file itself - one KV
    // write per chunk, only while there is something to backfill.
    if (state.previewsDirty) await env.KV.put("previews:index", JSON.stringify(state.previews));
    cur.chunks += 1;
    cur.updatedAt = Date.now();
    cur.progress.files = state.files.length;
    const complete = cur.phase === "done" || cur.chunks >= MAX_CHUNKS;
    const generatedAt = Date.now();
    await Promise.all([
      writeJson(env, foldersKey(job.slug), { slug: job.slug, generatedAt, complete: complete || !!pointer?.complete, folders: state.folders }),
      writeJson(env, filesKey(job.slug), { slug: job.slug, generatedAt, files: state.files }),
      writeJson(env, jobKey(job.slug), cur),
    ]);
    // KV pointer: once when the blob first exists, once when the walk ends.
    if (!pointer?.r2Key || complete) {
      await env.KV.put(statsPointerKey(job.slug), JSON.stringify({ ...(pointer || {}), r2Key: foldersKey(job.slug), generatedAt, complete: complete || !!pointer?.complete, ...(complete && job.full ? { lastFullAt: generatedAt } : {}), ...(complete ? { needsReindex: false, changed: [] } : {}) }));
    }
    if (!complete) {
      scheduleNextChunk(env, ctx, job, request);
      return job;
    }
    job.progress = cur.progress;
    job.chunks = cur.chunks;
    await finish("done");
    appLog(env, ctx, { area: "share-index", message: `share ${job.slug}: indexed ${Object.keys(state.folders).length} folders, ${state.files.length} files, ${cur.progress.warmed} thumbnails warmed in ${cur.chunks} chunk(s)` });
  } catch (error) {
    await finish("failed", error.message);
    appLog(env, ctx, { level: "error", area: "share-index", message: `share ${job.slug}: chunk failed`, detail: error.message });
  }
  return job;
}

// Continuation: the Worker calls its own continue route - a fresh
// invocation with a fresh subrequest budget.
function scheduleNextChunk(env, ctx, job, request) {
  const origin = request ? new URL(request.url).origin : env.SELF_ORIGIN || "";
  if (!ctx?.waitUntil || !env.ADMIN_TOKEN || !origin) return;
  ctx.waitUntil(
    fetch(`${origin}/api/admin/share-index/jobs/${encodeURIComponent(job.id)}/continue`, { method: "POST", headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } })
      .catch((error) => console.warn("share-index continue failed", String(error?.message || error))),
  );
}

// ---- phase: walk (queued folders, page by page; each page = 1 subrequest) ----
async function walkChunk(env, cur, state, budget) {
  while (cur.queue.length && budget.left > 0) {
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
  while (cur.changed.length && budget.left > 1) {
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
  if (!cur.changed.length && !cur.queue.length) {
    cur.phase = "warm";
    cur.warmAt = 0;
  }
}

// ---- phase: warm (spec §4 step 2) - thumbnails into R2, lo always, hi when large ----
async function warmChunk(env, cur, state, budget) {
  const files = state.files;
  while (cur.warmAt < files.length && budget.left > 3) {
    const f = files[cur.warmAt];
    cur.warmAt += 1;
    if (isVideo(f.m) && budget.left > 1) await backfillDuration(env, state, f, budget);
    if (f.w || !f.th || !(isPhoto(f.m) || isVideo(f.m))) continue;
    const variants = f.s >= HI_RES_BYTES && isPhoto(f.m) ? ["thumb-lo", "thumb-hi"] : ["thumb-lo"];
    for (const variant of variants) {
      const used = await warmMedia(env, f.id, variant, f.r);
      budget.left -= used;
      if (used > 1) cur.progress.warmed += 1;
    }
    f.w = 1;
  }
  if (cur.warmAt >= files.length) cur.phase = "done";
}

// A video tile shows "video" instead of a length when Drive never described
// the original and the preview was made before durations were reported.
// The 720p preview is a plain MP4 Drive is happy to describe, so ask once.
async function backfillDuration(env, state, f, budget) {
  if (f.d) return;
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
    const cover = folder.cover?.id ? (await mediaThumbs(env, share.slug, { id: folder.cover.id, rev: folder.cover.r })).thumbs.base : "";
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

// Used by the change feed: every file and folder id this share knows.
export async function knownIds(env, slug) {
  const [{ folders }, files] = await Promise.all([loadStats(env, slug), loadFiles(env, slug)]);
  return { folderIds: new Set(Object.keys(folders || {})), fileIds: new Set(files.map((f) => f.id)) };
}
