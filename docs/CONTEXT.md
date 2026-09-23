# CONTEXT — read this first

This is the file to load at the start of a working session. It exists so
nobody (human or agent) has to read the tree to find out what this repo is,
where things live, how a request flows, and which traps have already been hit.
Everything here is current as of **2026-09-23**; if something below disagrees
with the code, the code wins and this file is wrong — fix it in the same PR.

Companion files: [ARCHITECTURE.md](ARCHITECTURE.md) (drop-side internals in
depth), [API.md](API.md) (endpoint reference), [RUNBOOK.md](RUNBOOK.md) (how to
operate the live thing), [CHANGELOG.md](CHANGELOG.md) (why things are the way
they are — newest first, and genuinely worth skimming).

---

## 1. What this is

A personal file-delivery service on Cloudflare Workers, live at
**https://dropbox.losthusky.qzz.io**.

Two halves:

- **Drop links** (`/d/:slug`) — you send someone a link, they drop photos and
  videos in, and the files land in **your Google Drive** at original quality.
  No accounts, no app, multi-gigabyte files, resumable.
- **Share links** (`/s/:slug`) — you send someone a gallery of Drive folders
  they can browse, view and download.

Plus an **admin dashboard** (`/admin`) for links, live transfers, analytics,
people, background pipelines and logs.

**The one architectural fact everything else follows from: file bytes never
pass through the Worker on upload.** The browser gets a Drive resumable-upload
session URL and PUTs chunks straight to Google. The Worker only mints sessions,
records progress and verifies completions. Download and viewing *do* stream
through the Worker, because Drive's URLs are not shareable.

---

## 2. Stack and bindings

| Piece | What it is | Binding |
| --- | --- | --- |
| Worker | the whole app, `src/worker.js` is the router | — |
| KV | all durable app state (links, shares, indexes, counters) | `KV` |
| Durable Object | `LiveTracker`: live sessions over hibernatable WebSockets, plus SQLite for telemetry, activity, the app log | `LIVE_TRACKER` |
| R2 | `husky-drop-media`: thumbnail tiers, watched video previews, share stats blobs. **Private bucket, no public domain.** | `MEDIA_BUCKET` |
| Service binding | the Worker calling itself (a plain `fetch()` to its own host is Cloudflare error 1042) | `SELF` |
| Cron | `45 22 * * *` — image rules, share-index, identity stitching | `triggers.crons` |
| GitHub Actions | the heavy transcoders; the Worker dispatches and they call back | `GITHUB_TOKEN` |

Vars live in `wrangler.jsonc`; secrets are set with `wrangler secret put` and
listed in [DEPLOY.md](DEPLOY.md). Locally, `.dev.vars` holds only `ADMIN_TOKEN`
— **there are no Google credentials on this machine**, so anything that talks
to Drive can only be exercised against production or the fixture server.

