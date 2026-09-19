# Changelog

Newest first. Read this before touching the project — it says why things are
the way they are. Goal-by-goal status for the September round lives in
[STATUS.md](STATUS.md); design lives in [ARCHITECTURE.md](ARCHITECTURE.md).

## 2026-09-20 — RAW / oversized previews and "smaller (WebP)" downloads (PR #91)

Spec §5, §5.1 and §6 of the
[media-cache plan](superpowers/specs/2026-09-20-media-cache-ladder-design.md).

- **`scripts/lib/image-decode.mjs`** is the one RAW/HEIC decode path, shared
  by the image-archive runner and the new share-preview runner. It carries
  the fidelity rules: `dcraw_emu -o 1` (explicit sRGB, never the tool's
  default), `copyMetadataUpright()` (the only way tags go back onto rotated
  pixels - orientation always cleared), and `hasGainMap()` (Apple Adaptive
  HDR / Ultra HDR markers; a bare MPF segment does not count).
- **`scripts/transcode-share-previews.mjs`** + `transcode-share-previews.yml`
  (nightly, sharded) make a WebP preview-equivalent (long edge 4096, q84,
  ICC kept, upright) for RAW / HEIC / TIFF and decodable photos ≥ 50 MB in
  indexed shares, PUT it to R2 as the `preview-webp` variant and report in
  batches (one KV write each). Gain-map HDR JPEGs are skipped on purpose and
  the original is served - honest fallback over silent SDR flattening.
- **Serving.** The WebP becomes the gallery's high-resolution tier for those
  files; ≥ 50 MB decodable originals no longer auto-load in the viewer - a
  **Load original (98 MB)** button in the asset ladder fetches the real bytes
  through the existing verified Range path.
- **Downloads.** A "Download: original / smaller (WebP)" control on the share
  page. Single downloads swap to the WebP via `?dl=<name>`; ZIPs (`format:
  "webp"`) stream previews straight from R2 and fall back to the original for
  anything not processed yet.
- Admin Shares pane: **Make RAW previews** dispatches the runner; a finished
  full share-index also dispatches it.

## 2026-09-20 — share-index: folder stats from R2, change detection, rich folder tiles (PR #87)

Spec §2, §2.1, §3, §3.1, §4 and §8.3 of the
[media-cache plan](superpowers/specs/2026-09-20-media-cache-ladder-design.md).
Opening a folder no longer walks Drive to count it.

- **`src/share-index.js`** - a `share-index` job walks a share's tree in
  chunks of `INDEX_CHUNK` subrequests (40 default; fits the Free plan), writes
  per-folder stats and the file list to R2 after every chunk (partially
  walked folders show real numbers at once), then pre-warms thumbnails into
  the cache ladder (512px always, 1600px for photos over 3 MB). Cursor and
  progress live in R2; KV is written only when a job starts and ends, so a
  23k-file walk costs four KV writes, not thousands. Each chunk re-invokes
  the Worker on its own `/continue` route; the nightly cron resumes anything
  dropped. The lock is per share, on its own `share-index:jobs` key.
- **`src/share-changes.js`** - one Drive `changes.list` cursor for the whole
  app, polled at most every `CHANGE_WINDOW_SEC` (5 min) from the background
  of a share listing. Changed ids are intersected with each share's known
  files *and folders* (a new file inside a known folder counts) and start a
  targeted job for just those ids. Expired tokens re-anchor; the scheduled
  full walk (`INDEX_SCHEDULE`, per-share override in the editor, forced
  monthly) is the safety net. `sweepOrphans` backs the admin "Clear orphaned
  media" button.
- **`/api/share/summary`** answers from the blob (zero Drive calls, zero KV
  writes) once a share is indexed; `/api/share/stats` hands the gallery every
  folder's subtree totals and cover, keyed by the listing's fid.
- **Folder tiles** show the newest photo, photo/video/folder counts, size and
  "Modified N ago" when stats exist, and stay icon + name otherwise. Names go
  through `textContent`; nothing from Drive is rendered as HTML.
- **Video tiles that said "video" instead of a length**: those originals have
  no `videoMediaMetadata` in Drive and their preview was made before the
  runner reported durations. The warm phase now reads the duration off the
  720p preview file (which Drive does describe) and backfills
  `previews:index`; as a fallback the tile badge fills in the moment the
  browser learns the duration on hover.
