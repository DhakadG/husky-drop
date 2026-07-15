import assert from "node:assert/strict";
import { createVideoSession, createVideoWarmLease, projectVideoTimeline } from "../public/share-video-session.js";

assert.deepEqual(
  projectVideoTimeline({ currentTime: 15.92, duration: 16, ended: true }),
  { currentTime: 16, duration: 16 },
  "an ended video projects to the exact end of its timeline",
);

let scheduledRelease = null;
let releasedSource = "";
const warmLease = createVideoWarmLease({
  releaseDelay: 500,
  setTimer: (callback, delay) => {
    assert.equal(delay, 500);
    scheduledRelease = callback;
    return 1;
  },
  clearTimer: () => { scheduledRelease = null; },
  onRelease: (source) => { releasedSource = source; },
});
warmLease.remember("/api/share/file/warm?inline=1");
warmLease.claim("preview");
warmLease.release("preview");
assert.equal(typeof scheduledRelease, "function", "unhover schedules a short warm-source grace period");
warmLease.claim("viewer");
assert.equal(scheduledRelease, null, "opening the viewer claims and preserves the warm source");
assert.equal(warmLease.sourceFor(() => true), "/api/share/file/warm?inline=1");
warmLease.release("viewer");
scheduledRelease();
assert.equal(releasedSource, "/api/share/file/warm?inline=1");
assert.equal(warmLease.sourceFor(() => true), "", "released leases no longer advertise a stale source");
assert.deepEqual(
  projectVideoTimeline({ currentTime: 18, duration: 16, ended: false }),
  { currentTime: 16, duration: 16 },
  "timeline projection clamps imprecise media clocks",
);
assert.deepEqual(
  projectVideoTimeline({ currentTime: Number.NaN, duration: Number.POSITIVE_INFINITY, ended: false }),
  { currentTime: 0, duration: 0 },
  "timeline projection never exposes invalid values to the range control",
);

class FakeVideo extends EventTarget {
  constructor() {
    super();
    this.src = "";
    this.controls = false;
    this.playsInline = false;
    this.preload = "";
    this.paused = true;
    this.ended = false;
    this.playCalls = 0;
    this.pauseCalls = 0;
    this.loadCalls = 0;
    this.readyState = 0;
    this.currentTime = 0;
    this.asyncPause = false;
  }

  load() {
    this.loadCalls += 1;
  }

  play() {
    this.playCalls += 1;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }

  pause() {
    this.pauseCalls += 1;
    this.paused = true;
    if (this.asyncPause) queueMicrotask(() => this.dispatchEvent(new Event("pause")));
    else this.dispatchEvent(new Event("pause"));
  }

  removeAttribute(name) {
    if (name === "src") this.src = "";
  }
}

const states = [];
const video = new FakeVideo();
let sourceCalls = 0;
const session = createVideoSession({
  video,
  resolveSource: async () => {
    sourceCalls += 1;
    return "/api/share/file/video?inline=1";
  },
  onState: (state) => states.push(state),
});

await session.activate({ autoplay: false });
assert.equal(sourceCalls, 1);
assert.equal(video.src, "/api/share/file/video?inline=1");
assert.equal(video.playCalls, 0, "mobile activation does not autoplay");
assert.equal(video.controls, false, "the viewer owns one external control bar instead of rendering native controls too");
assert.equal(video.playsInline, true);

await session.playFromUser();
assert.equal(video.playCalls, 1);
video.pause();
assert.equal(session.snapshot().userPaused, true);

await session.activate({ autoplay: true });
assert.equal(video.playCalls, 1, "activation does not override an intentional pause");

await session.playFromUser();
video.asyncPause = true;
session.pauseForVisibility();
await Promise.resolve();
assert.ok(video.pauseCalls >= 2);
assert.equal(session.snapshot().active, true, "background pause keeps the slide active");
assert.equal(session.snapshot().userPaused, false, "an asynchronously delivered system pause is not mistaken for user intent");

session.deactivate();
assert.equal(session.snapshot().active, false);
session.destroy();
assert.equal(session.snapshot().state, "destroyed");
assert.equal(video.src, "");

const brokenVideo = new FakeVideo();
let attempts = 0;
const forceFlags = [];
const broken = createVideoSession({
  video: brokenVideo,
  resolveSource: async (_signal, { force }) => {
    forceFlags.push(force);
    attempts += 1;
    if (attempts === 1) throw new Error("token refresh failed");
    return "/api/share/file/retry?inline=1";
  },
  onState: () => {},
});

await broken.activate({ autoplay: false }).catch(() => {});
assert.equal(broken.snapshot().state, "error");
brokenVideo.currentTime = 19;
await broken.retry({ play: true });
assert.equal(brokenVideo.src, "/api/share/file/retry?inline=1");
assert.equal(brokenVideo.currentTime, 19, "a refreshed signed URL preserves playback position");
assert.equal(brokenVideo.playCalls, 1, "a retry click refreshes the tokenized source and retries playback in the same gesture");
assert.deepEqual(forceFlags, [false, true], "ordinary loads reuse a fresh source while explicit retries force refresh");
broken.destroy();

const blockedVideo = new FakeVideo();
blockedVideo.play = () => Promise.reject(new Error("playback blocked"));
const blocked = createVideoSession({
  video: blockedVideo,
  resolveSource: async () => "/api/share/file/blocked?inline=1",
  onState: () => {},
});
await blocked.activate({ autoplay: false });
await assert.rejects(() => blocked.playFromUser(), /playback blocked/);
assert.equal(blocked.snapshot().state, "error");
blocked.destroy();

let releaseSource;
const staleVideo = new FakeVideo();
const stale = createVideoSession({
  video: staleVideo,
  resolveSource: () => new Promise((resolve) => { releaseSource = resolve; }),
  onState: () => {},
});
const staleActivation = stale.activate({ autoplay: true });
await Promise.resolve();
stale.deactivate();
releaseSource("/api/share/file/stale?inline=1");
await staleActivation;
assert.equal(staleVideo.src, "", "a deactivated slide cannot assign a late tokenized source");
assert.equal(staleVideo.playCalls, 0, "a deactivated slide cannot autoplay after its source resolver finishes");
stale.destroy();

const readyVideo = new FakeVideo();
const readyStates = [];
const ready = createVideoSession({ video: readyVideo, resolveSource: async () => "/ready", onState: (state) => readyStates.push(state.state) });
await ready.activate();
readyVideo.readyState = 3;
readyVideo.dispatchEvent(new Event("canplay"));
assert.equal(ready.snapshot().state, "ready", "canplay is accepted as a usable external-player readiness signal");
ready.destroy();

assert.ok(states.some((entry) => entry.state === "loading"));
assert.ok(states.some((entry) => entry.state === "playing"));
console.log("share video session checks passed");
