# Executive Summary — husky-drop vs transfer.zip Audit

Date: 2026-07-06
Scope: full read of `husky-drop` (src/index.js, drop.js, admin.js, docs) vs `transfer.zip-web` + `transfer.zip-node` (main branch).

## Verdict

For your niche — friends push trip media directly into YOUR Google Drive at zero cost — **husky-drop's core architecture is better than transfer.zip's**. Do not adopt their storage model.

| | husky-drop | transfer.zip |
|---|---|---|
| Where bytes go | Browser → googleapis.com directly (Worker only mints sessions) | Browser → their node server (tus or S3) → stored → downloaded later |
| Infra cost | $0 (CF Workers free + your Drive quota) | Needs a VPS/S3, Mongo, always-on Node — never free |
| File ownership | Files land in your Drive, owned by you, instantly | Files sit on a server, expire, must be downloaded |
| Resumable | Yes (Drive resumable protocol, 308 + Range probe) | Yes (tus) |

transfer.zip is worth mining for: **product features** (transfer requests lifecycle, outbound sharing, per-event statistics, brand profiles, QR codes, folder uploads, browser zip tools), **UX patterns** (dashboard lists, onboarding), and **a few robustness ideas** — not for its infrastructure.

## Critical bugs found in husky-drop (fix first — see 06-ROADMAP Phase 0)

1. **`request` out of scope → ReferenceError** in `src/index.js` at four call sites of `logEvent(env, {...}, request)`:
   - `recordSessionStart()` (~line 891): `request` is not a parameter. The **first** `/api/session` call of every new upload session throws → returns 500 → the friend's first file errors and must be retried. Session stats + "start" email silently never fire on the path that matters.
   - `recordGlobalPinFailure()` (~line 649): throws when attempts > 60, **before** `env.KV.put(key, ...)` → the global PIN damping lock is never persisted. Your global brute-force protection is effectively dead.
   - `deleteLink()` (~line 1013): link is deleted but the API returns 500.
   - `recordCompletion()` fallback path (~line 1133): only hit without the DO binding (tests).
   - Fix: pass `request` down as a parameter (or drop the client-info param at these sites).

2. **KV `list` quota blowout**: `recentEvents()` runs `KV.list({prefix:"ev:"})` on every `/api/admin/overview`, and the admin polls every 15s. Cloudflare KV free tier allows ~1,000 list operations/day; an open dashboard burns ~5,760/day. Same problem with per-event `KV.put` (unique `ev:` keys) against the 1,000 writes/day cap during a real trip-upload evening (open + start + N file events). **Restructure events into a single rolling KV key or DO SQLite** (see 04-SECURITY-PERFORMANCE §3).

3. **Weak PIN hashing**: single salted SHA-256. Fine against online guessing (you have lockouts — once fixed), weak if KV contents ever leak. Move to PBKDF2 (WebCrypto, ~100k iterations) — cheap change.

4. **Admin auth**: static bearer token, compared non-constant-time, stored in localStorage, passed in the WebSocket query string, no rate limit on `/api/admin/*` guesses. Works, but hardening is cheap (see 04 §1).

## Top opportunities (detail in 02/03/05)

- **Share Links (outbound)** — your #1 requested feature; husky-drop is receive-only today. Plan in 03.
- **Pause/disable a link** without deleting it (transfer.zip's `active` flag). Trivial, high value.
- **Folder uploads** (`webkitRelativePath`) — friends can drop their whole `DCIM/Trip` folder.
- **Resume across page reload** — transfer.zip survives reloads via tus; your queue dies with the tab. Drive session URIs stay valid — persist them (03 §4).
- **Per-event timestamped stats** → real charts, not just lifetime counters (05).
- **QR code on link creation** — biggest friction cut for handing links to friends in person.
- **PWA + Android share target** — "Share → Husky Drop" straight from the phone gallery.

## Document map

| File | Contents |
|---|---|
| 01-FEATURE-MATRIX.md | Side-by-side feature comparison, who does it better |
| 02-GAP-ANALYSIS.md | Everything transfer.zip has that you don't, triaged |
| 03-DIRECT-DROP-AND-SHARE-LINKS.md | Drop-link hardening + full Share Links (outbound) design |
| 04-SECURITY-PERFORMANCE.md | Threat model, free-tier abuse protection, KV/DO budget, speed plan |
| 05-DASHBOARD-UX-BLUEPRINT.md | Analytics-driven dashboard redesign |
| 06-ROADMAP.md | Phase 0–3 tasks sized for smaller coding models |
