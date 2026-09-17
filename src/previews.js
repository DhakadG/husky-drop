// Low-res video previews. Originals stay untouched; a GitHub Actions job
// (.github/workflows/transcode-previews.yml) pulls videos that have no
// preview yet, runs ffmpeg, and PUTs a 720p MP4 back here. The worker stores
// it in a private "_previews" folder under DRIVE_PARENT_ID (never inside a
// shared folder, so folder-level "anyone with link" grants never reach it).
//
// KV footprint is deliberately one key, `previews:index`:
//   { files: {origId: {id, size, at}}, failed: {origId: {error, at, tries}},
//     runs: [last 20 run summaries], queue: {folderIds, fileIds, limit} }
// PUT does not touch KV; the Action reports in batches and the worker merges
// each report with a single write. Overview scans live in isolate memory.

import { accessToken, driveCreateFolder, driveFindFolder, driveListFolder, driveTrashFile } from "./drive.js";
import { json, shareState, cleanText } from "./util.js";
import { signShareTokenWithExpiry } from "./share-token.js";
import { appLog } from "./applog.js";
import { liveStub, sendNotify } from "./store.js";

const INDEX_KEY = "previews:index";
const FOLDER_KEY = "previews:folder";
const FOLDER_NAME = "_previews";
const PREVIEW_TTL = 4 * 3600;
const MAX_PREVIEW_BYTES = 90 * 1024 * 1024; // Workers request-body ceiling with margin
const MAX_TRIES = 3;
const RUNS_KEPT = 20;
const CRON_UTC = { hour: 21, minute: 30 }; // keep in sync with the workflow schedule
const WORKFLOW = "transcode-previews.yml";
const isVideo = (f) => /^video\//.test(f?.mimeType || f?.mime || "");

export async function previewIndex(env) {
  const raw = (await env.KV.get(INDEX_KEY, "json")) || {};
  // First version stored the file map flat.
  const files = raw.files || (raw.runs || raw.failed ? {} : raw);
  return { files, failed: raw.failed || {}, runs: raw.runs || [], queue: raw.queue || null };
}
const saveIndex = (env, index) => env.KV.put(INDEX_KEY, JSON.stringify(index));

// Listing fields for one file: `preview` (4h token) when ready, else the
// state so share pages can say "optimising soon" / "failed".
export async function previewFields(env, slug, file, index) {
  if (!isVideo(file)) return {};
  const entry = index.files[file.id];
  if (entry) {
    const { token, expiresAt } = await signShareTokenWithExpiry(env, "dl", slug, entry.id, PREVIEW_TTL);
    return { preview: `/api/share/dl/${token}`, previewExpiresAt: expiresAt, previewState: "ready" };
  }
  const failed = index.failed[file.id];
  return { previewState: failed && failed.tries >= MAX_TRIES ? "failed" : "queued" };
}

async function previewFolderId(env) {
  const cached = await env.KV.get(FOLDER_KEY);
  if (cached) return cached;
  const parent = env.DRIVE_PARENT_ID || undefined;
  const folder = (await driveFindFolder(env, FOLDER_NAME, parent)) || (await driveCreateFolder(env, FOLDER_NAME, parent));
  await env.KV.put(FOLDER_KEY, folder.id);
  return folder.id;
}

// ---- share tree scan (Drive reads with memory & KV cache) ----
const TREE_CACHE_KEY = "previews:tree_cache";
let scanMemo = { at: 0, tree: null };

