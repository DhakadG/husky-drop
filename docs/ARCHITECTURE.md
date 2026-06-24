# Architecture

```text
friend phone -- ask session --> Worker -- mint session URI --> Drive API
      |                                                         ^
      |                                                         |
      +-- resumable chunk PUTs directly to googleapis.com ------+

friend phone -- live progress WS --> Durable Object <-- admin dashboard WS
Worker/KV <---- low-volume events, counters, upload history ---- Worker
```

File bytes never touch the Worker. The Worker is a control plane: it mints
Drive resumable sessions, enforces PINs and lockouts, records metadata, and
relays live progress.

> **Shipping changes:** push to GitHub, then `npm run deploy` to Cloudflare —
> in that order, every time. See `docs/DEPLOY.md` for the full workflow.

## Live Progress Without KV Write Exhaustion

Claude's initial v2 plan used KV heartbeats every 15 seconds. This workspace
uses a Durable Object instead:

- The uploader opens `GET /api/live/upload/:slug` as a WebSocket.
- The admin opens `GET /api/admin/live?token=...` as a WebSocket.
- `LiveTracker` stores active sessions in memory and broadcasts snapshots.
- `/api/progress` exists only as a fallback and also updates the Durable Object
  in memory.
- KV is not used for repeated progress snapshots.

This removes the KV write-limit risk. The tradeoff is that active progress is
ephemeral if the Durable Object restarts. Uploads still continue because Google
Drive owns the resumable upload session.

## KV Schema

| Key | Value / metadata | TTL |
| --- | --- | --- |
| `link:{slug}` | full link record | expiry + 30 days, or none |
| `stats:{slug}` | `{opens,sessions,files,bytes}` | none |
| `recent:{slug}` | last 200 upload records (deduped by file id) | none |
| `ev:{invTs}:{r}` | event JSON | 90 days |
| `bf:{slug}:{ipHash}` | per-IP brute-force state | 24 hours |
| `bfg:{slug}` | per-link damping state | 2 hours |
| `folder:{slug}:{uploaderHash}` | Drive uploader subfolder cache | 180 days |
| `started:{slug}:{sessionId}` | start notification/event guard | 1 day |
| `gtoken` | cached Google access token | token lifetime |

## Durable Object State

`LiveTracker` keeps:

- Active upload sessions by session ID (with derived speed + ETA).
- Connected admin WebSockets.
- In-memory locks for per-uploader Drive folder creation.
- In-memory first-seen guards for upload session start events.
- Pending completion batches awaiting a KV flush (see below).
- Last update timestamps.

Sessions are pruned after 2 minutes without updates.
Folder locks prevent parallel file-session requests from creating duplicate
uploader folders when the same person uploads multiple files at once. The KV
`started:*` guard remains as durable backup, but the Durable Object handles
same-moment parallel requests before KV consistency can race.

Each progress update is diffed against the previous snapshot to derive a
smoothed throughput (`speed`) and `eta`, plus carries `count`/`done`/`error`
file tallies. The admin dashboard renders these as a live command center
(active uploaders, files in flight, aggregate throughput, ETA) with no KV cost.

## Batched Completion Writes

Recording every finished file directly to KV is the main write-amplifier: one
file cost four writes (`up:` + `recent:` + `stats:` + `ev:`), so a 600-file
phone dump could exceed the free KV daily write allowance on its own.

Completions now flow through the Durable Object:

- `POST /api/complete` still verifies the file against Drive inline, then relays
  the metadata to `LiveTracker` instead of writing KV itself.
- The Durable Object accumulates per-slug `{files, bytes, recents[]}` in memory
  and arms a single alarm (`COMPLETION_FLUSH_MS`, 4s).
- `alarm()` flushes each slug once: `stats:` is incremented, `recent:` is merged
  (deduped by file id, capped at 200), and one aggregated `ev:` event is written.
- The per-file `up:` key is gone entirely. Upload history is served from
  `recent:`; Google Drive remains the durable source for the full archive.

A 600-file transfer therefore costs roughly a handful of KV writes instead of
~2400. The tradeoff matches the live-progress one: counters can lag by the flush
window and a Durable Object eviction mid-window drops at most a few seconds of
increments, but Drive still holds every file. When the Durable Object binding is
absent (e.g. unit tests) completions fall back to immediate inline KV writes.

### Idempotent completions (safe retries)

