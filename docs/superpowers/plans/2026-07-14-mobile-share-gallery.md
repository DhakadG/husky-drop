# Mobile Share Gallery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the approved adaptive phone gallery with long-press drag selection while preserving desktop gallery behavior and ordering.

**Architecture:** Move row planning and touch-selection state into two small DOM-free modules that `public/share.js` adapts to the existing gallery and `selected` map. Replace the scattered share-page phone overrides in `public/style.css` with one owned mobile share section; do not create alternate mobile markup.

**Tech Stack:** Browser ES modules, Pointer Events, PhotoSwipe-adjacent share code, CSS media/input queries, Node `assert` regression scripts.

## Global Constraints

- Normal phone rows target two media items; very wide media may occupy a full-width row.
- Normal tap opens the viewer; long-press activates paint-mode selection and drag crosses each tile at most once.
- Movement before the hold remains native page scrolling; active drag supports edge auto-scroll and complete cancellation cleanup.
- Touch/coarse-pointer video scrubbing is removed; desktop fine-pointer hover and Shift scrubbing remain.
- Preserve source/sort order and the current desktop layout.
- Primary touch targets are at least 44 by 44 CSS pixels.
- No unintended document-level horizontal overflow from 320 through 1024 CSS pixels.

---

## File map

- Create `public/share-selection-engine.js`: DOM-free long-press, paint, de-duplication, cancellation, and edge-scroll state machine.
- Create `scripts/share-selection-engine-test.mjs`: deterministic fake-clock tests for the selection controller.
- Create `public/share-gallery-layout.js`: pure justified-row planner shared by phone and desktop rendering.
- Create `scripts/share-gallery-layout-test.mjs`: row ordering, two-up phone, wide-row, and final-row tests.
- Modify `public/share.js`: integrate both modules, remove touch video scrub listeners, expose selection status accessibly, and wire the mobile tools sheet.
- Modify `public/share.html`: add the compact gallery-tools trigger/sheet and selection live region semantics.
- Modify `public/style.css`: replace existing share-specific phone overrides with one consolidated share responsive section.
- Modify `scripts/share-viewer-test.mjs`: enforce integration and prevent touch-scrub regression.
- Modify `package.json`: include both new test scripts in `npm test`.

### Task 1: Long-press drag-selection engine

**Files:**
- Create: `public/share-selection-engine.js`
- Create: `scripts/share-selection-engine-test.mjs`
- Modify: `package.json`

**Interfaces:**
- Produces: `createDragSelectionController(options)`.
- Consumes callbacks: `isSelected(fileId)`, `setSelected(fileId, selected)`, `hitTest(x, y)`, `scrollBy(delta)`, `viewportHeight()`, `capture(pointerId)`, `release(pointerId)`, and optional scheduler/haptic functions.
- Produces methods: `pointerDown({ pointerId, x, y, fileId, capture, release })`, `pointerMove({ pointerId, x, y }) -> boolean`, `pointerUp(pointerId) -> boolean`, `cancel()`, and `isActive() -> boolean`.

- [ ] **Step 1: Write the failing controller tests**

Create `scripts/share-selection-engine-test.mjs` with deterministic scheduling and four behavior checks:

