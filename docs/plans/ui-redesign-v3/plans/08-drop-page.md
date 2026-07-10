# Plan 08 — Public Drop page uploader experience

**Files touched:** `public/drop.html`, `public/drop.js`, `public/style.css`.
**Depends on:** plan 00 (shared UI 3.0 tokens/components), plan 09 change 1 (admin understands `paused`), and plan 09 B9+B10 (real `ownerName` and safe `budgetHit` in the public link DTO).
**New assets:** none; every icon and progress ring is inline SVG.

This plan preserves all upload endpoints, XHR/resumable behavior, IndexedDB resume records, WebSocket reporting, error reporting, uploader-name gate, and element IDs used by `drop.js`. It changes presentation and adds client-side queue pause/show-all controls only.

---

### Change 1: Replace the page body with the uploader-first mockup structure
**File:** `public/drop.html`
**Why:** Translate `Drop Page.dc.html` into the existing runtime while preserving every JavaScript hook and all real edge-state panels.
**Locate:**
```html
<body class="drop-page">
<div class="ambient"></div>
<div class="toast-stack" id="toasts" aria-live="polite" aria-atomic="true"></div>
<main class="drop-shell">
  <header class="topbar">
```
**Action:** REPLACE
**Old code:**
```html
<body class="drop-page">
<div class="ambient"></div>
<div class="toast-stack" id="toasts" aria-live="polite" aria-atomic="true"></div>
<main class="drop-shell">
  <header class="topbar">
    <a class="brand" href="/"><i class="brand-mark"></i>losthusky<span>/</span>drop</a>
    <div class="status-pill" id="ws-state">secure drop</div>
  </header>

  <section id="loading" class="panel center-panel">
    <p class="eyebrow">loading link</p>
    <h1>Finding this drop...</h1>
  </section>

  <section id="gone" class="panel center-panel hidden">
    <p class="eyebrow">closed</p>
    <h1>This link is not available.</h1>
    <p class="muted">It expired, was deleted, or the URL is incomplete.</p>
  </section>

  <section id="pin-gate" class="panel center-panel hidden">
    <p class="eyebrow">protected link</p>
    <h1 id="pin-label">Password required</h1>
    <div class="field">
      <label for="pin">Password / PIN</label>
      <input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" placeholder="Enter the shared code" />
    </div>
    <button class="btn" id="pin-go">Open drop</button>
    <div class="msg-err" id="pin-err"></div>
  </section>

  <section id="main" class="hidden">
    <div id="resume-banner" class="panel resume-banner hidden">
      <b>You have unfinished uploads from a previous visit.</b>
      <span class="muted">Re-select the same files below and they will continue from where they stopped instead of starting over.</span>
    </div>
    <div class="drop-hero panel">
      <div>
        <img id="link-logo" class="link-logo hidden" alt="" />
        <p class="eyebrow">receive files</p>
        <h1 id="label">Trip drop</h1>
        <p id="welcome" class="hero-copy">Send original photos and videos here.</p>
        <div class="meta-row" id="meta"></div>
      </div>
    </div>

    <div class="grid-main">
      <section class="panel">
        <div class="field">
          <label for="who">Your name</label>
          <input id="who" type="text" autocomplete="name" placeholder="e.g. Riya" maxlength="60" />
        </div>

        <div class="dropzone" id="zone" role="button" tabindex="0" aria-label="Add photos and videos">
          <div class="big">Tap to add photos and videos</div>
          <div class="sub">Original size, HEIC, MOV, folders, and large files are fine.</div>
          <button class="mini hidden" id="folder-btn" type="button">or add a whole folder</button>
        </div>
        <input id="picker" type="file" multiple class="hidden" />
        <input id="folderpicker" type="file" webkitdirectory multiple class="hidden" />

        <div class="security-grid" aria-label="Security notes">
          <div>
            <b>Password gate</b>
            <span>Protected links verify before upload sessions are created.</span>
          </div>
          <div>
            <b>Direct encrypted route</b>
            <span>Uploads move over HTTPS straight to Google Drive.</span>
          </div>
          <div>
            <b>Admin live progress</b>
            <span>Upload progress streams through a live relay, not KV heartbeats.</span>
          </div>
          <div>
            <b>Keep this page open</b>
            <span>iPhones pause long uploads when the browser is closed.</span>
          </div>
        </div>
        <button class="mini report-btn" id="report-btn" type="button">Something not working? Report a problem</button>
      </section>

      <aside class="panel promo hidden" id="promo">
        <p class="eyebrow">message</p>
        <h2 id="promo-title"></h2>
        <p id="promo-text"></p>
        <div id="promo-video" class="promo-video hidden"></div>
        <a id="promo-cta" class="btn ghost hidden" target="_blank" rel="noreferrer">Open</a>
      </aside>
    </div>

    <section class="panel transfer-panel hidden" id="transfer-panel">
      <div class="transfer-head">
        <div>
          <p class="eyebrow">transfer queue</p>
          <h2><span id="pct">0</span>% complete</h2>
        </div>
        <div class="transfer-side">
          <div class="muted" id="detail">waiting</div>
          <div class="transfer-actions">
            <button class="mini hidden" id="retry-all" type="button">retry failed</button>
            <button class="mini danger hidden" id="cancel-all" type="button">cancel all</button>
          </div>
        </div>
      </div>
      <div class="trail total"><i id="totalbar"></i></div>
      <div class="filelist" id="list"></div>
    </section>
  </section>
</main>
<script src="/public.js"></script>
<script src="/drop.js"></script>
</body>
</html>
```
**New code:**
```html
<body class="drop-page">
<div class="bg-fx" aria-hidden="true"><i></i><i></i><i></i></div>
<div class="toast-stack" id="toasts" aria-live="polite" aria-atomic="true"></div>
<main class="drop-shell drop-v3">
  <header class="topbar drop-topbar"><a class="brand" href="/"><i class="brand-mark"></i>losthusky<span class="brand-slash">/</span>drop</a><div class="status-pill secure-pill" id="ws-state"><i aria-hidden="true"></i>secure drop</div></header>

  <section id="loading" class="panel edge-card"><span class="edge-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a9 9 0 1 0 9 9" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"></path></svg></span><p class="eyebrow">loading link</p><h1>Finding this drop…</h1></section>

  <section id="gone" class="panel edge-card hidden"><span class="edge-icon warn"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z" fill="currentColor" opacity=".16"></path><path d="M12 8v5M12 17h.01" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"></path></svg></span><p class="eyebrow">closed</p><h1>This link is not available.</h1><p class="muted">It expired, was deleted, or the URL is incomplete.</p><a class="btn ghost" href="/">Back to losthusky/drop</a></section>

  <section id="pin-gate" class="grad-border edge-gate hidden"><div class="edge-card-inner"><span class="edge-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3" fill="currentColor" opacity=".16"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" fill="none" stroke="currentColor" stroke-width="2"></path></svg></span><p class="eyebrow">protected drop</p><h1 id="pin-label">Password required</h1><p class="muted">Enter the code the collector shared with you.</p><div class="field"><label for="pin">Password / PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="one-time-code" placeholder="Enter shared code" /></div><button class="btn" id="pin-go">Open secure drop</button><div class="msg-err" id="pin-err"></div></div></section>

  <section id="main" class="hidden">
    <div id="resume-banner" class="resume-banner-v3 hidden"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6M20 20v-6h-6M5.5 15A8 8 0 0 0 19 8M18.5 9A8 8 0 0 0 5 16" fill="none" stroke="currentColor" stroke-width="2"></path></svg><span><b>Interrupted before? It resumes.</b><small>Re-select the same files and they continue instead of restarting.</small></span></div>

    <section class="panel collector-hero"><img id="link-logo" class="link-logo hidden" alt="" /><p class="eyebrow" id="collector-name">Your files are being collected</p><h1 id="label">Trip drop</h1><p id="welcome" class="hero-copy">Send original photos and videos here.</p><div class="meta-row" id="meta"></div></section>

    <section class="drop-step name-step"><span class="step-number">1</span><div class="field"><label for="who">What should we call you?</label><input id="who" type="text" autocomplete="name" placeholder="e.g. Riya" maxlength="60" /><small>This name helps the collector find your files.</small></div></section>

    <section class="drop-step upload-step"><span class="step-number">2</span><div class="grad-border dropzone-wrap"><div class="dropzone" id="zone" role="button" tabindex="0" aria-label="Add photos and videos"><span class="dropzone-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 16V4M7 9l5-5 5 5M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path></svg></span><div class="big">Add photos, videos or folders</div><div class="sub">HEIC, MOV, RAW, whole folders and multi-GB files are welcome. Keep adding while uploads run.</div><button class="mini hidden" id="folder-btn" type="button">Add a whole folder</button></div></div></section>
    <input id="picker" type="file" multiple class="hidden" /><input id="folderpicker" type="file" webkitdirectory multiple class="hidden" />

    <aside class="panel promo hidden" id="promo"><p class="eyebrow">message from collector</p><h2 id="promo-title"></h2><p id="promo-text"></p><div id="promo-video" class="promo-video hidden"></div><a id="promo-cta" class="btn ghost hidden" target="_blank" rel="noreferrer">Open</a></aside>

    <section class="panel transfer-panel-v3 hidden" id="transfer-panel">
      <div class="transfer-head-v3"><div class="progress-ring"><svg width="62" height="62" viewBox="0 0 62 62" aria-hidden="true"><circle cx="31" cy="31" r="26" fill="none" stroke="rgba(12,26,43,.08)" stroke-width="6"></circle><circle id="progress-ring-value" cx="31" cy="31" r="26" fill="none" stroke="url(#dropProgressGradient)" stroke-width="6" stroke-linecap="round" stroke-dasharray="163.36" stroke-dashoffset="163.36"></circle><defs><linearGradient id="dropProgressGradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2f6bff"></stop><stop offset="1" stop-color="#15c0c9"></stop></linearGradient></defs></svg><b><span id="pct">0</span>%</b></div><div class="transfer-copy"><p class="eyebrow">transfer queue</p><h2 id="queue-title">Preparing files</h2><div class="muted" id="detail">waiting</div></div><div class="transfer-actions"><button class="mini" id="pause-all" type="button">Pause</button><button class="mini hidden" id="retry-all" type="button">Retry failed</button><button class="mini danger hidden" id="cancel-all" type="button">Cancel all</button></div></div>
      <div class="trail total striped"><i id="totalbar"></i></div>
      <div class="keep-open"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 2.8 20h18.4L12 3Z" fill="currentColor" opacity=".16"></path><path d="M12 8v5M12 17h.01" fill="none" stroke="currentColor" stroke-width="2"></path></svg><span><b>Keep this page open until it finishes.</b> If it closes, return and re-select the same files to resume.</span></div>
      <div id="budget-notice" class="budget-notice hidden"><b>Upload budget reached.</b><span>This link auto-paused to protect the collector’s Drive limit. Files already delivered remain safe.</span></div>
      <div class="filelist" id="list"></div><button class="mini show-all-files hidden" id="show-all-files" type="button"></button>
    </section>

    <section id="done-card" class="grad-border done-card hidden"><div><span class="success-check"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6" fill="none" stroke="currentColor" stroke-width="2.4"></path></svg></span><p class="eyebrow">delivered</p><h2 id="done-title">All files delivered ✓</h2><p id="done-recap" class="muted"></p><button class="btn ghost" id="add-more" type="button">Add more files</button></div></section>

    <section class="trust-strip" aria-label="Transfer promises"><div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" fill="currentColor" opacity=".15"></path><path d="m8 12 3 3 5-6" fill="none" stroke="currentColor" stroke-width="2"></path></svg><span><b>Private link</b><small>Only people with this URL can upload.</small></span></div><div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16v12H4z" fill="currentColor" opacity=".15"></path><path d="M4 7h16M8 4h8M12 11v5M9.5 13.5 12 16l2.5-2.5" fill="none" stroke="currentColor" stroke-width="2"></path></svg><span><b>Direct to Drive</b><small>Original files travel over HTTPS.</small></span></div><div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4v6h6M20 20v-6h-6M5.5 15A8 8 0 0 0 19 8M18.5 9A8 8 0 0 0 5 16" fill="none" stroke="currentColor" stroke-width="2"></path></svg><span><b>Resumable</b><small>Re-pick interrupted files to continue.</small></span></div></section>
    <footer class="drop-footer"><button class="mini report-btn" id="report-btn" type="button">Report a problem</button><span>Powered by losthusky/drop</span></footer>
  </section>
</main>
<script src="/public.js"></script><script src="/drop.js"></script>
</body>
```
**Verify:** All IDs queried by current `drop.js` remain present; PIN/gone/loading/main are still mutually exclusive; uploader name appears before the dropzone; progress, queue, retry/cancel, promo, and report controls remain real.

