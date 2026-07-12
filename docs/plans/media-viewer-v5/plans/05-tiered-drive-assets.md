# Plan 05 — Signed tiered Drive asset delivery

**Files touched:** `src/drive.js`, `src/share.js`, `src/worker.js`, `public/share.js`, `public/share-viewer-engine.js`, `scripts/smoke-test.mjs`, `scripts/share-viewer-engine-test.mjs`.
**Depends on:** none; this provides the asset interfaces consumed by plans 04 and 06.
**New assets:** `public/share-viewer-engine.js`, `scripts/share-viewer-engine-test.mjs`.

---

### Change 1: Add a guarded server-side Drive thumbnail fetcher

**File:** `src/drive.js`

**Why:** Google documents `thumbnailLink` as short-lived and not intended for direct web use. OAuth credentials and upstream URLs must remain server-side.

**Locate:**

```js
export async function driveFileMeta(env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
```

**Action:** INSERT AFTER the complete `driveFileMeta()` function.

**New code:**

```js
const DRIVE_THUMB_SIZES = Object.freeze({ base: 512, mid: 1024, max: 1600 });
const DRIVE_THUMB_HOSTS = new Set(["lh3.googleusercontent.com", "lh4.googleusercontent.com", "lh5.googleusercontent.com", "lh6.googleusercontent.com"]);

export function driveThumbnailSize(tier) {
  return DRIVE_THUMB_SIZES[tier] || 0;
}

export function scaleDriveThumbnailUrl(value, size) {
  const url = new URL(String(value || ""));
  if (!DRIVE_THUMB_HOSTS.has(url.hostname)) throw new Error("unsupported Drive thumbnail host");
  const scaled = url.href.replace(/=s\d+(?:-[a-z0-9-]+)?$/i, `=s${size}`);
  return scaled === url.href ? url.href : scaled;
}

export async function driveThumbnail(env, meta, tier) {
  const size = driveThumbnailSize(tier);
  if (!size || !meta?.id || !meta.thumbnailLink) return null;
  const tok = await accessToken(env);
  const original = String(meta.thumbnailLink);
  const scaled = scaleDriveThumbnailUrl(original, size);
  let response = await fetch(scaled, { headers: { authorization: `Bearer ${tok}` } });
  if (!response.ok && scaled !== original) response = await fetch(original, { headers: { authorization: `Bearer ${tok}` } });
  if (!response.ok || !response.body || !/^image\//i.test(response.headers.get("content-type") || "")) return null;
  return { response, meta, size, tier };
}
```

**Verify:** Only the three named tiers and allowlisted Google image hosts are accepted; an unsupported rewrite retries the original URL; no Google URL is returned to the browser.

---

### Change 2: Return app-owned tier URLs from the share listing

**File:** `src/share.js`

**Why:** The browser needs stable Base/Mid/Max capabilities, not a raw expiring Google link.

**Locate:**

```js
async function publicShareFile(env, share, f) {
  const { token, expiresAt } = await signShareTokenWithExpiry(env, "dl", share.slug, f.id);
```

**Action:** REPLACE the token declaration and `thumb` response field.

**Old code:**

```js
  const { token, expiresAt } = await signShareTokenWithExpiry(env, "dl", share.slug, f.id);
```

**New code:**

```js
  const [{ token, expiresAt }, { token: thumbToken, expiresAt: thumbsExpireAt }] = await Promise.all([
    signShareTokenWithExpiry(env, "dl", share.slug, f.id),
    signShareTokenWithExpiry(env, "th", share.slug, f.id),
  ]);
  const thumbs = f.thumbnailLink
    ? Object.fromEntries(["base", "mid", "max"].map((tier) => [tier, `/api/share/thumb/${thumbToken}/${tier}`]))
    : {};
```

**Old code:**

```js
    thumb: f.thumbnailLink || "",
```

**New code:**

```js
    thumb: thumbs.base || "",
    thumbs,
    thumbsExpireAt,
```

**Verify:** Listing JSON contains only same-origin paths; every tier token is bound to share/file/scope and expires.

---

### Change 3: Add a revision-aware cached thumbnail route

**File:** `src/share.js`

**Why:** Thumbnail bytes should be cached by file revision and tier while share/auth checks remain authoritative.

**Locate:**

```js
export async function shareDownload(request, env, token, ctx) {
  const parsed = await verifyShareToken(env, token, "dl");
```

**Action:** INSERT BEFORE.

**New code:**

