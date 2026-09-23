// Image archive / re-encode jobs - scanning and planning. Runner-facing
// endpoints, job control and Drive writes live in images-run.js.
//
// The worker never downloads pixels: scan and plan work from Drive metadata
// (size, dimensions, modified time, sibling names). The admin gets the scan
// rows and estimates any recipe instantly; Start re-walks and stores a plan.
//
// KV: one key, `images:jobs` = { jobs: [last 10 job records] }.

import { driveFileMeta, driveFindFolder, driveListFolder } from "./drive.js";
import { json, cleanText, shareState } from "./util.js";

export const KEY = "images:jobs";
export const JOBS_KEPT = 10;
export const MAX_FILES = 5000;
const RAW_EXT = /\.(arw|srf|sr2|cr2|cr3|nef|nrw|dng|raf|orf|rw2|pef|3fr|iiq)$/i;
const TYPES = {
  jpeg: (f) => /^image\/jpe?g$/.test(f.mime),
  png: (f) => f.mime === "image/png",
  heic: (f) => /^image\/hei[cf]$/.test(f.mime) || /\.hei[cf]$/i.test(f.name),
  tiff: (f) => f.mime === "image/tiff",
  webp: (f) => f.mime === "image/webp",
  raw: (f) => RAW_EXT.test(f.name) || /^image\/x-(sony|canon|nikon|adobe-dng|fuji|olympus|panasonic|pentax)/.test(f.mime),
};
// Bytes per output pixel at quality 82 - measured on the first runs: busy
// daylight frames ~0.19, average ~0.1, dark or smooth frames ~0.03.
const BPP = { jpeg: 0.12, webp: 0.09, avif: 0.06, png: 1.2 };
// Seconds per file on the GitHub runner (download via worker + encode + upload).
const SECS = { jpeg: 4, png: 5, heic: 6, tiff: 5, webp: 4, raw: 7 };

export async function loadJobs(env) {
  return ((await env.KV.get(KEY, "json")) || {}).jobs || [];
}
// ponytail: last write wins on the single key; fine while one runner and
// one admin exist - add a version check if runners ever run concurrently.
export const saveJobs = (env, jobs) => env.KV.put(KEY, JSON.stringify({ jobs: jobs.slice(0, JOBS_KEPT) }));
export const publicJob = (job) => job && { ...job, files: undefined, fileCount: job.files?.length || 0 };

export function normalizeOptions(raw = {}) {
  const format = ["same", "jpeg", "webp", "avif"].includes(raw.format) ? raw.format : "same";
  const types = Array.isArray(raw.types) ? raw.types.filter((t) => TYPES[t]) : Object.keys(TYPES);
  const ids = (list) => (Array.isArray(list) ? list : []).map((id) => cleanText(id, 120)).filter(Boolean);
  return {
    folderIds: ids(raw.folderIds).slice(0, 20),
    excludeFolderIds: ids(raw.excludeFolderIds).slice(0, 200),
    recursive: raw.recursive !== false,
    maxMp: [0, 2, 4, 6, 8, 12, 16, 24].includes(Number(raw.maxMp)) ? Number(raw.maxMp) : 8,
    quality: Math.max(50, Math.min(95, Number(raw.quality) || 82)),
    format,
    types,
    metadata: ["keep", "strip-gps", "strip"].includes(raw.metadata) ? raw.metadata : "keep",
    minBytes: Math.max(0, Number(raw.minBytes) || 0),
    onlyIfSmaller: raw.onlyIfSmaller !== false,
    mode: ["replace", "archive", "copy"].includes(raw.mode) ? raw.mode : "copy",
    // The form sends `exclude`; stored options carry `excludeRe`. Accept both
    // so re-saving a stored rule can never drop its name exclusions.
    excludeRe: safeRegex(cleanText(raw.exclude ?? raw.excludeRe ?? "", 200)),
    // Optional size target per photo: the runner nudges quality up on smooth
    // frames and down on busy ones until the output lands near it.
    targetBytes: Math.max(0, Math.min(20 * 1024 * 1024, Number(raw.targetBytes) || 0)),
    // Protections
    skipRecentDays: Math.max(0, Math.min(3650, Number(raw.skipRecentDays) || 0)),
    skipSidecar: raw.skipSidecar !== false, // RAW with an .xmp next to it = edited in Lightroom/darktable
    largestFirst: !!raw.largestFirst,
    // Files encoded at once on the runner (4 vCPU). Admin "processing speed".
    parallel: Math.max(1, Math.min(8, Number(raw.parallel) || 4)),
  };
}
function safeRegex(source) {
  try {
    return source && new RegExp(source, "i") ? source : "";
  } catch {
    return "";
  }
}