Secrets the code reads: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`,
`GOOGLE_REFRESH_TOKEN`, `DRIVE_PARENT_ID`, `ADMIN_TOKEN`, `ADMIN_EMAIL`,
`SHARE_SIGNING_KEY`, `RESEND_API_KEY`, `NOTIFY_TO`/`NOTIFY_FROM`/`NOTIFY_REPLY_TO`,
`GITHUB_TOKEN`, `GITHUB_REPO`, `GEMINI_API_KEY`, `FP_SERVER_KEY`, `FP_RULESET_ID`.

---

## 3. Where things live

### `src/` — the Worker (33 files)

**Entry and shared**

| File | Job |
| --- | --- |
| `worker.js` | the router: every route is here, plus page serving, admin auth and the `scheduled()` handler |
| `index.js` | a 4-line shim; the real entry is `worker.js` (see `wrangler.jsonc` `main`) |
| `util.js` | constants, normalizers, `escapeHtml`, slug/PIN validation. No network, no KV |
| `store.js` | KV state: counters, events, upload history, PIN lockouts, notification emails |
| `drive.js` | every Google Drive call; token caching, folder walks, metadata, trash |
| `auth.js` | Google OAuth for *viewers* (attribution on share links), separate from admin auth |
| `applog.js` | the app log (SQLite in the DO) that the admin Logs tab reads |

**Drop side**

| File | Job |
| --- | --- |
| `drop-api.js` | public drop endpoints: meta, PIN, resumable session minting, `/api/preflight`, progress, completion |
| `admin-api.js` | admin drop-link CRUD, overview, timeseries, activity, Drive folder browsing |
| `live.js` | the `LiveTracker` Durable Object itself: sessions, WebSockets, alarms |
| `live-analytics.js` | DO SQLite: day rollups, `telemetry_batches` (30-day prune), activity feed |
| `live-completions.js` | buffers verified completions in DO memory, flushes to KV in one batch per alarm |
| `live-diagnostics.js` | DO routes for the log and People |
| `live-digest.js` | one "X uploaded N files" email per finished session |
| `identity.js`, `people.js`, `stitch.js` | device sessions, per-visitor profiles, nightly account stitching |

**Share side**

| File | Job |
| --- | --- |
| `share.js` | public share endpoints: meta, listing, summary, tracking. Two modes: gallery and redirect |
| `share-admin.js` | share CRUD, Drive permission revocation for redirect shares |
| `share-token.js` | short-lived HMAC download tokens, and the public-download safety list |
| `share-media.js` | the per-file byte routes: thumbnails, Range downloads, warm-on-browse |
| `media-cache.js` | **the ladder**: edge cache → R2 → Drive, content-addressed keys, `?dl=` attachments |
| `share-zip.js` | "download all" as a streamed STORE-mode ZIP64 |
| `share-index.js` | the index job: walks a share's Drive tree in bounded chunks, writes folder stats and file rows to R2, warms thumbnails. Also folder dedupe |
| `share-changes.js` | Drive change feed, scheduling, stalled-job resume, R2 orphan sweeps |
| `share-stats.js` | the endpoints the share page and admin use to read the index |
| `share-previews.js` | RAW/HEIC/TIFF → WebP "preview-equivalents" and WebP thumbnails, both made by GitHub runners |
| `previews.js` | 720p **video** previews (a separate, older pipeline) |
| `images.js`, `images-run.js`, `images-rules.js` | the image-archive re-encode jobs and their recurring rules |
| `pipelines.js` | the admin Pipelines tab: one read-only view over all of the above |
| `exif.js` | EXIF parsing for the viewer's file-info panel |

### `public/` — the browser (no bundler, no framework)

Plain ES modules and classic scripts served straight from the Worker's assets.
`public.js` is a **classic** script (not a module) loaded first on every page;
it defines the globals `esc`, `escAttr`, `reconcile`, `fmtBytes`, `uiIcon`.

| Group | Files | Notes |
| --- | --- | --- |
| Shared | `public.js`, `identity.js`, `skeleton.js` | `skeleton.js` is the one loading-state vocabulary (see §6) |
| Drop page | `drop.js` + `drop-{queue,render,state,resume,live,report,trekker,utils}.js`, `adaptive-concurrency.js` | the upload engine: parallel chunked PUTs, resume from IndexedDB, stall watchdog |
| Share page | `share.js` (1.3k lines, the big one) + `share-{state,utils,cache,access,download,select,selection-engine,gallery-layout,smart-header,preview,beacon,trekker,fx}.js` | |
| Share viewer | `share-viewer.js` + `share-viewer-{engine,state,assets,info,panels,strip,video}.js` | PhotoSwipe-based lightbox; `-engine` is deliberately DOM-free so it can be unit-tested |
| Admin | `admin.js` + `admin-{state,links,detail,shares,live,activity,activity-tools,people,people-profile,images,images-plan,images-rules,previews,pipelines,logs,folders,chart}.js` | one module per tab |

HTML pages: `index.html`, `admin.html`, `drop.html`, `share.html`,
`privacy.html`, `terms.html`. Icons are one sprite, `icons.svg`, generated by
`scripts/build-icons.mjs` from `lucide-static` — **never hand-edit it**, and
`uiIcon()` validates every name against the catalog.

### `scripts/` — tests, runners, tools

Tests are plain `node` scripts with `node:assert` — there is no test framework,
no watch mode, and `npm test` runs all of them in sequence after ESLint.

| Script | What it guards |
| --- | --- |
| `smoke-test.mjs` | the big one: routes end to end against fake KV/R2/DO/Drive |
| `innerhtml-audit-test.mjs` | no user-controlled value reaches HTML unescaped |
| `skeleton-test.mjs` | the loading-skeleton vocabulary |
| `share-viewer-test.mjs`, `share-viewer-engine-test.mjs` | viewer contracts and state machine |
| `share-gallery-layout-test.mjs`, `share-selection-engine-test.mjs`, `share-smart-header-test.mjs`, `share-video-session-test.mjs` | share page pure logic |
| `ui-v3-test.mjs`, `mobile-responsive-test.mjs`, `icon-audit-test.mjs`, `readme-test.mjs` | UI/asset/doc invariants |
| `admin-workflow-test.mjs`, `kv-budget-test.mjs`, `exif-test.mjs`, `transcode-previews-test.mjs`, `identity-ban-test.mjs`, `image-rules-test.mjs` | admin flows, KV write budget, EXIF, transcoder API, ban ids keep their case, pausing a rule keeps its recipe |
| `plan-policy-test.mjs` | plans stay untracked, durable specs stay tracked |
| `docs-test.mjs` | doc links resolve, and every path this file names still exists |
| `review-test.mjs` | the deep-review tooling: surfaces name real files, sharding covers each file once, unchanged targets are skipped |
| `dev-fixture-server.mjs` (+ its test) | a local server with fake media so the share page can run with no Drive credentials |
| `build-icons.mjs`, `get-refresh-token.mjs`, `migrate-r2.mjs` | tools, not tests |
| `review/run.mjs`, `review/queue.mjs`, `review/mark.mjs`, `review/render.mjs`, `review/prompts.mjs`, `review/surfaces.json` | the whole-file and whole-surface review pass ([REVIEW.md](REVIEW.md)) |
| `transcode-share-previews.mjs`, `transcode-share-thumbs.mjs`, `transcode-images.mjs`, `transcode-previews.mjs`, `lib/image-decode.mjs` | what the GitHub runners execute |

### `.github/workflows/`

| Workflow | Trigger | Does |
| --- | --- | --- |
| `ci.yml` | every PR + main | `npm ci && npm test` |
| `pr-review.yml` | every PR | opencode AI review; **skips itself** unless an `ANTHROPIC_API_KEY` secret exists |
| `skylos.yml` | PR diffs only | static analysis gate (a whole-repo run fails on a pre-existing `innerHTML` backlog, so it is scoped) |
| `deep-review.yml` | manual | whole-file and whole-surface review; results land on the `reviews` branch ([REVIEW.md](REVIEW.md)) |
| `transcode-share-previews.yml` | 22:15 UTC + dispatch | RAW/HEIC → WebP previews **and** WebP thumbnails, 8 shards |
| `transcode-previews.yml` | 21:30 UTC + dispatch | 720p video previews |
| `transcode-images.yml` | dispatch | image-archive re-encode jobs |

CodeRabbit also reviews every PR as a GitHub App (nothing in the repo
configures it).

### `docs/`

`CONTEXT.md` (this), `ARCHITECTURE.md`, `API.md`, `DEPLOY.md`, `EMAIL.md`,
`SECURITY.md`, `RUNBOOK.md`, `CHANGELOG.md`, `superpowers/specs/` (durable
design specs, tracked) and `superpowers/plans/` (**gitignored** — local
progress trackers). Anything parked lives in `archive/` with a reason.

---

## 4. How a request flows

### Upload (drop link)

1. `/d/:slug` serves `drop.html`. `drop.js` fetches link meta, gates on PIN
   and/or Google sign-in.
2. Files are listed **synchronously** in the UI before any network call.
3. `POST /api/preflight` asks which of them the server already has
   (name + size + `lastModified`). Matches render as `skipped` with an
   "upload anyway" escape hatch. This is what stopped duplicate re-uploads
   after a page reload.
4. For each file: `POST /api/session` mints a Drive resumable session; the
   browser PUTs chunks **directly to Google**; `POST /api/progress` reports
   percentage into the Durable Object (never KV).
5. `POST /api/complete` — the Worker asks Drive for the file's real size and
   only then records the completion. Completions are idempotent by file id,
   buffered in the DO, and flushed to KV in one batch per alarm.
6. The admin dashboard sees all of it live over a hibernatable WebSocket.

Client states: `checking → queued → uploading → verifying → done`, plus
`skipped`, and an error taxonomy (`E_STALL`, `E_TIMEOUT`, `E_NET`, `E_AUTH`,
`E_CLOSED`, `E_EXPIRED`, `E_BUDGET`, `E_QUOTA`, `E_REJECTED`, `E_SERVER`).
A 20-second stall watchdog aborts and retries.

### Browsing (share link)

1. `/s/:slug` serves `share.html`; `POST /api/share/meta/:slug` then
   `/api/share/list` returns a folder listing (200 files a page).
2. Folder tiles fill in from `/api/share/stats`, which reads a **KV pointer**
   to an R2 blob — the hot path never touches Drive.
3. Thumbnails come from `/api/share/media/:slug/:fileId/:variant/:rev/:sig`.
4. Opening a folder fires `POST /api/share/warm` (capped at 15 files) so the
   Worker pulls the heavy tiers into the edge cache before anyone clicks.
5. Download tokens are short-lived and bound to slug + file; "download all"
   streams a ZIP64 built from Drive streams.

### The media ladder (`media-cache.js`)

```
browser Cache API + immutable HTTP cache     (L0, 30 days)
        ↓ miss
