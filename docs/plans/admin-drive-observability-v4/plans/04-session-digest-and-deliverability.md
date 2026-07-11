# Session Digest & Email Deliverability Implementation Plan

**Goal:** Send a trustworthy, detailed upload digest and improve deliverability signals without claiming code can guarantee inbox placement.

## Change 1 — authoritative session summary

**Locate:** `src/live.js`, `maybeSendDigest(session)`.

**Action:** Build the digest from completion metadata whose `si` matches `session.id`, combining the in-memory pending batch with `recent:<slug>` for already-flushed rows. Derive `{startedAt,endedAt,durationMs,fileCount,totalBytes,videoCount,imageCount,otherCount,mimeGroups,largestFiles,errorCount}`. Do not trust client-provided count when server completion records disagree.

**Old code:**

```js
html: `<p><b>${escapeHtml(session.uploader)}</b> finished uploading ...</p><p>${session.done} files - ${fmtBytesServer(session.sent)}</p>`
```

**New code:** call `buildSessionDigestHtml({ link, session, summary })` and `buildSessionDigestText(...)`; subject becomes `Upload complete: <uploader> sent <N> files to <label>`.

## Change 2 — rich but compact template

**Locate:** `src/store.js`, `emailTemplate()`.

**Action:** REPLACE the body-only API with `emailTemplate({preheader,bodyHtml})`. Add a hidden preheader, accessible table-based metric row, session time range in the configured `EMAIL_TIME_ZONE` (default `UTC`), duration, total size, type breakdown, error/attention state, and an admin deep link `${PUBLIC_BASE_URL}/admin`. Keep inline styles, escaped user content, body under 80 KB, and no tracking pixels.

## Change 3 — plain text and provider errors

**Locate:** `src/store.js`, `sendNotify()`.

**Action:** REPLACE ignored response handling.

**Old code:**

```js
await fetch("https://api.resend.com/emails", { body: JSON.stringify({ from, to, subject, html }) }).catch(...);
```

**New code:**

```js
const response = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
  body: JSON.stringify({
    from: env.NOTIFY_FROM,
    to: [env.NOTIFY_TO],
    reply_to: env.NOTIFY_REPLY_TO || undefined,
    subject: msg.subject,
    html: emailTemplate({ preheader: msg.preheader, bodyHtml: msg.html }),
    text: msg.text,
    tags: [{ name: "category", value: msg.category || "drop-notification" }],
  }),
});
if (!response.ok) {
  console.error("Resend rejected email", response.status, (await response.text()).slice(0, 300));
  return null;
}
return response.json();
```

Wrap the fetch in `try/catch`, log network errors, and return `null`; notification failure must never reject upload session creation.

## Change 4 — start email details

**Locate:** `src/worker.js`, `recordSessionStart()`.

**Action:** Include exact start time, link label/slug, uploader, device/OS and coarse city/country from `extractClientInfo(request)`, plus a plain-text equivalent. Do not include IP address.

## Change 5 — DNS and reputation operations

**Locate:** `docs/EMAIL.md`.

**Action:** UPDATE the verified state and checklist:

- SPF currently resolves on `send.losthusky.qzz.io`.
- DKIM currently resolves at `resend._domainkey.losthusky.qzz.io`; request a 2048-bit key if Resend offers it (current public key is 1024-bit, which meets Gmail's minimum but not its recommendation).
- DMARC currently resolves as `v=DMARC1; p=none;`. Add an aggregate-report address (`rua`) only after that mailbox/receiver exists. Monitor first; move to `quarantine` only after every legitimate sender passes alignment.
- Verify `dmarc=pass`, `dkim=pass`, and aligned From domain in received headers.
- In Resend Deliverability Insights, confirm plain-text part, matching link domain, and no suppression.
- Register the domain with Google Postmaster Tools when volume is sufficient, keep complaint rate below 0.3%, warm sending consistently, and ask the current recipient to mark the legitimate message “Not spam” because Gmail explicitly reports prior spam classification.
- Do not add one-click unsubscribe to these owner-only transactional alerts; do add an admin setting to disable each alert category.

## Change 6 — tests

**Locate:** `scripts/email-test.mjs`.

**Action:** CREATE deterministic tests for escaping, plain-text presence, preheader, time range/duration, MIME grouping, large-file ordering, Resend non-2xx propagation, and absence of PIN/IP/signed URLs. Add to `npm test`.
