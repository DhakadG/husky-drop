// Media cache ladder (design spec §1): edge cache -> R2 -> Drive.
//
//   L0  the viewer's browser: URLs are content-addressed and served
//       `immutable`, so the plain HTTP cache keeps them for 30 days.
//   L1  R2 (env.MEDIA_BUCKET) behind Cloudflare's free edge cache. The edge
//       absorbs the hot path; R2 is the durable copy every viewer shares.
//   L2  Google Drive - only on a genuine cold miss.
//
// Keys are `media/<fileId>/<variant>-<rev>` where `rev` is the file's Drive
// md5 (or its modified time). A changed file gets a new key; old objects are
// never looked up again and age out via the bucket's 30-day lifecycle rule.
//
// This module never checks who is asking. The route in share-media.js
// validates the share, the viewer and the URL signature on every request,
// hit or miss, before calling serveMedia() (§1.2).

import { accessToken, driveFileMetaCached, driveThumbnail } from "./drive.js";
import { previewIndex } from "./previews.js";
import { json } from "./util.js";
import { mediaSig } from "./share-token.js";

export const MEDIA_TTL = 30 * 86400; // seconds
const EDGE_KEY = "https://media.internal.share/v1";
// What R2 is allowed to hold, kept deliberately small:
//   - thumb-lo / thumb-md: the page-load thumbnails, always pre-warmed.
//   - video-720: cached lazily on first full play, so only *watched* previews
//     become durable R2 copies (the rest stay in Drive). 30-day lifecycle ages
//     out the ones that stop being watched.
// The 1600px hover tier and RAW/HEIC full previews never touch R2 - they are
// served from Drive/Google on demand and kept warm by the edge cache.
const R2_VARIANTS = new Set(["thumb-lo", "thumb-md"]); // pre-warmed + runner-written
const R2_CACHED = new Set(["thumb-lo", "thumb-md", "video-720"]); // read from R2
// variant -> Drive thumbnail tier (or the 720p preview from previews.js)
const VARIANTS = { "thumb-lo": "base", "thumb-md": "mid", "thumb-hi": "max", "video-720": "preview", "preview-webp": "preview-webp" };
export const TIER_VARIANT = { base: "thumb-lo", mid: "thumb-md", max: "thumb-hi" };
export const mediaVariantTier = (variant) => VARIANTS[variant] || "";

// Stable, content-addressed thumbnail URLs for a listed file (spec §1):
// /api/share/media/<slug>/<fileId>/<variant>/<rev>/<sig>. Same file, same
// bytes, same URL - for every viewer, for 30 days.
export const mediaUrl = (slug, fileId, variant, rev, sig) => `/api/share/media/${encodeURIComponent(slug)}/${encodeURIComponent(fileId)}/${variant}/${rev}/${sig}`;

export async function mediaThumbs(env, slug, file) {
  const sig = await mediaSig(env, slug, file.id);
  const rev = mediaRev(file);
  return {
    thumbs: Object.fromEntries(Object.entries(TIER_VARIANT).map(([tier, variant]) => [tier, mediaUrl(slug, file.id, variant, rev, sig)])),
    thumbsExpireAt: Date.now() + MEDIA_TTL * 1000,
  };
}


// Content address of a Drive file for cache keys.
export function mediaRev(file) {
  if (file?.rev) return String(file.rev);
  const md5 = String(file?.md5Checksum || "").replace(/[^a-f0-9]/gi, "");
  if (md5) return md5.slice(0, 16);
  return `m${(Date.parse(file?.modifiedTime || "") || 0).toString(36)}`;
}

function clientHeaders(contentType, tier, extra = {}) {
  return new Headers({
    "content-type": contentType,
    "cache-control": `private, max-age=${MEDIA_TTL}, immutable`,
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-husky-asset-tier": tier,
    ...extra,
  });
}

// Parses a single `bytes=a-b` range. `bytes=0-` (the whole file, which is how
// <video> opens a source) is treated as a full request so it can fill the
// caches; other ranges read straight from R2 or Drive.
export function parseMediaRange(value) {
  const m = String(value || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!m || (!m[1] && !m[2])) return null;
  if (m[1] === "0" && !m[2]) return null;
  return { start: m[1] ? Number(m[1]) : NaN, end: m[2] ? Number(m[2]) : NaN };
}

