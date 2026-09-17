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

  assert.ok(tracker.transcoderState.workers["0:0"], "worker 0 of runner 0 recorded");
  assert.equal(tracker.transcoderState.workers["0:0"].name, "vacation.mp4");
  assert.equal(tracker.transcoderState.workers["0:0"].percent, 45);

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
  assert.equal(tracker.transcoderState.workers["0:0"], undefined, "worker 0 cleared after completion");
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

  // 6. Fan-out: a second runner joining the same run must add to the totals,
  // not reset them, and the run is only over when every runner has gone.
  const runnerA = new MockWebSocket();
  const runnerB = new MockWebSocket();
  for (const [ws, shard] of [[runnerA, 0], [runnerB, 1]]) {
    state.acceptWebSocket(ws, ["transcoder"]);
    ws.serializeAttachment({ role: "transcoder" });
    tracker.webSocketMessage(ws, JSON.stringify({ type: "transcoder:hello", runId: "run-fan", trigger: "manual", parallel: 4, shards: 2, shard, total: 500 }));
  }
  assert.equal(tracker.transcoderState.parallel, 8, "both runners' workers are counted");
  assert.equal(tracker.transcoderState.total, 1000, "both runners' shares are counted");
  assert.equal(Object.keys(tracker.transcoderState.runners).length, 2);

  tracker.webSocketMessage(runnerA, JSON.stringify({ type: "transcoder:progress", shard: 0, slot: 1, fileId: "a", name: "a.mp4", size: 1, stage: "transcoding", percent: 10 }));
  tracker.webSocketMessage(runnerB, JSON.stringify({ type: "transcoder:progress", shard: 1, slot: 1, fileId: "b", name: "b.mp4", size: 1, stage: "transcoding", percent: 20 }));
  assert.equal(tracker.transcoderState.workers["0:1"].name, "a.mp4", "slot 1 of each runner is its own worker");
  assert.equal(tracker.transcoderState.workers["1:1"].name, "b.mp4");

  tracker.webSocketMessage(runnerA, JSON.stringify({ type: "transcoder:bye", shard: 0, runId: "run-fan" }));
  assert.equal(tracker.transcoderState.active, true, "one runner leaving does not end the run");
  assert.equal(tracker.transcoderState.workers["0:1"], undefined, "that runner's slots are forgotten");
  assert.equal(tracker.transcoderState.workers["1:1"].name, "b.mp4", "the other runner keeps going");
  tracker.webSocketMessage(runnerB, JSON.stringify({ type: "transcoder:bye", shard: 1, runId: "run-fan" }));
  assert.equal(tracker.transcoderState.active, false, "the run ends when the last runner leaves");

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

  // Anti-flicker contract. A telemetry tick or a poll must patch panels in
  // place; re-rendering the whole tab reset folder checkboxes mid-click and
  // re-triggered a full Drive crawl every 20s.
  const liveFn = adminPreviewsJs.slice(adminPreviewsJs.indexOf("export function updatePreviewsLive"));
  assert.ok(!liveFn.split("\n}")[0].includes("render()"), "a live telemetry tick never re-renders the whole tab");
  assert.ok(adminPreviewsJs.includes("function patch()"), "admin-previews patches panels in place");
  assert.ok(adminPreviewsJs.includes("next.folders = data.folders"), "a refreshed overview keeps folders already loaded");
  assert.ok(adminPreviewsJs.includes("if (coverageLoading) return;"), "only one Drive crawl runs at a time");

  // Coverage panel: bulk selection, search, filters and a real folder tree.
  assert.ok(adminPreviewsJs.includes('id="coverage-all"'), "coverage has a select-all checkbox");
  assert.ok(adminPreviewsJs.includes('id="coverage-search"'), "coverage has a search box");
  assert.ok(adminPreviewsJs.includes("data-filter="), "coverage has filter buttons");
  assert.ok(adminPreviewsJs.includes("data-collapse="), "folder rows can fold their subtree away");
  assert.ok(adminPreviewsJs.includes("pointerover"), "rows can be drag-selected");
  assert.ok(adminPreviewsJs.includes("shiftKey"), "rows can be range-selected");
  assert.ok(adminPreviewsJs.includes('id="previews-stop"'), "a run in progress can be stopped");
  assert.ok(adminPreviewsJs.includes('id="previews-shards"'), "the runner count is settable");
  assert.ok(!adminPreviewsJs.includes('max="1000"'), "the videos-per-run cap is no longer 1000");
  assert.ok(css.includes(".pick {"), "style.css has the compact checkbox");
  assert.ok(css.includes("#previews-body {"), "style.css spaces the previews panels apart");
  assert.ok(css.includes(".tree-caret"), "style.css has the folder tree caret");

  // Run limits and fan-out.
  assert.ok(previewsJs.includes("const MAX_RUN_LIMIT = 5000;"), "a run may ask for more than 300 videos");
  assert.ok(previewsJs.includes("const MAX_SHARDS = 20;"), "up to 20 runners, GitHub's free concurrent job limit");
  assert.ok(previewsJs.includes("export async function cancelPreviewRun"), "previews.js can cancel a run");
  assert.ok(workerJs.includes('rest === "cancel"'), "worker.js routes POST /api/admin/previews/cancel");

  // Sharding must survive the pending list shrinking under it.
  const shardOf = (id, shards) => {
    let h = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0) % shards;
  };
  const ids = Array.from({ length: 500 }, (_, i) => `drive-file-${i}`);
  const owners = new Map(ids.map((id) => [id, shardOf(id, 8)]));
  const half = ids.filter((_, i) => i % 2);
  for (const id of half) assert.equal(shardOf(id, 8), owners.get(id), "a file keeps its runner as the queue drains");
  const counts = new Array(8).fill(0);
  for (const id of ids) counts[shardOf(id, 8)] += 1;
  assert.ok(Math.min(...counts) > 500 / 8 / 2, "the hash spreads work over every runner");

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


