# Review — `scripts/transcode-previews.mjs`

_agent review (file) · 2026-09-23_

> A careful runner: per-shard claiming, reports held back and retried instead of dropped, bitrate budgeting so long clips stay under the Worker's body limit, and a silent-audio retry. One gap defeats the budgeting: the fast remux path never checks the size it will produce, so long clips that are already 720p H.264 fail permanently.

## Findings

### MEDIUM · Fall back to a budgeted transcode when a remux would exceed the upload limit

**Where:** 162-167, 195-214, 382-386 · **Category:** correctness · **Confidence:** 0.8

**When:** A 45-minute 720p H.264/AAC recording at 2.4 Mb/s (about 800 MB) - the kind of phone or screen recording isCompliant accepts.

**Result:** The remux copies the stream untouched, the output is far over MAX_PREVIEW_BYTES, the file is reported as failed, and after three nightly runs it is permanently 'failed' - the one class of long video the duration-based bitrate budget exists for never gets a preview.

**Fix:** Add `duration * bitrate / 8 <= BUDGET_PREVIEW_BYTES` to isCompliant, and if the remuxed output still exceeds MAX_PREVIEW_BYTES, delete it and run the transcode path once before reporting a failure.
