# LostHusky's DropBox

Private Smash-style receive-only file drops for trip photos and videos. Friends
open a secure link, upload original files from their phones, and files land
directly in Google Drive.

File bytes never pass through Cloudflare Workers. The Worker only mints Google
Drive resumable upload sessions, enforces link security, records analytics, and
relays live progress through a Durable Object.

## Features

- Secure drop links with optional password/PIN (PBKDF2) and expiry up to 30 days.
- Up to 5 TB per transfer by default, bounded by Google Drive quota/limits.
- Browser-to-Google resumable uploads with retry/resume, adaptive 8-128 MB
  chunks, byte-window parallel scheduling, stall watchdog, and session
  prefetch for the fastest possible path.
- Resume-after-reload: interrupted uploads continue from Drive's last byte
  after re-selecting the same files (IndexedDB-persisted sessions).
- Share links (`/s/slug`): give friends read access to chosen Drive folders -
  private gallery mode (PIN, thumbnails, per-file + client-side zip download,
  analytics) or redirect mode (temporary public Drive grant, auto-revoked).
- Pause/resume any link, plus per-link budgets (max GB / files / sessions)
  that auto-pause a leaked link before it fills your Drive.
- Brute-force protection: per-IP lockouts plus per-link global damping;
  cookie-based admin sessions with rate-limited login.
- Admin dashboard: totals, 30-day activity chart (Durable Object SQLite
  rollups), uploader leaderboard, history with Drive sync, activity feed with
  client OS/geo, QR codes and share sheet for links, Drive free-space card.
- Live progress uses Durable Object WebSockets, not KV heartbeat writes; all
  events/stats are batched through the DO to stay inside KV free-tier limits.
- Client error reporting from friends' phones + "Report a problem" button.
- Folder uploads on desktop (webkitdirectory) with relative paths preserved
  in Drive metadata.
- Optional per-uploader Drive subfolders.
- Per-link customization: logo, background, accent, welcome message, promo
  video, and CTA.
- Optional Resend email notifications: upload start + one digest per finished
  session (not per file).
- Optional Cloudflare Web Analytics beacon (set `CF_BEACON_TOKEN`).
- Admin-side Drive preview/open action for completed files.

Entry point is `src/worker.js` (modules: `util.js`, `drive.js`, `store.js`,
`live.js`, `share.js`). See **`docs/SETUP-REQUIRED.md`** for the one-time
setup steps after deploying this version.

## Architecture

```text
friend phone -- ask session --> Worker -- mint session URI --> Drive API
friend phone -- chunk PUTs directly to googleapis.com
friend phone -- live progress WS --> Durable Object <-- admin dashboard WS
Worker <--> KV for links, events, counters, upload history
```

See `docs/` for the full plan, architecture, API, and security notes.

## One-Time Google Setup

1. Create a Google Cloud project.
2. Enable Google Drive API.
3. Configure OAuth consent screen.
4. Create a Web OAuth client with redirect URI:

```text
http://localhost:8765/cb
```

5. Mint a refresh token while logged into the target Drive account:

```powershell
node scripts/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
```

## Cloudflare Setup

Create a local `wrangler.jsonc` from the example:

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
wrangler kv namespace create KV
```

Put the returned KV namespace ID into `wrangler.jsonc`. Configure the route as:

```jsonc
"routes": [{ "pattern": "dropbox.losthusky.qzz.io", "custom_domain": true }]
```

Set secrets:

```powershell
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN
wrangler secret put ADMIN_TOKEN

# Optional email notifications
wrangler secret put RESEND_API_KEY
wrangler secret put NOTIFY_TO
wrangler secret put NOTIFY_FROM
```

## Deploying Changes (always two steps)

Every change ships in this order — see **`docs/DEPLOY.md`** for the full guide:

1. **Push to GitHub** (history / source of truth)
2. **Deploy to Cloudflare** with Wrangler (makes it live)

```powershell
# 1. validate
npm test

# 2. push to GitHub (origin/main → github.com/DhakadG/husky-drop)
git add -A
git commit -m "describe the change"
git push origin main

# 3. deploy to Cloudflare (live at dropbox.losthusky.qzz.io)
npm run deploy
```

`wrangler deploy` does **not** update GitHub, and `git push` does **not** update
the live site. Do both, in this order, every time.

## Local Dev

```powershell
npm install
npm test
wrangler dev
```

For local Google calls, add `.dev.vars`:

```text
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
ADMIN_TOKEN=dev-token
RESEND_API_KEY=...
NOTIFY_TO=you@example.com
NOTIFY_FROM=LostHusky's DropBox <dropbox@example.com>
```

## GitHub Redaction

The real `wrangler.jsonc` is ignored because it contains account-specific IDs.
Commit `wrangler.example.jsonc` instead. Never commit:

- `.dev.vars`
- `.wrangler/`
- OAuth refresh tokens
- Cloudflare API tokens
- real notification sender/recipient secrets

Suggested repo command:

```powershell
git init
git add .
git commit -m "feat: build losthusky dropbox"
gh repo create DhakadG/husky-drop --private --source=. --remote=origin --push
```