// ---- Test 5: folder tree is rebuilt from parent ids, not list order ----
{
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../public/admin-previews.js", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("function indexTree"), src.indexOf("// ---------- live telemetry"));
  const indexTree = new Function(`${body}; return indexTree;`)();

  // scanShares walks siblings concurrently, so children can arrive before the
  // parent they belong to. Depth alone would nest these wrongly.
  const scrambled = [
    { folderId: "b1", parentId: "b", name: "b-child", depth: 1, videos: 1, ready: 0, pending: 1, failed: 0 },
    { folderId: "b", parentId: null, name: "beta", depth: 0, videos: 1, ready: 0, pending: 1, failed: 0 },
    { folderId: "a", parentId: null, name: "alpha", depth: 0, videos: 1, ready: 0, pending: 1, failed: 0 },
    { folderId: "a1", parentId: "a", name: "a-child", depth: 1, videos: 1, ready: 0, pending: 1, failed: 0 },
  ];
  const tree = indexTree(scrambled);
  assert.deepEqual(tree.map((f) => f.folderId), ["a", "a1", "b", "b1"], "rows come back depth-first under their own parent");
  assert.deepEqual(tree.map((f) => f.depth), [0, 1, 0, 1], "depth follows the parent chain");
  assert.equal(tree[0].hasKids, true, "a parent knows it has children");
  assert.equal(tree[1].hasKids, false);
  assert.equal(tree[1].parent, "a", "a child points at its parent so collapsing works");

  // An orphan (its share went away mid-scan) is still listed, not swallowed.
  const orphaned = indexTree([{ folderId: "x1", parentId: "gone", name: "orphan", depth: 1, videos: 1, ready: 0, pending: 1, failed: 0 }]);
  assert.equal(orphaned.length, 1, "a folder whose parent vanished is still shown");

  console.log("\u2713 Folder tree ordering verified");
}

