# Review — `public/admin-previews.js`

_agent review (file) · 2026-09-23_

> Carefully built for a tab that is patched live: panels swap in place so polls and telemetry never steal a click, coverage is loaded separately with a bounded timeout, and selection survives refreshes. At 745 lines it is well over the house limit and would split naturally into coverage and runs/live modules, but no defect was found in it; the pipeline problems behind this tab (index races, crawl limits, failed-count mismatch) are filed under admin-media-jobs.

No findings.