---

### Change 2: Add queue pause and show-all state
**File:** `public/drop.js`
**Why:** Pause/resume must be surfaced to admin and the visible-list cap needs an explicit user override.
**Locate:**
```js
let liveReconnectDelay = 1000;
let liveConnectedOnce = false;
let lastClientError = "";
let errorReports = 0;

const queue = [];
const MAX_RETRIES = 8;
```
**Action:** REPLACE
**Old code:**
```js
let lastClientError = "";
let errorReports = 0;

const queue = [];
```
**New code:**
```js
let lastClientError = "";
let errorReports = 0;
let queuePaused = false;
let showAllFiles = false;

const queue = [];
```
**Verify:** No console errors before any files are selected.

---

### Change 3: Populate real collector name and wire new controls
**File:** `public/drop.js`
**Why:** The hero must use backend-provided identity, and pause/show-all/add-more need one listener each.
**Locate:**
```js
function showMain() {
  $("main").classList.remove("hidden");
  $("label").textContent = link.label;
  $("welcome").textContent = link.theme?.welcome || "Send original photos and videos here.";

  const meta = $("meta");
```
**Action:** REPLACE
**Old code:**
```js
function showMain() {
  $("main").classList.remove("hidden");
  $("label").textContent = link.label;
  $("welcome").textContent = link.theme?.welcome || "Send original photos and videos here.";

  const meta = $("meta");
```
**New code:**
```js
function showMain() {
  $("main").classList.remove("hidden");
  $("label").textContent = link.label;
  $("collector-name").textContent = link.ownerName ? `${link.ownerName} is collecting` : "Your files are being collected";
  $("welcome").textContent = link.theme?.welcome || "Send original photos and videos here.";

  const meta = $("meta");
```
**Verify:** No personal name is hard-coded in frontend code; the owner line comes from `link.ownerName`, with a truthful generic fallback.

