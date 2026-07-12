# Plan 07 — Optional PhotoSwipe transition engine

**Files touched:** `public/share.js`, `public/share-fx.js`, `public/style.css`, `scripts/share-viewer-test.mjs`.
**Depends on:** plan 00 motion helper; plan 04 rapid-surf state.
**New assets:** none.

---

### Change 1: Add versioned transition preferences with Immediate default

**File:** `public/share.js`

**Why:** Effects must be explicitly opt-in, persistent, bounded, and bypassed during rapid browsing.

**Locate:**

```js
const STRIP_SCALE_KEY = "husky-share-filmstrip-scale-v1";
const STRIP_WIDTHS = [34, 42, 52, 64, 76, 90, 106, 124, 142, 160, 178, 198, 216];
```

**Action:** INSERT AFTER.

**New code:**

```js
const VIEWER_MOTION_KEY = "husky-share-viewer-motion-v1";
const VIEWER_MOTION_MODES = Object.freeze([
  ["fade", "Fade"],
  ["soft-zoom", "Soft zoom"],
  ["zoom-in", "Zoom in"],
  ["zoom-out", "Zoom out"],
  ["scale-up", "Scale up"],
  ["slide-vertical", "Slide vertical"],
  ["skew", "Skew"],
  ["rotate", "Rotate"],
  ["film-cut", "Film cut"],
]);
let viewerMotion = loadViewerMotion();

function loadViewerMotion() {
  try {
    const stored = JSON.parse(localStorage.getItem(VIEWER_MOTION_KEY) || "{}");
    const mode = VIEWER_MOTION_MODES.some(([value]) => value === stored.mode) ? stored.mode : "fade";
    return { enabled: stored.enabled === true, mode, speed: Math.max(80, Math.min(700, Number(stored.speed) || 180)) };
  } catch {
    return { enabled: false, mode: "fade", speed: 180 };
  }
}

function saveViewerMotion() {
  localStorage.setItem(VIEWER_MOTION_KEY, JSON.stringify(viewerMotion));
}
```

**Verify:** First visit is Immediate/Off; invalid storage values are ignored; speed is clamped.

---

### Change 2: Add a top-toolbar motion settings button and panel

**File:** `public/share.js`

**Why:** Visitors need a clear toggle, named mode, and speed control without replacing the existing filmstrip control.

**Locate:**

```js
let viewerGuidePanel = null;
let stripSettingsPanel = null;
```

**Action:** INSERT AFTER and register the toolbar button after filmstrip settings.

**New code:**

```js
let viewerMotionPanel = null;

function closeViewerMotionPanel() {
  viewerMotionPanel?.remove();
  viewerMotionPanel = null;
}

function toggleViewerMotion() {
  viewerMotion.enabled = !viewerMotion.enabled;
  saveViewerMotion();
  syncViewerMotionUi();
}

function mountViewerMotionPanel(instance) {
  if (viewerMotionPanel) return closeViewerPanels();
  closeViewerPanels({ except: "motion" });
  const panel = document.createElement("section");
  panel.className = "pswp-motion-settings";
  panel.setAttribute("aria-label", "Slide effects");
  panel.innerHTML = `<header><div><span>Viewer motion</span><b>Slide effects</b></div><button type="button" aria-label="Close slide effects">×</button></header><label class="pswp-motion-toggle"><input type="checkbox" ${viewerMotion.enabled ? "checked" : ""}><span><b>Animate slide changes</b><small>Immediate remains fastest</small></span></label><label><span>Effect</span><select>${VIEWER_MOTION_MODES.map(([value, label]) => `<option value="${value}" ${viewerMotion.mode === value ? "selected" : ""}>${label}</option>`).join("")}</select></label><label><span>Speed <output>${viewerMotion.speed} ms</output></span><input type="range" min="80" max="700" step="20" value="${viewerMotion.speed}"></label>`;
  panel.querySelector("header button").addEventListener("click", () => closeViewerPanels());
  panel.querySelector('input[type="checkbox"]').addEventListener("change", (event) => { viewerMotion.enabled = event.target.checked; saveViewerMotion(); syncViewerMotionUi(); });
  panel.querySelector("select").addEventListener("change", (event) => { viewerMotion.mode = event.target.value; saveViewerMotion(); });
  const range = panel.querySelector('input[type="range"]');
  range.addEventListener("keydown", (event) => event.stopPropagation());
  range.addEventListener("input", () => { viewerMotion.speed = Number(range.value); panel.querySelector("output").textContent = `${range.value} ms`; saveViewerMotion(); });
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
  instance.element.appendChild(panel);
  viewerMotionPanel = panel;
  syncViewerPanelState();
}
```

