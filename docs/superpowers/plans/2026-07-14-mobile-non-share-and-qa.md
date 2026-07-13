# Mobile Non-Share Repair and Integration QA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair mobile discrepancies across home, drop, authentication, legal, and admin surfaces without redesigning their current composition, then verify the complete mobile experience across the approved viewport and input matrix.

**Architecture:** Keep the existing HTML hierarchy and desktop CSS. Add shared mobile invariants and route-scoped repairs in `public/style.css`, refine the existing admin bottom navigation into four primary destinations plus a labeled More sheet, and encode structural responsive contracts in a Node regression script. Browser verification uses the running Wrangler app and the exact matrix from the design specification.

**Tech Stack:** Existing HTML/CSS/vanilla JavaScript, Cloudflare Wrangler dev server, Node `assert` regression scripts, browser responsive/touch emulation.

## Global Constraints

- Preserve the current home, drop, authentication, legal, and admin page order, visual identity, and desktop workflows.
- Only change non-share layout where a responsive discrepancy or shared invariant requires it.
- Support 320 × 568, 360 × 800, 390 × 844, 430 × 932, 568 × 320, 768 × 1024, and 1024 × 768.
- Primary touch targets are at least 44 by 44 CSS pixels.
- No required action may be covered by a fixed bar, safe area, dialog edge, or on-screen keyboard.
- No route may produce unintended document-level horizontal overflow.
- Long URLs, filenames, breadcrumbs, status pills, action groups, and legal text must wrap or truncate inside their owner.
- Browser zoom remains enabled and reduced motion remains honored.

---

## File map

- Create `scripts/mobile-responsive-test.mjs`: source-level contracts shared by all public routes.
- Modify `package.json`: run the responsive contract in the full suite.
- Modify `public/style.css`: shared tokens plus route-scoped home, drop/auth, legal, admin, dialog, and landscape repairs.
- Modify `public/admin.html`: mobile More trigger/sheet while keeping existing desktop tabs.
- Modify `public/admin.js`: open/close More, route its actions through existing tab buttons, and preserve focus.
- Modify `scripts/admin-workflow-test.mjs`: enforce the five-destination mobile navigation and retained desktop tab paths.
- Verify, but do not structurally rewrite: `public/index.html`, `public/drop.html`, `public/privacy.html`, `public/terms.html`, and `public/admin.html`.

### Task 1: Shared responsive contracts and regression script

**Files:**
- Create: `scripts/mobile-responsive-test.mjs`
- Modify: `package.json`
- Modify: `public/style.css`

**Interfaces:**
- Produces CSS custom properties: `--mobile-gutter`, `--mobile-safe-left`, `--mobile-safe-right`, `--mobile-safe-bottom`, `--mobile-control`, and `--mobile-vh`.
- Produces one source test that checks all six public HTML entries and shared CSS invariants.

- [ ] **Step 1: Write the failing responsive contract**

Create `scripts/mobile-responsive-test.mjs`:

```js
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const htmlPaths = [
  "public/index.html",
  "public/drop.html",
  "public/privacy.html",
  "public/terms.html",
  "public/admin.html",
  "public/share.html",
];
const [css, ...pages] = await Promise.all([read("public/style.css"), ...htmlPaths.map(read)]);

for (const [index, page] of pages.entries()) {
  assert.match(page, /<meta[^>]+name="viewport"[^>]+width=device-width/, `${htmlPaths[index]} must keep mobile viewport semantics`);
  assert.match(page, /href="\/style\.css"/, `${htmlPaths[index]} must load the shared stylesheet`);
  assert.doesNotMatch(page, /user-scalable\s*=\s*no/i, `${htmlPaths[index]} must keep browser zoom enabled`);
}

assert.match(css, /--mobile-gutter:\s*12px/);
assert.match(css, /--mobile-safe-left:\s*max\(var\(--mobile-gutter\), env\(safe-area-inset-left\)\)/);
assert.match(css, /--mobile-safe-right:\s*max\(var\(--mobile-gutter\), env\(safe-area-inset-right\)\)/);
assert.match(css, /--mobile-safe-bottom:\s*max\(12px, env\(safe-area-inset-bottom\)\)/);
assert.match(css, /--mobile-control:\s*44px/);
assert.match(css, /100dvh/);
assert.match(css, /@media \(max-width: 640px\)/);
assert.match(css, /@media \(max-width: 900px\)/);
assert.match(css, /@media \(max-height: 500px\) and \(orientation: landscape\)/);
assert.doesNotMatch(css, /touch-action:\s*none[^}]*body/i, "document scrolling must not be disabled globally");

console.log("mobile responsive contracts passed");
```

