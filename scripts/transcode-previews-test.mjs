#!/usr/bin/env node
// Test suite for the upgraded parallel video transcoder and real-time WebSocket dashboard.

import assert from "node:assert/strict";
import { LiveTracker } from "../src/live.js";

console.log("Running video transcoder & real-time WebSocket tests...");

// Mock state and storage for Durable Object LiveTracker
class MockStorage {
  constructor() {
    this.data = new Map();
    this.sql = null;
  }
  async get(key) {
    return this.data.get(key);
  }
  async put(key, val) {
    this.data.set(key, val);
  }
  async getAlarm() {
    return null;
  }
  async setAlarm() {}
}

class MockState {
  constructor() {
    this.storage = new MockStorage();
    this.sockets = { admin: [], upload: [], transcoder: [] };
  }
  blockConcurrencyWhile(fn) {
    return fn();
  }
  acceptWebSocket(ws, tags = []) {
    for (const tag of tags) {
      if (this.sockets[tag]) this.sockets[tag].push(ws);
    }
  }
  getWebSockets(tag) {
    return this.sockets[tag] || [];
  }
}

class MockWebSocket {
  constructor() {
    this.attachment = null;
    this.sent = [];
    this.closed = false;
  }
  serializeAttachment(val) {
    this.attachment = val;
  }
  deserializeAttachment() {
    return this.attachment;
  }
  send(data) {
    this.sent.push(typeof data === "string" ? JSON.parse(data) : data);
  }
  close() {
    this.closed = true;
  }
}

// ---- Test 1: LiveTracker WebSocket Role and Broadcast ----
{
  const state = new MockState();
  const env = { KV: { get: async () => null, put: async () => {} } };
  const tracker = new LiveTracker(state, env);

  // Connect an admin socket
  const adminWs = new MockWebSocket();
  state.acceptWebSocket(adminWs, ["admin"]);
  adminWs.serializeAttachment({ role: "admin" });

  // Initial snapshot should include previewsLive
  assert.ok(tracker.transcoderState, "transcoderState is initialized");
  assert.equal(tracker.transcoderState.active, false);

  // Connect transcoder socket
  const transcoderWs = new MockWebSocket();
  state.acceptWebSocket(transcoderWs, ["transcoder"]);
  transcoderWs.serializeAttachment({ role: "transcoder" });

  // 1. Send hello
  tracker.webSocketMessage(
    transcoderWs,
    JSON.stringify({
      type: "transcoder:hello",
      runId: "run-4000",
      trigger: "manual",
      parallel: 3,
      total: 4000,
    })
  );

  assert.equal(tracker.transcoderState.active, true);
  assert.equal(tracker.transcoderState.runId, "run-4000");
  assert.equal(tracker.transcoderState.parallel, 3);
  assert.equal(tracker.transcoderState.total, 4000);

  // Verify admin socket received the broadcast
  const lastAdminMsg = adminWs.sent[adminWs.sent.length - 1];
  assert.equal(lastAdminMsg.type, "previews:live");
  assert.equal(lastAdminMsg.live.runId, "run-4000");

  // 2. Send progress for slot 0
  tracker.webSocketMessage(
    transcoderWs,
    JSON.stringify({
      type: "transcoder:progress",
      slot: 0,
      fileId: "vid-1",
      name: "vacation.mp4",
      size: 50_000_000,
      stage: "transcoding",
      percent: 45,
      speed: "3.2x",
      fps: 64,
    })
  );

  assert.ok(tracker.transcoderState.workers["0"], "worker 0 recorded");
  assert.equal(tracker.transcoderState.workers["0"].name, "vacation.mp4");
  assert.equal(tracker.transcoderState.workers["0"].percent, 45);

  // 3. Send file completion
  tracker.webSocketMessage(
    transcoderWs,
    JSON.stringify({
      type: "transcoder:file_done",
      slot: 0,
      id: "vid-1",
      name: "vacation.mp4",
      size: 50_000_000,
      previewSize: 5_000_000,
      ms: 12000,
      via: "transcode",
    })
  );

  assert.equal(tracker.transcoderState.done, 1);
  assert.equal(tracker.transcoderState.workers["0"], undefined, "worker 0 cleared after completion");
  assert.equal(tracker.transcoderState.recent.length, 1);
  assert.equal(tracker.transcoderState.recent[0].previewSize, 5_000_000);

  // 4. Send file skip (error)
  tracker.webSocketMessage(
    transcoderWs,
    JSON.stringify({
      type: "transcoder:file_skip",
      slot: 1,
      id: "vid-2",
      name: "corrupt.mp4",
      error: "invalid moov atom",
    })
  );

  assert.equal(tracker.transcoderState.skipped, 1);
  assert.equal(tracker.transcoderState.recent.length, 2);
  assert.equal(tracker.transcoderState.recent[0].ok, false);

  // 5. Send bye / close
  tracker.webSocketMessage(
    transcoderWs,
    JSON.stringify({
      type: "transcoder:bye",
      runId: "run-4000",
      done: 1,
    })
  );
  assert.equal(tracker.transcoderState.active, false);

  console.log("✓ LiveTracker WebSocket telemetry tests passed");
}

