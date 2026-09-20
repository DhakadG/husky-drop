#!/usr/bin/env node
// Runner for share "preview-equivalents" (media-cache spec §5): RAW / HEIC /
// TIFF and oversized originals in indexed shares get a WebP that the gallery
// shows in place of the original. Output goes to R2 only; originals are
// never touched.
//   GET  /api/admin/share-index/previews/pending?limit=&shards=&shard=
//   GET  /api/admin/images/source/:fileId                 -> original bytes
//   PUT  /api/admin/share-index/preview/:fileId?rev=      -> WebP bytes to R2
//   POST /api/admin/share-index/preview-report            -> batch (one KV write)
// Needs: node 22+, sharp, and on PATH dcraw_emu, heif-convert, exiftool,
// darktable-cli (see lib/image-decode.mjs).

import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { decodable, ext, hasGainMap } from "./lib/image-decode.mjs";

const origin = (process.env.HUSKY_ORIGIN || "").replace(/\/$/, "");
const token = process.env.HUSKY_ADMIN_TOKEN || "";
const limit = Math.max(1, Number(process.env.LIMIT) || 300);
const shards = Math.max(1, Number(process.env.SHARDS) || 1);
const shard = Math.max(0, Number(process.env.SHARD) || 0);
const parallel = Math.max(1, Math.min(8, Number(process.env.PARALLEL) || 4));
const budgetMs = (Number(process.env.TIME_BUDGET_MIN) || 270) * 60_000;
if (!origin || !token) {
  console.error("HUSKY_ORIGIN and HUSKY_ADMIN_TOKEN are required");
  process.exit(2);
}
const sharp = (await import("sharp")).default;
const api = (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });

// Preview-equivalent: long edge capped so a 60 MP RAW becomes a few MB, ICC
// kept so wide-gamut sources still look right, upright pixels, no EXIF.
const MAX_EDGE = Number(process.env.MAX_EDGE) || 4096;
const QUALITY = Number(process.env.QUALITY) || 84;

async function processOne(file, dir) {
  const input = join(dir, `${file.id}.${ext(file.name) || "bin"}`);
  const output = join(dir, `${file.id}.webp`);
  const src = await api(`/api/admin/images/source/${file.id}`);
  if (!src.ok || !src.body) throw new Error(`source ${src.status}`);
  await pipeline(Readable.fromWeb(src.body), createWriteStream(input));
  if (await hasGainMap(input, file)) return { gainmap: true };
  const { path: source, via } = await decodable(input, file);
  const info = await sharp(source, { failOn: "none", limitInputPixels: false })
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
    .keepIccProfile()
    .webp({ quality: QUALITY, effort: 4 })
    .toFile(output);
  const { size } = await stat(output);
  if (!size || !info.width) throw new Error("encoder produced nothing");
  // R2 occasionally answers 500 (10001, "internal error, try again"); the
  // bytes are already made, so retry the PUT alone.
  const bytes = await readFile(output);
  let put;
  for (let attempt = 0; attempt < 3; attempt++) {
    put = await api(`/api/admin/share-index/preview/${file.id}?rev=${encodeURIComponent(file.rev)}`, { method: "PUT", headers: { "content-type": "image/webp", "content-length": String(size) }, body: bytes }).catch(() => null);
    if (put?.ok || (put && put.status < 500)) break;
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (!put?.ok) throw new Error(`put ${put?.status || "network"}: ${put ? (await put.text()).slice(0, 120) : ""}`);
  return { size, via, w: info.width, h: info.height };
}

let batch = { done: [], skipped: [] };
async function report(extra = {}) {
  if (!batch.done.length && !batch.skipped.length && !Object.keys(extra).length) return;
  const body = JSON.stringify({ ...batch, ...extra, runId: process.env.GITHUB_RUN_ID || `local-${Date.now()}` });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await api("/api/admin/share-index/preview-report", { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => null);
    if (r?.ok) {
      batch = { done: [], skipped: [] };
      return;
    }
    await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
  }
}

const started = Date.now();
const dir = await mkdtemp(join(tmpdir(), "hd-share-previews-"));
let processed = 0;
try {
  const res = await api(`/api/admin/share-index/previews/pending?limit=${limit}&shards=${shards}&shard=${shard}`);
  if (!res.ok) throw new Error(`pending ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { pending, total } = await res.json();
  console.log(`${pending.length} of ${total} pending previews for shard ${shard}/${shards} · ${parallel} in parallel`);
  const queue = [...pending];
  const worker = async (slot) => {
    const mine = join(dir, `w${slot}`);
    await mkdir(mine, { recursive: true });
    for (let file = queue.shift(); file; file = queue.shift()) {
      if (Date.now() - started > budgetMs) return;
      const t0 = Date.now();
      try {
        const out = await processOne(file, mine);
        if (out.gainmap) {
          batch.skipped.push({ id: file.id, rev: file.rev, name: file.name, error: "gain-map HDR: original served as-is", gainmap: true });
          console.log(`keep ${file.name}: gain-map HDR, original wins`);
        } else {
          batch.done.push({ id: file.id, rev: file.rev, name: file.name, size: out.size, ms: Date.now() - t0, via: out.via, w: out.w, h: out.h });
          console.log(`ok   ${file.name} ${(file.size / 1e6).toFixed(1)} MB -> ${(out.size / 1e6).toFixed(2)} MB (${out.via})`);
        }
      } catch (error) {
        // unsupported = every decoder refused; the worker records it so the
        // file is not retried night after night. Anything else is transient.
        batch.skipped.push({ id: file.id, rev: file.rev, name: file.name, error: error.message, unsupported: !!error.unsupported });
        console.log(`skip ${file.name}: ${error.message}`);
      }
      processed += 1;
      await rm(mine, { recursive: true, force: true });
      await mkdir(mine, { recursive: true });
      if (batch.done.length + batch.skipped.length >= 10) await report();
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, (_, i) => worker(i)));
  await report({ finished: true, pendingLeft: Math.max(0, total - processed) });
  console.log(`finished: ${processed} files`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
