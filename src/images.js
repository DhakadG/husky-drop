// Image archive / re-encode jobs. The worker plans (dry run from Drive
// metadata, no downloads), stores the plan, and performs every Drive write;
// scripts/transcode-images.mjs (GitHub Actions) does the pixel work.
//
// KV: one key, `images:jobs` = { jobs: [last 10 job records] }. Writes only
// on admin actions (plan/start/pause/resume/cancel) and on batch reports.
//
// Modes (what happens to the original once the smaller copy is verified):
//   replace - new bytes become a new revision of the SAME file id (name and
//             folder kept, extension updated if the format changed). Drive
//             keeps the previous revision for 30 days.
//   archive - original moved to _archive/<folder name>/ (metadata patch, no
//             copy); the new file takes its place with the same name.
//   copy    - original untouched; the new file goes to _compressed/<folder name>/.

import { accessToken, driveCreateFolder, driveFileMeta, driveFindFolder, driveListFolder, driveTrashFile } from "./drive.js";
import { json, cleanText } from "./util.js";

const KEY = "images:jobs";
const JOBS_KEPT = 10;
const MAX_FILES = 5000;
const MAX_UPLOAD = 90 * 1024 * 1024;
const WORKFLOW = "transcode-images.yml";
const RAW_EXT = /\.(arw|srf|sr2|cr2|cr3|nef|nrw|dng|raf|orf|rw2|pef|3fr|iiq)$/i;
const TYPES = {
  jpeg: (f) => /^image\/jpe?g$/.test(f.mime),
  png: (f) => f.mime === "image/png",
  heic: (f) => /^image\/hei[cf]$/.test(f.mime) || /\.hei[cf]$/i.test(f.name),
  tiff: (f) => f.mime === "image/tiff",
  webp: (f) => f.mime === "image/webp",
  raw: (f) => RAW_EXT.test(f.name) || /^image\/x-(sony|canon|nikon|adobe-dng|fuji|olympus|panasonic|pentax)/.test(f.mime),
};
// Bytes per output pixel at the default quality; the dry run is an estimate.
const BPP = { jpeg: 0.30, webp: 0.22, avif: 0.15 };
// Seconds per file on the GitHub runner, measured: ~6 s for a 14 MB JPEG
// (download through the worker + encode + upload); RAW develops add ~8 s.
const SECS = { jpeg: 4, png: 5, heic: 6, tiff: 5, webp: 4, raw: 12 };

async function loadJobs(env) {
  return ((await env.KV.get(KEY, "json")) || {}).jobs || [];
}
// ponytail: last write wins on the single key; fine while one runner and
// one admin exist - add a version check if runners ever run concurrently.
const saveJobs = (env, jobs) => env.KV.put(KEY, JSON.stringify({ jobs: jobs.slice(0, JOBS_KEPT) }));
const publicJob = (job) => job && { ...job, files: undefined, fileCount: job.files?.length || 0 };

export function normalizeOptions(raw = {}) {
  const format = ["same", "jpeg", "webp", "avif"].includes(raw.format) ? raw.format : "same";
  const types = Array.isArray(raw.types) ? raw.types.filter((t) => TYPES[t]) : Object.keys(TYPES);
  return {
    folderIds: (raw.folderIds || []).map((id) => cleanText(id, 120)).filter(Boolean).slice(0, 20),
    recursive: raw.recursive !== false,
    maxMp: [0, 4, 6, 8, 12, 16, 24].includes(Number(raw.maxMp)) ? Number(raw.maxMp) : 8,
    quality: Math.max(50, Math.min(95, Number(raw.quality) || 82)),
    format,
    types,
    metadata: ["keep", "strip-gps", "strip"].includes(raw.metadata) ? raw.metadata : "keep",
    minBytes: Math.max(0, Number(raw.minBytes) || 1.5 * 1024 * 1024),
    onlyIfSmaller: raw.onlyIfSmaller !== false,
    mode: ["replace", "archive", "copy"].includes(raw.mode) ? raw.mode : "copy",
    // Optional size target per photo: the runner nudges quality up on smooth
    // frames and down on busy ones until the output lands near it.
    targetBytes: Math.max(0, Math.min(20 * 1024 * 1024, Number(raw.targetBytes) || 0)),
    excludeRe: safeRegex(cleanText(raw.exclude || "", 200)),
  };
}
function safeRegex(source) {
  try {
    return source && new RegExp(source, "i") ? source : "";
  } catch {
    return "";
  }
}

