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
> - `GET /api/share/meta/:slug` - public share-link metadata (no folder IDs).
> - `POST /api/share/verify` `{slug, pin}` - share PIN gate (same lockouts).
> - `POST /api/share/opened` `{slug}` - share open counter (DO-batched).
> - `POST /api/share/list` `{slug, pin, folderIndex?, pageToken?}` - lists
>   files with 15-min signed download URLs + short-lived thumbnail URLs.
> - `POST /api/share/redirect` `{slug, pin}` - redirect-mode Drive URLs
>   (re-grants the anyone-reader permission if needed).
> - `GET /api/share/dl/:token` - streams one file from Drive through the
>   Worker; token is HMAC-signed, scope+slug+file+expiry bound.
>
> Admin (cookie session `hd_admin` OR `Authorization: Bearer ADMIN_TOKEN`):
> - `POST /api/admin/login` `{token}` - sets HttpOnly cookie (7d); login is
>   rate limited 5 / 15 min / IP. `POST /api/admin/logout` clears it.
> - `GET /api/admin/timeseries?days=30&slug=` - per-day rollups
>   `{rows:[{day,opens,sessions,files,bytes,downloads}]}` from DO SQLite.
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
  one KV write per report merges the file map, failure counts and run
  history into the single `previews:index` key.
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

- `POST /api/admin/images/plan` — options `{folderIds[], recursive, maxMp
  (0|4|6|8|12|16|24), quality 50-95, format same|jpeg|webp|avif, metadata
  keep|strip-gps|strip, minBytes, onlyIfSmaller, exclude (regex), types[],
  mode copy|archive|replace}`. Walks the folders (metadata only) and stores
  a job (`status: planned`) with a digest: files, bytes now → expected,
  ETA, by type, skip reasons, largest files. One KV write.
- `GET /api/admin/images/jobs` — last 10 jobs (plan file lists omitted) +
  the active one.
- `POST /api/admin/images/jobs/:id/start` (`{confirm: "REPLACE"}` required
  for replace mode) / `pause` / `resume` / `cancel`. Start and resume
  dispatch the workflow when `GITHUB_TOKEN` is set.
- `GET /api/admin/images/jobs/:id/items` — processed files with outcome.
- Runner: `GET …/:id/next?n=8`, `GET /api/admin/images/source/:fileId`,
  `PUT …/:id/file/:fileId` (header `x-format`; the worker applies the mode -
  new revision of the same id, move original to `_archive/<folder>/`, or
  new file in `_compressed/<folder>/` - and verifies the stored size),
  `POST …/:id/report` (batch; `stopped` marks the job paused, `finished`
  marks it done). One KV write per report.

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
