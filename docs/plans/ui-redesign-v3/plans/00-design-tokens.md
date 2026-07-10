# Plan 00 — Design tokens & shared UI 3.0 components

**Files touched:** `public/style.css` only.
**Depends on:** nothing (all other plans depend on this one).
**New assets:** none (all icons are inline SVG; logo is pure CSS/HTML).

The current `style.css` (UI 2.0) already defines the right palette and fonts. This plan (a) retunes the shared tokens/gradients to the mockup values, (b) upgrades the background to the mockup recipe (2 blobs → 3 blobs + dot grid + noise via a new `.bg-fx` element), (c) upgrades the logo droplet, (d) makes primary buttons gradient pills, and (e) appends the shared UI 3.0 component classes every page plan uses.

At the end are two **Canonical shared blocks** (§A logo markup, §B `.bg-fx` markup, §C Google Fonts link, §D duotone icon library). Page plans copy these verbatim into their own New-code blocks — they are reference sources for plan authors/executors, not include mechanisms (this codebase has no templating).

---

### Change 1: Signature gradient to 120° + add text-gradient token
**File:** `public/style.css`
**Why:** Mockups use `linear-gradient(120deg,…)` everywhere and a 3-stop gradient for headline text.
**Locate:**
```css
  --accent-2: #15c0c9;
  --accent-3: #7b6bff;
  --grad: linear-gradient(135deg, var(--accent), var(--accent-2));
  --grad-soft: linear-gradient(135deg, color-mix(in oklab, var(--accent) 16%, transparent), color-mix(in oklab, var(--accent-2) 12%, transparent));

  /* Ink + text */
  --ink: #0c1a2b;
```
**Action:** REPLACE
**Old code:**
```css
  --grad: linear-gradient(135deg, var(--accent), var(--accent-2));
  --grad-soft: linear-gradient(135deg, color-mix(in oklab, var(--accent) 16%, transparent), color-mix(in oklab, var(--accent-2) 12%, transparent));
```
**New code:**
```css
  --grad: linear-gradient(120deg, var(--accent), var(--accent-2));
  --grad-soft: linear-gradient(135deg, color-mix(in oklab, var(--accent) 16%, transparent), color-mix(in oklab, var(--accent-2) 12%, transparent));
  --grad-text: linear-gradient(120deg, var(--accent) 10%, var(--accent-2) 55%, var(--accent-3) 100%);
  --grad-logo: linear-gradient(135deg, #2f6bff 0%, #4d8aff 45%, #15c0c9 100%);
```
**Verify:** Primary buttons/active nav render with a 120° blue→teal gradient; no CSS parse errors.

---

### Change 2: Blob animation keyframes match mockup motion
**File:** `public/style.css`
**Why:** Mockup blobs drift further and there is a third violet blob with its own keyframes.
**Locate:**
```css
@keyframes floatBlob {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(22px, -26px) scale(1.08);
  }
}
```
**Action:** REPLACE
**Old code:**
```css
@keyframes floatBlob {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(22px, -26px) scale(1.08);
  }
}
```
**New code:**
```css
@keyframes floatBlob {
  0%,
  100% {
    transform: translate(0, 0) scale(1);
  }
  50% {
    transform: translate(34px, -26px) scale(1.08);
  }
}
@keyframes floatBlob3 {
  0%,
  100% {
    transform: translate(0, 0);
  }
  50% {
    transform: translate(18px, 26px);
  }
}
```
**Verify:** No CSS errors; existing blobs still animate.

---