```js
import assert from "node:assert/strict";
import { createDragSelectionController } from "../public/share-selection-engine.js";

const selected = new Set();
const holds = new Map();
const frames = new Map();
let nextId = 1;
let captured = 0;
let released = 0;
let scrolled = 0;
let hit = "a";

const controller = createDragSelectionController({
  holdMs: 420,
  slopPx: 12,
  edgePx: 72,
  maxScrollPx: 18,
  isSelected: (id) => selected.has(id),
  setSelected: (id, on) => on ? selected.add(id) : selected.delete(id),
  hitTest: () => hit,
  scrollBy: (delta) => { scrolled += delta; },
  viewportHeight: () => 800,
  scheduleHold: (fn) => {
    const id = nextId++;
    holds.set(id, () => { holds.delete(id); fn(); });
    return id;
  },
  cancelHold: (id) => holds.delete(id),
  scheduleFrame: (fn) => {
    const id = nextId++;
    frames.set(id, () => { frames.delete(id); fn(); });
    return id;
  },
  cancelFrame: (id) => frames.delete(id),
  vibrate: () => {},
});

const down = (fileId = "a") => controller.pointerDown({
  pointerId: 7,
  x: 40,
  y: 400,
  fileId,
  capture: () => { captured += 1; },
  release: () => { released += 1; },
});

down();
assert.equal(controller.pointerMove({ pointerId: 7, x: 60, y: 400 }), false);
assert.equal(holds.size, 0, "pre-hold movement cancels without selecting");
assert.deepEqual([...selected], []);

down();
[...holds.values()][0]();
assert.equal(controller.isActive(), true);
assert.deepEqual([...selected], ["a"]);
assert.equal(captured, 1);

hit = "b";
assert.equal(controller.pointerMove({ pointerId: 7, x: 80, y: 410 }), true);
assert.deepEqual([...selected].sort(), ["a", "b"]);
controller.pointerMove({ pointerId: 7, x: 82, y: 412 });
assert.deepEqual([...selected].sort(), ["a", "b"], "re-entering a tile does not toggle twice");

controller.pointerMove({ pointerId: 7, x: 82, y: 795 });
assert.equal(frames.size, 1);
[...frames.values()][0]();
assert.ok(scrolled > 0, "bottom-edge drag auto-scrolls downward");
assert.equal(controller.pointerUp(7), true);
assert.equal(controller.isActive(), false);
assert.equal(released, 1);

selected.add("c");
hit = "c";
down("c");
[...holds.values()][0]();
assert.equal(selected.has("c"), false, "starting on selected media creates deselect paint mode");
controller.cancel();

console.log("share selection engine checks passed");
```

- [ ] **Step 2: Run the new test and verify the missing-module failure**

