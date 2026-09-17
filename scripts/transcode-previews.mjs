#!/usr/bin/env node
// High-performance, smart parallel video preview transcoder.
// Inspired by scripts/transcode-images.mjs with real-time WebSocket telemetry,
// pre-flight probe, dynamic bitrate scaling for long clips, and Cloudflare quota protection.
//
// Endpoints used:
//   GET  /api/admin/previews/pending?limit=N&cached=1 -> videos without a preview
//   GET  /api/admin/previews/source/:id              -> original bytes (Drive stream)
//   PUT  /api/admin/previews/:id                     -> store 720p preview (Drive stream)
//   POST /api/admin/previews/report                  -> batched KV report (1 KV write per 25 files)
//   GET  /api/admin/previews/ws?token=...            -> real-time WebSocket to LiveTracker DO
//
// Usage:
//   HUSKY_ORIGIN=... HUSKY_ADMIN_TOKEN=... PARALLEL=3 node scripts/transcode-previews.mjs

import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ---- Configuration & CLI inputs ----
const origin = (process.env.HUSKY_ORIGIN || "").replace(/\/$/, "");
const token = process.env.HUSKY_ADMIN_TOKEN || "";
const totalLimit = Math.max(1, Number(process.env.LIMIT) || 1000);
const budgetMs = (Number(process.env.TIME_BUDGET_MIN) || 270) * 60_000;
const runId = process.env.GITHUB_RUN_ID || `local-${Date.now()}`;
const trigger = process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ? "manual" : process.env.GITHUB_EVENT_NAME ? "schedule" : "local";

// Maximum preview size allowed by Cloudflare Worker request body (ceiling is 90 MB)
const MAX_PREVIEW_BYTES = 88 * 1024 * 1024;
// Target ceiling for duration-based bitrate budgeting (safe 78 MB margin)
const BUDGET_PREVIEW_BYTES = 78 * 1024 * 1024;

// Cloudflare Free Tier has 1,000 KV writes/day. Batching 25 items per KV report
// allows processing 4,000+ files with only ~160 KV writes total.
const REPORT_EVERY = Math.max(5, Number(process.env.REPORT_EVERY) || 25);

// Concurrency: default 3 in CI, or 1 to 6 based on available CPU cores
const detectedCpus = Math.max(1, cpus()?.length || 2);
const parallel = Math.max(1, Math.min(8, Number(process.env.PARALLEL) || (detectedCpus >= 4 ? 3 : 2)));

if (!origin || !token) {
  console.error("HUSKY_ORIGIN and HUSKY_ADMIN_TOKEN are required");
  process.exit(2);
}

