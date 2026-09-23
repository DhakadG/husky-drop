# Review — `public/share-fx.js`

_agent review (file) · 2026-09-23_

> A contained effects layer that backs off cleanly without GSAP or under reduced motion. One real defect: the custom cursor lives on document.body while the stylesheet hides the system cursor inside the viewer, so in fullscreen there is no cursor at all.

## Findings

### MEDIUM · Keep a visible pointer when the viewer or a video goes fullscreen

**Where:** 84-96 (+ style.css 1960-1964) · **Category:** ux · **Confidence:** 0.75

**When:** On a desktop with a mouse, a guest presses F in the viewer (pswp.element.requestFullscreen) or the fullscreen button on a video (wrap.requestFullscreen).

**Result:** Only the fullscreen element's subtree is painted, so the .fx-cur-dot/.fx-cur-ring appended to <body> disappear, while `body.has-fx-cursor .pswp * { cursor: none !important }` still hides the system cursor - the guest cannot see where the pointer is to reach the arrows, the seek bar or the exit button.

**Fix:** On fullscreenchange, move dot and ring into document.fullscreenElement (and back to body on exit), or add `:fullscreen` / `body:has(:fullscreen)` exceptions that restore the normal cursor.
