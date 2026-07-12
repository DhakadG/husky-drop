# Plan 06 — Ten-cell asset and intent status ladder

**Files touched:** `public/share.js`, `public/style.css`, `public/share-fx.js`, `public/share-viewer-engine.js`, `scripts/share-viewer-engine-test.mjs`.
**Depends on:** plan 05 asset states; plan 00 GSAP helper.
**New assets:** none.

---

### Change 1: Register a toolbar asset-status element

**File:** `public/share.js`

**Why:** Resolution state must remain visible without a blocking spinner or text overlay on the photograph.

**Locate:**

```js
  instance.on("uiRegister", () => {
    instance.ui.registerElement({
      name: "file-info-button",
```

**Action:** INSERT BEFORE File info registration.

**New code:**

```js
    instance.ui.registerElement({
      name: "asset-ladder",
      order: 8,
      isButton: false,
      tagName: "div",
      html: `<span class="pswp-asset-ladder-rail" aria-hidden="true">${Array.from({ length: 9 }, (_, index) => `<i data-intent-step="${index}"></i>`).join("")}</span><i class="pswp-asset-lamp" aria-hidden="true"></i><span class="sr-only pswp-asset-label">Thumbnail status unavailable</span>`,
      onInit: (element) => {
        assetLadderElement = element;
        element.classList.add("pswp-asset-ladder");
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
      },
    });
```

Declare `let assetLadderElement = null;` beside other viewer UI state.

**Verify:** The toolbar contains exactly nine rail cells plus one state lamp and one accessible label.

---

### Change 2: Map engine state to stable LED semantics

**File:** `public/share.js`

**Why:** CSS/GSAP must decorate a single authoritative mapping rather than infer status from DOM loading classes.

**Locate:**

```js
function setProgressiveLoading(content, loading, isError = false) {
  const changed = content._progressiveLoading !== loading;
```

**Action:** INSERT BEFORE.

**New code:**

```js
function assetLampState(state) {
  if (state.error) return { key: "failed", label: `Full preview failed. ${state.tier} remains available.` };
  if (state.loading === "full") return { key: "full-fetching", label: "Full resolution is loading" };
  if (state.intentStep > 0) return { key: "intent", label: `Full-resolution intent ${state.intentStep} of ${state.intentSteps}` };
  if (state.loading === "max") return { key: "max-fetching", label: "Maximum thumbnail is loading" };
  if (state.tier === "full") return { key: "full-ready", label: "Full resolution is ready" };
  if (state.tier === "max") return { key: "max-ready", label: "Maximum thumbnail is ready" };
  if (state.loading === "mid") return { key: "mid-fetching", label: "Medium preview is loading" };
  if (state.tier === "mid") return { key: "mid-ready", label: "Medium preview is ready" };
  if (state.loading === "base") return { key: "base-fetching", label: "Thumbnail is loading" };
  if (state.tier === "base") return { key: "base-ready", label: state.rapid ? "Thumbnail-only rapid browsing" : "Thumbnail is ready" };
  return { key: "empty", label: "Thumbnail is not ready" };
}

function updateAssetLadder(state = viewerAssets?.stateFor(pswp?.currSlide?.data?.file)) {
  if (!assetLadderElement || !state) return;
  const mapped = assetLampState(state);
  assetLadderElement.dataset.state = mapped.key;
  assetLadderElement.dataset.tier = state.tier;
  assetLadderElement.querySelector(".pswp-asset-label").textContent = mapped.label;
  assetLadderElement.querySelectorAll("[data-intent-step]").forEach((cell, index) => {
    cell.classList.toggle("active", index < Math.round((state.intentStep / state.intentSteps) * 9));
  });
  fx.animateViewerLed(assetLadderElement.querySelector(".pswp-asset-lamp"), mapped.key);
}
```

Pass `updateAssetLadder` as the asset engine's `onChange`. Ignore records whose file ID is not the active slide.

**Verify:** State text is truthful without GSAP; stale background records cannot change the active toolbar status.

---

### Change 3: Suppress the generic preloader when a valid tier is visible

**File:** `public/share.js`

**Why:** The PhotoSwipe spinner must not rotate indefinitely over a usable Base/Mid/Max preview.

**Locate:**

