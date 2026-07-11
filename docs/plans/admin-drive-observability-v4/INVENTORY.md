# Admin Drive & Observability v4 — Inventory

Source design: `docs/superpowers/specs/2026-07-12-drive-sharing-observability-design.md`.

**Admin architecture constraint:** `/admin` remains one document (`public/admin.html`) controlled by one script (`public/admin.js`). “New share link” is another `tab-pane`, not a page or route. Drive browsing is implemented once and switched between single-select and multi-select modes.

| Requirement | Current state | Release disposition | Plan |
|---|---|---|---|
| Create a Drive folder while browsing | `driveCreateFolder()` exists; no admin route/UI | Implement now | `plans/00-quick-implementation.md` |
| Browse Drive for drop destination | Existing single picker | Refactor into shared picker | `plans/00-quick-implementation.md` |
| Browse and select unrelated share folders | Backend supports up to 10 IDs; UI is raw text | Implement multi-select UI now | `plans/00-quick-implementation.md` |
| Separate New share link tab | Form is embedded below Share links | Move pane now | `plans/00-quick-implementation.md` |
| Replace native confirmations | Two `confirm()` calls | Replace with one `<dialog>` now | `plans/00-quick-implementation.md` |
| Correct activity file totals | Batch events are counted as files/events | Add explicit event count and session ID now | `plans/00-quick-implementation.md` |
| Always record completed transfer | Final live update is not forced | Emit terminal progress now | `plans/00-quick-implementation.md` |
| Correct logo orientation + assets | CSS mark is `-6deg`; assets share old orientation | Rotate exactly +90° now | `plans/00-quick-implementation.md` |
| Per-click drop analytics | No dedicated module | Planned | `plans/01-drop-trekker.md` |
| Per-click share/media dwell analytics | Analytics is embedded and coarse | Planned | `plans/02-share-trekker.md` |
| Validated batched analytics backend | Existing endpoints accept small coarse batches | Planned | `plans/03-analytics-backend.md` |
| Detailed session digest | Completion email contains only count and bytes | Planned | `plans/04-session-digest-and-deliverability.md` |
| Spam/deliverability hardening | SPF/DKIM/DMARC exist; provider response ignored; no text part | Planned + operational | `plans/04-session-digest-and-deliverability.md` |

## Confirmed root causes

1. `LiveTracker.flushCompletions()` writes one `file` event per alarm batch with `f: "N files"`; `admin.js` counts events and unique `f` strings. This explains “20 uploads / 6 files” for a much larger transfer.
2. `/api/complete` omits `sessionId`, session-start events omit `si`, and completion batches cannot be joined authoritatively to the upload session.
3. `setState(item, "done")` updates the local queue but does not call `sendLive(true)`. The last WebSocket update can therefore remain `uploading`.
4. Gmail shows SPF/DKIM-aligned mail, and public DNS also has `_dmarc` with `p=none`; inbox placement is therefore not fixable by HTML alone. Missing plain text, ignored Resend errors, low/new-domain reputation, and prior recipient spam classification remain relevant.

## Dependency order

1. `00-quick-implementation.md`
2. `03-analytics-backend.md`
3. `01-drop-trekker.md` and `02-share-trekker.md`
4. `04-session-digest-and-deliverability.md`