export function typeOf(f) {
  for (const [name, test] of Object.entries(TYPES)) if (test(f)) return name;
  return "";
}
function outputFormat(type, options) {
  if (options.format !== "same") return options.format;
  // "same" keeps JPEG/PNG/WebP; RAW, HEIC and TIFF have no sensible
  // same-format target for a web archive, so they become JPEG.
  return type === "png" || type === "webp" ? type : "jpeg";
}
export function estimate(f, options) {
  const px = (f.w || 0) * (f.h || 0);
  const cap = options.maxMp ? options.maxMp * 1e6 : Infinity;
  const outPx = px ? Math.min(px, cap) : cap === Infinity ? 12e6 : cap;
  const format = outputFormat(f.type, options);
  const bpp = format === "png" ? BPP.png : (BPP[format] || 0.12) * (options.quality / 82);
  const bytes = options.targetBytes && format !== "png" ? Math.min(Math.round(f.size * 0.9), options.targetBytes) : Math.round(outPx * bpp);
  return { outPx, format, bytes };
}

// Why a file would be left alone under these options ("" = process it).
export function skipReason(file, options, ctx) {
  if (!options.types.includes(file.type)) return "type excluded";
  if (options.excludeFolderIds.includes(file.folderId)) return "folder excluded";
  if (file.size < options.minBytes) return "already small";
  if (options.excludeRe && new RegExp(options.excludeRe, "i").test(file.name)) return "name excluded";
  if (file.size > 270 * 1024 * 1024) return "over 270 MB";
  if (options.skipRecentDays && file.mtime > Date.now() - options.skipRecentDays * 86400e3) return `modified in the last ${options.skipRecentDays} days`;
  if (options.skipSidecar && file.type === "raw" && file.xmp) return "RAW has an .xmp sidecar (edited)";
  if (ctx.doneBefore.has(file.id)) return "done in an earlier job";
  if (options.mode === "copy" && file.copy) return "copy already exists";
  if (options.mode === "archive" && file.arch) return "already archived";
  if (options.onlyIfSmaller && estimate(file, options).bytes >= file.size * 0.9) return "no worthwhile saving";
  return "";
}

// ---- Drive walk (metadata only) ----
// Existing outputs are detected by name in the mirror folders so a re-run
// never duplicates work even after job history has rolled off.
const mirrorMemo = new Map(); // "_compressed/root/sub" -> Set(names) | null
async function mirrorNames(env, base, relativePath) {
  const key = `${base}/${relativePath}`;
  if (mirrorMemo.has(key)) return mirrorMemo.get(key);
  let parent = env.DRIVE_PARENT_ID || undefined;
  let folder = null;
  for (const segment of [base, ...relativePath.split("/").filter(Boolean)]) {
    folder = await driveFindFolder(env, segment, parent);
    if (!folder) break;
    parent = folder.id;
  }
  let names = null;
  if (folder) {
    names = new Set();
    let pageToken = "";
    do {
      const page = await driveListFolder(env, folder.id, pageToken, { pageSize: 1000 });
      for (const f of page.files || []) names.add(f.name.replace(/\.[^.]+$/, "").toLowerCase());
      pageToken = page.nextPageToken || "";
    } while (pageToken);
  }
  mirrorMemo.set(key, names);
  setTimeout(() => mirrorMemo.delete(key), 60_000);
  return names;
}

