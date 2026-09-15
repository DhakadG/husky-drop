#!/usr/bin/env node
// Runner for image archive jobs planned in the admin (src/images.js).
//   GET  /api/admin/images/jobs/:id/next?n=8      -> files + options + status
//   GET  /api/admin/images/source/:fileId          -> original bytes
//   PUT  /api/admin/images/jobs/:id/file/:fileId   -> encoded bytes; worker writes Drive
//   POST /api/admin/images/jobs/:id/report         -> batch results (one KV write)
// Needs: node 22+, sharp (npm), and on PATH: dcraw_emu (libraw-bin) for RAW,
// heif-convert (libheif-examples) for HEIC, exiftool for metadata.
//   HUSKY_ORIGIN=... HUSKY_ADMIN_TOKEN=... JOB_ID=img-xxx node scripts/transcode-images.mjs

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const origin = (process.env.HUSKY_ORIGIN || "").replace(/\/$/, "");
const token = process.env.HUSKY_ADMIN_TOKEN || "";
const jobId = process.env.JOB_ID || "";
const budgetMs = (Number(process.env.TIME_BUDGET_MIN) || 270) * 60_000;
if (!origin || !token || !jobId) {
  console.error("HUSKY_ORIGIN, HUSKY_ADMIN_TOKEN and JOB_ID are required");
  process.exit(2);
}
const sharp = (await import("sharp")).default;
const api = (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });
const RAW_EXT = /\.(arw|srf|sr2|cr2|cr3|nef|nrw|dng|raf|orf|rw2|pef|3fr|iiq)$/i;
const ext = (name) => (name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();

// Get something sharp can read. RAW: libraw develop -> TIFF, falling back to
// the camera's embedded JPEG (Sony ARW carries a full-size one) when libraw
// does not know the body yet. HEIC: libheif -> JPEG.
async function decodable(input, file) {
  if (RAW_EXT.test(file.name)) {
    const tiff = `${input}.tiff`;
    try {
      await run("dcraw_emu", ["-w", "-q", "3", "-T", "-Z", tiff, input]);
      return tiff;
    } catch {
      const jpg = `${input}.preview.jpg`;
      for (const tag of ["JpgFromRaw", "PreviewImage", "OtherImage"]) {
        try {
          const { stdout } = await run("exiftool", ["-b", `-${tag}`, input], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
          if (stdout.length > 50_000) {
            await pipeline(Readable.from(stdout), createWriteStream(jpg));
            return jpg;
          }
        } catch {}
      }
      throw new Error("unsupported RAW (libraw and embedded preview both failed)");
    }
  }
  if (/^hei[cf]$/.test(ext(file.name)) || /hei[cf]/.test(file.mime)) {
    const jpg = `${input}.heic.jpg`;
    await run("heif-convert", ["-q", "95", input, jpg]);
    return jpg;
  }
  return input;
}

async function encode(source, output, file, options, original) {
  const meta = await sharp(source, { failOn: "none", limitInputPixels: false }).metadata();
  const w = meta.width || 0;
  const h = meta.height || 0;
  const cap = options.maxMp ? options.maxMp * 1e6 : Infinity;
  const scale = w * h > cap ? Math.sqrt(cap / (w * h)) : 1;
  let img = sharp(source, { failOn: "none", limitInputPixels: false }).rotate();
  if (scale < 1) img = img.resize({ width: Math.round(w * scale), height: Math.round(h * scale), fit: "inside", withoutEnlargement: true });
  // "strip" keeps only the colour profile; sharp's default output drops
  // EXIF/XMP/IPTC. Both keep modes carry everything and strip-gps removes
  // GPS afterwards with exiftool.
  img = options.metadata === "strip" ? img.keepIccProfile() : img.keepMetadata();
  const q = options.quality;
  if (file.format === "jpeg") img = img.jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q >= 90 ? "4:4:4" : "4:2:0" });
  else if (file.format === "webp") img = img.webp({ quality: q, effort: 4 });
  else if (file.format === "avif") img = img.avif({ quality: Math.round(q * 0.75), effort: 4 });
  else img = img.png({ compressionLevel: 9, palette: false });
  const info = await img.toFile(output);
  // RAW went through an intermediate (developed TIFF or embedded preview),
  // so copy the tags from the real original; pixels are already upright.
  if (options.metadata !== "strip" && source !== original) await run("exiftool", ["-overwrite_original", "-q", "-tagsfromfile", original, "-all:all", "-orientation=", output]).catch(() => {});
  if (options.metadata === "strip-gps") await run("exiftool", ["-overwrite_original", "-q", "-gps:all=", output]).catch(() => {});
  return info;
}

