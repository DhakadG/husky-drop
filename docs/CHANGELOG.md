# Changelog

Newest first. Read this before touching the project — it says why things are
the way they are. Goal-by-goal status for the September round lives in
[STATUS.md](STATUS.md); design lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## 2026-09-16 — Density slider v2, smooth playback bars (PR #39)

- Gallery density is continuous: 1-9 in quarter steps, tile size
  interpolated between the old nine stops. Mouse wheel over the slider
  nudges a step, double-click resets to Balanced. The text-input focus box
  that leaked onto the range is gone.
- Tile play glyph scales with the tile (`20cqw`, 18-44 px) instead of a
  fixed 40 px that swamped dense grids.
- Hover-preview played bar and the viewer seek bar update from
  `requestAnimationFrame` while playing; `timeupdate` alone fires ~4x/s and
  looked stepped.

## 2026-09-16 — Hot video tiles (PR #38)

- Video tiles actually inside the viewport (second, margin-less
  IntersectionObserver) switch their warm element to `preload="auto"` so the
  opening seconds are buffered before the pointer arrives; capped at 4, off
  under Save-Data, back to `metadata` when scrolled away. The remaining
  hover delay on 4K originals is Drive's ~0.7-1.3 s Range TTFB.

## 2026-09-16 — Media metadata memo (PR #37)

- `driveFileMetaCached`: share media routes (thumbnails, inline/Range
  downloads, file info) memoise Drive file metadata for 2 minutes per
  isolate. Every Range slice of a video was paying a full Drive metadata
  round trip (~400 ms) before the byte fetch; measured TTFB on a 1 MB slice
  was ~1 s.
- Hover preview no longer seeks to 0 on an element that is already at 0.

## 2026-09-16 — Share video efficiency + density slider (PR #36)

- Opening a hovered video in the viewer adopts the tile's already-buffered
  `<video>` (`adoptPreviewVideo`) instead of creating a new element, so the
  clip is not downloaded twice.
- Video tiles near the viewport keep a metadata-only element warm
  (`warmVideoTile`, capped at 12) so hover playback starts without a cold
  fetch; the warm lease is released when the tile scrolls away.
- Shift-scrub issues one accurate seek at a time and applies the latest
  pointer target on `seeked` (was: a `fastSeek` per animation frame, which
  piled up seeks and jumped between keyframes).
- Gallery density is now a bare icon-slider-icon row in the toolbar; the
  value shows as a tooltip over the thumb while hovering/dragging. The
  boxed "Gallery density" card and More/Detail sublabels are gone.

## 2026-09-15 — Trash a delivered upload (PR #35)

- Link detail → upload history → **remove**: moves the file to Drive trash,
  removes it from the history and counters (`DELETE
  /api/admin/uploads/:slug/:fileId`, confirm dialog). Used first to clean the
  verification files the September session uploaded into `temp`.

## 2026-09-15 — share-viewer.js split (PR #34)

