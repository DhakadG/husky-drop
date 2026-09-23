# Review — `scripts/transcode-images.mjs`

_agent review (file) · 2026-09-23_

> A compact runner (pool per batch, size-target quality nudging, metadata copied from the true original, dimension check against what Drive stored), with two ways to damage originals: it re-encodes gain-map HDR photos that the preview runner deliberately leaves alone, and after a failed batch report it processes the same files a second time.

## Findings

### HIGH · Skip gain-map HDR photos in the image archive, as the preview runner already does

**Where:** 69-76 (processOne) vs scripts/lib/image-decode.mjs:82-101 · **Category:** correctness · **Confidence:** 0.8

**When:** An archive or Replace job over an iPhone (Apple Adaptive HDR) or Pixel (Ultra HDR) photo library.

**Result:** transcode-share-previews.mjs calls hasGainMap() and keeps such originals untouched because sharp silently flattens the gain map to SDR; transcode-images.mjs never calls it, so every HDR photo is re-encoded as plain SDR. In Replace mode that becomes the file's content (the original revision is only kept ~30 days); in Archive mode the SDR copy takes the original's place in the folder and gallery.

**Fix:** In processOne, call hasGainMap(input, file) right after download and throw a soft skip ('gain-map HDR: original kept', counted like 'not smaller'); add 'gain-map HDR' as a skip reason in the planner so the dry run shows how many are left alone.

### MEDIUM · Never process a file twice when a batch report fails

**Where:** 102-115, 121-172 · **Category:** correctness · **Confidence:** 0.7

**When:** The report POST fails three times in a row (Worker hiccup, KV write limit) on a Replace or Copy job.

**Result:** nextImageBatch derives 'remaining' from job.items, which the lost report never updated, so the same files come back in the next batch. In Replace mode the already-recompressed file becomes a new Drive revision encoded again from the lossy copy (a second generation of quality loss on the original's file id); in Copy mode a duplicate lands in _compressed (x-retry cleanup only runs within one PUT); in Archive mode the second move fails and the file is reported as failed. When a later report succeeds, the held batch is sent too, so items are recorded twice.

**Fix:** Keep a Set of file ids this runner has PUT successfully (as transcode-previews.mjs does with `taken`) and skip them; if report() returns null, stop the run with 'report failed - resume from the admin' instead of fetching the next batch.
