// Share preview-equivalents (media-cache spec §5, §6): WebP renditions of
// RAW / HEIC / TIFF and oversized originals, made by
// scripts/transcode-share-previews.mjs and kept in R2 as the
// `preview-webp` media variant. Originals are never touched.
//
//   KV  share-previews:index  { files: { <fileId>: { r: rev, s: bytes, at,
//                              w, h, skip?: "gainmap" } }, runs: [last 20] }
//   R2  media/<fileId>/preview-webp-<rev>

import { cleanText, json, shareState } from "./util.js";
import { typeOf } from "./images.js";
import { mediaRev, mediaUrl, mediaVariantTier, r2PutBytes } from "./media-cache.js";
import { accessToken, driveCreateFolder, driveFindFolder, driveFileMetaCached, driveThumbnail, driveTrashFile } from "./drive.js";
import { mediaSig } from "./share-token.js";
import { getAllShares } from "./share-admin.js";
import { loadFiles } from "./share-index.js";
import { appLog } from "./applog.js";
import { liveStub } from "./store.js";

const INDEX_KEY = "share-previews:index";
// KV has no compare-and-set, and a run reports from eight shards at once. A
// read-modify-write of one key therefore loses most of what they say: every
// run made a few hundred previews and the backlog only fell by a fraction,
// because whichever shard wrote last erased the others. Each shard now owns
// one delta key. Readers union the deltas over the base index; a dispatch
// folds them in and deletes them, which is safe because the new run's shards
// have not written anything yet.
const DELTA_PREFIX = "share-previews:delta:";
// Long enough that a delta is always folded into the base by a later run,
// short enough that reads never union more than a couple of runs' worth.
const DELTA_TTL_SEC = 3 * 24 * 3600;
const RUNS_KEPT = 20;
const WORKFLOW = "transcode-share-previews.yml";
// Decodable in a browser but heavy enough that the WebP wins by default and
// the original becomes opt-in ("Load original").
export const HEAVY_BYTES = 50 * 1024 * 1024;

function mergeRun(runs, incoming) {
  const run = runs.find((r) => r.id === incoming.id);
  if (!run) {
    runs.unshift({ ...incoming });
    return;
  }
  run.startedAt = Math.min(run.startedAt || incoming.startedAt, incoming.startedAt || run.startedAt);
  for (const k of ["done", "skipped", "kept", "bytes"]) run[k] = (run[k] || 0) + (incoming[k] || 0);
  run.shardsDone = (run.shardsDone || 0) + (incoming.finishedAt ? 1 : 0);
  if (incoming.finishedAt) run.finishedAt = Math.max(run.finishedAt || 0, incoming.finishedAt);
  if (incoming.pendingLeft != null) run.pendingLeft = Math.min(run.pendingLeft ?? incoming.pendingLeft, incoming.pendingLeft);
}

async function readDeltas(env) {
  const { keys } = await env.KV.list({ prefix: DELTA_PREFIX });
  return (await Promise.all(keys.map((k) => env.KV.get(k.name, "json").then((v) => [k.name, v])))).filter(([, v]) => v);
}

export async function sharePreviewIndex(env) {
  const raw = (await env.KV.get(INDEX_KEY, "json")) || {};
  const index = { files: { ...(raw.files || {}) }, runs: (raw.runs || []).map((r) => ({ ...r })) };
  for (const [, delta] of await readDeltas(env)) {
    // Per file, not per key: putSharePreview records the Drive id in the base
    // index and the runner's report adds the rev and size, so one must not
    // clobber the other.
    for (const [id, entry] of Object.entries(delta.files || {})) index.files[id] = { ...(index.files[id] || {}), ...entry };
    for (const run of delta.runs || []) mergeRun(index.runs, run);
  }
  index.runs.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  index.runs = index.runs.slice(0, RUNS_KEPT);
  return index;
}
const saveIndex = (env, index) => env.KV.put(INDEX_KEY, JSON.stringify(index));

// Fold the shard deltas into the base index. Deleting them here would race
// with a shard writing one between the read and the delete - which cost
// exactly one file the first night - so they expire on their own instead.
// Merging a delta that is already in the base is idempotent.
async function compactPreviewIndex(env) {
  const deltas = await readDeltas(env);
  if (!deltas.length) return 0;
  await saveIndex(env, await sharePreviewIndex(env));
  return deltas.length;
}