async function scanShares(env, fresh = false) {
  if (!fresh && scanMemo.tree && Date.now() - scanMemo.at < 300_000) return scanMemo.tree;
  if (!fresh) {
    const cached = await env.KV.get(TREE_CACHE_KEY, "json").catch(() => null);
    if (cached && Array.isArray(cached) && cached.length) {
      scanMemo = { at: Date.now(), tree: cached };
      return cached;
    }
  }

  const slugs = (await env.KV.get("shares:index", "json")) || [];
  const folders = []; // {slug, label, folderId, name, depth, videos: [{id,name,size,mime}]}
  const seen = new Set();

  const walk = async (slug, label, folderId, name, depth) => {
    if (depth > 3 || seen.has(folderId)) return;
    seen.add(folderId);
    const node = { slug, label, folderId, name, depth, videos: [] };
    folders.push(node);
    let pageToken = "";
    do {
      let page;
      try {
        page = await driveListFolder(env, folderId, pageToken);
      } catch {
        break;
      }
      const subtasks = [];
      for (const f of page.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          subtasks.push(walk(slug, label, f.id, f.name, depth + 1));
        } else if (isVideo(f)) {
          node.videos.push({ id: f.id, name: f.name, size: Number(f.size) || 0, mime: f.mimeType });
        }
      }
      if (subtasks.length) await Promise.all(subtasks);
      pageToken = page.nextPageToken || "";
    } while (pageToken);
  };

  const shareTasks = [];
  for (const slug of slugs) {
    const share = await env.KV.get(`share:${slug}`, "json");
    if (shareState(share) !== "active") continue;
    for (const id of share.folderIds || []) {
      shareTasks.push(walk(slug, share.label || slug, id, share.label || slug, 0));
    }
  }
  await Promise.all(shareTasks);

  scanMemo = { at: Date.now(), tree: folders };
  env.KV.put(TREE_CACHE_KEY, JSON.stringify(folders), { expirationTtl: 86400 }).catch(() => {});
  return folders;
}

function fileState(index, id) {
  if (index.files[id]) return "ready";
  const failed = index.failed[id];
  return failed && failed.tries >= MAX_TRIES ? "failed" : "pending";
}

