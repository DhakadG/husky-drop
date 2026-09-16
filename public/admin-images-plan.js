// Image archive: client-side estimator over scan rows (mirrors
// src/images.js estimate/skipReason) and the in-browser "try it on one
// photo" comparison.

const BPP = { jpeg: 0.12, webp: 0.09, avif: 0.06, png: 1.2 };
const SECS = { jpeg: 4, png: 5, heic: 6, tiff: 5, webp: 4, raw: 7 };
export const TYPE_LABELS = { jpeg: "JPEG", png: "PNG", heic: "HEIC", tiff: "TIFF", webp: "WebP", raw: "RAW" };

export function outputFormat(type, cfg) {
  if (cfg.format !== "same") return cfg.format;
  return type === "png" || type === "webp" ? type : "jpeg";
}
export function estimateRow(r, cfg) {
  const px = (r.w || 0) * (r.h || 0);
  const cap = cfg.maxMp ? cfg.maxMp * 1e6 : Infinity;
  const outPx = px ? Math.min(px, cap) : cap === Infinity ? 12e6 : cap;
  const format = outputFormat(r.t, cfg);
  const bpp = format === "png" ? BPP.png : (BPP[format] || 0.12) * (cfg.quality / 82);
  const target = cfg.targetMb * 1024 * 1024;
  return target && format !== "png" ? Math.min(Math.round(r.s * 0.9), target) : Math.round(outPx * bpp);
}
export function skipReasonRow(r, cfg, scan, excluded) {
  if (!cfg.types.has(r.t)) return "type excluded";
  if (excluded.has(scan.folders[r.f].id)) return "folder excluded";
  if (r.s < cfg.minMb * 1024 * 1024) return "already small";
  if (cfg.excludeRe && safeTest(cfg.excludeRe, r.n)) return "name excluded";
  if (r.s > 270 * 1024 * 1024) return "over 270 MB";
  if (cfg.skipRecentDays && r.m > scan.now - cfg.skipRecentDays * 86400e3) return `modified in the last ${cfg.skipRecentDays} days`;
  if (cfg.skipSidecar && r.t === "raw" && r.x) return "RAW has an .xmp sidecar (edited)";
  if (scan.doneSet.has(r.id)) return "done in an earlier job";
  if (cfg.mode === "copy" && r.c) return "copy already exists";
  if (cfg.mode === "archive" && r.a) return "already archived";
  if (cfg.onlyIfSmaller && estimateRow(r, cfg) >= r.s * 0.9) return "no worthwhile saving";
  return "";
}
function safeTest(source, value) {
  try {
    return new RegExp(source, "i").test(value);
  } catch {
    return false;
  }
}

// Totals for the impact card and per-folder counts for the tree table.
export function summarize(scan, cfg, excluded) {
  const out = { files: 0, bytes: 0, est: 0, eta: 0, scanned: scan.rows.length, scannedBytes: 0, skipped: {}, byType: {}, perFolder: scan.folders.map(() => ({ images: 0, bytes: 0, picked: 0, pickedBytes: 0, est: 0, types: {}, done: 0 })), largest: [] };
  for (const r of scan.rows) {
    const pf = out.perFolder[r.f];
    pf.images += 1;
    pf.bytes += r.s;
    pf.types[r.t] = (pf.types[r.t] || 0) + 1;
    if (scan.doneSet.has(r.id) || r.c || r.a) pf.done += 1;
    out.scannedBytes += r.s;
    const bt = (out.byType[r.t] ||= { count: 0, picked: 0, bytes: 0, est: 0 });
    bt.count += 1;
    const why = skipReasonRow(r, cfg, scan, excluded);
    if (why) {
      out.skipped[why] = (out.skipped[why] || 0) + 1;
      continue;
    }
    const est = estimateRow(r, cfg);
    out.files += 1;
    out.bytes += r.s;
    out.est += est;
    out.eta += (SECS[r.t] || 4) + r.s / 6e6 + (cfg.targetMb ? 3 : 0);
    bt.picked += 1;
    bt.bytes += r.s;
    bt.est += est;
    pf.picked += 1;
    pf.pickedBytes += r.s;
    pf.est += est;
    out.largest.push(r);
  }
  out.largest.sort((a, b) => b.s - a.s).splice(8);
  // Roll sub-folder picks up into their parents for the tree table.
  for (let i = scan.folders.length - 1; i >= 0; i--) {
    const parent = scan.folders[i].parent;
    if (parent < 0) continue;
    const a = out.perFolder[i];
    const b = out.perFolder[parent];
    b.images += a.images;
    b.bytes += a.bytes;
    b.picked += a.picked;
    b.pickedBytes += a.pickedBytes;
    b.est += a.est;
    b.done += a.done;
    for (const [t, n] of Object.entries(a.types)) b.types[t] = (b.types[t] || 0) + n;
  }
  return out;
}

// ---- try it on one photo (browser encoder, indicative) ----
// RAW/HEIC/TIFF cannot be decoded by the browser; the runner uses libraw,
// libheif and mozjpeg, which lands ~15% smaller than the canvas encoder.
// Any decodable row qualifies (a folder that is fully "done" can still be
// previewed); rows the recipe would process come first.
export function trialCandidates(scan, cfg, excluded) {
  const rank = (r) => (skipReasonRow(r, cfg, scan, excluded) ? 1 : 0);
  return scan.rows.filter((r) => ["jpeg", "png", "webp"].includes(r.t)).sort((a, b) => rank(a) - rank(b) || b.s - a.s);
}
export async function trialEncode(row, cfg, onStage) {
  onStage?.("downloading");
  const res = await fetch(`/api/admin/images/source/${row.id}`);
  if (!res.ok) throw new Error(`download ${res.status}`);
  const blob = await res.blob();
  onStage?.("decoding");
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  const px = bitmap.width * bitmap.height;
  const cap = cfg.maxMp ? cfg.maxMp * 1e6 : Infinity;
  const scale = px > cap ? Math.sqrt(cap / px) : 1;
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, w, h);
  onStage?.("encoding");
  const format = outputFormat(row.t, cfg);
  const mime = format === "png" ? "image/png" : format === "webp" ? "image/webp" : "image/jpeg"; // avif: not encodable in browsers - shown as JPEG
  const out = await new Promise((resolve) => canvas.toBlob(resolve, mime, cfg.quality / 100));
  const before = { blob, w: bitmap.width, h: bitmap.height };
  bitmap.close?.();
  return { before, after: { blob: out, w, h, mime }, note: format === "avif" ? "AVIF cannot be encoded in the browser - JPEG shown; the runner's AVIF will be ~40% smaller." : "Browser encoder; the runner's mozjpeg lands ~15% smaller at the same quality." };
}