// ---- Test 6: the coverage table survives the global form styles ----
{
  const fs = await import("node:fs");
  const css = fs.readFileSync(new URL("../public/style.css", import.meta.url), "utf8");
  const js = fs.readFileSync(new URL("../public/admin-previews.js", import.meta.url), "utf8");
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at > -1, `${selector} is defined`);
    return css.slice(at, css.indexOf("}", at));
  };

  // `input, select` sets width:100%, min-height:48px and 12px padding. A
  // checkbox that only overrides width/height renders as a 48px slab and
  // stretches every row it sits in.
  const pick = rule(".pick");
  for (const prop of ["min-height: 0", "padding: 0", "box-sizing: border-box"]) {
    assert.ok(pick.includes(prop), `.pick undoes the global input ${prop.split(":")[0]}`);
  }
  assert.ok(rule(".coverage-search input").includes("min-height: 0"), "the search field undoes the global input height too");

  // A <td> that is display:flex drops out of the table's column layout, which
  // smeared selected rows sideways over the neighbouring columns.
  assert.ok(!rule(".tree-cell").includes("display: flex"), "the folder cell stays a table cell");
  assert.ok(rule(".tree-row").includes("display: flex"), "the span inside it does the laying out");
  assert.ok(js.includes('<span class="tree-row">'), "folder rows wrap their contents in that span");
  assert.ok(!js.includes('class="bar-cell"'), "the progress cell is not a flex container either");

  console.log("\u2713 Coverage table form-style overrides verified");
}

// ---- Test 7: silent sources, duplicate previews, and honest live stats ----
{
  const fs = await import("node:fs");
  const script = fs.readFileSync(new URL("./transcode-previews.mjs", import.meta.url), "utf8");
  const previewsJs = fs.readFileSync(new URL("../src/previews.js", import.meta.url), "utf8");
  const ui = fs.readFileSync(new URL("../public/admin-previews.js", import.meta.url), "utf8");

  // "-c:a aac -ac 2" against a source with no audio stream makes ffmpeg build an
  // output audio stream nothing feeds, and it exits 234 with
  // "aost#0:1/aac ... Error initializing a simple filtergraph".
  assert.ok(script.includes("const dropAudio = silent || probe.hasAudio === false"), "a source with no audio is encoded with -an");
  assert.ok(script.includes('? ["-an"]'), "-an is what gets passed");
  assert.ok(script.includes("{ silent: true }"), "a failed encode is retried without audio");
  assert.ok(script.includes('"-threads", "2"'), "x264 is capped so six workers do not fight over four cores");

  // A silent h264 720p file should fast-remux, not re-encode.
  const compliant = (hasAudio, audioCodec) => (!hasAudio || ["aac", "mp3"].includes(audioCodec));
  assert.equal(compliant(false, ""), true, "a silent h264 720p file can still fast remux");
  assert.equal(compliant(true, "pcm_s16le"), false, "an undecodable audio codec still re-encodes");

  // A run cancelled between transcoding and reporting gets redone, and
  // putPreview always creates a new Drive file, so the old one must be binned.
  assert.ok(previewsJs.includes("superseded.push(prev.id)"), "a replaced preview is trashed rather than leaked");

  // Coverage is only meaningful against the folder tree. Counting every preview
  // in the index against the tree's video count reported "3777 of 3654 · 103%".
  assert.ok(previewsJs.includes("const orphans = Object.keys(index.files)"), "previews outside the shares are counted separately");
  assert.ok(ui.includes("next.totals = { ...data.totals, previewBytes: next.totals.previewBytes }"), "a refresh keeps the crawl's coverage numbers");
  assert.ok(ui.includes("Math.min(videos, data.totals.ready"), "live progress cannot push ready past the number of videos");

  // Three decimals, and they must not be rounded to an int on the way.
  const pct3 = (a, b) => (b > 0 ? Math.min(100, (a / b) * 100) : 0).toFixed(3);
  assert.equal(pct3(1719, 2464), "69.765");
  assert.equal(pct3(0, 2464), "0.000");
  assert.equal(pct3(2464, 2464), "100.000");
  assert.equal(pct3(1, 0), "0.000", "an empty run does not divide by zero");
  assert.ok(ui.includes("const pct3 ="), "the live panel uses it");
  assert.ok(!ui.includes('<span class="chip mini">'), "finished files no longer carry a button-looking chip");

  console.log("✓ Audio fallback, duplicate cleanup and live stats verified");
}