// ---- GitHub Actions bridge (optional: needs GITHUB_TOKEN secret) ----
function ghConfigured(env) {
  return !!env.GITHUB_TOKEN;
}
async function gh(env, path, init = {}) {
  const repo = env.GITHUB_REPO || "DhakadG/husky-drop";
  return fetch(`https://api.github.com/repos/${repo}/actions/${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "user-agent": "husky-drop-worker",
      ...(init.headers || {}),
    },
  });
}
async function activeRun(env) {
  if (!ghConfigured(env)) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await gh(env, `workflows/${WORKFLOW}/runs?per_page=3`, { signal: ctrl.signal });
    if (!r.ok) return null;
    const { workflow_runs: runs = [] } = await r.json();
    const live = runs.find((run) => ["queued", "in_progress", "waiting"].includes(run.status));
    return live ? { id: live.id, status: live.status, startedAt: Date.parse(live.run_started_at || live.created_at), url: live.html_url } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
function nextScheduledRun(now = Date.now()) {
  const next = new Date(now);
  next.setUTCHours(CRON_UTC.hour, CRON_UTC.minute, 0, 0);
  if (next.getTime() <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime();
}

function computeCoverage(tree, index) {
  const totals = { videos: 0, ready: 0, pending: 0, failed: 0, bytes: 0, previewBytes: 0 };
  const folders = tree.map((node) => {
    const row = { slug: node.slug, label: node.label, folderId: node.folderId, name: node.name, depth: node.depth, videos: node.videos.length, ready: 0, pending: 0, failed: 0, bytes: 0, previewBytes: 0 };
    for (const v of node.videos) {
      const state = fileState(index, v.id);
      row[state] += 1;
      row.bytes += v.size;
      row.previewBytes += index.files[v.id]?.size || 0;
    }
    for (const key of ["videos", "ready", "pending", "failed", "bytes", "previewBytes"]) totals[key] += row[key];
    return row;
  });
  const names = new Map(tree.flatMap((node) => node.videos.map((v) => [v.id, v])));
  const failed = Object.entries(index.failed).map(([id, f]) => ({ id, name: names.get(id)?.name || id, ...f }));
  return { folders, totals, failed };
}

// ---- admin: fast overview (returns in <50ms without waiting for a full Drive crawl) ----
export async function previewsOverview(request, env) {
  const url = new URL(request.url);
  const fresh = url.searchParams.get("fresh") === "1";

  const [index, active, live] = await Promise.all([
    previewIndex(env),
    activeRun(env),
    env.LIVE_TRACKER
      ? liveStub(env)
          .fetch("https://live.internal/transcoder-status")
          .then((r) => r.json())
          .catch(() => null)
      : null,
  ]);

  // Check if we already have the tree cached in memory or KV
  let tree = null;
  if (!fresh && scanMemo.tree && Date.now() - scanMemo.at < 300_000) {
    tree = scanMemo.tree;
  } else if (!fresh) {
    tree = await env.KV.get(TREE_CACHE_KEY, "json").catch(() => null);
    if (tree) scanMemo = { at: Date.now(), tree };
  }

  let totals = {
    videos: Object.keys(index.files).length + Object.keys(index.failed).length,
    ready: Object.keys(index.files).length,
    pending: 0,
    failed: Object.keys(index.failed).length,
    bytes: 0,
    previewBytes: 0,
  };
  for (const f of Object.values(index.files)) totals.previewBytes += f.size || 0;

  let folders = null;
  let foldersLoading = false;
  let failed = Object.entries(index.failed).map(([id, f]) => ({ id, name: id, ...f }));

  if (tree) {
    const cov = computeCoverage(tree, index);
    folders = cov.folders;
    totals = cov.totals;
    failed = cov.failed;
  } else {
    foldersLoading = true;
  }

  return json({
    totals,
    folders,
    foldersLoading,
    failed,
    runs: index.runs,
    queue: index.queue,
    active,
    live,
    nextRunAt: nextScheduledRun(),
    dispatchConfigured: ghConfigured(env),
    scannedAt: scanMemo.at,
  });
}

// ---- admin: separate coverage endpoint (can run in background without hanging overview) ----
export async function previewsCoverage(request, env) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const [index, tree] = await Promise.all([
    previewIndex(env),
    scanShares(env, fresh),
  ]);

  const cov = computeCoverage(tree, index);
  return json({
    totals: cov.totals,
    folders: cov.folders,
    failed: cov.failed,
    scannedAt: scanMemo.at,
  });
}

// ---- Action: what to do next ----
// Queue (explicit folders/files from the admin) first, then everything else.
// Files that failed MAX_TRIES times are skipped until retried from the admin.
export async function listPendingPreviews(request, env) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(1000, Number(url.searchParams.get("limit")) || 20));
  const cached = url.searchParams.get("cached") === "1";
  const index = await previewIndex(env);
  // Trust the folder over the index: a preview that exists in Drive but was
  // never reported (run killed before its batch) must not be made twice.
  if (!cached) {
    const inDrive = await previewsInFolder(env);
    let repaired = 0;
    for (const [of, entry] of Object.entries(inDrive)) {
      if (index.files[of]) continue;
      index.files[of] = entry;
      repaired += 1;
    }
    if (repaired) await saveIndex(env, index);
  }
  const tree = await scanShares(env, !cached);
  const byId = new Map(tree.flatMap((node) => node.videos.map((v) => [v.id, v])));
  const eligible = (id) => !index.files[id] && (index.failed[id]?.tries || 0) < MAX_TRIES;
  const ordered = [];
  const push = (v) => v && eligible(v.id) && !ordered.some((o) => o.id === v.id) && ordered.push(v);
  const queue = index.queue || {};
  for (const id of queue.fileIds || []) push(byId.get(id));
  for (const node of tree) if ((queue.folderIds || []).includes(node.folderId)) node.videos.forEach(push);
  for (const node of tree) node.videos.forEach(push);
  return json({
    pending: ordered.slice(0, Math.max(limit, Number(queue.limit) || 0)),
    indexed: Object.keys(index.files).length,
    total: ordered.length,
  });
}

// Stream the original to the transcoder.
export async function previewSource(request, env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return json({ error: "bad file id" }, 400);
  const tok = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${tok}` },
    signal: request.signal,
  });
  if (!r.ok || !r.body) return json({ error: "Drive download failed" }, 502);
  return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" } });
}

