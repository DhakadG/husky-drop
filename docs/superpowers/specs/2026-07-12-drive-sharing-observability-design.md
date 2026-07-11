# Drive, Sharing, and Observability Design

## Objective

Improve the single-page `/admin` experience without duplicating admin pages or state. The immediate release adds a reusable Drive browser, folder creation, multi-folder share selection, a separate New share link tab, branded confirmation dialogs, correct upload-session accounting, an explicit final completion signal, and correctly oriented logo assets. Larger telemetry, digest, and deliverability changes are specified as follow-on plans with concrete event and storage contracts.

## Scope split

### Immediate implementation

- Keep one `public/admin.html` shell and one `public/admin.js` controller.
- Reuse one Drive picker in `drop-single` and `share-multiple` modes.
- Add `POST /api/admin/drive/folders` using the existing `driveCreateFolder()` helper.
- Let the admin create a child folder inside the folder currently being viewed, then remain in that location and select it.
- Move share creation out of the Share links list into `#tab-create-share`.
- Preserve the existing share backend's support for up to ten unrelated Drive folder IDs.
- Replace browser `confirm()` calls with one accessible `<dialog>` component.
- Store an explicit event item count and session ID so activity totals are data-driven.
- Force the final live `done` update after the last Drive verification succeeds.
- Rotate the brand mark clockwise by 90 degrees in CSS and in the checked-in SVG/PNG assets.

### Planned follow-on work

- `drop-trekker.js`: versioned, batched drop-page interaction and upload lifecycle telemetry.
- `share-trekker.js`: versioned, batched gallery navigation, media dwell, download, and ZIP telemetry.
- A server-side analytics ingestion contract with validation, rate limits, bounded retention, and session summaries.
- Rich session digest emails built from authoritative server-side completion records.
- Email deliverability operations: verified SPF/DKIM/DMARC alignment, plain-text alternatives, provider response logging, domain warming, and Postmaster monitoring.

## Drive browser architecture

The picker is one component with a mode and a selection collection:

```text
openDrivePicker({ mode: "drop" | "share", parentId })
  -> GET /api/admin/drive/folders?parent=<id>
  -> breadcrumbs + child folders
  -> open folder OR select folder
  -> POST /api/admin/drive/folders to create a child
```

Drop mode replaces the single destination. Share mode toggles folders in a `Map<id, {id,name,path}>`, renders removable chips, and sends the selected IDs as an array. Folder navigation never implies selection; only a clearly labelled Select/Add button changes selection.

The share landing page already renders independent folder roots and the backend already accepts unrelated folders, so no fabricated common parent is introduced. Each selected root retains its own Drive name and appears as its own gallery section/tab.

## Activity correctness

The current Durable Object batches completed files into one event and writes a label such as `"6 files"`. The admin then counts events and unique labels, producing incorrect totals. Events gain:

```js
{
  si: "upload-session-id",
  n: 6,
  f: "",              // a real filename only for a one-file event
  m: "6 files saved"
}
```

The client sends `sessionId` with `/api/complete`; session start, file completion, and session-close records all store it in `si`. The Activity UI sums `event.n || 1` for file events. A final `sendLive(true)` is emitted when queue state reaches all-done so the Durable Object can persist the completed-session summary and trigger the digest.

## Confirmation dialog

One `<dialog id="confirm-dialog">` contains title, explanation, Cancel, and the destructive action. `confirmAction(options)` returns `Promise<boolean>`, restores focus to the invoking control, closes on Escape, and never relies on browser-specific confirmation chrome.

## Visual direction

The new controls extend the existing blue/teal glass interface. Folder creation is a quiet inline toolbar action, selected share folders are compact path chips, and destructive confirmation spends the red accent only on the final action. The logo artwork is unchanged except for the requested exact clockwise rotation.

## Telemetry boundaries

Follow-on trackers will record meaningful UI actions and outcomes, not keystrokes or secret values. PINs, tokens, form input contents, full URLs with credentials, and arbitrary DOM text are prohibited. Events use both wall-clock UTC milliseconds and monotonic elapsed milliseconds, are queued in memory, flushed with `sendBeacon`/`fetch keepalive`, capped per batch, and de-duplicated server-side by event ID.

## Email deliverability boundary

Code can improve standards compliance, content, provider error visibility, and plain-text support; it cannot guarantee inbox placement. Current public DNS already publishes SPF, DKIM, and a DMARC monitoring policy. The follow-on plan upgrades observability and describes a safe progression from `p=none` after authentication is verified. It does not silently mutate DNS or claim that HTML styling alone fixes sender reputation.

## Verification

- Backend smoke tests cover folder creation, unrelated share roots, session IDs, event counts, and completion state.
- Admin structure tests cover the separate New share link tab, shared picker modes, folder creation controls, and the absence of native `confirm()`.
- Asset tests verify SVG rotation and PNG dimensions/availability.
- Full `npm test`, `git diff --check`, and `npx wrangler deploy --dry-run` must pass.

## Decisions and rejected alternatives

- Rejected separate drop/share picker implementations because they would duplicate navigation, breadcrumb, and creation logic.
- Rejected a synthetic common Drive parent for share links because unrelated roots are already a supported and useful data model.
- Rejected raw per-click KV writes because they would exceed the free-tier write budget; follow-on trackers batch through the Durable Object.
- Rejected inferring analytics from user-facing strings because localization or batching changes would break counts again.
