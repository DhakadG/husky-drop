# Architecture

```text
friend phone -- ask session --> Worker -- mint session URI --> Drive API
      |                                                         ^
      |                                                         |
      +-- resumable chunk PUTs directly to googleapis.com ------+

friend phone -- live progress WS --> Durable Object <-- admin dashboard WS
Worker/KV <---- low-volume events, counters, upload history ---- Worker
```

File bytes never touch the Worker. The Worker is a control plane: it mints
Drive resumable sessions, enforces PINs and lockouts, records metadata, and
relays live progress.

## Live Progress Without KV Write Exhaustion

Claude's initial v2 plan used KV heartbeats every 15 seconds. This workspace
uses a Durable Object instead:

- The uploader opens `GET /api/live/upload/:slug` as a WebSocket.
- The admin opens `GET /api/admin/live?token=...` as a WebSocket.
- `LiveTracker` stores active sessions in memory and broadcasts snapshots.
- `/api/progress` exists only as a fallback and also updates the Durable Object
  in memory.
- KV is not used for repeated progress snapshots.

This removes the KV write-limit risk. The tradeoff is that active progress is
ephemeral if the Durable Object restarts. Uploads still continue because Google
Drive owns the resumable upload session.

## KV Schema

| Key | Value / metadata | TTL |
| --- | --- | --- |
| `link:{slug}` | full link record | expiry + 30 days, or none |
| `stats:{slug}` | `{opens,sessions,files,bytes}` | none |
| `up:{slug}:{ts}:{r}` | `"1"`, metadata = upload record | 1 year |
| `ev:{invTs}:{r}` | event JSON | 90 days |
| `bf:{slug}:{ipHash}` | per-IP brute-force state | 24 hours |
| `bfg:{slug}` | per-link damping state | 2 hours |
| `folder:{slug}:{uploaderHash}` | Drive uploader subfolder cache | 180 days |
| `started:{slug}:{sessionId}` | start notification/event guard | 1 day |
| `gtoken` | cached Google access token | token lifetime |

## Durable Object State

`LiveTracker` keeps:

- Active upload sessions by session ID.
- Connected admin WebSockets.
- In-memory locks for per-uploader Drive folder creation.
- In-memory first-seen guards for upload session start events.
- Last update timestamps.

Sessions are pruned after 2 minutes without updates.
Folder locks prevent parallel file-session requests from creating duplicate
uploader folders when the same person uploads multiple files at once. The KV
`started:*` guard remains as durable backup, but the Durable Object handles
same-moment parallel requests before KV consistency can race.

## Upload Tuning

Per-link settings:

- `concurrency`: 1-4 parallel files.
- `chunkMB`: 8, 16, or 32 MB.
- `perUploaderFolders`: creates/uses a Drive subfolder per uploader.
- `maxTransferBytes`: defaults to 5 TB.

8/16/32 MB chunk sizes are multiples of Google's required 256 KiB unit.
