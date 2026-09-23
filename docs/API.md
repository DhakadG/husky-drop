# API Reference

Base: the Worker origin. All request bodies are JSON. Errors use `{ "error":
"message" }` with an HTTP status. PIN-checking endpoints may return `429
{error, retryAfter}` plus a `Retry-After` header during lockout.

> **v2 additions (2026-07)** - summary of endpoints added by the transfer.zip
> adaptation pass; older sections below still apply unless noted:
>
> Public:
> - `POST /api/client-error` `{linkId?, uploader?, name, message}` - rate
>   limited 5/min/IP via the Durable Object; logged as `clienterror` events.
> - `POST /api/preflight` `{linkId, pin, files:[{name,size,lastModified}]}` -
>   per file `{status:"new"|"duplicate", fileId?, at?, uploader?}` against the
>   drop's completed uploads (name + size, + lastModified when recorded). At
>   most 500 files per call (the client batches); matched against every
>   verified completion in the Durable Object's index, plus the recent KV rows.
> - `GET /api/share/meta/:slug` - public share-link metadata (no folder IDs).
> - `POST /api/share/verify` `{slug, pin}` - share PIN gate (same lockouts).
> - `POST /api/share/opened` `{slug}` - share open counter (DO-batched).
> - `POST /api/share/list` `{slug, pin, folderIndex?, pageToken?}` - lists
>   files with 15-min signed download URLs + short-lived thumbnail URLs.
> - `POST /api/share/redirect` `{slug, pin}` - redirect-mode Drive URLs
>   (re-grants the anyone-reader permission if needed).
> - `GET /api/share/dl/:token` - streams one file from Drive through the
>   Worker; token is HMAC-signed, scope+slug+file+expiry bound. `?inline=1`
>   is honoured only for images, video and audio; every other type (HTML,
>   SVG, XML, scripts) is sent as an attachment. Every response carries a
>   `sandbox` CSP, and the public-download safety list applies either way.
> - `GET /api/share/media/:slug/:fileId/:variant/:rev/:sig` - thumbnails
>   (`thumb-lo` 512px, `thumb-md` 1024px, `thumb-hi` 1600px) and the 720p
>   video preview (`video-720`, Range-aware) through the media cache ladder:
>   edge cache → R2 `MEDIA_BUCKET` → Drive. `rev` is the file's Drive md5
>   (or modified time), so the URL is stable for the life of the bytes and is
>   served `immutable` for 30 days; `sig` is an HMAC over slug+file with no
>   expiry. The share's state and the viewer's sign-in are re-checked on every
>   request before any cache tier is consulted. Listings hand these out in
>   `thumbs` / `preview`; `/api/share/thumb/:token/:tier` remains for
>   listings cached before the switch.
> - `POST /api/share/stats` `{slug, pin}` - every folder's subtree totals
>   (`files, photos, videos, bytes, folders, oldest, newest`) plus a `cover`
>   thumbnail URL, keyed by the listing's stable `fid`. Answered from the
>   share-index blob in R2; `{indexed:false}` until the first index lands.
> - `POST /api/share/summary` answers from the same blob when the share is
>   indexed (`indexedAt` present) and only walks Drive otherwise.
> - Listing a share also runs the cheap change check in the background: one
>   Drive `changes.list` per `CHANGE_WINDOW_SEC` across the whole app; a hit
>   starts a targeted share-index job for exactly the ids that changed.
>
> Admin (cookie session `hd_admin` OR `Authorization: Bearer ADMIN_TOKEN`):
> - `POST /api/admin/login` `{token}` - sets HttpOnly cookie (7d); login is
>   rate limited 5 / 15 min / IP. `POST /api/admin/logout` clears it.
> - `GET /api/admin/timeseries?days=30&slug=` - per-day rollups
>   `{rows:[{day,opens,sessions,files,bytes,shareOpens,downloads,servedBytes}]}`
>   from DO SQLite. `opens/sessions/files/bytes` are drop links only;
>   `shareOpens/downloads/servedBytes` are share links (`share:<slug>` rows).
> - `GET/POST /api/admin/shares`, `PATCH/DELETE /api/admin/shares/:slug` -
>   share-link CRUD (`{label, slug?, folders, mode, pin?, expiresDays,
>   allowZip}`; folders accepts Drive URLs or IDs, comma separated).
> - `PATCH /api/admin/links/:slug` now also accepts `disabled` (pause) and
>   settings `maxTotalBytes`, `maxTotalFiles`, `maxSessions` (budgets;
>   breaching one auto-pauses the link and returns `413`).
> - `POST /api/session` now also accepts `relativePath` (folder uploads) and
>   returns `507` when Drive free space (minus a 5 GB reserve) cannot fit the
>   file; paused links return `403`.
> - Admin live WebSocket `/api/admin/live` authenticates via the session
>   cookie; the `?token=` query parameter is gone.
> - `GET /api/link/:slug` additionally returns `paused`, `state`, and
>   `driveFreeGB`.
> - Events are stored in one rolling KV key (`events:recent`, cap 200) and
>   all counters flush through the Durable Object in batches (KV free-tier
>   safety); `ev:*` per-event keys are legacy and self-expire.

