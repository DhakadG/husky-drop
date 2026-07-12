# Plan 01 — Keyboard shortcuts and toolbar semantics

**Files touched:** `public/share.js`, `public/style.css`, `scripts/share-viewer-test.mjs`.
**Depends on:** plan 00 icon catalog; plan 04 rapid-surf hooks.
**New assets:** none.

---

### Change 1: Centralize viewer shortcut dispatch

**File:** `public/share.js`

**Why:** The current `if/else` block omits the requested Info and ±10 controls and cannot consistently mark rapid Arrow navigation.

**Locate:**

```js
  const onViewerKeydown = (e) => {
    if (e.target instanceof Element && e.target.closest("input, button, select, textarea, [contenteditable]")) return;
    if (e.key === "Home") {
      e.preventDefault();
      pswp.goTo(0);
```

**Action:** REPLACE the complete `onViewerKeydown` function and add the keyup handler.

**Old code:**

```js
  const onViewerKeydown = (e) => {
    if (e.target instanceof Element && e.target.closest("input, button, select, textarea, [contenteditable]")) return;
    if (e.key === "Home") {
      e.preventDefault();
      pswp.goTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      pswp.goTo(lightboxItems.length - 1);
    } else if (e.key === "[") {
      e.preventDefault();
      rotateCurrentImage(-90);
    } else if (e.key === "]") {
      e.preventDefault();
      rotateCurrentImage(90);
    } else if (e.key === "Escape" && hasOpenViewerPanel()) {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeViewerPanels();
    }
  };
```

**New code:**

```js
  const editableTarget = (target) => target instanceof Element && target.closest("input, button, select, textarea, [contenteditable]");
  const goRelative = (amount) => pswp?.goTo(Math.max(0, Math.min(lightboxItems.length - 1, pswp.currIndex + amount)));
  const onViewerKeydown = (event) => {
    if (editableTarget(event.target)) return;
    const key = event.key;
    if (key === "ArrowLeft" || key === "ArrowRight") noteRapidNavigation(event.repeat ? "key-hold" : "key");
    const action = {
      Home: () => pswp.goTo(0),
      End: () => pswp.goTo(lightboxItems.length - 1),
      ",": () => goRelative(-10),
      "<": () => goRelative(-10),
      ".": () => goRelative(10),
      ">": () => goRelative(10),
      "[": () => rotateCurrentMedia(-90),
      "]": () => rotateCurrentMedia(90),
      "0": () => resetCurrentRotation(),
      i: () => toggleFileInfo(false),
      I: () => toggleFileInfo(false),
      p: () => toggleFileInfoPin(),
      P: () => toggleFileInfoPin(),
      t: () => toggleFilmstrip(),
      T: () => toggleFilmstrip(),
      a: () => toggleViewerMotion(),
      A: () => toggleViewerMotion(),
      "?": () => toggleViewerGuide(pswp),
    }[key];
    if (event.shiftKey && key === "ArrowLeft") return event.preventDefault(), goRelative(-10);
    if (event.shiftKey && key === "ArrowRight") return event.preventDefault(), goRelative(10);
    if (key === "Escape" && hasOpenViewerPanel()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeViewerPanels({ forceInfo: true });
      return;
    }
    if (action) {
      event.preventDefault();
      action();
    }
  };
  const onViewerKeyup = (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") endRapidNavigation("key-release");
  };
```

Register and remove both handlers; register keydown in capture mode so rapid state is set before PhotoSwipe changes slides.

```js
  window.addEventListener("keydown", onViewerKeydown, true);
  window.addEventListener("keyup", onViewerKeyup, true);
```

**Verify:** `I` toggles transient metadata; both shifted punctuation forms skip exactly ten and clamp at gallery ends; form controls retain their native keyboard behavior.

---

### Change 2: Expand the in-viewer guide

**File:** `public/share.js`

**Why:** Every shortcut must be discoverable and described in user terms.

**Locate:**

```js
const SHORTCUTS = [
  ["&larr; &rarr;", "Previous / next"],
  ["Home / End", "First / last file"],
```