function typeOf(f) {
  for (const [name, test] of Object.entries(TYPES)) if (test(f)) return name;
  return "";
}
function outputFormat(type, options) {
  if (options.format !== "same") return options.format;
  // "same" keeps JPEG/PNG/WebP; RAW, HEIC and TIFF have no sensible
  // same-format target for a web archive, so they become JPEG.
  return type === "png" || type === "webp" ? type : "jpeg";
}
function estimate(f, options) {
  const px = (f.w || 0) * (f.h || 0);
  const cap = options.maxMp ? options.maxMp * 1e6 : Infinity;
  const outPx = px ? Math.min(px, cap) : cap === Infinity ? 12e6 : cap;
  const format = outputFormat(f.type, options);
  const bpp = format === "png" ? 1.2 : (BPP[format] || 0.3) * (options.quality / 82);
  return { outPx, format, bytes: Math.round(outPx * bpp) };
}

// ---- plan (dry run) ----
async function walk(env, folderId, options, out, path, depth, seen) {
  if (seen.has(folderId) || depth > 8 || out.files.length >= MAX_FILES) return;
  seen.add(folderId);
  let pageToken = "";
  do {
    const page = await driveListFolder(env, folderId, pageToken, { pageSize: 1000 });
    for (const f of page.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        if (options.recursive && !/^_(archive|compressed|previews)$/.test(f.name)) await walk(env, f.id, options, out, `${path}/${f.name}`, depth + 1, seen);
        continue;
      }
      const file = { id: f.id, name: f.name, size: Number(f.size) || 0, mime: f.mimeType || "", w: Number(f.imageMediaMetadata?.width) || 0, h: Number(f.imageMediaMetadata?.height) || 0, folderId, path };
      file.type = typeOf(file);
      if (!file.type) continue;
      out.scanned += 1;
      out.scannedBytes += file.size;
      out.byType[file.type] = (out.byType[file.type] || 0) + 1;
      let skip = "";
      if (!options.types.includes(file.type)) skip = "type excluded";
      else if (file.size < options.minBytes) skip = "already small";
      else if (options.excludeRe && new RegExp(options.excludeRe, "i").test(file.name)) skip = "name excluded";
      else if (file.size > MAX_UPLOAD * 3) skip = "over 270 MB";
      else if (out.doneBefore.has(file.id)) skip = "done in an earlier job";
      const est = estimate(file, options);
      if (options.targetBytes) est.bytes = Math.min(Math.round(file.size * 0.9), options.targetBytes);
      if (!skip && options.onlyIfSmaller && est.bytes >= file.size * 0.9) skip = "no worthwhile saving";
      if (skip) {
        out.skipped[skip] = (out.skipped[skip] || 0) + 1;
        continue;
      }
      out.files.push({ ...file, format: est.format, est: est.bytes });
      if (out.files.length >= MAX_FILES) return;
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);
}

export async function planImageJob(request, env) {
  const options = normalizeOptions(await request.json().catch(() => ({})));
  if (!options.folderIds.length) return json({ error: "pick at least one folder" }, 400);
  const jobs = await loadJobs(env);
  // Files a previous job (any mode) already turned into a smaller copy.
  const doneBefore = new Set(jobs.flatMap((j) => j.items.filter((i) => i.ok).map((i) => i.id)));
  const out = { files: [], scanned: 0, scannedBytes: 0, byType: {}, skipped: {}, doneBefore };
  const seen = new Set();
  const roots = [];
  for (const id of options.folderIds) {
    const meta = await driveFileMeta(env, id);
    if (!meta?.id) return json({ error: `folder ${id} not found` }, 404);
    roots.push({ id, name: meta.name });
    await walk(env, id, options, out, meta.name, 0, seen);
  }
  const bytes = out.files.reduce((n, f) => n + f.size, 0);
  const estBytes = out.files.reduce((n, f) => n + f.est, 0);
  const etaSec = out.files.reduce((n, f) => n + (SECS[f.type] || 4) + f.size / 6e6 + (options.targetBytes ? 3 : 0), 0);
  const largest = [...out.files].sort((a, b) => b.size - a.size).slice(0, 8).map((f) => ({ name: f.name, size: f.size, est: f.est, type: f.type, w: f.w, h: f.h }));
  const job = {
    id: `img-${Date.now().toString(36)}`,
    status: "planned",
    createdAt: Date.now(),
    options,
    roots,
    digest: { scanned: out.scanned, scannedBytes: out.scannedBytes, byType: out.byType, skipped: out.skipped, files: out.files.length, bytes, estBytes, etaSec, capped: out.files.length >= MAX_FILES, largest },
    progress: { done: 0, failed: 0, skipped: 0, bytesIn: 0, bytesOut: 0 },
    items: [],
    files: out.files,
  };
  // A new plan replaces any older un-started plan; running jobs are kept.
  await saveJobs(env, [job, ...jobs.filter((j) => j.status !== "planned")]);
  return json({ job: publicJob(job) }, 201);
}

