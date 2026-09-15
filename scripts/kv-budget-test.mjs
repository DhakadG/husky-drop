import assert from "node:assert/strict";
import worker from "../src/worker.js";
import { LiveTracker } from "../src/live.js";
import { accessToken } from "../src/drive.js";
import { shareTrack } from "../src/share.js";
import { listShares } from "../src/share-admin.js";
import { gatePin } from "../src/store.js";
import { makePinFields } from "../src/util.js";

class ReadOnlyKV {
  constructor(entries = {}) {
    this.values = new Map(Object.entries(entries).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]));
    this.writes = [];
  }
  async get(key, type) {
    const value = this.values.get(key);
    if (value == null) return null;
    return type === "json" ? JSON.parse(value) : value;
  }
  async put(key) {
    this.writes.push(["put", key]);
    throw new Error("KV put() limit exceeded for the day");
  }
  async delete(key) {
    this.writes.push(["delete", key]);
    throw new Error("KV put() limit exceeded for the day");
  }
}

function liveBinding(calls) {
  const stub = {
    async fetch(input, init = {}) {
      const url = new URL(typeof input === "string" ? input : input.url);
      const body = init.body ? JSON.parse(init.body) : null;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/ratelimit") return Response.json({ allowed: true, retryAfter: 0 });
      return Response.json({ ok: true });
    },
  };
  return { idFromName: () => "global", get: () => stub };
}

const pinLink = { slug: "protected", label: "Protected", ...(await makePinFields("7777")) };
const pinKv = new ReadOnlyKV();
const pinFailure = await gatePin(
  new Request("https://drop.test/api/share/list", { headers: { "cf-connecting-ip": "203.0.113.9" } }),
  { KV: pinKv },
  pinLink,
  "7777",
  "share:",
  "share-protected",
);
assert.equal(pinFailure, null, "a correct PIN must remain usable after the KV write budget is exhausted");
assert.deepEqual(pinKv.writes, [], "successful PIN checks with no failure state must not spend a KV delete");

const tokenKv = new ReadOnlyKV();
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
let tokenRefreshes = 0;
globalThis.fetch = async () => {
  tokenRefreshes++;
  return Response.json({ access_token: "fresh-google-token", expires_in: 3600 });
};
console.warn = () => {};
try {
  assert.equal(await accessToken({
    KV: tokenKv,
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "refresh",
  }), "fresh-google-token", "a successful Google token refresh must remain usable when its optional KV cache write fails");
  assert.equal(await accessToken({
    KV: tokenKv,
    GOOGLE_CLIENT_ID: "client",
    GOOGLE_CLIENT_SECRET: "secret",
    GOOGLE_REFRESH_TOKEN: "refresh",
  }), "fresh-google-token");
  assert.equal(tokenRefreshes, 1, "the isolate memory cache must prevent repeated Google token refreshes while KV writes are unavailable");
} finally {
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
}

const shareCalls = [];
const shareKv = new ReadOnlyKV({ "share:album": { slug: "album", label: "Album" } });
const shareResponse = await shareTrack(
  new Request("https://drop.test/api/share/track", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.10" },
    body: JSON.stringify({ slug: "album", sessionId: "session-1", events: [{ t: "view", name: "IMG_1.jpg" }] }),
  }),
  { KV: shareKv, LIVE_TRACKER: liveBinding(shareCalls) },
);
assert.equal(shareResponse.status, 200, "share telemetry must not fail when KV writes are unavailable");
assert.deepEqual(shareKv.writes, [], "share telemetry must not create per-batch KV keys");
assert.equal(shareCalls.filter((call) => call.path === "/telemetry").length, 1, "raw share telemetry must be handed to Durable Object storage once per batch");

