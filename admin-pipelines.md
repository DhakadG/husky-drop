# Review — `admin-pipelines`

_agent review (surface) · 2026-09-23_

> A genuinely useful single pane over six background systems, with sensible polling and cancel. The serious problem is underneath it: the Drive change feed never advances past a burst of more than 5,000 changes, so after any big Drive operation shares silently stop picking up changes. The GitHub run list can also hide the transcoder runs behind CI noise, and the orphan sweep trusts that every share's index is complete.

## Findings

### HIGH · Save the next page token when the change loop stops at MAX_CHANGE_PAGES

**Where:** src/share-changes.js:54-61 and 71 · **Category:** correctness · **Confidence:** 0.85

**When:** More than 5,000 changes accumulate in one window - an image-archive job re-encoding a few thousand files, a large drop, or a folder move.

**Result:** The loop exits with nextPageToken still set, `token` is only replaced when there is no next page, so the original token is written back; every later check re-reads the same first 5 pages and never reaches newer changes. Shares stop reacting to edits until the token expires or a scheduled full walk happens, and the Pipelines card still shows a fresh 'Last check'.

**Fix:** After the loop, if `next` is non-empty persist { pageToken: next, checkedAt, behind: true } so the following check continues from there (optionally let a force check loop again immediately); keep newStartPageToken only when the feed is drained. Add a test with a fake feed of 6 pages asserting the stored token advances.

### MEDIUM · Fetch runs per transcoder workflow instead of the last 20 runs of everything

**Where:** src/pipelines.js:39 · **Category:** correctness · **Confidence:** 0.8

**When:** A day with several PR pushes: ci.yml, pr-review.yml and skylos.yml each add runs.

**Result:** runs?per_page=20 fills up with CI runs, so an in-progress RAW-preview or video run is not listed: the card says 'No recent preview runner runs', 'Running now' omits it and there is no Cancel button for it.

**Fix:** Call workflows/<file>/runs?per_page=5 for each of the three WORKFLOWS entries (three requests, same 4 s timeout) and merge.

### MEDIUM · Stop re-reading every share's file list on each Pipelines poll

**Where:** src/pipelines.js:70-87 + public/admin-pipelines.js:39 · **Category:** cost · **Confidence:** 0.7

**When:** The Pipelines tab is open during an index run; it polls every 10 s.

**Result:** Each poll reads stats/<slug>.files.json for every active gallery share from R2 (potentially megabytes each) and runs wantsPreview over every row, just to compute 'Pending' previews - the slowest request in the admin, repeated six times a minute.

**Fix:** Compute files and pendingPreviews when the index job finishes and store them in the stats pointer (it is already written then); read only the pointer here.

### MEDIUM · Skip the orphan sweep for media of shares without a complete index

**Where:** src/share-changes.js:127-142 · **Category:** correctness · **Confidence:** 0.65

**When:** An admin clicks 'Clear orphaned media' while a share's first index walk is still running, or after a share's last index failed before writing files.json.

**Result:** loadFiles() returns no (or partial) rows for that share, so every thumbnail and watched video preview that share's visitors already cached in R2 is deleted; the next visitors pay cold Drive fetches again.

**Fix:** Before listing, collect shares whose pointer is missing, !complete, or have a running job; if any exist, either refuse with a message naming them or only delete objects older than their job's startedAt. Report 'skipped: share X not fully indexed' in the result.

### LOW · Show the real chunk size default

**Where:** src/pipelines.js:105 · **Category:** correctness · **Confidence:** 0.6

**When:** INDEX_CHUNK is not set in wrangler vars.

**Result:** The card header says 'chunk 40 subrequests' while docs/CONTEXT.md describes the chunk as 200; whichever share-index.js actually uses, the two defaults are defined separately and can drift.

**Fix:** Export the chunk and time-box constants from share-index.js and use them here instead of re-deriving defaults.

## Layout

- Put the Drive change feed card first after the banner - when it is stuck, everything below it is stale, and today it sits near the bottom.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Cancel or reset a stuck share-index job | A job whose chunk throws every time is resumed by resumeStalledJobs forever; 'Process now' is disabled while it is 'running' and there is no way to clear it from the UI. | Pipelines share index table, per row | small | share-index job record (status -> cancelled) + stats/<slug>.job.json delete |
| Server-driven orphan sweep | The sweep loop runs in the admin's browser; closing the tab mid-sweep leaves it half done and 'Last sweep' unchanged. | R2 orphan sweep card | medium | chunk chaining through SELF, same pattern as share-index |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Share index row | the share card in the Shares tab / the gallery /s/<slug> | the row names a share but offers no way to look at it |
| Share index 'last run failed' error | System log filtered to area share-index around finishedAt | the one-line error is truncated; the log has the detail |
| 'Running now' banner item | the card it describes | the banner is the first thing seen and is plain text |
