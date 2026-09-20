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
import { driveFileMetaCached, driveThumbnail } from "./drive.js";
import { mediaSig } from "./share-token.js";
import { getAllShares } from "./share-admin.js";
import { loadFiles } from "./share-index.js";
import { appLog } from "./applog.js";

const INDEX_KEY = "share-previews:index";
const RUNS_KEPT = 20;
const WORKFLOW = "transcode-share-previews.yml";
// Decodable in a browser but heavy enough that the WebP wins by default and
// the original becomes opt-in ("Load original").
export const HEAVY_BYTES = 50 * 1024 * 1024;

export async function sharePreviewIndex(env) {
  const raw = (await env.KV.get(INDEX_KEY, "json")) || {};
  return { files: raw.files || {}, runs: raw.runs || [] };
}
const saveIndex = (env, index) => env.KV.put(INDEX_KEY, JSON.stringify(index));

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
export async function putSharePreview(request, env, fileId) {
  const id = cleanText(fileId, 120).replace(/[^a-zA-Z0-9_-]/g, "");
  const rev = cleanText(new URL(request.url).searchParams.get("rev") || "", 16).replace(/[^a-z0-9]/gi, "");
  if (!id || !rev) return json({ error: "file id and rev required" }, 400);
  if (!env.MEDIA_BUCKET) return json({ error: "MEDIA_BUCKET not bound" }, 503);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_PREVIEW_BYTES) return json({ error: "empty or too large" }, 413);
  await r2PutBytes(env.MEDIA_BUCKET, `media/${id}/preview-webp-${rev}`, body, "image/webp");
  return json({ ok: true, bytes: body.byteLength }, 201);
}

// Batch report: {runId, done:[{id, rev, name, size, ms, via, w, h}],
// skipped:[{id, rev, name, error, gainmap?}], finished?, pendingLeft?}
export async function reportSharePreviews(request, env, ctx) {
  const b = await request.json().catch(() => null);
  if (!b?.runId) return json({ error: "runId required" }, 400);
  const index = await sharePreviewIndex(env);
  const now = Date.now();
  for (const d of b.done || []) {
    if (!d.id || !d.rev) continue;
    index.files[d.id] = { r: cleanText(d.rev, 16), s: Number(d.size) || 0, at: now, w: Number(d.w) || 0, h: Number(d.h) || 0 };
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
  const runId = String(b.runId).slice(0, 40);
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
  index.runs = index.runs.slice(0, RUNS_KEPT);
  await saveIndex(env, index);
  return json({ ok: true, indexed: Object.keys(index.files).length });
}

// Kick the runner (admin button, or the end of a share-index job).
export async function dispatchSharePreviews(env, { limit = 5000, shards = 8 } = {}) {
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
const THUMB_HI_BYTES = 3 * 1024 * 1024;
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
      const v = ["thumb-lo", "thumb-md"];
      if (/^image\//.test(f.m) && f.s >= THUMB_HI_BYTES) v.push("thumb-hi");
      rows.push({ id: f.id, rev: f.r, v });
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

export async function putShareThumb(request, env, parts) {
  const [fileId, variant, rev] = parts.map((p) => cleanText(p || "", 120).replace(/[^a-zA-Z0-9_-]/g, ""));
  if (!fileId || !mediaVariantTier(variant) || !rev || !env.MEDIA_BUCKET) return json({ error: "bad request" }, 400);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > 8 * 1024 * 1024) return json({ error: "empty or too large" }, 413);
  await r2PutBytes(env.MEDIA_BUCKET, `media/${fileId}/${variant}-${rev}`, body, "image/webp");
  return json({ ok: true, bytes: body.byteLength }, 201);
}
