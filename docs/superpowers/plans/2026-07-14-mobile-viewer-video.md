# Mobile Viewer and Video Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved immersive mobile viewer with a persistent compact thumbstrip and a reliable, dedicated video player lifecycle.

**Architecture:** Keep PhotoSwipe, Swiper, the viewer asset engine, EXIF, rotation, and desktop controls. Add a DOM-independent video session controller, render a fresh player for each PhotoSwipe video content instance, measure viewer chrome instead of using fixed padding, and mount a phone-only action dock/sheet that calls the existing viewer actions.

**Tech Stack:** PhotoSwipe, Swiper, browser ES modules, native HTML video controls, ResizeObserver, CSS dynamic viewport/safe-area units, Node `assert` regression scripts.

## Global Constraints

- Use Layout A's immersive hierarchy with Layout B's persistent compact thumbnail strip.
- Never reuse or mutate the gallery-hover video element as a viewer player.
- Mobile video playback requires explicit user intent and uses native controls with `playsinline`.
- Pause video on slide deactivation, document hiding, viewer close, and destruction; never restart a user-paused video implicitly.
- Video/control gestures, PhotoSwipe gestures, and Swiper gestures must not steal one another's input.
- The thumbnail strip is visible by default for at least two viewable items and remains user-hideable through advanced settings.
- Viewer media padding is measured from current chrome and safe areas, not fixed to one phone height.
- Preserve the existing desktop viewer, keyboard shortcuts, progressive image tiers, EXIF, rotation, download, and reduced-motion behavior.

---

## File map

- Create `public/share-video-session.js`: source loading, playback intent, pause state, retry, abort, and destruction controller for one owned `<video>`.
- Create `scripts/share-video-session-test.mjs`: fake-video lifecycle tests.
- Modify `public/share.js`: dedicated video rendering, session registration, visibility pause, measured chrome, mobile dock/sheet, and compact strip default.
- Modify `public/style.css`: video state surfaces, mobile viewer chrome, persistent strip, safe-area dock/sheets, and gesture boundaries.
- Modify `scripts/share-viewer-test.mjs`: forbid preview-video reuse and enforce mobile viewer structures.
- Modify `package.json`: add the session test to the full suite.

### Task 1: Dedicated video-session controller

**Files:**
- Create: `public/share-video-session.js`
- Create: `scripts/share-video-session-test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `createVideoSession({ video, resolveSource, onState })`.
- Produces methods: `load()`, `activate({ autoplay })`, `playFromUser()`, `deactivate()`, `pauseForVisibility()`, `retry()`, `destroy()`, and `snapshot()`.
- `resolveSource(signal) -> Promise<string>` returns a refreshed same-origin inline media URL.
- `onState({ state, error, active, userPaused })` renders loading, ready, playing, paused, error, and destroyed states.

- [ ] **Step 1: Write failing lifecycle tests with a fake video**

Create `scripts/share-video-session-test.mjs`:

```js
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
  load() { this.loadCalls += 1; }
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
  removeAttribute(name) { if (name === "src") this.src = ""; }
}

