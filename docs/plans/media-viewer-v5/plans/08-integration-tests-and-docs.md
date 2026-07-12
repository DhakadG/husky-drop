# Plan 08 — Integration verification and viewer documentation

**Files touched:** `package.json`, `scripts/share-viewer-engine-test.mjs`, `scripts/share-viewer-test.mjs`, `scripts/smoke-test.mjs`, `scripts/icon-audit-test.mjs`, `docs/LIGHTBOX-FEATURE-COMPARISON.md`.
**Depends on:** plans 00–07.
**New assets:** `scripts/share-viewer-engine-test.mjs`.

---

### Change 1: Add real state-machine behavior tests

**File:** `scripts/share-viewer-engine-test.mjs`

**Why:** Regex assertions cannot prove timing, cancellation, or resource guards.

**Locate:** File does not exist.

**Action:** CREATE.

**New code:**

```js
import assert from "node:assert/strict";
import { createAssetState, createRapidSurfController, createViewerAssetEngine } from "../public/share-viewer-engine.js";

function fakeClock() {
  let now = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(fn, delay) { const key = ++id; timers.set(key, { at: now + delay, fn }); return key; },
    clearTimeout(key) { timers.delete(key); },
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      now = end;
    },
  };
}

{
  const clock = fakeClock();
  const changes = [];
  const rapid = createRapidSurfController({ ...clock, onChange: (state) => changes.push(state) });
  for (let i = 0; i < 3; i++) { rapid.note("key"); clock.tick(100); }
  assert.equal(rapid.active, false);
  rapid.note("key");
  assert.equal(rapid.active, true);
  rapid.release("keyup");
  clock.tick(259);
  assert.equal(rapid.active, true);
  clock.tick(1);
  assert.equal(rapid.active, false);
  assert.deepEqual(changes.map((state) => state.active), [true, false]);
}

{
  const clock = fakeClock();
  const calls = [];
  const states = [];
  const engine = createViewerAssetEngine({
    ...clock,
    loadTier: async (file, tier) => { calls.push(`${file.id}:${tier}`); },
    onChange: (state) => states.push(state),
  });
  const file = { id: "photo-1" };
  await engine.activate(file);
  assert.deepEqual(calls, ["photo-1:base", "photo-1:mid", "photo-1:max"]);
  clock.tick(5999);
  await Promise.resolve();
  assert.equal(calls.includes("photo-1:full"), false);
  clock.tick(1);
  await Promise.resolve();
  assert.equal(calls.at(-1), "photo-1:full");
  assert.equal(states.some((state) => state.intentStep === 6), true);
}

{
  const state = createAssetState("x");
  assert.equal(state.tier, "empty");
  assert.equal(state.intentSteps, 6);
}

console.log("share viewer engine tests passed");
```

**Verify:** The test fails before the engine exists and passes only when thresholds/timing/order match the design.

---

### Change 2: Run engine tests in the repository suite

**File:** `package.json`

**Why:** State-machine regressions must block releases.

**Locate:**

```json
"test": "node scripts/smoke-test.mjs && node scripts/ui-v3-test.mjs && node scripts/icon-audit-test.mjs && node scripts/admin-workflow-test.mjs && node scripts/readme-test.mjs && node scripts/share-viewer-test.mjs"
```

**Action:** REPLACE.

**Old code:**

```json
"test": "node scripts/smoke-test.mjs && node scripts/ui-v3-test.mjs && node scripts/icon-audit-test.mjs && node scripts/admin-workflow-test.mjs && node scripts/readme-test.mjs && node scripts/share-viewer-test.mjs"
```

**New code:**

```json
"test": "node scripts/smoke-test.mjs && node scripts/ui-v3-test.mjs && node scripts/icon-audit-test.mjs && node scripts/admin-workflow-test.mjs && node scripts/readme-test.mjs && node scripts/share-viewer-engine-test.mjs && node scripts/share-viewer-test.mjs"
```

**Verify:** `npm test` runs the engine test before viewer integration assertions.

---

### Change 3: Replace obsolete Immediate-only assertions

**File:** `scripts/share-viewer-test.mjs`

**Why:** Existing assertions forbid transitions entirely and do not cover the new controls.

**Locate:**

```js
assert.match(shareJs, /showHideAnimationType:\s*"none"/);
assert.match(shareJs, /function formatShutterSpeed/);
```

**Action:** REPLACE and INSERT required integration checks.

**Old code:**

```js
assert.match(shareJs, /showHideAnimationType:\s*"none"/);
```

**New code:**