### Change 3: Retune the two body blobs to mockup values
**File:** `public/style.css`
**Why:** Mockup blobs are larger (600/660px), blurrier (80/85px), slower (18s/22s) and slightly stronger (.26/.22).
**Locate:**
```css
body::before {
  top: -160px;
  left: -120px;
  width: 480px;
  height: 480px;
  background: radial-gradient(circle at 30% 30%, var(--accent), transparent 70%);
  opacity: 0.22;
  animation: floatBlob 17s ease-in-out infinite;
}
```
**Action:** REPLACE
**Old code:**
```css
body::before {
  top: -160px;
  left: -120px;
  width: 480px;
  height: 480px;
  background: radial-gradient(circle at 30% 30%, var(--accent), transparent 70%);
  opacity: 0.22;
  animation: floatBlob 17s ease-in-out infinite;
}
body::after {
  bottom: -180px;
  right: -120px;
  width: 540px;
  height: 540px;
  background: radial-gradient(circle at 60% 40%, var(--accent-2), transparent 70%);
  opacity: 0.2;
  animation: floatBlob2 20s ease-in-out infinite;
}
```
**New code:**
```css
body::before {
  top: -180px;
  left: -140px;
  width: 600px;
  height: 600px;
  background: radial-gradient(circle at 32% 32%, var(--accent), transparent 70%);
  opacity: 0.26;
  filter: blur(80px);
  animation: floatBlob 18s ease-in-out infinite;
}
body::after {
  bottom: -220px;
  right: -160px;
  width: 660px;
  height: 660px;
  background: radial-gradient(circle at 60% 40%, var(--accent-2), transparent 70%);
  opacity: 0.22;
  filter: blur(85px);
  animation: floatBlob2 22s ease-in-out infinite;
}
```
**Verify:** Background blobs on every page are visibly larger/softer; page still scrolls smoothly.

---

### Change 4: Body base gradient matches mockup
**File:** `public/style.css`
**Why:** Mockup base is a simple vertical `#f4f8fe → #eaf1fb → #e5edf9` gradient.
**Locate:**
```css
  font-family: var(--font-body);
  color: var(--ink);
  background-color: var(--page-bg);
  background-image:
    radial-gradient(120% 90% at 85% -10%, #e6f6f7 0%, transparent 45%), radial-gradient(110% 80% at 0% 0%, #e9eeff 0%, transparent 40%), linear-gradient(180deg, #f1f5fb 0%, #eaf0f9 100%);
  background-size: cover;
  background-position: center;
```
**Action:** REPLACE
**Old code:**
```css
  background-color: var(--page-bg);
  background-image:
    radial-gradient(120% 90% at 85% -10%, #e6f6f7 0%, transparent 45%), radial-gradient(110% 80% at 0% 0%, #e9eeff 0%, transparent 40%), linear-gradient(180deg, #f1f5fb 0%, #eaf0f9 100%);
```
**New code:**
```css
  background-color: var(--page-bg);
  background-image: linear-gradient(180deg, #f4f8fe 0%, #eaf1fb 55%, #e5edf9 100%);
```
**Verify:** Page background is a clean top-to-bottom light gradient (no corner tints).

---

### Change 5: Logo droplet
**File:** `public/style.css`
**Why:** Mockup logo is a −6° rounded square with the 135° 3-stop gradient, inset highlight, colored shadow, and a white **droplet** (not a square) inside.
**Locate:**
```css
.brand-mark {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  border-radius: 12px;
  background: var(--grad);
```
**Action:** REPLACE
**Old code:**
```css
.brand-mark {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  border-radius: 12px;
  background: var(--grad);
  box-shadow: 0 8px 20px -6px rgba(47, 107, 255, 0.6);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: rotate(-6deg);
}
.brand-mark::after {
  content: "";
  width: 12px;
  height: 12px;
  border-radius: 4px;
  background: #fff;
}
```
**New code:**
```css
.brand-mark {
  width: 40px;
  height: 40px;
  flex: 0 0 auto;
  border-radius: 14px;
  background: var(--grad-logo);
  box-shadow:
    0 10px 22px -8px rgba(47, 107, 255, 0.65),
    inset 0 1px 1px rgba(255, 255, 255, 0.55);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transform: rotate(-6deg);
}
.brand-mark::after {
  content: "";
  width: 16px;
  height: 16px;
  border-radius: 50% 50% 50% 14%;
  transform: rotate(51deg);
  background: #fff;
  box-shadow: 0 2px 5px rgba(10, 40, 90, 0.3);
}
.brand .brand-slash {
  background: var(--grad);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
```
**Verify:** Every page's brand tile shows a white droplet inside a tilted gradient square; the `/` in `losthusky / drop` renders gradient wherever markup uses `<span class="brand-slash">/</span>` (page plans add it).

