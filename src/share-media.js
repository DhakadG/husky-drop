// Share links: per-file endpoints that stream bytes from Drive - thumbnails,
// inline/attachment downloads with Range support, on-demand EXIF info and
// download-token refresh.

import { cleanText, json, normalizeEvent, sanitizeFilename, sha256 } from "./util.js";
import {
  driveFileChunk,
  driveFileMetaCached,
  driveThumbnail,
  driveThumbnailSize,
  accessToken,
} from "./drive.js";
import { mergeExifMetadata, parseRawExif, shouldParseRawExif } from "./exif.js";
import { bumpShareStats, gatePin, liveStub, mergeEventsKV } from "./store.js";
import { getViewer } from "./auth.js";
import { loadActiveShare, requireViewer } from "./share.js";
import { signShareTokenWithExpiry, verifyShareToken, verifyMediaSig, downloadTokenFrom, publicDownloadSafety } from "./share-token.js";
import { mediaThumbs, mediaVariantTier, parseMediaRange as parseLadderRange, serveMedia } from "./media-cache.js";

// GET /api/share/media/:slug/:fileId/:variant/:rev/:sig - the cache ladder
// behind every thumbnail and 720p preview. Access is checked first, on every
// request, before any cache tier is consulted (§1.2).
export async function shareMedia(request, env, ctx, parts) {
  const [slug, fileId, variant, rev, sig] = parts.map((p) => cleanText(decodeURIComponent(p || ""), 120));
  if (!mediaVariantTier(variant) || !/^[a-z0-9]{1,16}$/i.test(rev)) return json({ error: "media variant not found" }, 404);
  if (!(await verifyMediaSig(env, slug, fileId, sig))) return json({ error: "invalid media signature" }, 403);
  const { share, error } = await loadActiveShare(env, slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);
  const range = variant === "video-720" ? parseLadderRange(request.headers.get("range")) : null;
  const download = sanitizeFilename(cleanText(new URL(request.url).searchParams.get("dl") || "", 240));
  return serveMedia(request, ctx, env, { fileId, variant, rev, range, download });
}