- [ ] **Step 2: Run the script and verify the missing-token failure**

Run: `node scripts/mobile-responsive-test.mjs`

Expected: FAIL at `--mobile-gutter`.

- [ ] **Step 3: Add shared mobile tokens without changing desktop layout**

Add near the root custom properties in `public/style.css`:

```css
:root {
  --mobile-gutter: 12px;
  --mobile-safe-left: max(var(--mobile-gutter), env(safe-area-inset-left));
  --mobile-safe-right: max(var(--mobile-gutter), env(safe-area-inset-right));
  --mobile-safe-bottom: max(12px, env(safe-area-inset-bottom));
  --mobile-control: 44px;
  --mobile-vh: 100vh;
}
@supports (height: 100dvh) {
  :root { --mobile-vh: 100dvh; }
}
@media (max-width: 640px) {
  html, body { max-width: 100%; }
  img, video, canvas, svg { max-width: 100%; }
  button, input, select, textarea { max-inline-size: 100%; }
  :where(.topbar, .panel, .field, .meta-row, .transfer-actions, .pane-head, .section-title) { min-width: 0; }
}
@media (max-height: 500px) and (orientation: landscape) {
  :where(.center-panel, .auth-wrap, .gate) { align-content: start; min-height: var(--mobile-vh); overflow-y: auto; }
}
```

- [ ] **Step 4: Add the contract to the full suite and run it**

Insert `node scripts/mobile-responsive-test.mjs` immediately after `node scripts/ui-v3-test.mjs` in `package.json`.

Run: `node scripts/mobile-responsive-test.mjs && npm test`

Expected: `mobile responsive contracts passed` and suite exit 0.

- [ ] **Step 5: Commit the shared contract**

```powershell
git add public/style.css scripts/mobile-responsive-test.mjs package.json
git commit -m "test: define mobile responsive contracts"
```

### Task 2: Preserve and repair home and legal pages

**Files:**
- Modify: `public/style.css` selectors for `.home-v3`, `.hero-v3`, `.hero-actions`, `.hero-v3-visual`, `.steps-v3-grid`, `.strip-v3`, `.foot-v3`, `.legal-shell`, `.legal-card`, `.legal-page`, `.nav-cluster`
- Modify: `scripts/mobile-responsive-test.mjs`

**Interfaces:**
- No DOM changes; existing `public/index.html`, `public/privacy.html`, and `public/terms.html` structure remains authoritative.

- [ ] **Step 1: Add failing route-specific source checks**

Append to `scripts/mobile-responsive-test.mjs`:

```js
assert.match(css, /\.home-v3[\s\S]+?overflow-x:\s*clip/);
assert.match(css, /\.hero-actions[\s\S]+?grid-template-columns:\s*1fr/);
assert.match(css, /\.legal-card[\s\S]+?overflow-wrap:\s*anywhere/);
assert.match(css, /\.legal-page[\s\S]+?line-height:\s*1\.7/);
```

- [ ] **Step 2: Run the contract and verify failure**

Run: `node scripts/mobile-responsive-test.mjs`

Expected: FAIL at the missing `.home-v3` mobile overflow contract.

- [ ] **Step 3: Add route-scoped phone repairs**

Place these rules inside the consolidated phone section, preserving current section order and desktop grids:

```css
@media (max-width: 640px) {
  .home-v3 { width: 100%; overflow-x: clip; }
  .home-v3 .topbar { gap: 10px; padding-left: var(--mobile-safe-left); padding-right: var(--mobile-safe-right); }
  .home-v3 .brand { min-width: 0; }
  .home-v3 .brand > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hero-v3 { grid-template-columns: 1fr; gap: 24px; padding-left: var(--mobile-safe-left); padding-right: var(--mobile-safe-right); }
  .hero-v3-copy, .hero-v3-visual, .mini-drop-card { min-width: 0; }
  .hero-v3-copy h1 { max-width: 100%; font-size: clamp(36px, 12vw, 56px); overflow-wrap: anywhere; }
  .hero-v3-sub { max-width: 100%; }
  .hero-actions { display: grid; grid-template-columns: 1fr; width: 100%; }
  .hero-actions .btn { width: 100%; min-height: var(--mobile-control); justify-content: center; }
  .hero-v3-visual { transform: none; }
  .mini-drop-head, .mini-drop-foot { gap: 8px; }
  .mini-drop-title, .mini-file { min-width: 0; }
  .steps-v3-grid { grid-template-columns: 1fr; }
  .strip-v3 { grid-template-columns: 1fr; }
  .foot-v3 { align-items: flex-start; flex-direction: column; gap: 12px; }

  .legal-shell { width: 100%; padding-left: var(--mobile-safe-left); padding-right: var(--mobile-safe-right); overflow-x: clip; }
  .legal-shell .topbar { align-items: flex-start; gap: 10px; }
  .legal-shell .nav-cluster { min-width: 0; flex-wrap: wrap; justify-content: flex-end; }
  .legal-card { min-width: 0; padding: 20px 16px; overflow-wrap: anywhere; }
  .legal-page { max-width: 72ch; font-size: 16px; line-height: 1.7; }
  .legal-page pre, .legal-page code, .legal-page a { white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
}
```

- [ ] **Step 4: Run source and full regression tests**

Run: `node scripts/mobile-responsive-test.mjs && npm test`

Expected: both exit 0.

With `npm run dev -- --port 8787`, verify `/`, `/privacy`, and `/terms` at every target viewport. Confirm section order is unchanged, no decorative layer widens the document, CTAs remain visible, and long legal URLs wrap.

- [ ] **Step 5: Commit home/legal repairs**

```powershell
git add public/style.css scripts/mobile-responsive-test.mjs
git commit -m "fix: repair home and legal mobile layout"
```

### Task 3: Preserve and repair drop and authentication flows

**Files:**
- Modify: `public/style.css` selectors for `.drop-page`, `.drop-shell`, `.drop-topbar`, `.collector-hero`, `.dropzone-wrap`, `.dropzone`, `.filelist`, `.upload-row`, `.transfer-panel-v3`, `.transfer-actions`, `.edge-card`, `.auth-wrap`, `.auth-card`, `.auth-input`
- Modify: `scripts/mobile-responsive-test.mjs`

**Interfaces:**
- Existing upload and authentication JavaScript remains unchanged unless browser verification exposes a keyboard/focus bug.

- [ ] **Step 1: Add failing drop/auth contracts**

Append to `scripts/mobile-responsive-test.mjs`:

```js
assert.match(css, /\.drop-page[\s\S]+?min-height:\s*var\(--mobile-vh\)/);
assert.match(css, /\.dropzone[\s\S]+?min-height:\s*132px/);
assert.match(css, /\.transfer-actions[\s\S]+?grid-template-columns:\s*1fr/);
assert.match(css, /\.auth-card[\s\S]+?max-height:\s*calc\(var\(--mobile-vh\)/);
```

- [ ] **Step 2: Run the contract and verify failure**

Run: `node scripts/mobile-responsive-test.mjs`

Expected: FAIL at the `.drop-page` dynamic-height contract.

- [ ] **Step 3: Add phone and keyboard-safe repairs**

Add to the phone section:

```css
@media (max-width: 640px) {
  .drop-page { min-height: var(--mobile-vh); overflow-x: clip; }
  .drop-shell { width: 100%; padding-left: var(--mobile-safe-left); padding-right: var(--mobile-safe-right); }
  .drop-topbar { gap: 8px; }
  .drop-topbar .brand { min-width: 0; }
  .collector-hero, .dropzone-wrap, .transfer-panel-v3, .edge-card { min-width: 0; padding: 16px; }
  .collector-hero .hero-copy h1 { font-size: clamp(30px, 10vw, 48px); overflow-wrap: anywhere; }
  .meta-row, .trust-strip { flex-wrap: wrap; }
  .dropzone { min-height: 132px; padding: 18px 12px; }
  .dropzone, .dropzone button, .dropzone label { touch-action: manipulation; }
  .filelist, .upload-row, .upload-row > * { min-width: 0; }
  .upload-row { grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
  .upload-row b, .upload-row span { overflow-wrap: anywhere; }
  .transfer-head-v3 { align-items: flex-start; flex-direction: column; }
  .transfer-actions { display: grid; grid-template-columns: 1fr; width: 100%; }
  .transfer-actions .btn, .transfer-actions .mini { width: 100%; min-height: var(--mobile-control); justify-content: center; }
  .promo-video iframe { width: 100%; aspect-ratio: 16 / 9; height: auto; }

  .auth-wrap { min-height: var(--mobile-vh); align-items: safe center; padding-top: max(12px, env(safe-area-inset-top)); padding-right: var(--mobile-safe-right); padding-bottom: var(--mobile-safe-bottom); padding-left: var(--mobile-safe-left); overflow-y: auto; }
  .auth-card { width: min(100%, 460px); max-height: calc(var(--mobile-vh) - 24px); overflow-y: auto; }
  .auth-input, .auth-card .btn { min-height: var(--mobile-control); font-size: 16px; }
}
```

Add a keyboard-open refinement:

```css
@media (max-width: 640px) and (max-height: 560px) {
  .auth-wrap { align-items: flex-start; }
  .auth-card { margin-block: 0; }
}
```

- [ ] **Step 4: Run tests and exercise upload/auth states**

Run: `node scripts/mobile-responsive-test.mjs && npm test`

Expected: both exit 0.

With the dev server, verify `/drop/<valid local fixture>` and `/admin` authentication at 320, 390, 430, and landscape widths. Exercise empty, selected-file, uploading, paused, error, completion, signed-out, PIN-error, and keyboard-open states. Confirm buttons stay reachable and no filename widens the page.

- [ ] **Step 5: Commit drop/auth repairs**

```powershell
git add public/style.css scripts/mobile-responsive-test.mjs
git commit -m "fix: repair drop and auth mobile layout"
```

### Task 4: Refine existing admin bottom navigation and dense surfaces

**Files:**
- Modify: `public/admin.html:64-109,339-380`
- Modify: `public/admin.js` tab initialization and dialog handlers
- Modify: `public/style.css:6251-6385,6532-6584`
- Modify: `scripts/admin-workflow-test.mjs`
- Modify: `scripts/mobile-responsive-test.mjs`

**Interfaces:**
- Produces IDs: `admin-more-toggle`, `admin-mobile-more`, and `admin-mobile-more-close`.
- Produces: `setAdminMobileMoreOpen(open)`.
- Mobile primary destinations: existing tabs `overview`, `live`, `links`, `shares`, plus the More trigger.
- More routes through existing hidden-on-mobile tab buttons for `activity`, `create`, and `create-share`; no duplicate tab state is introduced.

- [ ] **Step 1: Add failing admin navigation and dialog assertions**

Append to `scripts/admin-workflow-test.mjs`:

```js
assert.match(adminHtml, /id="admin-more-toggle"/);
assert.match(adminHtml, /id="admin-mobile-more"/);
assert.match(adminHtml, /data-mobile-tab="activity"/);
assert.match(adminHtml, /data-mobile-tab="create"/);
assert.match(adminHtml, /data-mobile-tab="create-share"/);
assert.match(adminJs, /function setAdminMobileMoreOpen/);
assert.match(adminJs, /admin-mobile-more-close/);
```

Append to `scripts/mobile-responsive-test.mjs`:

```js
assert.match(css, /\.admin-side :is\(\.tab, \.tab-more\) \.tab-label[\s\S]+?display:\s*block/);
assert.match(css, /\.admin-mobile-more[\s\S]+?env\(safe-area-inset-bottom\)/);
assert.match(css, /:is\(\.qr-card, \.share-edit-card, \.folder-picker-panel, \.confirm-card\)[\s\S]+?max-height:\s*calc\(var\(--mobile-vh\)/);
```

- [ ] **Step 2: Run admin and responsive tests and verify failure**

Run: `node scripts/admin-workflow-test.mjs && node scripts/mobile-responsive-test.mjs`

Expected: FAIL at `admin-more-toggle`.

- [ ] **Step 3: Add four primary tabs plus a mobile More sheet**

In `public/admin.html`, add the More button after the existing Share links tab and mark Activity/Create tabs as secondary:

