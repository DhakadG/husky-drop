# Review — `admin-logs`

_agent review (surface) · 2026-09-23_

> Small, solid surface: a capped SQLite log, cheap fire-and-forget writes, a useful unread-errors strip and copy-friendly selection. Its one real defect is that the area filter is a hard-coded list that omits three areas the code actually logs to, so share-index, share-previews and people entries cannot be filtered and the alert strip's area buttons silently show everything instead.

## Findings

### MEDIUM · Build the area filter from the areas that are actually logged

**Where:** public/admin.html:275 (#logs-area options) + public/admin-logs.js:144-148 · **Category:** correctness · **Confidence:** 0.85

**When:** The alert strip shows 'share-index 3'; the admin clicks it to see those errors.

**Result:** The handler sets #logs-area.value = 'share-index', but the select has no such option, so the value becomes '' and the log shows every area's errors; share-index, share-previews and people (used by 14 appLog calls) can never be filtered from the dropdown at all.

**Fix:** Add the missing options, or better, have /logs return the distinct areas (SELECT DISTINCT area FROM app_log) and render the select from that; in the strip handler, add an option on the fly if the area is missing.

### LOW · Ignore responses from superseded log requests

**Where:** public/admin-logs.js:93-172 · **Category:** correctness · **Confidence:** 0.7

**When:** The admin changes the area and then the level quickly; the first request is slower than the second.

**Result:** The first response lands last and replaces the body, so the list shows rows for a filter that is no longer selected.

**Fix:** Keep a request sequence number (as openFolderPicker does with pickerSeq) and drop responses whose sequence is not the latest.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Text search over message and detail | Finding 'the error for file IMG_2231' or a job id means scrolling 3000 lines. | System log toolbar | small | logQuery needs a `q` LIKE filter |
| Shared read-state | Errors marked read on the laptop reappear as unread on the phone; the badge disagrees between devices. | Alerts strip / nav badge | small | one 'read up to id' value in the DO instead of localStorage |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Log row mentioning a job id (img-..., run ids) or share slug | the Image archive job card / Pipelines row / share card | every entry names the thing it is about but none are links |
| client-area error row | People profile of the device that crashed | the detail carries device context; the person view has the rest of that visitor's story |