**Locate:**
```js
  $("retry-all").addEventListener("click", retryAll);
  $("cancel-all").addEventListener("click", cancelAll);

  document.addEventListener("visibilitychange", () => {
```
**Action:** REPLACE
**Old code:**
```js
  $("retry-all").addEventListener("click", retryAll);
  $("cancel-all").addEventListener("click", cancelAll);

  document.addEventListener("visibilitychange", () => {
```
**New code:**
```js
  $("retry-all").addEventListener("click", retryAll);
  $("cancel-all").addEventListener("click", cancelAll);
  $("pause-all").addEventListener("click", toggleQueuePause);
  $("show-all-files").addEventListener("click", () => {
    showAllFiles = !showAllFiles;
    schedulePaint();
  });
  $("add-more").addEventListener("click", () => {
    $("done-card").classList.add("hidden");
    if (pickerGate()) $("picker").click();
  });

  document.addEventListener("visibilitychange", () => {
```
**Verify:** New controls work without replacing existing retry/cancel listeners.

---

### Change 3a: Render the correct initial paused edge state
**File:** `public/drop.js`
**Why:** A link already auto-paused by a budget needs the amber explanation, while a manually paused link keeps the neutral notice.
**Locate:**
```js
  link = await r.json();
  if (link.expired) return showGone();
  if (link.paused) return showGone("paused", "This link is paused right now.", "Ask for a fresh link or try again later.");
  document.title = `${link.label} - LostHusky's DropBox`;
  applyTheme(link.theme || {});
  applySettings(link.settings || {});
