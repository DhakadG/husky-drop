# SETUP-REQUIRED — your to-do list after this upgrade

Everything below is what YOU must configure. All code work is done: bugs fixed, features implemented, smoke tests passing (`npm test`). Nothing here costs money.

## 1. Deploy (required)

```powershell
npm test                      # must print "smoke tests passed (v2)"
git add -A
git commit -m "feat: v2 - share links, speed engine, security hardening, analytics"
git push origin main
npm run deploy                # wrangler deploy
```

Notes on this deploy:
- The Worker entry point moved from `src/index.js` to **`src/worker.js`** (code was split into modules: util/drive/store/live/share). `wrangler.jsonc` is already updated — no action beyond deploying.
- `run_worker_first` now includes `/`, `/s/*` (already in your `wrangler.jsonc`; mirror it if you ever recreate from `wrangler.example.jsonc`).
- No KV migration needed. Old links keep working; legacy PINs re-hash themselves to PBKDF2 on next successful entry; old `ev:*` events are read once into the new `events:recent` key and the leftovers expire on their own 90-day TTL.

## 2. Cloudflare Web Analytics beacon (you asked for this)

1. Cloudflare dashboard → your account → **Analytics & Logs → Web Analytics** → *Add a site* → hostname `dropbox.losthusky.qzz.io` → choose **manual / disable automatic setup** (the Worker injects the snippet itself).
2. Copy the **token** from the provided snippet (`data-cf-beacon='{"token": "..."}'`).
3. Set it (either way works; var is fine, it is not a secret):
   - add to `wrangler.jsonc` → `"vars": { ..., "CF_BEACON_TOKEN": "your-token" }`, or
   - `wrangler secret put CF_BEACON_TOKEN`
4. Deploy. The beacon is injected into `/`, `/d/*`, `/s/*`, `/admin` automatically; CSP already allows it. Without the token, pages stay beacon-free (verified by tests).

You get: page views per link page, referrers, countries, Core Web Vitals — useful for spotting which drop links get opened and when friends hit errors (pair with the new `clienterror` events in the admin Activity feed, which capture actual JS errors + "Report a problem" taps from friends' phones).

## 3. New secret (recommended)

```powershell
wrangler secret put SHARE_SIGNING_KEY     # any long random string, e.g. 64 hex chars
```
Signs share-gallery download tokens. If you skip it, a key is derived from `ADMIN_TOKEN` (works, but a dedicated key means rotating one never breaks the other).

## 4. First login after deploy (one-time)

The admin now uses an HttpOnly session cookie. Your old saved token in the browser's localStorage is ignored — open `/admin`, enter `ADMIN_TOKEN` once, done for 7 days per browser. Login is rate-limited (5 tries / 15 min / IP). The old `Bearer` header still works for scripts/tests.

## 5. Try the new features (nothing to configure, just use)

- **Pause / budgets**: Links tab → pause button; Create/Detail → "Budgets" (max GB / files / sessions; 0 = unlimited). A breached budget auto-pauses the link. Suggest setting a byte budget (~free Drive space) on every link you hand out.
- **QR + share**: qr button on any link/share row, and after creating a link (URL is also auto-copied).
- **Share links** (`/s/slug`): Shares tab → paste Drive folder URLs/IDs (comma-separated, up to 10) →
  - *Gallery* mode (default): folder stays private; friends get a PIN-able gallery with thumbnails, per-file downloads and client-side "download all as zip" (keep zip selections under ~3.8 GB; Chrome/Edge stream to disk, others build in memory up to 1 GB).
  - *Redirect* mode: grants public anyone-with-link reader on the folder and sends friends to Drive; pausing/deleting/expiry revokes the grant.
- **Speed**: uploads now use a byte-window scheduler (up to 8 files in flight inside a concurrency×chunk window) + chunks that auto-grow 32→128 MB on fast networks and shrink on flaky ones + a 60s stall watchdog instead of a fixed timeout + 2 pre-warmed Drive sessions. Your per-link concurrency/chunk settings remain the baseline.
- **Resume after reload**: if a friend's page dies mid-upload, reopening the link shows a banner; re-selecting the same files continues from Drive's last byte (verified via offset probe). Sessions are re-usable for ~6 days.
- **Folder upload**: desktop browsers get an "add a whole folder" button; the relative path is stored in each Drive file's appProperties/description.
- **Emails**: the per-file "completed" email is replaced by ONE digest per session ("Riya finished — 214 files · 18.2 GB") using the same notify "complete" toggle. "Start" emails unchanged. This respects Resend's 100/day free cap.
- **Drive space**: drop pages show "~N GB free in Drive"; sessions are refused when a file can't fit (5 GB reserve); admin Overview shows a "Drive free" card.
- **Charts**: Overview → "Last 30 days" (bytes/files/opens/downloads) from the Durable Object's SQLite rollups — data starts accumulating from this deploy.

## 6. Optional Cloudflare dashboard hardening (5 minutes, free)

- Security → Bots → enable **Bot Fight Mode**.
- Security → WAF → Rate limiting rules → e.g. 100 req / 10 s per IP on `dropbox.losthusky.qzz.io/api/*`.

## 7. Post-deploy checklist

1. `/admin` → login with token → Overview loads, "Drive free" card appears.
2. Create a test drop link → QR modal pops → open `/d/<slug>` on your phone → upload 2 photos → live view shows them → Drive folder has them.
3. Reload the drop page mid-upload of a big file → banner → re-pick → it resumes (watch the "continues from X" toast).
4. Create a gallery share for an existing trip folder → open in incognito → PIN → thumbnails → download one file → zip two files.
5. Pause the share → incognito reload → "not available". Delete it.
6. Check Activity feed shows: open / start / file / share-open / share-dl events.
7. After ~24h, the 30-day chart shows its first bar, and Web Analytics shows visits.

## 8. Known limits (by design, documented for later)

- Zip download: no zip64 → 3.8 GB cap per zip; use "Open in Drive"/individual downloads beyond that.
- Gallery lists files flat (subfolders inside a shared folder are skipped in v1).
- Resume requires the friend to re-pick the same files (browser security); matching is automatic by name+size+mtime.
- Redirect-mode shares are truly public while active — prefer gallery mode for anything sensitive.
- Old dashboards polling every 15s cost ~1 KV read per poll now (was: a KV *list* + up to 60 reads) — free-tier safe.
- `docs/transferzip-audit/06-ROADMAP.md` Phase 3 items not included in this pass: PWA share-target, HEIC preview, theme profiles, Turnstile, `drive.file` scope migration.