export async function listImageJobs(env) {
  const jobs = await loadJobs(env);
  const active = jobs.find((j) => ["running", "paused", "pausing"].includes(j.status)) || null;
  return json({ jobs: jobs.map(publicJob), active: publicJob(active), dispatchConfigured: !!env.GITHUB_TOKEN });
}

async function dispatch(env, jobId) {
  if (!env.GITHUB_TOKEN) return { dispatched: false, reason: "GITHUB_TOKEN not set - run scripts/transcode-images.mjs locally with JOB_ID=" + jobId };
  const repo = env.GITHUB_REPO || "DhakadG/husky-drop";
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "husky-drop-worker", "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { job: jobId } }),
  });
  return r.status === 204 ? { dispatched: true } : { dispatched: false, reason: `GitHub refused: ${r.status}` };
}

// start | pause | resume | cancel
export async function controlImageJob(request, env, jobId, action) {
  const b = await request.json().catch(() => ({}));
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  if (action === "start") {
    if (job.status !== "planned") return json({ error: `job is ${job.status}` }, 409);
    if (job.options.mode === "replace" && b.confirm !== "REPLACE") return json({ error: 'type REPLACE to confirm overwriting originals' }, 400);
    if (jobs.some((j) => j !== job && ["running", "pausing"].includes(j.status))) return json({ error: "another job is running" }, 409);
    job.status = "running";
    job.startedAt = Date.now();
  } else if (action === "pause") {
    if (job.status !== "running") return json({ error: `job is ${job.status}` }, 409);
    job.status = "pausing"; // the runner finishes the current file, then stops
  } else if (action === "resume") {
    if (!["paused", "pausing"].includes(job.status)) return json({ error: `job is ${job.status}` }, 409);
    job.status = "running";
  } else if (action === "cancel") {
    if (["done", "cancelled"].includes(job.status)) return json({ error: `job is ${job.status}` }, 409);
    job.status = "cancelled";
    job.finishedAt = Date.now();
  } else return json({ error: "unknown action" }, 400);
  await saveJobs(env, jobs);
  const result = ["start", "resume"].includes(action) ? await dispatch(env, job.id) : {};
  return json({ ok: true, job: publicJob(job), ...result });
}

// ---- runner API ----
// Next batch of unprocessed files, plus the current status so the runner
// can stop on pause/cancel.
export async function nextImageBatch(request, env, jobId) {
  const n = Math.max(1, Math.min(50, Number(new URL(request.url).searchParams.get("n")) || 10));
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  const seen = new Set(job.items.map((i) => i.id));
  const files = job.status === "running" ? job.files.filter((f) => !seen.has(f.id)).slice(0, n) : [];
  return json({ status: job.status, options: job.options, files, remaining: job.files.length - seen.size });
}

export async function imageSource(request, env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return json({ error: "bad file id" }, 400);
  const tok = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` }, signal: request.signal });
  if (!r.ok || !r.body) return json({ error: "Drive download failed" }, 502);
  return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" } });
}

const withExt = (name, format) => name.replace(/\.[^.]+$/, "") + { jpeg: ".jpg", webp: ".webp", avif: ".avif", png: ".png" }[format];
const MIME = { jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", png: "image/png" };

async function subfolder(env, name, parentId) {
  return (await driveFindFolder(env, name, parentId)) || driveCreateFolder(env, name, parentId);
}
// _archive/<root>/<sub>/... mirrors the source tree so two folders that
// share a leaf name never merge. Folder ids memoised per isolate.
const folderMemo = new Map();
async function mirrorPath(env, base, relativePath) {
  let parent = env.DRIVE_PARENT_ID || undefined;
  let key = "";
  for (const segment of [base, ...relativePath.split("/").filter(Boolean)]) {
    key += `/${segment}`;
    if (!folderMemo.has(key)) folderMemo.set(key, (await subfolder(env, segment, parent)).id);
    parent = folderMemo.get(key);
  }
  return parent;
}
async function moveFile(env, tok, fileId, fromId, toId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${toId}&removeParents=${fromId}&supportsAllDrives=true`, { method: "PATCH", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("Drive move failed");
}
// A retried PUT must not leave two copies behind: drop anything already
// tagged as made from this original.
async function trashPriorCopies(env, tok, originalId) {
  const params = new URLSearchParams({ q: `appProperties has { key='archivedFrom' and value='${originalId}' } and trashed=false`, fields: "files(id)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const r = await fetch("https://www.googleapis.com/drive/v3/files?" + params, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok) return;
  for (const f of (await r.json()).files || []) await driveTrashFile(env, f.id).catch(() => {});
}
async function multipart(env, tok, url, method, meta, body, mime) {
  const boundary = `hd-${crypto.randomUUID()}`;
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`;
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${tok}`, "content-type": `multipart/related; boundary=${boundary}` }, body: new Blob([head, body, `\r\n--${boundary}--`]) });
  if (!r.ok) throw new Error("Drive upload failed: " + (await r.text()).slice(0, 160));
  return r.json();
}

