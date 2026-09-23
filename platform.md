# Review — `platform`

_agent review (surface) · 2026-09-23_

> The foundations are careful: secrets fail loud instead of defaulting, admin cookies are HMAC-signed and SameSite=Strict, PINs are PBKDF2 with transparent upgrade, KV cache writes degrade gracefully. The gaps are at the edges: Drive permission revocation reports success when it failed, wrong-PIN counters spend the scarce KV write budget on attacker traffic, and API responses (including inline file bytes) carry none of the security headers pages get.

## Findings

### MEDIUM · Page the admin folder picker past 100 folders

**Where:** src/drive.js:133-150 · **Category:** ux · **Confidence:** 0.8

**When:** The admin's Drive (or a parent folder) has more than 100 subfolders.

**Result:** driveListFolders asks for pageSize 100 with no nextPageToken handling, so folders after the 100th alphabetically never appear in the drop, share or image-archive pickers; the only way to pick them is pasting a folder ID.

**Fix:** Loop on nextPageToken (pageSize 1000) or return the token and add a 'load more' row in openFolderPicker.

### MEDIUM · Only forget a Drive permission after Drive confirms the revoke

**Where:** src/drive.js:311-321 + src/share-admin.js:238-244 · **Category:** security · **Confidence:** 0.75

**When:** A redirect-mode share is paused, deleted or expires while the Google token refresh fails or Drive answers 5xx/403 to the DELETE.

**Result:** driveRevokePermission never checks the response, and revokeSharePermissions clears share.permissionIds unconditionally, so the folder stays 'anyone with the link can view' in Drive while the app believes access is gone - and there is no record left to retry the revoke.

**Fix:** Return r.ok (treat 404 as success) from driveRevokePermission; in revokeSharePermissions keep the ids whose revoke failed, save them on the share, and appLog an error so the admin sees it; retry leftovers on the nightly cron.

### MEDIUM · Keep wrong-PIN counters out of KV

**Where:** src/store.js:263-341 (recordPinFailure / recordGlobalPinFailure) · **Category:** cost · **Confidence:** 0.65

**When:** Someone scripts wrong PINs against a public drop or share slug from rotating IPs.

**Result:** Every wrong attempt costs two KV writes (per-IP key and the global key), and the global damping resets every 10 minutes, so a single link can burn thousands of writes a day - enough to exhaust the daily KV write allowance, after which completion flushes, link edits and index pointers start failing app-wide.

**Fix:** Track PIN failures in the LiveTracker Durable Object (the /ratelimit bucket is already there) and keep KV only for the escalating lockout level, written at most once per lockout.

### LOW · Require the drop's PIN (or sign-in) before accepting an upload live socket

**Where:** src/worker.js:423-431 + src/live.js:305-316 · **Category:** security · **Confidence:** 0.7

**When:** Someone who knows a PIN-protected drop's slug opens /api/live/upload/<slug> and sends progress frames with made-up uploader names.

**Result:** The socket is accepted for any active link, so fake transfers appear in the admin's Live tab and link detail (and each frame creates a session record in DO memory) without ever passing the PIN gate that /api/progress enforces.

**Fix:** Have the page send the PIN (or rely on a short-lived signed token returned by /api/verify) in the first frame or query, verify it with gatePin in openUploadLiveSocket, and ignore frames from unverified sockets.

### LOW · Stop accepting the admin token in the WebSocket query string

**Where:** src/worker.js:441-451 · **Category:** security · **Confidence:** 0.6

**When:** The transcoder runner connects with ?token=<ADMIN_TOKEN>.

**Result:** The full admin token appears in request URLs, which Cloudflare logs and any tail/observability export record; anyone who can read those logs becomes admin.

**Fix:** Send the token only in the Authorization header (Node's WebSocket clients support custom headers), or mint a short-lived scoped transcoder token for the URL.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Security headers on API responses | SECURITY_HEADERS are applied to pages and assets only; every /api/* response (JSON and file bytes) goes out without nosniff-wide CSP or frame-ancestors, which is what turns an inline HTML/SVG download into script on the app origin (see share-delivery). | worker.js fetch(): wrap api() results | small | already available (SECURITY_HEADERS); media routes need a sandbox CSP |
