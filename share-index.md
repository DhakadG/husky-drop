# Review — `share-index`

_agent review (surface) · 2026-09-23_

> The chunked walk is sound: bounded by subrequests and wall clock, resumable, incremental via the change feed, and the read path never touches Drive. Two data-integrity gaps remain: a folder removed from a share keeps its root flag and so is never pruned from the index, and the duration backfill rewrites the video-preview index while runners are reporting into it. (The change-feed cursor that never advances past five pages is reported under admin-pipelines.)

## Findings

### MEDIUM · Prune roots that are no longer in share.folderIds

**Where:** src/share-index.js:128-136 (queue seeded with root: true) + 265-276 (pruneUnreachable starts from every folder with root) · **Category:** correctness · **Confidence:** 0.8

**When:** The admin edits a share from folders [A, B] to [A] and a full walk runs (on schedule or 'Process now').

**Result:** B's stats entry still carries root: true from the earlier walk, so pruneUnreachable treats it as reachable: B's folders and file rows stay in stats/<slug>.files.json forever. The removed folder keeps feeding the RAW-preview and thumbnail runners, keeps its R2 media out of the orphan sweep, and still counts as a 'known id' for the change feed.

**Fix:** At the start of a full walk (or in pruneUnreachable), seed reachability only from the share's current folderIds - clear `root` on any folder not in share.folderIds before pruning. Pass share into walkChunk/pruneUnreachable for that.

### MEDIUM · Stop rewriting previews:index from the index job

**Where:** src/share-index.js:176 and 340-368 · **Category:** correctness · **Confidence:** 0.75

**When:** A share-index job is in its warm phase backfilling video durations while the 720p transcoder runners are posting reports.

**Result:** The chunk reads previews:index once, adds durations, and writes the whole key back at the end of the chunk; any runner report that landed in between (new previews, failure counts, run totals) is overwritten - the same last-writer-wins loss CONTEXT.md §7 describes, from a second writer.

**Fix:** Keep backfilled durations in the share's own file rows (f.d, already done) and do not persist them into previews:index; or write them to a separate previews:durations key that previewFields reads alongside the index.

### LOW · Default dedupe to within-folder duplicates, not the whole subtree

**Where:** src/share-index.js:476-527 (dedupeShareFolder) · **Category:** ux · **Confidence:** 0.6

**When:** An event folder has 'Day 1/' and a curated 'Best of/' containing copies of the best shots; the admin runs dedupe on the event folder.

**Result:** Identical md5+size files across sibling folders are grouped together and every newer copy is trashed - the curated 'Best of' album quietly loses its photos (recoverable from Drive trash for 30 days, but nothing says which folder they came from).

**Fix:** Group by `${f.f}|${f.r}|${f.s}` by default and make cross-folder dedupe an explicit option; include each doomed file's folder path in the dry-run sample.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Show what the change feed picked up per share | When a guest says 'the new photos are not there', the admin cannot tell whether the change was seen, queued, or missed. | Pipelines share-index row / share card | small | pointer.changed already holds up to 500 ids |

## Should link to

| From | To | Why |
| --- | --- | --- |
| shareIndexGaps result (missing / empty folders) | Share card or Pipelines row | the endpoint exists but nothing in the admin surfaces it |
