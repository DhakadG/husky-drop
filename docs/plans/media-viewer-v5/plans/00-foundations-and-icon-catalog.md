# Plan 00 — Foundations and Lucide icon catalog

**Files touched:** `public/public.js`, `public/share-fx.js`, `public/style.css`.
**Depends on:** none.
**New assets:** no runtime dependency; exact SVG geometry is vendored from Lucide under ISC/MIT and attributed in source.

---

### Change 1: Add the open-source viewer icon subset

**File:** `public/public.js`

**Why:** Viewer controls currently mix hand-authored glyphs with PhotoSwipe defaults. A single attributed subset prevents drift and meets the requirement to use high-quality open-source icons.

**Locate:**

```js
const UI_ICONS = {
  list: { mode: "stroke", body: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"></path>' },
```

**Action:** INSERT AFTER the opening line.

**New code:**

```js
  // Viewer subset copied from Lucide Icons (ISC; Aperture is Feather/MIT).
  // Source: https://github.com/lucide-icons/lucide/tree/main/icons
  "file-text": { mode: "stroke", body: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"></path><path d="M14 2v5a1 1 0 0 0 1 1h5"></path><path d="M10 9H8M16 13H8M16 17H8"></path>' },
  "circle-help": { mode: "stroke", body: '<circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 1 1 5.83 1c0 2-3 2-3 4"></path><path d="M12 18h.01"></path>' },
  "gallery-horizontal-end": { mode: "stroke", body: '<path d="M2 7v10M6 5v14"></path><rect width="12" height="18" x="10" y="3" rx="2"></rect>' },
  "rotate-ccw": { mode: "stroke", body: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path>' },
  "rotate-cw": { mode: "stroke", body: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path><path d="M21 3v5h-5"></path>' },
  pin: { mode: "stroke", body: '<path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path>' },
  "pin-off": { mode: "stroke", body: '<path d="M12 17v5M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89M2 2l20 20M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11"></path>' },
  aperture: { mode: "stroke", body: '<circle cx="12" cy="12" r="10"></circle><path d="m14.31 8 5.74 9.94M9.69 8h11.48M7.38 12l5.74-9.94M9.69 16 3.95 6.06M14.31 16H2.83M16.62 12l-5.74 9.94"></path>' },
  timer: { mode: "stroke", body: '<path d="M10 2h4M12 14l3-3"></path><circle cx="12" cy="14" r="8"></circle>' },
  gauge: { mode: "stroke", body: '<path d="m12 14 4-4M3.34 19a10 10 0 1 1 17.32 0"></path>' },
  "wand-sparkles": { mode: "stroke", body: '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72M14 7l3 3M5 6v4M19 14v4M10 2v2M7 8H3M21 16h-4M11 3H9"></path>' },
  "chevrons-left": { mode: "stroke", body: '<path d="m11 17-5-5 5-5M18 17l-5-5 5-5"></path>' },
  "chevrons-right": { mode: "stroke", body: '<path d="m6 17 5-5-5-5M13 17l5-5-5-5"></path>' },
```

**Verify:** Every new definition names Lucide in the adjacent attribution; `uiIcon("timer")`, `uiIcon("aperture")`, and `uiIcon("gauge")` return 24×24 stroke icons without a network request.

---

### Change 2: Expose icon geometry to PhotoSwipe registration

**File:** `public/public.js`

**Why:** PhotoSwipe needs the inner SVG geometry, while normal DOM views need the complete `<svg>`.

**Locate:**

```js
function uiIcon(name, className = "ico") {
  const definition = UI_ICONS[name];
  if (!definition) throw new Error(`Unknown icon: ${name}`);
```

**Action:** INSERT BEFORE.

**New code:**

```js
function uiIconDefinition(name) {
  const definition = UI_ICONS[name];
  if (!definition) throw new Error(`Unknown icon: ${name}`);
  return definition;
}
```

**Verify:** `uiIconDefinition("rotate-cw").body` is usable as PhotoSwipe `html.inner` and unknown names throw.

---

### Change 3: Add viewer-specific GSAP effects with static fallbacks

**File:** `public/share-fx.js`

**Why:** LED, rotation, and optional transition effects need one motion boundary that already respects the locally bundled GSAP and reduced-motion preference.

**Locate:**

```js
  window.shareFx = {
    revealHeader,
    revealNewCards,
```

**Action:** INSERT BEFORE, then add the functions to `window.shareFx`.

**New code:**