---

### Change 6: Primary buttons become gradient pills
**File:** `public/style.css`
**Why:** Every primary CTA in the mockups is a `border-radius:999px` gradient pill with `0 16px 34px -14px rgba(47,107,255,0.75)` glow and brightness hover.
**Locate:**
```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 50px;
  padding: 14px 24px;
  border: 0;
  border-radius: var(--r-md);
```
**Action:** REPLACE
**Old code:**
```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 50px;
  padding: 14px 24px;
  border: 0;
  border-radius: var(--r-md);
  color: #fff;
  background: var(--grad);
  font: 700 15px var(--font-body);
  text-decoration: none;
  cursor: pointer;
  box-shadow: var(--shadow-btn);
  transition:
    transform 0.18s ease,
    box-shadow 0.18s ease;
}
.btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 20px 42px -14px rgba(47, 107, 255, 0.8);
}
```
**New code:**
```css
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 9px;
  min-height: 50px;
  padding: 14px 26px;
  border: 0;
  border-radius: 999px;
  color: #fff;
  background: var(--grad);
  font: 700 15px var(--font-body);
  text-decoration: none;
  cursor: pointer;
  box-shadow: 0 16px 34px -14px rgba(47, 107, 255, 0.75);
  transition:
    transform 0.18s ease,
    filter 0.18s ease,
    box-shadow 0.18s ease;
}
.btn:hover {
  transform: translateY(-2px);
  filter: brightness(1.06);
  box-shadow: 0 20px 42px -14px rgba(47, 107, 255, 0.8);
}
```
**Verify:** All existing `.btn` elements (admin forms, drop page, home CTAs) render as gradient pills; ghost variant unaffected.

---

