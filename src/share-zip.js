// Share links: "download all" as a streamed STORE-mode ZIP (zip64) built from
// Drive media streams, gated by a short-lived ticket.

import {
  SHARE_ZIP_TICKET_TTL,
  b64url,
  cleanText,
  json,
  sanitizeFilename,
} from "./util.js";
import { driveFileMeta, accessToken } from "./drive.js";
import { mediaRev } from "./media-cache.js";
import { sharePreviewIndex } from "./share-previews.js";
import { gatePin } from "./store.js";
import { loadActiveShare, requireViewer } from "./share.js";
import { verifyShareToken, downloadTokenFrom, publicDownloadSafety } from "./share-token.js";

export async function createShareZipTicket(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  if (share.allowZip === false) return json({ error: "zip downloads are disabled for this share" }, 403);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const requested = Array.isArray(b.files) ? b.files.slice(0, 1000) : [];
  if (!requested.length) return json({ error: "choose at least one file" }, 400);
  // format "webp" (spec §6): files with a preview-equivalent in R2 come out
  // as WebP; anything not processed yet is the original.
  const smaller = b.format === "webp";
  const previews = smaller ? await sharePreviewIndex(env) : { files: {} };
  const files = [];
  const blocked = [];
  for (const item of requested) {
    const token = downloadTokenFrom(item?.dl || item?.token);
    const parsed = await verifyShareToken(env, token, "dl", { allowExpired: true });
    if (!parsed || parsed.slug !== share.slug) return json({ error: "invalid file selection" }, 403);
    const meta = await driveFileMeta(env, parsed.fileId);
    if (!meta?.id) return json({ error: "selected file was not found" }, 404);
    const safety = publicDownloadSafety(meta);
    if (safety.blocked) {
      blocked.push(cleanText(meta.name || item?.name || parsed.fileId, 120));
      continue;
    }
    const preview = previews.files[parsed.fileId];
    const usePreview = smaller && preview && !preview.skip && preview.r === mediaRev(meta) && env.MEDIA_BUCKET;
    files.push({
      fileId: parsed.fileId,
      name: sanitizeFilename(usePreview ? (meta.name || `${parsed.fileId}`).replace(/\.[^.]+$/, "") + ".webp" : meta.name || item?.name || `${parsed.fileId}.bin`),
      size: Math.max(0, Number(usePreview ? preview.s : meta.size || item?.size) || 0),
      mime: usePreview ? "image/webp" : cleanText(meta.mimeType || item?.mime || "application/octet-stream", 100),
      ...(usePreview ? { r2Key: `media/${parsed.fileId}/preview-webp-${preview.r}` } : {}),
    });
  }
  if (!files.length && blocked.length) {
    return json({ error: "All selected files are blocked by the public-download safety policy.", blocked }, 451, { "x-robots-tag": "noindex, nofollow, noarchive" });
  }

  const ticket = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const expiresAt = Date.now() + SHARE_ZIP_TICKET_TTL * 1000;
  const zipName = sanitizeFilename(`${share.label.replace(/[^\w-]+/g, "_") || "share"}.zip`);
  await env.KV.put(`sharezip:${ticket}`, JSON.stringify({ slug: share.slug, label: share.label, zipName, files, expiresAt }), { expirationTtl: SHARE_ZIP_TICKET_TTL });
  return json({ ticket, url: `/api/share/zip/${ticket}`, expiresAt, count: files.length, blocked });
}

export async function shareZipDownload(request, env, ticket) {
  const safeTicket = cleanText(ticket || "", 200).replace(/[^A-Za-z0-9_-]/g, "");
  const payload = safeTicket ? await env.KV.get(`sharezip:${safeTicket}`, "json") : null;
  if (!payload) return json({ error: "zip ticket not found or expired" }, 404);
  if (payload.expiresAt && payload.expiresAt < Date.now()) {
    await env.KV.delete(`sharezip:${safeTicket}`);
    return json({ error: "zip ticket expired" }, 410);
  }
  const { share, error } = await loadActiveShare(env, payload.slug);
  if (error) return error;
  if (share.allowZip === false) return json({ error: "zip downloads are disabled for this share" }, 403);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const files = (payload.files || [])
    .filter((file) => !publicDownloadSafety(file).blocked)
    .map((file) => ({
      ...file,
      name: sanitizeFilename(file.name || `${file.fileId}.bin`),
      size: Math.max(0, Number(file.size) || 0),
      stream: async () => (file.r2Key ? r2MediaStream(env, file.r2Key, file.fileId) : driveMediaStream(env, file.fileId)),
    }));
  if (!files.length) {
    return json({ error: "This ZIP contains no files allowed by the public-download safety policy." }, 451, { "x-robots-tag": "noindex, nofollow, noarchive" });
  }
  const headers = new Headers({
    "content-type": "application/zip",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(payload.zipName || "share.zip")}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
  });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  zipStoreStream(files, async (chunk) => writer.write(chunk))
    .then(() => writer.close())
    .catch((err) => writer.abort(err));
  return new Response(readable, { headers });
}