// The runner PUTs the encoded image; the worker applies the job's mode and
// verifies what Drive stored (size + dimensions) before answering ok.
export async function putImageResult(request, env, jobId, fileId) {
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  const file = job?.files.find((f) => f.id === fileId);
  if (!job || !file) return json({ error: "unknown job/file" }, 404);
  if (job.status !== "running") return json({ error: `job is ${job.status}` }, 409);
  const format = cleanText(request.headers.get("x-format") || file.format, 8);
  const mime = MIME[format];
  if (!mime) return json({ error: "bad format" }, 400);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_UPLOAD) return json({ error: "empty or too large" }, 413);
  if (job.options.onlyIfSmaller && body.byteLength >= file.size) return json({ ok: false, skipped: "output not smaller" });

  const tok = await accessToken(env);
  const name = withExt(file.name, format);
  const props = { appProperties: { archivedFrom: file.id, archiveJob: job.id } };
  if (request.headers.get("x-retry") && job.options.mode !== "replace") await trashPriorCopies(env, tok, file.id);
  let created;
  if (job.options.mode === "replace") {
    created = await multipart(env, tok, `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=multipart&fields=id,size,imageMediaMetadata(width,height)&supportsAllDrives=true`, "PATCH", { name, mimeType: mime, ...props }, body, mime);
  } else {
    let parent = file.folderId;
    if (job.options.mode === "archive") await moveFile(env, tok, file.id, file.folderId, await mirrorPath(env, "_archive", file.path));
    else parent = await mirrorPath(env, "_compressed", file.path);
    created = await multipart(env, tok, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size,imageMediaMetadata(width,height)&supportsAllDrives=true", "POST", { name, mimeType: mime, parents: [parent], ...props }, body, mime);
  }
  const size = Number(created.size) || 0;
  if (size !== body.byteLength) return json({ error: `Drive stored ${size} bytes, expected ${body.byteLength}` }, 502);
  return json({ ok: true, id: created.id, size, w: created.imageMediaMetadata?.width || 0, h: created.imageMediaMetadata?.height || 0 });
}

// Batch report: {done: [{id, newId, size, ms}], skipped: [{id, error}], finished?, stopped?}
export async function reportImageBatch(request, env, jobId) {
  const b = await request.json().catch(() => ({}));
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  const known = new Map(job.files.map((f) => [f.id, f]));
  for (const d of b.done || []) {
    const f = known.get(d.id);
    if (!f) continue;
    job.items.push({ id: d.id, ok: true, newId: d.newId, size: Number(d.size) || 0, ms: Number(d.ms) || 0 });
    job.progress.done += 1;
    job.progress.bytesIn += f.size;
    job.progress.bytesOut += Number(d.size) || 0;
  }
  for (const s of b.skipped || []) {
    if (!known.has(s.id)) continue;
    const soft = /not smaller|unsupported/i.test(s.error || "");
    job.items.push({ id: s.id, ok: false, soft, error: cleanText(s.error || "failed", 160) });
    job.progress[soft ? "skipped" : "failed"] += 1;
  }
  if (b.finished) {
    job.status = "done";
    job.finishedAt = Date.now();
  } else if (b.stopped && ["pausing", "running"].includes(job.status)) job.status = "paused";
  await saveJobs(env, jobs);
  return json({ ok: true, status: job.status, progress: job.progress });
}

// Item detail for the admin (names resolved from the plan).
export async function imageJobItems(env, jobId) {
  const job = (await loadJobs(env)).find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  const names = new Map(job.files.map((f) => [f.id, f]));
  return json({ items: job.items.map((i) => ({ ...i, name: names.get(i.id)?.name || i.id, path: names.get(i.id)?.path || "", sizeIn: names.get(i.id)?.size || 0 })).reverse() });
}
