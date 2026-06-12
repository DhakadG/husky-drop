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

## Other Measures

- New PINs are salted SHA-256 hashes. Older unsalted hashes are accepted for
  backward compatibility.
- Secrets live in Worker secrets or `.dev.vars`; both are excluded from GitHub.
- `wrangler.jsonc` is local-only. `wrangler.example.jsonc` is the committed
  placeholder.
- Admin access is a single bearer token over HTTPS. Rotate with
  `wrangler secret put ADMIN_TOKEN`.
- Session URIs are single-file Google resumable upload URLs; leaking one does
  not leak Drive credentials.
- Filenames, folder names, dashboard strings, and theme fields are sanitized and
  length-capped.
- Upload spam still exists if a trusted PIN holder uploads junk. Delete or
  expire that link.

## Not Implemented

- Anti-virus scanning.
- End-to-end client-side encryption.
- Turnstile.

Add those before making public claims beyond password protection, HTTPS
transport, and Google Drive encryption at rest.