```js
  function animateViewerLed(element, state) {
    if (!element || reduced || !hasGsap) return;
    gsap.killTweensOf(element);
    if (/fetching|intent/.test(state)) {
      gsap.fromTo(element, { scale: 0.72, opacity: 0.45 }, { scale: 1, opacity: 1, duration: 0.24, ease: "back.out(2)" });
    } else {
      gsap.fromTo(element, { scale: 0.82 }, { scale: 1, duration: 0.14, ease: "power2.out" });
    }
  }

  function animateViewerRotation(element, delta, complete) {
    if (!element || reduced || !hasGsap) return complete?.();
    gsap.killTweensOf(element);
    gsap.fromTo(element, { rotate: 0 }, { rotate: delta, duration: 0.14, ease: "power2.inOut", onComplete: complete });
  }

  function animateViewerTransition(element, mode, speed) {
    if (!element || reduced || !hasGsap || mode === "immediate") return;
    const duration = Math.max(0.08, Math.min(0.7, Number(speed) / 1000));
    const presets = {
      fade: [{ opacity: 0 }, { opacity: 1 }],
      "soft-zoom": [{ opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1 }],
      "zoom-in": [{ opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1 }],
      "zoom-out": [{ opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1 }],
      "scale-up": [{ opacity: 0, scale: 0.78 }, { opacity: 1, scale: 1 }],
      "slide-vertical": [{ opacity: 0, y: 22 }, { opacity: 1, y: 0 }],
      skew: [{ opacity: 0, skewX: 4, x: 16 }, { opacity: 1, skewX: 0, x: 0 }],
      rotate: [{ opacity: 0, rotate: -2, scale: 0.96 }, { opacity: 1, rotate: 0, scale: 1 }],
      "film-cut": [{ opacity: 0, filter: "brightness(1.45) contrast(0.9)" }, { opacity: 1, filter: "brightness(1) contrast(1)" }],
    };
    const preset = presets[mode] || presets.fade;
    gsap.killTweensOf(element);
    gsap.fromTo(element, preset[0], { ...preset[1], duration, ease: "power2.out", clearProps: "transform,opacity,filter" });
  }
```

Add these keys inside `window.shareFx`:

```js
    animateViewerLed,
    animateViewerRotation,
    animateViewerTransition,
```

**Verify:** With GSAP unavailable or reduced motion enabled, all functions return without leaving partial inline transforms; otherwise every timeline is ≤700 ms.

---

### Change 4: Make enabled toolbar controls visually actionable

**File:** `public/style.css`

**Why:** The current uniform grey toolbar reads as disabled and lacks grouped hit areas, focus feedback, and press motion.

**Locate:**

```css
.pswp .pswp__top-bar .pswp__button {
  width: 48px;
  height: 56px;
}
```

**Action:** REPLACE.

**Old code:**

```css
.pswp .pswp__top-bar .pswp__button {
  width: 48px;
  height: 56px;
}
```

**New code:**

```css
.pswp .pswp__top-bar .pswp__button {
  width: 44px;
  height: 44px;
  margin: 6px 2px;
  border: 1px solid transparent;
  border-radius: 13px;
  color: rgba(244, 249, 255, 0.94);
  opacity: 1;
  cursor: pointer;
  transition: color 120ms ease, background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 120ms ease;
}
.pswp .pswp__top-bar .pswp__button:hover,
.pswp .pswp__top-bar .pswp__button[aria-pressed="true"] {
  color: #8ff6ef;
  border-color: rgba(80, 194, 255, 0.3);
  background: rgba(48, 111, 255, 0.16);
  box-shadow: 0 10px 28px -18px rgba(49, 149, 255, 0.9);
}
.pswp .pswp__top-bar .pswp__button:active { transform: scale(0.92); }
.pswp .pswp__top-bar .pswp__button:focus-visible {
  outline: 2px solid #7fc8ff;
  outline-offset: 2px;
}
.pswp .pswp__top-bar .pswp__button:disabled,
.pswp .pswp__top-bar .pswp__button[aria-disabled="true"] {
  color: rgba(219, 229, 244, 0.42);
  opacity: 1;
  cursor: not-allowed;
  box-shadow: none;
}
```

**Verify:** Enabled icons render near-white at rest and blue/teal on hover; disabled controls remain visually distinct; mouse hit areas are at least 44 px; keyboard focus is visible.

## Tests

- Extend `scripts/icon-audit-test.mjs` to assert the Lucide attribution and every viewer icon name.
- Extend `scripts/share-viewer-test.mjs` to assert the three viewer motion functions and reduced-motion guard.

## Responsive and accessibility

- At ≤640 px keep the same 44 px targets and allow the counter to occupy the second toolbar row.
- All icon-only buttons require an `aria-label`, `title`, and keyboard shortcut metadata where applicable.
- The CSS transition block must be disabled by the existing reduced-motion media rule.

## Placeholder data

No icon is synthesized or approximated. Geometry comes from Lucide's repository and remains source-attributed.
