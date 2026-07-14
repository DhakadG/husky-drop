import assert from "node:assert/strict";
import { createVideoSession } from "../public/share-video-session.js";

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
    this.dispatchEvent(new Event("pause"));
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
assert.equal(video.controls, true);
assert.equal(video.playsInline, true);

await session.playFromUser();
assert.equal(video.playCalls, 1);
video.pause();
assert.equal(session.snapshot().userPaused, true);

await session.activate({ autoplay: true });
assert.equal(video.playCalls, 1, "activation does not override an intentional pause");

await session.playFromUser();
session.pauseForVisibility();
assert.ok(video.pauseCalls >= 2);
assert.equal(session.snapshot().active, true, "background pause keeps the slide active");

session.deactivate();
assert.equal(session.snapshot().active, false);
session.destroy();
assert.equal(session.snapshot().state, "destroyed");
assert.equal(video.src, "");

const brokenVideo = new FakeVideo();
let attempts = 0;
const broken = createVideoSession({
  video: brokenVideo,
  resolveSource: async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("token refresh failed");
    return "/api/share/file/retry?inline=1";
  },
  onState: () => {},
});

await assert.rejects(() => broken.load(), /token refresh failed/);
assert.equal(broken.snapshot().state, "error");
await broken.retry();
assert.equal(brokenVideo.src, "/api/share/file/retry?inline=1");
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

assert.ok(states.some((entry) => entry.state === "loading"));
assert.ok(states.some((entry) => entry.state === "playing"));
console.log("share video session checks passed");
