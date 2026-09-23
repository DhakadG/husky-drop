# Review — `public/admin.html`

_agent review (file) · 2026-09-23_

> Clean, well-labelled markup with skeletons sized like the real content and proper dialogs. Two small truth/usability slips: the sign-in card promises a 30-day session when the cookie lasts 7 days, and the new-drop PIN field forces a numeric keypad even though it accepts passwords.

## Findings

### LOW · State the real admin session length

**Where:** 28 · **Category:** ux · **Confidence:** 0.9

**When:** The admin signs in on Monday expecting the copy's promise.

**Result:** The card says the session 'stays signed in on this device for 30 days', but ADMIN_SESSION_TTL (src/util.js) is 7 days, so the dashboard drops back to the lock screen a week later - and the 401 path in refreshAll then triggers the double-poller bug noted in admin-overview.

**Fix:** Change the copy to '7 days' (or render it from a value the server returns with /api/admin/me).

### LOW · Do not force a number pad on the drop 'Password / PIN' field

**Where:** 382 · **Category:** ux · **Confidence:** 0.75

**When:** The admin creates a drop link on a phone and wants a word password.

**Result:** inputmode="numeric" shows only digits on mobile keyboards, so a letter password cannot be typed there even though makePinFields and the drop gate support text passwords (pinDigits=false).

**Fix:** Remove inputmode from #f-pin (the share form's #s-pin already has none).