// Which files want a preview-equivalent: anything a browser cannot decode
// (RAW, HEIC, TIFF) and decodable images at or over HEAVY_BYTES.
export function wantsPreview(file) {
  const mime = file.mime || file.mimeType || "";
  if (!/^image\//.test(mime) && !typeOf({ name: file.name || "", mime })) return false;
  const type = typeOf({ name: file.name || "", mime });
  if (["raw", "heic", "tiff"].includes(type)) return true;
  return (Number(file.size) || 0) >= HEAVY_BYTES && /^image\/(jpe?g|png|webp)$/.test(mime);
}

// Fields for one listed file: the preview replaces the "max" tier, and
// heavy originals stop auto-loading in the viewer.
export async function sharePreviewFields(env, slug, f, index) {
  const wants = wantsPreview({ name: f.name, mime: f.mimeType, size: f.size });
  if (!wants) return {};
  const entry = index.files[f.id];
  const rev = mediaRev(f);
  const fields = { heavy: (Number(f.size) || 0) >= HEAVY_BYTES && /^image\/(jpe?g|png|webp)$/.test(f.mimeType || "") };
  if (!entry || entry.r !== rev) return { ...fields, previewImage: false };
  if (entry.skip) return { ...fields, previewImage: false, previewSkip: entry.skip };
  const url = mediaUrl(slug, f.id, "preview-webp", rev, await mediaSig(env, slug, f.id));
  return { ...fields, previewImage: true, previewImageUrl: url, previewImageBytes: entry.s || 0 };
}

// ---- runner API ----
// Every indexed share's file rows, filtered to what wants a preview and has
// none for its current revision. Sharded like previews.js.
export async function listPendingSharePreviews(request, env) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get("limit")) || 300));
  const shards = Math.max(1, Math.min(20, Number(url.searchParams.get("shards")) || 1));
  const shard = Math.max(0, Math.min(shards - 1, Number(url.searchParams.get("shard")) || 0));
  const index = await sharePreviewIndex(env);
  const seen = new Set();
  const pending = [];
  for (const share of await getAllShares(env)) {
    if (share.mode !== "gallery" || shareState(share) !== "active") continue;
    for (const row of await loadFiles(env, share.slug)) {
      if (seen.has(row.id) || !wantsPreview({ name: row.n, mime: row.m, size: row.s })) continue;
      seen.add(row.id);
      const entry = index.files[row.id];
      if (entry && entry.r === row.r) continue;
      pending.push({ id: row.id, name: row.n, mime: row.m, size: row.s, rev: row.r, slug: share.slug });
    }
  }
  pending.sort((a, b) => b.size - a.size);
  const mine = shards > 1 ? pending.filter((f) => shardOf(f.id, shards) === shard) : pending;
  return json({ pending: mine.slice(0, Math.ceil(limit / shards)), total: pending.length, shard, shards });
}

function shardOf(id, shards) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i += 1) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return (h >>> 0) % shards;
}

const MAX_PREVIEW_BYTES = 40 * 1024 * 1024;

