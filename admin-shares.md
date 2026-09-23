# Review — `admin-shares`

_agent review (surface) · 2026-09-23_

> The share card is information-rich (index state, viewers, stats) and redirect-mode permission handling is careful. The main gap is that editing a gallery's folders does not re-index it, so the gallery shows stale folder stats until the nightly job; the same expiry-drift-on-save bug as drop links exists here, and 'Unique viewers' silently caps at 50.

## Findings

### MEDIUM · Only send expiresDays when it was edited

**Where:** public/admin-shares.js:206 and 249 + src/share-admin.js:208-211 · **Category:** correctness · **Confidence:** 0.8

**When:** A share closes in 1 day 2 hours; the admin opens Edit to change the welcome text and saves.

**Result:** The editor pre-fills ceil(remaining days) = 2 and always sends it, so each unrelated save pushes the close date out by up to a day - a gallery meant to close on Friday stays open.

**Fix:** Store the pre-filled se-days value on open and include expiresDays in the PATCH only when the input differs.

### MEDIUM · Start an index job when a gallery share's folders change

**Where:** src/share-admin.js:179-195, 229-235 · **Category:** correctness · **Confidence:** 0.75

**When:** Admin opens Edit on a gallery share, adds a second Drive folder and saves.

**Result:** patchShare stores the new folderIds but neither plans an index job nor marks the stats pointer needsReindex; the new folder's tile shows no counts or cover and nothing is warmed until the nightly cron walks it, and the card still says 'Indexed 3 h ago' as if current.

**Fix:** When destinationChanged && share.mode === 'gallery', call planShareIndex(env, ctx, share, { trigger: 'edit', full: true }) and ctx.waitUntil(runShareIndexChunk(...)) exactly as createShareRecord does (patchShare needs ctx passed from the router).

### LOW · Stop presenting a capped viewer list as 'Unique viewers'

**Where:** src/live-analytics.js:211 (slice(0, 50)) + src/share-admin.js:64 · **Category:** correctness · **Confidence:** 0.8

**When:** A share is opened by 120 signed-in guests.

**Result:** bumpShareStat keeps only the 50 most recent viewer emails in viewers_json, so the card's 'Unique viewers' reads 50 and never grows; the admin under-reports the audience.

**Fix:** Keep a separate viewer_count column incremented when viewerPreviouslySeen is false and expose it as viewerCount; keep the 50-entry map only for the chips.

### LOW · Keep the preview-runner and orphan-sweep buttons in one tab

**Where:** public/admin.html:203 + public/admin-pipelines.js:85,121 + public/admin-shares.js:86-95 · **Category:** organisation · **Confidence:** 0.75

**When:** Admin clicks 'Run now' for RAW previews in the Pipelines tab.

**Result:** The same data-run-share-previews handler runs, and six seconds later it rewrites that button's label to 'Make RAW previews'; the two tabs also show the same maintenance actions with different wording, so it is unclear which is canonical.

**Fix:** Remove both buttons from the Shares pane head (Pipelines owns background jobs) and link to Pipelines instead; have runSharePreviewsNow restore the button's original text captured at click time.

### LOW · Report failed pause / sign-in / archive / delete

**Where:** public/admin-shares.js:125-155 · **Category:** ux · **Confidence:** 0.7

**When:** Admin pauses a share whose link leaked while the session cookie has expired.

**Result:** The PATCH returns 401 and the card redraws unchanged with no message; the admin believes access is cut.

**Fix:** Check r.ok and flash the error on the clicked button, as in the drop links fix.

## Layout

- Drop the two maintenance buttons from the Shares pane head so '+ New share link' is the only primary action there.
- Put the Archived section's toggle next to the header count, as the Drop links tab does with 'expired'.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Open the gallery from the card | Copy, QR and Share exist, but checking what the guest sees means copying the URL and pasting it. | Share card action row | small | already available (share.url) |
| Per-share activity chart | 'Did the client look at it after I sent it on Monday?' needs opens by day, which day_stats already records under share:<slug>. | Share card, expandable | small | /api/admin/timeseries?slug=share:<slug> (slug is cleanText'd to 66 chars, fits) |
| Download count on the card | stats.downloads is computed and sent but only the byte total is shown. | Share card stat grid | small | already available |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Share card index line ('Indexed 3 h ago', 'failed: ...') | Pipelines tab scrolled to this share's index job | the failure text is truncated here and the job history lives there |
| Share card folder names | the Drive folders (drive.google.com/drive/folders/<id>) | confirm which folders are exposed |
| Viewer chip | People profile for that email | who is this person and what else did they open |