// Store one finished preview in Drive. No KV write here: the Action reports
// the batch and `reportPreviewRun` records it.
export async function putPreview(request, env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return json({ error: "bad file id" }, 400);
  const declared = Number(request.headers.get("content-length")) || 0;
  if (declared > MAX_PREVIEW_BYTES) return json({ error: "preview too large" }, 413);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_PREVIEW_BYTES) return json({ error: "preview empty or too large" }, 413);

  const tok = await accessToken(env);
  const meta = { name: `${id}.mp4`, parents: [await previewFolderId(env)], appProperties: { previewOf: id } };
  const boundary = `hd-${crypto.randomUUID()}`;
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: video/mp4\r\n\r\n`;
  const payload = new Blob([head, body, `\r\n--${boundary}--`]);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size&supportsAllDrives=true", {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: payload,
  });
  if (!r.ok) return json({ error: "Drive upload failed: " + (await r.text()).slice(0, 200) }, 502);
  const created = await r.json();
  return json({ ok: true, previewId: created.id, size: Number(created.size) || body.byteLength }, 201);
}

// Batch report from the Action: {runId, trigger, startedAt, finishedAt?,
// done: [{id, name, size, previewId, previewSize, ms}], skipped: [{id, name, error}]}.
// One KV write per report; the script reports every few files and at the end.
export async function reportPreviewRun(request, env, ctx) {
  const b = await request.json().catch(() => null);
  if (!b || !b.runId) return json({ error: "runId required" }, 400);
  const index = await previewIndex(env);
  const now = Date.now();
  for (const d of b.done || []) {
    if (!d.id || !d.previewId) continue;
    index.files[d.id] = { id: d.previewId, size: Number(d.previewSize) || 0, at: now };
    delete index.failed[d.id];
  }
  for (const s of b.skipped || []) {
    if (!s.id) continue;
    const prev = index.failed[s.id] || { tries: 0 };
    index.failed[s.id] = { error: cleanText(s.error || "failed", 200), at: now, tries: prev.tries + 1 };
  }
  const runId = String(b.runId).slice(0, 40);
  const existing = index.runs.find((r) => r.id === runId);
  const run = existing || { id: runId, trigger: cleanText(b.trigger || "schedule", 20), startedAt: Number(b.startedAt) || now, done: 0, skipped: 0, bytes: 0, previewBytes: 0, items: [] };
  run.done += (b.done || []).length;
  run.skipped += (b.skipped || []).length;
  for (const d of b.done || []) {
    run.bytes += Number(d.size) || 0;
    run.previewBytes += Number(d.previewSize) || 0;
  }
  run.items = [...run.items, ...(b.done || []).map((d) => ({ id: d.id, name: cleanText(d.name || d.id, 120), ok: true, ms: Number(d.ms) || 0, size: Number(d.size) || 0, previewSize: Number(d.previewSize) || 0 })), ...(b.skipped || []).map((s) => ({ id: s.id, name: cleanText(s.name || s.id, 120), ok: false, error: cleanText(s.error || "", 200) }))].slice(-300);
  for (const s of b.skipped || []) appLog(env, ctx, { level: "warn", area: "previews", message: `preview failed: ${s.name || s.id}`, detail: s.error });
  if (b.finishedAt) {
    run.finishedAt = Number(b.finishedAt) || now;
    run.pendingLeft = Number(b.pendingLeft) || 0;
    index.queue = null; // an explicit request has been served
    appLog(env, ctx, { area: "previews", message: `run ${runId} (${run.trigger}) finished: ${run.done} done, ${run.skipped} skipped, ${run.pendingLeft} left` });
    if (run.done || run.skipped) ctx?.waitUntil?.(sendNotify(env, { subject: `Video previews: ${run.done} made${run.skipped ? `, ${run.skipped} failed` : ""}${run.pendingLeft ? `, ${run.pendingLeft} left` : ""}`, html: `<p>${run.trigger} run ${runId}: <b>${run.done}</b> previews made, ${run.skipped} failed, ${run.pendingLeft} still pending.</p><p>${(run.bytes / 1e9).toFixed(2)} GB of originals → ${(run.previewBytes / 1e6).toFixed(0)} MB of previews.</p><p><a href="https://dropbox.losthusky.qzz.io/admin/previews">Video previews</a></p>`, category: "video-previews", idempotencyKey: `prev-digest-${runId}` }));
  }
  if (!existing) index.runs.unshift(run);
  index.runs = index.runs.slice(0, RUNS_KEPT);
  await saveIndex(env, index);
  return json({ ok: true, indexed: Object.keys(index.files).length });
}

// ---- admin actions ----
// Queue specific folders/files (or everything) and start the workflow now.
export async function startPreviewRun(request, env) {
  const b = await request.json().catch(() => ({}));
  const index = await previewIndex(env);
  const folderIds = (b.folderIds || []).map((id) => cleanText(id, 120)).filter(Boolean).slice(0, 50);
  const fileIds = (b.fileIds || []).map((id) => cleanText(id, 120)).filter(Boolean).slice(0, 500);
  const limit = Math.max(1, Math.min(300, Number(b.limit) || 40));
  if (b.retryFailed) index.failed = {};
  index.queue = { folderIds, fileIds, limit, at: Date.now() };
  await saveIndex(env, index);
  if (!ghConfigured(env)) return json({ ok: true, queued: true, dispatched: false, reason: "GITHUB_TOKEN not set - the nightly run will pick the queue up" }, 202);
  if (await activeRun(env)) return json({ ok: true, queued: true, dispatched: false, reason: "a run is already in progress" }, 202);
  const r = await gh(env, `workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { limit: String(limit) } }),
  });
  if (r.status !== 204) return json({ ok: false, queued: true, dispatched: false, reason: `GitHub refused: ${r.status} ${(await r.text()).slice(0, 120)}` }, 502);
  return json({ ok: true, queued: true, dispatched: true }, 202);
}