Run: `node scripts/share-selection-engine-test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `public/share-selection-engine.js`.

- [ ] **Step 3: Implement the selection controller**

Create `public/share-selection-engine.js`:

```js
export function createDragSelectionController(options) {
  const {
    holdMs = 420,
    slopPx = 12,
    edgePx = 72,
    maxScrollPx = 18,
    isSelected,
    setSelected,
    hitTest,
    scrollBy,
    viewportHeight,
    scheduleHold = (fn, ms) => setTimeout(fn, ms),
    cancelHold = clearTimeout,
    scheduleFrame = requestAnimationFrame,
    cancelFrame = cancelAnimationFrame,
    vibrate = () => {},
  } = options;

  let pointer = null;
  let holdTimer = 0;
  let frame = 0;
  let active = false;
  let paintSelected = true;
  let processed = new Set();

  const stopHold = () => {
    if (holdTimer) cancelHold(holdTimer);
    holdTimer = 0;
  };

  const stopFrame = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
  };

  const apply = (fileId) => {
    if (!fileId || processed.has(fileId)) return;
    processed.add(fileId);
    setSelected(fileId, paintSelected);
  };

  const paintAtPointer = () => {
    if (pointer) apply(hitTest(pointer.x, pointer.y));
  };

  const scrollDelta = () => {
    if (!pointer) return 0;
    const height = viewportHeight();
    if (pointer.y < edgePx) return -Math.ceil(maxScrollPx * (1 - pointer.y / edgePx));
    if (pointer.y > height - edgePx) return Math.ceil(maxScrollPx * (1 - (height - pointer.y) / edgePx));
    return 0;
  };

  const runFrame = () => {
    frame = 0;
    if (!active) return;
    const delta = scrollDelta();
    if (!delta) return;
    scrollBy(delta);
    paintAtPointer();
    frame = scheduleFrame(runFrame);
  };

  const syncFrame = () => {
    if (!active || !scrollDelta()) return stopFrame();
    if (!frame) frame = scheduleFrame(runFrame);
  };

  const finish = (releaseCapture = true) => {
    const wasActive = active;
    stopHold();
    stopFrame();
    if (releaseCapture && active) pointer?.release?.(pointer.pointerId);
    pointer = null;
    active = false;
    processed = new Set();
    return wasActive;
  };

  const activate = () => {
    holdTimer = 0;
    if (!pointer) return;
    active = true;
    paintSelected = !isSelected(pointer.fileId);
    pointer.capture?.(pointer.pointerId);
    apply(pointer.fileId);
    vibrate(12);
    syncFrame();
  };

  return {
    pointerDown(next) {
      finish();
      pointer = { ...next, startX: next.x, startY: next.y };
      processed = new Set();
      holdTimer = scheduleHold(activate, holdMs);
    },
    pointerMove(next) {
      if (!pointer || next.pointerId !== pointer.pointerId) return false;
      pointer.x = next.x;
      pointer.y = next.y;
      if (!active && Math.hypot(next.x - pointer.startX, next.y - pointer.startY) > slopPx) {
        finish(false);
        return false;
      }
      if (!active) return false;
      paintAtPointer();
      syncFrame();
      return true;
    },
    pointerUp(pointerId) {
      if (!pointer || pointer.pointerId !== pointerId) return false;
      return finish();
    },
    cancel() {
      return finish();
    },
    isActive() {
      return active;
    },
  };
}
```

- [ ] **Step 4: Run the controller test and the existing viewer tests**

Run: `node scripts/share-selection-engine-test.mjs && node scripts/share-viewer-test.mjs`

Expected: both print their `checks passed` messages.

- [ ] **Step 5: Add the test to the suite and commit**

Insert `node scripts/share-selection-engine-test.mjs` immediately before `node scripts/share-viewer-engine-test.mjs` in `package.json`'s `test` script.

Run: `npm test`

Expected: exit 0 and final output includes `KV budget checks passed`.

Commit:

```powershell
git add public/share-selection-engine.js scripts/share-selection-engine-test.mjs package.json
git commit -m "feat: add touch drag selection engine"
```

### Task 2: Integrate long-press selection and remove touch video scrubbing

**Files:**
- Modify: `public/share.js:1-10,42-48,445-506,672-741,831-991,2647-2687`
- Modify: `public/share.html:128-132`
- Modify: `scripts/share-viewer-test.mjs`

**Interfaces:**
- Consumes: `createDragSelectionController` from Task 1.
- Produces: `setSelection(file, fig, on)`, `cancelTouchSelection()`, and an `aria-live` selection summary.

- [ ] **Step 1: Add failing integration assertions**

Append these checks beside the existing selection/viewer assertions in `scripts/share-viewer-test.mjs`:

```js
assert.match(shareJs, /from "\.\/share-selection-engine\.js"/);
assert.match(shareJs, /createDragSelectionController/);
assert.match(shareJs, /function setSelection\(/);
assert.match(shareJs, /document\.elementFromPoint/);
assert.match(shareJs, /navigator\.vibrate/);
assert.match(shareJs, /lostpointercapture/);
assert.doesNotMatch(shareJs, /touchHoldTimer/);
assert.doesNotMatch(shareJs, /touch-scrubbing/);
assert.match(shareHtml, /id="mobile-sel-info"[^>]+aria-live="polite"/);
```

- [ ] **Step 2: Run the regression script and verify failure**

Run: `node scripts/share-viewer-test.mjs`

Expected: FAIL at the missing `share-selection-engine.js` import assertion.

- [ ] **Step 3: Wire the controller to gallery cards**

Import the controller and create one shared instance in `public/share.js`:

```js
import { createDragSelectionController } from "./share-selection-engine.js";

const visibleFiles = new Map();
const touchSelection = createDragSelectionController({
  isSelected: (fileId) => selected.has(fileId),
  setSelected: (fileId, on) => {
    const file = visibleFiles.get(fileId);
    if (file?._el) setSelection(file, file._el, on);
  },
  hitTest: (x, y) => document.elementFromPoint(x, y)?.closest(".g-card")?._file?.id || "",
  scrollBy: (delta) => window.scrollBy(0, delta),
  viewportHeight: () => window.visualViewport?.height || window.innerHeight,
  vibrate: (duration) => navigator.vibrate?.(duration),
});

function cancelTouchSelection() {
  touchSelection.cancel();
  document.body.classList.remove("drag-selecting");
}
```

At the beginning of `render()`, call `cancelTouchSelection()` and `visibleFiles.clear()`. In the file loop, add `visibleFiles.set(file.id, file)` after assigning `file._el`.

Replace `toggleSelect` with explicit state plus the compatibility toggle:

```js
function setSelection(file, fig, on) {
  if (on) selected.set(file.id, file);
  else selected.delete(file.id);
  fig.classList.toggle("selected", on);
  if (on) fx.pop(fig.querySelector(".g-check"));
  document.body.classList.toggle("selecting", selected.size > 0);
  updateSelInfo();
}

function toggleSelect(file, fig) {
  setSelection(file, fig, !selected.has(file.id));
}
```

Inside `card(file)`, add touch-only pointer wiring after the existing click handlers:

```js
fig.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch" || event.target.closest("button, a")) return;
  touchSelection.pointerDown({
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    fileId: file.id,
    capture: (pointerId) => {
      fig.setPointerCapture(pointerId);
      document.body.classList.add("drag-selecting");
    },
    release: (pointerId) => {
      if (fig.hasPointerCapture(pointerId)) fig.releasePointerCapture(pointerId);
      document.body.classList.remove("drag-selecting");
    },
  });
});
fig.addEventListener("pointermove", (event) => {
  if (touchSelection.pointerMove({ pointerId: event.pointerId, x: event.clientX, y: event.clientY })) event.preventDefault();
}, { passive: false });
fig.addEventListener("pointerup", (event) => {
  if (touchSelection.pointerUp(event.pointerId)) event.preventDefault();
}, { passive: false });
fig.addEventListener("pointercancel", cancelTouchSelection);
fig.addEventListener("lostpointercapture", cancelTouchSelection);
```

Delete the entire touch branch in `installHoverPreview`: `touchHoldTimer`, `touchStart`, `touchArmed`, the touch `pointerdown`/`pointermove`, `finishTouch`, and the click-suppression handler. Retain the fine-pointer `canHoverPreview` branch unchanged.

Call `cancelTouchSelection()` before folder navigation, sort rerender, viewer opening, and on `window.blur`.

Add live-region semantics in `public/share.html`:

```html
<span id="mobile-sel-info" aria-live="polite" aria-atomic="true"></span>
```

- [ ] **Step 4: Run behavior and integration tests**

Run: `node scripts/share-selection-engine-test.mjs && node scripts/share-viewer-test.mjs && npm test`

Expected: all commands exit 0; the integration script reports `share viewer regression checks passed`.

- [ ] **Step 5: Commit the integration**

```powershell
git add public/share.js public/share.html scripts/share-viewer-test.mjs
git commit -m "feat: add mobile hold and drag selection"
```

### Task 3: Pure adaptive justified-row planner

**Files:**
- Create: `public/share-gallery-layout.js`
- Create: `scripts/share-gallery-layout-test.mjs`
- Modify: `public/share.js:1219-1267`
- Modify: `package.json`

**Interfaces:**
- Produces: `computeJustifiedRows(items, options) -> Array<{ items: Array<{ id, width, height }>, height }>`.
- Consumes items shaped as `{ id: string, aspect: number }`.

- [ ] **Step 1: Write failing row-planner tests**

Create `scripts/share-gallery-layout-test.mjs`:

```js
import assert from "node:assert/strict";
import { computeJustifiedRows } from "../public/share-gallery-layout.js";