### Change 7: Append UI 3.0 shared component classes
**File:** `public/style.css`
**Why:** Shared classes referenced by every page plan: third blob + dot-grid + noise layer, gradient text, gradient-border hero card, inner glass tiles, icon buttons, icon tiles, filter chips, avatars, progress bars, eyebrow pills, duotone icon sizing.
**Locate:**
```css
  /* Fine-pointer-only cursor follower never applies on touch, but guard anyway. */
  .fx-cur-dot,
  .fx-cur-ring {
    display: none !important;
  }
}
```
**Action:** INSERT AFTER
**New code:**
```css

/* ============================================================
   UI 3.0 — shared components (design tokens plan 00)
   ============================================================ */

/* Background FX layer: pages add <div class="bg-fx" aria-hidden="true"></div>
   right after <body>. Dot grid on the element, noise on ::before,
   third (violet) blob on ::after. The two main blobs stay on body::before/after. */
.bg-fx {
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  overflow: hidden;
  background-image: radial-gradient(rgba(47, 107, 255, 0.09) 1px, transparent 1.4px);
  background-size: 26px 26px;
  -webkit-mask-image: radial-gradient(80% 70% at 50% 30%, black, transparent);
  mask-image: radial-gradient(80% 70% at 50% 30%, black, transparent);
}
.bg-fx::before {
  content: "";
  position: absolute;
  inset: 0;
  opacity: 0.05;
  mix-blend-mode: multiply;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2'/%3E%3C/filter%3E%3Crect width='160' height='160' filter='url(%23n)'/%3E%3C/svg%3E");
}
.bg-fx::after {
  content: "";
  position: absolute;
  top: 26%;
  right: 10%;
  width: 400px;
  height: 400px;
  border-radius: 50%;
  filter: blur(90px);
  opacity: 0.15;
  background: radial-gradient(circle at 50% 50%, var(--accent-3), transparent 70%);
  animation: floatBlob3 26s ease-in-out infinite;
}

/* Gradient headline text */
.grad-text {
  background: var(--grad-text);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

/* Gradient-border hero card: 2px gradient wrapper around a glass card.
   Usage: <div class="grad-border"><div class="grad-border-inner">…</div></div> */
.grad-border {
  padding: 2px;
  border-radius: 26px;
  background: var(--grad);
  box-shadow: 0 24px 60px -30px rgba(47, 107, 255, 0.55);
}
.grad-border-inner {
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.86);
  backdrop-filter: blur(14px);
  padding: clamp(20px, 3vw, 30px);
}

/* Inner glass tile (nested inside .panel cards) */
.glass-tile {
  border-radius: 14px;
  border: 1px solid rgba(12, 26, 43, 0.06);
  background: rgba(255, 255, 255, 0.66);
  padding: 12px 14px;
}

/* Square glass icon button (copy / QR / folder / pause / delete rows) */
.icon-btn {
  width: 36px;
  height: 36px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
  border: 1px solid rgba(12, 26, 43, 0.12);
  background: rgba(255, 255, 255, 0.8);
  color: var(--ink-soft);
  cursor: pointer;
  padding: 0;
  transition:
    border-color 0.16s ease,
    color 0.16s ease,
    transform 0.16s ease;
}
.icon-btn:hover {
  border-color: var(--accent);
  color: var(--accent);
  transform: translateY(-1px);
}
.icon-btn.danger {
  color: var(--red);
  border-color: rgba(240, 85, 107, 0.3);
  background: rgba(240, 85, 107, 0.05);
}
.icon-btn.danger:hover {
  border-color: var(--red);
}
.icon-btn svg {
  width: 15px;
  height: 15px;
  fill: currentColor;
}

/* Duotone icon tile (44px, tinted gradient backplate) for stat cards / steps */
.icon-tile {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  border-radius: 15px;
  background: linear-gradient(135deg, rgba(47, 107, 255, 0.14), rgba(21, 192, 201, 0.14));
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.icon-tile svg {
  width: 20px;
  height: 20px;
}

/* Filter chips (activity filters, chart metric toggles) */
.chip-filter {
  font: 600 12.5px var(--font-body);
  color: var(--muted);
  border: 1px solid rgba(12, 26, 43, 0.12);
  border-radius: 999px;
  padding: 8px 15px;
  background: rgba(255, 255, 255, 0.75);
  cursor: pointer;
  transition:
    color 0.15s ease,
    border-color 0.15s ease;
}
.chip-filter:hover {
  color: var(--accent);
  border-color: rgba(47, 107, 255, 0.4);
}
.chip-filter.active {
  color: #fff;
  border-color: transparent;
  background: var(--grad);
  box-shadow: 0 10px 22px -12px rgba(47, 107, 255, 0.7);
}
.chip-filter.danger:hover {
  color: var(--red);
  border-color: rgba(240, 85, 107, 0.4);
}

/* Initials avatar */
.avatar {
  width: 38px;
  height: 38px;
  flex: 0 0 auto;
  border-radius: 13px;
  background: var(--grad);
  color: #fff;
  font: 700 13px var(--font-display);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  letter-spacing: 0.02em;
  box-shadow: 0 10px 22px -10px rgba(47, 107, 255, 0.7);
}

/* Progress bar (gradient fill). Usage: <div class="bar"><i style="width:68%"></i></div> */
.bar {
  height: 9px;
  border-radius: 99px;
  background: rgba(12, 26, 43, 0.07);
  overflow: hidden;
}
.bar > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--accent), var(--accent-2));
  transition: width 0.4s ease;
}
.bar.amber > i {
  background: linear-gradient(90deg, #f0b429, var(--amber));
}

/* Mono uppercase eyebrow pill */
.eyebrow {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-mono);
  font-size: 12px;
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--accent);
  border: 1px solid rgba(47, 107, 255, 0.25);
  border-radius: 999px;
  padding: 8px 15px;
  background: rgba(47, 107, 255, 0.06);
}
.eyebrow svg {
  width: 12px;
  height: 12px;
  fill: currentColor;
}

/* Duotone inline SVG default sizing (icons carry their own opacity backplates) */
.duo {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  fill: currentColor;
}

/* Dashed empty-state card */
.empty-dashed {
  border: 1.5px dashed rgba(12, 26, 43, 0.18);
  border-radius: 18px;
  padding: 26px;
  text-align: center;
  color: var(--muted);
  font-size: 13.5px;
  background: rgba(255, 255, 255, 0.4);
}
```
**Verify:** Classes exist and are inert until page plans use them; loading any page shows the dot grid + noise + violet blob once its HTML gains `<div class="bg-fx" aria-hidden="true"></div>`.