**Action:** REPLACE.

**Old code:**

```js
const SHORTCUTS = [
  ["&larr; &rarr;", "Previous / next"],
  ["Home / End", "First / last file"],
  ["[ / ]", "Rotate left / right"],
  ["Esc", "Close the active panel, then viewer"],
  ["Scroll wheel or drag", "Browse the filmstrip"],
  ["Shift + hover a tile", "Scrub a video (desktop)"],
  ["Touch + hold a tile", "Scrub a video (touch)"],
];
```

**New code:**

```js
const SHORTCUTS = [
  ["← / →", "Previous / next"],
  ["Shift + ← / →", "Skip 10"],
  [", / .", "Skip 10 left / right"],
  ["Home / End", "First / last file"],
  ["I", "Toggle File info"],
  ["P", "Keep File info open"],
  ["[ / ]", "Rotate left / right"],
  ["0", "Reset rotation"],
  ["T", "Toggle filmstrip"],
  ["A", "Toggle slide effects"],
  ["?", "Open this guide"],
  ["Esc", "Close the active panel, then viewer"],
  ["Wheel / drag", "Browse the filmstrip"],
];
```

**Verify:** The guide has no obsolete behavior and contains every registered shortcut exactly once.

---

### Change 3: Add explicit skip-10 toolbar controls

**File:** `public/share.js`

**Why:** High-volume galleries need discoverable coarse navigation in addition to punctuation shortcuts.

**Locate:**

```js
  instance.on("uiRegister", () => {
    instance.ui.registerElement({
      name: "file-info-button",
```

**Action:** INSERT BEFORE the File info registration.

**New code:**

```js
    for (const [name, order, delta, iconName, title, keys] of [
      ["skip-back-button", 9, -10, "chevrons-left", "Skip back 10", ","],
      ["skip-forward-button", 10, 10, "chevrons-right", "Skip forward 10", "."],
    ]) {
      instance.ui.registerElement({
        name,
        order,
        isButton: true,
        tagName: "button",
        html: { isCustomSVG: true, size: 24, inner: uiIconDefinition(iconName).body, outlineID: `pswp__icn-${name}` },
        onClick: () => instance.goTo(Math.max(0, Math.min(lightboxItems.length - 1, instance.currIndex + delta))),
        onInit: (element) => {
          element.dataset.step = "10";
          element.setAttribute("aria-keyshortcuts", keys);
        },
        title,
      });
    }
```

**Verify:** Buttons clamp at the first/last slide and display a small `10` badge without baking text into the SVG.

---

### Change 4: Style the numeric skip badge and pressed state

**File:** `public/style.css`

**Why:** A chevron alone does not communicate the ten-item jump.

**Locate:**

```css
.pswp .pswp__top-bar .pswp__button:active { transform: scale(0.92); }
```

**Action:** INSERT AFTER.

**New code:**

```css
.pswp .pswp__button[data-step]::after {
  content: attr(data-step);
  position: absolute;
  right: 3px;
  bottom: 3px;
  min-width: 15px;
  height: 15px;
  border: 1px solid rgba(122, 210, 255, 0.36);
  border-radius: 999px;
  color: #ddf7ff;
  background: #173864;
  font: 700 8px/13px var(--font-mono);
  text-align: center;
}
```

**Verify:** The badge remains legible at desktop and mobile widths and does not shrink the 44 px target.

## Tests

- Add behavior assertions for clamp math, both punctuation variants, `I`, `P`, `0`, and editable-target suppression.
- Assert keyup ends rapid state and destroy removes both capture listeners.

## Responsive and accessibility

- Hide skip buttons visually below 420 px only if the shortcut guide remains available; do not remove their keyboard actions.
- Buttons require `aria-keyshortcuts`; the guide is a labelled region and remains focusable/scrollable.
- No shortcut intercepts a focused input, range, select, button, textarea, or contenteditable element.

## Placeholder data

No shortcut labels are decorative. Every listed key must call a real implemented action.
