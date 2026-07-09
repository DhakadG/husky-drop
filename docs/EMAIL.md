# Email notifications — full setup guide

The Worker sends notification emails through [Resend](https://resend.com) (free tier: 100
emails/day, 3,000/month). Nothing sends until three secrets are configured:
`RESEND_API_KEY`, `NOTIFY_FROM`, and `NOTIFY_TO` (see `sendNotify` in `src/store.js`).

Two emails exist today, both wrapped in the branded blue template in `src/store.js`:

| Email | Trigger | Toggle |
|---|---|---|
| "X started uploading" | first session start on a link | per-link **Notifications → On upload start** |
| "X finished uploading (N files, Y GB)" | session digest when a transfer completes | per-link **Notifications → Session digest** |

Both toggles live in the admin dashboard: **Link detail → Edit settings → Notifications**
(and on the create-link form). The master switch is **Email enabled**.

---

## Step 1 — Create a Resend account and add your domain

1. Sign up at https://resend.com (GitHub/Google login works).
2. Go to **Domains → Add Domain**.
3. Enter your **root domain**: `losthusky.qzz.io`.
   (A subdomain like `send.losthusky.qzz.io` is also fine and keeps root DNS
   cleaner, but since the domain was added as the bare root here, all records
   below are relative to the root — that's what's actually configured.)
4. Pick the region closest to you and click **Add**.

Resend now shows you 3 DNS records to add. **Copy them exactly.**

## Step 2 — Add the DNS records in Cloudflare

Your domain `losthusky.qzz.io` is already served through Cloudflare (the Worker
route proves it), so DNS lives in the Cloudflare dashboard → your zone → **DNS → Records**.

You do **NOT** need MX records at the root to *send* email. MX records are only for
*receiving*. For sending (domain added as root `losthusky.qzz.io`), Resend asks for:

| Type | Name (what Resend calls it) | Purpose |
|---|---|---|
| TXT | `send.losthusky` (→ `send.losthusky.qzz.io`) | value `v=spf1 include:amazonses.com ~all` (SPF) — authorises Resend's servers to send for you |
| MX | `send.losthusky` (→ `send.losthusky.qzz.io`), priority 10 | `feedback-smtp.<region>.amazonses.com` — bounce/feedback handling for the *sending* subdomain (this is not inbound mail for you) |
| TXT | `resend._domainkey.losthusky` (→ `resend._domainkey.losthusky.qzz.io`) | long `p=MIGfMA0...` value (DKIM) — cryptographically signs your emails |

**Important — the Name field:** Cloudflare does NOT auto-trim the zone suffix
the way some registrars do. If your zone in Cloudflare is `losthusky.qzz.io`,
paste the record name **exactly as Resend shows it, minus the trailing
`.losthusky.qzz.io`** — e.g. enter `send.losthusky`, not
`send.losthusky.qzz.io` (which resolves to
`send.losthusky.qzz.io.losthusky.qzz.io` and silently fails verification).
This bit us once already — always resolve the final record with
`Resolve-DnsName -Name resend._domainkey.losthusky.qzz.io -Type TXT -Server 1.1.1.1`
(or `dig`) after saving, and confirm the DKIM value comes back before trusting
the Resend dashboard's "pending" status.

Also:
- Set the records to **DNS only** (grey cloud). Email DNS records must never be proxied.
- Back in Resend, click **Verify DNS Records**. Propagation is usually < 15 minutes
  on Cloudflare. Status must read **Verified** before sending works.

> Note about `qzz.io`: it's a free/registry-managed domain. As long as your
> `losthusky.qzz.io` zone is delegated to Cloudflare nameservers (which it is, since
> the Worker custom domain works), all of the above behaves like any normal domain.

## Step 3 — Create the API key and set the Worker secrets

In Resend: **API Keys → Create API Key** → permission "Sending access" → copy the
`re_...` key (you only see it once).

Then from the project folder:

```powershell
npx wrangler secret put RESEND_API_KEY
# paste: re_xxxxxxxxxxxxxxxx

npx wrangler secret put NOTIFY_FROM
# paste: LostHusky Drop <notify@losthusky.qzz.io>

npx wrangler secret put NOTIFY_TO
# paste: ghanisht.kumawat@gmail.com
```

Rules for the values:
- **NOTIFY_FROM** must use the exact domain you verified in Resend — since the
  domain here is the bare root `losthusky.qzz.io` (not a `send.` subdomain),
  the address is `notify@losthusky.qzz.io`. The
  `Display Name <address>` format controls the sender name in inboxes.
  The mailbox part (`notify@`) can be anything — it does not need to exist.
- **NOTIFY_TO** is where notifications are delivered — your personal inbox.
  It can be any address; it does not need to be on your domain.
- Never put these in `wrangler.jsonc` `vars` — the key is a secret, and this repo
  forbids committing secrets.

Redeploy afterwards (`npx wrangler deploy`) so the Worker picks up the secrets.

## Step 4 — Test it

1. Open a drop link, enable **Email me + On upload start** for it in Link detail.
2. Upload a small file. Within seconds you should get "…started uploading".
3. If nothing arrives, check **Resend → Logs** first (it shows every accepted /
   rejected send), then `npx wrangler tail` for `notify failed` messages.

## Changing the email templates

- The **shared branded frame** (header, card, footer) is `emailTemplate()` in
  `src/store.js` — edit HTML/inline styles there once and every email inherits it.
- The **"started uploading" body** is built in `recordSessionStart()` in `src/worker.js`.
- The **session digest body** ("N files — Y GB") is built in `maybeSendDigest()` in
  `src/live.js`.

Keep all styles inline (email clients ignore `<style>` blocks), and keep using
`escapeHtml()` around any uploader-controlled text.

## Optional — receiving email at losthusky.qzz.io

Sending needs no inbox, but if you ever want to *receive* mail (e.g. replies to
`notify@`), use **Cloudflare Email Routing** (free):

1. Cloudflare dashboard → your zone → **Email → Email Routing** → Enable.
2. Cloudflare auto-creates the required **MX + SPF records on the root domain**
   (these do not conflict with Resend's records, which live on `send.`).
3. Add a routing rule: `anything@losthusky.qzz.io` → forward to your Gmail.
4. Verify the destination address from the confirmation email.

That gives you real inbound addresses on the domain without running a mail server.
