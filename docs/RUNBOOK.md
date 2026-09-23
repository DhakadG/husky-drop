# RUNBOOK — operating the live service

Everything here runs against **production**, https://dropbox.losthusky.qzz.io.
Read [CONTEXT.md](CONTEXT.md) first if you have not.

Set the token once per shell (it lives in `.dev.vars`, which is gitignored):

```bash
T=$(grep ADMIN_TOKEN .dev.vars | cut -d= -f2 | tr -d '"\r ')
```

Most of what is below also has a button in the admin **Pipelines** tab. The
curl form is here because it is scriptable and because it works when the UI is
the thing that is broken.

---

## Is anything wrong?

One call answers it:

```bash
curl -s -H "authorization: Bearer $T" https://dropbox.losthusky.qzz.io/api/admin/pipelines
```

Returns share-index state per share (files indexed, live cursor, last job),
RAW/HEIC preview counts and run history, WebP thumbnail runs, video previews,
the image archive, the Drive change-feed cursor, the last R2 orphan sweep, and
the GitHub Actions runs behind all of it.

What "healthy" looks like: no share with `needsReindex: true` for more than a
few minutes, `sharePreviews.pending` near zero after the nightly run, and
`changes.checkedAt` within the last day.

The app log:

```bash
curl -s -H "authorization: Bearer $T" https://dropbox.losthusky.qzz.io/api/admin/logs
```

---

## Share index

**Re-index one share** (targeted unless `full`):

```bash
curl -s -X POST -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"slug":"<slug>"}' https://dropbox.losthusky.qzz.io/api/admin/share-index/run
```

**Check a job**, including its live cursor:

```bash
curl -s -H "authorization: Bearer $T" https://dropbox.losthusky.qzz.io/api/admin/share-index/status/<slug>
```

**A job stopped moving.** A deploy kills the self-continuation chain.
`resumeStalledJobs()` picks it up on the next change check (within ~5 minutes),
or poke it:

```bash
curl -s -X POST -H "authorization: Bearer $T" -H "content-type: application/json" -d '{}' \
  https://dropbox.losthusky.qzz.io/api/admin/share-index/jobs/<jobId>/continue
```

**Folders with no stats** (empty folders are expected; missing ones are not):

```bash
curl -s -H "authorization: Bearer $T" https://dropbox.losthusky.qzz.io/api/admin/share-index/gaps/<slug>
```

**Force a change-feed check:**

```bash
curl -s -X POST -H "authorization: Bearer $T" -H "content-type: application/json" -d '{}' \
  https://dropbox.losthusky.qzz.io/api/admin/share-index/check-changes
```

---

## Duplicate files in a folder

Same Drive md5 **and** size inside one folder subtree. The oldest copy stays,
the rest go to Drive's trash (recoverable for 30 days) and a targeted index job
drops them from the index. Name-only matches are reported, never touched.

Always dry-run first:

```bash
curl -s -X POST -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"slug":"<slug>","folder":"<folder name, path or id>","dryRun":true}' \
  https://dropbox.losthusky.qzz.io/api/admin/share-index/dedupe
```

Read `duplicates`, `bytes` and the `sample` groups, then repeat with
`"dryRun":false`. Afterwards, re-run the dry run: it should report `0`.

---

## RAW / HEIC previews and WebP thumbnails

Both are made by GitHub runners, dispatched by the Worker.

```bash
# what is left
curl -s -H "authorization: Bearer $T" \
  "https://dropbox.losthusky.qzz.io/api/admin/share-index/previews/pending?limit=200"

# run now (nightly at 22:15 UTC anyway)
curl -s -X POST -H "authorization: Bearer $T" -H "content-type: application/json" \
  -d '{"limit":5000,"shards":8}' https://dropbox.losthusky.qzz.io/api/admin/share-index/previews/run
```

A run takes a few minutes per shard. Expect `pending` to fall by roughly what
the run reports as `done`. **If it falls by much less, that is the lost-update
failure mode** — see CONTEXT.md §7; each shard must be writing its own key.

Files that every decoder refuses are recorded as `skip: "unsupported"`, and
HDR gain-map files as `skip: "gainmap"`, so they are not retried nightly. Both
are served as the original. A handful of those is normal.

---

## R2

**Sweep orphans** — media objects no index references any more:

```bash
curl -s -X POST -H "authorization: Bearer $T" -H "content-type: application/json" -d '{}' \
  https://dropbox.losthusky.qzz.io/api/admin/media/orphans
```

Returns `scanned` / `removed` / `referenced`, and the result is remembered for
the Pipelines tab. A 30-day lifecycle rule on `media/` and `stats/` does the
routine ageing; this is for the rest.

If the bucket is growing unexpectedly, the question is always *which variant*.
`thumb-lo` and `thumb-md` belong there; `thumb-hi` and `preview-webp` do not —
those stream from Google and Drive. `video-720` is a deliberate cache of
previews people actually watched.

---

## Uploads

**Someone says an upload failed.** The per-drop session log has every state
change that browser reported, for 30 days:

```bash
curl -s -H "authorization: Bearer $T" \
  "https://dropbox.losthusky.qzz.io/api/admin/upload-sessions/<slug>?type=upload_error"
```

Also available in the admin UI: drop link → detail → **Upload sessions**, with
filters by event type and file name.

The error codes mean what they say: `E_STALL` (20 s with no progress, retried),
`E_TIMEOUT`, `E_NET`, `E_AUTH` (sign-in expired), `E_CLOSED` (link paused or
expired), `E_BUDGET` (link hit its cap), `E_QUOTA` (Drive is full),
`E_REJECTED` (Drive refused the file), `E_SERVER`.

**Duplicates from a re-upload** should not happen — `/api/preflight` matches on
name + size + `lastModified` and marks them `skipped`. If they do, check that
the completion records carry `lm`.

---

## Deploys

Merging to `main` deploys through the GitHub → Cloudflare integration, ~1–2
minutes. Never `npm run deploy`.

```bash
npx wrangler deployments list        # what is live
curl -s -o /dev/null -w "%{http_code}\n" https://dropbox.losthusky.qzz.io/api/hello
```

After a deploy, check that no index job was mid-chain (see above) and that the
Pipelines tab still loads.

---

## Rotating things

- **Share or drop PIN** — admin UI, link detail → Access. Old PINs stop working
  immediately; existing download tokens keep working until they expire.
- **Admin token** — `npx wrangler secret put ADMIN_TOKEN`, then update
  `.dev.vars` so local probing keeps working.
- **Google refresh token** — `node scripts/get-refresh-token.mjs`, then
  `npx wrangler secret put GOOGLE_REFRESH_TOKEN`. Everything Drive-side is down
  until this is right, so do it deliberately.
