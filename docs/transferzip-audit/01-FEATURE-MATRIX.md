# 01 — Feature Matrix: husky-drop vs transfer.zip

Legend: ✅ has it · 🟡 partial/basic · ❌ missing · **bold** = the better implementation for YOUR use case.

## Core transfer engine

| Feature | husky-drop | transfer.zip | Winner & why |
|---|---|---|---|
| Receive-files links (guest uploads to you) | ✅ `/d/:slug` drop links | ✅ "Transfer Requests" `/upload/:secretCode` | **husky-drop** — files land in YOUR Drive immediately; t.zip stores on a server you'd have to pay for, then you download (the exact re-upload dance you're avoiding) |
| Send-files links (you share files out) | ❌ | ✅ Stored Transfers + download page, zip download | **transfer.zip** — you have nothing here. See 03 for the Drive-backed equivalent |
| Chunked/resumable upload | ✅ Drive resumable: 308 handling, `Range` probe, dead-session re-mint, exp backoff (8 retries) | ✅ tus protocol (tus-js-client), retryDelays | **husky-drop** — equally robust protocol-wise, and no server in the byte path. t.zip wins only on resume-after-reload (see below) |
| Resume after page reload | ❌ queue lost with the tab | ✅ tus + resume page (`/app/resume/[transferId]`) | **transfer.zip** — adapt: persist Drive session URIs (03 §4) |
| Parallel files | ✅ 1–4 per link setting, prefetches next session | ✅ 12 parallel + global byte-window throttle (Bottleneck reservoir) | Tie — t.zip's *byte-window* (cap in-flight bytes, not file count) is the smarter scheduler; worth copying at 8–20 MB window. Your session prefetch is something they lack |
| Chunk size | ✅ 8/16/32 MB per link | 🟡 fixed 128 MB tus chunk | **husky-drop** — tunable is better on flaky phone networks; 128 MB chunks lose more on a drop |
| Folder upload (keep structure) | ❌ files only | ✅ `webkitRelativePath` stored per file | **transfer.zip** — easy, valuable gap |
| Max size limits | ✅ per-link `maxTransferBytes` (≤5 TB) | ✅ plan-based | **husky-drop** for your context |
| P2P instant transfer (no storage) | ❌ | ✅ Quick Transfers: WebRTC + AES-GCM E2E, QR, relay fallback | t.zip unique. Low priority for you: your friends upload asynchronously; both-online-at-once rarely holds after a trip. Skip unless you want it as a toy |
| Zero-byte / edge cases | 🟡 untested | 🟡 known bug (0-byte stuck in Quick) | Add a 0-byte guard client-side |

## Link/security features