---

## Canonical shared blocks (copy verbatim into page plans' New-code)

### §A — Logo markup
```html
<a class="brand" href="/"><i class="brand-mark"></i><span>losthusky <span class="brand-slash">/</span> drop</span></a>
```
(For non-link contexts use `<span class="brand">…</span>` with identical children.)

### §B — Background FX layer (first child of `<body>`)
```html
<div class="bg-fx" aria-hidden="true"></div>
```

### §C — Google Fonts link (each page `<head>`; replaces the page's existing fonts link)
```html
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet" />
```

### §D — Duotone SVG icon library
Copy these complete `<svg>` elements wherever a page plan names an icon. All use `viewBox="0 0 24 24"`; set explicit `width`/`height`/`fill` per use site (page plans always include them inline in full).

**lock**
```html
<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="10" width="14" height="10" rx="2.5" opacity="0.25"></rect><path d="M7 10V8a5 5 0 0 1 10 0v2h-2V8a3 3 0 0 0-6 0v2H7zm-2 2h14v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z"></path></svg>
```
**bolt** (fast / eyebrow)
```html
<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.14"></circle><path d="M13 2L4.5 13.5H11l-1 8.5L18.5 10H12l1-8z"></path></svg>
```
**check-circle** (done state)
```html
<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.16"></circle><path d="M10.4 15.2l-3-3 1.3-1.3 1.7 1.7 4.9-4.9 1.3 1.3-6.2 6.2z"></path></svg>
```
**check** (plain tick, feature chips)
```html
<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M10.4 17.2l-5-5 1.4-1.4 3.6 3.6 7.8-7.8 1.4 1.4-9.2 9.2z"></path></svg>
```
**upload** (arrow up over tray)
```html
<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a1 1 0 0 1 .7.3l4.5 4.5a1 1 0 0 1-1.4 1.4L13 6.4V15a1 1 0 1 1-2 0V6.4L8.2 9.2a1 1 0 0 1-1.4-1.4l4.5-4.5A1 1 0 0 1 12 3z"></path><path d="M4 15a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2a1 1 0 0 1 1-1z" opacity="0.6"></path></svg>
```
**video** (camera + lens flag)
```html
<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M5 6h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm13.5 3.8l2.9-1.9a1 1 0 0 1 1.6.8v6.6a1 1 0 0 1-1.6.8l-2.9-1.9V9.8z"></path></svg>
```
**image** (plain rect, queued file)
```html
<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="5" width="16" height="14" rx="2.5"></rect></svg>
```
**image-duo** (photo with mount + sun)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="18" height="16" rx="3" opacity="0.18"></rect><path d="M5 6h14a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm3.5 4a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM6 16h12l-3.8-5-3 3.8-1.8-2.2L6 16z"></path></svg>
```
**folder**
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 7a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7z" opacity="0.3"></path><path d="M7 6h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"></path></svg>
```
**folder-check** (delivered to Drive)
```html
<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M5 7a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7z" opacity="0.3"></path><path d="M7 6h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1zm3.4 8.2l1.3-1.3 1.1 1.1 2.5-2.5 1.3 1.3-3.8 3.8-2.4-2.4z"></path></svg>
```
**link** (chain)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l2.8-2.8a3 3 0 0 1 4.2 4.2l-2 2a1 1 0 1 1-1.4-1.4l2-2a1 1 0 0 0-1.4-1.4l-2.8 2.8a1 1 0 0 1-1.4 0z"></path><path d="M13.4 10.6a1 1 0 0 1 0 1.4l-2.8 2.8a3 3 0 0 1-4.2-4.2l2-2a1 1 0 0 1 1.4 1.4l-2 2a1 1 0 1 0 1.4 1.4l2.8-2.8a1 1 0 0 1 1.4 0z" opacity="0.55"></path></svg>
```
**eye** (opens / views / show password)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 5c5 0 9 4.3 10 7-1 2.7-5 7-10 7S3 14.7 2 12c1-2.7 5-7 10-7z" opacity="0.2"></path><path d="M12 7c3.9 0 7 3.1 7.8 5-.8 1.9-3.9 5-7.8 5s-7-3.1-7.8-5C5 10.1 8.1 7 12 7zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"></path></svg>
```
**users** (sessions / viewers)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="8" r="4" opacity="0.25"></circle><path d="M9 6a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 8c3.3 0 6 1.8 6 4v1H3v-1c0-2.2 2.7-4 6-4zm7.5-1.6A3.5 3.5 0 0 0 18 5.6a3.5 3.5 0 0 1-1.5 6.8zm1 2.1c2 .6 3.5 1.9 3.5 3.5v1h-3v-1c0-1.3-.5-2.5-1.4-3.4.3 0 .6-.1.9-.1z"></path></svg>
```
**db** (storage / drive)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><ellipse cx="12" cy="6" rx="8" ry="3" opacity="0.35"></ellipse><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0 1.7-3.6 3-8 3S4 7.7 4 6zm16 6c0 1.7-3.6 3-8 3s-8-1.3-8-3"></path></svg>
```
**shield** (privacy / rate limit)
```html
<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V5l8-3z" opacity="0.14"></path><path d="M12 4.2l6 2.2v4.7c0 3.9-2.5 6.8-6 8.8-3.5-2-6-4.9-6-8.8V6.4l6-2.2zm-1 9.4l-1.8-1.8-1.2 1.2 3 3 5-5-1.2-1.2-3.8 3.8z"></path></svg>
```
**shield-solid** (trust strip)
```html
<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l8 3v6c0 5-3.4 8.6-8 11-4.6-2.4-8-6-8-11V5l8-3z"></path></svg>
```
**refresh** (resume / retry / sync)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.14"></circle><path d="M12 5a7 7 0 1 1-6.3 4h2.3A5 5 0 1 0 12 7v2.5L7.5 6 12 2.5V5z"></path></svg>
```
**copy**
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="8" y="8" width="12" height="12" rx="2.5" opacity="0.3"></rect><path d="M6 4h9a2 2 0 0 1 2 2v1h-2V6H6v9h1v2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm4 5h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z"></path></svg>
```
**qr**
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4h7v7H4V4zm2 2v3h3V6H6zm7-2h7v7h-7V4zm2 2v3h3V6h-3zM4 13h7v7H4v-7zm2 2v3h3v-3H6zm11-2h3v2h-3v-2zm-4 0h2v3h3v2h-3v2h-2v-7zm5 5h2v2h-2v-2z"></path></svg>
```
**pause**
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.4"></rect><rect x="14" y="5" width="4" height="14" rx="1.4"></rect></svg>
```
**play** (re-open)
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.5a1 1 0 0 1 1.5-.9l9 6.5a1 1 0 0 1 0 1.8l-9 6.5A1 1 0 0 1 8 18.5v-13z"></path></svg>
```
**trash**
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M7 9h10v10a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2V9z" opacity="0.3"></path><path d="M9 3h6l1 2h4v2H4V5h4l1-2zM7 9h2v9H7V9zm4 0h2v9h-2V9zm4 0h2v9h-2V9z"></path></svg>
```
**share-nodes**
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="18" cy="5" r="3" opacity="0.3"></circle><circle cx="6" cy="12" r="3" opacity="0.3"></circle><circle cx="18" cy="19" r="3" opacity="0.3"></circle><path d="M18 3.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM6 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm12 7a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM8.6 10.8l6.9-4-1-1.7-6.9 4 1 1.7zm-1 4.1l6.9 4 1-1.7-6.9-4-1 1.7z"></path></svg>
```
**bell**
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3a6 6 0 0 1 6 6v3.5l1.7 2.8a1 1 0 0 1-.9 1.5H5.2a1 1 0 0 1-.9-1.5L6 12.5V9a6 6 0 0 1 6-6z" opacity="0.25"></path><path d="M12 4.5A4.5 4.5 0 0 1 16.5 9v3.9l1.2 2H6.3l1.2-2V9A4.5 4.5 0 0 1 12 4.5zM10 19h4a2 2 0 1 1-4 0z"></path></svg>
```
**chart** (activity bars)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="4" width="18" height="16" rx="3" opacity="0.14"></rect><path d="M7 14h2.4v4H7v-4zm3.8-5h2.4v9h-2.4V9zm3.8 3H17v6h-2.4v-6z"></path></svg>
```
**pulse** (live)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.14"></circle><path d="M3.5 12h3.6l1.7-4.4 3 8.3 2.1-5.4 1.2 1.5h5.4v2h-6.3l-.5-.6-2.2 5.5-3-8.2-.9 2.3H3.5v-1z"></path></svg>
```
**search**
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><circle cx="10.5" cy="10.5" r="6" opacity="0.2"></circle><path d="M10.5 4.5a6 6 0 1 1-3.9 10.6l-3.9 3.9-1.4-1.4 3.9-3.9A6 6 0 0 1 10.5 4.5zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"></path></svg>
```
**chevron-down** (accordion / expanders)
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 15.4L5.6 9 7 7.6l5 5 5-5L18.4 9 12 15.4z"></path></svg>
```
**arrow-right**
```html
<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M9 5l7 7-7 7-1.4-1.4L13.2 12 7.6 6.4 9 5z"></path></svg>
```
**plus**
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1z"></path></svg>
```
**login** (enter arrow)
```html
<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M13 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5v-2h5V5h-5V3z" opacity="0.45"></path><path d="M10.6 7.4L14.2 11H3v2h11.2l-3.6 3.6 1.4 1.4 6-6-6-6-1.4 1.4z"></path></svg>
```
**error** (triangle)
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3l10 18H2L12 3z" opacity="0.18"></path><path d="M12 6.2L19.5 19h-15L12 6.2zM11 11v4h2v-4h-2zm0 5.5v2h2v-2h-2z"></path></svg>
```
**download**
```html
<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21a1 1 0 0 1-.7-.3l-4.5-4.5a1 1 0 0 1 1.4-1.4L11 17.6V9a1 1 0 1 1 2 0v8.6l2.8-2.8a1 1 0 0 1 1.4 1.4l-4.5 4.5a1 1 0 0 1-.7.3z"></path><path d="M4 3a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V4a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V4a1 1 0 0 1 1-1z" opacity="0.6"></path></svg>
```

---

## Responsive
No page-level responsive work in this plan. The appended components are already fluid; page plans carry their own responsive sections. The existing responsive blocks in `style.css` are untouched by this plan.

## Placeholder data
None — this plan is CSS-only.