Completions are de-duplicated by Drive file id so re-sending one never inflates
the totals. This is what makes the client retry/sync buttons safe:

- In the Durable Object, `accumulateCompletion` tracks a `seen` set per pending
  batch and ignores a file id it already holds.
- At flush time, `flushCompletions` reads the existing `recent:` list and only
  moves `stats:` counters for file ids that are genuinely new; the recent list
  is still refreshed (deduped via `mergeRecent`).
- The inline fallback applies the same check before `bumpStats`.

So a file finishing in Drive but failing its dashboard log can be re-sent any
number of times and the counts stay correct. A regression test in
`scripts/smoke-test.mjs` sends the same completion twice and asserts the totals
do not move.

### Admin Drive re-sync

`GET /api/admin/link/:slug?fresh=1` (and `/api/admin/uploads/:slug?fresh=1`)
forces a Drive re-list and rewrites the cached `recent:` list. The admin link
detail "sync from Drive" button uses this to reconcile files that finished in
Drive while their dashboard log was delayed.

## Retry, Cancel, and Sync on the Drop Page

`public/drop.js` tracks a per-file state machine
(`queued → uploading → done | error | warning | canceled`) with O(1) counters.
Every file row exposes contextual actions, and the transfer header exposes
"retry failed" / "cancel all":

- **Cancel** aborts the in-flight `XMLHttpRequest` (`item.xhr.abort()`), so a
  600-file queue can be stopped instantly. An abandoned Drive resumable session
  simply expires on Google's side; nothing to clean up.
- **Retry is dedup-safe.** If the file already has a Drive id, only the
  dashboard record is missing, so the client re-sends `/api/complete` (no
  re-upload). Otherwise nothing was finalized in Drive yet, so the file is
  re-queued and resumes from its last confirmed offset.
- **Dead-session recovery.** If a chunk PUT returns 400/404/410 the resumable
  session is gone; the client mints a fresh session and restarts that one file.
  The old partial was never finalized, so this creates no duplicate.

## Flicker-Free Admin Dashboard

The dashboard refreshes from two sources — a 1s `tickLive` and the Durable
Object WebSocket — plus a 15s overview poll. Earlier versions rebuilt each
section with `innerHTML`, which replayed the panel entrance animation and
collapsed scrollable lists for a frame (the "fade + scrollbar flash").

The renderers now reconcile against the live DOM instead of replacing it:

- `reconcile()` keys rows (live sessions by id, events by composite key, links
  by slug) and reuses existing nodes, only inserting/removing what changed.
- `upsertCards()` patches the stat/metric card values in place, so only the
  numbers that actually changed are touched.
- `scrollbar-gutter: stable` on the scroll areas reserves the gutter so a list
  crossing its max-height never shifts layout.

Because nodes persist across refreshes, the entrance animation only plays for a
genuinely new row, and there is no per-second flicker or scrollbar flash.

## Live Reconnect

Both the uploader and the admin reconnect their WebSocket with capped backoff
(1s → 15s). The admin always reconnects (long-lived dashboard); the uploader
reconnects only while it still has queued or in-flight work. This removes the
"dashboard silently froze" failure where a dropped socket never recovered.

## Large-Batch Upload Performance (client)

`public/drop.js` is built so selecting 600+ files never blocks the main thread:

- **Enqueue is allocation-only** — no DOM is created per file, so even huge
  selections add in a few milliseconds and uploads start on the same frame.
- **O(1) aggregate counters** (`totals`) replace full-queue `reduce`/`filter`
  scans; the hot progress path only mutates numbers.
- **Rendering is coalesced** into one `requestAnimationFrame` pass instead of a
  synchronous repaint per uploaded byte.
- **The file list is bounded** (`MAX_VISIBLE`): only files uploading now, ones
  needing attention, the next queued, and a short tail of finished files keep a
  DOM row. The rest are summarised, so the DOM stays tiny regardless of count.
- **Live progress is lean** — an O(1) summary plus a capped 20-file sample,
  including `count`/`done`/`error`/`speed`, not the entire queue.

## Upload Tuning

Per-link settings:

- `concurrency`: 1-4 parallel files.
- `chunkMB`: 8, 16, or 32 MB.
- `perUploaderFolders`: creates/uses a Drive subfolder per uploader.
- `maxTransferBytes`: defaults to 5 TB.

8/16/32 MB chunk sizes are multiples of Google's required 256 KiB unit.