// POST /api/share/warm { slug, pin?, urls:[signed media paths] } - when a
// viewer opens a folder, the client asks us to pre-warm that folder's heavy
// on-demand tiers (thumb-hi, preview-webp) into Cloudflare's edge cache. The
// Worker fetches them from Drive/Google and fills the edge; the viewer's own
// bandwidth is untouched, so the next lightbox open is instant and no data is
// spent until they actually look. lo/md (already in R2) and video (too big to
// warm eagerly) are ignored.
const WARM_TIERS = new Set(["thumb-hi", "preview-webp"]);
const WARM_MAX = 15; // keep the fan-out under the free-tier subrequest budget
export async function shareWarm(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const slug = cleanText(b.slug || "", 60);
  const { share, error } = await loadActiveShare(env, slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);
  const urls = Array.isArray(b.urls) ? b.urls.slice(0, WARM_MAX) : [];
  let warmed = 0;
  await Promise.all(
    urls.map(async (raw) => {
      const m = String(raw || "").match(/^\/api\/share\/media\/([^/]+)\/([^/]+)\/([^/]+)\/([a-z0-9]{1,16})\/([^/?#]+)/i);
      if (!m) return;
      const uslug = decodeURIComponent(m[1]);
      const fileId = decodeURIComponent(m[2]);
      const variant = decodeURIComponent(m[3]);
      const rev = decodeURIComponent(m[4]);
      const sig = decodeURIComponent(m[5]);
      if (uslug !== slug || !WARM_TIERS.has(variant)) return;
      if (!(await verifyMediaSig(env, slug, fileId, sig))) return;
      const res = await serveMedia(request, ctx, env, { fileId, variant, rev }).catch(() => null);
      // serveMedia fills the edge cache via ctx.waitUntil; we don't need the body.
      res?.body?.cancel?.().catch(() => {});
      warmed += 1;
    }),
  );
  return json({ ok: true, warmed });
}

export async function refreshShareDownload(request, env) {
  const b = await request.json().catch(() => ({}));
  const oldToken = downloadTokenFrom(b.dl || b.token);
  const parsed = await verifyShareToken(env, oldToken, "dl", { allowExpired: true });
  if (!parsed) return json({ error: "invalid download token" }, 403);
  const slug = cleanText(b.slug || parsed.slug, 60);
  if (slug !== parsed.slug) return json({ error: "download token does not belong to this share" }, 403);
  const { share, error } = await loadActiveShare(env, slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  const { token, expiresAt } = await signShareTokenWithExpiry(env, "dl", share.slug, parsed.fileId);
  const meta = env.GOOGLE_CLIENT_ID ? await driveFileMetaCached(env, parsed.fileId) : null;
  const media = meta?.thumbnailLink ? await mediaThumbs(env, share.slug, meta) : { thumbs: {}, thumbsExpireAt: 0 };
  return json({ dl: `/api/share/dl/${token}`, dlExpiresAt: expiresAt, ...media });
}


// Full image metadata is deliberately fetched on demand. Returning every EXIF
// field in the 200-item gallery listing makes first paint slower and exposes
// location data before the viewer asks for it. The signed download token proves
// this file came from this share; auth/PIN gates are checked again here.
export async function shareFileInfo(request, env) {
  const b = await request.json().catch(() => ({}));
  const oldToken = downloadTokenFrom(b.dl || b.token);
  const parsed = await verifyShareToken(env, oldToken, "dl");
  if (!parsed) return json({ error: "invalid file token" }, 403);
  const slug = cleanText(b.slug || parsed.slug, 60);
  if (slug !== parsed.slug) return json({ error: "file token does not belong to this share" }, 403);
  const { share, error } = await loadActiveShare(env, slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const meta = await driveFileMetaCached(env, parsed.fileId);
  if (!meta?.id) return json({ error: "file not found" }, 404);
  const driveImage = meta.imageMediaMetadata || {};
  let parsedExif = {};
  if (shouldParseRawExif(meta)) {
    try {
      const chunk = await driveFileChunk(env, parsed.fileId);
      if (chunk) parsedExif = await parseRawExif(chunk);
    } catch (parseError) {
      console.warn("RAW EXIF fallback failed", parsed.fileId, String(parseError?.message || parseError));
    }
  }
  const image = mergeExifMetadata(driveImage, parsedExif);
  const video = meta.videoMediaMetadata || {};
  let width = Number(image.width || video.width) || 0;
  let height = Number(image.height || video.height) || 0;
  if (Number(image.rotation) % 2 === 1) [width, height] = [height, width];
  return json({
    file: {
      id: meta.id,
      name: cleanText(meta.name || "file", 240),
      mime: cleanText(meta.mimeType || "", 140),
      size: Number(meta.size) || 0,
      createdAt: Date.parse(meta.createdTime) || 0,
      modifiedAt: Date.parse(meta.modifiedTime) || 0,
      width,
      height,
      megapixels: width && height ? Math.round((width * height) / 10000) / 100 : 0,
      durationMs: Number(video.durationMillis) || 0,
    },
    exif: {
      cameraMake: cleanText(image.cameraMake || "", 160),
      cameraModel: cleanText(image.cameraModel || "", 160),
      lens: cleanText(image.lens || "", 240),
      time: cleanText(image.time || "", 80),
      aperture: image.aperture ?? null,
      exposureTime: image.exposureTime ?? null,
      exposureBias: image.exposureBias ?? null,
      exposureMode: cleanText(image.exposureMode || "", 80),
      isoSpeed: image.isoSpeed ?? null,
      focalLength: image.focalLength ?? null,
      flashUsed: image.flashUsed ?? null,
      meteringMode: cleanText(image.meteringMode || "", 80),
      whiteBalance: cleanText(image.whiteBalance || "", 80),
      colorSpace: cleanText(image.colorSpace || "", 80),
      sensor: cleanText(image.sensor || "", 160),
      maxApertureValue: image.maxApertureValue ?? null,
      subjectDistance: image.subjectDistance ?? null,
      rotation: image.rotation ?? null,
      exposureProgram: cleanText(image.exposureProgram || "", 100),
      focalLength35mm: image.focalLength35mm ?? null,
      software: cleanText(image.software || "", 200),
      artist: cleanText(image.artist || "", 200),
      copyright: cleanText(image.copyright || "", 240),
      description: cleanText(image.description || "", 300),
      lightSource: cleanText(image.lightSource || "", 100),
      contrast: cleanText(image.contrast || "", 80),
      saturation: cleanText(image.saturation || "", 80),
      sharpness: cleanText(image.sharpness || "", 80),
      customRendered: cleanText(image.customRendered || "", 100),
      source: image.source || "drive",
      location: image.location && typeof image.location === "object"
        ? {
            latitude: Number(image.location.latitude) || null,
            longitude: Number(image.location.longitude) || null,
            altitude: Number(image.location.altitude) || null,
          }
        : null,
    },
  });
}

// Files at or under this size get fully fetched and cached at Cloudflare's
// edge on first inline view; Cloudflare's Cache API then auto-slices Range
// requests (video seeking, resumed image loads) straight from that cached
// copy, so a second view - or the second half of a scrub - never touches
// Drive again. Larger files always stream straight through (uncached).
const EDGE_CACHEABLE_BYTES = 100 * 1024 * 1024;

function shareThumbnailHeaders(source, tier, browserCache = true) {
  const headers = new Headers({
    "content-type": source.get("content-type") || "image/jpeg",
    "cache-control": browserCache ? "private, max-age=900" : "public, max-age=86400",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-husky-asset-tier": tier,
  });
  const length = source.get("content-length");
  if (length) headers.set("content-length", length);
  return headers;
}

export async function shareThumbnail(request, env, token, tier, ctx) {
  const parsed = await verifyShareToken(env, token, "th");
  if (!parsed) return json({ error: "invalid or expired thumbnail token" }, 403);
  if (!driveThumbnailSize(tier)) return json({ error: "thumbnail tier not found" }, 404);
  const { share, error } = await loadActiveShare(env, parsed.slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const meta = await driveFileMetaCached(env, parsed.fileId);
  if (!meta?.id || !meta.thumbnailLink) return json({ error: "thumbnail unavailable" }, 404);
  const revision = encodeURIComponent(meta.modifiedTime || "0");
  const cache = caches.default;
  const cacheKey = new Request(`https://media.internal.share/thumb/${parsed.fileId}/${tier}/${revision}`);
  const hit = await cache.match(cacheKey);
  if (hit?.body) {
    return new Response(hit.body, { status: 200, headers: shareThumbnailHeaders(hit.headers, tier, true) });
  }

  const asset = await driveThumbnail(env, meta, tier);
  if (!asset?.response?.body) return json({ error: "thumbnail unavailable" }, 404);
  const [clientBody, cacheBody] = asset.response.body.tee();
  const cacheWrite = cache.put(
    cacheKey,
    new Response(cacheBody, { status: 200, headers: shareThumbnailHeaders(asset.response.headers, tier, false) }),
  );
  if (ctx?.waitUntil) ctx.waitUntil(cacheWrite);
  else await cacheWrite;
  return new Response(clientBody, { status: 200, headers: shareThumbnailHeaders(asset.response.headers, tier, true) });
}

export async function shareDownload(request, env, token, ctx) {
  const parsed = await verifyShareToken(env, token, "dl");
  if (!parsed) return json({ error: "invalid or expired download token" }, 403);
  const { share, error } = await loadActiveShare(env, parsed.slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);
  // Attribution only (who downloaded what) - independent of whether this
  // share requires sign-in, so shares without requireAuth still show a
  // viewer's identity in the admin Activity feed when they happen to be
  // signed in from browsing another gated share.
  const viewer = gate.viewer || (await getViewer(request, env));

  const meta = await driveFileMetaCached(env, parsed.fileId);
  if (!meta?.id) return json({ error: "file not found" }, 404);
  // ?inline=1 serves the file for in-page viewing (lightbox images, <video>).
  const inline = new URL(request.url).searchParams.get("inline") === "1";
  const method = request.method.toUpperCase();
  const bytes = Number(meta.size) || 0;
  const safety = publicDownloadSafety(meta);
  if (!inline && safety.blocked) {
    return json({ error: safety.reason }, 451, { "x-robots-tag": "noindex, nofollow, noarchive" });
  }
  const etag = `"${(await sha256(`${meta.id}:${meta.modifiedTime || ""}:${bytes}:${meta.mimeType || ""}`)).slice(0, 32)}"`;
  const modifiedAt = Date.parse(meta.modifiedTime || "");
  const lastModified = Number.isFinite(modifiedAt) ? new Date(modifiedAt).toUTCString() : "";
  // RFC range evaluation applies to GET. HEAD reports the full representation
  // headers without opening a Drive media stream.
  const requestedRange = method === "GET" ? request.headers.get("range") || "" : "";
  const parsedRange = requestedRange ? parseMediaRange(requestedRange, bytes) : null;
  if (requestedRange && !parsedRange) return mediaRangeError(meta, inline, etag, lastModified, bytes);
  const ifRange = request.headers.get("if-range") || "";
  const range = parsedRange && (!ifRange || ifRangeMatches(ifRange, etag, modifiedAt)) ? parsedRange : null;
  const headers = shareMediaHeaders(meta, inline, etag, lastModified);

  // Preconditions are evaluated before Range, so a matching validator stays
  // a 304 even when a client also sent Range.
  if (isMediaNotModified(request, etag, modifiedAt)) {
    headers.delete("content-length");
    return new Response(null, { status: 304, headers });
  }
  if (range) {
    headers.set("content-range", `bytes ${range.start}-${range.end}/${bytes}`);
    headers.set("content-length", String(range.end - range.start + 1));
  } else if (bytes) {
    headers.set("content-length", String(bytes));
  }
  if (method === "HEAD") return new Response(null, { status: 200, headers });

  // Range requests always bypass the full-object cache and stream Drive's
  // exact 206 response immediately. Only ordinary full inline GETs may fill
  // a versioned edge entry in the background.
  const cache = inline && !range && bytes && bytes <= EDGE_CACHEABLE_BYTES ? caches.default : null;
  const revision = encodeURIComponent(meta.modifiedTime || etag);
  const cacheKey = cache ? new Request(`https://media.internal.share/f-v3/${parsed.fileId}/${revision}`) : null;
  const hit = cache ? await cache.match(cacheKey) : null;
  if (hit?.body) return new Response(hit.body, { status: 200, headers });

  const tok = await accessToken(env);
  const driveHeaders = new Headers({ authorization: `Bearer ${tok}` });
  if (range) driveHeaders.set("range", `bytes=${range.start}-${range.end}`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parsed.fileId)}?alt=media&supportsAllDrives=true`, {
    headers: driveHeaders,
    signal: request.signal,
  });
  if (r.status === 416) return mediaRangeError(meta, inline, etag, lastModified, bytes);
  if ((range && r.status !== 206) || (!range && r.status !== 200) || !r.body) return json({ error: "Drive download failed" }, 502);
  if (range && r.headers.get("content-range") !== headers.get("content-range")) {
    r.body.cancel().catch(() => {});
    return json({ error: "Drive returned an invalid media range" }, 502);
  }

  // Count the transfer once: skip stat bumps for mid-file seeks so scrubbing
  // a video does not inflate the download counters.
  const firstChunk = !range || range.start === 0;
  if (!inline && firstChunk) await bumpDownloadStats(env, share, request, meta.name, bytes, viewer);

  if (cache) {
    const [clientBody, cacheBody] = r.body.tee();
    const write = cache.put(cacheKey, new Response(cacheBody, { status: 200, headers })).catch((cause) => console.error("edge cache put failed", cause?.message || cause));
    if (ctx?.waitUntil) ctx.waitUntil(write);
    return new Response(clientBody, { status: 200, headers });
  }
  return new Response(r.body, { status: range ? 206 : 200, headers });
}

function parseMediaRange(value, total) {
  if (!total || !/^bytes=[^,]+$/.test(value)) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd) || start >= total || requestedEnd < start) return null;
  return { start, end: Math.min(requestedEnd, total - 1) };
}

function isMediaNotModified(request, etag, modifiedAt) {
  const noneMatch = request.headers.get("if-none-match");
  if (noneMatch) return noneMatch.split(",").some((value) => [etag, `W/${etag}`, "*"].includes(value.trim()));
  const since = Date.parse(request.headers.get("if-modified-since") || "");
  return Number.isFinite(since) && Number.isFinite(modifiedAt) && modifiedAt <= since;
}

function ifRangeMatches(value, etag, modifiedAt) {
  const candidate = value.trim();
  if (candidate.startsWith('"') || candidate.startsWith("W/")) return candidate === etag;
  const date = Date.parse(candidate);
  return Number.isFinite(date) && Number.isFinite(modifiedAt) && modifiedAt <= date;
}

function shareMediaHeaders(meta, inline, etag, lastModified) {
  const headers = new Headers({
    "content-type": meta.mimeType || "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name || "file")}`,
    "cache-control": inline ? "public, max-age=86400" : "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "accept-ranges": "bytes",
    "x-husky-asset-tier": inline ? "full" : "download",
    "x-husky-original-bytes": String(Math.max(0, Number(meta.size) || 0)),
  });
  if (etag) headers.set("etag", etag);
  if (lastModified) headers.set("last-modified", lastModified);
  return headers;
}

function mediaRangeError(meta, inline, etag, lastModified, bytes) {
  const headers = shareMediaHeaders(meta, inline, etag, lastModified);
  headers.set("content-range", `bytes */${bytes}`);
  headers.set("content-length", "0");
  return new Response(null, { status: 416, headers });
}

async function bumpDownloadStats(env, share, request, fileName, bytes, viewer) {
  const record = normalizeEvent({ type: "share-dl", slug: share.slug, label: share.label, file: fileName, bytes, uploader: viewer?.email || "" }, request);
  if (env.LIVE_TRACKER) {
    liveStub(env)
      .fetch("https://live.internal/share-stat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: share.slug,
          downloads: 1,
          bytes,
          viewer: viewer ? { email: viewer.email, name: viewer.name || "" } : null,
          record,
        }),
      })
      .catch(() => {});
  } else {
    await bumpShareStats(env, share.slug, {
      opens: 0,
      downloads: 1,
      bytes,
      viewers: viewer?.email ? { [viewer.email]: { n: viewer.name || "", at: Date.now() } } : {},
    });
    await mergeEventsKV(env, [record]);
  }
}