```
**Action:** REPLACE
**Old code:**
```js
  link = await r.json();
  if (link.expired) return showGone();
  if (link.paused) return showGone("paused", "This link is paused right now.", "Ask for a fresh link or try again later.");
  document.title = `${link.label} - LostHusky's DropBox`;
  applyTheme(link.theme || {});
  applySettings(link.settings || {});
```
**New code:**
```js
  link = await r.json();
  if (link.expired) return showGone("expired", "This drop has closed.", "Ask the collector for a new link.");
  if (link.paused && link.budgetHit) return showGone("budget reached", "This drop reached its upload budget.", "Files already delivered are safe. Ask the collector to raise the limit or reopen the link.");
  if (link.paused) return showGone("paused", "This link is paused right now.", "Ask the collector to reopen it or try again later.");
  document.title = `${link.label} - LostHusky's DropBox`;
  applyTheme(link.theme || {});
  applySettings(link.settings || {});
```
**Verify:** Expired, manual pause, and budget pause show three distinct truthful notices driven only by backend fields.

---

### Change 4: Stop scheduling new files while paused and report pause to admin
**File:** `public/drop.js`
**Why:** Client-side pause must not abort active chunks, but it must stop the queue and appear in the admin live feed.
**Locate:**
```js
}

function pump() {
  const windowBytes = concurrency * chunkSize;
  while (active < MAX_ACTIVE) {
    const next = queue.find((q) => q.state === "queued");
    if (!next) break;
```
**Action:** REPLACE
**Old code:**
```js
function pump() {
  const windowBytes = concurrency * chunkSize;
  while (active < MAX_ACTIVE) {
```
**New code:**
```js
function pump() {
  if (queuePaused) {
    sendLive(true);
    schedulePaint();
    return;
  }
  const windowBytes = concurrency * chunkSize;
  while (active < MAX_ACTIVE) {
```
**Verify:** Pressing Pause allows in-flight chunks to settle but starts no new queued file.

**Locate:**
```js
function setState(item, next) {
  if (item.state === next) return;
  totals[item.state]--;
```
**Action:** INSERT BEFORE
**New code:**
```js
function toggleQueuePause() {
  queuePaused = !queuePaused;
  $("pause-all").textContent = queuePaused ? "Resume" : "Pause";
  $("pause-all").classList.toggle("active", queuePaused);
  sendLive(true);
  schedulePaint();
  if (!queuePaused) pump();
}

```
**Verify:** Pause button toggles to Resume, then resumes queued work when clicked again.

**Locate:**
```js
      speed: Math.round(speedBps),
      state: totals.count && totals.done === totals.count ? "done" : "uploading",
      files: sample,
```
**Action:** REPLACE
**Old code:**
```js
      speed: Math.round(speedBps),
      state: totals.count && totals.done === totals.count ? "done" : "uploading",
      files: sample,
```
**New code:**
```js
      speed: Math.round(speedBps),
      paused: queuePaused,
      state: totals.count && totals.done === totals.count ? "done" : "uploading",
      files: sample,
```
**Verify:** Upload WebSocket progress messages include a real Boolean `paused` consumed by plan 09 change 1.

---

### Change 5: Preserve session HTTP status and show real budget auto-pause
**File:** `public/drop.js`
**Why:** A 413 budget response must trigger the mockup’s amber budget notice, not a generic or fabricated message.
**Locate:**
```js
    body: sessionBody(item),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Error(`locked for ${d.retryAfter || 60}s`);
  if (!r.ok) throw new Error(d.error || `session HTTP ${r.status}`);
  item.uri = d.sessionUri;
  saveResumeRecord(item);
```
**Action:** REPLACE
**Old code:**
```js
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Error(`locked for ${d.retryAfter || 60}s`);
  if (!r.ok) throw new Error(d.error || `session HTTP ${r.status}`);
  item.uri = d.sessionUri;
```
**New code:**
```js
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Error(`locked for ${d.retryAfter || 60}s`);
  if (!r.ok) {
    const error = new Error(d.error || `session HTTP ${r.status}`);
    error.status = r.status;
    throw error;
  }
  item.uri = d.sessionUri;
```
**Verify:** Errors retain the original response status.

**Locate:**
```js
  } catch (err) {
    if (item.canceled) return;
    item.stat = err.message.slice(0, 80);
    setState(item, "error");
```
**Action:** REPLACE
**Old code:**
```js
  } catch (err) {
    if (item.canceled) return;
    item.stat = err.message.slice(0, 80);
    setState(item, "error");
```
**New code:**
```js
  } catch (err) {
    if (item.canceled) return;
    if (err.status === 413) {
      queuePaused = true;
      $("pause-all").textContent = "Resume";
      $("budget-notice").classList.remove("hidden");
    }
    item.stat = err.message.slice(0, 80);
    setState(item, "error");
```
**Verify:** Only a real 413 response displays the budget notice and pauses new queue work.

---

### Change 6: Make “show all” use the actual queue and update its control
**File:** `public/drop.js`
**Why:** The mockup’s show-all button must reveal real files beyond the performance cap.
**Locate:**
```js
}

function visibleItems() {
  const att = attention.length > 50 ? attention.slice(-50) : attention;
  const pinned = uploadingList.length + att.length + doneRecent.length;
  const room = Math.max(0, MAX_VISIBLE - pinned);
  const queued = [];
```
**Action:** INSERT AFTER
**New code:**
```js
  if (showAllFiles) return queue;
```
**Verify:** When `showAllFiles` is true, the renderer receives the complete real queue.

**Locate:**
```js
  const hidden = totals.count - vis.length;
  if (hidden > 0) {
    if (!tailNote) {
      tailNote = document.createElement("div");
```
**Action:** REPLACE
**Old code:**
```js
  const hidden = totals.count - vis.length;
  if (hidden > 0) {
    if (!tailNote) {
      tailNote = document.createElement("div");
      tailNote.className = "list-note";
    }
    tailNote.textContent = `+${hidden} more file${hidden === 1 ? "" : "s"} not shown - totals above stay accurate`;
    list.appendChild(tailNote);
  } else if (tailNote) {
    tailNote.remove();
    tailNote = null;
  }
```
**New code:**
```js
  const hidden = totals.count - vis.length;
  if (tailNote) {
    tailNote.remove();
    tailNote = null;
  }
  const showButton = $("show-all-files");
  showButton.classList.toggle("hidden", hidden <= 0 && !showAllFiles);
  showButton.textContent = showAllFiles ? "Show active and recent only" : `Show all ${totals.count} files`;
```
**Verify:** The button shows the real total count and can collapse back to the optimized view.

---

### Change 7: Drive the progress ring, queue heading, pause status, and done card from totals
**File:** `public/drop.js`
**Why:** New visual elements must be synchronized with the existing authoritative counters.
**Locate:**
```js
function renderSummary() {
  const pct = totals.bytes ? Math.floor((totals.sent / totals.bytes) * 100) : 0;
  $("pct").textContent = pct;
  $("totalbar").style.width = `${pct}%`;
  $("detail").textContent = detailText();

  const failed = totals.error + totals.warning + totals.canceled;
```
**Action:** REPLACE
**Old code:**
```js
function renderSummary() {
  const pct = totals.bytes ? Math.floor((totals.sent / totals.bytes) * 100) : 0;
  $("pct").textContent = pct;
  $("totalbar").style.width = `${pct}%`;
  $("detail").textContent = detailText();

  const failed = totals.error + totals.warning + totals.canceled;
```
**New code:**
```js
function renderSummary() {
  const pct = totals.bytes ? Math.floor((totals.sent / totals.bytes) * 100) : 0;
  $("pct").textContent = pct;
  $("totalbar").style.width = `${pct}%`;
  $("progress-ring-value").style.strokeDashoffset = String(163.36 * (1 - pct / 100));
  $("detail").textContent = queuePaused ? `Paused · ${detailText()}` : detailText();
  $("queue-title").textContent = totals.done === totals.count && totals.count ? `Delivered ${totals.done} of ${totals.count} files` : queuePaused ? `Paused — ${totals.done} of ${totals.count} files delivered` : `Uploading — ${totals.done} of ${totals.count} files`;
  const completed = totals.count > 0 && totals.done === totals.count;
  $("done-card").classList.toggle("hidden", !completed);
  if (completed) {
    $("done-title").textContent = `All ${totals.done} files delivered ✓`;
    $("done-recap").textContent = `${fmtBytes(totals.bytes)} saved to the collector’s Drive.`;
  }

  const failed = totals.error + totals.warning + totals.canceled;
```
**Verify:** Ring, bar, headline, and recap match current totals; completion has no confetti and never appears while failures remain.

---

### Change 8: Add uploader-first, edge-state, queue, trust-strip, and responsive styles
**File:** `public/style.css`
**Why:** Implement the drop mockup and PLAN.md edge states without changing upload logic.
**Locate:**
```css
/* ---------- Admin shell v3 ---------- */
.admin-side {
  border-radius: 24px;
  border: 1px solid var(--glass-border);
  background: var(--glass);
  backdrop-filter: blur(14px);
  box-shadow: var(--shadow-card);
```
**Action:** INSERT BEFORE
**New code:**
```css
/* ---------- Public Drop page v3 ---------- */
.drop-v3 {
  max-width: 980px;
}
.drop-topbar {
  margin-bottom: 28px;
}
.secure-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.secure-pill i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--green);
  box-shadow: 0 0 0 5px rgba(31, 178, 122, 0.1);
  animation: pulseDot 1.8s ease-in-out infinite;
}
.edge-card,
.edge-gate {
  max-width: 520px;
  margin: 12vh auto 0;
  text-align: center;
}
.edge-card {
  padding: 34px;
}
.edge-card-inner {
  border-radius: 22px;
  padding: 34px;
  background: rgba(255, 255, 255, 0.78);
}
.edge-icon {
  width: 52px;
  height: 52px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 16px;
  color: var(--accent);
  background: rgba(47, 107, 255, 0.1);
}
.edge-icon.warn {
  color: var(--amber);
  background: rgba(217, 138, 20, 0.1);
}
.edge-icon svg {
  width: 26px;
  height: 26px;
}
.edge-gate .field {
  text-align: left;
}
.collector-hero {
  position: relative;
  overflow: hidden;
  padding: 30px;
  text-align: center;
}
.collector-hero::after {
  content: "";
  position: absolute;
  width: 240px;
  height: 240px;
  right: -100px;
  bottom: -150px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(21, 192, 201, 0.17), transparent 68%);
}
.collector-hero h1 {
  margin: 7px 0;
  font: 800 clamp(27px, 5vw, 46px) var(--font-display);
  letter-spacing: -0.04em;
}
.collector-hero .meta-row {
  justify-content: center;
}
.resume-banner-v3,
.keep-open,
.budget-notice {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border-radius: 14px;
  padding: 12px 14px;
}
.resume-banner-v3 {
  margin-bottom: 12px;
  color: var(--accent);
  background: rgba(47, 107, 255, 0.09);
}
.resume-banner-v3 svg,
.keep-open svg {
  width: 22px;
  height: 22px;
  flex: 0 0 auto;
}
.resume-banner-v3 b,
.resume-banner-v3 small {
  display: block;
}
.resume-banner-v3 small {
  margin-top: 2px;
  color: var(--ink-soft);
}
.drop-step {
  position: relative;
  margin-top: 16px;
  padding-left: 48px;
}
.step-number {
  position: absolute;
  top: 7px;
  left: 0;
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  color: #fff;
  font: 700 13px var(--font-display);
  background: var(--grad);
  box-shadow: 0 10px 22px -10px rgba(47, 107, 255, 0.7);
}
.name-step {
  max-width: 620px;
  margin-left: auto;
  margin-right: auto;
}
.name-step .field small {
  color: var(--muted);
  font-size: 11px;
}
.dropzone-wrap {
  border-radius: 24px;
}
.drop-v3 .dropzone {
  min-height: 250px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-direction: column;
  border: 0;
  border-radius: 22px;
  padding: 32px;
  background: rgba(255, 255, 255, 0.72);
}
.dropzone-icon {
  width: 58px;
  height: 58px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  color: var(--accent);
  background: rgba(47, 107, 255, 0.1);
  transition: transform 0.18s ease;
}
.dropzone:hover .dropzone-icon,
.dropzone.drag .dropzone-icon {
  transform: translateY(-4px);
}
.dropzone-icon svg {
  width: 29px;
  height: 29px;
}
.transfer-panel-v3 {
  margin-top: 18px;
  padding: 22px;
}
.transfer-head-v3 {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 14px;
}
.progress-ring {
  position: relative;
  width: 62px;
  height: 62px;
}
.progress-ring svg {
  transform: rotate(-90deg);
}
.progress-ring b {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 700 11px var(--font-display);
}
.transfer-copy h2 {
  margin: 3px 0;
  font: 700 17px var(--font-display);
}
.striped > i {
  background: repeating-linear-gradient(120deg, #2f6bff 0 10px, #15c0c9 10px 20px);
  background-size: 28px 100%;
  animation: progressStripe 1s linear infinite;
}
@keyframes progressStripe {
  to { background-position: 28px 0; }
}
.keep-open {
  margin: 14px 0;
  color: #7a5410;
  background: rgba(217, 138, 20, 0.1);
}
.budget-notice {
  flex-direction: column;
  margin: 12px 0;
  color: #7a5410;
  border: 1px solid rgba(217, 138, 20, 0.2);
  background: rgba(217, 138, 20, 0.1);
}
.transfer-panel-v3 .file-row {
  border-radius: 13px;
  padding: 11px 12px;
  background: rgba(255, 255, 255, 0.55);
}
.transfer-panel-v3 .file-row.error {
  border: 1px solid rgba(240, 85, 107, 0.2);
}
.show-all-files {
  display: flex;
  margin: 14px auto 0;
}
.done-card {
  margin-top: 18px;
  text-align: center;
}
.done-card > div {
  border-radius: 22px;
  padding: 30px;
  background: rgba(255, 255, 255, 0.76);
}
.done-card .success-check svg {
  width: 27px;
  height: 27px;
}
.trust-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  margin-top: 18px;
}
.trust-strip > div {
  display: flex;
  gap: 9px;
  border-radius: 15px;
  padding: 13px;
  background: rgba(255, 255, 255, 0.48);
}
.trust-strip svg {
  width: 24px;
  height: 24px;
  flex: 0 0 auto;
  color: var(--accent);
}
.trust-strip b,
.trust-strip small {
  display: block;
}
.trust-strip small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 10.5px;
}
.drop-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 18px 0 36px;
  color: var(--muted);
  font: 10.5px var(--font-mono);
}

@media (max-width: 680px) {
  .drop-v3 {
    padding: 14px;
  }
  .collector-hero,
  .transfer-panel-v3 {
    padding: 17px;
  }
  .drop-step {
    padding-left: 0;
    padding-top: 42px;
  }
  .step-number {
    top: 0;
  }
  .transfer-head-v3 {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .transfer-actions {
    grid-column: 1 / -1;
  }
  .trust-strip {
    grid-template-columns: 1fr;
  }
  .drop-footer {
    align-items: flex-start;
    flex-direction: column;
    gap: 9px;
  }
}
```
**Verify:** Mockup hierarchy and edge states render on desktop; at ≤680px hero/queue/trust areas stack without horizontal scroll; reduced-motion rules from plan 00 stop background and progress animation.

---

## Placeholder data
No mockup collector name, file names, percentages, speeds, or counts are copied. Owner identity comes from plan 09 B9; link title/settings come from `GET /api/link/:slug`; queue data comes from actual selected `File` objects and upload counters; budget notice appears only for an actual HTTP 413.

## Responsive
Change 8 contains the public Drop page’s mobile behavior. It does not depend on or duplicate the admin bottom-tab-bar rules.
