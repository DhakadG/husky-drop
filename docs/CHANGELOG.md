# Changelog

Newest first. Read this before touching the project — it says why things are
the way they are. Goal-by-goal status for the September round lives in
[STATUS.md](STATUS.md); design lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## 2026-09-15 — Realtime feed + auth hardening (PRs #12–#16)

- **#12 auth.** HMAC keys no longer fall back to a constant when
  `ADMIN_TOKEN` is unset (`requireSecret` throws). Admin Google sign-in
  requires `ADMIN_TOKEN`; `email_verified` is enforced; Google failures are
  logged with status + body.
- **#13 worker hot path.** `/api/progress` and `/api/opened` ack before the
  Durable Object relays run (`ctx.waitUntil`, concurrent). No KV read per
  progress tick when the DO is configured. `sessionId` is required on
  `/api/progress` and `/api/session`. Drive quota preflight cached 30 s per
  isolate. `/api/drop/track` writes in one wave.
- **#14 LiveTracker.** Admin sockets get coalesced `patch` deltas instead of
  a full snapshot per tick; sorted snapshot cached. Hibernatable WebSockets
  (`state.acceptWebSocket`, attachment carries the session id);
  `recentDone` persisted; wake sends a fresh snapshot. Rate limiter evicts
  only expired buckets; folder-id cache TTL 6 h; `/events-days` one query.
- **#15 admin lists.** Link/share records read with `Promise.all`.
- **#16 split.** `live.js` (960 lines) → `live.js` + `live-analytics.js`
  (SQLite tables) + `live-digest.js` (`DigestQueue`), per the 500-line rule.
- **#18 split.** `share.js` (1434) → `share.js` / `share-admin.js` /
  `share-token.js` / `share-media.js` / `share-zip.js`; `worker.js` (1113) →
  `worker.js` / `drop-api.js` / `admin-api.js`. Every `src/` file is now
  under 500 lines. `shareSigningKey` gets the same fail-loud secret rule as
  `auth.js` (it still had the `"dev"` fallback).

## 2026-09-15 — Housekeeping

- Repository trimmed to a single `main` branch on GitHub. All September
  feature branches merged and deleted; stale `codex/*` branches and their
  worktrees removed (their content was already in `main` under rebased
  hashes).
- Clerk viewer-auth experiment dropped for good. Viewer sign-in on `/d/` and
  `/s/` stays Google OAuth (`src/auth.js`). Nothing Clerk-related remains in
  the tree; `.dev.vars` / Worker secrets may still hold unused `CLERK_*`
  keys that can be deleted.
- `graphify-out/` (generated knowledge graph) is git-ignored.
- Workflow from here on: branch → PR → CodeRabbit review (`coderabbit review
  --agent --base main`, installed in WSL) → merge → GitHub integration deploys
  the Worker. `npm run deploy` is not part of the loop.

## 2026-09-14 → 15 — Reliability round (PRs #1–#9)

Triggered by: no emails for finished uploads, the upload page stuck on
"Uploading", 2–3 MB/s on a gigabit link, and admin tabs lost on refresh.

- **#1 Emails decided server-side.** The finished-upload digest used to fire
  only when the uploader's browser sent a WebSocket frame with `state: done`.
  `LiveTracker.flushDigests` now decides from Drive-verified `/api/complete`
  calls (8 s settle after done, 90 s idle otherwise). Google account name
  beats the typed name when sign-in is required.
- **#2 One-file-per-second bug.** Every `/api/session` resolved the
  uploader's Drive folder through a per-uploader lock in the Durable Object
  and then re-read a KV cache that had not propagated. `resolveFolderOnce`
  memoises folder ids in DO memory. Client: prefetch a Drive session for
  every open slot, chunks grow at >4 MB/s, `/api/complete` retries, queue
  title counts Drive-saved files as delivered.
- **#3 Admin routes.** `/admin/<tab>` and `/admin/links/<slug>` are real
  URLs; refresh and back keep the tab. Sign-in check is `GET /api/admin/me`
  instead of the full overview (the 3–5 s stall). Overview KV reads run in
  parallel.
- **#4 Drop/share UX.** PIN inputs are `type=text` masked with CSS so
  password managers stay quiet; number pad only for all-digit codes
  (`pinDigits`). Per-uploader-folder links hide the folder picker and flatten
  dropped trees.
- **#5 Overview wording + person timeline.** Plain-English labels
  everywhere; Activity groups one card per person per day across drops and
  shares.
- **#6 Informative emails.** Shared `notifyEmail()` layout: headline, facts,
  file list, dashboard button. Subjects no longer start with "LostHusky's
  DropBox:" — Gmail was soft-bouncing (`550-5.7.1 likely unsolicited`) on the
  Dropbox look-alike subject and two-line body; all delivered since. No DMARC
  needed. Retries carry an `Idempotency-Key`.
- **#7 Saturate fast links.** `pump()` capped bytes in flight at
  `concurrency × chunkSize`, so once chunks grew to 128 MB only 2–4 files ran.
  Parallelism is now a file count (≤12 desktop, ≤8 mobile) under a memory
  window. Queue uploads in folder/natural-name order; finished rows fade in
  place; keep-open banner and Pause hide when everything landed; started
  email says how much is queued; admin "Refresh snapshot" re-arms the socket.
- **#8 Drive picker.** Root crumb no longer duplicated ("My Drive / My
  Drive"), path wraps so the current folder is visible, last six folders
  offered as chips, "Share this drop's folder" button after creating a drop
  (`POST /api/admin/links/:slug/folder`).
- **#9** `docs/STATUS.md`.

Measured: 44 GB / 595 files from a Windows desktop in ~13 min (~56 MB/s avg,
peaks 86 MB/s) versus 2–3 MB/s before.

## 2026-08-11

- `DRIVE_PARENT_ID` moved from a Worker var to a secret.

## 2026-07-14 → 15 — Mobile and viewer hardening

- Local fixture server for share pages (`npm run dev:fixtures`) with
  deterministic media, so the gallery can be developed without Drive.
- Mobile responsive contracts for home, legal, drop, auth and admin pages;
  mobile viewer controls, smart gallery toolbar, two-phase blur slide
  transitions, ranged video streaming, viewer continuity fixes.

## 2026-07-09 → 13 — UI v3

- Full redesign of homepage, admin (unlock, overview, live, drop links,
  detail, activity, share links) and the public uploader; icon fidelity
  audit; Microsoft Clarity + inline-script CSP nonce.

## 2026-07-06 — v2

- transfer.zip-inspired feature set: speed engine (adaptive concurrency,
  resumable Drive sessions, folder upload), outbound share links (gallery +
  redirect modes, PIN, Google sign-in gate, ZIP), analytics, Cloudflare Web
  Analytics beacon, custom domain routing, API/security docs.

## 2026-06-24 — UI 2.0

- Light glassmorphic theme (Unbounded + Plus Jakarta Sans) replacing the dark
  amber theme; all JS hooks preserved.

## 2026-06-12 — v1

- Initial build: Cloudflare Worker control plane, KV metadata, Durable Object
  live progress, browser-to-Drive resumable uploads, PIN-protected drop
  links, admin dashboard, Resend notifications.
