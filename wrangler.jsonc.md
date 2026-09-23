# Review — `wrangler.jsonc`

_agent review (file) · 2026-09-23_

> Clear, commented configuration; secrets correctly kept out of vars. One interaction worth fixing: the 30-day R2 lifecycle on stats/ can delete a share's live index while its KV pointer still names it.

## Findings

### LOW · Do not let the stats/ lifecycle expire a live index

**Where:** 17-20 · **Category:** correctness · **Confidence:** 0.6

**When:** A share with indexSchedule 'monthly' (full walk due at 30 days minus one hour) misses one nightly cron, or a share is paused for more than 30 days and then resumed.

**Result:** stats/<slug>.json and .files.json are deleted by the 30-day rule while share-stats:<slug> still points at them: folder tiles lose their counts and covers, the Pipelines tab still reports 'Indexed N d ago', and the next orphan sweep sees no file rows for that share and deletes all of its R2 thumbnails.

**Fix:** Drop the lifecycle rule for stats/ (the blobs are small and rewritten by every walk) and clean them up explicitly in deleteShare instead; or make loadStats treat a missing blob as 'not indexed' and clear the pointer so a walk is scheduled.
