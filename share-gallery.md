# Review — `share-gallery`

_agent review (surface) · 2026-09-23_

> The gallery is polished where it has been worked on (deep links, token repair, justified layout, drag-select, folder stats). Its truthfulness breaks down on large folders: sorting, filtering and 'select all' only ever act on the pages already loaded, while the UI presents them as acting on the folder. Navigation also drops clicks and back-button presses that arrive while a listing is loading, leaving the URL and the view out of sync.

## Findings

### MEDIUM · Have 'select all' respect the active filter and say when more files exist

**Where:** public/share-select.js:135-145 · **Category:** correctness · **Confidence:** 0.8

**When:** Filter is 'Show: photos' in a folder with photos and videos, or a folder has more than 200 files; the guest clicks 'select all' then 'Download zip'.

**Result:** selectAll() adds every loaded file of every listing regardless of the filter, so hidden videos go into the zip; and on a paged folder it silently selects only the loaded 200 while current.summary knows there are 1,400 - the guest downloads a partial set believing it is everything.

**Fix:** Select from the rendered grids (grid._files, which are already filtered) instead of current.folders; when any folder has nextPageToken, label the result '200 of 1,400 selected - load all' and offer a server-side 'zip this folder' that uses the index file rows.

### MEDIUM · Make 'Newest first' / 'Largest first' mean the whole folder, not the loaded page

**Where:** public/share.js:533-544 (sortFiles) + src/drive.js driveListFolder orderBy 'folder,name' + public/share.js:617-620 · **Category:** correctness · **Confidence:** 0.75

**When:** A guest opens a folder of 1,400 photos and picks 'Newest first'.

**Result:** Drive pages arrive in name order, 200 at a time, and sortFiles only reorders what is loaded - the guest sees the newest of the alphabetically-first 200 and reasonably concludes those are the latest photos; the real newest ones are 6 'Load next' clicks away.

**Fix:** When a non-name sort is chosen and folder.nextPageToken is set, either pass the sort to /api/share/list (map to Drive orderBy modifiedTime desc / quotaBytesUsed desc) and reload page 1, or serve sorted pages from the share-index file rows (stats/<slug>.files.json) which already hold every file with size and time.

### MEDIUM · Queue the latest navigation instead of dropping it while one is in flight

**Where:** public/share.js:429-435 and 477-491 · **Category:** correctness · **Confidence:** 0.7

**When:** On a slow connection the guest opens a folder and, before it loads, presses Back (or clicks a different folder).

**Result:** navigate() returns immediately when `navigating` is set. For Back, the browser has already changed the hash, so the URL says the parent while the view then paints the child folder; for a click, nothing happens and the guest clicks again, often opening the wrong folder.

**Fix:** Replace the boolean with a 'latest request wins' token: store the requested entry, and when the in-flight navigation finishes, if a newer request exists, run it (or abort the older fetch with an AbortController and start the new one).

### MEDIUM · Append new pages instead of rebuilding every tile

**Where:** public/share.js:562-634 (render) and 714 · **Category:** cost · **Confidence:** 0.7

**When:** A guest pages through a 1,000-file folder with 'Load next' or the auto-prefetch.

**Result:** Each page calls render(), which empties #folders and recreates every card, image element and listener, and observes the new nodes on three IntersectionObservers without ever unobserving the old ones; by page five the browser rebuilds 1,000 tiles per click, scroll position jumps, and detached tiles stay referenced by the observers.

**Fix:** For loadMore, create cards only for page.files, append them to the existing grid, update grid._files and scheduleLayout(); call observer.unobserve() (or disconnect/re-create the observers) when render() does rebuild. This is what reconcile() is for in the house rules.

### LOW · Show an empty state when the filter hides everything

**Where:** public/share.js:571-575 and 599 · **Category:** ux · **Confidence:** 0.8

**When:** 'Show: videos' in a folder that only has photos and no subfolders with videos.

**Result:** The empty-folder check looks at unfiltered files, so the page renders an empty grid with no message - it looks broken rather than filtered.

**Fix:** After sorting/filtering, if no files and no subfolders pass, render 'No videos here - show everything' with a button that resets the filter.

### LOW · Apply the share's state and viewer gate before recording opens and views

**Where:** src/share.js:101-149 (logShareOpened) + 155-160 (shareTrack) · **Category:** security · **Confidence:** 0.7

**When:** Anyone who knows a slug (including of a paused or expired share) POSTs /api/share/opened in a loop, or /api/share/track with made-up event names.

**Result:** Opens are counted for a paused or expired share and can be inflated without limit (opened has no rate limit); the admin's Activity and share card numbers become unreliable.

**Fix:** Use loadActiveShare() in both handlers, run requireViewer() when the share requires sign-in, and put /opened behind the same rateLimitRemote bucket as /track.

## Layout

- Collapse hover-zoom and download-format selects into the 'Layout & select' sheet on desktop too - five selects in one toolbar row push 'select all' and the zip button off-screen on laptops.
- Show 'closes in N days' next to the share title rather than as the last meta chip; it is the one line a guest should act on.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Search by file name | Guests are usually looking for one photo ('IMG_4412', 'the group shot'); today they scroll or page through hundreds. | Gallery toolbar | medium | share-index file rows already hold every name per share |
| Download this whole folder | The common guest intent is 'give me everything from this event'; selection only covers loaded tiles. | Folder header / breadcrumb actions | medium | share-zip.js + share-index file rows for the folder subtree |

## Should link to

| From | To | Why |
| --- | --- | --- |
| 'N files' meta chip | a 'load everything' action or the full-folder zip | the total is shown but there is no way to act on it |
| Folder hover card | a direct 'download this folder' action | the card already knows the count and size |
