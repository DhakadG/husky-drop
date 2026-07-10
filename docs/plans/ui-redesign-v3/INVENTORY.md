# UI 3.0 Redesign — Feature & Layout Inventory

Diff of the redesign mockups (`docs/Personal Dropbox UI Redesign/redesign-package/`) against the current production code. Source of truth for visuals: the eight `*.dc.html` mockups + `PLAN.md`. This inventory drives the plan files in `plans/`.

**Architecture constraint (applies to every admin plan):** the live app serves ONE admin page (`/admin` → `public/admin.html` + `public/admin.js`). Tabs (Overview / Live transfers / Drop links / Share links / Activity / New drop link / hidden Link-detail) are `<section id="tab-*" class="tab-pane">` panes switched by `showTab()` (`admin.js:97`) via sidebar `<button class="tab" data-tab="…">`. The mockups draw admin as five separate pages with a shared sidebar — the plans map each mockup page onto its existing tab pane. The shared admin shell (sidebar, background, header chrome) is changed exactly once (plan 03); plans 04–07 must not repeat shell markup.

---

## Table 1 — Visual/layout changes per page

Design tokens used throughout (defined once in plan 00): fonts **Unbounded** (display/numbers) / **Plus Jakarta Sans** (body) / **Spline Sans Mono** (meta/labels — all three already loaded); colors `#2f6bff` primary, `#15c0c9`/`#0e9aa7` teal, `#7b6bff` violet, `#1fb27a` success, `#d98a14` warning, `#f0556b` danger, ink `#0c1a2b`, secondary `#43566b`, muted `#6b7c91`/`#9aa8b8`; signature gradient `linear-gradient(120deg,#2f6bff,#15c0c9)`; glass cards `rgba(255,255,255,.6–.68)` + `backdrop-filter:blur(12–14px)` + `0 24px 60px -34px rgba(20,60,120,.5)`; animated background = base gradient `#f4f8fe→#e5edf9` + 2–3 blurred radial blobs (18–26s loops) + 26px dot grid masked to top + SVG fractal-noise at 5% multiply; gradient text via `background-clip:text`; duotone SVG icons (solid shape + 14–20% opacity backplate); rotated (−6°) droplet logo.

