#!/usr/bin/env node
// Transcode share videos to 720p previews through the worker's admin API.
//   GET  /api/admin/previews/pending?limit=N   -> videos without a preview
//   GET  /api/admin/previews/source/:id        -> original bytes
//   PUT  /api/admin/previews/:id               -> store the preview
// Runs in GitHub Actions (see .github/workflows/transcode-previews.yml) or
// anywhere with ffmpeg: HUSKY_ORIGIN=... HUSKY_ADMIN_TOKEN=... node scripts/transcode-previews.mjs

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const origin = (process.env.HUSKY_ORIGIN || "").replace(/\/$/, "");
const token = process.env.HUSKY_ADMIN_TOKEN || "";
const limit = Math.max(1, Number(process.env.LIMIT) || 40);
const budgetMs = (Number(process.env.TIME_BUDGET_MIN) || 270) * 60_000;
const MAX_PREVIEW_BYTES = 90 * 1024 * 1024;
if (!origin || !token) {
  console.error("HUSKY_ORIGIN and HUSKY_ADMIN_TOKEN are required");
  process.exit(2);
}
const headers = { authorization: `Bearer ${token}` };
const api = (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { ...headers, ...(init.headers || {}) } });

function ffmpeg(input, output) {
  // 720p H.264, capped bitrate so long clips stay under the upload ceiling;
  // +faststart moves the index to the front so playback starts on the first range.
  const args = [
    "-y", "-hide_banner", "-loglevel", "error", "-i", input,
    "-vf", "scale='min(1280,iw)':-2", "-c:v", "libx264", "-preset", "veryfast", "-crf", "27",
    "-maxrate", "2500k", "-bufsize", "5000k", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "96k", "-ac", "2", "-movflags", "+faststart", "-map_metadata", "-1", output,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}

async function transcodeOne(file, dir) {
  const input = join(dir, `${file.id}.src`);
  const output = join(dir, `${file.id}.mp4`);
  const src = await api(`/api/admin/previews/source/${file.id}`);
  if (!src.ok || !src.body) throw new Error(`source ${src.status}`);
  await pipeline(Readable.fromWeb(src.body), createWriteStream(input));
  await ffmpeg(input, output);
  const { size } = await stat(output);
  if (size > MAX_PREVIEW_BYTES) throw new Error(`preview ${Math.round(size / 1e6)} MB exceeds ceiling`);
  const put = await api(`/api/admin/previews/${file.id}`, {
    method: "PUT",
    headers: { "content-type": "video/mp4", "content-length": String(size) },
    body: await readFile(output),
  });
  if (!put.ok) throw new Error(`put ${put.status}: ${(await put.text()).slice(0, 200)}`);
  return size;
}

const started = Date.now();
const dir = await mkdtemp(join(tmpdir(), "hd-previews-"));
try {
  const res = await api(`/api/admin/previews/pending?limit=${limit}`);
  if (!res.ok) throw new Error(`pending ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const { pending, indexed } = await res.json();
  console.log(`${indexed} previews indexed, ${pending.length} pending`);
  let done = 0;
  for (const file of pending) {
    if (Date.now() - started > budgetMs) {
      console.log("time budget reached");
      break;
    }
    const t0 = Date.now();
    try {
      const size = await transcodeOne(file, dir);
      done += 1;
      console.log(`ok   ${file.name} ${(file.size / 1e6).toFixed(0)} MB -> ${(size / 1e6).toFixed(1)} MB in ${Math.round((Date.now() - t0) / 1000)}s`);
    } catch (error) {
      console.log(`skip ${file.name}: ${error.message}`);
    } finally {
      await rm(join(dir, `${file.id}.src`), { force: true });
      await rm(join(dir, `${file.id}.mp4`), { force: true });
    }
  }
  console.log(`done: ${done}/${pending.length}`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