## Public

### `GET /api/link/:slug`

Returns:

```json
{
  "slug": "trip",
  "label": "Spiti Trip",
  "requiresPin": true,
  "expiresAt": 1780000000000,
  "expired": false,
  "theme": {},
  "settings": {}
}
```

`theme` and `settings` drive the drop page. `folderId`, `pinHash`, and
`pinSalt` never leave the admin API.

### `POST /api/verify`

Body:

```json
{ "linkId": "trip", "pin": "1234" }
```

Returns `{ok:true}` or `403` wrong, `410` expired, `429` locked.

### `POST /api/session`

Body:

```json
{
  "linkId": "trip",
  "pin": "1234",
  "filename": "IMG_0001.MOV",
  "size": 1200000000,
  "mimeType": "video/quicktime",
  "uploaderName": "Riya",
  "sessionId": "browser-session-id"
}
```

Returns `{sessionUri}`. Validates link, PIN, file size and `sessionId` (one
stable id per browser session, required, 400 without it) before any Google
call. If `settings.perUploaderFolders` is enabled, the Worker finds or creates
`<chosen folder>/<uploaderName>/` and parents the file there.

### `GET /api/live/upload/:slug`

Uploader WebSocket endpoint. Preferred live-progress path because it does not
write to KV.

The drop page sends:

```json
{
  "type": "progress",
  "sessionId": "browser-session-id",
  "slug": "trip",
  "label": "Spiti Trip",
  "uploader": "Riya",
  "files": [{ "name": "IMG.MOV", "size": 2000, "sent": 1000, "state": "uploading" }],
  "sent": 1000,
  "total": 2000,
  "state": "uploading"
}
```

### `POST /api/progress`

Compatibility fallback for heartbeat-style clients:

```json
{
  "linkId": "trip",
  "pin": "1234",
  "sessionId": "browser-session-id",
  "uploader": "Riya",
  "files": [{ "n": "IMG.MOV", "s": 2000, "sent": 1000, "st": "uploading" }],
  "sent": 1000,
  "total": 2000,
  "final": false
}
```

This validates the PIN, starts a session event if needed, and forwards the
snapshot to the Durable Object. `sessionId` is required (400 without it); the
relay runs after the `{ok:true}` ack. It does not store progress snapshots in KV.

### `POST /api/complete`

Body:

```json
{ "linkId": "trip", "filename": "IMG.MOV", "size": 2000, "mimeType": "video/quicktime", "uploader": "Riya", "fileId": "drive-file-id" }
```

Writes upload history, file event, and counters.

### `POST /api/opened`

Body:

```json
{ "linkId": "trip" }
```

Page-open tracking. The client de-dupes per browser session.

## Admin

All admin endpoints require:

```text
Authorization: Bearer <ADMIN_TOKEN>
```

### `GET /api/admin/live`

Admin WebSocket endpoint (cookie-authenticated). On connect the server sends
`{type:"snapshot", active:[...], recent:[...]}`; afterwards it sends
coalesced deltas `{type:"patch", updated:[session], removed:[id], recent?}`
that the client merges by session id. Sockets are hibernatable, so an idle
dashboard costs nothing while no upload is running.