const dropCalls = [];
const dropKv = new ReadOnlyKV({ "link:inbox": { slug: "inbox", label: "Inbox" } });
const dropResponse = await worker.fetch(
  new Request("https://drop.test/api/drop/track", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.11" },
    body: JSON.stringify({ slug: "inbox", sessionId: "session-2", events: [{ t: "click", name: "button:Upload" }] }),
  }),
  { KV: dropKv, LIVE_TRACKER: liveBinding(dropCalls) },
);
assert.equal(dropResponse.status, 200, "drop telemetry must not fail when KV writes are unavailable");
assert.deepEqual(dropKv.writes, [], "drop telemetry must not create per-batch KV keys");
assert.equal(dropCalls.filter((call) => call.path === "/telemetry").length, 1, "raw drop telemetry must be handed to Durable Object storage once per batch");

const sqlCalls = [];
const shareRows = new Map();
const sql = {
  exec(statement, ...params) {
    sqlCalls.push({ statement, params });
    if (/SELECT opens, downloads, bytes, views, viewers_json FROM share_stats WHERE slug/i.test(statement)) {
      const row = shareRows.get(params[0]);
      return { toArray: () => row ? [row] : [] };
    }
    if (/INSERT INTO share_stats/i.test(statement)) {
      const [slug, opens, downloads, bytes, views, viewers_json] = params;
      shareRows.set(slug, { slug, opens, downloads, bytes, views, viewers_json });
      return { toArray: () => [] };
    }
    if (/SELECT slug, opens, downloads, bytes, views, viewers_json FROM share_stats/i.test(statement)) {
      return { toArray: () => [...shareRows.values()] };
    }
    return { toArray: () => [] };
  },
};
const state = {
  storage: { sql, getAlarm: async () => null, setAlarm: async () => {}, get: async () => undefined, put: async () => {} },
  blockConcurrencyWhile(task) { this.ready = Promise.resolve().then(task); },
};
const tracker = new LiveTracker(state, { KV: new ReadOnlyKV() });
await state.ready;
const persisted = await tracker.fetch(new Request("https://live.internal/telemetry", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "share", slug: "album", sessionId: "session-1", at: Date.now(), events: [{ t: "view", name: "IMG_1.jpg" }] }),
}));
assert.equal(persisted.status, 200, "Durable Object telemetry endpoint must accept batches");
assert.ok(sqlCalls.some(({ statement }) => /INSERT INTO telemetry_batches/i.test(statement)), "telemetry batches must persist in Durable Object SQLite");
const activity = await tracker.fetch(new Request("https://live.internal/event", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ record: { t: "share-browse", at: Date.now(), s: "album", m: "viewed 1 file" } }),
}));
assert.equal(activity.status, 200);
assert.ok(sqlCalls.some(({ statement }) => /INSERT INTO activity_events/i.test(statement)), "admin activity must persist in Durable Object SQLite instead of KV");
const recentActivity = await tracker.fetch(new Request("https://live.internal/events?limit=60"));
assert.equal(recentActivity.status, 200, "recent activity must be readable from Durable Object SQLite");
const activityDays = await tracker.fetch(new Request("https://live.internal/events-days?before=2026-07-13&days=3"));
assert.equal(activityDays.status, 200, "older activity day paging must use Durable Object SQLite instead of KV day keys");
const shareStat = await tracker.fetch(new Request("https://live.internal/share-stat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ slug: "album", views: 2, viewer: { email: "viewer@example.com", name: "Viewer" } }),
}));
assert.equal(shareStat.status, 200);
assert.equal((await shareStat.json()).viewerPreviouslySeen, false, "the first Durable Object viewer update reports a new viewer");
const repeatedShareStat = await tracker.fetch(new Request("https://live.internal/share-stat", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ slug: "album", viewer: { email: "viewer@example.com", name: "Viewer" } }),
}));
assert.equal((await repeatedShareStat.json()).viewerPreviouslySeen, true, "a repeated Durable Object viewer update reports an existing viewer");
assert.ok(sqlCalls.some(({ statement }) => /INSERT INTO share_stats/i.test(statement)), "share counters must persist in Durable Object SQLite instead of KV");
const shareStats = await tracker.fetch(new Request("https://live.internal/share-stats"));
assert.equal(shareStats.status, 200, "share counter deltas must be readable from Durable Object SQLite");