caches.default at the edge                   (L1a)
        ↓ miss
R2 husky-drop-media                          (L1b — thumb-lo, thumb-md, watched video-720 only)
        ↓ miss
Google Drive                                 (L2)
```

Keys are content-addressed: `media/<fileId>/<variant>-<rev>`, where `rev` is
Drive's md5 when it exists and `modifiedTime` otherwise. Variants:
`thumb-lo` (512), `thumb-md` (1024), `thumb-hi` (1600, served live from Google),
`preview-webp` (from Drive's `_share_previews` folder), `video-720`.
Every URL carries an HMAC signature (`mediaSig`) and is verified **after**
`requireViewer` — auth first, cache second.

**R2 is deliberately small.** It holds the two page-load thumbnail tiers plus
video previews somebody actually watched; a 30-day lifecycle rule ages the rest
out. Full-size previews live in Drive. This is why the bucket sits at ~2–3 GB
instead of the 17.9 GB it once was.

### Background work

`share-index` jobs walk a share's Drive tree in chunks and write three R2
objects per share: `stats/<slug>.json` (folders), `stats/<slug>.files.json`
(file rows) and `stats/<slug>.job.json` (the cursor). A KV pointer
`share-stats:<slug>` names the current blob; KV job records live in
`share-index:jobs`.

Phases are `walk → warm → done`. Each chunk is time-boxed (`INDEX_CHUNK_MS`,
20 s) and subrequest-boxed (`INDEX_CHUNK`, 200), then schedules the next chunk
**through the `SELF` service binding**. Drive's change feed
(`changes:cursor`) folds newly changed file ids into a running job or starts a
targeted one.

The transcoders are GitHub Actions: the Worker dispatches a workflow, the
runner asks for pending work (`/previews/pending`, `/thumbs/pending`), does the
decode, `PUT`s the result back, and reports progress.

---

## 5. Data stores at a glance

**KV** (writes are the scarce resource — see §7)

| Key | Holds |
| --- | --- |
| `link:<slug>`, `links:index` | drop links |
| `share:<slug>`, `shares:index` | share links |
| `share-index:jobs` | index job records (written at start and end only) |
| `share-stats:<slug>` | pointer to the R2 stats blob |
| `share-previews:index` | which files have a WebP preview, plus run history |
| `share-previews:delta:<run>-<shard>` | one runner shard's report (3-day TTL) |
| `share-thumbs:runs`, `share-thumbs:shard:<run>-<shard>` | thumbnail run progress |
| `previews:index`, `previews:folder:*`, `previews:live` | video previews |
| `images:jobs`, `images:rules` | image archive |
| `changes:cursor` | Drive change page token |
| `media:orphans:last` | last R2 sweep result |
| `stats:<slug>`, `recent:<slug>`, `ev:*`, `events:recent` | counters and the event feed |

**R2** `media/<fileId>/<variant>-<rev>` and `stats/<slug>*.json`.

**Durable Object SQLite**: day rollups, `telemetry_batches` (30-day prune), the
activity log, the app log, People profiles.

---

## 6. Conventions that are load-bearing

- **Escaping.** Anything user-controlled that reaches HTML goes through
  `esc()` / `escAttr()` in the browser or `escapeHtml()` on the server, or is
  set with `textContent`. `scripts/innerhtml-audit-test.mjs` enforces this and
  will fail the build; if a flagged value genuinely cannot carry markup, add it
  to that file's `REVIEWED` map **with a reason**.
- **Loading states.** `public/skeleton.js` is the only vocabulary: `skelLines`,
  `skelRows`, `skelCards`, `skelTiles`, `skelFolders`, `skelPairs`, plus
  `delayedSkeleton()` which only paints if the wait passes ~180 ms. Bones are
  sized like the real content so nothing reflows.
- **Icons.** `uiIcon(name)` only; names are validated against `icons.svg`, and
  `icon-audit-test.mjs` fails on an unknown one.
- **DOM updates** in lists go through `reconcile()` in `public.js`, which
  reuses one element per key and removes static `.skel` placeholders on first
  paint.
- **File size.** Keep modules under ~500 lines; `share.js` is already over and
  should not grow.
- **Line endings.** Several files are CRLF (`share.js`, `admin-shares.js`,
  `API.md`, …). Match what is already in the file — a whole-file rewrite that
  flips endings makes the diff unreadable.

---

## 7. Traps already hit (do not re-learn these)

- **KV has no compare-and-set.** Eight runner shards read-modify-writing one
  key erased each other; the RAW preview backlog never drained because of it.
  Anything written concurrently gets **one key per writer** plus a union on
  read. Don't delete the per-writer keys either — that races with a writer;
  give them a TTL.
- **KV writes are budgeted**, reads are cheap. Live progress goes to the
  Durable Object, not KV. `kv-budget-test.mjs` exists to keep it that way.
- **`waitUntil` is capped at ~30 s.** Long work is chunked with an explicit
  time box, and the next chunk is scheduled — never "just loop".
- **A Worker fetching its own hostname is Cloudflare error 1042.** Use the
  `SELF` service binding.
- **A deploy kills an in-flight index chain.** `resumeStalledJobs()` picks it
  up within ~5 minutes, or hit *Process now* in the Pipelines tab.
- **Drive's `files.get` only returns the fields you ask for.** `trashed` was
  missing once, so trashed files kept their index rows until a full re-walk.
- **`caches.default` is per-colo**, so a warm cache in one region proves
  nothing about another.
- **Preview edge size is a money decision.** 4096px previews are what pushed R2
  over the free tier; they live in Drive now.
- **The bucket must stay private.** No public R2 domain — every byte is served
  through the Worker so auth and signatures actually mean something.

### Tooling quirks in this environment

- The Bash tool prints a harmless `claude-*-cwd: No such file` line on every
  call. Ignore it; check exit codes explicitly.
- Heredocs here mangle backticks and apostrophes. For anything non-trivial,
  write a small Node or Python script to the scratchpad and run that.
- `npm test` starts with ESLint. Run the whole thing before opening a PR; a
  regex-based import pruner once dropped `notifyEmail` and broke prod uploads.
- There are no Google credentials locally. Use `scripts/dev-fixture-server.mjs`
  for the share page, or test against production.

---

## 8. SOP — how work ships here

1. **Branch.** One concern per branch and per PR.
2. **Build it**, and update the things that go with it in the *same* PR:
   `docs/API.md` for endpoints, `docs/CHANGELOG.md` for the why, tests for the
   behaviour.
3. **`npm test`** — ESLint plus every script. Exit code 0, no exceptions.
4. **PR** with a test plan. CI, Skylos, opencode and CodeRabbit all run.
5. **Merge** — the GitHub → Cloudflare integration deploys within ~1–2 minutes.
   **Never `npm run deploy`.**
6. **Probe production.** `curl` the endpoint you changed, or open the page.
   A change is not finished because it merged.

Writing style for anything that leaves the repo — commits, PR bodies, docs,
code comments — is normal English prose that explains *why*. Chat can be terse;
artifacts are not.

Tests are not optional decoration: non-trivial logic leaves behind the smallest
check that fails if the logic breaks. Several tests in `scripts/` were written
by deliberately re-introducing the bug to confirm the test catches it — that is
the standard.

---

## 9. Probing production

The admin token is in `.dev.vars`.

```bash
T=$(grep ADMIN_TOKEN .dev.vars | cut -d= -f2 | tr -d '"\r ')
curl -s -H "authorization: Bearer $T" https://dropbox.losthusky.qzz.io/api/admin/pipelines
curl -s -H "authorization: Bearer $T" https://dropbox.losthusky.qzz.io/api/admin/logs
```

`/api/admin/pipelines` is the single best health check: share-index cursors,
preview and thumbnail runs, video previews, the image archive, the Drive change
feed and the last orphan sweep, plus the GitHub runs behind them.
[RUNBOOK.md](RUNBOOK.md) has the rest.

Test surfaces: drop `/d/temp` (PIN `2468`), share `/s/8quhkyv2`. The browser
in this environment is signed in as the admin.

---

## 10. Where to look when…

| You need to… | Start at |
| --- | --- |
| add or change an endpoint | `src/worker.js` (the router), then the module it calls, then `docs/API.md` |
| change what the gallery shows | `public/share.js` → `render()` |
| change the lightbox | `public/share-viewer-engine.js` for logic, `share-viewer.js` for the DOM |
| change upload behaviour | `public/drop-queue.js` and `src/drop-api.js` |
| change what R2 stores | `src/media-cache.js` — and read §4 first, the sizing is deliberate |
| add a background job | `src/share-index.js` for the chunking pattern, `src/pipelines.js` to surface it |
| find out why something looks the way it does | `docs/CHANGELOG.md`, then `docs/superpowers/specs/` |
| operate the live system | [RUNBOOK.md](RUNBOOK.md) |