export async function serveMedia(request, ctx, env, { fileId, variant, rev, range = null, download = "" }) {
  const tier = mediaVariantTier(variant);
  if (!tier) return json({ error: "unknown media variant" }, 404);
  // "smaller (WebP)" downloads (spec §6): same bytes, saved as a file.
  const res = await serveMediaInner(request, ctx, env, { fileId, variant, rev, range, tier });
  if (!download || res.status >= 300) return res;
  const headers = new Headers(res.headers);
  headers.set("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(download)}`);
  return new Response(res.body, { status: res.status, headers });
}

async function serveMediaInner(request, ctx, env, { fileId, variant, rev, range, tier }) {
  const r2Key = `media/${fileId}/${variant}-${rev}`;
  const edgeKey = new Request(`${EDGE_KEY}/${fileId}/${variant}/${rev}`);
  const cache = caches.default;
  const bucket = env.MEDIA_BUCKET || null;

  if (!range) {
    const hit = await cache.match(edgeKey);
    if (hit?.body) return new Response(hit.body, { status: 200, headers: clientHeaders(hit.headers.get("content-type") || "application/octet-stream", tier, lengthOf(hit.headers)) });
  }

  // R2 is consulted for the two thumbnail tiers (always present) and for
  // video-720 (cached on first play - see below). thumb-hi and preview-webp
  // never touch R2.
  if (bucket && R2_CACHED.has(variant)) {
    const obj = await bucket.get(r2Key, range ? { range: r2Range(range) } : undefined).catch(() => null);
    if (obj?.body) {
      const type = obj.httpMetadata?.contentType || "application/octet-stream";
      if (range) {
        const start = obj.range?.suffix != null ? obj.size - obj.range.suffix : obj.range?.offset || 0;
        const end = obj.range?.length != null && obj.range?.suffix == null ? start + obj.range.length - 1 : obj.size - 1;
        return partial(obj.body, type, tier, start, end, obj.size);
      }
      const res = new Response(obj.body, { status: 200, headers: clientHeaders(type, tier, { "content-length": String(obj.size), "accept-ranges": "bytes" }) });
      fill(ctx, cache.put(edgeKey, edgeCopy(res.clone(), type)));
      return res;
    }
    // Not in R2 yet: fall through; the source path below fills it.
  }

  // preview-webp: RAW/HEIC/TIFF full preview, kept in Drive's _share_previews
  // folder, streamed on demand and edge-cached (never R2).
  if (tier === "preview-webp") return fromDrivePreview(request, ctx, env, { fileId, r2Key, edgeKey, bucket, cache });
  // 720p video: streamed from Drive, and a full (byte-0) play warms R2 so the
  // watched previews - and only those - become the durable R2 copy.
  if (tier === "preview") return fromPreview(request, ctx, env, { fileId, r2Key, edgeKey, range, bucket, cache });
  return fromThumbnail(ctx, env, { fileId, tier, r2Key, edgeKey, bucket: R2_VARIANTS.has(variant) ? bucket : null, cache });
}

function lengthOf(headers) {
  const length = headers.get("content-length");
  return length ? { "content-length": length } : {};
}

function r2Range(range) {
  if (Number.isNaN(range.start)) return { suffix: range.end };
  return Number.isNaN(range.end) ? { offset: range.start } : { offset: range.start, length: range.end - range.start + 1 };
}

function partial(body, type, tier, start, end, total) {
  return new Response(body, {
    status: 206,
    headers: clientHeaders(type, tier, { "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(end - start + 1), "accept-ranges": "bytes" }),
  });
}

function edgeCopy(res, type) {
  const headers = new Headers({ "content-type": type, "cache-control": `public, max-age=${MEDIA_TTL}, immutable` });
  const length = res.headers.get("content-length");
  if (length) headers.set("content-length", length);
  return new Response(res.body, { status: 200, headers });
}

function fill(ctx, promise) {
  const guarded = promise.catch((error) => console.warn("media cache fill skipped", String(error?.message || error)));
  if (ctx?.waitUntil) ctx.waitUntil(guarded);
  return guarded;
}

const r2Put = (bucket, key, body, type, length) =>
  bucket.put(key, body, {
    httpMetadata: { contentType: type, cacheControl: `public, max-age=${MEDIA_TTL}, immutable` },
    ...(length ? { customMetadata: { length: String(length) } } : {}),
  });
// Runner-produced objects (share previews) land here directly.
export const r2PutBytes = (bucket, key, bytes, type) => r2Put(bucket, key, bytes, type, bytes.byteLength);

// Pre-warm (spec §4 step 2): put one thumbnail variant into R2 unless it is
// there already. Returns the subrequests spent so chunked jobs can budget.
export async function warmMedia(env, fileId, variant, rev) {
  const bucket = env.MEDIA_BUCKET;
  if (!bucket || !R2_VARIANTS.has(variant)) return 0; // only lo/md thumbs live in R2

  const r2Key = `media/${fileId}/${variant}-${rev}`;
  if (await bucket.head(r2Key).catch(() => null)) return 1;
  const meta = await driveFileMetaCached(env, fileId);
  if (!meta?.thumbnailLink) return 2;
  const asset = await driveThumbnail(env, meta, mediaVariantTier(variant));
  if (!asset?.response?.body) return 3;
  const bytes = await asset.response.arrayBuffer();
  await r2Put(bucket, r2Key, bytes, asset.response.headers.get("content-type") || "image/jpeg", bytes.byteLength);
  return 4;
}

// L2 for thumbnails: Drive's bounded derivative, buffered (a 1600px JPEG is
// well under a megabyte) so one fetch feeds the client, the edge and R2.
async function fromThumbnail(ctx, env, { fileId, tier, r2Key, edgeKey, bucket, cache }) {
  const meta = await driveFileMetaCached(env, fileId);
  if (!meta?.id || !meta.thumbnailLink) return json({ error: "thumbnail unavailable" }, 404);
  const asset = await driveThumbnail(env, meta, tier);
  if (!asset?.response?.body) return json({ error: "thumbnail unavailable" }, 404);
  const type = asset.response.headers.get("content-type") || "image/jpeg";
  const bytes = await asset.response.arrayBuffer();
  const res = new Response(bytes, { status: 200, headers: clientHeaders(type, tier, { "content-length": String(bytes.byteLength) }) });
  fill(ctx, cache.put(edgeKey, edgeCopy(res.clone(), type)));
  if (bucket) fill(ctx, r2Put(bucket, r2Key, bytes, type, bytes.byteLength));
  return res;
}

// L2 for the 720p video preview that previews.js keeps in Drive's _previews
// folder. Full requests stream to the client while a tee fills the edge and
// (when the runtime can size the stream) R2. Ranged requests are proxied.
async function fromPreview(request, ctx, env, { fileId, r2Key, edgeKey, range, bucket, cache }) {
  const index = await previewIndex(env);
  const entry = index.files[fileId];
  if (!entry?.id) return json({ error: "preview unavailable" }, 404);
  const tok = await accessToken(env);
  const headers = new Headers({ authorization: `Bearer ${tok}` });
  if (range) headers.set("range", `bytes=${Number.isNaN(range.start) ? "" : range.start}-${Number.isNaN(range.end) ? "" : range.end}`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(entry.id)}?alt=media&supportsAllDrives=true`, { headers, signal: request.signal });
  if (r.status === 416) return new Response(null, { status: 416, headers: { "content-range": r.headers.get("content-range") || "bytes */0" } });
  if (!(r.status === 200 || r.status === 206) || !r.body) return json({ error: "Drive download failed" }, 502);
  const type = r.headers.get("content-type") || "video/mp4";
  if (range) {
    const m = (r.headers.get("content-range") || "").match(/^bytes (\d+)-(\d+)\/(\d+)$/);
    if (r.status !== 206 || !m) return json({ error: "Drive returned an invalid media range" }, 502);
    return partial(r.body, type, "preview", Number(m[1]), Number(m[2]), Number(m[3]));
  }
  const length = Number(r.headers.get("content-length")) || 0;
  // A full (byte-0) play fills the edge and, when the runtime can size the
  // stream, warms R2 - so a watched preview becomes the durable R2 copy.
  const [clientBody, rest] = r.body.tee();
  const [edgeBody, r2Body] = rest.tee();
  const extra = { "accept-ranges": "bytes", ...(length ? { "content-length": String(length) } : {}) };
  fill(ctx, cache.put(edgeKey, edgeCopy(new Response(edgeBody, { headers: extra }), type)));
  if (bucket && length && typeof FixedLengthStream === "function") {
    const sized = new FixedLengthStream(length);
    fill(ctx, Promise.all([r2Body.pipeTo(sized.writable), r2Put(bucket, r2Key, sized.readable, type, length)]));
  } else {
    r2Body.cancel().catch(() => {});
  }
  return new Response(clientBody, { status: 200, headers: clientHeaders(type, "preview", extra) });
}

// preview-webp full preview: a WebP in Drive's _share_previews folder. The
// Drive file id lives in share-previews:index (read directly to avoid a
// circular import). WebP is small, so buffer once to feed client + edge; R2
// is never touched.
async function fromDrivePreview(request, ctx, env, { fileId, r2Key, edgeKey, bucket, cache }) {
  const idx = await env.KV.get("share-previews:index", "json").catch(() => null);
  const driveId = idx?.files?.[fileId]?.d;
  if (!driveId) {
    // Not migrated yet: the WebP may still be in R2 from before this change.
    // Serve it (no re-persist) so RAW previews never break mid-migration.
    if (bucket) {
      const obj = await bucket.get(r2Key).catch(() => null);
      if (obj?.body) {
        const res = new Response(obj.body, { status: 200, headers: clientHeaders("image/webp", "preview-webp", { "content-length": String(obj.size) }) });
        fill(ctx, cache.put(edgeKey, edgeCopy(res.clone(), "image/webp")));
        return res;
      }
    }
    return json({ error: "preview not made yet" }, 404);
  }
  const tok = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(driveId)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` }, signal: request.signal });
  if (!r.ok || !r.body) return json({ error: "preview unavailable" }, 502);
  const bytes = await r.arrayBuffer();
  const res = new Response(bytes, { status: 200, headers: clientHeaders("image/webp", "preview-webp", { "content-length": String(bytes.byteLength) }) });
  fill(ctx, cache.put(edgeKey, edgeCopy(res.clone(), "image/webp")));
  return res;
}
