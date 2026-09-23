# Review — `public/admin.js`

_agent review (file) · 2026-09-23_

> A clear boot/routing/socket module; every tab is a real URL and the live socket reconnects with backoff. The double-poller-on-re-login and always-on 15 s polling are filed under admin-overview. One small file-local defect: the shared flash() helper strips icons from the buttons it labels.

## Findings

### LOW · Restore a button's markup, not just its text, after flash()

**Where:** 498-502, 616-622 · **Category:** ux · **Confidence:** 0.8

**When:** The admin clicks 'Copy link' on a drop or share card, or a trash button on the detail page fails.

**Result:** flash() saves button.textContent and writes it back, so the SVG icon inside the link-action button is dropped and the card shows a bare text label until the next 15 s overview poll re-renders it.

**Fix:** Save and restore innerHTML (all flashed buttons are app-built markup), or flash only the label span as admin-shares.js already does for its runner buttons.
