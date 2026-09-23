# Review — `public/share.html`

_agent review (file) · 2026-09-23_

> Well-structured markup with a skeleton shaped like the gallery and vendor CSS ordered deliberately before style.css. The only issue is the share gate showing the PIN in clear text, unlike the drop gate.

## Findings

### LOW · Mask the share PIN field like the drop gate does

**Where:** 81-85 · **Category:** security · **Confidence:** 0.7

**When:** A guest types a share password in a café, on a shared screen, or while screen-recording to ask for help.

**Result:** The field is type="text", so the password is readable over the shoulder and captured in recordings; the drop page's gate uses type="password" with a show/hide toggle for the same kind of secret.

**Fix:** Use type="password" with autocomplete="off" and reuse the drop gate's eye toggle.
