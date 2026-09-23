# What is broken

8 critical and high findings, worst first.

## HIGH · Stop lowercasing fingerprint ids when storing a ban

`admin-activity-people` src/identity.js:153 (value lowercased) + src/identity.js:86 (exact match) + src/util.js:298-301 · security · confidence 0.85 · [full review](admin-activity-people.md)

**When:** Admin clicks 'block fingerprint' on a device whose FingerprintJS visitor id is 'aB3dE5...' (fpFrom accepts [A-Za-z0-9]).

**Result:** adminBans stores 'ab3de5...', isBanned compares value = 'aB3dE5...' exactly, so the device is never blocked; the profile card also shows it as not blocked. The admin believes an abusive visitor is locked out when they are not.

**Fix:** Lowercase only for kind === 'email' in adminBans (device ids are already lowercase hex); add a smoke-test case that bans a mixed-case fp and expects bannedRequest to return true.

## HIGH · Stop 'pause'/'enable' from erasing a rule's exclude regex

`admin-media-jobs` public/admin-images-rules.js:178 + src/images-rules.js:31 + src/images.js:55 · correctness · confidence 0.85 · [full review](admin-media-jobs.md)

**When:** A nightly rule was saved with 'Exclude names matching' = _edited|\.psd$; the admin clicks 'pause' and later 'enable' on it.

**Result:** ruleAction posts the stored rule back; upsertImageRule re-runs normalizeOptions(rule.options), which reads raw.exclude (the stored options only have excludeRe), so the regex becomes ''. The next scheduled run re-encodes the files the admin excluded - in archive or replace mode that moves or overwrites them. The toggle also sends confirm: 'REPLACE' automatically, bypassing the replace guard.

**Fix:** Add a dedicated PATCH that only flips `enabled` on the stored rule without re-normalizing options (or make normalizeOptions accept raw.excludeRe as a fallback for raw.exclude). Do not send confirm: 'REPLACE' from the toggle. Also restore excludeRe and excludeFolderIds in the 'load recipe' action.

## HIGH · Stop counting share downloads as 'Data received' in the chart

`admin-overview` src/live-analytics.js:222 (bumpDay(`share:${slug}`)) + src/live-analytics.js:260-270 (timeseries sums every slug) + public/admin-chart.js:16 · correctness · confidence 0.85 · [full review](admin-overview.md)

**When:** A guest downloads a 4 GB ZIP from a share link; bumpShareStat records {bytes: 4 GB, opens, downloads} into day_stats under slug 'share:<slug>', and timeseries() sums all slugs with no filter.

**Result:** The 'Data received' bar for that day shows 4 GB that nobody uploaded, and 'Link opens' counts gallery visits; the stat cards directly above (drop-only totals from KV) show different numbers, so the admin cannot trust either.

**Fix:** In timeseries(), return two groups: drop metrics (opens, sessions, files, bytes) from rows WHERE slug NOT LIKE 'share:%', and share metrics (shareOpens, downloads, servedBytes) from rows WHERE slug LIKE 'share:%'. Apply the same split to the pendingDays fold-in. Point the chart's 'Downloads' chip at the share series and add a 'Share opens' chip.

## HIGH · Save the next page token when the change loop stops at MAX_CHANGE_PAGES

`admin-pipelines` src/share-changes.js:54-61 and 71 · correctness · confidence 0.85 · [full review](admin-pipelines.md)

**When:** More than 5,000 changes accumulate in one window - an image-archive job re-encoding a few thousand files, a large drop, or a folder move.

**Result:** The loop exits with nextPageToken still set, `token` is only replaced when there is no next page, so the original token is written back; every later check re-reads the same first 5 pages and never reaches newer changes. Shares stop reacting to edits until the token expires or a scheduled full walk happens, and the Pipelines card still shows a fresh 'Last check'.

**Fix:** After the loop, if `next` is non-empty persist { pageToken: next, checkedAt, behind: true } so the following check continues from there (optionally let a force check loop again immediately); keep newStartPageToken only when the feed is drained. Add a test with a fake feed of 6 pages asserting the stored token advances.

## HIGH · Make preflight dedupe cover the whole drop and the whole batch