### `GET /api/admin/overview`

Returns:

```json
{
  "totals": { "links": 1, "opens": 2, "sessions": 3, "files": 4, "bytes": 5 },
  "links": [],
  "active": [],
  "events": []
}
```

`active` comes from the Durable Object snapshot. Durable history remains in KV.

### `POST /api/admin/live/close`

Body: `{id?, slug?}`. Returns `{ok, closed}`.

Dismisses stuck or abandoned live transfers from the admin dashboard. `id`
closes one session; `slug` without `id` closes every live session for that
link. This only clears live dashboard state; completed Drive files stay in
Drive.

### `GET /api/admin/link/:slug`

Returns `{link, uploads, count, totalBytes, active}`.

### `POST /api/admin/links`

Body:

```json
{
  "label": "Spiti Trip",
  "slug": "spiti-26",
  "pin": "1234",
  "expiresDays": 14,
  "folderId": "",
  "folderName": "",
  "settings": { "concurrency": 2, "chunkMB": 8, "perUploaderFolders": true },
  "notify": { "enabled": true, "start": true, "complete": false },
  "theme": { "logoUrl": "", "backgroundUrl": "", "accentColor": "#f2a33c" }
}
```

Blank folder means auto-create under `DRIVE_PARENT_ID` if configured.

### `PATCH /api/admin/links/:slug`

Accepts any subset of `label`, `pin` (`""` clears), `expiresDays`,
`settings`, `notify`, and `theme`. Returns the updated admin-shaped link.

### `DELETE /api/admin/links/:slug`

Deletes the link record. Drive files remain.

### `GET /api/admin/uploads/:slug`

Returns `{uploads, count, totalBytes}`.

### `DELETE /api/admin/uploads/:slug/:fileId`

Moves the file to Drive's trash (recoverable for 30 days), drops it from the
link's recent list and counters, and logs a `filedel` event. The file must
carry this link's `dropLink` property (403 otherwise). Returns `{ok, removed}`.

### Video previews (`/api/admin/previews/*`)

Used by `.github/workflows/transcode-previews.yml` (Bearer `ADMIN_TOKEN`).

- `GET /api/admin/previews/pending?limit=20` — videos in active shares with
  no preview yet: `{pending: [{id, name, size, mime}], indexed}`.
- `GET /api/admin/previews/source/:fileId` — streams the original.
- `PUT /api/admin/previews/:fileId` (body: MP4, ≤ 90 MB) — stores the preview
  in the private `_previews` folder under `DRIVE_PARENT_ID` with
  `appProperties.previewOf`, and records it in KV `previews:index`.
- `POST /api/admin/previews/report` — batch results from the Action
  (`{runId, trigger, startedAt, done[], skipped[], finishedAt?, pendingLeft?}`);
  reports are forwarded to the LiveTracker Durable Object, which applies
  them one batch at a time (a burst from parallel shards becomes one KV
  write) to the single `previews:index` key.
- `GET /api/admin/previews/overview[?fresh=1]` — totals, per-folder coverage
  for every active share, failed files, last 20 runs, the queue, the active
  GitHub run (when `GITHUB_TOKEN` is set) and `nextRunAt`. The Drive walk is
  memoised per isolate for 60 s; `fresh=1` bypasses it. No KV writes.
- `POST /api/admin/previews/run` `{limit?, folderIds?, fileIds?, retryFailed?}`
  — records the queue (served first by `pending`) and dispatches the
  workflow; 202 with `dispatched:false` + `reason` when it cannot.
- `POST /api/admin/previews/retry` `{fileIds?}` — clears failure counts
  (all when empty).
- `DELETE /api/admin/previews/:fileId` — trashes the preview so it is
  regenerated. Trashing an original via `/api/admin/uploads` also drops
  its preview.
- `POST /api/admin/previews/reindex` — rebuilds the file map from the folder.

