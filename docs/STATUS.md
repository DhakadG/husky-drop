# Status — September 2026 fix round

What was asked, what shipped, what is still open. Each row links the PR that
carried it. Everything listed as shipped is merged into `main` and deployed by
the GitHub → Cloudflare integration.

## Goals from the brief

| # | Ask | Status | Where |
| --- | --- | --- | --- |
| 1 | Emails not arriving for started / finished uploads | Shipped | [#1](https://github.com/DhakadG/husky-drop/pull/1), [#6](https://github.com/DhakadG/husky-drop/pull/6) |
| 2 | Upload page stuck on "Uploading" after files were in Drive | Shipped | [#2](https://github.com/DhakadG/husky-drop/pull/2), [#7](https://github.com/DhakadG/husky-drop/pull/7) |
| 3 | Upload speed not matching the network | Shipped (2–3 MB/s → 56 MB/s avg on 44 GB) | [#2](https://github.com/DhakadG/husky-drop/pull/2), [#7](https://github.com/DhakadG/husky-drop/pull/7) |
| 4 | Admin refresh / back lands on Overview | Shipped | [#3](https://github.com/DhakadG/husky-drop/pull/3) |
| 5 | 3–5 s on the sign-in screen when already signed in | Shipped | [#3](https://github.com/DhakadG/husky-drop/pull/3) |
| 6 | Overview full of developer wording | Shipped | [#5](https://github.com/DhakadG/husky-drop/pull/5) |
| 7 | One timeline per person across drops and shares | Shipped (named / signed-in identity; no FingerprintJS) | [#5](https://github.com/DhakadG/husky-drop/pull/5) |
| 8 | PIN field triggers password manager; want number pad for numeric codes | Shipped | [#4](https://github.com/DhakadG/husky-drop/pull/4) |
| 9 | Uploaders can build sub-folders even when admin chose per-uploader folders | Shipped | [#4](https://github.com/DhakadG/husky-drop/pull/4) |
| 10 | Use the Google account name in emails when sign-in is required | Shipped | [#1](https://github.com/DhakadG/husky-drop/pull/1) |
| 11 | Richer email content | Shipped | [#6](https://github.com/DhakadG/husky-drop/pull/6), [#7](https://github.com/DhakadG/husky-drop/pull/7) |
| 12 | "Keep this page open" + Pause still shown after everything delivered | Shipped | [#7](https://github.com/DhakadG/husky-drop/pull/7) |
| 13 | Upload queue: finished rows fade, next moves up, actions on one line | Shipped | [#7](https://github.com/DhakadG/husky-drop/pull/7) |
| 14 | Upload files in a predictable order | Shipped (folder → natural name order) | [#7](https://github.com/DhakadG/husky-drop/pull/7) |
| 15 | Drive picker: "My Drive / My Drive", current folder scrolled out of view | Shipped | [#8](https://github.com/DhakadG/husky-drop/pull/8) |
| 16 | Remember recently used folders | Shipped (last 6, per browser) | [#8](https://github.com/DhakadG/husky-drop/pull/8) |
| 17 | "Create a share of this drop" after making a drop link | Shipped | [#8](https://github.com/DhakadG/husky-drop/pull/8) |
| 18 | Google Drive icons | Partial — picker header only | [#8](https://github.com/DhakadG/husky-drop/pull/8) |
| 19 | "Refresh snapshot" does nothing until reload | Changed — button now re-arms the live socket. Needs confirmation on prod. | [#7](https://github.com/DhakadG/husky-drop/pull/7) |
| 20 | Real-time transfer view without burning Cloudflare quota | Already the design: one Durable Object WebSocket per admin tab, no KV polling. Nothing to add unless #19 proves the socket drops. | — |
| 21 | Clerk viewer auth | Dropped (2026-09-15) — viewer sign-in stays Google OAuth | — |
| 22 | Routes secured | Admin API cookie-gated + same-origin; `/admin/*` pages public shells, data behind auth. No change needed. | — |

## Root causes worth remembering

- **Digest email depended on the browser.** The finished email fired only when
  the uploader's tab sent a WebSocket frame saying `done`. Closed tab, dropped
  socket or one failed `/api/complete` → no email, page stuck on "Uploading".
  The Durable Object now decides from Drive-verified completions
  (`LiveTracker.flushDigests`, 8 s settle after done / 90 s idle).
- **One file per second.** Every `/api/session` resolved the uploader's Drive
  folder through a per-uploader lock, then re-read a KV cache that had not
  propagated (KV is eventually consistent). Parallel files each paid a Drive
  lookup in series. `LiveTracker.resolveFolderOnce` memoises folder ids in DO
  memory.
- **Half-idle gigabit link.** `pump()` capped bytes in flight at
  `concurrency × chunkSize`; once chunks adapted to 128 MB that meant 2–4
  files. Parallelism is now a file count (≤12 desktop / ≤8 mobile) with a
  memory-only byte cap.
- **Gmail soft-bounces.** `550-5.7.1 likely unsolicited`: two-line body, a
  subject starting "LostHusky's DropBox:" (Dropbox look-alike).
  Bodies are now informative and subjects read
  `Priya sent 7 files (27.7 MB) to Chandlai`.
- **Slow sign-in screen.** The cookie check was the full overview (serial KV
  walk over every link). Now `GET /api/admin/me`.

## Still on you

- Confirm on prod whether "Refresh snapshot" / live view stays current during a
  long transfer. If not, note what the sidebar pill says (`live updates on`
  or `off`) — that tells us whether the socket died.
- Delete any unused `CLERK_*` secrets/vars from the Worker and `.dev.vars`.

## Not done, on purpose

- FingerprintJS — named or signed-in identity already gives one timeline per
  person; add only if anonymous cross-device matching is ever needed.
- Persisting digest candidates in DO storage — a DO is not evicted while an
  upload socket is open; a restart mid-transfer loses at most one email.
- Auto-scrolling the upload queue — active rows are always at the top, so the
  viewport already stays on current uploads.
- Batch session minting — unnecessary once the folder lock was fixed.

## How the work was run

Branch per concern → PR → CodeRabbit CLI review (WSL) → fix findings → merge to
`main` (auto-deploys). Tests: `npm test`. Knowledge graph: `graphify update .`.
