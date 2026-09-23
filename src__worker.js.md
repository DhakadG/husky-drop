# Review — `src/worker.js`

_agent review (file) · 2026-09-23_

> A readable single router with auth checked before every admin route and ban checks in front of the public data routes. The missing security headers on /api/* responses and the admin token accepted in a WebSocket query string are filed under the platform surface; the one file-local issue is that unexpected exceptions return their raw message to anonymous callers.

## Findings

### LOW · Return a generic message for unexpected 500s on public routes

**Where:** 136-139 · **Category:** security · **Confidence:** 0.65

**When:** A guest's share listing hits an uncaught Drive error (driveListFolder throws 'Drive list failed: <first 200 chars of Google's error body>') or a misconfigured secret (requireSecret throws 'ADMIN_TOKEN must be set - ...').

**Result:** The top-level catch sends err.message verbatim to whoever made the request, exposing Google API error bodies, internal function names and configuration state to anonymous visitors.

**Fix:** Log the full error with appLog/console.error and respond with { error: 'internal error', ref: <short random id> }; keep the raw message only for requests that passed isAdmin.
