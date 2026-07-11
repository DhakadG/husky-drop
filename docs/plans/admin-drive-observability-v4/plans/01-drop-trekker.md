# Drop Trekker Implementation Plan

**Goal:** Create `public/drop-trekker.js` and instrument the uploader with accurate, batched, privacy-bounded session and click telemetry.

## Event contract

Every event is `{v:1,id,t,at,elapsedMs,seq,slug,sessionId,data}`. `at` is UTC epoch milliseconds; `elapsedMs` is monotonic time since tracker construction; `seq` orders events even when wall-clock time changes. Never record PINs, uploader text input contents, tokens, Drive IDs, full URLs, or arbitrary DOM text.

## Change 1 — create the tracker module

**Locate:** no file exists.

**Action:** CREATE `public/drop-trekker.js`.

**Old code:**

```text
File does not exist.
```

**New code:**

```js
(function (global) {
  "use strict";
  const MAX_BATCH = 30;
  const MAX_QUEUE = 180;
  const FLUSH_MS = 5000;

  function safeData(input = {}) {
    const out = {};
    for (const [key, value] of Object.entries(input)) {
      if (!/^(count|bytes|mime|extension|state|reason|attempt|chunk|concurrency|source|control|outcome|durationMs|visibleMs)$/.test(key)) continue;
      out[key] = typeof value === "string" ? value.slice(0, 80) : Number.isFinite(value) ? value : !!value;
    }
    return out;
  }

  function createDropTrekker({ slug, sessionId, endpoint = "/api/drop/track" }) {
    const origin = performance.now();
    const queue = [];
    const spans = new Map();
    let seq = 0;
    let timer = setInterval(() => flush("interval"), FLUSH_MS);

    function track(t, data = {}) {
      queue.push({
        v: 1,
        id: crypto.randomUUID?.() || `${Date.now()}-${++seq}`,
        t: String(t).slice(0, 40),
        at: Date.now(),
        elapsedMs: Math.max(0, Math.round(performance.now() - origin)),
        seq: ++seq,
        slug,
        sessionId,
        data: safeData(data),
      });
      if (queue.length > MAX_QUEUE) queue.splice(0, queue.length - MAX_QUEUE);
      if (queue.length >= MAX_BATCH) flush("capacity");
    }

    function begin(name, key, data = {}) {
      spans.set(`${name}:${key}`, { started: performance.now(), data });
      track(`${name}_started`, data);
    }

    function end(name, key, data = {}) {
      const span = spans.get(`${name}:${key}`);
      spans.delete(`${name}:${key}`);
      track(`${name}_ended`, { ...span?.data, ...data, durationMs: span ? Math.round(performance.now() - span.started) : 0 });
    }

    function flush(reason = "manual", useBeacon = false) {
      if (!queue.length) return;
      const events = queue.splice(0, MAX_BATCH);
      const payload = JSON.stringify({ v: 1, scope: "drop", slug, sessionId, reason, events });
      if (useBeacon && navigator.sendBeacon?.(endpoint, new Blob([payload], { type: "application/json" }))) return;
      fetch(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: payload, keepalive: true }).catch(() => {
        queue.unshift(...events);
        if (queue.length > MAX_QUEUE) queue.length = MAX_QUEUE;
      });
    }

    function destroy() {
      clearInterval(timer);
      timer = null;
      flush("page_exit", true);
    }

    return { track, begin, end, flush, destroy };
  }

  global.createDropTrekker = createDropTrekker;
})(globalThis);
```

## Change 2 — load and initialize it

**Locate:** `public/drop.html`, immediately before `/drop.js`.

**Action:** INSERT.

**Old code:**

```html
<script src="/adaptive-concurrency.js"></script>
<script src="/drop.js"></script>
```

**New code:**

```html
<script src="/adaptive-concurrency.js"></script>
<script src="/drop-trekker.js"></script>
<script src="/drop.js"></script>
```

**Locate:** `public/drop.js`, after `sessionId`.

**Action:** INSERT.

**New code:**

```js
const trekker = createDropTrekker({ slug, sessionId });
trekker.track("session_open", { source: document.referrer ? "referrer" : "direct" });
```

## Change 3 — explicit upload lifecycle calls

**Locate:** `public/drop.js`: `showMain`, `addFiles`, `toggleQueuePause`, `uploadFile`, retry branches, `finalizeComplete`, `maybeQueueNotice`, and page lifecycle handlers.

**Action:** INSERT calls at state transitions, never inside progress callbacks.

**Old code:**

```js
setState(item, "uploading");
// ...
setState(item, "done");
```

**New code:**

```js
trekker.begin("file_upload", item.id, { bytes: item.file.size, mime: item.file.type, extension: fileExtension(item.file.name) });
setState(item, "uploading");
// ... after authoritative /api/complete success
setState(item, "done");
trekker.end("file_upload", item.id, { outcome: "complete", bytes: item.file.size });
```

Add these event names at their single authoritative transitions: `name_confirmed`, `picker_opened`, `folder_picker_opened`, `files_added`, `empty_files_skipped`, `duplicates_skipped`, `queue_paused`, `queue_resumed`, `chunk_retry`, `file_canceled`, `file_failed`, `file_verified`, `resume_found`, `resume_succeeded`, `resume_failed`, `session_complete`, `client_error`, `visibility_hidden`, `visibility_visible`, `page_exit`.

## Change 4 — semantic click capture

**Locate:** `public/drop.js`, `showMain()` after controls are wired.

**Action:** INSERT one delegated listener.

**New code:**

```js
document.addEventListener("click", (event) => {
  const control = event.target.closest("button,a,[role=button],#zone");
  if (!control) return;
  const stable = control.id || control.dataset.action || control.getAttribute("role") || control.tagName.toLowerCase();
  trekker.track("control_clicked", { control: stable, state: control.disabled ? "disabled" : "enabled" });
}, { capture: true });
window.addEventListener("pagehide", () => trekker.destroy(), { once: true });
```

## Change 5 — tests

**Locate:** `scripts/drop-trekker-test.mjs`.

**Action:** CREATE a VM-based test with fake `performance`, `fetch`, `sendBeacon`, and timers. Assert sequence ordering, allowlisted data, batching at 30, queue cap, span duration, failed-flush requeue, and page-exit beacon. Add it to `npm test`.