- **Deep link lost on reload** (follow-up to #85): the boot-time root hop
  called `pushState(pathname)` and wiped the hash before the restore ran.
  It no longer touches history, and the URL is re-synced to the crumbs after
  a restore.
- **Hover zoom** now respects the stuck toolbar at the top and the phone
  selection bar at the bottom, picks the roomier side when neither fits, and
  leaves oversized tiles centred.
- Creating a gallery share queues its first index; the share card shows
  "Indexed 2 h ago / Indexing… / Not indexed yet" and a **Process now** button.
- Follow-ups from the first prod run (PRs #88–#90): chunks are time-boxed to
  `INDEX_CHUNK_MS` (20 s) because background work is cut off at 30 s; the
  continuation goes through a `SELF` service binding because a Worker cannot
  fetch its own hostname (error 1042); stats count as complete once the walk
  ends rather than after every thumbnail is warm; warming runs six files at
  a time. The 23,669-file share walked in five chunks.

## 2026-09-20 — Media cache ladder: thumbnails and previews served from R2 behind the edge (PR #86)

Spec §1 + §8.3 groundwork of the
[media-cache plan](superpowers/specs/2026-09-20-media-cache-ladder-design.md).
Nothing here touches what is fast already; it removes the Drive round trip
from everything that has been seen once.

- **New `src/media-cache.js`** - `serveMedia()`: edge `caches.default` →
  R2 `MEDIA_BUCKET` → Drive, keyed `media/<fileId>/<variant>-<rev>` where
  `rev` is the Drive md5 (or modified time). A changed file gets a new key;
  old objects age out through the bucket's 30-day lifecycle rules. Ranged
  reads (video scrubbing) skip the edge and read R2 with `{ range }`; a
  `bytes=0-` open is treated as the whole file so it fills the caches.
- **Stable thumbnail URLs.** `/api/share/thumb/<token>/<tier>` rotated its
  signed token on every listing, which is why a reload re-downloaded every
  thumbnail: the browser never saw the same URL twice. Listings now hand out
  `/api/share/media/<slug>/<file>/<variant>/<rev>/<sig>` - same bytes, same
  URL, for every viewer - served `immutable` for 30 days, so the browser's
  own HTTP cache is the L0 tier with no JavaScript in the way. The signature
  has no expiry; the share's state and the viewer's sign-in are checked on
  every request, hit or miss, before any cache is consulted (§1.2).
- **720p video previews** ride the same ladder (`video-720`), keyed by the
  preview file's id so a regenerated preview gets a fresh URL. No parallel
  video path.
- `md5Checksum` is now part of the Drive listing and metadata fields.
- Bucket `husky-drop-media` created with 30-day expiry rules on `media/`
  and `stats/`; `MEDIA_BUCKET` binding in `wrangler.jsonc`. The code runs
  without the binding (edge + Drive only), so a downgrade fails soft.
- R2 Data Catalog and D1 were considered and skipped: the catalog is for
  Iceberg analytics engines, and D1 would replace the one-JSON-per-share
  stats blob with rows without removing any work from the read path.

## 2026-09-20 — Share gallery: hover zoom stays on screen, deep links survive a reload (PR #85)

First slice of the media-cache plan
([spec](superpowers/specs/2026-09-20-media-cache-ladder-design.md), §0).

- **Hover zoom clipped at the window edge.** The tile scales from its centre,
  so a first-column tile grew half off-screen. On `pointerenter` the tile
  measures itself against the viewport and snaps its `transform-origin` to
  whichever edge would clip (left/right/top/bottom), growing inward instead.
  Pure helper `hoverZoomOrigin()` in `share-gallery-layout.js`, unit-tested.
- **Refreshing inside a folder dropped to the root.** The folder path already
  lived in the URL hash (`#fid/fid`); nothing read it on boot. The gallery now
  walks the hash down from the root before the first paint, so a reload, a
  pasted deep link, and the round trip through Google sign-in all land back in
  the same folder. Browser back into a folder we had climbed out of via the
  breadcrumb used to fall to the root too - it rebuilds the path the same way.
- **Listings are kept in the browser Cache API** (`husky-media-v1`) for the
  same 5 minutes the in-page cache already honoured, so that reload paints
  from local data instead of re-listing Drive. New `share-cache.js`; the
  thumbnail bytes themselves move to the same store in the next slice.

## 2026-09-17 — Where the missing thumbnails and durations actually went (PR #80)

The tiles with no still are exactly the tiles whose badge reads "video", and
that is not a coincidence. `thumb` and `dur` came from one place only: Drive's
own `thumbnailLink` and `videoMediaMetadata`. Drive generates both itself, after
upload, and for a good number of these files it never did - so both were empty
while `size`, which comes straight off the file, was always right.

- Every one of those files now has a 720p H.264 preview, which Drive is
  perfectly happy to describe. A file missing Drive metadata now borrows the
  preview's: the duration and shape that ffprobe already measured on the runner
  and reports with the batch, and a thumbnail served from the preview file.
  Anything Drive did supply still wins.
- **Hover stopped producing a still at all** after PR #79: a poster attempt set
  a guard it never released and could mark the file as permanently unthumbable,
  so the hover-time capture was skipped afterwards. The guard is released after
  every attempt and a failed poster no longer disables hovering.
- Poster capture asked for metadata only, which stops at `readyState 1` and
  leaves no frame to draw. It asks for data now.
- **Hover zoom scaled the chrome with the tile**: at 1.5x the filename, checkbox
  and download button were 1.5x too. Each overlay scales back by the same
  factor from its own corner, so only the picture grows.

## 2026-09-17 — Share gallery: posters on load, hover card rebuilt (PR #79)

- **Videos with no Drive thumbnail stayed blank chips** until you pointed at
  them: grabbing a frame only happened inside the hover preview. Tiles now pull
  their own poster as they scroll into range, three at a time since each one
  downloads the 720p preview to decode a frame.
- **The progress bar only appeared on the first hover.** `attachBufferBar` ran
  only on the hover that first parented the video element, and the bar removed
  itself on every `pointerleave` - so from the second hover on there was none.
  It is rebuilt each time now.
- **And it was invisible anyway**: the bar sat at `z-index: 3`, under the
  caption's readability gradient at `4`. It goes above the caption, is taller,
  has its own dark track and a glow on the played portion, and the caption
  leaves room for it.
- **The play glyph is gone.** Hovering already plays the clip; the duration
  badge is what marks a video, so every video carries one - clips with no known
  duration read "video" - and it stays visible without hovering.
- **Hover zoom is now a choice**: auto, off, subtle, medium, large, in the
  gallery toolbar. Whatever is picked is scaled by the density slider, because
  growing a tile only helps when the tile is small: at the densest setting a
  tile has room and needs the detail, at the largest it already fills the row.
  Even "large" settles at 1.0 on full-size tiles.
- **Scrolling**: anchor and programmatic jumps are smoothed. The wheel is left
  alone on purpose - smoothing it changes how far a flick travels. The jitter
  was paint cost, so tiles are now layout/paint islands and off-screen ones skip
  rendering entirely.

## 2026-09-17 — Never transcode the same file twice (PR #78)

The worker decides what is pending from `previews:index`, and the index only
learns about a file once its batch report lands. Three ways that let a file be
done more than once, or counted more than once:

- **A report that never landed was thrown away.** `report()` cleared the buffer
  before sending and gave up after three attempts, so those results were lost
  and the files looked pending again on the next fetch - transcoded a second
  time, at full cost. Failed results are now put back for the next flush.
- **No runner-side memory.** A runner now keeps the ids it has claimed and drops
  them from later batches, whatever the server offers. If a whole batch comes
  back already-done, it stops rather than looping.
- **The run summary double-counted.** `run.done` and `run.bytes` were incremented
  per report, so a re-sent report inflated them, and a file that failed and then
  succeeded counted in both columns. Each file is now counted once, by its
  latest outcome.

Per-folder coverage was already right (`ready + waiting = videos` on every row);
these fix the run totals and the wasted work behind them.

## 2026-09-17 — Silent sources, honest stats, transcoding hero (PR #77)

- **ffmpeg exit 234 on videos with no audio.** `-c:a aac -b:a X -ac 2` was passed
  unconditionally, so for a source with no audio stream ffmpeg built an output
  audio stream with nothing feeding it and died with
  `aost#0:1/aac … Error initializing a simple filtergraph`. The probe now
  reports `hasAudio` and those files encode with `-an`. Any other encode failure
  is retried once without audio, which also covers channel layouts ffmpeg will
  not resample and codecs it cannot decode - a silent preview beats none.
  A silent H.264 720p file can now fast-remux too; it used to re-encode because
  the compliance check demanded an aac or mp3 track.
- **"3777 · 103%" ready out of 3654 videos.** Nothing was transcoded twice. The
  overview counted every preview in the index - including ones whose original
  has left the shares - and the dashboard showed that against the folder tree's
  video count. Coverage numbers now come from the tree only, the index size is
  reported separately, and previews outside the shares are counted as
  `orphans` and shown in the Coverage header. "Waiting" was hitting 0 for the
  same reason.
- **Duplicate previews in Drive.** A run cancelled between transcoding and its
  batch report gets redone next time, and `putPreview` always creates a new
  Drive file, so the old one was leaked forever. The report now trashes the
  preview it replaces.
- `-threads 2` on x264: six workers sharing four vCPUs were each trying to use
  every core.
- **Transcoding now** is rebuilt around one large progress bar and a large
  percentage to three decimals, with done/total, compression, throughput per
  minute, estimated time left and failures beside it.
- Finished files in the live feed no longer carry a chip that reads like a
  "transcode" button.
- Folder indent guides are coloured per depth, VS Code style, so nesting reads
  without counting pixels.

## 2026-09-17 — Coverage table: undo the global form styles (PR #76)

The folder checkboxes rendered as 48px slabs and selected rows smeared
sideways over the neighbouring columns.

- `input, select` sets `width: 100%`, `min-height: 48px` and 12px of padding for
  every field on the site. `.pick` set only width and height, so the height and
  padding still applied: a 48px checkbox that stretched every row with it. It
  now resets `min-height`, `padding` and `box-sizing` as well. The coverage search
  field had the same problem.
- `.tree-cell` was `display: flex` on a `<td>`, which takes the cell out of the
  table’s column layout - that is what pushed the selected rows’ background
  across the Share and Progress columns. The cell is a table cell again and a
  span inside it does the laying out; same for the progress cell.
- Rows are tighter: 4px of vertical padding, a 15px checkbox, smaller process
  buttons and a narrower progress bar, so more of the 115 folders fit on screen.

## 2026-09-17 — Previews: fan out to 20 runners, rebuilt coverage panel (PR #74)

Asking for 4,000 videos ran 300 of them, on one runner, for 50 minutes.

- **Run limits are honoured.** `startPreviewRun` clamped every request to 300
  regardless of what the admin typed. The ceiling is now 5,000, and the toolbar
  input says "videos" so the number means something.
- **The work is spread over runners.** GitHub gives a public repo 20 concurrent
  Linux runners, each 4 vCPU / 16 GB / 14 GB SSD with a 6-hour job cap, so the
  workflow is now a matrix of up to 20 jobs. Each runner asks the worker for the
  videos whose id hashes to its shard — a stable hash, not a slice of the list,
  because the list shrinks as the other runners report. A `plan` job warms the
  Drive tree cache first so 20 machines do not crawl Drive at once.
- **Per-runner concurrency follows the CPU count** (cores + 2, capped at 6 for
  the 14 GB disk) instead of a fixed 3. A worker spends much of its life on the
  network, so more workers than cores keeps ffmpeg fed.
- **One run, many runners, one live panel.** The Durable Object used to be reset
  by each runner's hello and keyed workers by slot number alone, so runners
  overwrote each other. It now tracks runners by shard, keys workers
  "shard:slot", and only calls a run over once the last runner leaves.
- **Stop a run** from the dashboard (`POST /api/admin/previews/cancel`). GitHub
  has no pause, so this cancels; whatever was already reported is kept.
- **Coverage panel rebuilt**: select-all with a mixed state, shift-click ranges,
  press-and-drag over the checkboxes, search, All/Waiting/Failed/Done filters, a
  real folder tree with collapsible subtrees and indent guides, a live "n
  folders · n videos" selection readout, and a 16px checkbox in place of the one
  that ate a row of height. Selection survives a rescan.
- The folder tree is rebuilt from parent ids. The scan walks sibling folders
  concurrently, so its list is not depth-first and indenting by depth alone
  nested folders under the wrong parent.
- **Runs panel**: runner count control, per-run failure count and a "retry this
  run's failures" button, and the toolbar no longer redraws under your caret
  while you are typing a limit.
- Panels in the tab had no gap between them; they do now.

## 2026-09-17 — Video previews tab: stop the flicker loop (PR #73)

The dashboard rebuilt the whole Video previews tab on every WebSocket tick and
every 20s poll, and each rebuild asked for a fresh Google Drive crawl of ~3,600
files. Clicking "retry" on a failed transcode landed in that loop, so the tab
flickered, reset folder checkboxes mid-click, and stalled on a scan that
Cloudflare eventually cut off with a 524.

- A poll or telemetry tick now patches the stat cards, live monitor, runs table
  and failed list in place. Only the first paint renders the whole tab, and the
  coverage table is left alone unless coverage itself reloaded.
- A refreshed overview keeps the folders it already has instead of dropping them
  and re-crawling. `?fresh=1` is now only about re-crawling Drive, which is the
  coverage endpoint's job; the overview always answers from cache.
- One Drive crawl at a time, bounded at 60s on the client so a hung scan fails
  into the inline retry strip instead of wedging every later scan.
- Retry / run / run-end refresh coverage from the cached tree (one KV read)
  instead of forcing a full re-crawl.
- The overview no longer invents coverage from the index: it reported "420 · 100%
  ready" while 3,200 videos had no preview. `videos` and `pending` are null until
  the crawl lands and the cards show "…". "Failed" counts files that used all 3
  tries, matching its label and the coverage numbers.
- A cancelled run no longer shows as "running" forever, and a runner that dies
  without saying goodbye stops pinning the dashboard to "live" (no telemetry for
  2 minutes = gone).
- Event handlers are delegated on the tab body and attached once, so swapping
  panels can neither lose them nor stack duplicates.

## 2026-09-19 — Activity v2, session continuity, previews cache (PR #81)

- **Activity tab** rebuilt: stats strip for the filtered set, filters for
  kind (drop/share/admin), person, link, range (today…14 d, pulls earlier
  days as needed), sort, search; three views - session cards, flat table
  (500 rows), per-person totals; CSV export; refresh; "clear filters".
  Person identity uses the device→account map, so the visit before the
  Google redirect and the one after are one card.
- Drop and share pages keep their session id in `sessionStorage`, so the
  sign-in reload continues the same session instead of starting a new one.
- Previews: the share tree cache has no TTL any more (overview answers
  instantly; scans refresh it); "finished" is logged and mailed once per
  run instead of once per parallel runner; stat shows "…" not "null".
- Log rows: compact dates, wider column; sidebar live-updates dot no longer
  squashed; icons drop their trailing margin when last in a control.
- `admin-activity-tools.js` holds the toolbar and table/people views.
- Stitch retries once after 20 s on Gemini 503/429 (PR #82).

## 2026-09-16 — Archive links, rules verdicts, overview skeleton fix (PR #69)

- Drop and share links can be **archived** (PATCH `{archived}`): closed to
  visitors like an expired link, folded into "Expired & archived" /
  "Archived" in the admin, nothing deleted.
- Fingerprint Rules Engine: with `FP_RULESET_ID` the Server API call
  evaluates the ruleset; `rule: block` shows as a risk tag with the rule.
- Fingerprint Pro (metered) runs once per device to seed `hd_fp`, then
  only for signed-out visitors and at most once a day (`hd_fpv`).
- Overview skeletons now clear on first render (`reconcile` strips them).
- Person timeline was hidden by the activity-tab CSS; device cells wrap
  instead of clipping; profile spacing tidied.

## 2026-09-16 — Log selection, profile v2, Server API v4 (PR #68)

- Alerts & log: click / shift-click / drag to select rows, copy as text,
  mark errors read (localStorage) - read errors leave the badge and strip.
- People profile: identity chips (typed names, linked cookies/fingerprints
  with unlink), meta row, device cards with grouped cells and risk tags.
- Fingerprint Server API v4 (`/v4/events/{id}`, Bearer). Agent calls tag
  each event with the link slug/kind and `linkedId` = signed-in e-mail.

## 2026-09-16 — Fingerprint verdicts (PR #67)

- Hello sends the Pro `event_id`; with `FP_SERVER_KEY` the worker fetches the
  Server API event and stores confidence, OS/browser version, device, city,
  ASN, VPN/proxy/Tor/datacenter, tampering, anti-detect, dev tools,
  high-activity, suspect score and velocity on the device row. Risk flags
  render as red tags in Devices; risky visits warn in the system log.
- Gemini model bumped to `gemini-3.6-flash` (2.5 retired for new keys).

## 2026-09-16 — Gemini + Fingerprint Pro (PR #64)

- Stitch uses Gemini (free AI Studio key, `GEMINI_API_KEY`) when set;
  Anthropic stays as the alternative.
- Fingerprint Pro agent (public key, region `ap`) is loaded first; the
  vendored open-source agent remains the ad-block fallback. CSP allows
  `fpjscdn.net` / `*.fpjs.io`. Visitor ids are now alphanumeric, not hex.

## 2026-09-16 — AI identity stitching (PR #63)

- Nightly (with the 22:45 cron) `src/stitch.js` sends known accounts and
  unsigned visits - OS, browser, screen, timezone, language, places, links,
  times, typed names - to Claude and stores merge *suggestions* with a
  confidence and reason. The People tab lists them with merge / dismiss;
  nothing merges automatically. Needs the `ANTHROPIC_API_KEY` secret.

## 2026-09-16 — Identity, sessions, bans (PR #62)

- **Fingerprint.** Drop and share pages load a vendored FingerprintJS v3
  (MIT) and keep the visitor id in `hd_fp`; events carry it as `p`. A
  fingerprint that ever signed in aliases to that account, so a device that
  clears cookies or opens a no-sign-in link is still recognised.
- **Sessions.** `/api/hello` records one row per device with client details
  (screen, tz, language, platform, browser, cores, memory, touch, network,
  installed-app, referrer). People profiles show them under Devices.
- **Bans.** Block a Google account, device cookie or fingerprint from the
  profile; blocked visitors get 403 on pages, upload sessions and share
  listing/downloads. List + unblock on the People tab.
- **Identify everyone signed in.** A Google session names the uploader/viewer
  even on links that do not require sign-in.
- **Folder alias.** Per-uploader folders are `Name -- Alias`; signed-in
  uploaders get their Google name locked in and only pick the alias.
- **People UI.** Cards are a fixed grid (uploads / views / last seen);
  unsigned visits and blocked entries fold into their own sections; profile
  gets Devices and block buttons.

## 2026-09-16 — People merge (PR #57)

- Admin can merge a device/typed-name profile into a Google account from
  the profile page (and unlink). Stored in a DO `aliases` table.
- Typed names that only one signed-in account has ever used alias to it
  automatically, so a name used on a link without sign-in still resolves.
- E-mail-shaped uploader names on older events count as the account (#54).
- Runner: darktable-cli gets isolated config/cache dirs and its stderr tail
  lands in the skip reason (#55, #56).

## 2026-09-16 — People, alerts, admin motion (PR #53)

- **People tab.** Visitors are stitched into one profile by Google account,
  falling back to a new anonymous `hd_did` device cookie, then the typed
  uploader name. The DO keeps an `identities` table (device → email) so a
  device that signs in later is attributed retroactively on read; nothing
  extra hits KV.
- **Activity** rows say whether they came from a drop link or a share and
  group by the same identity key; sessions link to the person's profile.
- **Alerts & log.** Client errors from drop/share pages now carry stack,
  breadcrumbs (last ~25 actions), a state snapshot (queue counts, online,
  paused, connection type) and land in the system log under `client`; the
  admin gets one e-mail per page per 15 min. The tab shows an alerts strip
  and a nav badge for errors in the last 24 h.
- **Motion.** Pane transitions, staggered list entrance, skeletons on the
  overview/people/logs, stat tick on change; all off under
  `prefers-reduced-motion`.
- **Fixes.** Sidebar lock/status row is a two-column grid so the button no
  longer collapses; `.ico` baseline fixed at the root.
- Diagnostics routes (`/people`, `/person`, `/log`, `/logs`) moved out of
  `live.js` into `live-diagnostics.js` to keep it under 500 lines.

## 2026-09-16 — HDR DNG fallback (PR #52)

- Runner tries `darktable-cli` when libraw and the embedded preview both
  fail - Lightroom HDR-merge DNGs (linear float) in the ARW test folder
  were the case. Reported as `via: darktable`.

## 2026-09-16 — System log, email digests, recurring rules, outcome switch (PR #51)

- **System log** tab (`src/applog.js`): job start/queue/finish/pause,
  every failed file, rule runs, Drive store failures, email attempts.
  Stored in the LiveTracker Durable Object's SQLite (`app_log`, capped at
  3000 rows) - zero KV writes. Filter by area and level, page older.
- **Email digest** (Resend, existing `NOTIFY_*`) when an image job or a
  video-preview run finishes; per-job "email me" toggle.
- **Recurring rules** (`src/images-rules.js`, `images:rules` key): save
  the current sources + recipe as a daily / weekly / monthly rule; the
  worker cron (`45 22 * * *` UTC) plans and starts (or queues) due rules.
  Run now / pause / load recipe / delete from the tab.
- **Switch outcome** on finished copy/archive jobs: copy → archive moves
  originals to `_archive/` and puts the copies in their place; archive →
  copy reverses it. Chunked; per-item `mode` tracked. Replace stays
  final.
- Sources: known share/drop-link folders in a grouped dropdown, recent
  picks as chips, Drive browser opened in the shared picker dialog.
- Drive picker (used by drops, shares and the archive): skeleton rows
  while loading, staggered fade-in, busy state on the clicked row, retry
  on error, "Added" state for folders already picked.
- Resolution / format / metadata are option cards with pixel size, use
  case and caveat instead of bare segmented buttons.
- Trial compare: the "before" pane is the original resampled to the
  output size without recompression, so 1:1 lines up and only encoding
  differs; original dimensions shown correctly.
- Job cards link the GitHub runner log(s) for the job.
- Icons: `.ico` uses `vertical-align: -0.2em` + `display: inline-block`;
  flex parents (buttons, chips, tabs, tools) drop the glyph margin and
  centre with `gap`.

## 2026-09-16 — Image archive v4 (PR #48)

- Flow is now scan → tune → start. `POST /api/admin/images/scan` returns
  compact per-file rows once; the recipe is estimated in the browser
  instantly (impact card, per-folder "will process", per-preset totals).
- Sources: one-click chips for share and drop-link folders; folder tree
  table with per-folder tick boxes (→ `excludeFolderIds`), images / size /
  type badges / already-done counts.
- Recipe: size-target preset, 2 MP step, processing speed 1–8 (runner
  pool; `parallel` in options), protections: skip RAW with `.xmp` sidecar
  (edited in Lightroom/darktable), skip files modified in the last N days,
  largest-first ordering, live regex validation, existing outputs in
  `_compressed` / `_archive` detected by name so re-runs never duplicate.
- **Try it on one photo**: encodes a scanned JPEG/PNG/WebP in the browser
  (largest or random) with a before/after wipe slider and a 1:1 toggle.
- Jobs: queue (start while one runs → queued, auto-started by the
  finishing job's last report), live rate and ETA, **undo** for copy and
  archive jobs (chunked), output-folder links, per-file `via`
  (libraw / embedded preview / libheif) and final quality badges, failed
  filter.
- Runner: worker pool (default 4), per-worker temp dirs, reports `via`,
  `q`, output `parent`.
- `src/images.js` split into planning + `src/images-run.js`.

## 2026-09-16 — Image archive: size target, sturdier runner (PR #46)

- Optional **size target per photo** (Advanced): the runner re-encodes at
  a nudged quality (up to 4 passes) until the file lands within ±30% of
  it - the first test run showed dark/smooth 24 MP frames compressing to
  0.2 MB at q82 while busy ones hit 1.5 MB.
- Runner: a failed batch report keeps its batch and retries (results were
  silently lost before); Drive-hop 502s on PUT retry once with `x-retry`,
  and the worker trashes any copy the first attempt stored, so no
  duplicates. ETA per file now reflects the measured ~6 s.
- Job file list shows in → out sizes.

## 2026-09-16 — Image archive v2 (PR #45)

- Tab rebuilt: three numbered steps on the left (folders, encoding,
  originals) and a sticky plan card on the right with a live "24 MP photo
  becomes ~X MB" sample, the dry-run digest as a before/after bar, and the
  start button. Preset cards, segmented controls for resolution / format /
  metadata, chip toggles for file types, switch toggles, an Advanced fold,
  mode cards with the REPLACE confirmation inside the danger card, job
  cards with progress bars. Scoped `.ia-*` form styles so the global
  48 px input / uppercase label rules no longer apply.
- Fixes from review: `_archive` / `_compressed` mirror the full relative
  path (leaf-name collisions merged unrelated folders); "strip" metadata
  really strips (sharp's `withMetadata()` keeps EXIF) - now `keepIccProfile`
  only; RAW EXIF is copied back from the true original on both the libraw
  and the embedded-preview path; pause and the time budget are checked per
  file, not per batch; start guards a missing plan.

## 2026-09-16 — Image archive (PR #44)

- New admin tab **Image archive** (`src/images.js`, `public/admin-images.js`,
  `scripts/transcode-images.mjs`, `transcode-images.yml`): pick Drive
  folders (browse or paste a link), recursive, presets (Web archive 8 MP
  q82 / recompress only / print-safe 12 MP / smallest AVIF 6 MP), resolution
  cap, quality, format (same / JPEG / WebP / AVIF), metadata (keep /
  strip GPS / strip), skip-under size, exclude regex, per-type toggles
  (JPEG, PNG, HEIC, TIFF, WebP, RAW), only-if-smaller. **Dry run** digest
  from Drive metadata: files, size now → expected, saving, ETA, by type,
  skip reasons, largest files. Modes for originals: copy to
  `_compressed/`, move originals to `_archive/`, or replace in place as a
  new revision (typed `REPLACE` confirmation; Drive keeps the old revision
  ~30 days). Pause (finishes current file) / resume / cancel; the runner
  reports every 8 files; a runner that hits its time budget leaves the job
  paused for resume.
- RAW handling: libraw (`dcraw_emu`) develop → TIFF → sharp; if libraw
  does not know the body (new Sony bodies), the embedded full-size JPEG
  preview is used instead; EXIF copied back with exiftool. HEIC via
  libheif. Every stored file is verified (size, dimensions) before it
  counts as done.
- Video transcoder `pending` now lists the `_previews` folder first and
  repairs the index from it, so a preview that exists in Drive is never
  made twice.
- Workflows on `actions/checkout@v5` + `setup-node@v5` (Node 24 runners).
- `wrangler.jsonc` carries the observability block enabled in the dashboard.

## 2026-09-16 — Video previews admin tab (PR #43)

- New admin tab **Video previews**: totals, per-share/per-folder coverage
  with progress bars, failed files with retry, last 20 runs with per-file
  detail, next scheduled run, active GitHub run link, "Run now" (limit),
  "Process selected" folders, per-folder "process". Polls every 20 s only
  while a run is active.
- KV thrift: everything lives in one key (`previews:index` = files +
  failed + runs + queue). `PUT` no longer writes KV; the Action reports in
  batches of 8 (one write each) and once at the end. The Drive coverage
  walk is memoised in isolate memory, never cached in KV.
- `GITHUB_TOKEN` secret (optional) lets the worker dispatch the workflow
  and read the active run; without it "Run now" queues for the schedule.
- Share viewer shows "optimising…" / "original" next to the controls when
  a video has no preview yet; the drop page's delivered card mentions the
  overnight streaming copy for videos. Trashing an original trashes its
  preview.

## 2026-09-16 — 720p video previews via GitHub Actions (PR #41)

- `src/previews.js` + `.github/workflows/transcode-previews.yml` +
  `scripts/transcode-previews.mjs`: a nightly (or manual) Action asks the
  worker for share videos without a preview, streams each original through
  ffmpeg (720p, H.264 CRF 27, ≤ 2.5 Mbps, faststart) and PUTs the result
  back. The worker stores previews in a private `_previews` folder under
  `DRIVE_PARENT_ID` (outside every shared folder, so "anyone with the link"
  grants never cover them) and keeps `previews:index` in KV. Only
  `ADMIN_TOKEN` leaves Cloudflare (as the `HUSKY_ADMIN_TOKEN` repo secret);
  Google credentials stay in the worker.
- Share listings add `preview`; hover playback and the viewer's first play
  use it. New **HD** button in the viewer controls switches to the original
  at the same timestamp.

## 2026-09-16 — Density slider v2, smooth playback bars (PR #39)

- Gallery density is continuous: 1-9 in quarter steps, tile size
  interpolated between the old nine stops. Mouse wheel over the slider
  nudges a step, double-click resets to Balanced. The text-input focus box
  that leaked onto the range is gone.
- Tile play glyph scales with the tile (`20cqw`, 18-44 px) instead of a
  fixed 40 px that swamped dense grids.
- Hover-preview played bar and the viewer seek bar update from
  `requestAnimationFrame` while playing; `timeupdate` alone fires ~4x/s and
  looked stepped.

## 2026-09-16 — Hot video tiles (PR #38)

- Video tiles actually inside the viewport (second, margin-less
  IntersectionObserver) switch their warm element to `preload="auto"` so the
  opening seconds are buffered before the pointer arrives; capped at 4, off
  under Save-Data, back to `metadata` when scrolled away. The remaining
  hover delay on 4K originals is Drive's ~0.7-1.3 s Range TTFB.

## 2026-09-16 — Media metadata memo (PR #37)

- `driveFileMetaCached`: share media routes (thumbnails, inline/Range
  downloads, file info) memoise Drive file metadata for 2 minutes per
  isolate. Every Range slice of a video was paying a full Drive metadata
  round trip (~400 ms) before the byte fetch; measured TTFB on a 1 MB slice
  was ~1 s.
- Hover preview no longer seeks to 0 on an element that is already at 0.

## 2026-09-16 — Share video efficiency + density slider (PR #36)

- Opening a hovered video in the viewer adopts the tile's already-buffered
  `<video>` (`adoptPreviewVideo`) instead of creating a new element, so the
  clip is not downloaded twice.
- Video tiles near the viewport keep a metadata-only element warm
  (`warmVideoTile`, capped at 12) so hover playback starts without a cold
  fetch; the warm lease is released when the tile scrolls away.
- Shift-scrub issues one accurate seek at a time and applies the latest
  pointer target on `seeked` (was: a `fastSeek` per animation frame, which
  piled up seeks and jumped between keyframes).
- Gallery density is now a bare icon-slider-icon row in the toolbar; the
  value shows as a tooltip over the thumb while hovering/dragging. The
  boxed "Gallery density" card and More/Detail sublabels are gone.

## 2026-09-15 — Trash a delivered upload (PR #35)

- Link detail → upload history → **remove**: moves the file to Drive trash,
  removes it from the history and counters (`DELETE
  /api/admin/uploads/:slug/:fileId`, confirm dialog). Used first to clean the
  verification files the September session uploaded into `temp`.

## 2026-09-15 — share-viewer.js split (PR #34)

- `share-viewer.js` (1.9k) → `share-viewer.js` (open, slide items,
  progressive image, rotation; 343) + `share-viewer-state.js` (`vs` for the
  viewer's reassigned scalars, `viewerChrome`) + `share-viewer-assets.js` +
  `share-viewer-video.js` + `share-viewer-panels.js` + `share-viewer-info.js`
  + `share-viewer-strip.js`. Every `public/` file is now under 500 lines.
  Verified on the fixture gallery: open/nav, video slide, motion + guide
  panels, rotate, asset ladder, strip, mobile dock + More sheet.

## 2026-09-15 — drop.js client split (PR #33)

- `public/drop.js` (1.36k, classic script) → ES modules: `drop.js` (boot,
  gate, main page, pickers, addFiles) + `drop-state.js` (constants,
  collections, and `st` for reassigned scalars) + `drop-queue.js` (upload
  engine) + `drop-render.js` + `drop-live.js` + `drop-resume.js` +
  `drop-report.js` + `drop-utils.js`. Identifier rewrite was tokenizer-aware
  (strings/comments/keys untouched). Verified with real uploads from
  localhost into Drive (5 files, incl. a 3 MB one), pause/offline toggles,
  and the retry/attention path with a stubbed session.

## 2026-09-15 — Live tab + link detail (PR #31)

- Live metric labels and the upload-history table header use the body face
  at 12px (no more 10–11px uppercase mono). Detail page: Copy is the filled
  head action; QR / Drive / Pause stay quiet.

## 2026-09-15 — Home polish (PR #30)

- Headline no longer hyphen-breaks ("original‑quality" is one word; `text-wrap:
  balance`). The visitor CTA is "See how it works"; "Create a drop link" is
  the secondary (owner) action. Feature strip icons use the same tile
  language as the step cards. Footer text passes contrast.

## 2026-09-15 — admin.js client split (PR #29)

- `public/admin.js` (1.7k, classic script) → ES modules: `admin.js` (boot,
  auth, tabs, live socket, stats, event delegation, QR; 570) +
  `admin-state.js` + `admin-chart.js` + `admin-live.js` + `admin-activity.js`
  + `admin-links.js` + `admin-shares.js` + `admin-detail.js` +
  `admin-folders.js`. Same lint contract as the share modules. Dead:
  `staticCard`, an unused `settingsOpen`.

## 2026-09-15 — share.js client split (PR #28)

- `public/share.js` (3.5k lines) → `share.js` (gate, navigation, rendering,
  cards, layout; 950) + `share-state.js` (shared state with live bindings +
  setters) + `share-viewer.js` (PhotoSwipe/Swiper; 1.9k) + `share-preview.js`
  + `share-select.js` + `share-download.js` + `share-beacon.js` +
  `share-utils.js`. Imports are exact (ESLint `no-unused-vars`/`no-undef`/
  `no-import-assign` on the modules, no page globals except public.js
  helpers). Two dead functions found and removed (`waitForVideoDuration`,
  `formatShortDate`).

## 2026-09-15 — Drop/share list cards (PR #27)

- Card order is head → stats → actions; actions are a footer row behind a
  hairline. Stats and meta use the body face at readable sizes (11.5–12.5px,
  no 9.5px uppercase mono). Status pill and budget warning colours pass
  4.5:1 on the glass. Action buttons are 36px tall (44px on touch), have
  focus rings and hover transitions; cards lift their border on hover.

## 2026-09-15 — Lint guard (PR #26)

- `npm run lint` (ESLint 9, `no-undef` / `no-unused-vars` / `no-redeclare`)
  runs first in `npm test`. Every identifier in `src/` and `public/` must
  resolve - the static check that would have caught #22. Cross-checked the
  #16/#18 split by diffing every function name in the pre-split files
  against the tree: all present (live.js ones under their new class names).
- Found by the linter: the create-drop-link error path referenced an
  undefined `button` and threw instead of showing the API error.

## 2026-09-15 — Admin overview pass (PR #24)

- Stat tiles: auto-fit grid (6 across on wide, 3×2 at 800px, 2 at phone),
  sentence-case body-face labels, one visual weight (the "Data received"
  accent tile is gone). Page titles are solid ink; gradient text is reserved
  for brand and CTAs.
- Activity rows lead with the action ("Browsed gallery") and put the actor
  and link in the subline; unknown `drop-*`/`share-*` types get a readable
  fallback instead of "Activity".
- Link/share cards: Details/Edit is the one filled button, Delete is quiet
  text at the far end until hovered, labels in the body face.
- Icon rail (901–1080px) hides the brand wordmark properly.

## 2026-09-15 — Drop page v4 (PRs #22–#23)

- **#22 hotfix.** `notifyEmail` import lost in the #18 split; every progress
  tick on links with start emails threw in the background relay. Smoke test
  now fails on programming errors surfaced via `console.error`.
- **#23 drop v4.** One column, one rhythm: header (collector / label /
  one-line facts instead of chips) → flow card (name with a live tick, then
  the dropzone with explicit "Choose files / Choose a folder" buttons) →
  transfer card → done card → footer (trust line + report). Once files are
  queued the dropzone yields to a slim "Add files / Add folder" row. Row
  errors are humanised (`humanError`): connection dropped, budget reached,
  server hiccup, link closed - never a stack-trace fragment; retry countdown
  carries the reason. Drive resumable sessions are minted for the browser's
  `Origin` header (under `wrangler dev` request.url carries the route host,
  so local uploads failed CORS).

## 2026-09-15 — Drop/share states (PRs #20–#21)

- **#20 hotfix.** `chip()` on the drop page still used retired icon names and
  threw after #19; audit test now fails on retired names at icon call sites.
- **#21 states.** Drop page: one `#gate` card renders loading (skeleton
  title), closed (404 / expired / paused / budget / offline / 5xx, each with
  its own copy, tone and a way back), Google sign-in and PIN (masked input
  with eye toggle, `one-time-code` autocomplete, checking state, shake +
  inline error on a wrong code, lockout countdown, 410/403 escalate to the
  closed card). Topbar pill is a real status: `checking / secure / live /
  paused / offline / closed` (the double dot came from `::before` plus a
  stray `<i>`). Offline is handled: uploads pause, a notice shows, and on
  `online` failed files re-queue and the pump resumes. `body[data-phase]`
  (ready / uploading / paused / offline / attention / done) compacts the
  dropzone while a transfer runs and colour-codes the transfer panel; step 1
  ticks once a name is entered. Share page: loading spinner, back link on
  the closed card with per-cause copy, "Continue with Google" wording shared
  with the drop page, folder-only roots get an "open a folder" hint. Admin:
  901–1080px uses an icon rail instead of a wrapped header block. Viewer:
  asset-ladder pill moves under the top bar below 1100px.

## 2026-09-15 — One icon system (PR #19)

- Every icon is now a Lucide stroke glyph from `public/icons.svg`, referenced
  as `<svg class="ico"><use href="/icons.svg#name"/></svg>` (HTML) or
  `uiIcon(name)` (JS). The sprite is generated by `npm run icons` from the
  `UI_ICON_NAMES` catalog in `public/public.js` via `lucide-static` (dev dep).
- Gone: ~40 hand-drawn fill glyphs with opacity backplates, 55 inline
  `<svg>` blocks across the HTML pages, `STAT_ICONS` markup, `.ico-fill` /
  `.duo`. The `file`=`image` and `shield-alert`=`alert` copy-paste bugs died
  with them. Token field eye toggles eye/eye-off; drop-page loading glyph spins.
- `scripts/icon-audit-test.mjs` now enforces: sprite == catalog, no inline
  glyph paths outside charts/rings, every referenced name exists.

## 2026-09-15 — Realtime feed + auth hardening (PRs #12–#16)

- **#12 auth.** HMAC keys no longer fall back to a constant when
  `ADMIN_TOKEN` is unset (`requireSecret` throws). Admin Google sign-in
  requires `ADMIN_TOKEN`; `email_verified` is enforced; Google failures are
  logged with status + body.
- **#13 worker hot path.** `/api/progress` and `/api/opened` ack before the
  Durable Object relays run (`ctx.waitUntil`, concurrent). No KV read per
  progress tick when the DO is configured. `sessionId` is required on
  `/api/progress` and `/api/session`. Drive quota preflight cached 30 s per
  isolate. `/api/drop/track` writes in one wave.
- **#14 LiveTracker.** Admin sockets get coalesced `patch` deltas instead of
  a full snapshot per tick; sorted snapshot cached. Hibernatable WebSockets
  (`state.acceptWebSocket`, attachment carries the session id);
  `recentDone` persisted; wake sends a fresh snapshot. Rate limiter evicts
  only expired buckets; folder-id cache TTL 6 h; `/events-days` one query.
- **#15 admin lists.** Link/share records read with `Promise.all`.
- **#16 split.** `live.js` (960 lines) → `live.js` + `live-analytics.js`
  (SQLite tables) + `live-digest.js` (`DigestQueue`), per the 500-line rule.
- **#18 split.** `share.js` (1434) → `share.js` / `share-admin.js` /
  `share-token.js` / `share-media.js` / `share-zip.js`; `worker.js` (1113) →
  `worker.js` / `drop-api.js` / `admin-api.js`; `live.js` hands completions
  to `live-completions.js` (`CompletionQueue`). Every `src/` file is now
  under 500 lines. `shareSigningKey` gets the same fail-loud secret rule as
  `auth.js` (it still had the `"dev"` fallback).

## 2026-09-15 — Housekeeping

- Repository trimmed to a single `main` branch on GitHub. All September
  feature branches merged and deleted; stale `codex/*` branches and their
  worktrees removed (their content was already in `main` under rebased
  hashes).
- Clerk viewer-auth experiment dropped for good. Viewer sign-in on `/d/` and
  `/s/` stays Google OAuth (`src/auth.js`). Nothing Clerk-related remains in
  the tree; `.dev.vars` / Worker secrets may still hold unused `CLERK_*`
  keys that can be deleted.
- `graphify-out/` (generated knowledge graph) is git-ignored.
- Workflow from here on: branch → PR → CodeRabbit review (`coderabbit review
  --agent --base main`, installed in WSL) → merge → GitHub integration deploys
  the Worker. `npm run deploy` is not part of the loop.

## 2026-09-14 → 15 — Reliability round (PRs #1–#9)

Triggered by: no emails for finished uploads, the upload page stuck on
"Uploading", 2–3 MB/s on a gigabit link, and admin tabs lost on refresh.

- **#1 Emails decided server-side.** The finished-upload digest used to fire
  only when the uploader's browser sent a WebSocket frame with `state: done`.
  `LiveTracker.flushDigests` now decides from Drive-verified `/api/complete`
  calls (8 s settle after done, 90 s idle otherwise). Google account name
  beats the typed name when sign-in is required.
- **#2 One-file-per-second bug.** Every `/api/session` resolved the
  uploader's Drive folder through a per-uploader lock in the Durable Object
  and then re-read a KV cache that had not propagated. `resolveFolderOnce`
  memoises folder ids in DO memory. Client: prefetch a Drive session for
  every open slot, chunks grow at >4 MB/s, `/api/complete` retries, queue
  title counts Drive-saved files as delivered.
- **#3 Admin routes.** `/admin/<tab>` and `/admin/links/<slug>` are real
  URLs; refresh and back keep the tab. Sign-in check is `GET /api/admin/me`
  instead of the full overview (the 3–5 s stall). Overview KV reads run in
  parallel.
- **#4 Drop/share UX.** PIN inputs are `type=text` masked with CSS so
  password managers stay quiet; number pad only for all-digit codes
  (`pinDigits`). Per-uploader-folder links hide the folder picker and flatten
  dropped trees.
- **#5 Overview wording + person timeline.** Plain-English labels
  everywhere; Activity groups one card per person per day across drops and
  shares.
- **#6 Informative emails.** Shared `notifyEmail()` layout: headline, facts,
  file list, dashboard button. Subjects no longer start with "LostHusky's
  DropBox:" — Gmail was soft-bouncing (`550-5.7.1 likely unsolicited`) on the
  Dropbox look-alike subject and two-line body; all delivered since. No DMARC
  needed. Retries carry an `Idempotency-Key`.
- **#7 Saturate fast links.** `pump()` capped bytes in flight at
  `concurrency × chunkSize`, so once chunks grew to 128 MB only 2–4 files ran.
  Parallelism is now a file count (≤12 desktop, ≤8 mobile) under a memory
  window. Queue uploads in folder/natural-name order; finished rows fade in
  place; keep-open banner and Pause hide when everything landed; started
  email says how much is queued; admin "Refresh snapshot" re-arms the socket.
- **#8 Drive picker.** Root crumb no longer duplicated ("My Drive / My
  Drive"), path wraps so the current folder is visible, last six folders
  offered as chips, "Share this drop's folder" button after creating a drop
  (`POST /api/admin/links/:slug/folder`).
- **#9** `docs/STATUS.md`.

Measured: 44 GB / 595 files from a Windows desktop in ~13 min (~56 MB/s avg,
peaks 86 MB/s) versus 2–3 MB/s before.

## 2026-08-11

- `DRIVE_PARENT_ID` moved from a Worker var to a secret.

## 2026-07-14 → 15 — Mobile and viewer hardening

- Local fixture server for share pages (`npm run dev:fixtures`) with
  deterministic media, so the gallery can be developed without Drive.
- Mobile responsive contracts for home, legal, drop, auth and admin pages;
  mobile viewer controls, smart gallery toolbar, two-phase blur slide
  transitions, ranged video streaming, viewer continuity fixes.

## 2026-07-09 → 13 — UI v3

- Full redesign of homepage, admin (unlock, overview, live, drop links,
  detail, activity, share links) and the public uploader; icon fidelity
  audit; Microsoft Clarity + inline-script CSP nonce.

## 2026-07-06 — v2

- transfer.zip-inspired feature set: speed engine (adaptive concurrency,
  resumable Drive sessions, folder upload), outbound share links (gallery +
  redirect modes, PIN, Google sign-in gate, ZIP), analytics, Cloudflare Web
  Analytics beacon, custom domain routing, API/security docs.

## 2026-06-24 — UI 2.0

- Light glassmorphic theme (Unbounded + Plus Jakarta Sans) replacing the dark
  amber theme; all JS hooks preserved.

## 2026-06-12 — v1

- Initial build: Cloudflare Worker control plane, KV metadata, Durable Object
  live progress, browser-to-Drive resumable uploads, PIN-protected drop
  links, admin dashboard, Resend notifications.