```js
export async function shareThumbnail(request, env, token, tier, ctx) {
  const parsed = await verifyShareToken(env, token, "th");
  if (!parsed) return json({ error: "invalid or expired thumbnail token" }, 403);
  const { share, error } = await loadActiveShare(env, parsed.slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);
  const meta = await driveFileMeta(env, parsed.fileId);
  if (!meta?.id || !meta.thumbnailLink) return json({ error: "thumbnail unavailable" }, 404);
  const revision = encodeURIComponent(meta.modifiedTime || "0");
  const cache = caches.default;
  const cacheKey = new Request(`https://media.internal.share/thumb/${parsed.fileId}/${tier}/${revision}`);
  const hit = await cache.match(cacheKey);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("cache-control", "private, max-age=900");
    return new Response(hit.body, { status: 200, headers });
  }
  const asset = await driveThumbnail(env, meta, tier);
  if (!asset) return json({ error: "thumbnail unavailable" }, 404);
  const headers = new Headers({
    "content-type": asset.response.headers.get("content-type") || "image/jpeg",
    "cache-control": "private, max-age=900",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-husky-asset-tier": tier,
  });
  const [clientBody, cacheBody] = asset.response.body.tee();
  const storedHeaders = new Headers(headers);
  storedHeaders.set("cache-control", "public, max-age=86400");
  const write = cache.put(cacheKey, new Response(cacheBody, { status: 200, headers: storedHeaders }));
  if (ctx?.waitUntil) ctx.waitUntil(write);
  else await write;
  return new Response(clientBody, { status: 200, headers });
}
```

Add `driveThumbnail` to the `src/drive.js` import.

**Verify:** Invalid scopes/sizes fail; cache key includes modified time and tier; upstream body is not read twice; browser response does not expose Google URLs.

---

### Change 4: Route thumbnail requests through the Worker

**File:** `src/worker.js`

**Why:** The new handler must be reachable without creating another page or service.

**Locate:**

```js
  shareFileInfo,
  shareDownload,
  shareRedirect,
```

**Action:** INSERT `shareThumbnail,` after `shareDownload,`, then add the route before `/api/share/dl/`.

**New code:**

```js
  if (m === "GET" && p.startsWith("/api/share/thumb/")) {
    const rest = p.slice("/api/share/thumb/".length).split("/");
    if (rest.length !== 2) return json({ error: "invalid thumbnail path" }, 400);
    return shareThumbnail(request, env, rest[0], rest[1], ctx);
  }
```

**Verify:** `/api/share/thumb/<token>/<tier>` resolves before static assets and never enters the admin route group.

---

### Change 5: Refresh download and thumbnail capabilities together

**File:** `src/share.js`

**Why:** Viewer sessions can outlive 15-minute tokens; refreshing only `dl` would leave tier URLs expired.

**Locate:**

```js
  const { token, expiresAt } = await signShareTokenWithExpiry(env, "dl", share.slug, parsed.fileId);
  return json({ dl: `/api/share/dl/${token}`, dlExpiresAt: expiresAt });
```

**Action:** REPLACE.

**Old code:**

```js
  const { token, expiresAt } = await signShareTokenWithExpiry(env, "dl", share.slug, parsed.fileId);
  return json({ dl: `/api/share/dl/${token}`, dlExpiresAt: expiresAt });
```

**New code:**

```js
  const [{ token, expiresAt }, { token: thumbToken, expiresAt: thumbsExpireAt }] = await Promise.all([
    signShareTokenWithExpiry(env, "dl", share.slug, parsed.fileId),
    signShareTokenWithExpiry(env, "th", share.slug, parsed.fileId),
  ]);
  return json({
    dl: `/api/share/dl/${token}`,
    dlExpiresAt: expiresAt,
    thumbs: Object.fromEntries(["base", "mid", "max"].map((tier) => [tier, `/api/share/thumb/${thumbToken}/${tier}`])),
    thumbsExpireAt,
  });
```

**Verify:** Refresh rechecks share state/auth/PIN once and returns synchronized capabilities.

---

### Change 6: Consume named tier URLs in the client

**File:** `public/share.js`

**Why:** Size arithmetic belongs to the backend policy, while data-URL video captures remain supported.

**Locate:**

```js
function thumbUrl(file, size) {
  if (!file.thumb) return "";
  if (/^data:/i.test(file.thumb)) return file.thumb;
  return file.thumb.replace(/=s\d+(-c)?$/, `=s${size}`);
}
```

**Action:** REPLACE.

**Old code:**

```js
function thumbUrl(file, size) {
  if (!file.thumb) return "";
  if (/^data:/i.test(file.thumb)) return file.thumb;
  return file.thumb.replace(/=s\d+(-c)?$/, `=s${size}`);
}
```

**New code:**

```js
function thumbTierForSize(size) {
  return size <= 512 ? "base" : size <= 1280 ? "mid" : "max";
}