const items = [
  { id: "a", aspect: 1.5 },
  { id: "b", aspect: 0.75 },
  { id: "c", aspect: 2.4 },
  { id: "d", aspect: 1 },
  { id: "e", aspect: 1.2 },
];

const phone = computeJustifiedRows(items, {
  containerWidth: 320,
  gap: 3,
  targetHeight: 150,
  maxItems: 2,
  wideThreshold: 2.2,
});
assert.deepEqual(phone.map((row) => row.items.map((item) => item.id)), [["a", "b"], ["c"], ["d", "e"]]);
assert.equal(phone[1].items[0].width, 320);
assert.ok(phone.every((row) => row.items.every((item) => item.width > 0 && item.height > 0)));

const desktop = computeJustifiedRows(items.slice(0, 4), {
  containerWidth: 1200,
  gap: 3,
  targetHeight: 250,
  maxItems: Infinity,
  wideThreshold: Infinity,
});
assert.deepEqual(desktop.flatMap((row) => row.items.map((item) => item.id)), ["a", "b", "c", "d"]);
assert.ok(desktop.at(-1).height <= 250, "the final row never stretches above its target");

console.log("share gallery layout checks passed");
```

- [ ] **Step 2: Run the test and verify missing-module failure**

Run: `node scripts/share-gallery-layout-test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `public/share-gallery-layout.js`.

- [ ] **Step 3: Implement the row planner and integrate it**

Create `public/share-gallery-layout.js`:

```js
export function computeJustifiedRows(items, options) {
  const { containerWidth, gap, targetHeight, maxItems = Infinity, wideThreshold = Infinity } = options;
  const source = items.map((item) => ({ ...item, aspect: Math.min(2.8, Math.max(0.45, item.aspect || 1)) }));
  const grouped = [];
  let current = [];

  const pushCurrent = () => {
    if (current.length) grouped.push(current);
    current = [];
  };

  for (const item of source) {
    if (item.aspect >= wideThreshold) {
      pushCurrent();
      grouped.push([item]);
      continue;
    }
    current.push(item);
    const sum = current.reduce((total, entry) => total + entry.aspect, 0);
    if (current.length >= maxItems || sum * targetHeight + gap * (current.length - 1) >= containerWidth) pushCurrent();
  }
  pushCurrent();

  return grouped.map((row, index) => {
    const gaps = gap * (row.length - 1);
    const sum = row.reduce((total, item) => total + item.aspect, 0);
    const isLast = index === grouped.length - 1;
    const height = Math.max(1, Math.min((containerWidth - gaps) / sum, isLast ? targetHeight : targetHeight * 1.35));
    const sized = row.map((item) => ({ id: item.id, height: Math.round(height), width: Math.floor(item.aspect * height) }));
    const used = sized.reduce((total, item) => total + item.width, 0) + gaps;
    if (!isLast && sized.length) sized.at(-1).width += containerWidth - used;
    return { height: Math.round(height), items: sized };
  });
}
```

Import it into `public/share.js` and replace `layoutGallery`'s inline row grouping with:

```js
const planned = computeJustifiedRows(
  files.map((file) => ({ id: file.id, aspect: aspectOf(file) })),
  {
    containerWidth: W,
    gap: W <= 640 ? 3 : 2,
    targetHeight: target,
    maxItems: W <= 640 ? 2 : Infinity,
    wideThreshold: W <= 640 ? 2.2 : Infinity,
  },
);
const byId = new Map(files.map((file) => [file.id, file]));
for (const row of planned) {
  for (const item of row.items) {
    const el = byId.get(item.id)?._el;
    if (!el) continue;
    el.style.width = `${item.width}px`;
    el.style.height = `${item.height}px`;
  }
}
```

- [ ] **Step 4: Add the test to `npm test` and run the suite**

Insert `node scripts/share-gallery-layout-test.mjs` immediately after the selection-engine test in `package.json`.

Run: `node scripts/share-gallery-layout-test.mjs && npm test`

Expected: the new script prints `share gallery layout checks passed`; the suite exits 0.

- [ ] **Step 5: Commit the adaptive row planner**

```powershell
git add public/share-gallery-layout.js scripts/share-gallery-layout-test.mjs public/share.js package.json
git commit -m "feat: adapt share rows for phones"
```

### Task 4: Mobile share toolbar, cards, and safe selection bar

**Files:**
- Modify: `public/share.html:87-132`
- Modify: `public/share.js:591-629`
- Modify: `public/style.css:3271-3281,3570-3710,5692-5751`
- Modify: `scripts/share-viewer-test.mjs`

**Interfaces:**
- Produces DOM IDs: `gallery-tools-toggle`, `gallery-tools-sheet`, and `gallery-tools-close`.
- Preserves existing IDs: `tile-size`, `sort`, `select-all`, `select-none`, `sel-info`, `zip-btn`, and `mobile-select-bar`.

- [ ] **Step 1: Add failing source-level layout assertions**

Add to `scripts/share-viewer-test.mjs`:

```js
assert.match(shareHtml, /id="gallery-tools-toggle"/);
assert.match(shareHtml, /id="gallery-tools-sheet"/);
assert.match(shareJs, /function setGalleryToolsOpen/);
assert.match(shareCss, /body\.share-page\.drag-selecting/);
assert.match(shareCss, /@media \(max-width: 640px\)[\s\S]+?\.gallery-tools-sheet/);
assert.match(shareCss, /env\(safe-area-inset-bottom\)/);
```

- [ ] **Step 2: Run the integration test and verify failure**

Run: `node scripts/share-viewer-test.mjs`

Expected: FAIL at `gallery-tools-toggle`.

- [ ] **Step 3: Add one mobile tools sheet and consolidate share phone CSS**

Place a mobile-only trigger beside `sort`, and wrap the existing density/select-all controls in a dialog-like sheet without duplicating the inputs:

```html
<button class="mini gallery-tools-toggle" id="gallery-tools-toggle" type="button" aria-expanded="false" aria-controls="gallery-tools-sheet">Layout &amp; select</button>
<section class="gallery-tools-sheet" id="gallery-tools-sheet" role="dialog" aria-label="Gallery layout and selection tools" tabindex="-1" hidden>
  <header><b>Gallery tools</b><button class="mini" id="gallery-tools-close" type="button" aria-label="Close gallery tools">Close</button></header>
  <div id="gallery-tools-slot"></div>
</section>
```

