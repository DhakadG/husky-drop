# Review — `share-viewer`

_agent review (surface) · 2026-09-23_

> A carefully engineered viewer: a tested DOM-free asset engine, verified full-resolution promotion, rapid-browsing mode, a video session with token refresh, and thorough cleanup on destroy. Its gaps are about scope and bandwidth: it only knows the files already paged into the gallery, it fetches originals automatically after a 6-second dwell and buffers original videos for posters with no Save-Data or cellular check, and there is no way to link someone to a single photo.

## Findings

### MEDIUM · Let the viewer continue past the loaded page

**Where:** public/share-viewer.js:83-140 (dataSource: lightboxItems) + public/share-viewer-panels.js:333 + public/share.js:612-614 · **Category:** ux · **Confidence:** 0.8

**When:** A folder of 1,400 photos; the guest opens the first photo and keeps pressing → (or End).

**Result:** lightboxItems holds only the 200 files loaded so far, so the counter reads '200 / 200' and navigation stops dead at the 200th photo as if the folder ended; the guest has to close the viewer, scroll to 'Load next' and find their place again.

**Fix:** When the viewer reaches the last two items and the source folder has nextPageToken, call prefetchMore(folder), append the new viewable files to lightboxItems and to pswp.options.dataSource (PhotoSwipe supports growing numItems via the dataSource array), and show 'more loading…' instead of a hard stop.

### MEDIUM · Do not auto-download originals on Save-Data or cellular connections

**Where:** public/share-viewer-engine.js:316-336 (tickIntent → ensure 'full') + public/share-viewer.js:106 · **Category:** cost · **Confidence:** 0.7

**When:** A guest on a phone with mobile data pauses about 6 seconds on each photo while browsing a wedding gallery.

**Result:** The 'full-resolution intent' timer fetches every dwelled-on original (typically 5-15 MB JPEGs) without being asked; a 100-photo browse silently costs the guest a gigabyte, and each fetch also streams from Drive through the Worker.

**Fix:** In canLoadFull (share-viewer.js) return false when navigator.connection?.saveData or effectiveType is 2g/3g, or when the pointer is coarse; keep the explicit zoom and 'Load original' paths, which use ensureFull({force}).

### MEDIUM · Stop buffering original videos just to paint a poster

**Where:** public/share-preview.js:335-398 (ensureVideoPoster/capturePoster) + public/share.js:75-78 · **Category:** cost · **Confidence:** 0.65

**When:** A folder of phone videos Drive produced no thumbnail for and that have no 720p preview yet; the guest scrolls through it on a phone.

**Result:** Every such tile within 700 px of the viewport queues capturePoster, which points a <video> at the original (inlineUrl), sets preload='auto' and waits for loadeddata - three originals buffering at a time, with no Save-Data or touch-device check (unlike warmVisible and heatVideoTile). The guest's data and the Worker's Drive egress go to posters.

**Fix:** Only capture posters from the 720p preview (previewUrl) and skip when none exists, or gate capturePoster behind !navigator.connection?.saveData && canHoverPreview; for preview-less videos show the duration chip and a video glyph instead.

### LOW · Ignore a second open while the viewer is loading

**Where:** public/share-viewer.js:82-141 · **Category:** correctness · **Confidence:** 0.6

**When:** On first use the PhotoSwipe module is still downloading and the guest taps the tile again (or double-clicks).

**Result:** Both calls pass the await and construct two PhotoSwipe instances; vs.pswp points at the second, the first stays in the DOM with its own global keydown listener, so arrow keys move two viewers and closing leaves one behind.

**Fix:** Return early when vs.pswp is set or an `opening` promise is pending; set the flag before awaiting loadPswp().

## Layout

- The desktop top bar carries 13 controls (±10, info, guide, download, filmstrip, motion, rotate ×2, reset, fullscreen, zoom); move motion and filmstrip size into the guide/overflow as the mobile sheet already does, keeping download and info visible.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Link to one photo | 'Look at this one' is the most common thing a guest wants to send; the URL hash only carries the folder path, so the recipient lands on the grid. | Viewer toolbar (copy link) + share.js restorePath (open viewer on #<folder>/@<fileId>) | small | already available (file ids in the listing) |
| Owner switch to hide GPS in File info | The EXIF panel shows exact coordinates to every guest; for photos taken at home that is more than most owners mean to share. | Share editor setting + /api/share/file-info | small | share record field; file-info already assembles `location` separately |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Viewer 'Download' | the folder zip / selection with this photo added | guests often want this photo plus the rest of the set |
