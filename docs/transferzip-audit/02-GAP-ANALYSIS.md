# 02 — Gap Analysis: what transfer.zip has that husky-drop lacks

Each gap: what it is, how transfer.zip does it, how to adapt it to your Worker+KV+DO+Drive stack, and a verdict (ADOPT / ADAPT / SKIP).

## A. Outbound sharing (Stored Transfers + download page) — **ADAPT, top priority**

t.zip: `Transfer` model (files[], secretCode UUID, expiry, password, brand profile) + download page + zip-all (server-side zipper queue) + `views[]`/`downloads[]` stats.
You: nothing outbound. Your version should be Drive-backed Share Links — full design in **03-DIRECT-DROP-AND-SHARE-LINKS.md §3**. Do NOT copy their server-side zipper; zip client-side instead.

## B. Link lifecycle controls — **ADOPT (trivial)**

t.zip TransferRequests have `active: Boolean` — pause without deleting.
Add to your link object: `disabled: true/false`, checked in `linkState()`:

```js
function linkState(link) {
  if (!link) return "missing";
  if (link.disabled) return "paused";           // NEW
  if (link.expiresAt && Date.now() > link.expiresAt) return "expired";
  return "active";
}
```
Plus a PATCH field and an admin toggle button. Also adopt from the same family:
- **Per-link quota**: `maxTotalBytes` / `maxTotalFiles` checked in `createSession` against `stats:{slug}` — protects your Drive from a leaked link (04 §2).
- **Allowed types**: optional `accept` list (e.g. `image/*,video/*`) validated on `mimeType` in `createSession` AND in the file picker `accept` attr.

## C. Folder uploads — **ADOPT**

t.zip stores `relativePath` (`file.webkitRelativePath || file.name`) per file.
You: add `webkitdirectory` picker option + read `webkitRelativePath`, then either
1. flatten into the uploader's folder (fine), or
2. mirror 1 level of structure: create Drive subfolder per top-level dir via your existing `driveFindFolder/driveCreateFolder` (cache in the DO folderLocks map like per-uploader folders).
Note: `webkitdirectory` is desktop-only; on Android/iOS multi-select from gallery already covers the trip case. Feature-detect and hide the button on mobile.

## D. Resume after page reload — **ADAPT (high value, unique twist)**

t.zip: tus survives reloads; dashboard has `/app/resume/[transferId]`.
You: Drive resumable session URIs remain valid (~1 week) and support offset probing — you already have `probeOffset()`. Persist per-file `{name, size, lastModified, sessionUri, fileId}` in IndexedDB keyed by slug+sessionId. On reload with pending entries: show "Resume interrupted upload — re-select the same files"; match re-picked files by `name+size+lastModified`, probe offset, continue. Design details in 03 §4.

## E. QR codes — **ADOPT (tiny)**

t.zip shows QR for quick-share links. Generate QR client-side in admin (no external service; a ~1.5 kB vanilla qr lib vendored into `public/`, CSP-safe). Show on link create success + link detail.

## F. Per-event timestamped statistics — **ADAPT**

t.zip stores `views: [{time}]`, `downloads: [{time}]` per transfer → recency text and future charts. Counters (yours) can't answer "when".
Your stack: don't append unbounded arrays to KV (write amplification). Instead keep **daily rollups** in the DO's SQLite storage: `bumpDay(slug, day, {opens,sessions,files,bytes})` — one SQLite row per link-day, flushed with your existing alarm batching. 90 days retention. Feeds the 05 dashboard charts. DO SQLite free tier (100k row-writes/day) dwarfs KV's 1k/day.

## G. Client error tracking — **ADOPT (small)**

t.zip `trackError(context, err, meta)` → POST to backend → Error collection.
You: `POST /api/client-error {slug, message, stack?, ua}` → `logEvent(type:"clienterror")` (rate-limit 5/min/IP via DO). You currently cannot see why an upload failed on a friend's phone. Pair with a "Report a problem" button on the drop page.

## H. Browser tools (zip/unzip/HEIC) — **ADAPT selectively**

t.zip ships standalone tools (zip.js, heic converter) mostly for SEO. For you only one matters: **HEIC→JPG on the Share-Link gallery viewer** (iPhone photos your Windows friends can't open). Client-side `heic2any`-style wasm decode on preview. Phase 3.

## I. Email templates & digest — **ADAPT lightly**

t.zip has branded React-email templates incl. TransferRequestReceived. Yours are inline HTML strings — fine. Steal the *behavior*, not the tech: send **one digest email per session** ("Priya uploaded 214 files · 18.2 GB to Kareri Lake Trek — open folder") triggered from the DO when a session goes `done`/`stale` with >0 completions, instead of per-file `complete` emails. Respects Resend free tier (100/day).

## J. Session auth via short-lived scoped JWTs — **ADAPT concept**

t.zip's worker signs RS256 JWTs with scopes (`upload`, `download`, `control`); nodes verify with the public key. Single-Worker you don't need asymmetric crypto, but the *shape* is right for Share Links: HMAC-signed short-lived tokens minting scoped access (`scope:view` / `scope:download`, bound to slug + expiry) so download URLs can't be forged or reused across links. Snippet in 03 §3.4.

## K. Things to explicitly SKIP

| t.zip feature | Why skip |
|---|---|
| tus protocol / node servers / S3 providers / Redis / Mongo | Replaces your $0 architecture with paid infra; Drive resumable already gives you chunked+resumable |
| WebRTC Quick Transfers + signaling server | Needs both parties online; wrong fit for post-trip collection; large maintenance surface (their own README lists Safari/Firefox bugs) |
| Stripe, plans, waitlist, A/B tests, campaigns, SEO content pages | Commercial features |
| Multi-user auth (passport, magic links, Google sign-in) | Single admin; a session cookie upgrade (04 §1) is enough |
| Server-side zip (zipperQueue) | Worker CPU/memory can't zip 50 GB; zip client-side from the gallery instead |
| Their password encryption scheme | Hard-coded AES key committed to the repo — anti-pattern |
| Multi-region nodes + geoip | CF edge already global |

## L. Gaps in NEITHER project worth building (your leapfrogs)

1. **PWA + Web Share Target** — manifest + service worker; Android "Share → Husky Drop" from the gallery pre-loads files into the drop queue. Biggest mobile-UX win available. (Roadmap P3, but cheap.)
2. **Upload integrity spot-check** — you already verify size vs Drive on complete; optionally add md5Checksum comparison (Drive computes it) for paranoia.
3. **Scheduled Worker (cron trigger)** for housekeeping: prune stale `folder:`/`started:` keys, roll up old events, email you a weekly digest.
4. **Drive quota headroom on the drop page** — call `about.get(storageQuota)` (cache 1h in KV) and warn guests "only 800 GB free" before a 1 TB dump starts.