Share listings then carry `preview` / `previewExpiresAt` (a 4-hour signed
`dl` token for the preview file) plus `previewState`
(`ready` | `queued` | `failed`) next to `dl`.

### Image archive (`/api/admin/images/*`)

Re-encode photos in chosen Drive folders (recursive) to a resolution cap
and quality, with a dry run first. All Drive writes happen in the worker;
`scripts/transcode-images.mjs` (workflow `transcode-images.yml`) does the
pixel work with sharp + libraw + libheif + exiftool.

- `GET /api/admin/images/sources` — folders the app already knows (shares,
  drop links) for one-click picking.
- `POST /api/admin/images/scan` `{folderIds[]}` — walks the folders
  (metadata only, no KV) and returns compact rows (`id, n, f, t, s, w, h,
  m, x, c, a` = name, folder index, type, size, width, height, modified,
  has .xmp sidecar, copy exists in `_compressed`, exists in `_archive`) plus
  the folder tree, so the admin estimates any recipe instantly.
- `POST /api/admin/images/plan` — options `{folderIds[], recursive, maxMp
  (0|4|6|8|12|16|24), quality 50-95, format same|jpeg|webp|avif, metadata
  keep|strip-gps|strip, minBytes, targetBytes, onlyIfSmaller, exclude
  (regex), types[], excludeFolderIds[], skipRecentDays, skipSidecar,
  largestFirst, parallel 1-8, mode copy|archive|replace}`. Walks the folders (metadata only) and stores
  a job (`status: planned`) with a digest: files, bytes now → expected,
  ETA, by type, skip reasons, largest files. One KV write.
- `GET /api/admin/images/jobs` — last 10 jobs (plan file lists omitted) +
  the active one.
- `POST /api/admin/images/jobs/:id/start` (`{confirm: "REPLACE"}` required
  for replace mode) / `pause` / `resume` / `cancel`. Start and resume
  dispatch the workflow when `GITHUB_TOKEN` is set; while another job runs
  the job is `queued` and starts from the finishing job's final report.
- `POST /api/admin/images/jobs/:id/undo` — copy jobs: trash the copies;
  archive jobs: move originals back and trash the copies. Chunked (60 per
  call, returns `remaining`). Replace jobs: 409.
- `GET /api/admin/images/jobs/:id/items` — processed files with outcome.
- Runner: `GET …/:id/next?n=8`, `GET /api/admin/images/source/:fileId`,
  `PUT …/:id/file/:fileId` (header `x-format`; the worker applies the mode -
  new revision of the same id, move original to `_archive/<folder>/`, or
  new file in `_compressed/<folder>/` - and verifies the stored size),
  `POST …/:id/report` (batch; `stopped` marks the job paused, `finished`
  marks it done). One KV write per report.

### Rules, conversion, logs

- `GET /api/admin/images/rules`, `POST /api/admin/images/rules` (`{id?,
  name, every daily|weekly|monthly, enabled, notify, options, confirm}`),
  `DELETE /api/admin/images/rules/:id`, `POST …/rules/:id/run`. A POST with
  an existing `id` and no `options` only changes `enabled`/`notify`/`every`/
  `name` and leaves the stored recipe untouched. The cron trigger runs due
  rules via `runDueRules`.
- `POST /api/admin/images/jobs/:id/convert` `{to: copy|archive}` —
  chunked outcome switch for finished copy/archive jobs.
- `GET /api/admin/logs?limit&area&level&before` — app log rows from the
  Durable Object (`{id, at, level, area, message, detail}`).
- `GET /api/admin/people?days` — visitor profiles from the last N days
  (default 90). Key is `email:<addr>`, `device:<hd_did>`, or `name:<typed>`.
- `GET /api/admin/people/:key` — that person's events, newest first.
- `POST /api/admin/people/merge` `{key, email}` — fold a `device:`/`name:`
  profile into a Google account (empty `email` unlinks). Typed names that
  only one signed-in account has ever used are merged automatically.