```js
function setProgressiveLoading(content, loading, isError = false) {
  const changed = content._progressiveLoading !== loading;
```

**Action:** REPLACE the loading assignment.

**Old code:**

```js
  content._progressiveLoading = loading;
```

**New code:**

```js
  const visibleTier = content.element?.querySelector(".pswp-progressive-thumb, .pswp-progressive-tier, .pswp-progressive-full");
  content._progressiveLoading = Boolean(loading && !visibleTier);
```

**Verify:** `.pswp__preloader--active` is absent whenever a visible tier has loaded; the LED lamp communicates background promotion.

---

### Change 4: Style the camera-recorder status rail

**File:** `public/style.css`

**Why:** The ladder must be subtle, legible, compact, and consistent with the blue/teal viewer palette.

**Locate:**

```css
.pswp .pswp__counter {
  position: absolute;
```

**Action:** INSERT BEFORE.

**New code:**

```css
.pswp .pswp-asset-ladder {
  align-self: center;
  height: 30px;
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 6px;
  border: 1px solid rgba(119, 170, 255, 0.16);
  border-radius: 999px;
  padding: 0 9px;
  background: rgba(4, 12, 24, 0.64);
  backdrop-filter: blur(12px);
}
.pswp .pswp-asset-ladder-rail { display: flex; gap: 3px; }
.pswp .pswp-asset-ladder-rail i,
.pswp .pswp-asset-lamp {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: rgba(189, 203, 224, 0.2);
  box-shadow: none;
}
.pswp .pswp-asset-ladder-rail i.active {
  background: #60a9ff;
  box-shadow: 0 0 7px rgba(67, 146, 255, 0.72);
}
.pswp .pswp-asset-lamp { width: 8px; height: 8px; }
.pswp .pswp-asset-ladder[data-state="base-fetching"] .pswp-asset-lamp,
.pswp .pswp-asset-ladder[data-state="base-ready"] .pswp-asset-lamp { background: #f4f8ff; box-shadow: 0 0 8px rgba(244, 248, 255, 0.65); }
.pswp .pswp-asset-ladder[data-state="mid-fetching"] .pswp-asset-lamp,
.pswp .pswp-asset-ladder[data-state="mid-ready"] .pswp-asset-lamp { background: #ffd95c; box-shadow: 0 0 9px rgba(255, 217, 92, 0.65); }
.pswp .pswp-asset-ladder[data-state="max-fetching"] .pswp-asset-lamp,
.pswp .pswp-asset-ladder[data-state="max-ready"] .pswp-asset-lamp { background: #ff9d45; box-shadow: 0 0 10px rgba(255, 133, 55, 0.72); }
.pswp .pswp-asset-ladder[data-state="intent"] .pswp-asset-lamp,
.pswp .pswp-asset-ladder[data-state="full-fetching"] .pswp-asset-lamp { background: #5ea8ff; animation: pswpAssetPulse 680ms ease-in-out infinite alternate; }
.pswp .pswp-asset-ladder[data-state="full-ready"] .pswp-asset-lamp { background: #57e3af; box-shadow: 0 0 11px rgba(69, 229, 174, 0.78); }
.pswp .pswp-asset-ladder[data-state="failed"] .pswp-asset-lamp { background: #ff657a; box-shadow: 0 0 9px rgba(255, 81, 111, 0.65); }
@keyframes pswpAssetPulse { from { opacity: 0.45; transform: scale(0.78); } to { opacity: 1; transform: scale(1.16); } }
```

**Verify:** Grey/white/yellow/orange/blue/green/red states are visually distinct; no cell changes layout.

## Tests

- Unit-test every `assetLampState()` mapping and all six intent steps.
- Assert the final cell remains blue while Full fetches and turns green only after decode.
- Assert lower-tier failures keep last-ready tier and produce red only for terminal Full failure.
- Assert the preloader deactivates when any usable image tier is present.

## Responsive and accessibility

- Below 520 px collapse the nine rail cells behind the state lamp, but keep the accessible label.
- `role=status` and `aria-live=polite` announce only state changes; do not announce every animation frame.
- Reduced motion removes pulsing/GSAP while preserving solid colors and text.

## Placeholder data

The rail is a dwell/status indicator, not byte-level progress unless an actual streamed byte count is available. Never fake download percentage.