// Preview-equivalent from R2; the original if the object is gone.
async function r2MediaStream(env, key, fileId) {
  const obj = await env.MEDIA_BUCKET?.get(key).catch(() => null);
  return obj?.body || driveMediaStream(env, fileId);
}

async function driveMediaStream(env, fileId) {
  const tok = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok || !r.body) throw new Error("Drive download failed");
  return r.body;
}

const ZIP32_MAX = 0xffffffffn;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc, buf) {
  crc = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(v) {
  return new Uint8Array([v & 255, (v >>> 8) & 255]);
}

function u32(v) {
  return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
}

function u64(v) {
  const out = new Uint8Array(8);
  let n = BigInt(v);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function zip64Extra(values) {
  const body = concatBytes(values.map((v) => u64(v)));
  return concatBytes([u16(0x0001), u16(body.length), body]);
}

async function zipStoreStream(files, write) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const central = [];
  let offset = 0n;

  for (const file of files) {
    const nameBytes = enc.encode(dedupeZipName(file.name, central));
    const lfhOffset = offset;
    const declaredSize = BigInt(Math.max(0, Number(file.size) || 0));
    const localZip64 = declaredSize > ZIP32_MAX;
    const localExtra = localZip64 ? zip64Extra([0n, 0n]) : new Uint8Array();
    const lfh = concatBytes([
      u32(0x04034b50),
      u16(localZip64 ? 45 : 20),
      u16(0x0808),
      u16(0),
      u16(time),
      u16(date),
      u32(0),
      u32(localZip64 ? 0xffffffff : 0),
      u32(localZip64 ? 0xffffffff : 0),
      u16(nameBytes.length),
      u16(localExtra.length),
      nameBytes,
      localExtra,
    ]);
    await write(lfh);
    offset += BigInt(lfh.length);

    let crc = 0;
    let size = 0n;
    const stream = await file.stream();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      crc = crc32(crc, chunk);
      size += BigInt(chunk.length);
      await write(chunk);
    }
    offset += size;

    const zip64 = localZip64 || size > ZIP32_MAX || lfhOffset > ZIP32_MAX;
    const descriptor = zip64 ? concatBytes([u32(0x08074b50), u32(crc), u64(size), u64(size)]) : concatBytes([u32(0x08074b50), u32(crc), u32(Number(size)), u32(Number(size))]);
    await write(descriptor);
    offset += BigInt(descriptor.length);

    const centralExtraValues = [];
    if (size > ZIP32_MAX || localZip64) centralExtraValues.push(size, size);
    if (lfhOffset > ZIP32_MAX) centralExtraValues.push(lfhOffset);
    const centralExtra = centralExtraValues.length ? zip64Extra(centralExtraValues) : new Uint8Array();
    central.push({
      name: new TextDecoder().decode(nameBytes),
      bytes: concatBytes([
        u32(0x02014b50),
        u16(zip64 ? 45 : 20),
        u16(zip64 ? 45 : 20),
        u16(0x0808),
        u16(0),
        u16(time),
        u16(date),
        u32(crc),
        u32(size > ZIP32_MAX || localZip64 ? 0xffffffff : Number(size)),
        u32(size > ZIP32_MAX || localZip64 ? 0xffffffff : Number(size)),
        u16(nameBytes.length),
        u16(centralExtra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(lfhOffset > ZIP32_MAX ? 0xffffffff : Number(lfhOffset)),
        nameBytes,
        centralExtra,
      ]),
    });
  }

  const cdStart = offset;
  for (const entry of central) {
    await write(entry.bytes);
    offset += BigInt(entry.bytes.length);
  }
  const cdSize = offset - cdStart;
  const needsZip64 = central.length >= 0xffff || cdSize > ZIP32_MAX || cdStart > ZIP32_MAX;
  if (needsZip64) {
    const zip64EocdStart = offset;
    const zip64Eocd = concatBytes([u32(0x06064b50), u64(44n), u16(45), u16(45), u32(0), u32(0), u64(BigInt(central.length)), u64(BigInt(central.length)), u64(cdSize), u64(cdStart)]);
    await write(zip64Eocd);
    offset += BigInt(zip64Eocd.length);
    const locator = concatBytes([u32(0x07064b50), u32(0), u64(zip64EocdStart), u32(1)]);
    await write(locator);
    offset += BigInt(locator.length);
  }
  const eocd = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(needsZip64 ? 0xffff : central.length),
    u16(needsZip64 ? 0xffff : central.length),
    u32(needsZip64 ? 0xffffffff : Number(cdSize)),
    u32(needsZip64 ? 0xffffffff : Number(cdStart)),
    u16(0),
  ]);
  await write(eocd);
}

function dedupeZipName(name, central) {
  const used = new Set(central.map((entry) => entry.name));
  const base = sanitizeFilename(name);
  let out = base;
  let i = 1;
  while (used.has(out)) {
    const dot = base.lastIndexOf(".");
    out = dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`;
    i++;
  }
  return out;
}