- `share-viewer.js` (1.9k) → `share-viewer.js` (open, slide items,
  progressive image, rotation; 343) + `share-viewer-state.js` (`vs` for the
  viewer's reassigned scalars, `viewerChrome`) + `share-viewer-assets.js` +
  `share-viewer-video.js` + `share-viewer-panels.js` + `share-viewer-info.js`
  + `share-viewer-strip.js`. Every `public/` file is now under 500 lines.
  Verified on the fixture gallery: open/nav, video slide, motion + guide
  panels, rotate, asset ladder, strip, mobile dock + More sheet.

## 2026-09-15 — drop.js client split (PR #33)

- `public/drop.js` (1.36k, classic script) → ES modules: `drop.js` (boot,
  gate, main page, pickers, addFiles) + `drop-state.js` (constants,
  collections, and `st` for reassigned scalars) + `drop-queue.js` (upload
  engine) + `drop-render.js` + `drop-live.js` + `drop-resume.js` +
  `drop-report.js` + `drop-utils.js`. Identifier rewrite was tokenizer-aware
  (strings/comments/keys untouched). Verified with real uploads from
  localhost into Drive (5 files, incl. a 3 MB one), pause/offline toggles,
  and the retry/attention path with a stubbed session.

## 2026-09-15 — Live tab + link detail (PR #31)

- Live metric labels and the upload-history table header use the body face
  at 12px (no more 10–11px uppercase mono). Detail page: Copy is the filled
  head action; QR / Drive / Pause stay quiet.

## 2026-09-15 — Home polish (PR #30)

- Headline no longer hyphen-breaks ("original‑quality" is one word; `text-wrap:
  balance`). The visitor CTA is "See how it works"; "Create a drop link" is
  the secondary (owner) action. Feature strip icons use the same tile
  language as the step cards. Footer text passes contrast.

## 2026-09-15 — admin.js client split (PR #29)

- `public/admin.js` (1.7k, classic script) → ES modules: `admin.js` (boot,
  auth, tabs, live socket, stats, event delegation, QR; 570) +
  `admin-state.js` + `admin-chart.js` + `admin-live.js` + `admin-activity.js`
  + `admin-links.js` + `admin-shares.js` + `admin-detail.js` +
  `admin-folders.js`. Same lint contract as the share modules. Dead:
  `staticCard`, an unused `settingsOpen`.

## 2026-09-15 — share.js client split (PR #28)

- `public/share.js` (3.5k lines) → `share.js` (gate, navigation, rendering,
  cards, layout; 950) + `share-state.js` (shared state with live bindings +
  setters) + `share-viewer.js` (PhotoSwipe/Swiper; 1.9k) + `share-preview.js`
  + `share-select.js` + `share-download.js` + `share-beacon.js` +
  `share-utils.js`. Imports are exact (ESLint `no-unused-vars`/`no-undef`/
  `no-import-assign` on the modules, no page globals except public.js
  helpers). Two dead functions found and removed (`waitForVideoDuration`,
  `formatShortDate`).

## 2026-09-15 — Drop/share list cards (PR #27)

- Card order is head → stats → actions; actions are a footer row behind a
  hairline. Stats and meta use the body face at readable sizes (11.5–12.5px,
  no 9.5px uppercase mono). Status pill and budget warning colours pass
  4.5:1 on the glass. Action buttons are 36px tall (44px on touch), have
  focus rings and hover transitions; cards lift their border on hover.

## 2026-09-15 — Lint guard (PR #26)

- `npm run lint` (ESLint 9, `no-undef` / `no-unused-vars` / `no-redeclare`)
  runs first in `npm test`. Every identifier in `src/` and `public/` must
  resolve - the static check that would have caught #22. Cross-checked the
  #16/#18 split by diffing every function name in the pre-split files
  against the tree: all present (live.js ones under their new class names).
- Found by the linter: the create-drop-link error path referenced an
  undefined `button` and threw instead of showing the API error.

## 2026-09-15 — Admin overview pass (PR #24)

- Stat tiles: auto-fit grid (6 across on wide, 3×2 at 800px, 2 at phone),
  sentence-case body-face labels, one visual weight (the "Data received"
  accent tile is gone). Page titles are solid ink; gradient text is reserved
  for brand and CTAs.
- Activity rows lead with the action ("Browsed gallery") and put the actor
  and link in the subline; unknown `drop-*`/`share-*` types get a readable
  fallback instead of "Activity".
- Link/share cards: Details/Edit is the one filled button, Delete is quiet
  text at the far end until hovered, labels in the body face.
- Icon rail (901–1080px) hides the brand wordmark properly.

## 2026-09-15 — Drop page v4 (PRs #22–#23)

- **#22 hotfix.** `notifyEmail` import lost in the #18 split; every progress
  tick on links with start emails threw in the background relay. Smoke test
  now fails on programming errors surfaced via `console.error`.
- **#23 drop v4.** One column, one rhythm: header (collector / label /
  one-line facts instead of chips) → flow card (name with a live tick, then
  the dropzone with explicit "Choose files / Choose a folder" buttons) →
  transfer card → done card → footer (trust line + report). Once files are
  queued the dropzone yields to a slim "Add files / Add folder" row. Row
  errors are humanised (`humanError`): connection dropped, budget reached,
  server hiccup, link closed - never a stack-trace fragment; retry countdown
  carries the reason. Drive resumable sessions are minted for the browser's
  `Origin` header (under `wrangler dev` request.url carries the route host,
  so local uploads failed CORS).

## 2026-09-15 — Drop/share states (PRs #20–#21)

- **#20 hotfix.** `chip()` on the drop page still used retired icon names and
  threw after #19; audit test now fails on retired names at icon call sites.
- **#21 states.** Drop page: one `#gate` card renders loading (skeleton
  title), closed (404 / expired / paused / budget / offline / 5xx, each with
  its own copy, tone and a way back), Google sign-in and PIN (masked input
  with eye toggle, `one-time-code` autocomplete, checking state, shake +
  inline error on a wrong code, lockout countdown, 410/403 escalate to the
  closed card). Topbar pill is a real status: `checking / secure / live /
  paused / offline / closed` (the double dot came from `::before` plus a
  stray `<i>`). Offline is handled: uploads pause, a notice shows, and on
  `online` failed files re-queue and the pump resumes. `body[data-phase]`
  (ready / uploading / paused / offline / attention / done) compacts the
  dropzone while a transfer runs and colour-codes the transfer panel; step 1
  ticks once a name is entered. Share page: loading spinner, back link on
  the closed card with per-cause copy, "Continue with Google" wording shared
  with the drop page, folder-only roots get an "open a folder" hint. Admin:
  901–1080px uses an icon rail instead of a wrapped header block. Viewer:
  asset-ladder pill moves under the top bar below 1100px.

## 2026-09-15 — One icon system (PR #19)

- Every icon is now a Lucide stroke glyph from `public/icons.svg`, referenced
  as `<svg class="ico"><use href="/icons.svg#name"/></svg>` (HTML) or
  `uiIcon(name)` (JS). The sprite is generated by `npm run icons` from the
  `UI_ICON_NAMES` catalog in `public/public.js` via `lucide-static` (dev dep).
- Gone: ~40 hand-drawn fill glyphs with opacity backplates, 55 inline
  `<svg>` blocks across the HTML pages, `STAT_ICONS` markup, `.ico-fill` /
  `.duo`. The `file`=`image` and `shield-alert`=`alert` copy-paste bugs died
  with them. Token field eye toggles eye/eye-off; drop-page loading glyph spins.
- `scripts/icon-audit-test.mjs` now enforces: sprite == catalog, no inline
  glyph paths outside charts/rings, every referenced name exists.

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
  `worker.js` / `drop-api.js` / `admin-api.js`; `live.js` hands completions
  to `live-completions.js` (`CompletionQueue`). Every `src/` file is now
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
