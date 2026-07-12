# Plan 03 — Rotation state, feedback, status, and reset

**Files touched:** `public/share.js`, `public/style.css`, `public/share-fx.js`, `scripts/share-viewer-test.mjs`.
**Depends on:** plan 00 motion/icon foundations; plan 05 asset cache.
**New assets:** Lucide RotateCcw and RotateCw from plan 00.

---

### Change 1: Normalize rotation through one state helper

**File:** `public/share.js`

**Why:** Rotation math, data dimensions, the toolbar badge, and renderer classes must never disagree.

**Locate:**

```js
function applyImageTransform(wrap, file) {
  const transform = viewerTransforms.get(file.id) || { rotation: 0 };
```

**Action:** INSERT BEFORE.

**New code:**

```js
function rotationFor(file) {
  return ((Number(viewerTransforms.get(file?.id)?.rotation) || 0) % 360 + 360) % 360;
}

function setRotation(file, rotation) {
  const normalized = ((Number(rotation) || 0) % 360 + 360) % 360;
  if (normalized) viewerTransforms.set(file.id, { rotation: normalized });
  else viewerTransforms.delete(file.id);
  return normalized;
}
```

Replace direct map reads in `pswpItem()` and `applyImageTransform()` with `rotationFor(file)`.

**Verify:** `-90`, `270`, and `630` normalize to `270`; zero removes the map entry.

---

### Change 2: Rotate images and videos with fast directional feedback

**File:** `public/share.js`

**Why:** Current rotation refreshes abruptly, supports only images, and provides no visual explanation.

**Locate:**

```js
function rotateCurrentImage(delta) {
  const file = pswp?.currSlide?.data?.file;
  if (!file || !/^image\//.test(file.mime)) return;
```

**Action:** REPLACE.

**Old code:**

```js
function rotateCurrentImage(delta) {
  const file = pswp?.currSlide?.data?.file;
  if (!file || !/^image\//.test(file.mime)) return;
  closeViewerPanels();
  const current = viewerTransforms.get(file.id) || { rotation: 0 };
  const rotation = ((current.rotation + delta) % 360 + 360) % 360;
  viewerTransforms.set(file.id, { ...current, rotation });
  pswp.options.dataSource[pswp.currIndex] = pswpItem(file);
  pswp.refreshSlideContent(pswp.currIndex);
  trackEvent("image_rotate", `${rotation}°`, { file: file.name, direction: delta < 0 ? "left" : "right" });
}
```

**New code:**

```js
function rotateCurrentMedia(delta) {
  const file = pswp?.currSlide?.data?.file;
  if (!file || !/^(image|video)\//.test(file.mime)) return;
  closeViewerPanels();
  const rotation = setRotation(file, rotationFor(file) + delta);
  const element = pswp.currSlide?.content?.element;
  const finish = () => {
    pswp.options.dataSource[pswp.currIndex] = pswpItem(file);
    pswp.refreshSlideContent(pswp.currIndex);
    syncRotationUi();
  };
  if (element) fx.animateViewerRotation(element, delta, finish);
  else finish();
  trackEvent("media_rotate", `${rotation}°`, { file: file.name, direction: delta < 0 ? "left" : "right", mime: file.mime });
}

function resetCurrentRotation() {
  const file = pswp?.currSlide?.data?.file;
  if (!file || rotationFor(file) === 0) return;
  const delta = rotationFor(file) > 180 ? 360 - rotationFor(file) : -rotationFor(file);
  setRotation(file, 0);
  const finish = () => {
    pswp.options.dataSource[pswp.currIndex] = pswpItem(file);
    pswp.refreshSlideContent(pswp.currIndex);
    syncRotationUi();
  };
  fx.animateViewerRotation(pswp.currSlide?.content?.element, delta, finish);
  trackEvent("media_rotation_reset", file.name, { mime: file.mime });
}
```

**Verify:** Images and videos rotate in 90° steps; feedback completes in 140 ms; reset returns to 0; telemetry does not claim a download.

---

### Change 3: Add contextual angle and reset controls

**File:** `public/share.js`

**Why:** Users need to know current orientation; a disabled always-visible reset would add noise.

**Locate:**

```js
function registerUi(instance) {
  const rotateButtons = [];
```

**Action:** INSERT state variables after the opening and register elements after rotate-right.

**New code:**

```js
let syncRotationUi = () => {};

function registerUi(instance) {
  let rotationStatus = null;
  let rotationReset = null;
  syncRotationUi = () => {
    const file = instance.currSlide?.data?.file;
    const rotation = rotationFor(file);
    const show = /^(image|video)\//.test(file?.mime || "") && rotation !== 0;
    if (rotationStatus) {
      rotationStatus.hidden = !show;
      rotationStatus.textContent = `${rotation}°`;
    }
    if (rotationReset) rotationReset.hidden = !show;
  };
```

```js
    instance.ui.registerElement({
      name: "rotation-status",
      order: 17,
      isButton: false,
      tagName: "span",
      html: "0°",
      onInit: (element) => {
        rotationStatus = element;
        element.classList.add("pswp-rotation-status");
        element.hidden = true;
      },
    });
    instance.ui.registerElement({
      name: "rotation-reset-button",
      order: 18,
      isButton: true,
      tagName: "button",
      html: { isCustomSVG: true, size: 24, inner: uiIconDefinition("rotate-ccw").body, outlineID: "pswp__icn-rotation-reset" },
      onClick: resetCurrentRotation,
      onInit: (element) => {
        rotationReset = element;
        element.hidden = true;
        element.setAttribute("aria-keyshortcuts", "0");
      },
      title: "Reset rotation",
    });
```

Call `syncRotationUi()` on change, after init, rotate completion, and reset completion. On viewer destroy reset it with `syncRotationUi = () => {};` so a later call cannot retain old DOM references.

**Verify:** Status/reset are absent at 0° and immediately appear at 90°/180°/270° for the active file only.

---

### Change 4: Style rotation feedback and contextual cluster

**File:** `public/style.css`

**Why:** The angle must read as status rather than another button.

**Locate:**

```css
.pswp .pswp__counter {
  position: absolute;
```

**Action:** INSERT BEFORE.

**New code:**

```css
.pswp .pswp-rotation-status {
  align-self: center;
  min-width: 39px;
  margin: 0 2px;
  border: 1px solid rgba(73, 214, 205, 0.28);
  border-radius: 999px;
  padding: 5px 8px;
  color: #a4f5ed;
  background: rgba(31, 156, 176, 0.13);
  font: 700 10px var(--font-mono);
  text-align: center;
}
.pswp .pswp-rotation-status[hidden],
.pswp .pswp__button--rotation-reset-button[hidden] { display: none; }
```

Update `.pswp-progressive-thumb`, `.pswp-progressive-full`, `.pswp-video` with a 140 ms rotate transition only when `.pswp-rotating` is applied; reduced motion sets it to none.

**Verify:** Rotation feedback is visible but never delays more than 140 ms; the contextual cluster does not shift the centered counter.

## Tests

- Unit-test normalization and contextual visibility for 0/90/180/270.
- Assert video MIME types are supported.
- Assert state is per-file and switching back restores the angle.
- Assert reduced-motion calls completion synchronously.

## Responsive and accessibility

- On narrow screens, the angle chip may move to the second toolbar row but never obscure Close.
- Reset has `aria-keyshortcuts="0"`; angle status uses plain text readable by assistive technology.
- Never animate longer than 160 ms; reduced motion skips the GSAP turn.

## Placeholder data

The angle is derived from the actual per-file transform state; it is never a decorative sample.
