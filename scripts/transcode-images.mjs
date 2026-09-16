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
      return { path: tiff, via: "libraw" };
    } catch {
      const jpg = `${input}.preview.jpg`;
      for (const tag of ["JpgFromRaw", "PreviewImage", "OtherImage"]) {
        try {
          const { stdout } = await run("exiftool", ["-b", `-${tag}`, input], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
          if (stdout.length > 50_000) {
            await pipeline(Readable.from(stdout), createWriteStream(jpg));
            return { path: jpg, via: "preview" };
          }
        } catch {}
      }
      // Lightroom HDR / linear float DNGs: libraw refuses and they carry no
      // preview. darktable's pipeline handles them.
      const dt = `${input}.dt.jpg`;
      try {
        await run("darktable-cli", [input, dt, "--core", "--conf", "plugins/imageio/format/jpeg/quality=95"], { timeout: 180_000 });
        return { path: dt, via: "darktable" };
      } catch {}
      throw new Error("unsupported RAW (libraw, embedded preview and darktable all failed)");
    }
  }
  if (/^hei[cf]$/.test(ext(file.name)) || /hei[cf]/.test(file.mime)) {
    const jpg = `${input}.heic.jpg`;
    await run("heif-convert", ["-q", "95", input, jpg]);
    return { path: jpg, via: "libheif" };
  }
  return { path: input, via: "direct" };
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
  const withQuality = (q) => {
    if (file.format === "jpeg") return img.clone().jpeg({ quality: q, mozjpeg: true, chromaSubsampling: q >= 90 ? "4:4:4" : "4:2:0" });
    if (file.format === "webp") return img.clone().webp({ quality: q, effort: 4 });
    if (file.format === "avif") return img.clone().avif({ quality: Math.round(q * 0.75), effort: 4 });
    return img.clone().png({ compressionLevel: 9, palette: false });
  };
  let q = options.quality;
  let info = await withQuality(q).toFile(output);
  // Size target: smooth frames compress far below the target at a given
  // quality, busy ones far above. Nudge quality a few times toward it.
  if (options.targetBytes && file.format !== "png") {
    for (let i = 0; i < 4; i++) {
      const ratio = info.size / options.targetBytes;
      if (ratio > 0.7 && ratio < 1.3) break;
      const next = Math.max(50, Math.min(95, ratio < 0.7 ? q + (ratio < 0.35 ? 8 : 4) : q - (ratio > 2 ? 10 : 5)));
      if (next === q) break;
      q = next;
      info = await withQuality(q).toFile(output);
    }
  }
  // RAW went through an intermediate (developed TIFF or embedded preview),
  // so copy the tags from the real original; pixels are already upright.
  if (options.metadata !== "strip" && source !== original) await run("exiftool", ["-overwrite_original", "-q", "-tagsfromfile", original, "-all:all", "-orientation=", output]).catch(() => {});
  if (options.metadata === "strip-gps") await run("exiftool", ["-overwrite_original", "-q", "-gps:all=", output]).catch(() => {});
  return { ...info, q };
}

async function processOne(file, options, dir) {
  const input = join(dir, `${file.id}.${ext(file.name) || "bin"}`);
  const output = join(dir, `${file.id}.out.${file.format === "jpeg" ? "jpg" : file.format}`);
  const src = await api(`/api/admin/images/source/${file.id}`);
  if (!src.ok || !src.body) throw new Error(`source ${src.status}`);
  await pipeline(Readable.fromWeb(src.body), createWriteStream(input));
  const { path: source, via } = await decodable(input, file);
  const info = await encode(source, output, file, options, input);
  const { size } = await stat(output);
  if (!size || !info.width) throw new Error("encoder produced nothing");
  const bytes = await readFile(output);
  let put;
  let result;
  // The worker-to-Drive hop occasionally 502s; one retry, flagged so the
  // worker removes any copy the first attempt may have stored.
  for (let attempt = 0; attempt < 2; attempt++) {
    put = await api(`/api/admin/images/jobs/${jobId}/file/${file.id}`, {
      method: "PUT",
      headers: { "content-type": "application/octet-stream", "x-format": file.format, "content-length": String(size), ...(attempt ? { "x-retry": "1" } : {}) },
      body: bytes,
    });
    result = await put.json().catch(() => ({}));
    if (put.ok || put.status < 500) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (!put.ok) throw new Error(result.error || `put ${put.status}`);
  if (result.skipped) throw new Error(result.skipped);
  if (result.w && (Math.abs(result.w - info.width) > 1 || Math.abs(result.h - info.height) > 1)) throw new Error(`Drive reports ${result.w}x${result.h}, encoded ${info.width}x${info.height}`);
  return { newId: result.id, size, via, q: info.q, parent: result.parent };
}

let batch = { done: [], skipped: [] };
// A failed report keeps its batch for the next attempt; nothing is dropped.
async function report(extra = {}) {
  if (!batch.done.length && !batch.skipped.length && !Object.keys(extra).length) return null;
  const body = JSON.stringify({ ...batch, ...extra, runId: process.env.GITHUB_RUN_ID || "" });
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await api(`/api/admin/images/jobs/${jobId}/report`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => null);
    if (r?.ok) {
      batch = { done: [], skipped: [] };
      return r.json();
    }
    console.log(`report failed (${r?.status || "network"}), retrying`);
    await new Promise((res) => setTimeout(res, 4000 * (attempt + 1)));
  }
  return null;
}

const started = Date.now();
const dir = await mkdtemp(join(tmpdir(), "hd-images-"));
let processed = 0;
try {
  for (;;) {
    const first = await api(`/api/admin/images/jobs/${jobId}/next?n=1`);
    if (!first.ok) throw new Error(`next ${first.status}: ${(await first.text()).slice(0, 200)}`);
    const { status, options } = await first.json();
    if (status !== "running") {
      console.log(`job is ${status}; stopping`);
      await report({ stopped: true });
      break;
    }
    const parallel = Math.max(1, Math.min(8, Number(options.parallel) || 4));
    const res = await api(`/api/admin/images/jobs/${jobId}/next?n=${parallel * 3}`);
    const { files, remaining } = await res.json();
    if (!files.length) {
      await report({ finished: true });
      console.log(`finished: ${processed} files`);
      break;
    }
    console.log(`${remaining} remaining · ${parallel} in parallel`);
    // Pool: `parallel` workers pull from this batch; pause / cancel / the
    // time budget are checked between batches (≤ 3 files per worker each).
    let stop = "";
    const queue = [...files];
    const worker = async (slot) => {
      const mine = join(dir, `w${slot}`);
      await mkdir(mine, { recursive: true });
      for (let file = queue.shift(); file; file = queue.shift()) {
        if (Date.now() - started > budgetMs) {
          stop = "time budget reached - resume from the admin to continue";
          return;
        }
        const t0 = Date.now();
        try {
          const { newId, size, via, q, parent } = await processOne(file, options, mine);
          batch.done.push({ id: file.id, newId, size, ms: Date.now() - t0, via, q, parent });
          console.log(`ok   ${file.path}/${file.name} ${(file.size / 1e6).toFixed(1)} MB -> ${(size / 1e6).toFixed(2)} MB (${via}, q${q})`);
        } catch (error) {
          batch.skipped.push({ id: file.id, error: error.message });
          console.log(`skip ${file.name}: ${error.message}`);
        }
        processed += 1;
        await rm(mine, { recursive: true, force: true });
        await mkdir(mine, { recursive: true });
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, files.length) }, (_, i) => worker(i)));
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
