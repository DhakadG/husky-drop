# Review — `admin-overview`

_agent review (surface) · 2026-09-23_

> A tidy landing tab that renders fast and degrades quietly, but it only describes the drop side: the share half of the product (opens, downloads, bytes served) is invisible here even though the overview payload already carries it. Worse, the 30-day chart silently mixes share downloads into 'Data received' and share opens into 'Link opens', so the chart and the stat cards above it disagree.

## Findings

### HIGH · Stop counting share downloads as 'Data received' in the chart

**Where:** src/live-analytics.js:222 (bumpDay(`share:${slug}`)) + src/live-analytics.js:260-270 (timeseries sums every slug) + public/admin-chart.js:16 · **Category:** correctness · **Confidence:** 0.85

**When:** A guest downloads a 4 GB ZIP from a share link; bumpShareStat records {bytes: 4 GB, opens, downloads} into day_stats under slug 'share:<slug>', and timeseries() sums all slugs with no filter.

**Result:** The 'Data received' bar for that day shows 4 GB that nobody uploaded, and 'Link opens' counts gallery visits; the stat cards directly above (drop-only totals from KV) show different numbers, so the admin cannot trust either.

**Fix:** In timeseries(), return two groups: drop metrics (opens, sessions, files, bytes) from rows WHERE slug NOT LIKE 'share:%', and share metrics (shareOpens, downloads, servedBytes) from rows WHERE slug LIKE 'share:%'. Apply the same split to the pendingDays fold-in. Point the chart's 'Downloads' chip at the share series and add a 'Share opens' chip.

### MEDIUM · Make unlock() idempotent so re-sign-in does not double every poller

**Where:** public/admin.js:253-263 and 320-324 · **Category:** correctness · **Confidence:** 0.8

**When:** The admin session cookie expires while the dashboard is open; refreshAll() gets 401 and shows the token screen; the admin signs in again and tryToken() calls unlock() a second time.

**Result:** A second set of setInterval timers starts: overview polled every 7.5 s effectively, tickLive re-renders twice a second, the chart refetches twice; each further re-login adds another set until the page is reloaded.

**Fix:** Keep module-level `let unlocked = false`; in unlock() do the show/hide and routeFromUrl every time but only start the three setIntervals (and connectLive) when !unlocked, then set unlocked = true.

### MEDIUM · Show the share side on the landing tab

**Where:** public/admin.js:453-488 (renderStats) · **Category:** missing-feature · **Confidence:** 0.8

**When:** The admin opens /admin to see how a gallery sent to a client yesterday is doing.

**Result:** Nothing on Overview mentions shares at all; they must open the Shares tab and scan every card. overview.shares already carries opens, downloads, bytes and viewers per share.

**Fix:** Add stat cards 'Gallery opens', 'Downloads' and 'Data served' summed from overview.shares[].stats in renderStats(); no server change needed.

### MEDIUM · Pause the 15-second overview poll when the page is hidden

**Where:** public/admin.js:260 and 317-336 · **Category:** cost · **Confidence:** 0.75

**When:** The admin leaves /admin open in a background tab overnight.

**Result:** Every 15 s the Worker reads every link:*, stats:*, share:*, sstats:* key plus share-index state and three Durable Object queries - several thousand KV reads per hour per forgotten tab, for a view nobody is looking at; the live WebSocket already pushes the only fast-changing part.

**Fix:** In refreshAll() return early when document.hidden, and add a visibilitychange listener that calls refreshAll() when the tab becomes visible again.

### LOW · Make the headline stat cards navigate

**Where:** public/admin.js:464-487 (stat cards) · **Category:** interlinking · **Confidence:** 0.7

**When:** The admin sees 'Files received 1,204' and wants to see what arrived.

**Result:** The cards are inert divs; the admin has to find the right tab by hand.

**Fix:** Render each card as a button with data-goto-tab (links -> 'links', opens/sessions/files/received -> 'activity' with the matching activity filter, drive free -> 'links'), reusing the existing handleAdminAction goto branch.

## Layout

- Put 'Live now' above the 30-day chart when liveActive is non-empty - an upload in progress is the most time-sensitive thing on the page and currently sits below the fold on a laptop.
- Split the stat grid into two labelled rows, 'Received' (drop links) and 'Shared' (share links), so the chart chips can follow the same split.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Share totals on Overview | Half the product is share links; the landing page says nothing about whether anyone opened or downloaded a gallery. | Overview stat grid | small | already available (overview.shares[].stats) |
| Click a chart bar to see that day's activity | A spike on the chart raises 'who was that?' and the only answer is scrolling the Activity tab by date. | Overview 30-day chart | small | /api/admin/events?before=<day+1>&days=1 already exists |
| Drive usage as a proportion, not just 'space left' | 'Drive space left 1.2 TB' says nothing about how close to full the account is; overview.quota already has limit and usage. | Overview 'Drive space left' card | small | already available (overview.quota.limit/usage) |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Overview 'Drop links' stat card | Drop links tab | the number is a list the admin will want to open |
| Overview 'Files received' / 'Data received' cards | Activity tab filtered to uploads | saves finding the filter by hand |
| Overview chart bar | Activity tab scoped to that day | explains a spike in one click |