- `POST /api/hello` `{fp, slug, sessionId, meta}` — once per page load from
  drop/share pages: Fingerprint Pro visitor id (public key, `ap` region;
  vendored open-source agent as ad-block fallback) plus client details (screen,
  timezone, language, platform, browser, cores, memory, touch, network).
  Upserts the device row in the DO `sessions` table and, when the viewer is
  signed in, links the device and fingerprint to that account. With the
  `FP_SERVER_KEY` secret (Fingerprint secret key, region `ap`) the worker also
  pulls the Server API verdict for `fpEvent`: id confidence, OS/browser
  version, device, city/ASN, VPN/proxy/Tor/datacenter, tampering, anti-detect,
  dev tools, high-activity, suspect score, IP/country velocity. Risky visits
  log a warning under `people`; flags show on the profile's device rows.
  With `FP_RULESET_ID` the call also evaluates that Rules Engine ruleset
  (`rule_action.type` → `rule` / `ruleWhy` on the device row).
- `PATCH /api/admin/links/:slug` and `/api/admin/shares/:slug` accept
  `{archived: true|false}`; archived links report state `archived` and are
  closed to visitors.
- `GET /api/admin/sessions?limit` — recent device rows.
- `GET|POST|DELETE /api/admin/people/suggestions` — Claude-proposed merges
  of unsigned visits into accounts (POST runs the pass now; DELETE `{key}`
  dismisses one). Also runs on the nightly cron when `GEMINI_API_KEY`
  (Google AI Studio, free tier; optional `GEMINI_MODEL`, default
  `gemini-3.6-flash`) or `ANTHROPIC_API_KEY` is set. Accepting = the normal
  merge call.
- `GET|POST|DELETE /api/admin/bans` `{kind: email|device|fp, value, reason}` —
  blocked accounts/devices. Banned visitors get 403 on `/d/`, `/s/`, session
  creation and share listing/downloads (cached 30 s per isolate). Only
  `email` values are lowercased; device and fingerprint ids are matched exactly.
- `POST /api/session` accepts `uploaderAlias`; per-uploader folders become
  `Name -- Alias`. A signed-in Google account names the uploader even on
  links that do not require sign-in.

Pages under `/d/` and `/s/` set an anonymous `hd_did` cookie (random 24 hex,
HttpOnly, 400 days). Events carry it as `d` and the signed-in Google e-mail
as `e`, the FingerprintJS id (client-set `hd_fp` cookie) as `p`; the Durable
Object's `identities`/`aliases` tables link device and fingerprint to the
account so older anonymous events are attributed once it signs in.

### share-index (`/api/admin/share-index/*`, `/api/admin/media/orphans`)

Folder stats + thumbnail pre-warm per gallery share (design spec §2/§4/§8.3).

- `GET /api/admin/share-index/jobs` - last 20 jobs with progress; `chunk` is
  the subrequest budget per invocation (`INDEX_CHUNK`); each chunk also stops after `INDEX_CHUNK_MS` (20 s) because background continuation is cut off at 30 s.
- `POST /api/admin/share-index/run` `{slug, full?}` - "Process now". `202`
  when a job started, `200 {started:false, reason:"already indexing"}` when
  that share is mid-walk (the lock is per share).
- `POST /api/admin/share-index/jobs/:id/continue` - runs one more chunk. The
  Worker calls this on itself after every chunk; the nightly cron resumes any
  running job that stalled.
- `GET /api/admin/share-index/status/:slug` - `{pointer, active, last}`.
- `POST /api/admin/share-index/check-changes` - force the change check. Reads
  at most 5 pages; when more remain it saves the next page token and
  answers `behind: true`, and the next check continues from there.
- `POST /api/admin/media/orphans` `{cursor?, dryRun?}` - deletes R2 media
  objects no indexed share references (one bucket page per call; loop while
  `cursor` is returned).
