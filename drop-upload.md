# Review — `drop-upload`

_agent review (surface) · 2026-09-23_

> The upload engine is the strongest part of the app: direct-to-Drive chunked PUTs with adaptive chunk size and concurrency, IndexedDB resume, a stall watchdog, honest per-file states and Drive-verified completion. The weak link is the duplicate preflight, which only knows the newest 200 completions and only checks the first 500 files - exactly the large re-drop it exists for. Live status also never reports a session as finished when any file was skipped.

## Findings

### HIGH · Make preflight dedupe cover the whole drop and the whole batch

**Where:** src/drop-api.js:427-442 + src/store.js:211-227 (recent:<slug> capped at RECENT_CAP 200) + public/drop.js:489-499 · **Category:** correctness · **Confidence:** 0.85

**When:** An uploader's browser crashed after 700 of 1,500 photos; they reopen the link and drop the same folder again.

**Result:** Preflight compares only against recent:<slug>, which holds the newest 200 completions, and the server only answers for the first 500 files of the request; roughly 500 already-delivered photos are re-uploaded as duplicates in Drive (hours of upload, doubled storage), while the page says nothing was skipped. The 6 s client timeout on a 1,500-entry request can also fail open and skip dedupe entirely.

**Fix:** Keep a per-link completed-file index keyed by name|size(|lastModified) in the Durable Object's SQLite (completions already pass through CompletionQueue) and query it from /api/preflight; on the client send preflight in batches of 500 and apply each batch's results as they return.

### MEDIUM · Report the session as done when nothing is left in flight, not only when every file uploaded

**Where:** public/drop-live.js:238-242 · **Category:** correctness · **Confidence:** 0.8

**When:** An upload of 300 files where 4 were skipped by preflight (or one was canceled).

**Result:** sendLive sends state 'done' only when done + warning === count, so the Durable Object never records the finish: the session never appears in the admin's 'Finished this hour', and it silently disappears from the Live tab two minutes after the last frame - while the uploader's own page says 'Delivered 300 of 300'.

**Fix:** Use the same rule renderSummary uses: state 'done' when totals.count > 0 and queued + checking + uploading === 0 (send error/canceled counts alongside so the admin sees the outcome).

### LOW · Use one session id for telemetry and uploads

**Where:** public/drop-trekker.js:404 vs public/drop-state.js:9-22 · **Category:** interlinking · **Confidence:** 0.7

**When:** An uploader signs in with Google (a full reload) and then uploads.

**Result:** dropTrekker mints a fresh random sessionId per page load while uploads use the sessionStorage-backed one; the admin's 'Upload sessions' log groups by the trekker id, so one visit splits into two cards and none of them matches the session id shown in Live, Activity or the digest email.

**Fix:** Have drop-trekker read the same hd_sid:<slug> sessionStorage value (or have drop-state set window.dropTrekker.sessionId) so every surface keys on one id.

### LOW · Gate /api/complete like /api/session

**Where:** src/drop-api.js:378-396 · **Category:** security · **Confidence:** 0.65

**When:** Someone who knows a PIN-protected drop's slug (but not its PIN), or a paused link, POSTs /api/complete with a Drive file id and its size.

**Result:** logComplete checks neither the PIN nor the link state, and accepts any Drive file that has no dropLink appProperty at all, so the link's history and counters can be padded with files that never came through it.

**Fix:** Run gatePin and reject expired/paused links as createSession does, and require driveFile.appProperties.dropLink === linkId (not merely 'not different').

### LOW · Count dead-session restarts toward the retry limit

**Where:** public/drop-queue.js:189-195 · **Category:** correctness · **Confidence:** 0.6

**When:** Drive keeps answering a chunk PUT with 400 (e.g. a file that changed on disk mid-upload so its bytes no longer match the declared length).

**Result:** err.dead resets the file, mints a new session and `continue`s without incrementing retries, so the file loops forever creating Drive sessions and /api/session calls instead of reaching the error state the uploader could act on.

**Fix:** Increment item.retries (or a separate item.restarts, max 2) on the dead path and throw once exceeded.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| 'What did I already send?' list for returning uploaders | Uploaders on a second visit cannot see what landed last time, so they re-drop everything 'to be safe'. | Drop page, above the drop zone for a returning device | medium | completed-file index per link (see the preflight finding) filtered by device/session |
