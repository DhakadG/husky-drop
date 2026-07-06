# 04 — Security & Performance Plan (zero-budget)

## Threat model (what actually matters for a personal gateway)

| Threat | Impact | Current state | Fix |
|---|---|---|---|
| Leaked/forwarded drop link | Strangers fill your 2TB+ Drive | PIN optional; no volume cap | Per-link byte/file/session budgets + auto-pause (03 §2.3) |
| PIN brute force | Link access | Per-IP lockout ✅; global damping **broken** (`request` bug) | Fix bug; keep design |
| Admin token theft/guess | Full control + Drive folder creation | Static token, localStorage, WS query string, no attempt limit, non-constant-time compare | §1 below |
| KV data leak (rogue dashboard, misconfig) | PINs crackable offline | Single SHA-256 | PBKDF2 §1.3 |
| Free-tier quota exhaustion (accidental or abuse) | Site dies mid-trip | KV list/write budgets already at risk (events) | §3 — the most urgent perf item |
| Refresh-token compromise | Full Drive read/write | Full `drive` scope secret in Wrangler | §2 scope reduction |
| XSS on drop/admin pages | Token/PIN theft | Strict CSP ✅, consistent esc() ✅ | Keep; add `require-trusted-types-for` later |

## 1. Admin auth hardening (small effort, do in Phase 1)

1.1 **Session cookie instead of bearer-everywhere**: POST `/api/admin/login {token}` → verify (constant-time) → set HttpOnly, Secure, SameSite=Strict cookie holding an HMAC-signed session (`exp` 7d, signed with `SHARE_SIGNING_KEY` or a dedicated secret). All `/api/admin/*` and the WS upgrade check the cookie — token leaves localStorage and the WS URL.

1.2 **Rate-limit login**: reuse `recordPinFailure` machinery with slug `"__admin__"` (5 tries → exponential lockout per IP). Currently unlimited guessing.

1.3 **PBKDF2 for PINs** (WebCrypto, no deps):
```js
async function pinHash(pin, saltHex, iterations = 100_000) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations }, key, 256);
  return bytesToHex(new Uint8Array(bits));
}
```
Migration: keep `pinAlgo: "sha256" | "pbkdf2"` on the link; verify with old algo, re-hash to new on first successful entry. (~30 ms CPU is within Worker limits.)

1.4 **Constant-time compares** everywhere secrets are compared (admin token, pin hashes, share tokens):
```js
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}
```

## 2. Google credential blast-radius

- **Preferred**: switch OAuth scope from `drive` to **`drive.file`** — the token can then only see files/folders the app itself created. Requirement: `DRIVE_PARENT_ID` must be created *by the app* (one-time migration: let the Worker create a new parent folder, move existing trip folders under it via Drive UI — app-created children remain visible). Verify `driveFindFolder` still works within app-created trees before committing.
- If `drive.file` proves too restrictive for Share Links on pre-existing folders, fall back to full scope but: dedicate a Google account? No — files must land in YOUR storage. Instead accept full scope and mitigate: secrets only in Wrangler secrets (already true), never in KV; rotate refresh token if a laptop with `.dev.vars` is ever lost.
- **Never log token contents**; current code is clean — keep it that way (add to review checklist).

## 3. Free-tier quota engineering (the real "performance" problem)

Budgets (Cloudflare free): Workers 100k req/day · KV: 100k reads/day, **1k writes/day, 1k lists/day** · DO: included w/ SQLite-backed storage (~100k row-writes/day class) · Resend: 100 emails/day.

Current spenders that will blow the KV caps:

| Code path | Cost today | Fix |
|---|---|---|
| `recentEvents()` per overview poll (15s) | ~5,760 KV **lists**/day + up to 60 gets each | **Move events to a single rolling KV key** `events:recent` (JSON array, cap 200, written only by the DO's batched flush) → 1 read per poll, 0 lists. Or store in DO SQLite and serve `/snapshot`-style |
| `logEvent()` unique `ev:*` key per event | 1 write each; a busy evening (600 files logged as batched "file" events + opens + starts + locks) can still spike | Route ALL events through `LiveTracker.accumulateEvent()` → flush merged into `events:recent` on the existing 4s alarm. Worst case a whole evening = a few dozen writes |
| `bumpStats` on every open | 1 read+write per open | Batch opens through the DO too (they're not latency-sensitive) |
| `gtoken` cache | ✅ already good | — |
| Admin polling `refreshAll()` every 15s + full overview (N links × stats gets) | reads only, but O(links) gets | Cache overview JSON in the DO for 10s; or store `stats:*` snapshots inside DO and serve from memory. Reads are cheap (100k) — low priority |

Concrete rule for all new features (share links, error reports, rollups): **clients never write KV directly from the request path; everything funnels through the DO alarm batcher.** You already built the right machinery — finish moving everything onto it.

Daily-rollup schema for charts (DO SQLite):
```sql
CREATE TABLE IF NOT EXISTS day_stats (
  slug TEXT, day TEXT,            -- '2026-07-06'
  opens INT DEFAULT 0, sessions INT DEFAULT 0,
  files INT DEFAULT 0, bytes INT DEFAULT 0,
  downloads INT DEFAULT 0,        -- share links
  PRIMARY KEY (slug, day)
);
```

## 4. "Instant" sharing/receiving — latency plan

Perceived speed wins, in order of impact:

1. **Skip the queue-to-first-byte gap**: you already prefetch the next file's session. Also start the FIRST session request in parallel with PIN verification response paint (fire `ensureSession` for file #1 as soon as it's enqueued — you do this; keep).
2. **Byte-window scheduler (from t.zip)**: replace "N files in parallel" with "N files, but cap total in-flight bytes at ~64 MB". Small files stream in parallel; huge videos don't starve each other. ~30 lines in `pump()`.
3. **Adaptive chunk size**: start at 16 MB; if a chunk RTT < 3 s, step up (32 → 64 MB, Drive allows multiples of 256 KB); on timeout/failure, halve. Better than static per-link tuning on hotel Wi-Fi vs 5G.
4. **Instant link creation**: `createLink` currently blocks on Drive folder creation (~400–900 ms). Return the link immediately with `folderPending: true` and create the folder lazily on first session (or via `ctx.waitUntil`). Admin sees the copyable URL instantly — this is t.zip's "instant link generation" feel.
5. **QR + share sheet**: `navigator.share({url})` on the admin create-success screen (mobile) + QR render — hand a phone-scannable code to a friend in person.
6. **Drop page cold load**: it's already dependency-free vanilla JS (good; t.zip ships a full Next bundle). Add `<link rel=preconnect href=https://www.googleapis.com>` and inline critical CSS to keep first-open-on-cell-network snappy.

## 5. Abuse guardrails summary (all free)

- Per-link budgets + auto-pause (bytes/files/sessions) — primary defense.
- Uploader name allow-list per link.
- Optional Cloudflare Turnstile (free) on PIN-less links before first session mint — bot wall without friction for your friends. Widget on drop page, `siteverify` in Worker, only when `settings.turnstile: true`.
- Rate limits in the DO (it's a global singleton — perfect for counters): sessions/min per IP, error-report spam, thumb-proxy requests.
- Cloudflare zone-level: enable Bot Fight Mode + a rate-limiting rule on `/api/*` (both free-plan features) as the outer moat.
