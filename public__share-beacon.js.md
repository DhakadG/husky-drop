# Review — `public/share-beacon.js`

_agent review (file) · 2026-09-23_

> Batched share telemetry with a beacon on hide.

## Findings

### LOW · Do not send guests' email and name to Microsoft Clarity

**Where:** 45-48 · **Category:** security · **Confidence:** 0.7

**When:** A signed-in guest opens a share on a deployment with CLARITY_PROJECT_ID set (it is set in wrangler.jsonc).

**Result:** installTracking calls clarity('identify', viewer.email, ..., viewer.name), attaching the guest's Google email and display name to their Clarity session recordings at a third party, which the privacy policy does not mention.

**Fix:** Identify with an opaque id (trackSessionId or a hash of the email) and drop the friendly-name argument; if the email is needed, keep it in the app's own People data only.