```html
<button class="tab-more" id="admin-more-toggle" type="button" aria-expanded="false" aria-controls="admin-mobile-more">
  <svg width="17" height="17" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>
  <span class="tab-label">More</span>
</button>
```

Add the sheet before the dialogs:

```html
<section class="admin-mobile-more" id="admin-mobile-more" role="dialog" aria-label="More admin destinations" tabindex="-1" hidden>
  <header><b>More</b><button class="mini" id="admin-mobile-more-close" type="button">Close</button></header>
  <button type="button" data-mobile-tab="activity">Activity</button>
  <button type="button" data-mobile-tab="create">New drop link</button>
  <button type="button" data-mobile-tab="create-share">New share link</button>
  <button type="button" id="admin-mobile-lock">Lock dashboard</button>
</section>
```

Add top-level references beside the existing admin state, wire them inside `init()` immediately after the `.tab` listeners, and keep the open/close function at top-level so `showTab` can synchronize active state:

```js
let adminMobileMore = null;
let adminMoreToggle = null;
const adminSecondaryTabs = new Set(["activity", "create", "create-share"]);

function setAdminMobileMoreOpen(open) {
  if (!adminMobileMore || !adminMoreToggle) return;
  const wasOpen = !adminMobileMore.hidden;
  adminMobileMore.hidden = !open;
  adminMoreToggle.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("admin-more-open", open);
  if (open) adminMobileMore.querySelector("button")?.focus();
  else if (wasOpen) adminMoreToggle.focus({ preventScroll: true });
}

// Inside init(), after the existing .tab click listeners:
adminMobileMore = document.getElementById("admin-mobile-more");
adminMoreToggle = document.getElementById("admin-more-toggle");
adminMoreToggle.addEventListener("click", () => setAdminMobileMoreOpen(adminMobileMore.hidden));
document.getElementById("admin-mobile-more-close").addEventListener("click", () => setAdminMobileMoreOpen(false));
adminMobileMore.addEventListener("click", (event) => {
  const name = event.target.closest("[data-mobile-tab]")?.dataset.mobileTab;
  if (!name) return;
  setAdminMobileMoreOpen(false);
  document.querySelector(`.admin-side .tab[data-tab="${CSS.escape(name)}"]`)?.click();
});
document.getElementById("admin-mobile-lock").addEventListener("click", () => {
  setAdminMobileMoreOpen(false);
  document.getElementById("logout").click();
});
```

At the end of the existing `showTab(name)`, add:

```js
adminMoreToggle?.classList.toggle("active", adminSecondaryTabs.has(name));
```

Replace the current `@media (max-width: 900px)` navigation block with rules that show labels and only five destinations:

```css
@media (max-width: 900px) {
  .admin-layout { display: block; padding-bottom: calc(82px + env(safe-area-inset-bottom)); }
  .admin-side { position: fixed; left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right)); bottom: max(8px, env(safe-area-inset-bottom)); z-index: 80; min-height: 0; padding: 6px; border-radius: 18px; flex-direction: row; }
  .admin-side .side-brand, .admin-side .side-foot, .admin-side .side-divider { display: none; }
  .side-nav { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); width: 100%; gap: 2px; }
  .admin-side :is(.tab, .tab-more) { min-width: 0; min-height: 52px; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 2px; padding: 6px 2px; border: 0; border-radius: 11px; background: transparent; }
  .admin-side :is(.tab, .tab-more) .tab-label { display: block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; font-size: 8px; white-space: nowrap; }
  .admin-side .tab-more.active { color: var(--accent); background: rgba(47,107,255,.1); }
  .admin-side .tab[data-tab="activity"], .admin-side .tab[data-tab="create"], .admin-side .tab[data-tab="create-share"], .admin-side #detail-tab { display: none; }
  .admin-mobile-more { position: fixed; left: max(8px, env(safe-area-inset-left)); right: max(8px, env(safe-area-inset-right)); bottom: calc(76px + env(safe-area-inset-bottom)); z-index: 90; display: grid; gap: 7px; max-height: min(66dvh, 560px); overflow-y: auto; padding: 13px; border-radius: 18px; background: var(--panel); box-shadow: 0 24px 70px rgba(6,20,41,.34); }
  .admin-mobile-more[hidden] { display: none; }
  .admin-mobile-more > header { display: flex; align-items: center; justify-content: space-between; }
  .admin-mobile-more > button { min-height: var(--mobile-control); border: 1px solid var(--line); border-radius: 11px; text-align: left; }
  .stat-grid, .link-stat-grid, .share-stat-grid { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  .dashboard-grid, .grid-2, .grid-3 { grid-template-columns: 1fr; }
  .link-action-row, .detail-actions, .pane-actions { gap: 7px; }
  .link-action, .detail-actions .btn, .pane-actions .btn { min-height: var(--mobile-control); }
  :is(.qr-card, .share-edit-card, .folder-picker-panel, .confirm-card) { width: min(100%, calc(100vw - 16px)); max-height: calc(var(--mobile-vh) - max(16px, env(safe-area-inset-top)) - max(16px, env(safe-area-inset-bottom))); overflow-y: auto; margin: auto; }
}
```