const states = [];
const video = new FakeVideo();
let sourceCalls = 0;
const session = createVideoSession({
  video,
  resolveSource: async () => { sourceCalls += 1; return "/api/share/file/video?inline=1"; },
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

assert.ok(states.some((entry) => entry.state === "loading"));
assert.ok(states.some((entry) => entry.state === "playing"));
console.log("share video session checks passed");
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `node scripts/share-video-session-test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `public/share-video-session.js`.

- [ ] **Step 3: Implement the owned session controller**

Create `public/share-video-session.js`:

```js
export function createVideoSession({ video, resolveSource, onState = () => {} }) {
  let state = "idle";
  let error = null;
  let active = false;
  let userPaused = false;
  let internalPause = false;
  let destroyed = false;
  let controller = null;
  let loadPromise = null;

  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";

  const snapshot = () => ({ state, error, active, userPaused });
  const emit = (next, nextError = null) => {
    state = next;
    error = nextError;
    onState(snapshot());
  };
  const onPlay = () => {
    userPaused = false;
    emit("playing");
  };
  const onPause = () => {
    if (!internalPause && active && !video.ended) userPaused = true;
    if (!destroyed && state !== "error") emit("paused");
  };
  const onLoadedData = () => {
    if (!destroyed && state !== "playing") emit("ready");
  };
  const onError = () => {
    if (!destroyed) emit("error", new Error("Video could not be played by this browser."));
  };
  for (const [name, handler] of [["play", onPlay], ["pause", onPause], ["loadeddata", onLoadedData], ["error", onError]]) {
    video.addEventListener(name, handler);
  }

  const pauseInternally = () => {
    if (video.paused) return;
    internalPause = true;
    video.pause();
    internalPause = false;
  };

  const load = () => {
    if (destroyed) return Promise.reject(new Error("Video session is destroyed."));
    if (video.src && state !== "error") return Promise.resolve(video.src);
    if (loadPromise) return loadPromise;
    controller?.abort();
    controller = new AbortController();
    emit("loading");
    loadPromise = resolveSource(controller.signal)
      .then((source) => {
        if (destroyed || controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
        video.src = source;
        video.load();
        return source;
      })
      .catch((cause) => {
        if (cause?.name !== "AbortError") emit("error", cause instanceof Error ? cause : new Error(String(cause)));
        throw cause;
      })
      .finally(() => { loadPromise = null; });
    return loadPromise;
  };

  const playFromUser = async () => {
    userPaused = false;
    await load();
    return video.play();
  };

  return {
    load,
    async activate({ autoplay = false } = {}) {
      active = true;
      await load();
      if (autoplay && !userPaused) await video.play().catch(() => {});
    },
    playFromUser,
    deactivate() {
      active = false;
      pauseInternally();
    },
    pauseForVisibility() {
      pauseInternally();
    },
    async retry() {
      controller?.abort();
      video.removeAttribute("src");
      video.load();
      error = null;
      state = "idle";
      return load();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      controller?.abort();
      pauseInternally();
      for (const [name, handler] of [["play", onPlay], ["pause", onPause], ["loadeddata", onLoadedData], ["error", onError]]) {
        video.removeEventListener(name, handler);
      }
      video.removeAttribute("src");
      video.load();
      emit("destroyed");
    },
    snapshot,
  };
}
```

- [ ] **Step 4: Add the test to `npm test` and run it**

Insert `node scripts/share-video-session-test.mjs` immediately before `node scripts/share-viewer-engine-test.mjs` in `package.json`.

Run: `node scripts/share-video-session-test.mjs && npm test`

Expected: the new test prints `share video session checks passed`; the full suite exits 0.

- [ ] **Step 5: Commit the controller**

```powershell
git add public/share-video-session.js scripts/share-video-session-test.mjs package.json
git commit -m "feat: add owned viewer video sessions"
```

### Task 2: Replace preview-video reuse in PhotoSwipe

**Files:**
- Modify: `public/share.js:1-10,1199-1216,1822-1895`
- Modify: `public/style.css:2568-2604,3266-3269`
- Modify: `scripts/share-viewer-test.mjs`

**Interfaces:**
- Consumes: `createVideoSession` from Task 1.
- Produces per-content fields: `_videoSession`, `_video`, `_videoPromise`, and `_videoCleanup`.
- Keeps `getPreviewVideo(file)` exclusive to gallery preview/probing.

- [ ] **Step 1: Add failing no-reuse and lifecycle assertions**

Add to `scripts/share-viewer-test.mjs`:

```js
assert.match(shareJs, /from "\.\/share-video-session\.js"/);
assert.match(shareJs, /document\.createElement\("video"\)/);
assert.match(shareJs, /content\._videoSession/);
assert.match(shareJs, /pauseForVisibility/);
assert.match(shareJs, /video\.playsInline = true/);
assert.match(shareJs, /pswp-video-retry/);
const videoStart = shareJs.indexOf("function registerVideoContent(instance)");
const videoEnd = shareJs.indexOf("\nfunction cleanupTilePreview", videoStart);
const videoContent = shareJs.slice(videoStart, videoEnd);
assert.doesNotMatch(videoContent, /getPreviewVideo\(/, "viewer video must not reuse gallery preview nodes");
assert.doesNotMatch(videoContent, /className = "g-video-preview"/);
```

- [ ] **Step 2: Run the viewer regression test and verify failure**

Run: `node scripts/share-viewer-test.mjs`

Expected: FAIL at the missing `share-video-session.js` import.

- [ ] **Step 3: Render a fresh video and connect session events**

Import `createVideoSession`. Replace `registerVideoContent` with a version that creates a fresh `<video>` and owns its UI:

```js
function registerVideoContent(instance) {
  const sessions = new Set();
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  const pauseHidden = () => {
    if (document.hidden) sessions.forEach((session) => session.pauseForVisibility());
  };
  document.addEventListener("visibilitychange", pauseHidden);
  instance.on("destroy", () => {
    document.removeEventListener("visibilitychange", pauseHidden);
    sessions.forEach((session) => session.destroy());
    sessions.clear();
  });

  instance.on("contentLoad", (event) => {
    const { content } = event;
    if (content.data.type !== "video") return;
    event.preventDefault();
    const file = content.data.file;
    const wrap = document.createElement("div");
    wrap.className = "pswp-video-wrap";
    wrap.dataset.fileId = file.id;
    applyImageTransform(wrap, file);

    const poster = document.createElement("img");
    poster.className = "pswp-video-poster";
    poster.src = file.thumb ? thumbUrl(file, "base") : "";
    poster.alt = "";
    if (poster.src) wrap.appendChild(poster);

    const status = document.createElement("div");
    status.className = "pswp-video-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "Loading video";
    wrap.appendChild(status);

    const video = document.createElement("video");
    video.className = "pswp-video";
    video.controls = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("controlslist", "nodownload");
    wrap.appendChild(video);

    const play = document.createElement("button");
    play.className = "pswp-video-play";
    play.type = "button";
    play.setAttribute("aria-label", `Play ${file.name}`);
    play.innerHTML = icon("play", "pswp-video-play-icon");
    wrap.appendChild(play);

    const retry = document.createElement("button");
    retry.className = "pswp-video-retry hidden";
    retry.type = "button";
    retry.textContent = "Retry video";
    wrap.appendChild(retry);

    const session = createVideoSession({
      video,
      resolveSource: async (signal) => {
        await ensureFreshDownload(file, true, signal);
        return `${file.dl}?inline=1`;
      },
      onState: ({ state, error }) => {
        wrap.dataset.videoState = state;
        poster.classList.toggle("hidden", ["playing", "ready"].includes(state));
        play.classList.toggle("hidden", state === "playing");
        retry.classList.toggle("hidden", state !== "error");
        status.classList.toggle("hidden", !["loading", "error"].includes(state));
        status.textContent = state === "error" ? error?.message || "Video could not be loaded" : "Loading video";
      },
    });
    play.addEventListener("click", () => session.playFromUser().catch(() => {}));
    retry.addEventListener("click", () => session.retry().catch(() => {}));
    for (const type of ["pointerdown", "pointermove", "pointerup", "touchstart", "touchmove", "click"]) {
      video.addEventListener(type, (inputEvent) => inputEvent.stopPropagation(), { passive: type !== "touchmove" });
    }
    content._video = video;
    content._videoSession = session;
    content.element = wrap;
    sessions.add(session);
    void session.load().catch(() => {});
  });

  instance.on("contentActivate", ({ content }) => {
    void content?._videoSession?.activate({ autoplay: finePointer.matches }).catch(() => {});
  });
  instance.on("contentDeactivate", ({ content }) => content?._videoSession?.deactivate());
  instance.on("contentDestroy", ({ content }) => {
    const session = content?._videoSession;
    if (!session) return;
    sessions.delete(session);
    session.destroy();
    content._videoSession = null;
    content._video = null;
  });
}
```

Keep `cleanupTilePreview(file)` for clearing the gallery card's visual state, but do not move or mutate the preview video node.

Replace `.pswp-video-loading` CSS with `.pswp-video-status`, add 64 px central `.pswp-video-play`, a visible retry button, `touch-action: manipulation` on the player, and `[data-video-state="playing"] .pswp-video-poster { opacity: 0; pointer-events: none; }`.

- [ ] **Step 4: Run lifecycle, integration, and full regression tests**

Run: `node scripts/share-video-session-test.mjs && node scripts/share-viewer-test.mjs && npm test`

Expected: all exit 0; no-reuse assertion passes.

- [ ] **Step 5: Commit the dedicated viewer player**

```powershell
git add public/share.js public/style.css scripts/share-viewer-test.mjs
git commit -m "fix: isolate mobile viewer video playback"
```

### Task 3: Measured viewer chrome and persistent compact strip

**Files:**
- Modify: `public/share.js:33-35,1636-1648,1715-1743,2259-2271,2485-2645`
- Modify: `public/style.css:3199-3344,3660-3700`
- Modify: `scripts/share-viewer-test.mjs`

**Interfaces:**
- Produces: `mountViewerChromeMetrics(instance) -> { refresh(), cleanup() }`.
- Maintains numeric `viewerChrome.top` and `viewerChrome.bottom` consumed by PhotoSwipe `paddingFn`.

- [ ] **Step 1: Add failing chrome/strip assertions**

Add to `scripts/share-viewer-test.mjs`:

```js
assert.match(shareJs, /function mountViewerChromeMetrics/);
assert.match(shareJs, /new ResizeObserver/);
assert.match(shareJs, /viewerChrome\.top/);
assert.match(shareJs, /viewerChrome\.bottom/);
assert.match(shareJs, /matchMedia\("\(max-width: 640px\)"\)\.matches \? 3 : 5/);
assert.match(shareCss, /--viewer-bottom-space/);
assert.match(shareCss, /\.pswp \.lb-strip[\s\S]+?touch-action: pan-x/);
```

- [ ] **Step 2: Run the regression test and verify failure**

Run: `node scripts/share-viewer-test.mjs`

Expected: FAIL at `mountViewerChromeMetrics`.

- [ ] **Step 3: Measure top/bottom chrome and use a compact phone default**

Initialize the strip preference with a compact default only when no preference exists:

```js
let stripScale = readScale("lhdb_strip_scale", matchMedia("(max-width: 640px)").matches ? 3 : 5, STRIP_WIDTHS.length);
const viewerChrome = { top: 104, bottom: stripHeightForScale() + 70 };
let viewerChromeMetrics = { refresh: () => {}, cleanup: () => {} };
```

Change PhotoSwipe padding to:

```js
paddingFn: () => ({ top: viewerChrome.top, bottom: viewerChrome.bottom, left: 0, right: 0 }),
```

Add and call the metric owner after `mountBottomBar(pswp)`:

```js
function mountViewerChromeMetrics(instance) {
  const root = instance.element;
  const top = root.querySelector(".pswp__top-bar");
  const bottom = root.querySelector(".pswp-bottom-bar");
  let scheduled = 0;
  const measure = () => {
    scheduled = 0;
    const topRect = top?.getBoundingClientRect();
    const bottomRect = bottom?.getBoundingClientRect();
    viewerChrome.top = Math.ceil(topRect?.height || 56) + 8;
    viewerChrome.bottom = root.classList.contains("pswp-filmstrip-hidden") ? 64 : Math.ceil(bottomRect?.height || stripHeightForScale() + 54) + 8;
    root.style.setProperty("--viewer-top-space", `${viewerChrome.top}px`);
    root.style.setProperty("--viewer-bottom-space", `${viewerChrome.bottom}px`);
    instance.updateSize(true);
  };
  const schedule = () => {
    cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(measure);
  };
  const observer = new ResizeObserver(schedule);
  if (top) observer.observe(top);
  if (bottom) observer.observe(bottom);
  window.addEventListener("orientationchange", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  schedule();
  return {
    refresh: schedule,
    cleanup() {
      cancelAnimationFrame(scheduled);
      observer.disconnect();
      window.removeEventListener("orientationchange", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    },
  };
}
```

Assign `viewerChromeMetrics = mountViewerChromeMetrics(pswp)` once per viewer open. Call `viewerChromeMetrics.refresh()` after filmstrip visibility or strip scale changes. Call `viewerChromeMetrics.cleanup()` only during viewer destruction, then restore the no-op object.

Keep the strip mounted by default when there are at least two items. Preserve `toggleFilmstrip` in advanced settings. Use phone CSS variables `--strip-w: 46px` and `--strip-h: 35px` only as the initial fallback; inline values from the user setting continue to win.

- [ ] **Step 4: Run the viewer regression suite**

Run: `node scripts/share-viewer-test.mjs && npm test`

Expected: exit 0.

- [ ] **Step 5: Commit measured viewer layout**

```powershell
git add public/share.js public/style.css scripts/share-viewer-test.mjs
git commit -m "fix: measure mobile viewer chrome"
```

### Task 4: Immersive phone action dock and advanced sheet

**Files:**
- Modify: `public/share.js:1976-2219,2259-2271`
- Modify: `public/style.css:2675-2992,3199-3344,5692-5751`
- Modify: `scripts/share-viewer-test.mjs`

**Interfaces:**
- Produces DOM classes: `pswp-mobile-dock`, `pswp-mobile-actions`, `pswp-mobile-action`, and `pswp-mobile-more`.
- Produces: `mountMobileViewerControls(instance) -> cleanup()` and `setMobileActionsOpen(open)`.
- Calls existing viewer functions: `rotateCurrentMedia`, `toggleFileInfo`, `downloadFile`, `mountStripSizeControl`, `toggleViewerMotion`, `toggleViewerGuide`, `toggleViewerFullscreen`, `toggleFilmstrip`, and `resetCurrentRotation`.

- [ ] **Step 1: Add failing mobile hierarchy assertions**

Add to `scripts/share-viewer-test.mjs`:

```js
assert.match(shareJs, /function mountMobileViewerControls/);
assert.match(shareJs, /pswp-mobile-dock/);
assert.match(shareJs, /pswp-mobile-actions/);
assert.match(shareJs, /setMobileActionsOpen/);
assert.match(shareCss, /\.pswp-mobile-dock/);
assert.match(shareCss, /min-height:\s*44px/);
assert.match(shareCss, /100dvh/);
```

- [ ] **Step 2: Run the integration test and verify failure**

Run: `node scripts/share-viewer-test.mjs`

Expected: FAIL at `mountMobileViewerControls`.

- [ ] **Step 3: Mount direct actions plus one mutually exclusive sheet**

Factor the existing toolbar download callback into:

```js
function downloadCurrentViewerFile() {
  const file = pswp?.currSlide?.data?.file;
  if (file) downloadFile(file);
}
```

Add `mountMobileViewerControls(instance)`:

```js
function mountMobileViewerControls(instance) {
  const dock = document.createElement("nav");
  dock.className = "pswp-mobile-dock";
  dock.setAttribute("aria-label", "Viewer actions");
  const actions = [
    ["rotate-ccw", "Rotate", () => rotateCurrentMedia(-90)],
    ["file-text", "Details", () => toggleFileInfo(false)],
    ["download", "Save", downloadCurrentViewerFile],
  ];
  for (const [iconName, label, handler] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pswp-mobile-action";
    button.setAttribute("aria-label", label);
    button.innerHTML = `${icon(iconName, "pswp-mobile-action-icon")}<span>${label}</span>`;
    button.addEventListener("click", handler);
    dock.appendChild(button);
  }
  const more = document.createElement("button");
  more.type = "button";
  more.className = "pswp-mobile-action pswp-mobile-more";
  more.setAttribute("aria-label", "More viewer actions");
  more.setAttribute("aria-expanded", "false");
  more.innerHTML = `<b aria-hidden="true">•••</b><span>More</span>`;
  dock.appendChild(more);

  const sheet = document.createElement("section");
  sheet.className = "pswp-mobile-actions";
  sheet.setAttribute("aria-label", "More viewer actions");
  sheet.setAttribute("role", "dialog");
  sheet.tabIndex = -1;
  sheet.hidden = true;
  const sheetActions = [
    ["Rotate right", () => rotateCurrentMedia(90)],
    ["Reset rotation", resetCurrentRotation],
    ["Filmstrip size", () => mountStripSizeControl(instance)],
    ["Show or hide filmstrip", toggleFilmstrip],
    ["Motion settings", () => mountViewerMotionPanel(instance)],
    ["Viewer guide", () => toggleViewerGuide(instance)],
    ["Fullscreen", toggleViewerFullscreen],
  ];
  for (const [label, handler] of sheetActions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => { setMobileActionsOpen(false); handler(); });
    sheet.appendChild(button);
  }
  instance.element.append(dock, sheet);
  mobileViewerDock = dock;
  mobileViewerActions = sheet;
  more.addEventListener("click", () => setMobileActionsOpen(sheet.hidden));
  return () => {
    dock.remove();
    sheet.remove();
    mobileViewerDock = null;
    mobileViewerActions = null;
  };
}

function setMobileActionsOpen(open) {
  if (!mobileViewerActions || !mobileViewerDock) return;
  closeViewerPanels("mobile-actions");
  mobileViewerActions.hidden = !open;
  const more = mobileViewerDock.querySelector(".pswp-mobile-more");
  more?.setAttribute("aria-expanded", String(open));
  if (open) mobileViewerActions.querySelector("button")?.focus();
  else more?.focus({ preventScroll: true });
  syncViewerPanelState();
}
```

Extend `closeViewerPanels` and `hasOpenViewerPanel` to include the mobile sheet. Mount after PhotoSwipe initialization and clean it on destroy.

In the consolidated `@media (max-width: 640px)` viewer block, hide the nonessential desktop toolbar buttons, preserve close/counter/info, and style:

```css
@media (max-width: 640px) {
  .pswp { height: 100vh; height: 100dvh; --viewer-dock-h: 62px; }
  .pswp .pswp__top-bar { min-height: calc(56px + env(safe-area-inset-top)); padding-top: env(safe-area-inset-top); }
  .pswp .pswp__top-bar .pswp__button { width: 44px; height: 44px; }
  .pswp-mobile-dock { position: absolute; left: 0; right: 0; bottom: 0; z-index: 125; min-height: calc(var(--viewer-dock-h) + env(safe-area-inset-bottom)); display: grid; grid-template-columns: repeat(4, 1fr); padding: 5px max(8px, env(safe-area-inset-right)) env(safe-area-inset-bottom) max(8px, env(safe-area-inset-left)); border-top: 1px solid rgba(255,255,255,.12); background: rgba(5,12,22,.92); backdrop-filter: blur(18px); }
  .pswp-mobile-action { min-width: 44px; min-height: 44px; display: grid; place-items: center; gap: 2px; border: 0; border-radius: 11px; color: #edf5ff; background: transparent; }
  .pswp-mobile-action span { font: 700 8px var(--font-mono); }
  .pswp-mobile-action-icon { width: 21px; height: 21px; fill: none; stroke: currentColor; }
  .pswp-mobile-actions { position: absolute; left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right)); bottom: calc(var(--viewer-dock-h) + env(safe-area-inset-bottom) + 8px); z-index: 130; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 7px; max-height: min(62dvh, 520px); overflow: auto; padding: 12px; border-radius: 18px; background: rgba(7,17,31,.97); }
  .pswp-mobile-actions[hidden] { display: none; }
  .pswp-mobile-actions button { min-height: 44px; border: 1px solid rgba(255,255,255,.12); border-radius: 11px; color: #edf5ff; background: rgba(255,255,255,.06); }
  .pswp .pswp-bottom-bar { bottom: calc(var(--viewer-dock-h) + env(safe-area-inset-bottom)); }
  .pswp .lb-strip { padding: 5px 9px 7px; touch-action: pan-x; }
  .pswp .pswp-file-info, .pswp .pswp-guide, .pswp .pswp-strip-settings, .pswp .pswp-motion-settings { position: absolute; top: auto; left: max(6px, env(safe-area-inset-left)); right: max(6px, env(safe-area-inset-right)); bottom: calc(var(--viewer-dock-h) + env(safe-area-inset-bottom) + 8px); width: auto; max-height: min(70dvh, 620px); border-radius: 20px; }
}
```

- [ ] **Step 4: Run tests and phone interaction checks**

Run: `node scripts/share-viewer-test.mjs && npm test`

Expected: both exit 0.

With `npm run dev -- --port 8787`, verify image swipe/zoom, video seek/play, strip drag/click, panel exclusivity, safe-area dock, portrait/landscape, and 44 px targets at 320, 390, 430, 568-by-320, 768, and 1024 widths. Confirm desktop toolbar and shortcuts are unchanged at 1280 px.

- [ ] **Step 5: Commit the mobile viewer hierarchy**

```powershell
git add public/share.js public/style.css scripts/share-viewer-test.mjs
git commit -m "feat: organize mobile viewer controls"
```
