# Share Trekker Implementation Plan

**Goal:** Move embedded share analytics into `public/share-trekker.js` and accurately track gallery navigation, opened-media dwell, selection, download requests, server outcomes, and ZIP outcomes.

## Change 1 — create a dedicated module

**Locate:** `public/share.js:1642`, the current `trackQueue`, `trackEvent()`, and `flushTrack()` block.

**Action:** EXTRACT and REPLACE with `public/share-trekker.js` exposing `createShareTrekker()`. Use the same envelope as Drop Trekker, `scope:"share"`, endpoint `/api/share/track`, 30-event batches, 180-event queue, five-second flush, and data allowlist:

```js
/^(folderIndex|fileId|name|mime|extension|bytes|source|control|outcome|durationMs|visibleMs|selectedCount|status|reason)$/
```

Names are allowed only for files/folders already exposed by the share API; crop to 160 characters. Never record viewer form contents, OAuth parameters, PINs, tokens, signed download URLs, or captions from arbitrary DOM nodes.

**Old code:**

```js
const trackQueue = [];
function trackEvent(t, name) {
  trackQueue.push({ t, name: String(name || "").slice(0, 160) });
}
```

**New code:**

```js
const trekker = createShareTrekker({ slug, sessionId: trackSessionId });
const trackEvent = (t, data = {}) => trekker.track(t, data);
```

## Change 2 — media dwell timing

**Locate:** `public/share.js`, `openMedia()`, PhotoSwipe `change`, and `close` handlers.

**Action:** Keep one active media span and close it before opening the next.

**Old code:**

```js
trackEvent("view", file.name);
```

**New code:**

```js
trekker.openMedia({ fileId: file.id, name: file.name, mime: file.mime, source: "gallery" });
// PhotoSwipe change:
trekker.openMedia({ fileId: current.id, name: current.name, mime: current.mime, source: "swipe" });
// PhotoSwipe close:
trekker.closeMedia("viewer_closed");
```

`openMedia()` must first emit `media_view_ended` for the previous file with `durationMs` and `visibleMs`, then emit `media_view_started`. Visibility changes pause/resume `visibleMs` so background-tab time is not counted as viewing.

## Change 3 — honest download and ZIP outcomes

**Locate:** `downloadFile()`.

**Action:** Rename the client event from `download` to `download_requested`. Do not claim browser success from an anchor click. The backend download handler remains authoritative and emits `download_served` with HTTP status/bytes.

**Locate:** `downloadZip()` and `createZipTicket()`.

**Action:** Emit `zip_requested`, `zip_ticket_created`, `zip_ticket_failed`, and `zip_navigation_started`. The server ZIP stream emits `zip_stream_started`, `zip_stream_completed`, or `zip_stream_failed`; only those events count as success in analytics.

## Change 4 — navigation and selection

**Locate:** folder navigation and selection toggle functions.

**Action:** Emit `folder_opened`, `breadcrumb_clicked`, `selection_changed`, `select_all`, and `selection_cleared` with folder index, stable file ID, and selected count. One delegated `control_clicked` listener records stable IDs/data-actions only.

## Change 5 — HTML and tests

**Locate:** `public/share.html`, before `/share.js`.

**Action:** INSERT `<script src="/share-trekker.js"></script>`.

**Locate:** `scripts/share-trekker-test.mjs`.

**Action:** CREATE tests for media-switch timing, hidden-tab exclusion, exactly-once close, batch requeue, safe-data filtering, and the distinction between request and server-confirmed outcomes. Add to `npm test`.
