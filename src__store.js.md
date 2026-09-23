# Review — `src/store.js`

_agent review (file) · 2026-09-23_

> The KV layer respects the write budget on hot paths by relaying to the Durable Object, and the PIN gate has sensible per-IP and per-link damping. The wrong-PIN counters spending KV writes are filed under the platform surface; the one file-local issue is that the shared rate limiter fails open.

## Findings

### LOW · Fail closed for the admin-login and client-error rate limits

**Where:** 37-49 · **Category:** security · **Confidence:** 0.65

**When:** The LiveTracker Durable Object is briefly unavailable (deploy, overload, a thrown error in its fetch).

**Result:** rateLimitRemote returns allowed:true on any error, so during that window /api/admin/login accepts unlimited token guesses and /api/client-error unlimited e-mails - the limits vanish exactly when the system is under stress.

**Fix:** Take a `failOpen` flag: keep failing open for telemetry and share tracking, but return { allowed: false, retryAfter: 30 } for the admin login and client-error mail buckets.