const listKv = new ReadOnlyKV({
  "shares:index": ["album"],
  "share:album": { slug: "album", label: "Album", mode: "gallery", createdAt: 1 },
  "sstats:album": { opens: 3, views: 4, downloads: 1, bytes: 100, viewers: {} },
});
const listLive = {
  idFromName: () => "global",
  get: () => ({ fetch: async () => Response.json({ rows: [{ slug: "album", opens: 2, views: 5, downloads: 1, bytes: 50, viewers: {} }] }) }),
};
const listed = await (await listShares({ KV: listKv, LIVE_TRACKER: listLive })).json();
assert.deepEqual(listed.shares[0].stats, { opens: 5, downloads: 2, bytes: 150, views: 9 }, "share list must merge historical KV totals with new SQLite deltas");

console.log("KV budget regression tests passed");

// Digest email is decided server-side from Drive-verified completions, so a
// tab closed before the browser reports "done" still produces exactly one
// email with the real file count.
const digestTracker = new LiveTracker(state, { KV: new ReadOnlyKV({ "link:inbox": { slug: "inbox", label: "Inbox", notify: { enabled: true, complete: true } } }) });
await state.ready;
const meta = (f, at) => ({ n: `${f}.jpg`, s: 1000, m: "image/jpeg", u: "Priya", f, si: "sess-1", at });
for (const [f, at] of [["a", 1], ["b", 2], ["a", 1]]) {
  await digestTracker.fetch(new Request("https://live.internal/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug: "inbox", label: "Inbox", meta: meta(f, at) }),
  }));
}
const digest = digestTracker.digests.get("sess-1");
assert.deepEqual([digest.files, digest.bytes, digest.uploader], [2, 2000, "Priya"], "retried completions must count once in the digest");
assert.equal(digestTracker.digests.ready(digest, Date.now() + 10_000), false, "an active session with no done signal waits for the idle window");
assert.equal(digestTracker.digests.ready(digest, Date.now() + 100_000), true, "an idle session still gets its digest without the browser saying done");
digestTracker.digests.note("sess-1", { done: true, uploader: "typed name" });
assert.equal(digestTracker.digests.get("sess-1").uploader, "Priya", "verified uploader name beats the browser's progress frame");
assert.equal(digestTracker.digests.ready(digestTracker.digests.get("sess-1"), Date.now() + 9_000), true, "a done session sends after the short settle window");
console.log("digest decision checks passed");

// Admin sockets receive one coalesced delta per burst of progress ticks, not a
// full re-sorted snapshot per tick, and a dropped uploader socket is reported
// through the attachment that survives hibernation.
const adminSends = [];
const adminSocket = { send: (payload) => adminSends.push(JSON.parse(payload)) };
const liveState = {
  storage: { sql, getAlarm: async () => null, setAlarm: async () => {}, get: async () => undefined, put: async () => {} },
  blockConcurrencyWhile(task) { this.ready = Promise.resolve().then(task); },
  getWebSockets: (tag) => (tag === "admin" ? [adminSocket] : []),
};
const feed = new LiveTracker(liveState, { KV: new ReadOnlyKV() });
await liveState.ready;
adminSends.length = 0;
for (let tick = 0; tick < 3; tick++) {
  feed.recordProgress({ sessionId: "s1", slug: "inbox", sent: tick, total: 10 });
  feed.recordProgress({ sessionId: "s2", slug: "inbox", sent: tick, total: 10 });
}
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(adminSends.length, 1, "six progress ticks inside the coalesce window become one admin patch");
assert.equal(adminSends[0].type, "patch");
assert.deepEqual(adminSends[0].updated.map((s) => s.id).sort(), ["s1", "s2"], "the patch carries only the sessions that changed");
let attachment = { role: "upload", slug: "inbox", sessionId: "s1" };
feed.webSocketClose({ deserializeAttachment: () => attachment, close() {} });
await new Promise((resolve) => setTimeout(resolve, 300));
assert.equal(adminSends.at(-1).updated[0]?.state, "stale", "a dropped uploader socket marks its session stale via the hibernation attachment");
console.log("live feed patch checks passed");