export async function retryFailedPreviews(request, env) {
  const b = await request.json().catch(() => ({}));
  const index = await previewIndex(env);
  const ids = (b.fileIds || []).map(String);
  if (ids.length) for (const id of ids) delete index.failed[id];
  else index.failed = {};
  await saveIndex(env, index);
  return json({ ok: true, failed: Object.keys(index.failed).length });
}

// Remove one preview (Drive trash + index) so the next run regenerates it.
export async function deletePreview(env, fileId) {
  const id = cleanText(fileId, 120);
  const index = await previewIndex(env);
  const entry = index.files[id];
  if (!entry) return json({ error: "no preview for this file" }, 404);
  await driveTrashFile(env, entry.id);
  delete index.files[id];
  await saveIndex(env, index);
  return json({ ok: true });
}

// Called when an original is trashed: drop its preview too (no-op otherwise).
export async function forgetPreview(env, fileId) {
  const index = await previewIndex(env);
  const entry = index.files[fileId];
  if (!entry) return;
  await driveTrashFile(env, entry.id).catch(() => {});
  delete index.files[fileId];
  await saveIndex(env, index);
}

// previewOf -> {id, size, at} for everything in the _previews folder.
async function previewsInFolder(env) {
  const folderId = await previewFolderId(env);
  const tok = await accessToken(env);
  const files = {};
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,size,appProperties,createdTime)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetch("https://www.googleapis.com/drive/v3/files?" + params, { headers: { authorization: `Bearer ${tok}` } });
    if (!r.ok) throw new Error("Drive list failed");
    const page = await r.json();
    for (const f of page.files || []) {
      const of = f.appProperties?.previewOf;
      if (of) files[of] = { id: f.id, size: Number(f.size) || 0, at: Date.parse(f.createdTime) || Date.now() };
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return files;
}

// Rebuild the file map from the _previews folder (recovery after a KV wipe).
export async function reindexPreviews(request, env) {
  const index = await previewIndex(env);
  try {
    index.files = await previewsInFolder(env);
  } catch {
    return json({ error: "Drive list failed" }, 502);
  }
  await saveIndex(env, index);
  return json({ ok: true, indexed: Object.keys(index.files).length });
}