| Feature | husky-drop | transfer.zip | Winner |
|---|---|---|---|
| Password protection | ✅ salted SHA-256 PIN + per-IP lockout + global damping (damping currently broken — bug) | 🟡 password stored **reversibly encrypted with hard-coded key in the repo**, validated server-side, no visible lockout | **husky-drop** by far — t.zip's password crypto is a cautionary tale, don't copy it. Upgrade yours to PBKDF2 |
| Link expiry | ✅ ≤30 days, KV TTL | ✅ arbitrary date + cron hard-deletes files | **husky-drop** (files persist in Drive by design — that's your product) |
| Enable/disable (pause) link | ❌ delete only | ✅ `active` boolean on TransferRequest | **transfer.zip** — trivial to add, do it |
| Brute-force protection | ✅ per-IP exponential lockout + per-link global window | ❌ none visible | **husky-drop** |
| Auth (admin) | 🟡 static bearer token in localStorage | ✅ full user system: passport sessions, magic links, Google OAuth, password reset | t.zip is overkill for 1 admin; but adapt: signed HttpOnly session cookie after token login (04 §1) |
| Upload authorization | ✅ every session minted server-side after link+PIN check; Drive verifies size on complete | ✅ short-lived scoped JWTs (RS256) minted by worker, verified by node (`needsScope('upload')`) | Tie — different architectures. Their *scoped short-lived token* idea maps nicely onto your share-link downloads (03 §3) |
| CSP / security headers | ✅ strict CSP, HSTS, permissions-policy | 🟡 Next.js defaults | **husky-drop** |

## Upload page UX (guest-facing)

| Feature | husky-drop | transfer.zip | Winner |
|---|---|---|---|
| Drag/drop + picker | ✅ | ✅ (Uppy-style) | Tie |
| Uploader identity | ✅ name required, per-uploader Drive subfolders | 🟡 optional email on some flows | **husky-drop** — per-uploader folders is a killer feature for trips |
| Progress UX | ✅ per-file rows, bounded DOM (600+ files stay fast), totals, speed EMA, ETA, wake-lock, beforeunload guard, toasts | ✅ progress bars, simpler | **husky-drop** — your bounded-render queue is genuinely better engineering |
| Retry/cancel | ✅ per-file + retry-all/cancel-all, warning state for "Drive saved, log delayed" | 🟡 auto-retry only | **husky-drop** |
| Branding | ✅ per-link theme: logo, bg, accent, welcome, promo, CTA, video embed | ✅ reusable BrandProfiles (icon+bg in S3), applied to transfers AND emails | **transfer.zip** on reusability (profiles as entities); yours on breadth. Adapt: named theme presets in KV (05) |
| QR code for link | ❌ | ✅ (Quick share) | **transfer.zip** — add on link create/detail |
| PWA / share target | ❌ | ❌ | Neither — your chance to leapfrog (02 §D) |
| Live progress to admin | ✅ WebSocket via Durable Object, smoothed speed/ETA, admin can dismiss sessions | ❌ nothing comparable | **husky-drop** — unique, keep |

## Post-upload / recipient side

| Feature | husky-drop | transfer.zip | Winner |
|---|---|---|---|
| Download page for recipients | ❌ (Drive is the archive) | ✅ transfer page, per-file or zip-all download (zipper queue on node) | **transfer.zip** — this is your Share Links gap (03) |
| Client-side zip/unzip tools | ❌ | ✅ zip.js browser tools (zip, unzip, HEIC→JPG convert) | **transfer.zip** — HEIC convert is directly relevant to iPhone trip photos |
| Email notifications | ✅ Resend on start/complete (per-link toggles) | ✅ React-email templates: share, downloaded, request-received; branded | Tie for your needs; steal their "digest" idea: one summary email per session, not per file |
| Email to recipients w/ link | ❌ (you share links manually) | ✅ send transfer/request by email, multiple recipients by plan | Low priority — WhatsApp does this for you |

## Dashboard & analytics

| Feature | husky-drop | transfer.zip | Winner |
|---|---|---|---|
| Stats | 🟡 lifetime counters (opens/sessions/files/bytes) per link | ✅ per-event timestamped views[]/downloads[] arrays → counts + recency ("Viewed 2h ago") | **transfer.zip** — timestamps enable charts/trends; counters can't. See 05 |
| Activity feed | ✅ typed events w/ OS + geo (CF `request.cf`), expandable rows | ❌ | **husky-drop** (once KV-quota refactor lands) |
| Live view | ✅ real-time uploads w/ speed/ETA | ❌ | **husky-drop** |
| Upload history | ✅ recent list + "sync from Drive" reconciliation + Drive preview links | ✅ file lists per transfer | **husky-drop** — Drive-as-source-of-truth sync is a great pattern |
| Charts / time series | ❌ | 🟡 counts only, no charts either | Neither — open field (05) |
| Web analytics | ❌ | ✅ umami integration | Optional: self-host-free Cloudflare Web Analytics beacon |
| Error tracking | ❌ (client errors invisible) | ✅ `trackError()` posts client errors to backend | **transfer.zip** — add `/api/client-error` → event log; you can't debug friends' phones otherwise |
| Onboarding | ❌ | ✅ OnboardingSteps component | n/a for solo admin |

## Infra/ops

| Feature | husky-drop | transfer.zip | Winner |
|---|---|---|---|
| Hosting cost | ✅ $0 CF free tier | ❌ VPS + Mongo + Redis + S3/disk | **husky-drop** |
| Multi-region nodes | ❌ n/a | ✅ geo-routed nodes, RS256 trust between web/node | n/a — CF edge gives you this for free |
| Auto-cleanup of expired data | 🟡 KV TTLs only | ✅ cron deletes expired transfers + files | Adapt idea: scheduled Worker (cron trigger) to prune `recent:`/`folder:` keys and disable expired links' stats (Phase 3) |
| Tests | 🟡 smoke test script | ❌ none visible | **husky-drop**, barely |