```js
assert.match(shareJs, /showHideAnimationType:\s*"none"/); // viewer open/close remains immediate
assert.match(shareJs, /VIEWER_MOTION_MODES/);
assert.match(shareJs, /enabled:\s*false/);
assert.match(shareJs, /motion-settings-button/);
assert.match(shareJs, /asset-ladder/);
assert.match(shareJs, /toggleFileInfoPin/);
assert.match(shareJs, /aria-keyshortcuts/);
assert.match(shareJs, /rotateCurrentMedia/);
assert.match(shareJs, /resetCurrentRotation/);
assert.doesNotMatch(shareJs, /function warmNeighbors/);
```

**Verify:** The test permits opt-in slide effects but keeps opening/closing Immediate and prevents neighbor originals.

---

### Change 4: Add backend confidentiality/cache assertions

**File:** `scripts/smoke-test.mjs`

**Why:** The tier proxy must not regress into leaking raw Drive URLs or accepting arbitrary sizes.

**Locate:** The existing share-route assertions around `/api/share/file-info` and `/api/share/dl/`.

**Action:** INSERT AFTER.

**New code:**

```js
assert.match(workerSource, /\/api\/share\/thumb\//);
assert.match(shareSource, /export async function shareThumbnail/);
assert.match(shareSource, /verifyShareToken\(env, token, "th"\)/);
assert.match(shareSource, /modifiedTime/);
assert.match(driveSource, /DRIVE_THUMB_SIZES/);
assert.match(driveSource, /authorization:\s*`Bearer \$\{tok\}`/);
assert.doesNotMatch(shareSource.match(/async function publicShareFile[\s\S]*?\n\}/)?.[0] || "", /thumb:\s*f\.thumbnailLink/);
```

**Verify:** Tests fail if listing returns raw Google URLs or the route loses scope validation.

---

### Change 5: Update the feature comparison only after behavior exists

**File:** `docs/LIGHTBOX-FEATURE-COMPARISON.md`

**Why:** Documentation must distinguish implemented v5 features from remaining lightGallery gaps.

**Locate:**

```md
| Native fullscreen | Not yet | Yes, through Fullscreen | High-value next addition. |
```

**Action:** Keep truthful remaining gaps and update rows for transitions, rotation, thumbnails, and loading only after browser verification.

**New code:**

```md
| Intent-aware resolution | Base/Mid/Max/Full with a six-second intent gate | Responsive sources and preload | Husky Drop adds explicit bandwidth guarding and visible tier state. |
| Rapid browsing | Thumbnail-only frequency/hold throttle | Preload and bounded DOM | Husky Drop advantage for very large Drive galleries. |
| Rotate left/right/reset | Yes, with per-file angle state | Yes, through Rotate | Equivalent core transform; Husky Drop exposes angle status. |
| Animated slide transitions | Optional nine-mode PhotoSwipe layer; Immediate by default | 31 core modes | Husky Drop remains speed-first and disables effects during rapid surf. |
```

**Verify:** No row claims fullscreen, autoplay, flip, hash, or social sharing unless those features are actually implemented.

## Browser verification script

1. Open a share containing at least 30 images and keep Network throttling available.
2. Hold Right Arrow for two seconds: slides advance without visible blanking; Base remains the active tier; no original `?inline=1` requests begin for traversed slides.
3. Release on one slide: Mid then Max appear; six intent cells fill over six seconds; Full starts only afterward and turns green after decode.
4. Press `I`, interact with the image, and confirm unpinned drawer closes. Press `I`, click Pin, navigate/rotate, and confirm it stays open and refreshes metadata.
5. Press `]` and confirm 140 ms turn, angle badge, and reset control. Press `0`; both contextual controls disappear.
6. Enable each motion preset and vary 80/180/700 ms. Confirm rapid mode and reduced motion remain Immediate.
7. Repeat at 390×844 viewport; ensure toolbar, ladder, EXIF actions, motion settings, and filmstrip remain reachable.

## Release gates

```powershell
node --check public/share.js
node scripts/share-viewer-engine-test.mjs
npm test
git diff --check
npx wrangler deploy --dry-run
```

Expected: every command exits 0; no failing assertion, syntax error, or Worker bundle error.

## Responsive and accessibility

- Test keyboard-only focus order, screen-reader status text, `aria-pressed`, `aria-keyshortcuts`, and reduced motion.
- Confirm no live region announces every LED animation frame.

## Placeholder data

Docs and tests describe only implemented behavior. No sample cache states, EXIF values, or transition availability may be presented as live data.
