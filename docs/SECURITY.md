# Security

## Threat Model

Private personal service. Main risks are:

- PIN guessing on a leaked drop URL.
- Spam uploads into Drive.
- Credential leakage.

Out of scope: nation-state attacks and DDoS beyond Cloudflare's edge shielding.

## PIN Brute-Force Protection

PIN checks are enforced on `/api/verify`, `/api/session`, and `/api/progress`.

### 1. Per-IP And Per-Link Exponential Lockout

State key:

```text
bf:{slug}:{sha256(ip)}
```

| Wrong attempts | Lockout |
| --- | --- |
| 1-4 | none |
| 5 | 1 minute |
| 6 | 2 minutes |
| 7 | 4 minutes |
| 8+ | doubling, capped at 60 minutes |

State expires after 24 hours. A correct PIN clears the per-IP state. Lockout
responses are `429` with `retryAfter` and `Retry-After`; the drop page renders
a countdown.

### 2. Per-Link Global Damping

State key:

```text
bfg:{slug}
```

Wrong attempts from all IPs share a one-hour window. More than 60 wrong
attempts locks PIN endpoints for that link for 10 minutes. This blunts
distributed guessing where every IP stays below its own limit.

## Other Measures (v2)

- New PINs are PBKDF2-SHA256 (100k iterations, per-PIN salt). Legacy salted
  and unsalted SHA-256 hashes still verify and are transparently re-hashed to
  PBKDF2 on the next successful entry. All hash/token comparisons are
  constant-time.
- Admin auth: `POST /api/admin/login` mints an HMAC-signed HttpOnly, Secure,
  SameSite=Strict cookie (7 days). Login attempts are rate limited
  (5 / 15 min / IP via the Durable Object). The bearer token still works for
  scripts. The admin WebSocket authenticates via the cookie - the token no
  longer appears in any URL. Mutating admin routes also enforce a same-origin
  `Origin` check.
- Abuse containment: per-link budgets (`maxTotalBytes` / `maxTotalFiles` /
  `maxSessions`) auto-pause a link when crossed, and any link can be manually
  paused without deleting it. Upload sessions are refused when Drive free
  space (minus a 5 GB rese