# Plan 04 — Rapid-Surf navigation throttle

**Files touched:** `public/share-viewer-engine.js`, `public/share.js`, `scripts/share-viewer-engine-test.mjs`.
**Depends on:** plan 05 asset-state interfaces may be implemented in the same module first.
**New assets:** `public/share-viewer-engine.js`, `scripts/share-viewer-engine-test.mjs`.

---

### Change 1: Create a deterministic rapid-navigation controller

**File:** `public/share-viewer-engine.js`

**Why:** Frequency/hold behavior must be testable without PhotoSwipe or wall-clock sleeps.

**Locate:** File does not exist.

**Action:** CREATE.

**New code:**

```js
export const RAPID_WINDOW_MS = 500;
export const RAPID_EVENT_COUNT = 4;
export const RAPID_SETTLE_MS = 260;

export function createRapidSurfController(options = {}) {
  const now = options.now || (() => performance.now());
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const onChange = options.onChange || (() => {});
  let events = [];
  let active = false;
  let held = false;
  let settleTimer = 0;

  const setActive = (next, reason) => {
    if (active === next) return;
    active = next;
    onChange({ active, reason });
  };
  const armSettle = (reason) => {
    cancel(settleTimer);
    settleTimer = schedule(() => {
      if (!held) setActive(false, reason);
    }, RAPID_SETTLE_MS);
  };
  return {
    note(reason = "navigation", isHeld = false) {
      const time = now();
      events = events.filter((value) => time - value <= RAPID_WINDOW_MS);
      events.push(time);
      held = held || isHeld;
      if (held || events.length >= RAPID_EVENT_COUNT) setActive(true, held ? "held" : "frequency");
      armSettle("quiet");
      return active;
    },
    release(reason = "release") {
      held = false;
      armSettle(reason);
    },
    cancel(reason = "cancel") {
      held = false;
      events = [];
      cancel(settleTimer);
      settleTimer = 0;
      setActive(false, reason);
    },
    get active() { return active; },
  };
}
```

**Verify:** Four moves in 500 ms enter rapid mode; three do not; a held input enters immediately; release waits 260 ms before settle.

---

### Change 2: Connect keyboard, chevrons, filmstrip, and swipe navigation

**File:** `public/share.js`

**Why:** Rapid mode must cover all ways users can traverse media, not only keyboard repeat events.

**Locate:**

```js
let pswp = null;
let pswpModulePromise = null;
let strip = null;
```

**Action:** INSERT AFTER.

**New code:**

```js
let rapidSurf = false;
let rapidController = null;

function noteRapidNavigation(reason, held = false) {
  rapidController?.note(reason, held);
}

function endRapidNavigation(reason) {
  rapidController?.release(reason);
}

function bindRapidPointer(button, direction) {
  if (!button) return;
  button.addEventListener("pointerdown", () => noteRapidNavigation(`arrow-${direction}`, true));
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    button.addEventListener(type, () => endRapidNavigation(`arrow-${direction}-release`));
  }
}
```

Inside `openViewer()` construct:

```js
  rapidController = createRapidSurfController({
    onChange: ({ active, reason }) => {
      rapidSurf = active;
      pswp?.element?.classList.toggle("pswp-rapid-surf", active);
      viewerAssets.setRapid(active);
      if (!active) promoteActiveSlide(reason);
      updateAssetLadder();
    },
  });
```

After init bind `.pswp__button--arrow--prev` and next. Call `noteRapidNavigation("slide-change")` in the PhotoSwipe change handler, on filmstrip click, and on touch/swipe change. Call `rapidController.cancel("viewer-destroy")` on destroy.

**Verify:** Keyboard hold, pointer hold, click bursts, filmstrip clicks, and swipe bursts feed the same controller; destroy clears timers.

---

### Change 3: Force Base rendering during rapid mode

**File:** `public/share.js`

**Why:** A previously decoded original must not block quick traversal; rapid mode explicitly prioritizes the lightweight tier.

**Locate:**

```js
    const cached = decodedImages.get(file.id);
    if (cached?.complete && cached.naturalWidth) {
      cached.className = "pswp-progressive-full";
```

**Action:** REPLACE the cache condition and branch.

**Old code:**

```js
    const cached = decodedImages.get(file.id);
    if (cached?.complete && cached.naturalWidth) {
      cached.className = "pswp-progressive-full";
      cached.alt = file.name;
      wrap.classList.add("ready", "from-cache");
      wrap.appendChild(cached);
      content._fullImage = cached;
      setProgressiveLoading(content, false);
      return;
    }
```

**New code:**

```js
    const cached = decodedImages.get(file.id);
    if (!rapidSurf && cached?.complete && cached.naturalWidth) {
      cached.className = "pswp-progressive-full";
      cached.alt = file.name;
      wrap.classList.add("ready", "from-cache");
      wrap.appendChild(cached);
      content._fullImage = cached;
      setProgressiveLoading(content, false);
      return;
    }
    if (rapidSurf) {
      appendTierImage(wrap, file, "base", "pswp-progressive-thumb");
      wrap.classList.add("ready", "rapid-preview");
      setProgressiveLoading(content, false);
      return;
    }
```

**Verify:** Rapid slides display Base immediately, do not attach decoded originals, and do not show the generic spinner.

---

### Change 4: Promote only the settled active slide

**File:** `public/share.js`

**Why:** Async completions for traversed slides must never replace the final selected slide or restart neighbor originals.

**Locate:**

```js
function warmNeighbors(index) {
  for (const n of [index - 2, index - 1, index + 1, index + 2]) {
```

**Action:** DELETE the function and replace call sites with active-tier promotion.

**Old code:**

```js
function warmNeighbors(index) {
  for (const n of [index - 2, index - 1, index + 1, index + 2]) {
    const file = lightboxItems[n];
    if (file && /^image\//.test(file.mime)) warmImage(file);
  }
}
```

**New code:**

```js
function promoteActiveSlide(reason = "settled") {
  if (!pswp || rapidSurf) return;
  const index = pswp.currIndex;
  const file = lightboxItems[index];
  if (!file || !/^image\//.test(file.mime)) return;
  viewerAssets.activate(file, { reason }).then(() => {
    if (!pswp || pswp.currIndex !== index || rapidSurf) return;
    pswp.refreshSlideContent(index);
  });
}
```

**Verify:** No neighbor original warming remains; stale promises check the captured index before refreshing; only the final slide promotes after settle.

## Tests

- Use fake time to prove 3/4-event threshold, 500 ms rolling window, held immediate entry, and 260 ms settle.
- Prove rapid rendering ignores decoded Full cache.
- Prove stale slide completion cannot refresh a newer index.
- Prove destroy cancels timers and settle callbacks.

## Responsive and accessibility

- Pointer hold works with mouse, pen, and touch; `pointercancel` always releases.
- Rapid mode has no flashing visual animation; the status ladder changes synchronously.
- Keyboard behavior remains native for focused form controls.

## Placeholder data

Threshold constants are fixed and tested. Do not infer rapid state from image load failures or arbitrary frame timing.