export async function walk(env, folderId, options, out, path, depth, seen, parentIndex = -1) {
  if (seen.has(folderId) || depth > 8 || out.files.length >= MAX_FILES) return;
  seen.add(folderId);
  const folderIndex = out.folders.push({ id: folderId, name: path.split("/").pop(), path, depth, parent: parentIndex }) - 1;
  const entries = [];
  let pageToken = "";
  do {
    const page = await driveListFolder(env, folderId, pageToken, { pageSize: 1000 });
    for (const f of page.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        if (options.recursive && !/^_(archive|compressed|previews)$/.test(f.name)) await walk(env, f.id, options, out, `${path}/${f.name}`, depth + 1, seen, folderIndex);
      } else entries.push(f);
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  const sidecars = new Set(entries.filter((f) => /\.xmp$/i.test(f.name)).map((f) => f.name.replace(/\.xmp$/i, "").toLowerCase()));
  const [copies, archived] = await Promise.all([mirrorNames(env, "_compressed", path), mirrorNames(env, "_archive", path)]);
  for (const f of entries) {
    const file = { id: f.id, name: f.name, size: Number(f.size) || 0, mime: f.mimeType || "", w: Number(f.imageMediaMetadata?.width) || 0, h: Number(f.imageMediaMetadata?.height) || 0, mtime: Date.parse(f.modifiedTime) || 0, folderId, folderIndex, path };
    file.type = typeOf(file);
    if (!file.type) continue;
    const base = f.name.replace(/\.[^.]+$/, "").toLowerCase();
    file.xmp = sidecars.has(base);
    file.copy = !!copies?.has(base);
    file.arch = !!archived?.has(base);
    out.files.push(file);
    if (out.files.length >= MAX_FILES) return;
  }
}

async function walkRoots(env, options) {
  const out = { files: [], folders: [], roots: [] };
  const seen = new Set();
  for (const id of options.folderIds) {
    const meta = await driveFileMeta(env, id);
    if (!meta?.id) return { error: json({ error: `folder ${id} not found` }, 404) };
    out.roots.push({ id, name: meta.name });
    await walk(env, id, options, out, meta.name, 0, seen);
  }
  return out;
}

// ---- admin: scan (no KV) ----
export async function scanImages(request, env) {
  const options = normalizeOptions(await request.json().catch(() => ({})));
  if (!options.folderIds.length) return json({ error: "pick at least one folder" }, 400);
  const out = await walkRoots(env, options);
  if (out.error) return out.error;
  const jobs = await loadJobs(env);
  const doneBefore = [...new Set(jobs.flatMap((j) => j.items.filter((i) => i.ok && !i.undone).map((i) => i.id)))];
  return json({
    roots: out.roots,
    folders: out.folders,
    doneBefore,
    capped: out.files.length >= MAX_FILES,
    rows: out.files.map((f) => ({ id: f.id, n: f.name, f: f.folderIndex, t: f.type, s: f.size, w: f.w, h: f.h, m: f.mtime, x: f.xmp ? 1 : 0, c: f.copy ? 1 : 0, a: f.arch ? 1 : 0 })),
    now: Date.now(),
  });
}

// ---- admin: plan (one KV write) ----
export async function planImageJob(request, env) {
  const options = normalizeOptions(await request.json().catch(() => ({})));
  if (!options.folderIds.length) return json({ error: "pick at least one folder" }, 400);
  try {
    const { job } = await planJobRecord(env, options);
    return json({ job: publicJob(job) }, 201);
  } catch (error) {
    return json({ error: error.message }, error.status || 500);
  }
}

// Builds and stores a planned job. Shared by the admin and the rules cron.
export async function planJobRecord(env, options, extra = {}) {
  const jobs = await loadJobs(env);
  const ctx = { doneBefore: new Set(jobs.flatMap((j) => j.items.filter((i) => i.ok && !i.undone).map((i) => i.id))) };
  const out = await walkRoots(env, options);
  if (out.error) throw Object.assign(new Error("a folder was not found"), { status: 404 });
  const digest = { scanned: out.files.length, scannedBytes: 0, byType: {}, skipped: {}, files: 0, bytes: 0, estBytes: 0, etaSec: 0, capped: out.files.length >= MAX_FILES, largest: [] };
  const files = [];
  for (const file of out.files) {
    digest.scannedBytes += file.size;
    digest.byType[file.type] = (digest.byType[file.type] || 0) + 1;
    const why = skipReason(file, options, ctx);
    if (why) {
      digest.skipped[why] = (digest.skipped[why] || 0) + 1;
      continue;
    }
    const est = estimate(file, options);
    files.push({ id: file.id, name: file.name, size: file.size, mime: file.mime, w: file.w, h: file.h, type: file.type, folderId: file.folderId, path: file.path, format: est.format, est: est.bytes });
    digest.bytes += file.size;
    digest.estBytes += est.bytes;
    digest.etaSec += (SECS[file.type] || 4) + file.size / 6e6 + (options.targetBytes ? 3 : 0);
  }
  if (options.largestFirst) files.sort((a, b) => b.size - a.size);
  digest.files = files.length;
  digest.largest = [...files].sort((a, b) => b.size - a.size).slice(0, 8).map((f) => ({ name: f.name, size: f.size, est: f.est, type: f.type, w: f.w, h: f.h }));
  const job = {
    id: `img-${Date.now().toString(36)}`,
    status: "planned",
    createdAt: Date.now(),
    options,
    roots: out.roots,
    digest,
    progress: { done: 0, failed: 0, skipped: 0, bytesIn: 0, bytesOut: 0 },
    outputs: [],
    runIds: [],
    items: [],
    files,
    ...extra,
  };
  // A new plan replaces any older un-started plan; running jobs are kept.
  const next = [job, ...jobs.filter((j) => j.status !== "planned")];
  await saveJobs(env, next);
  return { job, jobs: next };
}

// ---- admin: quick picks (folders already known to the app) ----
export async function imageSources(env) {
  const shareSlugs = (await env.KV.get("shares:index", "json")) || [];
  const shares = [];
  for (const slug of shareSlugs) {
    const share = await env.KV.get(`share:${slug}`, "json");
    if (!share) continue;
    const folders = [];
    for (const id of (share.folderIds || []).slice(0, 10)) {
      const meta = await driveFileMeta(env, id);
      if (meta?.id) folders.push({ id, name: meta.name });
    }
    if (folders.length) shares.push({ slug, label: share.label || slug, state: shareState(share), folders });
  }
  const links = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: "link:", cursor });
    for (const key of page.keys) {
      const link = await env.KV.get(key.name, "json");
      if (link?.folderId) links.push({ slug: link.slug, label: link.label || link.slug, folder: { id: link.folderId, name: link.folderName || link.label || link.slug } });
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return json({ shares, links });
}