- [ ] **Step 4: Run admin, responsive, and full suites**

Run: `node scripts/admin-workflow-test.mjs && node scripts/mobile-responsive-test.mjs && npm test`

Expected: all exit 0.

Verify every admin tab, link-card state, detail page, creation mode, activity filter, folder picker, QR dialog, edit dialog, confirm dialog, and authentication state at 320, 390, 430, 768, and 1024 widths. Confirm the desktop sidebar is unchanged at 1280 px.

- [ ] **Step 5: Commit admin refinements**

```powershell
git add public/admin.html public/admin.js public/style.css scripts/admin-workflow-test.mjs scripts/mobile-responsive-test.mjs
git commit -m "fix: refine admin mobile navigation"
```

### Task 5: Full mobile completion audit

**Files:**
- Modify only files with an observed failing acceptance check.
- Update: `docs/superpowers/specs/2026-07-14-mobile-responsive-design.md` only if implementation reveals a necessary design correction and the user approves that correction.

**Interfaces:**
- Consumes all deliverables from the gallery, viewer/video, and non-share plans.
- Produces a clean full suite and a route-by-route acceptance record in the final handoff.

- [ ] **Step 1: Run static and behavior verification**

Run:

```powershell
npm test
git diff --check
rg -n 'touchHoldTimer|touch-scrubbing|getPreviewVideo\(file\)' public/share.js
```

Expected: `npm test` exits 0; `git diff --check` prints nothing; the `rg` command finds `getPreviewVideo(file)` only in gallery preview/probe paths and finds neither removed touch-scrub identifier.

- [ ] **Step 2: Start the local app and exercise the viewport matrix**

Run: `npm run dev -- --port 8787`

Expected: Wrangler reports a local URL on port 8787.

At 320 × 568, 360 × 800, 390 × 844, 430 × 932, 568 × 320, 768 × 1024, and 1024 × 768, inspect `/`, a populated `/drop/<slug>`, a populated `/s/<slug>`, `/admin`, `/privacy`, and `/terms`.

- [ ] **Step 3: Verify state and input variants**

For applicable routes, repeat checks with coarse touch, fine pointer, reduced motion, phone landscape, keyboard-open fields, safe-area emulation, long filenames/URLs, empty/loading/error/success states, image and video viewer slides, active selection, active upload, and every dialog.

Expected on every pass: no document overflow, no obscured required action, 44 px primary targets, stable gallery order, reliable hold-drag selection, persistent strip, isolated video controls, safe dialogs, and unchanged desktop behavior.

- [ ] **Step 4: Repair each observed discrepancy and rerun its narrow and full checks**

For every failing selector or interaction, first add a reproducing assertion to `scripts/mobile-responsive-test.mjs`, `scripts/share-selection-engine-test.mjs`, `scripts/share-gallery-layout-test.mjs`, `scripts/share-video-session-test.mjs`, `scripts/share-viewer-test.mjs`, or `scripts/admin-workflow-test.mjs`. Run the narrow script to see it fail, apply the smallest route-scoped fix, rerun the narrow script, then run `npm test`.

Expected: each new assertion fails before its fix and passes afterward; the full suite remains green.

- [ ] **Step 5: Commit the verified audit repairs**

```powershell
git add public scripts package.json
git commit -m "fix: close mobile responsive audit gaps"
```

Do not create this commit when the audit produces no additional tracked changes.
