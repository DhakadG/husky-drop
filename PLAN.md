# Makeover backlog

What the reviews say this product should have and does not.

## Missing features

| Feature | Where it belongs | Why | Effort | Needs | Surface |
| --- | --- | --- | --- | --- | --- |
| Ban from the Activity row | Activity session card actions | Abuse is noticed in the Activity feed (errors, lock events); blocking requires opening the profile and finding the right device. | small | already available (/api/admin/bans, event.d / event.p) | [admin-activity-people](admin-activity-people.md) |
| Profile timeline paging | People profile Timeline | personEvents caps at 300 events; a regular visitor's older history is unreachable. | small | /live.internal/person needs a `before` parameter | [admin-activity-people](admin-activity-people.md) |
| Per-link 30-day chart on the detail page | Link detail, under the stat cards | 'When did people actually upload to this link?' has no answer on the page that is about this link. | small | already available (/api/admin/timeseries?slug=) | [admin-drops](admin-drops.md) |
| Share this drop's folder from the detail page | Link detail action row | The 'share this folder' shortcut only exists on the create-success screen; a week later the admin has to rebuild it by hand in the Shares tab. | small | already available (/api/admin/links/:slug/folder + create-share tab) | [admin-drops](admin-drops.md) |
| Extend / set expiry as an explicit action | Link detail header next to the status chip | Expiry is a 'days from now' number buried in the Access accordion; the common task is 'give them one more week'. | small | already available (PATCH expiresDays) | [admin-drops](admin-drops.md) |
| Stopped / failed sessions group | Live tab, under the active list | An uploader messages 'it stopped working' - the admin needs to see which session died, at which file, and when. | small | already available (sessions with state 'stale' live in the DO for 2 min; telemetry has the error events) | [admin-live](admin-live.md) |
| Per-file error reason on the live card | Live tab file rows | A file row turns red with no reason; the error code (E_STALL, E_QUOTA...) is already in the client taxonomy. | small | progress frames would need to carry file.error | [admin-live](admin-live.md) |
| Text search over message and detail | System log toolbar | Finding 'the error for file IMG_2231' or a job id means scrolling 3000 lines. | small | logQuery needs a `q` LIKE filter | [admin-logs](admin-logs.md) |
| Shared read-state | Alerts strip / nav badge | Errors marked read on the laptop reappear as unread on the phone; the badge disagrees between devices. | small | one 'read up to id' value in the DO instead of localStorage | [admin-logs](admin-logs.md) |
| Process a folder and all its subfolders | Video previews coverage table | Parent folders with no direct videos are not selectable, so previewing an event folder means ticking every leaf. | small | already available (parentId in the tree); queue.folderIds needs subtree expansion in listPendingPreviews | [admin-media-jobs](admin-media-jobs.md) |
| Retry failed files of an image job | Image archive job card | A job with 30 transient Drive failures can only be re-planned from scratch. | small | job.items with ok:false, !soft | [admin-media-jobs](admin-media-jobs.md) |
| Share totals on Overview | Overview stat grid | Half the product is share links; the landing page says nothing about whether anyone opened or downloaded a gallery. | small | already available (overview.shares[].stats) | [admin-overview](admin-overview.md) |
| Click a chart bar to see that day's activity | Overview 30-day chart | A spike on the chart raises 'who was that?' and the only answer is scrolling the Activity tab by date. | small | /api/admin/events?before=<day+1>&days=1 already exists | [admin-overview](admin-overview.md) |
| Drive usage as a proportion, not just 'space left' | Overview 'Drive space left' card | 'Drive space left 1.2 TB' says nothing about how close to full the account is; overview.quota already has limit and usage. | small | already available (overview.quota.limit/usage) | [admin-overview](admin-overview.md) |
| Cancel or reset a stuck share-index job | Pipelines share index table, per row | A job whose chunk throws every time is resumed by resumeStalledJobs forever; 'Process now' is disabled while it is 'running' and there is no way to clear it from the UI. | small | share-index job record (status -> cancelled) + stats/<slug>.job.json delete | [admin-pipelines](admin-pipelines.md) |
| Open the gallery from the card | Share card action row | Copy, QR and Share exist, but checking what the guest sees means copying the URL and pasting it. | small | already available (share.url) | [admin-shares](admin-shares.md) |
| Per-share activity chart | Share card, expandable | 'Did the client look at it after I sent it on Monday?' needs opens by day, which day_stats already records under share:<slug>. | small | /api/admin/timeseries?slug=share:<slug> (slug is cleanText'd to 66 chars, fits) | [admin-shares](admin-shares.md) |
| Download count on the card | Share card stat grid | stats.downloads is computed and sent but only the byte total is shown. | small | already available | [admin-shares](admin-shares.md) |
| Security headers on API responses | worker.js fetch(): wrap api() results | SECURITY_HEADERS are applied to pages and assets only; every /api/* response (JSON and file bytes) goes out without nosniff-wide CSP or frame-ancestors, which is what turns an inline HTML/SVG download into script on the app origin (see share-delivery). | small | already available (SECURITY_HEADERS); media routes need a sandbox CSP | [platform](platform.md) |
| Show what the change feed picked up per share | Pipelines share-index row / share card | When a guest says 'the new photos are not there', the admin cannot tell whether the change was seen, queued, or missed. | small | pointer.changed already holds up to 500 ids | [share-index](share-index.md) |
| Link to one photo | Viewer toolbar (copy link) + share.js restorePath (open viewer on #<folder>/@<fileId>) | 'Look at this one' is the most common thing a guest wants to send; the URL hash only carries the folder path, so the recipient lands on the grid. | small | already available (file ids in the listing) | [share-viewer](share-viewer.md) |
| Owner switch to hide GPS in File info | Share editor setting + /api/share/file-info | The EXIF panel shows exact coordinates to every guest; for photos taken at home that is more than most owners mean to share. | small | share record field; file-info already assembles `location` separately | [share-viewer](share-viewer.md) |
| Server-driven orphan sweep | R2 orphan sweep card | The sweep loop runs in the admin's browser; closing the tab mid-sweep leaves it half done and 'Last sweep' unchanged. | medium | chunk chaining through SELF, same pattern as share-index | [admin-pipelines](admin-pipelines.md) |
| 'What did I already send?' list for returning uploaders | Drop page, above the drop zone for a returning device | Uploaders on a second visit cannot see what landed last time, so they re-drop everything 'to be safe'. | medium | completed-file index per link (see the preflight finding) filtered by device/session | [drop-upload](drop-upload.md) |
| Zip progress and partial-failure report | share-zip.js stream + share page toast | When one Drive stream fails mid-zip the download just stops; the guest cannot tell which files are missing. | medium | write a MISSING.txt entry for failed files instead of aborting | [share-delivery](share-delivery.md) |
| Search by file name | Gallery toolbar | Guests are usually looking for one photo ('IMG_4412', 'the group shot'); today they scroll or page through hundreds. | medium | share-index file rows already hold every name per share | [share-gallery](share-gallery.md) |
| Download this whole folder | Folder header / breadcrumb actions | The common guest intent is 'give me everything from this event'; selection only covers loaded tiles. | medium | share-zip.js + share-index file rows for the folder subtree | [share-gallery](share-gallery.md) |

## Things that should link to each other

| From | To | Why | Surface |
| --- | --- | --- | --- |
| Activity event row for an upload | Link detail upload-session log (session id = event.si) | jump from 'uploaded 12 files' to the per-file event stream | [admin-activity-people](admin-activity-people.md) |
| Activity 'link' column / kind-tag place | the drop link detail or share card | the slug is right there and not clickable | [admin-activity-people](admin-activity-people.md) |
| People profile device card | Activity filtered to that device | see what this device did across all links | [admin-activity-people](admin-activity-people.md) |
| Link detail header | the share link(s) whose folderIds include this drop's folderId | shows at once whether the uploaders' files have been shared back | [admin-drops](admin-drops.md) |
| Top uploaders row / Upload history uploader cell | People profile | one click from a name to everything that person did | [admin-drops](admin-drops.md) |
| Upload-session card with problems | System log filtered to that session id | server-side errors for the same session are in the Logs tab | [admin-drops](admin-drops.md) |
| Finished-this-hour row | Link detail upload-session log for that session id | goes straight from 'someone finished' to what they sent | [admin-live](admin-live.md) |
| Uploader name/avatar on a live card | People profile (data-open-person) | tells the admin who this is and what they sent before | [admin-live](admin-live.md) |
| Live card 'Drive folder' button | the uploader's own subfolder, not the link root | the root folder holds every uploader's files | [admin-live](admin-live.md) |
| Log row mentioning a job id (img-..., run ids) or share slug | the Image archive job card / Pipelines row / share card | every entry names the thing it is about but none are links | [admin-logs](admin-logs.md) |
| client-area error row | People profile of the device that crashed | the detail carries device context; the person view has the rest of that visitor's story | [admin-logs](admin-logs.md) |
| Coverage folder row | the share gallery folder /s/<slug> (or Drive folder) | check what viewers see for that folder | [admin-media-jobs](admin-media-jobs.md) |
| Failed preview row | the original in Drive | most failures are a corrupt or odd file; the admin has to find it by name today | [admin-media-jobs](admin-media-jobs.md) |
| Image job card | System log filtered to area images for that job id | per-file failure details are logged there | [admin-media-jobs](admin-media-jobs.md) |
| Overview 'Drop links' stat card | Drop links tab | the number is a list the admin will want to open | [admin-overview](admin-overview.md) |
| Overview 'Files received' / 'Data received' cards | Activity tab filtered to uploads | saves finding the filter by hand | [admin-overview](admin-overview.md) |
| Overview chart bar | Activity tab scoped to that day | explains a spike in one click | [admin-overview](admin-overview.md) |
| Share index row | the share card in the Shares tab / the gallery /s/<slug> | the row names a share but offers no way to look at it | [admin-pipelines](admin-pipelines.md) |
| Share index 'last run failed' error | System log filtered to area share-index around finishedAt | the one-line error is truncated; the log has the detail | [admin-pipelines](admin-pipelines.md) |
| 'Running now' banner item | the card it describes | the banner is the first thing seen and is plain text | [admin-pipelines](admin-pipelines.md) |
| Share card index line ('Indexed 3 h ago', 'failed: ...') | Pipelines tab scrolled to this share's index job | the failure text is truncated here and the job history lives there | [admin-shares](admin-shares.md) |
| Share card folder names | the Drive folders (drive.google.com/drive/folders/<id>) | confirm which folders are exposed | [admin-shares](admin-shares.md) |
| Viewer chip | People profile for that email | who is this person and what else did they open | [admin-shares](admin-shares.md) |
| 'N files' meta chip | a 'load everything' action or the full-folder zip | the total is shown but there is no way to act on it | [share-gallery](share-gallery.md) |
| Folder hover card | a direct 'download this folder' action | the card already knows the count and size | [share-gallery](share-gallery.md) |
| shareIndexGaps result (missing / empty folders) | Share card or Pipelines row | the endpoint exists but nothing in the admin surfaces it | [share-index](share-index.md) |
| Viewer 'Download' | the folder zip / selection with this photo added | guests often want this photo plus the rest of the set | [share-viewer](share-viewer.md) |

## Layout and organisation

### admin-activity-people

- Put 'Suggested merges' below the people grid when it is empty - the empty-state paragraph currently sits above every person.
- Collapse the Activity toolbar filters (kind, person, link, days, sort) into one row with the view switcher; today they push the first event below the fold on a laptop.

### admin-drops

- Move 'Upload sessions' (debug) below Settings - it is a troubleshooting tool, and on a healthy link it pushes the settings far down the page.
- Show the budget bar inside the stat grid's 'Received' card instead of as a separate strip under it.

### admin-live

- Order the Live tab as: active sessions, stopped sessions, finished this hour - the current empty-state card duplicates 'Last completed' and the finished list when both are visible.

### admin-media-jobs

- On the Image archive tab, move 'Progress & history' above 'Recurring rules' - while a job runs, the job card is what the admin comes back for and it is currently at the very bottom.

### admin-overview

- Put 'Live now' above the 30-day chart when liveActive is non-empty - an upload in progress is the most time-sensitive thing on the page and currently sits below the fold on a laptop.
- Split the stat grid into two labelled rows, 'Received' (drop links) and 'Shared' (share links), so the chart chips can follow the same split.

### admin-pipelines

- Put the Drive change feed card first after the banner - when it is stuck, everything below it is stale, and today it sits near the bottom.

### admin-shares

- Drop the two maintenance buttons from the Shares pane head so '+ New share link' is the only primary action there.
- Put the Archived section's toggle next to the header count, as the Drop links tab does with 'expired'.

### share-gallery

- Collapse hover-zoom and download-format selects into the 'Layout & select' sheet on desktop too - five selects in one toolbar row push 'select all' and the zip button off-screen on laptops.
- Show 'closes in N days' next to the share title rather than as the last meta chip; it is the one line a guest should act on.

### share-viewer

- The desktop top bar carries 13 controls (±10, info, guide, download, filmstrip, motion, rotate ×2, reset, fullscreen, zoom); move motion and filmstrip size into the guide/overflow as the mobile sheet already does, keeping download and info visible.

## Gaps noted in file reviews

### `public/style.css`

- Page-scoped stylesheets (drop/share/admin) so a guest opening a drop link does not download the admin dashboard's CSS.

