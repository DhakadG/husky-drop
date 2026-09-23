# Review — `admin-activity-people`

_agent review (surface) · 2026-09-23_

> The richest surface in the admin: per-person timelines, device verdicts, bans and AI-suggested merges. Three things undercut it: fingerprint bans are stored lowercased and never match the mixed-case visitor ids they are meant to block, the Activity tab cannot reach today's events beyond the newest 60, and the client computes person keys without the server's aliases, so 'profile' links dead-end for anyone who was merged.

## Findings

### HIGH · Stop lowercasing fingerprint ids when storing a ban

**Where:** src/identity.js:153 (value lowercased) + src/identity.js:86 (exact match) + src/util.js:298-301 · **Category:** security · **Confidence:** 0.85

**When:** Admin clicks 'block fingerprint' on a device whose FingerprintJS visitor id is 'aB3dE5...' (fpFrom accepts [A-Za-z0-9]).

**Result:** adminBans stores 'ab3de5...', isBanned compares value = 'aB3dE5...' exactly, so the device is never blocked; the profile card also shows it as not blocked. The admin believes an abusive visitor is locked out when they are not.

**Fix:** Lowercase only for kind === 'email' in adminBans (device ids are already lowercase hex); add a smoke-test case that bans a mixed-case fp and expects bannedRequest to return true.

### MEDIUM · Make 'Drop links used' and 'Shares viewed' open that link, not just the tab

**Where:** public/admin-people.js:31-32 + public/admin-people-profile.js:89-90 · **Category:** interlinking · **Confidence:** 0.9

**When:** On a profile, the admin clicks the drop link 'Wedding uploads' this person used.

**Result:** The button carries data-goto-link=<slug> but the handler ignores it and shows the Drop links list; the admin has to find the card again. Same for shares.

**Fix:** Call refreshDetail(slug, true) for data-goto-link; for data-goto-share, showTab('shares') then scroll to and highlight the card with that slug (or open its editor).

### MEDIUM · Let the Activity tab load all of today, not just the newest 60 events

**Where:** public/admin-state.js:70 + public/admin-activity.js:239 + src/live-analytics.js:93-100 + src/admin-api.js:285 · **Category:** correctness · **Confidence:** 0.75

**When:** A busy day: a guest browses a share (dozens of share-view/share-browse events) and 60 events are reached by early afternoon.

**Result:** Overview supplies recentEvents(60); 'Load earlier days' asks for before=<today>, which is exclusive, so today's events older than the 60th are never fetched - the morning's uploads simply are not in the Activity tab, CSV export or People-from-activity view, and every 15 s refresh pushes more out.

**Fix:** Initialise activityOldestDay to tomorrow's date (so the first 'Load earlier' includes today), or fetch /api/admin/events?before=<tomorrow>&days=1 when the Activity tab first opens, and de-duplicate by eventKey as loadEarlierActivity already does.

### MEDIUM · Resolve Activity person keys with the same aliases the People tab uses

**Where:** public/admin-activity.js:27-35 vs src/people.js:71-79 + public/admin-people.js:59-62 · **Category:** interlinking · **Confidence:** 0.75

**When:** An anonymous device was merged into jane@example.com (manual merge, accepted suggestion, or a typed name unique to one account); the admin clicks 'profile' on one of its Activity cards.

**Result:** The client key is device:<id> while the server folded that device into email:jane@...; openPerson() finds no match and returns silently, leaving the admin on the People list. The Activity 'people' count and People-view table also split one person into several rows.

**Fix:** Return the alias map with /api/admin/people (or have /events attach the resolved person key as `k` on each record, as withIdentity already attaches `e`) and make personKeyOf prefer it; in openPerson, fall back to a search box pre-filled with the key's label instead of returning silently.

### LOW · Check the merge and stitch responses before refreshing

**Where:** public/admin-people.js:88-98 · **Category:** ux · **Confidence:** 0.75

**When:** Admin clicks 'merge' on a suggestion while the DO is unavailable, or 'run now' when the model returns 503 twice.

**Result:** decideSuggestion ignores the merge result and then deletes the suggestion anyway, so a failed merge loses the suggestion; runStitch shows nothing on {error: 503}.

**Fix:** In decideSuggestion only DELETE the suggestion when the merge returned ok; in runStitch alert d.error when present.

### LOW · Tell the admin when a day was truncated at EVENT_CAP

**Where:** src/live-analytics.js:104 · **Category:** correctness · **Confidence:** 0.7

**When:** A day with more than 200 activity events is loaded via 'Load earlier days'.

**Result:** eventDays silently drops everything past the newest 200 for that day; the Activity tab presents the day as complete.

**Fix:** Return truncated: true per day when the cap was hit and render 'showing latest 200 of this day' in the day header.

## Layout

- Put 'Suggested merges' below the people grid when it is empty - the empty-state paragraph currently sits above every person.
- Collapse the Activity toolbar filters (kind, person, link, days, sort) into one row with the view switcher; today they push the first event below the fold on a laptop.

## Missing features

| Feature | Why | Where | Effort | Needs |
| --- | --- | --- | --- | --- |
| Ban from the Activity row | Abuse is noticed in the Activity feed (errors, lock events); blocking requires opening the profile and finding the right device. | Activity session card actions | small | already available (/api/admin/bans, event.d / event.p) |
| Profile timeline paging | personEvents caps at 300 events; a regular visitor's older history is unreachable. | People profile Timeline | small | /live.internal/person needs a `before` parameter |

## Should link to

| From | To | Why |
| --- | --- | --- |
| Activity event row for an upload | Link detail upload-session log (session id = event.si) | jump from 'uploaded 12 files' to the per-file event stream |
| Activity 'link' column / kind-tag place | the drop link detail or share card | the slug is right there and not clickable |
| People profile device card | Activity filtered to that device | see what this device did across all links |