`drop-upload` src/drop-api.js:427-442 + src/store.js:211-227 (recent:<slug> capped at RECENT_CAP 200) + public/drop.js:489-499 · correctness · confidence 0.85 · [full review](drop-upload.md)

**When:** An uploader's browser crashed after 700 of 1,500 photos; they reopen the link and drop the same folder again.

**Result:** Preflight compares only against recent:<slug>, which holds the newest 200 completions, and the server only answers for the first 500 files of the request; roughly 500 already-delivered photos are re-uploaded as duplicates in Drive (hours of upload, doubled storage), while the page says nothing was skipped. The 6 s client timeout on a 1,500-entry request can also fail open and skip dedupe entirely.

**Fix:** Keep a per-link completed-file index keyed by name|size(|lastModified) in the Durable Object's SQLite (completions already pass through CompletionQueue) and query it from /api/preflight; on the client send preflight in batches of 500 and apply each batch's results as they return.

## HIGH · Skip gain-map HDR photos in the image archive, as the preview runner already does

`scripts/transcode-images.mjs` 69-76 (processOne) vs scripts/lib/image-decode.mjs:82-101 · correctness · confidence 0.8 · [full review](scripts__transcode-images.mjs.md)

**When:** An archive or Replace job over an iPhone (Apple Adaptive HDR) or Pixel (Ultra HDR) photo library.

**Result:** transcode-share-previews.mjs calls hasGainMap() and keeps such originals untouched because sharp silently flattens the gain map to SDR; transcode-images.mjs never calls it, so every HDR photo is re-encoded as plain SDR. In Replace mode that becomes the file's content (the original revision is only kept ~30 days); in Archive mode the SDR copy takes the original's place in the folder and gallery.

**Fix:** In processOne, call hasGainMap(input, file) right after download and throw a soft skip ('gain-map HDR: original kept', counted like 'not smaller'); add 'gain-map HDR' as a skip reason in the planner so the dry run shows how many are left alone.

## HIGH · Never render uploaded HTML/SVG inline on the app origin

`share-delivery` src/share-media.js:257-275, 357-371 + src/worker.js:127 (API responses get no SECURITY_HEADERS) · security · confidence 0.8 · [full review](share-delivery.md)

**When:** Someone uploads evil.svg (or .html) through a drop link; the admin shares that folder (the 'share this drop' flow does this in one click); the uploader, as a guest of the share, gets a dl token and sends the admin /api/share/dl/<token>?inline=1.

**Result:** shareDownload serves the file with content-type image/svg+xml or text/html, content-disposition inline and no content-security-policy, so the script runs on dropbox.losthusky.qzz.io with the admin's session cookie in scope and can call every /api/admin/* endpoint (create links, change PINs, read people data).

**Fix:** In shareMediaHeaders, when inline, add 'content-security-policy: sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'' and only honour inline for image/(jpeg|png|webp|gif|avif|heic), video/*, audio/* and application/pdf; everything else (text/html, image/svg+xml, xml, js) gets attachment + application/octet-stream. Add a smoke test that an SVG with ?inline=1 comes back as an attachment or sandboxed.

## HIGH · In archive mode, store and verify the new file before moving the original

`admin-media-jobs` src/images-run.js:187-195 · correctness · confidence 0.75 · [full review](admin-media-jobs.md)

**When:** An archive job; Drive's multipart upload returns 5xx for one photo, or the stored size does not match.

**Result:** moveFile() has already moved the original into _archive/, then the upload throws (or the size check returns 502): the photo disappears from its folder and from any share gallery pointing at it, with no replacement. The runner's retry calls moveFile again with removeParents = the old folder, which is no longer a parent, so the item fails permanently and the original stays hidden.

**Fix:** Upload the new file into file.folderId first, verify its size, then move the original to the _archive mirror; if the move fails, trash the new file. On an x-retry, look up the original's current parent (imageParentOf) instead of assuming file.folderId.

## Everything else