| Page (current file) | Mockup | Layout change |
|---|---|---|
| Homepage (`public/index.html`) | `Home.dc.html` | Marketing page rebuilt: topbar → logo + single "Admin" pill; hero becomes 2-col grid (gradient headline + CTA pair + check-chips ⁄ floating −6°-rotated mini drop-card visual with fake progress rows); `.home-console` stats panel removed; sections become "Three steps" 3-card row, 4-up feature strip, slim footer. New animated blob/dot-grid/noise background replaces flat body background. |
| Admin unlock (`#auth` panel in `admin.html`) | `Admin Unlock.dc.html` | Centered gradient-border hero card (2px gradient wrapper) with lock icon tile, "Unlock dashboard" heading, mono-labeled password field with show/hide eye toggle, gradient Unlock button, rate-limit shield notice, "← back to home" link. Keeps the existing dual auth (Google button + token field) and element IDs admin.js binds to (`#admin-google`, `#tok`, `#login`, `#auth-err`). |
| Admin · Overview (`#tab-overview`) | `Admin Overview.dc.html` | Sidebar restyled (logo, gradient active item, live count badge, lock/logout at bottom); content = gradient page title, 6 stat cards (links/opens/sessions/files/**bytes-received accent card**/drive-free) with duotone icon tiles, "Last 30 days" chart card with metric-toggle chips (bytes/files/opens/sessions/downloads) + 30-bar CSS chart + busiest-day tooltip, then two-up "Live now" (avatar rows, progress bars, speed/ETA) and "Recent activity" (5 person-first rows with type icons) cards. |
| Admin · Activity (`#tab-activity`) | `Admin Activity.dc.html` | Flat event list → **day-grouped expandable session timeline**: filter chip bar (all/uploads/opens/views/downloads/errors) + person/link search; day divider pills ("Today · Jul 10" + counts); session cards (avatar, person · link, email · time range · device · geo, count chips, chevron) that expand into a gradient-spine vertical timeline of events; error sessions get red styling; "load earlier days" button. |
| Admin · Drop links (`#tab-links`) | `Admin Drop Links.dc.html` | Table (`#rows` tbody) → stacked **link cards**: title (→ detail), status chip (open/PIN/expired), mono meta line (`/d/slug · expires · N× parallel · N MB chunks · per-uploader folders`), icon action row (copy/QR/Drive folder/pause/delete/detail), 4 stat tiles incl. **budget progress tile** (∞ or amber % bar); dimmed condensed "Expired · N" group with re-open action. New-link CTA button in header. |
| Admin · New drop link (`#tab-create`) | `PLAN.md` §2 (not mocked) | Create form → 2-step flow: (1) label + destination folder, (2) collapsed optional protections (PIN, expiry, size budget, parallelism preset simple/fast/aggressive); success state shows big `/d/slug` preview + copy + QR. Label is the only required field; Enter submits from step 1. |
| Admin · Link detail (`#tab-detail`) | `Admin Link Detail.dc.html` | Detail view → breadcrumb ("Drop links / <label>") + gradient title + status/slug chips + icon actions; 4 stat cards (accent on bytes); two-up "Top uploaders" (share-of-total bars) and "Live now" (dashed empty state); upload-history card with filter input + sort toggle + grid table (file/uploader/size/uploaded/open) + "show all N"; **settings accordion** (Access expanded; Transfer, Budgets, Notifications, Branding & promo collapsed with summary lines); footer Save/Clear-password/Delete. |
| Admin · Share links (`#tab-shares`) | `Admin Share Links.dc.html` | Table (`#share-rows`) → **share cards**: label + mode chip (`gallery · PIN · Google sign-in`), mono meta (slug · folders · closes-in), icon actions, 4 stat tiles (opens / **unique viewers** / **file views** / bytes downloaded), **recent-viewers avatar chip row** + "view activity →"; create form gets a Gallery-vs-Redirect radio-card mode selector and toggle chips (zip, require sign-in). |
| Admin · Live transfers (`#tab-live`) | `PLAN.md` §1 (not mocked) | Sticky summary strip (active sessions · combined throughput · Drive write rate); one large card per session: avatar, uploader → link, overall ring %, per-file rows, **60s speed sparkline**, ETA; dashed empty state + last-completed summary; "Finished this hour" list of completed sessions. |
| Drop page (`public/drop.html` + `drop.js`) | `Drop Page.dc.html` + `PLAN.md` §4 | Admin-centric → uploader-first: topbar logo + pulsing "secure drop" pill; hero card "**<owner> is collecting**" (gradient eyebrow) + title + 3 info chips; numbered Step 1 name tile (keeps `#who` gate); Step 2 = gradient-border hero dropzone; transfer queue card with **circular SVG progress ring**, striped animated total bar, amber reassurance banner, per-file state rows (done/active/queued/**error + retry**), "show all N files"; 3-card trust strip; "Report a problem" footer. Edge states styled: locked (PIN card), expired/paused notice, done recap card, budget-hit amber notice. |

Not in scope for this plan set: the `/s/` share-gallery visitor page (PLAN.md §3) — not in MIGRATION-PROMPT's plan list; future plan set under `docs/plans/`.

---

## Table 2 — New features requiring FRONTEND work only

Everything here is fully served by existing endpoints/data; the work is markup/CSS/JS rendering.

| Feature | Where | Existing data source |
|---|---|---|
| Stat-card grids (overview, link detail, share cards) | 03, 06, 07 | `GET /api/admin/overview` totals (`worker.js:723`), `GET /api/admin/link/:slug` (`worker.js:707`); per-link `stats:{slug}` `{opens,sessions,files,bytes}` |
| Drive-free-space stat card | 03 | `overview.quota.{limit,usage,free}` (`worker.js:748`) |
| 30-day chart + metric toggle chips + busiest-day label | 03 | `GET /api/admin/timeseries?days=30` → `{day,opens,sessions,files,bytes,downloads}` rows (`worker.js:754`, DO SQLite `day_stats`); busiest day computed client-side |
| Live-now cards with per-file rows, %, speed, ETA | 03, 04→06, live tab | Admin WebSocket `GET /api/admin/live` snapshot; sessions already carry `{uploader,label,sent,total,pct,count,done,speed,eta,files[],state}` (`util.js:368`) |
| Combined throughput / active count in live summary strip | live tab (03's shell badge too) | Sum of `session.speed` over snapshot, client-side |
| Budget progress bars + auto-pause chip | 05, 06, 08 | `settings.maxTotalBytes/maxTotalFiles/maxSessions` (0 = ∞, `util.js:313`) vs `stats.*`; auto-pause already sets `disabled`+`disabledReason` (`worker.js:453-470`) |
| Link meta line "N× parallel · N MB chunks · per-uploader folders" | 05, 06 | `settings.concurrency`, `settings.chunkMB`, `settings.perUploaderFolders` (`util.js:304-310`) |
| Settings accordion (Access/Transfer/Budgets/Notifications/Branding) | 06 | All fields exist: link record `label/pin/expiresAt/settings/notify/theme` (`worker.js:627-641`, `util.js:301,319,341`) |
| Top uploaders with share-of-total bars | 06 | Aggregate client-side from `GET /api/admin/uploads/:slug` recent metas (`u`,`s` fields, cap 200) — mockup itself says "in recent history" |
| Filter chips + person/link search on activity | 04 | Client-side filtering of event fields `t/u/l/s` |
| Session grouping of events (day → session cards → timeline) | 03, 04 | Client-side grouping: events already carry `si` sessionId, `u` identity, `c:{o:os,l:location}` device/geo (`util.js:286`); rollup events (`share-browse`, `file` "N files") already exist |
| Error rows in activity | 04 | `clienterror` events (name/message in `m`, `worker.js:592`); plus `autopause`/`lock`/`global-lock` |
| Copy + QR buttons | 05, 06, 07 | Already implemented (`showQr`, `qrcode.min.js`); restyle only |
| Show-all toggles, expired-links group, hover states, duotone icons, gradient buttons | all | Pure markup/CSS |
| Uploader-name step, per-file progress/retry, resume banner | 08 | All wired in `drop.js` (name gate `pickerGate`, per-file XHR progress, IndexedDB resume, adaptive chunks); restyle + progress-ring markup only |
| Drop-page edge states (locked/expired/done/budget) | 08 | States already returned by `GET /api/link/:slug` (`state`, `requiresPin`) and 413 budget responses; currently minimally styled |
| 2-step new-link flow + success QR | 05 | `POST /api/admin/links` accepts all fields today; success payload includes slug |
| Mobile: sidebar → bottom tab bar, stat grids → 2 col, tables → stacked cards | all admin plans | CSS only (the sidebar is the existing `.tab` button list) |

---

## Table 3 — New features requiring BACKEND work

Every mockup feature with **no existing backend support**. None of these may be faked in the frontend; each has a full sub-plan (route handlers, storage, consuming fetch calls) in `plans/09-backend.md`.

| # | Feature | Mockup | What's missing | Route / payload contract | Source and storage |
|---|---|---|---|---|---|
| B1 | **Live speed sparkline (last 60s)** | PLAN.md §1 Live transfers | DO session keeps only current EWMA `speed` | Existing admin WS snapshot adds `active[].speedHist: Array<{t:number,bps:number}>`; no new route | `LiveTracker.recordSession()` samples the real session byte delta; in-memory ring capped at 50 (~60s) |
| B2 | **Finished this hour + last-completed** | PLAN.md §1 | Done/stale sessions disappear | Existing admin WS and internal `/snapshot` add `recent: Array<{id,slug,label,uploader,files,bytes,duration,endedAt}>` | `LiveTracker.recentDone`, cap 20, pruned after 60 minutes; sourced when real state first becomes `done` |
| B3 | **Unique/recent share viewers + file views** | Admin Share Links | `sstats:{slug}` lacks views/viewer aggregation | Existing `GET /api/admin/shares` adds `stats.views:number`, `viewerCount:number`, `recentViewers:Array<{email,name}>`; existing `/share-stat` body adds `views` and `viewer` | KV `sstats:{slug}` becomes `{opens,downloads,bytes,views,viewers:{email:{n,at}}}`; DO batches writes; identity comes from verified viewer auth |
| B4 | **Activity beyond 200 events** | Admin Activity | Rolling `events:recent` has no pagination | New admin-gated `GET /api/admin/events?before=YYYY-MM-DD&days=3` → `{days:Array<{day,events}>,oldest}` | KV `events:day:YYYY-MM-DD`, max 200/day, 90-day TTL; written by existing `mergeEventsKV()` flush path |
| B5 | **Drive folder picker** | PLAN.md §2 | Only raw folder ID/URL input exists | New admin-gated `GET /api/admin/drive/folders?parent=<id>` → `{folders:Array<{id,name}>}` or `{error}` | Google Drive `files.list` using the existing access-token helper; no cached/sample folder data |
| B6 | **First open of a share** | Admin Activity | Events do not distinguish first identified open | Existing share-open event uses `m: "first open"` only when the verified email is absent from the B3 viewer map | Derived from persisted `sstats:{slug}.viewers`; consumed by Activity timeline copy |
| B7 | **Drive write rate** | PLAN.md §1 | No independent Drive-side telemetry | No backend change: UI labels `sum(active[].speed)` as both combined throughput and current Drive write rate | Same real live progress byte deltas used by B1; the UI does not invent a second number |
| B8 | **Pause/resume surfaced to admin** | Drop page + Live tab | Live DTO lacks pause state | Existing uploader WS progress body adds `paused:boolean`; existing admin snapshot returns `active[].paused:boolean` | Client queue state, normalized by `normalizeLiveSession`; no KV write |
| B9 | **Collector display name** | Drop Page (“Ghanishth is collecting”) | Public DTO has no owner identity | Existing `GET /api/link/:slug` adds `ownerName:string` | Non-secret `OWNER_DISPLAY_NAME` Worker variable, sanitized to 60 chars; blank means generic frontend copy |
| B10 | **Budget-hit vs manual pause on initial load** | PLAN.md §4 | Public DTO exposes only `paused` | Existing `GET /api/link/:slug` adds `budgetHit:boolean` | Derived server-side from the three fixed `disabledReason` values; arbitrary internal reason text is not exposed |

Everything else the migration prompt flagged for checking — session-grouped activity fields, per-link stats aggregates, 30-day series, uploader names, size budgets with auto-pause, viewer identity, error events, drive free space — **already exists** (see Table 2 sources).

---

## Plan index & dependency order

| Plan | Targets | Depends on |
|---|---|---|
| `00-design-tokens.md` | `public/style.css` (tokens, background, glass, buttons, icons, logo, chips) | — |
| `09-backend.md` | `src/live.js`, `src/store.js`, `src/util.js`, `src/worker.js`, `src/share.js`, `src/drive.js`, `wrangler.example.jsonc` | — |
| `01-index.md` | `public/index.html`, style.css home sections | 00 |
| `02-admin-unlock.md` | `public/admin.html` `#auth`, style.css | 00 |
| `03-admin-overview.md` | `public/admin.html` (shell + `#tab-overview` + `#tab-live`), `public/admin.js`, style.css | 00, 09(B1,B2,B8) (shell change lives ONLY here) |
| `04-admin-activity.md` | `#tab-activity`, `admin.js` events rendering | 00, 03, 09(B4,B6) |
| `05-admin-drop-links.md` | `#tab-links` + `#tab-create`, `admin.js` links rendering | 00, 03, 09(B5) |
| `06-admin-link-detail.md` | `#tab-detail`, `admin.js` detail rendering | 00, 03 |
| `07-admin-share-links.md` | `#tab-shares`, `admin.js` shares rendering | 00, 03, 09(B3) |
| `08-drop-page.md` | `public/drop.html`, `public/drop.js`, style.css | 00, 09(B8,B9,B10) |

Execution order = table order. Plans 04–07 assume 03's shell is applied and reference it only by selector (`.tab[data-tab=…]`, `#tab-…`).
