# Review — `admin-live`

_agent review (surface) · 2026-09-23_

> The live plumbing is solid: coalesced deltas, hibernation-safe snapshots, completions de-duplicated and batched. The surface itself only shows the happy path - a session whose socket drops or that ends in errors vanishes instead of being surfaced, 'dismiss' does not stick, and 'Finished this hour' can show sessions from yesterday.

## Findings

### MEDIUM · Show stalled and disconnected sessions instead of hiding them

**Where:** public/admin-live.js:6 + src/live.js:328-333 · **Category:** ux · **Confidence:** 0.75

**When:** An uploader's tab crashes or loses network mid-transfer; webSocketClose marks the session 'stale', and renderLive() filters to state === 'uploading'.

**Result:** The one session the admin most needs to see - someone whose upload died at 60% - disappears from the Live tab at once, never appears under 'Finished this hour', and is pruned from the DO two minutes later with no trace on this surface.

**Fix:** Render sessions with state 'stale' or 'error' in a 'Stopped' group below the active list (reusing makeLiveRow with a muted class and 'last seen Xs ago'), and on prune() push a summary with outcome 'stopped' into recentDone the same way noteFinished() does.

### MEDIUM · Make 'dismiss' stick, or remove it

**Where:** src/live.js:197-208 and 562-602 · **Category:** correctness · **Confidence:** 0.75

**When:** Admin clicks 'dismiss' on a session that is still uploading.

**Result:** /close deletes the session, but the uploader's next progress frame (~1.2 s later) goes through recordSession() and recreates it, so the card reappears; the button looks broken.

**Fix:** Keep a `dismissed` Map of session id -> expiry (e.g. 10 min) in the DO; /close adds to it and recordProgress() returns early for dismissed ids (still feeding digests). Alternatively label the button 'hide' and keep the hidden ids client-side only.

### MEDIUM · Write stats before the recent list so a failed flush cannot drop counts

**Where:** src/live-completions.js:94-100 · **Category:** correctness · **Confidence:** 0.7

**When:** The recent:<slug> put succeeds but the stats:<slug> put throws (KV write limit, transient error); flush() requeues the batch.

**Result:** On retry every file id is already in recent:<slug>, newFiles is 0, and flushOne returns before touching stats - those files and bytes are permanently missing from the link's counters and the day rollup.

**Fix:** Compute newFiles/newBytes, put stats:<slug> and bumpDay first, then put recent:<slug>; a retry after a failed recent put then at worst re-adds rows that mergeRecent de-duplicates.

### LOW · Apply the one-hour cutoff when recentDone is read, not only when a session finishes

**Where:** src/live.js:607-622, 127, 282 · **Category:** correctness · **Confidence:** 0.8

**When:** The last upload finished yesterday afternoon and nothing has finished since.

**Result:** 'Finished this hour' still lists yesterday's sessions, and 'Last completed' reads like it just happened.

**Fix:** Filter recentDone by endedAt >= now - 3600_000 in /snapshot, the admin-socket snapshot and wake(); client-side, filter liveRecent the same way in renderLive().

### LOW · Stop re-rendering every live card once a second

**Where:** public/admin.js:261 (tickLive) + public/admin-live.js:79-82 · **Category:** ux · **Confidence:** 0.65

**When:** A keyboard or screen-reader admin tabs to the 'dismiss' or 'Drive folder' button on a live card.

**Result:** tickLive() calls updateLiveRow(), which replaces the card's innerHTML every second even when nothing changed, so focus and hover are lost and the button can be swapped out between mousedown and click.

**Fix:** Drop the 1 s tickLive re-render (nothing in the cards is time-relative) and render only on socket messages; or in updateLiveRow compare a cheap signature (pct, sent, state, files length) against el._sig before writing innerHTML.

## Layout

- Order the Live tab as: active sessions, stopped sessions, finished this hour - the current empty-state card duplicates 'Last completed' and the finished list when both are visible.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Stopped / failed sessions group | An uploader messages 'it stopped working' - the admin needs to see which session died, at which file, and when. | Live tab, under the active list | small | already available (sessions with state 'stale' live in the DO for 2 min; telemetry has the error events) |
| Per-file error reason on the live card | A file row turns red with no reason; the error code (E_STALL, E_QUOTA...) is already in the client taxonomy. | Live tab file rows | small | progress frames would need to carry file.error |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Finished-this-hour row | Link detail upload-session log for that session id | goes straight from 'someone finished' to what they sent |
| Uploader name/avatar on a live card | People profile (data-open-person) | tells the admin who this is and what they sent before |
| Live card 'Drive folder' button | the uploader's own subfolder, not the link root | the root folder holds every uploader's files |