| Target | Severity | Finding | Where |
| --- | --- | --- | --- |
| [admin-activity-people](admin-activity-people.md) | medium | Make 'Drop links used' and 'Shares viewed' open that link, not just the tab | public/admin-people.js:31-32 + public/admin-people-profile.js:89-90 |
| [admin-drops](admin-drops.md) | medium | Do not re-render the detail view on top of a failed save | public/admin-detail.js:263-271 |
| [admin-logs](admin-logs.md) | medium | Build the area filter from the areas that are actually logged | public/admin.html:275 (#logs-area options) + public/admin-logs.js:144-148 |
| [scripts/review/run.mjs](scripts__review__run.mjs.md) | medium | Fingerprint surfaces the same way queue.mjs and mark.mjs do | 211-216, 229 |
| [admin-drops](admin-drops.md) | medium | Only send expiresDays when the admin changed it | public/admin-detail.js:44, 108, 234 + src/admin-api.js:171-174 |
| [admin-media-jobs](admin-media-jobs.md) | medium | Give each video runner shard its own report key | src/previews.js:398-483 (reportPreviewRun read-modify-write of previews:index) |
| [admin-overview](admin-overview.md) | medium | Make unlock() idempotent so re-sign-in does not double every poller | public/admin.js:253-263 and 320-324 |
| [admin-overview](admin-overview.md) | medium | Show the share side on the landing tab | public/admin.js:453-488 (renderStats) |
| [admin-pipelines](admin-pipelines.md) | medium | Fetch runs per transcoder workflow instead of the last 20 runs of everything | src/pipelines.js:39 |
| [admin-shares](admin-shares.md) | medium | Only send expiresDays when it was edited | public/admin-shares.js:206 and 249 + src/share-admin.js:208-211 |
| [drop-upload](drop-upload.md) | medium | Report the session as done when nothing is left in flight, not only when every file uploaded | public/drop-live.js:238-242 |
| [platform](platform.md) | medium | Page the admin folder picker past 100 folders | src/drive.js:133-150 |
| [public/privacy.html](public__privacy.html.md) | medium | List the processors and identifiers the app really uses | Information we collect; Storage and processors |
| [scripts/transcode-previews.mjs](scripts__transcode-previews.mjs.md) | medium | Fall back to a budgeted transcode when a remux would exceed the upload limit | 162-167, 195-214, 382-386 |
| [share-delivery](share-delivery.md) | medium | Apply the public-download safety block to inline requests too | src/share-media.js:261-264 |
| [share-delivery](share-delivery.md) | medium | Record the preview's Drive id in the shard delta, not the shared base index | src/share-previews.js:183-187 |
| [share-gallery](share-gallery.md) | medium | Have 'select all' respect the active filter and say when more files exist | public/share-select.js:135-145 |
| [share-index](share-index.md) | medium | Prune roots that are no longer in share.folderIds | src/share-index.js:128-136 (queue seeded with root: true) + 265-276 (pruneUnreachable starts from every folder with root) |
| [share-viewer](share-viewer.md) | medium | Let the viewer continue past the loaded page | public/share-viewer.js:83-140 (dataSource: lightboxItems) + public/share-viewer-panels.js:333 + public/share.js:612-614 |
| [admin-activity-people](admin-activity-people.md) | medium | Let the Activity tab load all of today, not just the newest 60 events | public/admin-state.js:70 + public/admin-activity.js:239 + src/live-analytics.js:93-100 + src/admin-api.js:285 |
| [admin-activity-people](admin-activity-people.md) | medium | Resolve Activity person keys with the same aliases the People tab uses | public/admin-activity.js:27-35 vs src/people.js:71-79 + public/admin-people.js:59-62 |
| [admin-live](admin-live.md) | medium | Show stalled and disconnected sessions instead of hiding them | public/admin-live.js:6 + src/live.js:328-333 |
| [admin-live](admin-live.md) | medium | Make 'dismiss' stick, or remove it | src/live.js:197-208 and 562-602 |
| [admin-media-jobs](admin-media-jobs.md) | medium | Do not report 'undone' when some files failed to undo | src/images-run.js:283-305 + public/admin-images.js:378-389 |
| [admin-overview](admin-overview.md) | medium | Pause the 15-second overview poll when the page is hidden | public/admin.js:260 and 317-336 |
| [admin-shares](admin-shares.md) | medium | Start an index job when a gallery share's folders change | src/share-admin.js:179-195, 229-235 |
| [platform](platform.md) | medium | Only forget a Drive permission after Drive confirms the revoke | src/drive.js:311-321 + src/share-admin.js:238-244 |
| [public/share-fx.js](public__share-fx.js.md) | medium | Keep a visible pointer when the viewer or a video goes fullscreen | 84-96 (+ style.css 1960-1964) |
| [share-delivery](share-delivery.md) | medium | Tie media and download refresh to what the share contains now | src/share-token.js:121-134 + src/share-media.js:23-35 and 78-95 |
| [share-gallery](share-gallery.md) | medium | Make 'Newest first' / 'Largest first' mean the whole folder, not the loaded page | public/share.js:533-544 (sortFiles) + src/drive.js driveListFolder orderBy 'folder,name' + public/share.js:617-620 |
| [share-index](share-index.md) | medium | Stop rewriting previews:index from the index job | src/share-index.js:176 and 340-368 |
| [.github/workflows/pr-review.yml](.github__workflows__pr-review.yml.md) | medium | Pin the third-party opencode action to a commit | 30 |
| [admin-live](admin-live.md) | medium | Write stats before the recent list so a failed flush cannot drop counts | src/live-completions.js:94-100 |
| [admin-pipelines](admin-pipelines.md) | medium | Stop re-reading every share's file list on each Pipelines poll | src/pipelines.js:70-87 + public/admin-pipelines.js:39 |
| [scripts/transcode-images.mjs](scripts__transcode-images.mjs.md) | medium | Never process a file twice when a batch report fails | 102-115, 121-172 |
| [share-gallery](share-gallery.md) | medium | Queue the latest navigation instead of dropping it while one is in flight | public/share.js:429-435 and 477-491 |
| [share-gallery](share-gallery.md) | medium | Append new pages instead of rebuilding every tile | public/share.js:562-634 (render) and 714 |
| [share-viewer](share-viewer.md) | medium | Do not auto-download originals on Save-Data or cellular connections | public/share-viewer-engine.js:316-336 (tickIntent → ensure 'full') + public/share-viewer.js:106 |
| [admin-media-jobs](admin-media-jobs.md) | medium | Bound the Drive crawl and report folders it could not read | src/previews.js:117-151 |
| [admin-pipelines](admin-pipelines.md) | medium | Skip the orphan sweep for media of shares without a complete index | src/share-changes.js:127-142 |
| [platform](platform.md) | medium | Keep wrong-PIN counters out of KV | src/store.js:263-341 (recordPinFailure / recordGlobalPinFailure) |
| [share-delivery](share-delivery.md) | medium | Build zip tickets without one sequential Drive call per file | src/share-zip.js:37-58 and 83-107 |
| [share-viewer](share-viewer.md) | medium | Stop buffering original videos just to paint a poster | public/share-preview.js:335-398 (ensureVideoPoster/capturePoster) + public/share.js:75-78 |
| [src/stitch.js](src__stitch.js.md) | medium | Disclose, minimise or keep in-house the visitor data sent to the model | 41-64, 23-40 |
| [public/admin.html](public__admin.html.md) | low | State the real admin session length | 28 |
| [scripts/review/render.mjs](scripts__review__render.mjs.md) | low | Render the per-target Markdown that INDEX, TOP and PLAN link to | 43, 56, 69, 90 |
| [admin-drops](admin-drops.md) | low | Say when upload history is truncated | public/admin-detail.js:183-184 + src/store.js:211-227 |
| [admin-live](admin-live.md) | low | Apply the one-hour cutoff when recentDone is read, not only when a session finishes | src/live.js:607-622, 127, 282 |
| [admin-shares](admin-shares.md) | low | Stop presenting a capped viewer list as 'Unique viewers' | src/live-analytics.js:211 (slice(0, 50)) + src/share-admin.js:64 |
| [public/admin.js](public__admin.js.md) | low | Restore a button's markup, not just its text, after flash() | 498-502, 616-622 |
| [scripts/smoke-test.mjs](scripts__smoke-test.mjs.md) | low | Make the fake change feed return more than one page | 257-264 |
| [share-gallery](share-gallery.md) | low | Show an empty state when the filter hides everything | public/share.js:571-575 and 599 |
| [admin-activity-people](admin-activity-people.md) | low | Check the merge and stitch responses before refreshing | public/admin-people.js:88-98 |
| [admin-media-jobs](admin-media-jobs.md) | low | Make the 'Failed' card and the 'Failed files' list count the same thing | src/previews.js:219, 256, 265 + public/admin-previews.js:280, 476-486 |
| [admin-shares](admin-shares.md) | low | Keep the preview-runner and orphan-sweep buttons in one tab | public/admin.html:203 + public/admin-pipelines.js:85,121 + public/admin-shares.js:86-95 |
| [public/admin.html](public__admin.html.md) | low | Do not force a number pad on the drop 'Password / PIN' field | 382 |
| [public/style.css](public__style.css.md) | low | Give the image-archive and gallery-density sliders a visible keyboard focus | 8001-8006, 6492-6495 |
| [scripts/review/run.mjs](scripts__review__run.mjs.md) | low | Do not mark a target reviewed when the answer could not be parsed | 126-135, 244-251 |
| [scripts/smoke-test.mjs](scripts__smoke-test.mjs.md) | low | Exercise pagination and non-image MIME types in the fakes | 38-44, 100-103, 213-220 |
| [.github/workflows/transcode-images.yml](.github__workflows__transcode-images.yml.md) | low | Install pillow-heif like the share-previews workflow does | 26-27 |
| [admin-activity-people](admin-activity-people.md) | low | Tell the admin when a day was truncated at EVENT_CAP | src/live-analytics.js:104 |
| [admin-drops](admin-drops.md) | low | Surface failures from pause, archive and delete | public/admin-links.js:313-324, 332 |
| [admin-logs](admin-logs.md) | low | Ignore responses from superseded log requests | public/admin-logs.js:93-172 |
| [admin-overview](admin-overview.md) | low | Make the headline stat cards navigate | public/admin.js:464-487 (stat cards) |
| [admin-shares](admin-shares.md) | low | Report failed pause / sign-in / archive / delete | public/admin-shares.js:125-155 |
| [drop-upload](drop-upload.md) | low | Use one session id for telemetry and uploads | public/drop-trekker.js:404 vs public/drop-state.js:9-22 |
| [platform](platform.md) | low | Require the drop's PIN (or sign-in) before accepting an upload live socket | src/worker.js:423-431 + src/live.js:305-316 |
| [public/share-beacon.js](public__share-beacon.js.md) | low | Do not send guests' email and name to Microsoft Clarity | 45-48 |
| [public/share.html](public__share.html.md) | low | Mask the share PIN field like the drop gate does | 81-85 |
| [public/style.css](public__style.css.md) | low | Delete selectors for layouts no page renders any more | 320-360, 782-800, 1711-1770, 5168 and others |
| [share-gallery](share-gallery.md) | low | Apply the share's state and viewer gate before recording opens and views | src/share.js:101-149 (logShareOpened) + 155-160 (shareTrack) |
| [admin-live](admin-live.md) | low | Stop re-rendering every live card once a second | public/admin.js:261 (tickLive) + public/admin-live.js:79-82 |
| [drop-upload](drop-upload.md) | low | Gate /api/complete like /api/session | src/drop-api.js:378-396 |
| [public/share.js](public__share.js.md) | low | Guard localStorage/sessionStorage reads at module load | 60, 780, 820 (+ share-state.js:14,18) |
| [src/drop-api.js](src__drop-api.js.md) | low | Count in-flight sessions against the byte budget | 252-269 |
| [src/store.js](src__store.js.md) | low | Fail closed for the admin-login and client-error rate limits | 37-49 |
| [src/worker.js](src__worker.js.md) | low | Return a generic message for unexpected 500s on public routes | 136-139 |
| [admin-pipelines](admin-pipelines.md) | low | Show the real chunk size default | src/pipelines.js:105 |
| [drop-upload](drop-upload.md) | low | Count dead-session restarts toward the retry limit | public/drop-queue.js:189-195 |
| [platform](platform.md) | low | Stop accepting the admin token in the WebSocket query string | src/worker.js:441-451 |
| [share-delivery](share-delivery.md) | low | Mark inline originals private, not public | src/share-media.js:361 |
| [share-index](share-index.md) | low | Default dedupe to within-folder duplicates, not the whole subtree | src/share-index.js:476-527 (dedupeShareFolder) |
| [share-viewer](share-viewer.md) | low | Ignore a second open while the viewer is loading | public/share-viewer.js:82-141 |
| [wrangler.jsonc](wrangler.jsonc.md) | low | Do not let the stats/ lifecycle expire a live index | 17-20 |

