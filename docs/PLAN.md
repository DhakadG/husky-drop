# LostHusky's DropBox - Plan

Personal Smash-style file receiving service. Friends upload from iPhones via a
drop link; files land directly in Google Drive. Cloudflare Worker + KV +
Durable Object, with zero file bytes through the Worker.

This `docs/` folder is never deployed. Wrangler deploys the Worker entry in
`src/` and static assets in `public/`.

## Feature Map

| Feature | Status | Implementation |
| --- | --- | --- |
| Secure drop links | v2 | Slugged links in KV, password/PIN, expiry |
| Huge transfers | v2 | Browser to Drive resumable uploads, 5 TB default ceiling |
| Password protection | v2 | Salted SHA-256 PIN hashes |
| Brute-force lockouts | v2 | Per-IP exponential lockout plus per-link global damping |
| Validity period | v2 | Per-link expiry, 0 = permanent, max 30 days from admin UI |
| Usage dashboard | v2 | Global overview, stats, live sessions, event feed |
| Per-transfer report | v2 | Per-link uploads, opens, active sessions, totals |
| Live transfer progress | v2 | Durable Object WebSockets, no KV heartbeat writes |
| Follow-up emails | v2 | Resend API if configured, per-link toggles |
| Custom branding | v2 | Logo, background, accent, welcome message |
| Loading-screen promo | v2 | Promo card with YouTube/Vimeo and CTA |
| Media previews | v2 | Admin-side Drive preview/open action |
| Transfer history | v2 | Upload log kept 1 year in KV metadata |
| Upload tuning | v2 | Parallel transfers 1-4 and 8/16/32 MB chunks |
| Per-uploader folders | v2 | Optional Drive subfolder by uploader name |
| Sending files to others | Later | Out of scope; Drive share links cover it |

## Operational Notes

- Worker name stays `husky-drop`; changing it creates a new Worker and loses
  existing secret bindings.
- UI/domain brand becomes `LostHusky's DropBox`.
- Custom domain route is `dropbox.losthusky.qzz.io`.
- Real `wrangler.jsonc` stays local. Commit only `wrangler.example.jsonc`.