const headers = { authorization: `Bearer ${token}` };
const api = (path, init = {}) =>
  fetch(`${origin}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers || {}) },
  });

// ---- Real-time WebSocket Client ----
let ws = null;
let wsConnected = false;
let wsHeartbeatTimer = null;
let wsReconnectTimer = null;
let isStopping = false;

function initWebSocket() {
  const wsUrl = `${origin.replace(/^http/, "ws")}/api/admin/previews/ws?token=${encodeURIComponent(token)}`;
  try {
    ws = new WebSocket(wsUrl);
  } catch (err) {
    console.warn(`[ws] could not create WebSocket: ${err.message}`);
    return;
  }

  ws.onopen = () => {
    wsConnected = true;
    console.log("[ws] connected to Cloudflare live status stream");
    sendWs({
      type: "transcoder:hello",
      runId,
      trigger,
      parallel,
      total: totalLimit,
      startedAt: started,
    });

    clearInterval(wsHeartbeatTimer);
    wsHeartbeatTimer = setInterval(() => {
      sendWs({ type: "transcoder:heartbeat", at: Date.now() });
    }, 15_000);
  };

  ws.onclose = () => {
    wsConnected = false;
    clearInterval(wsHeartbeatTimer);
    if (!isStopping) {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(initWebSocket, 4000);
    }
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {}
  };
}

function sendWs(payload) {
  if (!ws || !wsConnected || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

// ---- Smart Probe with ffprobe ----
async function probeVideo(filePath) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      [
        "-v", "error",
        "-show_entries", "format=duration,size,bit_rate:stream=width,height,codec_name,codec_type,r_frame_rate,bit_rate:stream_tags=rotate",
        "-of", "json",
        filePath,
      ],
      { timeout: 30_000 }
    );
    const info = JSON.parse(stdout || "{}");
    const videoStream = (info.streams || []).find((s) => s.codec_type === "video");
    const audioStream = (info.streams || []).find((s) => s.codec_type === "audio");
    const duration = Number(info.format?.duration) || 0;
    const width = Number(videoStream?.width) || 0;
    const height = Number(videoStream?.height) || 0;
    const videoCodec = videoStream?.codec_name || "";
    const audioCodec = audioStream?.codec_name || "";
    const bitrate = Number(info.format?.bit_rate) || 0;
    const rotation = Number(videoStream?.tags?.rotate) || 0;

    return {
      duration,
      width,
      height,
      videoCodec,
      audioCodec,
      bitrate,
      rotation,
      isCompliant:
        videoCodec === "h264" &&
        ["aac", "mp3"].includes(audioCodec) &&
        width > 0 && width <= 1280 &&
        height > 0 && height <= 720 &&
        bitrate > 0 && bitrate <= 2_600_000,
    };
  } catch {
    return {
      duration: 0,
      width: 0,
      height: 0,
      videoCodec: "",
      audioCodec: "",
      bitrate: 0,
      rotation: 0,
      isCompliant: false,
    };
  }
}

// ---- FFmpeg Runner with Live Progress Tracking & Bitrate Budgeting ----
function transcodeVideo(input, output, probe, onProgress) {
  const duration = probe.duration || 0;

  // Fast remux: if original is already 720p or smaller, H.264 + AAC, and fits budget,
  // skip CPU-intensive re-encoding and just remux with +faststart!
  if (probe.isCompliant) {
    const remuxArgs = [
      "-y", "-hide_banner", "-loglevel", "error",
      "-i", input,
      "-c", "copy",
      "-movflags", "+faststart",
      "-map_metadata", "-1",
      output,
    ];
    return new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", remuxArgs, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr?.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve({ via: "remux" });
        else reject(new Error(`ffmpeg remux failed (${code}): ${stderr.slice(0, 200)}`));
      });
    });
  }

  // Calculate dynamic bitrate based on duration so long clips NEVER exceed the 90 MB ceiling:
  // targetBps = (BUDGET_BYTES * 8) / durationSec
  let maxVideoBps = 2_400_000;
  let audioBps = 96_000;
  let audioBitrateStr = "96k";
  let crf = "26";

  if (duration > 0) {
    const totalTargetBps = Math.floor((BUDGET_PREVIEW_BYTES * 8) / duration);
    if (totalTargetBps < 2_500_000) {
      if (totalTargetBps < 120_000) {
        // Very long video (> 75 mins)
        audioBps = 32_000;
        audioBitrateStr = "32k";
        maxVideoBps = Math.max(40_000, totalTargetBps - audioBps);
        crf = "32";
      } else if (totalTargetBps < 300_000) {
        // Long video (30-75 mins)
        audioBps = 48_000;
        audioBitrateStr = "48k";
        maxVideoBps = Math.max(70_000, totalTargetBps - audioBps);
        crf = "30";
      } else {
        // Medium video (5-30 mins)
        audioBps = 64_000;
        audioBitrateStr = "64k";
        maxVideoBps = Math.max(120_000, totalTargetBps - audioBps);
        crf = "28";
      }
    }
  }

  const maxrateStr = `${Math.round(maxVideoBps / 1000)}k`;
  const bufsizeStr = `${Math.round((maxVideoBps * 2) / 1000)}k`;

  // Scale filter: ensures 720p maximum width and strictly even dimensions (required by libx264 yuv420p)
  const vf = "scale='min(1280,iw)':-2:force_original_aspect_ratio=decrease,pad='ceil(iw/2)*2':'ceil(ih/2)*2'";

  const args = [
    "-y", "-hide_banner", "-nostats",
    "-progress", "pipe:1",
    "-i", input,
    "-vf", vf,
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", crf,
    "-maxrate", maxrateStr,
    "-bufsize", bufsizeStr,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", audioBitrateStr,
    "-ac", "2",
    "-movflags", "+faststart",
    "-map_metadata", "-1",
    output,
  ];

  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    if (child.stdout) {
      const rl = createInterface({ input: child.stdout });
      let currentOutTimeUs = 0;
      let currentFps = 0;
      let currentSpeed = "1.0x";
      let lastReport = 0;

      rl.on("line", (line) => {
        const [key, val] = line.split("=");
        if (!key || !val) return;
        const trimmedKey = key.trim();
        const trimmedVal = val.trim();

        if (trimmedKey === "out_time_us") {
          currentOutTimeUs = Number(trimmedVal) || 0;
        } else if (trimmedKey === "fps") {
          currentFps = Number(trimmedVal) || 0;
        } else if (trimmedKey === "speed") {
          currentSpeed = trimmedVal;
        } else if (trimmedKey === "progress") {
          const now = Date.now();
          if (now - lastReport >= 1200) {
            lastReport = now;
            const currentSec = currentOutTimeUs / 1_000_000;
            const percent = duration > 0 ? Math.min(99, Math.max(0, Math.round((currentSec / duration) * 100))) : 0;
            const speedNum = Number.parseFloat(currentSpeed) || 1;
            const etaSec = duration > currentSec && speedNum > 0 ? Math.round((duration - currentSec) / speedNum) : 0;
            onProgress?.({ percent, fps: currentFps, speed: currentSpeed, etaSec });
          }
        }
      });
    }

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ via: "transcode" });
      } else {
        const detail = stderr.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
        reject(new Error(`ffmpeg exited ${code}: ${detail || "unknown error"}`));
      }
    });
  });
}

// ---- Process Single Video in Worker Slot ----
async function transcodeOne(file, dir, slot) {
  const input = join(dir, `${file.id}.src`);
  const output = join(dir, `${file.id}.mp4`);

  const reportStage = (stage, extra = {}) => {
    sendWs({
      type: "transcoder:progress",
      slot,
      fileId: file.id,
      name: file.name,
      size: file.size,
      stage,
      ...extra,
    });
  };

  // Step 1: Download source stream with retry
  reportStage("downloading", { percent: 0 });
  let srcRes = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      srcRes = await api(`/api/admin/previews/source/${file.id}`);
      if (srcRes.ok && srcRes.body) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
  }
  if (!srcRes || !srcRes.ok || !srcRes.body) {
    throw new Error(`source download failed (${srcRes?.status || "network"})`);
  }
  await pipeline(Readable.fromWeb(srcRes.body), createWriteStream(input));

  // Step 2: Probe metadata
  reportStage("probing", { percent: 5 });
  const probe = await probeVideo(input);

  // Step 3: Transcode / Remux
  reportStage("transcoding", { percent: 10, speed: "1.0x" });
  const { via } = await transcodeVideo(input, output, probe, ({ percent, fps, speed, etaSec }) => {
    reportStage("transcoding", { percent, fps, speed, etaSec });
  });

  const { size } = await stat(output);
  if (!size) throw new Error("transcoder produced empty file");
  if (size > MAX_PREVIEW_BYTES) {
    throw new Error(`preview ${Math.round(size / 1e6)} MB exceeds ${Math.round(MAX_PREVIEW_BYTES / 1e6)} MB limit`);
  }

  // Step 4: Upload preview with retry
  reportStage("uploading", { percent: 98 });
  let put = null;
  let putData = {};
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      let body;
      try {
        body = Readable.toWeb(createReadStream(output));
      } catch {
        body = await readFile(output);
      }
      put = await api(`/api/admin/previews/${file.id}`, {
        method: "PUT",
        headers: {
          "content-type": "video/mp4",
          "content-length": String(size),
          ...(attempt ? { "x-retry": "1" } : {}),
        },
        body,
        duplex: "half",
      });
      if (put.ok) {
        putData = await put.json().catch(() => ({}));
        break;
      }
      if (put.status < 500) {
        putData = await put.json().catch(() => ({}));
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2500 * (attempt + 1)));
  }

  if (!put || !put.ok) {
    throw new Error(putData.error || `put ${put?.status || "network failure"}`);
  }

  return { previewId: putData.previewId, size, via };
}

// ---- Batched KV Reporting ----
let batch = { done: [], skipped: [] };
let lastReportTime = Date.now();

async function report(extra = {}) {
  if (!batch.done.length && !batch.skipped.length && !extra.finishedAt) return null;
  const body = JSON.stringify({
    runId,
    trigger,
    startedAt: started,
    ...batch,
    ...extra,
  });
  batch = { done: [], skipped: [] };
  lastReportTime = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await api("/api/admin/previews/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      if (r?.ok) return r.json();
    } catch {}
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  console.warn("[report] batch report failed after retries");
  return null;
}

// ---- Main Parallel Processing Loop ----
const started = Date.now();
const dir = await mkdtemp(join(tmpdir(), "hd-previews-"));
initWebSocket();

// Handle graceful termination
process.on("SIGINT", async () => {
  if (isStopping) return;
  isStopping = true;
  console.log("\n[SIGINT] Stopping gracefully...");
  await report({ stopped: true });
  sendWs({ type: "transcoder:bye", runId });
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
});

process.on("SIGTERM", async () => {
  if (isStopping) return;
  isStopping = true;
  console.log("\n[SIGTERM] Terminating...");
  await report({ stopped: true });
  sendWs({ type: "transcoder:bye", runId });
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  process.exit(0);
});

let processedCount = 0;
let totalPendingRemaining = 0;

try {
  let isFirstBatch = true;

  while (processedCount < totalLimit) {
    if (Date.now() - started > budgetMs) {
      console.log(`[budget] time budget reached (${Math.round(budgetMs / 60_000)} min); stopping`);
      break;
    }

    // Fetch batch of videos (use cached=1 after the first fetch to avoid repeated Drive tree scans)
    const batchSize = Math.max(parallel * 4, 24);
    const fetchLimit = Math.min(batchSize, totalLimit - processedCount);
    const cachedParam = isFirstBatch ? "" : "&cached=1";
    isFirstBatch = false;

    let res;
    try {
      res = await api(`/api/admin/previews/pending?limit=${fetchLimit}${cachedParam}`);
    } catch (err) {
      console.warn(`[pending] fetch failed: ${err.message}, retrying in 5s...`);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }

    if (!res.ok) {
      const errText = (await res.text()).slice(0, 200);
      throw new Error(`pending request failed ${res.status}: ${errText}`);
    }

    const { pending = [], indexed = 0, total = 0 } = await res.json();
    totalPendingRemaining = total || pending.length;

    if (!pending.length) {
      console.log(`[queue] no more pending videos; indexed: ${indexed}`);
      break;
    }

    console.log(
      `[batch] processing ${pending.length} videos (${parallel} parallel workers, ${totalPendingRemaining} remaining in queue)`
    );

    const queue = [...pending];
    let stopReason = "";

    const worker = async (slot) => {
      const slotDir = join(dir, `w${slot}`);
      await mkdir(slotDir, { recursive: true });

      while (queue.length > 0) {
        if (Date.now() - started > budgetMs) {
          stopReason = "time budget reached";
          return;
        }

        const file = queue.shift();
        if (!file) break;

        const t0 = Date.now();
        try {
          const { previewId, size, via } = await transcodeOne(file, slotDir, slot);
          const elapsed = Date.now() - t0;
          processedCount += 1;

          batch.done.push({
            id: file.id,
            name: file.name,
            size: file.size,
            previewId,
            previewSize: size,
            ms: elapsed,
          });

          sendWs({
            type: "transcoder:file_done",
            slot,
            id: file.id,
            name: file.name,
            size: file.size,
            previewSize: size,
            ms: elapsed,
            via,
          });

          const origMb = (file.size / 1e6).toFixed(1);
          const prevMb = (size / 1e6).toFixed(1);
          console.log(
            `ok   [w${slot}] ${file.name} (${origMb} MB -> ${prevMb} MB in ${Math.round(elapsed / 1000)}s, ${via})`
          );
        } catch (error) {
          processedCount += 1;
          batch.skipped.push({ id: file.id, name: file.name, error: error.message });

          sendWs({
            type: "transcoder:file_skip",
            slot,
            id: file.id,
            name: file.name,
            error: error.message,
          });

          console.log(`skip [w${slot}] ${file.name}: ${error.message}`);
        } finally {
          // Flush batch to KV periodically or when size exceeds threshold
          if (
            batch.done.length + batch.skipped.length >= REPORT_EVERY ||
            Date.now() - lastReportTime >= 180_000
          ) {
            await report();
          }

          // Clean slot temp files immediately to protect disk quota
          await rm(join(slotDir, `${file.id}.src`), { force: true });
          await rm(join(slotDir, `${file.id}.mp4`), { force: true });
        }
      }
    };

    // Run parallel workers
    const activeWorkers = Array.from({ length: Math.min(parallel, queue.length) }, (_, i) => worker(i));
    await Promise.all(activeWorkers);

    // Report batch results
    await report();

    if (stopReason) {
      console.log(`[stop] ${stopReason}`);
      break;
    }
  }

  // Final summary report
  await report({
    finishedAt: Date.now(),
    pendingLeft: Math.max(0, totalPendingRemaining - processedCount),
  });

  sendWs({
    type: "transcoder:bye",
    runId,
    done: processedCount,
    finishedAt: Date.now(),
  });

  console.log(`\n=== All Done: ${processedCount} videos processed in ${Math.round((Date.now() - started) / 1000)}s ===`);
} finally {
  isStopping = true;
  clearInterval(wsHeartbeatTimer);
  clearTimeout(wsReconnectTimer);
  try {
    ws?.close();
  } catch {}
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
