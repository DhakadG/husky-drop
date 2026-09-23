# Review — `admin-media-jobs`

_agent review (surface) · 2026-09-23_

> Both tabs are careful about UX (in-place patching, instant estimates, trial encode, undo and convert). The risk is in the data paths that touch originals and shared state: toggling a recurring rule silently drops its name-exclusion regex, archive mode moves the original away before the replacement is safely stored, and the video preview index is still one KV key written by up to 20 parallel runners - the exact trap CONTEXT.md says was fixed for RAW previews.

## Findings

### HIGH · Stop 'pause'/'enable' from erasing a rule's exclude regex

**Where:** public/admin-images-rules.js:178 + src/images-rules.js:31 + src/images.js:55 · **Category:** correctness · **Confidence:** 0.85

**When:** A nightly rule was saved with 'Exclude names matching' = _edited|\.psd$; the admin clicks 'pause' and later 'enable' on it.

**Result:** ruleAction posts the stored rule back; upsertImageRule re-runs normalizeOptions(rule.options), which reads raw.exclude (the stored options only have excludeRe), so the regex becomes ''. The next scheduled run re-encodes the files the admin excluded - in archive or replace mode that moves or overwrites them. The toggle also sends confirm: 'REPLACE' automatically, bypassing the replace guard.

**Fix:** Add a dedicated PATCH that only flips `enabled` on the stored rule without re-normalizing options (or make normalizeOptions accept raw.excludeRe as a fallback for raw.exclude). Do not send confirm: 'REPLACE' from the toggle. Also restore excludeRe and excludeFolderIds in the 'load recipe' action.

### HIGH · In archive mode, store and verify the new file before moving the original

**Where:** src/images-run.js:187-195 · **Category:** correctness · **Confidence:** 0.75

**When:** An archive job; Drive's multipart upload returns 5xx for one photo, or the stored size does not match.

**Result:** moveFile() has already moved the original into _archive/, then the upload throws (or the size check returns 502): the photo disappears from its folder and from any share gallery pointing at it, with no replacement. The runner's retry calls moveFile again with removeParents = the old folder, which is no longer a parent, so the item fails permanently and the original stays hidden.

**Fix:** Upload the new file into file.folderId first, verify its size, then move the original to the _archive mirror; if the move fails, trash the new file. On an x-retry, look up the original's current parent (imageParentOf) instead of assuming file.folderId.

### MEDIUM · Give each video runner shard its own report key

**Where:** src/previews.js:398-483 (reportPreviewRun read-modify-write of previews:index) · **Category:** correctness · **Confidence:** 0.8

**When:** A 'Run now' with 8-20 runners; each reports every few files to /previews/report.

**Result:** Concurrent reports read the same previews:index, each adds its own files and writes the whole object back; the last write wins, so finished previews, failure counts and run totals from other shards are lost (KV also rejects more than one write per second to a key). Lost previews show as 'queued' on share pages and in coverage until a later non-cached pending call repairs them from Drive; lost failure counts mean broken files are retried indefinitely.

**Fix:** Mirror what share-previews already does: write each report to previews:delta:<run>-<shard> with a TTL and union the deltas into the index on read (and fold them in during the next pending/overview call).

### MEDIUM · Do not report 'undone' when some files failed to undo

**Where:** src/images-run.js:283-305 + public/admin-images.js:378-389 · **Category:** ux · **Confidence:** 0.75

**When:** Undo of an archive job where a few originals cannot be moved back (permission change, file deleted by hand).

**Result:** Items with undoError are excluded from `remaining`, so the loop ends and the button says 'undone' while those originals are still sitting in _archive/; the job status stays 'done' with no visible hint.

**Fix:** Return `failed: count of items with undoError` from the endpoint and show 'undone, N could not be restored' plus list them in the job's files view (filter 'failed' should include undoError items).

### MEDIUM · Bound the Drive crawl and report folders it could not read

**Where:** src/previews.js:117-151 · **Category:** correctness · **Confidence:** 0.65

**When:** A share with a few hundred nested folders, or Drive throttling during 'Rescan'.

**Result:** walk() fans out with Promise.all over every subfolder at every level (unbounded concurrency against the subrequest cap and Drive's rate limit), and any listing error just `break`s - those folders silently vanish from coverage and from the pending list, so their videos never get previews. Videos deeper than depth 3 are also never scanned, with nothing in the UI saying so.

**Fix:** Walk with a small worker pool (e.g. 6 concurrent listings), record failed folder ids and depth-capped folders in the result, and show 'N folders could not be read / deeper than 3 levels' on the coverage panel.

### LOW · Make the 'Failed' card and the 'Failed files' list count the same thing

**Where:** src/previews.js:219, 256, 265 + public/admin-previews.js:280, 476-486 · **Category:** correctness · **Confidence:** 0.75

**When:** Ten videos failed once, two failed three times.

**Result:** The stat card says 'Failed (3 tries) 2' while the 'Failed files' table below lists 12 rows, most of which will be retried automatically next run.

**Fix:** Split the table into 'gave up (3 tries)' and 'will retry', or filter it to tries >= MAX_TRIES and show the retrying count as a note.

## Layout

- On the Image archive tab, move 'Progress & history' above 'Recurring rules' - while a job runs, the job card is what the admin comes back for and it is currently at the very bottom.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Process a folder and all its subfolders | Parent folders with no direct videos are not selectable, so previewing an event folder means ticking every leaf. | Video previews coverage table | small | already available (parentId in the tree); queue.folderIds needs subtree expansion in listPendingPreviews |
| Retry failed files of an image job | A job with 30 transient Drive failures can only be re-planned from scratch. | Image archive job card | small | job.items with ok:false, !soft |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Coverage folder row | the share gallery folder /s/<slug> (or Drive folder) | check what viewers see for that folder |
| Failed preview row | the original in Drive | most failures are a corrupt or odd file; the admin has to find it by name today |
| Image job card | System log filtered to area images for that job id | per-file failure details are logged there |