- `GET /api/admin/share-index/previews/pending?limit=&shards=&shard=` -
  files in indexed shares that want a WebP preview-equivalent (RAW / HEIC /
  TIFF, or decodable images ≥ 50 MB) and have none for their current
  revision. `PUT /api/admin/share-index/preview/:fileId?rev=` stores the WebP
  in R2 (`media/<id>/preview-webp-<rev>`); `POST
  /api/admin/share-index/preview-report` merges a runner batch into KV
  `share-previews:index` (gain-map HDR files are recorded as "keep the
  original"); `POST /api/admin/share-index/previews/run` dispatches
  `transcode-share-previews.yml`. Listings then carry `previewImage`,
  `previewImageUrl`, `previewImageBytes`, `heavy` and point `thumbs.max` at
  the WebP.
- `GET /api/admin/share-index/thumbs/pending`, `GET .../thumb-source/:id/:variant/:rev` (`204` when R2 already has a WebP, else Drive's JPEG), `PUT .../thumb/:id/:variant/:rev` (WebP) - the runner's WebP thumbnail loop.
- `GET /api/share/media/.../preview-webp/...?dl=<name>` serves the WebP as
  an attachment; `POST /api/share/zip-ticket` accepts `format: "webp"` and
  pulls previews from R2 for files that have one (originals otherwise).
- `POST /api/admin/links` accepts `createShare: true`: the folder is created
  synchronously and a gallery share (same slug, sign-in, PIN, expiry) is
  created on it and indexed; the response adds `share: {slug, url}` or
  `shareError`.
- Shares carry `indexSchedule` (`daily|weekly|monthly|null` = global
  `INDEX_SCHEDULE`) via `PATCH /api/admin/shares/:slug`; creating a gallery
  share starts its first index immediately.

Storage: KV `share-index:jobs` (written at job start/end only), KV
`share-stats:<slug>` pointer, R2 `stats/<slug>.json` (folders),
`stats/<slug>.files.json` (file rows), `stats/<slug>.job.json` (cursor), KV
`changes:cursor` (one Drive change token for the app).

### `GET /api/admin/upload-sessions/:slug?type=&file=&since=&limit=`

Per-file upload telemetry for one drop, grouped by browser session (30-day
DO table `telemetry_batches`), filterable by event type and file name.
`GET /api/admin/share-index/gaps/:slug` lists subfolders a completed index
never walked and folders that are simply empty.

`POST /api/admin/share-index/dedupe` `{slug, folder, dryRun?, limit?}` finds files
with the same Drive md5 and size inside one indexed folder subtree (`folder`
is an id, path or name). The oldest copy stays; with `dryRun:false` the rest go
to Drive's trash (recoverable for 30 days) and a targeted job drops them from
the index. Name-only matches are listed under `nameOnly`, never touched.

`POST /api/admin/share-index/thumbs-report` is the WebP thumbnail runner's
progress report (`{runId, shard, shards, made, had, failed, bytesIn, bytesOut,
total, finished}`), merged per run into `share-thumbs:runs`.

### Pipelines (`/api/admin/pipelines`)

`GET /api/admin/pipelines` is the admin **Pipelines** tab: share-index jobs
with their live cursor (phase, chunk, folders/files walked, warm progress,
queued folders, pending changes), the RAW/HEIC preview runner (indexed, kept
original, pending, last runs), the WebP thumbnail runs, video previews, the
image-archive job, the Drive change feed cursor and the last orphan sweep.
With `GITHUB_TOKEN` set it also lists recent GitHub Actions runs of the three
transcode workflows with per-shard jobs for the active ones.
`POST /api/admin/pipelines/cancel` `{runId}` cancels a GitHub run.

### `GET /api/admin/thumb/:fileId`

Returns Drive file preview metadata for admin-side preview/open actions.

## Environment

Secrets:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REFRESH_TOKEN`
- `ADMIN_TOKEN`
- optional `RESEND_API_KEY`
- optional `NOTIFY_TO`
- optional `NOTIFY_FROM`
- optional `GITHUB_TOKEN` — fine-grained PAT (Actions: read & write on this
  repo) so the admin "Run now" button can dispatch the preview transcoder
  and show the active run. Without it, queued work waits for the schedule.

Vars:

- optional `DRIVE_PARENT_ID`
- optional `GITHUB_REPO` — `owner/repo` for the transcoder workflow
  (default `DhakadG/husky-drop`).
- optional `LINK_SLUGS` — comma-separated existing slugs for admin overview
  recovery/fast-path when KV list quota is exhausted.
