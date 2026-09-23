# Review — `admin-drops`

_agent review (surface) · 2026-09-23_

> Creating and inspecting drop links is well covered - settings accordion, budgets, the per-session event log. The weak spot is the settings save: it re-renders the whole view the moment the request returns, so both the 'Saved'/'failed' message and any edits vanish, and every save quietly moves the expiry date. The detail page also knows far less than the app does (no per-link chart, no link to the share of this folder, history silently capped at 200).

## Findings

### MEDIUM · Do not re-render the detail view on top of a failed save

**Where:** public/admin-detail.js:263-271 · **Category:** correctness · **Confidence:** 0.85

**When:** Admin edits five fields in Settings and clicks Save; the PATCH fails (network, 500) or succeeds.

**Result:** saveDetail() writes 'Save failed.' and then immediately calls refreshDetail(), whose renderDetail() replaces #detail-view including #detail-msg - the message disappears within a few hundred ms and, on failure, every edited field snaps back to the server value, so the admin's changes are lost without a visible error.

**Fix:** On !r.ok, show the server's error text (await r.json().error) and return without refreshDetail(). On success, call refreshDetail() first and set #detail-msg ('Saved.') after it resolves; use a success class instead of msg-err.

### MEDIUM · Only send expiresDays when the admin changed it

**Where:** public/admin-detail.js:44, 108, 234 + src/admin-api.js:171-174 · **Category:** correctness · **Confidence:** 0.8

**When:** A link expires in 2 days 3 hours; the admin opens Settings to change the label and saves.

**Result:** The form shows Math.ceil(remaining) = 3 and saveDetail always sends expiresDays, so patchLink sets expiresAt = now + 3 days: every unrelated save silently extends the link by up to a day, and a link can be kept alive indefinitely by editing it.

**Fix:** Remember the rendered d-days value and include expiresDays in the PATCH body only if the input differs from it (same pattern as the pin field).

### LOW · Say when upload history is truncated

**Where:** public/admin-detail.js:183-184 + src/store.js:211-227 · **Category:** ux · **Confidence:** 0.8

**When:** A link has received 1,204 files; recent:<slug> holds only the newest 200 (RECENT_CAP).

**Result:** The Files card says 1,204 while the history header says '200 files · 38 GB' with no hint that the list is capped; searching for an older file returns 'No files match the filter' although it exists.

**Fix:** When uploads.length < link.stats.files, render '200 most recent of 1,204 - sync from Drive for all' in #up-count and make the empty-filter message offer the Drive sync.

### LOW · Surface failures from pause, archive and delete

**Where:** public/admin-links.js:313-324, 332 · **Category:** ux · **Confidence:** 0.7

**When:** The admin session expired, or KV rejects the write, and the admin clicks Pause on a link being abused.

**Result:** The fetch result is ignored; refreshAll() redraws the card unchanged and the admin believes the link is paused when it is not.

**Fix:** Check r.ok in toggleLinkPause/toggleLinkArchive/deleteLink and flash the returned error on the clicked button (flash() already exists in admin.js).

## Layout

- Move 'Upload sessions' (debug) below Settings - it is a troubleshooting tool, and on a healthy link it pushes the settings far down the page.
- Show the budget bar inside the stat grid's 'Received' card instead of as a separate strip under it.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Per-link 30-day chart on the detail page | 'When did people actually upload to this link?' has no answer on the page that is about this link. | Link detail, under the stat cards | small | already available (/api/admin/timeseries?slug=) |
| Share this drop's folder from the detail page | The 'share this folder' shortcut only exists on the create-success screen; a week later the admin has to rebuild it by hand in the Shares tab. | Link detail action row | small | already available (/api/admin/links/:slug/folder + create-share tab) |
| Extend / set expiry as an explicit action | Expiry is a 'days from now' number buried in the Access accordion; the common task is 'give them one more week'. | Link detail header next to the status chip | small | already available (PATCH expiresDays) |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Link detail header | the share link(s) whose folderIds include this drop's folderId | shows at once whether the uploaders' files have been shared back |
| Top uploaders row / Upload history uploader cell | People profile | one click from a name to everything that person did |
| Upload-session card with problems | System log filtered to that session id | server-side errors for the same session are in the Logs tab |
