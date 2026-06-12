# API Reference

Base: the Worker origin. All request bodies are JSON. Errors use `{ "error":
"message" }` with an HTTP status. PIN-checking endpoints may return `429
{error, retryAfter}` plus a `Retry-After` header during lockout.

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

Returns `{sessionUri}`. Validates link, PIN, and file size before any Google
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
snapshot to the Durable Object. It does not store progress snapshots in KV.

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

### `GET /api/admin/live?token=<ADMIN_TOKEN>`

Admin WebSocket endpoint for live upload progress snapshots.

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

Vars:

- optional `DRIVE_PARENT_ID`
