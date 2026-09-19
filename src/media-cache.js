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
// variant -> Drive thumbnail tier (or the 720p preview from previews.js)
const VARIANTS = { "thumb-lo": "base", "thumb-md": "mid", "thumb-hi": "max", "video-720": "preview" };
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

export async function serveMedia(request, ctx, env, { fileId, variant, rev, range = null }) {
  const tier = mediaVariantTier(variant);
  if (!tier) return json({ error: "unknown media variant" }, 404);
  const r2Key = `media/${fileId}/${variant}-${rev}`;
  const edgeKey = new Request(`${EDGE_KEY}/${fileId}/${variant}/${rev}`);
  const cache = caches.default;
  const bucket = env.MEDIA_BUCKET || null;

  if (!range) {
    const hit = await cache.match(edgeKey);
    if (hit?.body) return new Response(hit.body, { status: 200, headers: clientHeaders(hit.headers.get("content-type") || "application/octet-stream", tier, lengthOf(hit.headers)) });
  }

  if (bucket) {
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
    // Not in R2 yet: a ranged request is proxied from Drive below; the next
    // full request fills R2.
  }

  return tier === "preview" ? fromPreview(request, ctx, env, { fileId, r2Key, edgeKey, range, bucket, cache }) : fromThumbnail(ctx, env, { fileId, tier, r2Key, edgeKey, bucket, cache });
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
  const [clientBody, rest] = r.body.tee();
  const [edgeBody, r2Body] = rest.tee();
  const extra = { "accept-ranges": "bytes", ...(length ? { "content-length": String(length) } : {}) };
  fill(ctx, cache.put(edgeKey, edgeCopy(new Response(edgeBody, { headers: extra }), type)));
  if (bucket && length && typeof FixedLengthStream === "function") {
    // R2 needs a sized stream; a tee branch has no length of its own.
    const sized = new FixedLengthStream(length);
    fill(ctx, Promise.all([r2Body.pipeTo(sized.writable), r2Put(bucket, r2Key, sized.readable, type, length)]));
  } else {
    r2Body.cancel().catch(() => {});
  }
  return new Response(clientBody, { status: 200, headers: clientHeaders(type, "preview", extra) });
}
