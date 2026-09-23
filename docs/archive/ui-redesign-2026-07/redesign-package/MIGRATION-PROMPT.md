# TASK: Redesign Migration Planning — losthusky/drop (UI 3.0)

You are a senior frontend architect. Your job is to produce implementation PLANS only — no execution. The plans will later be executed verbatim by a low-cost model with limited reasoning, so every plan must be explicit, self-contained, and copy-paste precise.

## Inputs

1. **Existing codebase** — the current production app (`public/index.html`, `public/admin.html`, `public/drop.html`, `public/style.css`, plus the server/backend code in the repo). This is the code to MODIFY.
2. **Redesign mockups** — the target UI. These files are the source of truth for all visuals, layout, copy, and interaction patterns:
   - `Home.dc.html` (homepage)
   - `Admin Unlock.dc.html` (admin sign-in)
   - `Admin Overview.dc.html`
   - `Admin Activity.dc.html`
   - `Admin Drop Links.dc.html`
   - `Admin Link Detail.dc.html`
   - `Admin Share Links.dc.html`
   - `Drop Page.dc.html` (uploader view)
   - `PLAN.md` (design system spec + specs for pages not mocked: Live transfers, new-link flow, share gallery, drop-page edge states, mobile behavior)

Note: the mockups are static hi-fi HTML with inline styles. Do NOT copy them as-is into the app — extract their design system and markup patterns, and translate into the app's existing architecture (templates/JS/CSS structure the codebase already uses).

## PHASE 1 — Feature & Layout Inventory (do this first)

Diff the mockups against the existing code and produce `INVENTORY.md` with three tables:

1. **Visual/layout changes** — per page: what layout changed (e.g. "Activity: flat table → day-grouped expandable session timeline"), which design tokens apply (fonts Unbounded / Plus Jakarta Sans / Spline Sans Mono; colors #2f6bff, #15c0c9, #0e9aa7, #7b6bff, #1fb27a, #d98a14, #f0556b; glass cards; animated gradient-blob + dot-grid + noise background; gradient text/buttons; duotone SVG icons; new rotated-droplet logo).
2. **New features requiring frontend work only** — e.g. filter chips, expandable session groups, collapsed settings accordion, stat-card grids, budget progress bars, copy/QR buttons, show-all toggles, hover states.
3. **New features requiring backend work** — anything the current API does not support. For each: the endpoint/data needed, suggested route, payload shape, and where the data comes from. Examples to check for: session-grouped activity (group events by uploader+link+time window), live-transfer progress feed (SSE/WebSocket or polling endpoint with per-file progress + speed + ETA), per-link stats aggregates (opens/sessions/files/bytes), 30-day metrics series for the overview chart, uploader-name field on drops, upload pause/retry/resume state surfaced to UI, size budgets with auto-pause, viewer identity on shares, error events in activity, drive-free-space stat.

Flag every feature in the mockups that has NO existing backend support — these must not be silently faked in the frontend; each needs a backend sub-plan.

## PHASE 2 — Per-File Implementation Plans

Create one plan file per target, in a `plans/` folder:

- `plans/00-design-tokens.md` (shared CSS: fonts, colors, background layers, glass card classes, buttons, icons — everything other plans reference)
- `plans/01-index.md` (homepage)
- `plans/02-admin-unlock.md`
- `plans/03-admin-overview.md`
- `plans/04-admin-activity.md`
- `plans/05-admin-drop-links.md`
- `plans/06-admin-link-detail.md`
- `plans/07-admin-share-links.md`
- `plans/08-drop-page.md`
- `plans/09-backend.md` (all new endpoints/data changes, one section per feature)

### Required format for every plan (strict — the executor cannot infer anything)

For each change, in dependency order:

```
### Change N: <short title>
**File:** <exact path>
**Why:** <1 sentence>
**Locate:** <unambiguous anchor — the exact existing code snippet (5–15 lines, verbatim) the executor must find>
**Action:** REPLACE | INSERT AFTER | INSERT BEFORE | DELETE
**Old code:** (verbatim block, only for REPLACE/DELETE)
**New code:** (complete, final, copy-paste ready — no placeholders, no "...", no "similar to above")
**Verify:** <what the executor should see working after this change>
```

Rules:
- New code blocks must be COMPLETE. If a nav sidebar appears on 5 pages, write it out fully in each plan (or put it in 00-design-tokens as a shared include and reference the exact include mechanism the codebase uses).
- All SVG icons written out in full — the executor cannot draw icons.
- Every plan starts with: list of files it touches, plans it depends on, and any new assets to create.
- Backend plan: full route handlers with real code in the codebase's existing language/framework and style, plus any storage/schema changes, plus the exact frontend fetch calls that consume them.
- Where the mockup shows sample data (names, file lists, stats), the plan must state which parts are placeholder and wire them to real data sources instead.
- Mobile: each page plan ends with a responsive section (sidebar → bottom tab bar, stat grids → 2 cols, tables → stacked cards) per PLAN.md.

## Output order

1. `INVENTORY.md`
2. `plans/00-design-tokens.md`
3. `plans/09-backend.md`
4. Remaining page plans in numeric order.

Do not write any final application code outside the plan files. Do not summarize the mockups instead of planning — every visual detail in the mockups must land in a Locate/Action/New-code block somewhere.