On initialization, move the existing `#tile-size`, `#select-all`, and `#select-none` into `#gallery-tools-slot` only while `matchMedia("(max-width: 640px)").matches`; restore them before the sort control when leaving the breakpoint. Use one function:

```js
function setGalleryToolsOpen(open) {
  const sheet = $("gallery-tools-sheet");
  const wasOpen = !sheet.hidden;
  sheet.hidden = !open;
  $("gallery-tools-toggle").setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("gallery-tools-open", open);
  if (open) sheet.querySelector("button, input, select")?.focus();
  else if (wasOpen) $("gallery-tools-toggle").focus({ preventScroll: true });
}
```

Wire placement and breakpoint changes without cloning any control:

```js
const galleryToolsMedia = matchMedia("(max-width: 640px)");
function syncGalleryToolsPlacement() {
  const toolbar = $("sort").parentElement;
  const slot = $("gallery-tools-slot");
  if (galleryToolsMedia.matches) {
    slot.append($("tile-size"), $("select-all"), $("select-none"));
  } else {
    setGalleryToolsOpen(false);
    toolbar.insertBefore($("tile-size"), $("sort"));
    toolbar.insertBefore($("select-all"), $("select-none"));
  }
}
$("gallery-tools-toggle").addEventListener("click", () => setGalleryToolsOpen($("gallery-tools-sheet").hidden));
$("gallery-tools-close").addEventListener("click", () => setGalleryToolsOpen(false));
galleryToolsMedia.addEventListener("change", syncGalleryToolsPlacement);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("gallery-tools-sheet").hidden) setGalleryToolsOpen(false);
});
syncGalleryToolsPlacement();
```

Replace the existing share-page phone overrides with one `@media (max-width: 640px)` block that enforces:

```css
@media (max-width: 640px) {
  body.share-page { overflow-x: clip; }
  body.share-page .shell { width: 100%; padding-inline: max(10px, env(safe-area-inset-left)); }
  .share-head { align-items: flex-start; gap: 10px; }
  .share-title, .share-title > div, .meta-row { min-width: 0; }
  .gallery-toolbar { position: sticky; top: max(6px, env(safe-area-inset-top)); z-index: 30; gap: 8px; padding: 9px; }
  .crumbs { flex-wrap: nowrap; overflow-x: auto; scrollbar-width: none; overscroll-behavior-inline: contain; }
  .toolbar-tools { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
  .sort-select, .gallery-tools-toggle { min-height: 44px; }
  .gallery-tools-sheet { position: fixed; left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right)); bottom: max(8px, env(safe-area-inset-bottom)); z-index: 140; max-height: min(70dvh, 560px); overflow: auto; padding: 14px; border-radius: 18px; background: var(--panel); box-shadow: 0 24px 70px rgba(6, 20, 41, .34); }
  .gallery-tools-sheet > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .gallery-tools-sheet .tile-size-control { width: 100%; margin-top: 12px; }
  .g-card { touch-action: pan-y pinch-zoom; }
  body.share-page.drag-selecting { overscroll-behavior-y: contain; user-select: none; }
  body.share-page.drag-selecting .g-card { touch-action: none; }
  .g-card .g-check, .g-card .g-dl { width: 44px; height: 44px; opacity: 1; }
  .g-card figcaption { opacity: 1; min-width: 0; padding: 26px 8px 7px; }
  .mobile-select-bar { left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right)); bottom: max(8px, env(safe-area-inset-bottom)); min-height: 56px; }
}
```

- [ ] **Step 4: Run regression checks at source and suite level**

Run: `node scripts/share-viewer-test.mjs && npm test`

Expected: both exit 0.

Manually run `npm run dev -- --port 8787`, open a populated share, and verify at 320, 390, 430, and 568-by-320 that breadcrumbs scroll locally, the tools sheet is reachable, rows stay ordered, pre-hold swipes scroll, hold-drag paints selection, and the fixed selection bar does not cover the final row.

- [ ] **Step 5: Commit the mobile share surface**

```powershell
git add public/share.html public/share.js public/style.css scripts/share-viewer-test.mjs
git commit -m "feat: organize share gallery for mobile"
```
