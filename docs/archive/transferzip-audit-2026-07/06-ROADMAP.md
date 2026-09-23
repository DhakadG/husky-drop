# 06 — Implementation Roadmap (phased, sized for smaller coding models)

Each task: scope, files touched, acceptance criteria (AC). Feed one task at a time to the coding model, with the referenced doc section pasted in as context. After every task: `npm test` + `wrangler dev` manual check + the two-step deploy from `docs/DEPLOY.md`.

---

## Phase 0 — Bugfixes (do immediately, ~1 sitting)

**P0.1 Fix `request` ReferenceErrors** — `src/index.js`
Pass `request` into `recordSessionStart(env, link, uploader, sessionId, request)` and `recordCompletion(env, link, meta, request)`; add it to `deleteLink(env, slug, request)` and `recordGlobalPinFailure(env, link, request)`; update all call sites (`createSession`, `logProgress`, `logComplete`, `api()` router, `gatePin`). The DO paths (`flushCompletions`) legitimately have no request — pass `null` (already handled: `extractClientInfo` null-guards).
AC: first `/api/session` of a fresh sessionId returns 200 and a `start` event appears; deleting a link returns `{ok:true}`; smoke test passes.

**P0.2 Event storage refactor (KV quota)** — `src/index.js` (see 04 §3)
Add `accumulateEvent()` to LiveTracker; `logEvent()` relays to the DO; alarm flush merges into single KV key `events:recent` (cap 200, newest first). `recentEvents()` becomes one `KV.get`. Delete the `ev:*` list/scan path (keep a one-off migration read of existing `ev:*` keys into the new array, or just accept losing old events).
AC: overview shows events; zero `KV.list` calls remain in the codebase (`grep KV.list` → only `getAllLinks` fallback); opening the dashboard for 10 min adds ≤3 KV writes.

**P0.3 Batch `opens` through the DO** — small; same pattern.
AC: 20 rapid page opens produce 1–2 KV writes total.

**P0.4 0-byte file guard** — `public/drop.js`: skip size-0 files with a toast.

---

## Phase 1 — Critical hardening & quick wins

**P1.1 Admin session cookie + login rate limit** (04 §1.1–1.2) — `src/index.js`, `public/admin.js`
AC: token never appears in WS URL or localStorage; 6 wrong tokens → 429 with backoff; existing flows work.

**P1.2 PBKDF2 PINs with migration** (04 §1.3) — AC: old links still verify; new/re-entered PINs stored as `pinAlgo:"pbkdf2"`; wrong-PIN lockouts unchanged.

**P1.3 Link `disabled` flag + per-link budgets + auto-pause** (03 §2.2–2.3) — Worker + admin toggle + drop-page "paused" state.
AC: paused link shows friendly closed page, sessions refused; exceeding `maxTotalBytes` auto-pauses and logs event.

**P1.4 Constant-time compares** (04 §1.4) — admin token, pin hash, future share tokens.

**P1.5 Instant link creation** (04 §4.4) — return URL immediately, folder via `ctx.waitUntil` or lazy-on-first-session.
AC: create-link p95 < 300 ms; first upload still lands in the right folder.

**P1.6 QR code + navigator.share on admin** (02 §E) — vendor a tiny QR lib into `public/vendor/`, CSP `script-src 'self'` unchanged.

**P1.7 Client error reporting** (02 §G) — `/api/client-error` (DO rate-limited 5/min/IP) + drop.js catch hooks + "Report a problem" button; events feed shows `clienterror`.

---

## Phase 2 — The big features

**P2.1 Share Links, gallery mode** (03 §3) — new `share:{slug}` KV objects, `/s/:slug` page, `files.list` proxy, thumb proxy, HMAC download tokens (03 §3.4), `SHARE_SIGNING_KEY` secret, PIN gate reuse, share events via DO.
Split for the coding model: (a) backend routes+tokens, (b) gallery page UI, (c) analytics wiring.
AC: private folder browsable via link; direct fileId URL without token → 403; expired/paused share → closed page; downloads logged.

**P2.2 Share Links, redirect mode + permission lifecycle** (03 §3.1) — grant/revoke `anyone` reader, store `permissionIds`, cron trigger (new `[triggers]` in wrangler.jsonc) revokes on expiry.
AC: deleting/expiring a redirect share removes the Drive permission (verify via Drive UI).

**P2.3 Resume-after-reload** (03 §4) — IndexedDB persistence + re-pick matching + probe/resume.
AC: reload mid-upload of a 2 GB file, re-select it → upload continues from Drive's reported offset (verify bytes not re-sent via DevTools).

**P2.4 Client-side zip download in gallery** — vendored `client-zip`-style streaming zip of selected files through the download proxy.
AC: select 20 photos → one zip; memory stays flat (streamed) for 2 GB selections.

**P2.5 Byte-window upload scheduler + adaptive chunks** (04 §4.2–4.3) — `public/drop.js`.
AC: mixed batch (300 photos + 4 videos) shows photos completing steadily alongside videos; throughput ≥ current on stable network.

**P2.6 Folder upload (desktop)** (02 §C) — `webkitdirectory` + optional 1-level Drive mirroring.

**P2.7 Daily rollups in DO SQLite** (04 §3 schema) — write path piggybacks on existing alarms; `GET /api/admin/timeseries`.
AC: chart endpoint returns 30 rows after a day of use; KV writes unchanged.

---

## Phase 3 — Polish & delight

**P3.1 Dashboard overhaul** (05 §1–4): overview KPIs incl. Drive free space, SVG charts, attention chips, uploader leaderboard, file-type donut, thumbnails in history, admin.js module split.
**P3.2 Guest page polish** (05 §5): completion recap screen, duplicate pre-check, i18n-lite.
**P3.3 PWA + Web Share Target** (02 §L1): manifest, SW (cache static only, never API), `share_target` → drop page pre-filled queue.
AC: Android "Share 30 photos → Husky Drop" opens the drop page with files queued.
**P3.4 Session digest email** (02 §I): DO fires one Resend email per finished/stale session; per-file complete emails removed.
**P3.5 Theme profiles** (05 §7).
**P3.6 HEIC preview in gallery** (02 §H) — wasm decoder, lazy-loaded only on .heic click.
**P3.7 Housekeeping cron** (02 §L3): prune `folder:`/`started:`/pending resume keys, weekly digest email.
**P3.8 `drive.file` scope migration** (04 §2) — spike first; only ship if folder flows survive.
**P3.9 Turnstile option for PIN-less links** (04 §5).

---

## Sequencing logic

Phase 0 unblocks correctness (your stats/emails are silently broken today) and prevents mid-trip quota death. Phase 1 is everything cheap that reduces risk before you hand links to more people. Phase 2 delivers the two features you asked for by name (share links, instant/robust receiving). Phase 3 is the experience layer.

Dependency notes: P2.1 needs P1.4 (timing-safe) + ideally P1.1; P2.7 feeds P3.1 charts; P3.4 depends on session lifecycle already in the DO (present). Everything is independent enough to hand to a small model one task at a time.