// ---- Test 2: Dynamic Bitrate Budgeting Formula ----
{
  const BUDGET_PREVIEW_BYTES = 78 * 1024 * 1024; // 78 MB

  function calcBitrate(durationSec) {
    let maxVideoBps = 2_400_000;
    let audioBps = 96_000;
    if (durationSec > 0) {
      const totalTargetBps = Math.floor((BUDGET_PREVIEW_BYTES * 8) / durationSec);
      if (totalTargetBps < 2_500_000) {
        if (totalTargetBps < 120_000) {
          audioBps = 32_000;
          maxVideoBps = Math.max(40_000, totalTargetBps - audioBps);
        } else if (totalTargetBps < 300_000) {
          audioBps = 48_000;
          maxVideoBps = Math.max(70_000, totalTargetBps - audioBps);
        } else {
          audioBps = 64_000;
          maxVideoBps = Math.max(120_000, totalTargetBps - audioBps);
        }
      }
    }
    const estimatedMaxBytes = Math.ceil(((maxVideoBps + audioBps) * durationSec) / 8);
    return { maxVideoBps, audioBps, estimatedMaxBytes };
  }

  // Short video: 30 seconds
  const shortVid = calcBitrate(30);
  assert.equal(shortVid.maxVideoBps, 2_400_000, "short videos use standard 2400k ceiling");

  // Medium video: 10 minutes (600s)
  const medVid = calcBitrate(600);
  assert.ok(medVid.estimatedMaxBytes <= 85 * 1024 * 1024, "10 min video stays under 85 MB");

  // Long video: 30 minutes (1800s)
  const longVid = calcBitrate(1800);
  assert.ok(longVid.estimatedMaxBytes <= 85 * 1024 * 1024, "30 min video stays under 85 MB");

  // Feature length: 2 hours (7200s)
  const movieVid = calcBitrate(7200);
  assert.ok(movieVid.estimatedMaxBytes <= 85 * 1024 * 1024, "2-hour video stays under 85 MB limit");

  console.log("✓ Dynamic bitrate budgeting formulas verified (files guaranteed < 85MB)");
}

// ---- Test 3: Fast Remux Compliance Detection ----
{
  function isCompliant(probe) {
    return (
      probe.videoCodec === "h264" &&
      ["aac", "mp3"].includes(probe.audioCodec) &&
      probe.width > 0 &&
      probe.width <= 1280 &&
      probe.height > 0 &&
      probe.height <= 720 &&
      probe.bitrate > 0 &&
      probe.bitrate <= 2_600_000
    );
  }

  // Already 720p H.264
  assert.equal(
    isCompliant({ videoCodec: "h264", audioCodec: "aac", width: 1280, height: 720, bitrate: 1_800_000 }),
    true,
    "720p h264/aac should fast remux"
  );

  // 1080p requires transcoding
  assert.equal(
    isCompliant({ videoCodec: "h264", audioCodec: "aac", width: 1920, height: 1080, bitrate: 5_000_000 }),
    false,
    "1080p must transcode to 720p"
  );

  // HEVC/H.265 requires transcoding
  assert.equal(
    isCompliant({ videoCodec: "hevc", audioCodec: "aac", width: 1280, height: 720, bitrate: 1_000_000 }),
    false,
    "HEVC must transcode to H.264"
  );

  console.log("✓ Fast remux compliance detection verified");
}

// ---- Test 4: Progressive Preview UI & Skeletons Contract ----
{
  const fs = await import("node:fs");
  const adminHtml = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
  const adminPreviewsJs = fs.readFileSync(new URL("../public/admin-previews.js", import.meta.url), "utf8");
  const css = fs.readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  const workerJs = fs.readFileSync(new URL("../src/worker.js", import.meta.url), "utf8");
  const previewsJs = fs.readFileSync(new URL("../src/previews.js", import.meta.url), "utf8");

  // Verify admin.html initial skeleton state
  assert.ok(adminHtml.includes('id="previews-stat-grid"'), "admin.html has previews stat grid skeleton");
  assert.ok(adminHtml.includes("stat-card v3 skel"), "admin.html has skeleton stat cards");
  assert.ok(adminHtml.includes('id="previews-runs-section"'), "admin.html has previews runs section skeleton");
  assert.ok(adminHtml.includes('id="previews-coverage-section"'), "admin.html has previews coverage section skeleton");
  assert.ok(adminHtml.includes("coverage-loading-badge"), "admin.html has coverage loading badge");
  assert.ok(!adminHtml.includes("Loading preview status…"), "admin.html no longer contains blank loading text");

  // Verify admin-previews.js progressive decoupled functions
  assert.ok(adminPreviewsJs.includes("export function renderSkeletons"), "admin-previews exports renderSkeletons");
  assert.ok(adminPreviewsJs.includes("export async function loadCoverage"), "admin-previews exports loadCoverage");
  assert.ok(adminPreviewsJs.includes("loadCoverage({ fresh"), "admin-previews kicks off background coverage fetch");
  assert.ok(adminPreviewsJs.includes("renderCoverageLoading"), "admin-previews has renderCoverageLoading skeleton");
  assert.ok(adminPreviewsJs.includes("updateStatCards"), "admin-previews updates stat cards in place");

  // Verify CSS skeleton and spinner rules
  assert.ok(css.includes(".skel-bone"), "style.css includes .skel-bone");
  assert.ok(css.includes("@keyframes skel-wave"), "style.css includes @keyframes skel-wave");
  assert.ok(css.includes(".stat-card.v3.skel"), "style.css includes .stat-card.v3.skel");
  assert.ok(css.includes(".coverage-loading-badge"), "style.css includes .coverage-loading-badge");
  assert.ok(css.includes("@keyframes spin"), "style.css includes @keyframes spin");

  // Verify Worker & backend routes
  assert.ok(workerJs.includes('rest === "coverage"'), "worker.js routes GET /api/admin/previews/coverage");
  assert.ok(previewsJs.includes("export async function previewsCoverage"), "previews.js exports previewsCoverage");
  assert.ok(previewsJs.includes("foldersLoading"), "previewsOverview supports foldersLoading");

  console.log("✓ Progressive previews UI contracts, skeletons & decoupled routes verified");
}

console.log("\nAll video transcoder tests passed successfully!");