Toolbar registration:

```js
    instance.ui.registerElement({
      name: "motion-settings-button",
      order: 15,
      isButton: true,
      tagName: "button",
      html: { isCustomSVG: true, size: 24, inner: uiIconDefinition("wand-sparkles").body, outlineID: "pswp__icn-motion-settings" },
      onClick: () => mountViewerMotionPanel(instance),
      onInit: (element) => {
        viewerMotionButton = element;
        element.setAttribute("aria-keyshortcuts", "A");
      },
      title: "Slide effects",
    });
```

**Verify:** Toggle, select, and slider persist; opening the panel closes the guide/filmstrip panel; range keys do not navigate slides.

---

### Change 3: Apply effects only to active media content

**File:** `public/share.js`

**Why:** PhotoSwipe's slide transform owns pan/zoom and must remain untouched.

**Locate:**

```js
  pswp.on("change", () => {
    closeViewerPanels();
    const current = lightboxItems[pswp.currIndex];
```

**Action:** INSERT after active-slide promotion.

**New code:**

```js
    queueMicrotask(() => {
      if (!viewerMotion.enabled || rapidSurf || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const element = pswp?.currSlide?.content?.element;
      fx.animateViewerTransition(element, viewerMotion.mode, viewerMotion.speed);
    });
```

Also call the same guard in image/video `contentLoad` when content is created after the change event.

**Verify:** The effect animates only the active `.pswp-progressive-wrap` or `.pswp-video-wrap`; rapid mode, Immediate, and reduced motion bypass it.

---

### Change 4: Style the motion panel and active toolbar state

**File:** `public/style.css`

**Why:** Motion controls should match the modern filmstrip panel and make “Off” obvious.

**Locate:**

```css
.pswp .pswp-guide,
.pswp .pswp-strip-settings {
  position: absolute;
```

**Action:** ADD `.pswp .pswp-motion-settings` to the shared selector and INSERT specific form styles.

**New code:**

```css
.pswp .pswp-motion-settings {
  width: min(360px, calc(100vw - 24px));
  padding: 0 16px 16px;
}
.pswp .pswp-motion-settings > label {
  display: grid;
  gap: 8px;
  margin-top: 14px;
  color: rgba(226, 238, 255, 0.76);
  font: 600 11px var(--font-body);
}
.pswp .pswp-motion-settings label > span { display: flex; justify-content: space-between; gap: 12px; }
.pswp .pswp-motion-settings select,
.pswp .pswp-motion-settings input[type="range"] { width: 100%; accent-color: #43c9d0; }
.pswp .pswp-motion-settings select {
  border: 1px solid rgba(120, 174, 255, 0.22);
  border-radius: 11px;
  padding: 10px 12px;
  color: #edf5ff;
  background: #0b1830;
}
.pswp .pswp-motion-toggle { grid-template-columns: auto 1fr; align-items: center; }
.pswp .pswp-motion-toggle small { display: block; color: rgba(209, 224, 246, 0.54); }
```

**Verify:** Panel does not cover the pinned EXIF controls; active motion button uses `aria-pressed=true`; mobile inputs remain usable.

## Tests

- Assert default Off/180 ms/Fade, storage validation, and speed clamping.
- Assert rapid and reduced-motion suppress every mode.
- Assert all nine mode names map to a real GSAP preset.
- Assert range keyboard events do not trigger viewer shortcuts.

## Responsive and accessibility

- All form controls have visible labels and focus states.
- `A` toggles enabled state without opening the panel; toolbar click opens settings.
- Reduced motion always bypasses effects even if stored enabled.

## Placeholder data

These are Husky Drop effects inspired by lightGallery names and implemented on PhotoSwipe. Do not claim direct lightGallery integration or copy its CSS.