function thumbUrl(file, sizeOrTier = "base") {
  if (/^data:/i.test(file.thumb || "")) return file.thumb;
  const tier = typeof sizeOrTier === "string" ? sizeOrTier : thumbTierForSize(sizeOrTier);
  return file.thumbs?.[tier] || file.thumb || "";
}
```

Extend `ensureFreshDownload()`:

```js
  file.thumbs = d.thumbs || file.thumbs;
  file.thumbsExpireAt = d.thumbsExpireAt || file.thumbsExpireAt;
  file.thumb = file.thumbs?.base || file.thumb;
```

**Verify:** Gallery/filmstrip use Base; lightbox uses Mid then Max; captured data URLs bypass proxy tiering.

---

### Change 7: Add the intent-aware asset engine

**File:** `public/share-viewer-engine.js`

**Why:** Tier promotion, abort ownership, dwell timing, and LRU cleanup need one deterministic owner.

**Locate:** After the rapid controller from plan 04.

**Action:** INSERT AFTER.

**New code:**

```js
export const ASSET_TIERS = ["empty", "base", "mid", "max", "full"];
export const INTENT_STEPS = 6;
export const INTENT_STEP_MS = 1000;

export function createAssetState(fileId) {
  return { fileId, tier: "empty", loading: "", intentStep: 0, intentSteps: INTENT_STEPS, rapid: false, error: "", progress: 0 };
}

export function createViewerAssetEngine(options = {}) {
  const records = new Map();
  const schedule = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;
  const loadTier = options.loadTier;
  const onChange = options.onChange || (() => {});
  let activeId = "";
  let rapid = false;
  let intentTimer = 0;
  let intentOwner = "";

  const recordFor = (file) => {
    if (!records.has(file.id)) records.set(file.id, createAssetState(file.id));
    return records.get(file.id);
  };
  const emit = (record) => onChange({ ...record });
  const stopIntent = () => {
    cancelTimer(intentTimer);
    intentTimer = 0;
    intentOwner = "";
  };
  const ensure = async (file, tier) => {
    const record = recordFor(file);
    if (ASSET_TIERS.indexOf(record.tier) >= ASSET_TIERS.indexOf(tier)) return true;
    record.loading = tier;
    record.error = "";
    emit(record);
    try {
      await loadTier(file, tier, (progress) => { record.progress = progress; emit(record); });
      record.tier = tier;
      record.loading = "";
      record.progress = 1;
      emit(record);
      return true;
    } catch (error) {
      if (error?.name !== "AbortError") record.error = String(error?.message || error);
      record.loading = "";
      emit(record);
      return false;
    }
  };
  const tickIntent = (file) => {
    const record = recordFor(file);
    if (rapid || activeId !== file.id || intentOwner !== file.id) return stopIntent();
    record.intentStep += 1;
    emit(record);
    if (record.intentStep >= INTENT_STEPS) return stopIntent(), ensure(file, "full");
    intentTimer = schedule(() => tickIntent(file), INTENT_STEP_MS);
  };
  return {
    async activate(file) {
      activeId = file.id;
      stopIntent();
      const record = recordFor(file);
      record.rapid = rapid;
      record.intentStep = 0;
      await ensure(file, "base");
      if (rapid || activeId !== file.id) return record;
      await ensure(file, "mid");
      if (rapid || activeId !== file.id) return record;
      await ensure(file, "max");
      if (rapid || activeId !== file.id) return record;
      intentOwner = file.id;
      intentTimer = schedule(() => tickIntent(file), INTENT_STEP_MS);
      return record;
    },
    setRapid(value) {
      rapid = Boolean(value);
      if (rapid) stopIntent();
      for (const record of records.values()) record.rapid = rapid;
    },
    deactivate(fileId) { if (activeId === fileId) activeId = ""; stopIntent(); options.abort?.(fileId); },
    ensureFull(file) { stopIntent(); return ensure(file, "full"); },
    stateFor(file) { return { ...recordFor(file) }; },
    destroy() { activeId = ""; stopIntent(); options.destroy?.(); records.clear(); },
  };
}
```

**Verify:** Full cannot start before six stable ticks unless `ensureFull()` is explicit; deactivation cancels timers and aborts ownership.

## Tests

- Mock Drive OAuth fetches and assert no upstream URL leaks.
- Assert tier allowlist, host allowlist, fallback fetch, revision cache key, and response headers.
- Unit-test Base → Mid → Max order, six-second intent, cancellation, explicit Full, failure fallback, and destroy.
- Assert no `warmNeighbors()` or immediate original `warmImage(file)` remains.

## Responsive and accessibility

Tier selection is independent of layout. Mid may choose 1024 on compact viewports and 1280 on high-DPI desktop, but the public route names remain stable.

## Placeholder data

Never claim Drive guarantees a 1600 px derivative. Max is a best-effort tier; the last successful lower tier remains visible on failure.