// Full previews live in Drive (cold storage), not R2. R2 stays under its 10 GB
// free tier by only ever holding the lo/md thumbnails.
const PREV_FOLDER_KEY = "share-previews:folder";
const PREV_FOLDER_NAME = "_share_previews";
async function sharePreviewFolderId(env) {
  const cached = await env.KV.get(PREV_FOLDER_KEY);
  if (cached) return cached;
  const parent = env.DRIVE_PARENT_ID || undefined;
  const folder = (await driveFindFolder(env, PREV_FOLDER_NAME, parent)) || (await driveCreateFolder(env, PREV_FOLDER_NAME, parent));
  await env.KV.put(PREV_FOLDER_KEY, folder.id);
  return folder.id;
}
export async function driveUploadWebp(env, name, bytes, appProperties) {
  const tok = await accessToken(env);
  const meta = { name, parents: [await sharePreviewFolderId(env)], appProperties };
  const boundary = `hd-${crypto.randomUUID()}`;
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: image/webp\r\n\r\n`;
  const payload = new Blob([head, bytes, `\r\n--${boundary}--`]);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size&supportsAllDrives=true", {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: payload,
  });
  if (!r.ok) throw new Error("Drive upload failed: " + (await r.text()).slice(0, 200));
  return r.json();
}

// Runner PUTs the WebP bytes; we store them in Drive and record the Drive id so
// serveMedia can stream the preview on demand. A superseded revision's Drive
// file is trashed.
export async function putSharePreview(request, env, fileId) {
  const id = cleanText(fileId, 120).replace(/[^a-zA-Z0-9_-]/g, "");
  const rev = cleanText(new URL(request.url).searchParams.get("rev") || "", 16).replace(/[^a-z0-9]/gi, "");
  if (!id || !rev) return json({ error: "file id and rev required" }, 400);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_PREVIEW_BYTES) return json({ error: "empty or too large" }, 413);
  let created;
  try {
    created = await driveUploadWebp(env, `${id}-${rev}.webp`, body, { sharePreviewOf: id, rev });
  } catch (e) {
    return json({ error: String(e.message || e) }, 502);
  }
  if (!created?.id) return json({ error: "Drive upload failed" }, 502);
  // Eight shards PUT at once and KV has no compare-and-set: writing the base
  // index from here lost other PUTs' Drive ids. The Durable Object applies
  // them one batch at a time instead (see applyPreviewReports).
  const put = { id, r: rev, s: body.byteLength, d: created.id };
  if (env.LIVE_TRACKER) {
    const r = await liveStub(env).fetch("https://live.internal/share-preview-put", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(put) });
    if (!r.ok) return json({ error: "index update failed" }, 502);
  } else await applySharePreviewPuts(env, [put]);
  return json({ ok: true, bytes: body.byteLength, driveId: created.id }, 201);
}

export async function applySharePreviewPuts(env, puts) {
  const index = await sharePreviewIndex(env);
  const replaced = [];
  for (const { id, r, s, d } of puts) {
    const prev = index.files[id];
    if (prev?.d && prev.d !== d) replaced.push(prev.d);
    index.files[id] = { ...(prev || {}), r, s, at: Date.now(), d };
  }
  await saveIndex(env, index);
  await Promise.all(replaced.map((d) => driveTrashFile(env, d).catch(() => {})));
  return { ok: true };
}

// Batch report: {runId, done:[{id, rev, name, size, ms, via, w, h}],
// skipped:[{id, rev, name, error, gainmap?}], finished?, pendingLeft?}
export async function reportSharePreviews(request, env, ctx) {
  const b = await request.json().catch(() => null);
  if (!b?.runId) return json({ error: "runId required" }, 400);
  const runId = String(b.runId).slice(0, 40);
  const shard = String(Math.max(0, Math.min(63, Number(b.shard) || 0)));
  // This shard's own key: nobody else writes it, so read-modify-write is safe.
  const deltaKey = `${DELTA_PREFIX}${runId}-${shard}`;
  const index = (await env.KV.get(deltaKey, "json")) || { files: {}, runs: [] };
  const now = Date.now();
  for (const d of b.done || []) {
    if (!d.id || !d.rev) continue;
    index.files[d.id] = { ...(index.files[d.id] || {}), r: cleanText(d.rev, 16), s: Number(d.size) || 0, at: now, w: Number(d.w) || 0, h: Number(d.h) || 0 };
  }
  const failed = [];
  for (const s of b.skipped || []) {
    if (!s.id || !s.rev) continue;
    // Gain-map HDR is a decision, not a failure: the original is served.
    // "unsupported" = every decoder refused: also served as-is, and not
    // retried night after night. Anything else is transient and retried.
    if (s.gainmap) index.files[s.id] = { r: cleanText(s.rev, 16), at: now, skip: "gainmap" };
    else if (s.unsupported) index.files[s.id] = { r: cleanText(s.rev, 16), at: now, skip: "unsupported", why: cleanText(s.error || "", 160) };
    else failed.push(`${cleanText(s.name || s.id, 80)}: ${cleanText(s.error || "", 120)}`);
  }
  if (failed.length) appLog(env, ctx, { level: "warn", area: "share-previews", message: `${failed.length} preview(s) failed this batch (will retry)`, detail: failed.slice(0, 20) });
  const run = index.runs.find((r) => r.id === runId) || { id: runId, startedAt: now, done: 0, skipped: 0, bytes: 0 };
  run.done += (b.done || []).length;
  run.skipped += (b.skipped || []).filter((s) => !s.gainmap && !s.unsupported).length;
  run.kept = (run.kept || 0) + (b.skipped || []).filter((s) => s.gainmap || s.unsupported).length;
  run.bytes += (b.done || []).reduce((t, d) => t + (Number(d.size) || 0), 0);
  if (b.finishedAt || b.finished) {
    run.finishedAt = now;
    run.pendingLeft = Number(b.pendingLeft) || 0;
    appLog(env, ctx, { area: "share-previews", message: `run ${runId} finished: ${run.done} previews, ${run.kept || 0} kept as original (HDR / undecodable), ${run.skipped} failed, ${run.pendingLeft} left` });
  }
  if (!index.runs.some((r) => r.id === runId)) index.runs.unshift(run);
  await env.KV.put(deltaKey, JSON.stringify(index), { expirationTtl: DELTA_TTL_SEC });
  return json({ ok: true, indexed: Object.keys(index.files).length });
}

// Kick the runner (admin button, or the end of a share-index job).
export async function dispatchSharePreviews(env, { limit = 5000, shards = 8 } = {}) {
  await compactPreviewIndex(env).catch(() => {});
  if (!env.GITHUB_TOKEN) return { dispatched: false, reason: "GITHUB_TOKEN not set - the nightly run will pick it up" };
  const repo = env.GITHUB_REPO || "DhakadG/husky-drop";
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "husky-drop-worker", "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { limit: String(limit), shards: String(shards) } }),
  });
  return r.status === 204 ? { dispatched: true } : { dispatched: false, reason: `GitHub refused: ${r.status}` };
}

export async function startSharePreviews(request, env) {
  const b = await request.json().catch(() => ({}));
  const result = await dispatchSharePreviews(env, { limit: Math.max(1, Math.min(5000, Number(b.limit) || 5000)), shards: Math.max(1, Math.min(20, Number(b.shards) || 8)) });
  const index = await sharePreviewIndex(env);
  return json({ ok: true, ...result, indexed: Object.keys(index.files).length, runs: index.runs.slice(0, 5) }, result.dispatched ? 202 : 200);
}

// ---- WebP thumbnails (runner-made) ----
// Drive hands out JPEG thumbnails; the runner re-encodes them as WebP under
// the same content-addressed key so R2 holds a third of the bytes and every
// viewer downloads a third of the bytes. The Worker itself never encodes.
// Only the two page-load tiers (lo/md) are stored in R2; the 1600px hover tier
// is served live from Google + edge cache, so the runner never makes it.
export async function listPendingShareThumbs(request, env) {
  const url = new URL(request.url);
  const limit = Math.max(1, Math.min(50_000, Number(url.searchParams.get("limit")) || 20_000));
  const shards = Math.max(1, Math.min(20, Number(url.searchParams.get("shards")) || 1));
  const shard = Math.max(0, Math.min(shards - 1, Number(url.searchParams.get("shard")) || 0));
  const seen = new Set();
  const rows = [];
  for (const share of await getAllShares(env)) {
    if (share.mode !== "gallery" || shareState(share) !== "active") continue;
    for (const f of await loadFiles(env, share.slug)) {
      if (seen.has(f.id) || !f.th || !/^(image|video)\//.test(f.m || "")) continue;
      seen.add(f.id);
      rows.push({ id: f.id, rev: f.r, v: ["thumb-lo", "thumb-md"] });
    }
  }
  const mine = shards > 1 ? rows.filter((r) => shardOf(r.id, shards) === shard) : rows;
  return json({ pending: mine.slice(0, Math.ceil(limit / shards)), total: rows.length, shard, shards });
}

// 204 when R2 already holds a WebP for this key; otherwise Drive's JPEG.
export async function shareThumbSource(request, env, parts) {
  const [fileId, variant, rev] = parts.map((p) => cleanText(p || "", 120).replace(/[^a-zA-Z0-9_-]/g, ""));
  if (!fileId || !variant || !rev || !env.MEDIA_BUCKET) return json({ error: "bad request" }, 400);
  const head = await env.MEDIA_BUCKET.head(`media/${fileId}/${variant}-${rev}`).catch(() => null);
  if (head?.httpMetadata?.contentType === "image/webp") return new Response(null, { status: 204 });
  const meta = await driveFileMetaCached(env, fileId);
  const asset = meta?.thumbnailLink ? await driveThumbnail(env, meta, mediaVariantTier(variant)) : null;
  if (!asset?.response?.body) return json({ error: "thumbnail unavailable" }, 404);
  return new Response(asset.response.body, { headers: { "content-type": asset.response.headers.get("content-type") || "image/jpeg" } });
}

const R2_THUMB_VARIANTS = new Set(["thumb-lo", "thumb-md"]);
// ---- one-time migration: preview-webp R2 -> Drive ----
// Moves the WebPs that used to live in R2 into Drive's _share_previews folder
// so R2 drops back under its 10 GB cap without re-encoding anything. Idempotent
// and resumable: entries that already have a Drive id (`d`) are skipped, so a
// runner just calls this until `remaining` is 0. Drive upload + index save
// happen BEFORE the R2 delete, so an interrupted run never loses the only copy.
export async function migratePreviewsToDrive(request, env) {
  if (!env.MEDIA_BUCKET) return json({ error: "MEDIA_BUCKET not bound" }, 503);
  const limit = Math.max(1, Math.min(20, Number(new URL(request.url).searchParams.get("limit")) || 12));
  const index = await sharePreviewIndex(env);
  const pending = Object.keys(index.files).filter((id) => index.files[id].r && !index.files[id].d && !index.files[id].skip);
  const todo = pending.slice(0, limit);
  const results = await Promise.all(
    todo.map(async (id) => {
      const e = index.files[id];
      try {
        const obj = await env.MEDIA_BUCKET.get(`media/${id}/preview-webp-${e.r}`);
        if (!obj) return { id, gone: true }; // no R2 object (already swept): drop the stale entry
        const bytes = await obj.arrayBuffer();
        const created = await driveUploadWebp(env, `${id}-${e.r}.webp`, bytes, { sharePreviewOf: id, rev: e.r });
        return { id, d: created.id, s: bytes.byteLength };
      } catch (err) {
        return { id, error: String(err?.message || err).slice(0, 120) };
      }
    }),
  );
  let migrated = 0;
  let gone = 0;
  const failed = [];
  for (const r of results) {
    if (r.gone) {
      delete index.files[r.id];
      gone += 1;
    } else if (r.d) {
      index.files[r.id] = { ...index.files[r.id], s: r.s, at: Date.now(), d: r.d };
      migrated += 1;
    } else failed.push(r.error);
  }
  await saveIndex(env, index);
  // Only now, with the Drive copy indexed and durable, drop the R2 bytes.
  await Promise.all(results.filter((r) => r.d).map((r) => env.MEDIA_BUCKET.delete(`media/${r.id}/preview-webp-${index.files[r.id].r}`).catch(() => {})));
  return json({ ok: true, migrated, gone, failed: failed.length, remaining: Math.max(0, pending.length - migrated - gone - failed.length) });
}

// ---- one-time sweep: evict the tier that no longer belongs in R2 ----
// thumb-hi is now served live from Google + edge cache, so its old R2 objects
// are dead weight. video-720 stays: watched previews are a deliberate on-demand
// R2 cache. preview-webp is left to the migration above (its R2 copy may still
// be the only one). Cursor-paged; loop until null.
const R2_EVICT = new Set(["thumb-hi"]);
export async function sweepStaleTiers(request, env) {
  if (!env.MEDIA_BUCKET) return json({ error: "MEDIA_BUCKET not bound" }, 503);
  const b = await request.json().catch(() => ({}));
  const page = await env.MEDIA_BUCKET.list({ prefix: "media/", cursor: b.cursor || undefined, limit: 1000 });
  const doomed = [];
  for (const obj of page.objects || []) {
    const m = obj.key.match(/^media\/[^/]+\/(.+)-[A-Za-z0-9]{1,16}$/);
    if (m && R2_EVICT.has(m[1])) doomed.push(obj.key);
  }
  if (doomed.length && !b.dryRun) await env.MEDIA_BUCKET.delete(doomed);
  return json({ ok: true, scanned: (page.objects || []).length, removed: b.dryRun ? 0 : doomed.length, wouldRemove: doomed.length, cursor: page.truncated ? page.cursor : null });
}

export async function putShareThumb(request, env, parts) {
  const [fileId, variant, rev] = parts.map((p) => cleanText(p || "", 120).replace(/[^a-zA-Z0-9_-]/g, ""));
  if (!fileId || !R2_THUMB_VARIANTS.has(variant) || !rev || !env.MEDIA_BUCKET) return json({ error: "bad request" }, 400);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > 8 * 1024 * 1024) return json({ error: "empty or too large" }, 413);
  await r2PutBytes(env.MEDIA_BUCKET, `media/${fileId}/${variant}-${rev}`, body, "image/webp");
  return json({ ok: true, bytes: body.byteLength }, 201);
}