async function processOne(file, options, dir) {
  const input = join(dir, `${file.id}.${ext(file.name) || "bin"}`);
  const output = join(dir, `${file.id}.out.${file.format === "jpeg" ? "jpg" : file.format}`);
  const src = await api(`/api/admin/images/source/${file.id}`);
  if (!src.ok || !src.body) throw new Error(`source ${src.status}`);
  await pipeline(Readable.fromWeb(src.body), createWriteStream(input));
  const source = await decodable(input, file);
  const info = await encode(source, output, file, options, input);
  const { size } = await stat(output);
  if (!size || !info.width) throw new Error("encoder produced nothing");
  const put = await api(`/api/admin/images/jobs/${jobId}/file/${file.id}`, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream", "x-format": file.format, "content-length": String(size) },
    body: await readFile(output),
  });
  const result = await put.json().catch(() => ({}));
  if (!put.ok) throw new Error(result.error || `put ${put.status}`);
  if (result.skipped) throw new Error(result.skipped);
  if (result.w && (Math.abs(result.w - info.width) > 1 || Math.abs(result.h - info.height) > 1)) throw new Error(`Drive reports ${result.w}x${result.h}, encoded ${info.width}x${info.height}`);
  return { newId: result.id, size };
}

let batch = { done: [], skipped: [] };
async function report(extra = {}) {
  if (!batch.done.length && !batch.skipped.length && !Object.keys(extra).length) return null;
  const body = JSON.stringify({ ...batch, ...extra });
  batch = { done: [], skipped: [] };
  const r = await api(`/api/admin/images/jobs/${jobId}/report`, { method: "POST", headers: { "content-type": "application/json" }, body });
  return r.ok ? r.json() : null;
}

const started = Date.now();
const dir = await mkdtemp(join(tmpdir(), "hd-images-"));
let processed = 0;
try {
  for (;;) {
    const res = await api(`/api/admin/images/jobs/${jobId}/next?n=8`);
    if (!res.ok) throw new Error(`next ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { status, options, files, remaining } = await res.json();
    if (status !== "running") {
      console.log(`job is ${status}; stopping`);
      await report({ stopped: true });
      break;
    }
    if (!files.length) {
      await report({ finished: true });
      console.log(`finished: ${processed} files`);
      break;
    }
    console.log(`${remaining} remaining`);
    let stop = "";
    for (const file of files) {
      // Pause and the time budget are honoured per file, not per batch.
      if (Date.now() - started > budgetMs) {
        stop = "time budget reached - resume from the admin to continue";
        break;
      }
      if (file !== files[0]) {
        const peek = await api(`/api/admin/images/jobs/${jobId}/next?n=1`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
        if (peek && peek.status !== "running") {
          stop = `job is ${peek.status}; stopping`;
          break;
        }
      }
      const t0 = Date.now();
      try {
        const { newId, size } = await processOne(file, options, dir);
        batch.done.push({ id: file.id, newId, size, ms: Date.now() - t0 });
        console.log(`ok   ${file.path}/${file.name} ${(file.size / 1e6).toFixed(1)} MB -> ${(size / 1e6).toFixed(2)} MB`);
      } catch (error) {
        batch.skipped.push({ id: file.id, error: error.message });
        console.log(`skip ${file.name}: ${error.message}`);
      }
      processed += 1;
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
    }
    const state = await report();
    if (stop || (state && state.status !== "running")) {
      console.log(stop || `job is ${state.status}; stopping`);
      await report({ stopped: true });
      break;
    }
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
