# Review — `scripts/smoke-test.mjs`

_agent review (file) · 2026-09-23_

> An unusually thorough end-to-end harness: real worker routes against fake KV/R2/cache/Drive, with regression assertions for most past incidents. Its blind spots are in the fakes themselves - pagination is never exercised (KV, R2 and the Drive change feed all return one complete page), and no fixture is an HTML/SVG file - which is exactly where the review found its most serious live bugs.

## Findings

### LOW · Make the fake change feed return more than one page

**Where:** 257-264 · **Category:** correctness · **Confidence:** 0.8

**When:** maybeCheckChanges receives a nextPageToken on every page until MAX_CHANGE_PAGES is hit.

**Result:** The fake always answers with newStartPageToken and no nextPageToken, so the bug where the cursor is written back unchanged after 5 pages (share-changes.js:54-71) passes every run.

**Fix:** Add a pageToken branch that returns nextPageToken for six consecutive pages, run check-changes, and assert that changes:cursor.pageToken moved past the first page.

### LOW · Exercise pagination and non-image MIME types in the fakes

**Where:** 38-44, 100-103, 213-220 · **Category:** correctness · **Confidence:** 0.75

**When:** Orphan sweeps page R2 with a cursor; KV.list fallbacks page with a cursor; a share can contain .html or .svg files.

**Result:** FakeKV.list always reports list_complete and FakeR2.list always truncated:false, so cursor loops are never taken; the media fixtures are only JPEG, MP4, MOV, EXE and ARW, so the inline HTML/SVG path in shareDownload (served without a sandbox on the app origin) has no test that would fail.

**Fix:** Give FakeR2.list/FakeKV.list a `limit` that truncates and returns a cursor, and add an 'evil.svg' (image/svg+xml) fixture with an assertion that /api/share/dl/<token>?inline=1 comes back as an attachment or with a sandbox CSP.
