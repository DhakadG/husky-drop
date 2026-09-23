# Deploy Workflow (read this before shipping)

Every change to this project ships in **two ordered steps**. Do them in this
order, every time:

1. **Push the code to GitHub** (source of truth / history).
2. **Deploy to Cloudflare with Wrangler** (makes it live).

> Cloudflare serves the live site. GitHub is the record. A `wrangler deploy`
> does **not** update GitHub, and a `git push` does **not** update the live
> site. You must do both.

The production site is **https://dropbox.losthusky.qzz.io** (Cloudflare Worker
`husky-drop`, custom domain configured in `wrangler.jsonc`).

---

## 0. Before you deploy

Run the checks locally. Never deploy red.

```powershell
npm test            # smoke tests (worker logic, dedup, security headers)
node --check public/drop.js
node --check public/admin.js
node --check src/worker.js
```

All four must pass. `npm test` must print `smoke tests passed`.

---

## 1. Push to GitHub

Repository: **https://github.com/DhakadG/husky-drop** (remote `origin`, branch
`main`).

```powershell
git add -A
git status                       # confirm only intended files are staged
git commit -m "describe the change"
git push origin main
```

Never commit secrets. The following are git-ignored and must stay local:

- `wrangler.jsonc` (account-specific IDs — commit `wrangler.example.jsonc`)
- `.dev.vars` (local secrets)
- `.wrangler/`, `node_modules/`
- OAuth refresh tokens, Cloudflare API tokens, notification sender/recipient

If you are on a fresh machine, see `docs/archive/GITHUB.md` for the first-push commands.

---

## 2. Deploy to Cloudflare with Wrangler

```powershell
npm run deploy        # alias for: wrangler deploy
```

What this uploads:

- **Static assets** in `public/` (`drop.html`, `drop.js`, `admin.html`,
  `admin.js`, `style.css`) — Wrangler only re-uploads changed files.
- **The Worker** `src/worker.js` (control plane + `LiveTracker` Durable Object).
- **The Worker** `src/worker.js` (control plane + `LiveTracker` Durable Object).

A successful deploy prints `Deployed husky-drop triggers`, the custom domain
`dropbox.losthusky.qzz.io`, and a new **Version ID**. Note that Version ID in
case you need to roll back.

### Required bindings (already in `wrangler.jsonc`)

| Binding | Type | Purpose |
| --- | --- | --- |
| `KV` | KV namespace | links, stats, recent uploads, events, lockouts |
| `MEDIA_BUCKET` | R2 bucket `husky-drop-media` | media cache ladder: thumbnails, 720p previews, folder-stats blobs. Private (no public/custom domain - the Worker gates every read). Create once: `npx wrangler r2 bucket create husky-drop-media`, then the 30-day lifecycle rules from the comment in `wrangler.jsonc` (`media/`, `stats/`). |
| `LIVE_TRACKER` | Durable Object (`LiveTracker`) | live progress + batched completion flush |
| `ASSETS` | Static assets | serves `public/` |
| `DRIVE_PARENT_ID` | var | Drive folder new link folders are created under |
| `LINK_SLUGS` | var | env-configured link slugs |

### Required secrets (set once per environment, not in git)

```powershell
wrangler secret put GOOGLE_CLIENT_ID
wrangler secret put GOOGLE_CLIENT_SECRET
wrangler secret put GOOGLE_REFRESH_TOKEN
wrangler secret put ADMIN_TOKEN
# enables /admin Google sign-in; token login remains as fallback
wrangler secret put ADMIN_EMAIL
# optional email notifications
wrangler secret put RESEND_API_KEY
wrangler secret put NOTIFY_TO
wrangler secret put NOTIFY_FROM
```

Secrets persist across deploys; you only re-run these when rotating a value.

Optional non-secret analytics vars can live in `wrangler.jsonc` under `vars`:

```jsonc
"CF_BEACON_TOKEN": "cloudflare-web-analytics-token",
"CLARITY_PROJECT_ID": "microsoft-clarity-project-id"
```

For admin Google sign-in, add this authorized redirect URI in Google Cloud:
`https://dropbox.losthusky.qzz.io/api/admin/auth/callback`.

---

## 3. Verify after deploy

1. Open https://dropbox.losthusky.qzz.io/d/<slug> — the drop page loads.
2. Open https://dropbox.losthusky.qzz.io/admin — unlock with `ADMIN_TOKEN`;
   the live state pill should read **live** (Durable Object WebSocket).
3. Do a small test upload and confirm the file lands in Drive and appears in
   admin **Live transfers**, then in the link's **Upload history**.

---

## 4. Roll back (if needed)

List recent versions and roll back to a known-good Version ID:

```powershell
wrangler deployments list
wrangler rollback <VERSION_ID>
```

Rolling back the Worker does not delete files already saved in Google Drive.

---

## Quick reference

```powershell
# full ship, from a clean working tree
npm test
git add -A
git commit -m "what changed"
git push origin main
npm run deploy
```
