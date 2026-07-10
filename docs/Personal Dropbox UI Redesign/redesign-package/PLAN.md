# losthusky/drop — UI 3.0 Redesign Plan

Redesigned pages (built as hi-fi mockups in this project):

| Page | File |
|---|---|
| Homepage | `Home.dc.html` |
| Admin unlock | `Admin Unlock.dc.html` |
| Admin · Overview | `Admin Overview.dc.html` |
| Admin · Activity | `Admin Activity.dc.html` |
| Admin · Drop links | `Admin Drop Links.dc.html` |
| Admin · Link detail | `Admin Link Detail.dc.html` |
| Admin · Share links | `Admin Share Links.dc.html` |
| Drop page (uploader) | `Drop Page.dc.html` |

## Design system (apply everywhere)

- **Fonts**: Unbounded (display/headings/numbers), Plus Jakarta Sans (body), Spline Sans Mono (meta/labels/stats).
- **Colors**: keep existing blue→teal scheme. Primary `#2f6bff`, teal `#15c0c9`/`#0e9aa7`, violet accent `#7b6bff`, success `#1fb27a`, warning `#d98a14`, danger `#f0556b`. Ink `#0c1a2b`, secondary `#43566b`, muted `#6b7c91`/`#9aa8b8`.
- **Signature gradient**: `linear-gradient(120deg,#2f6bff,#15c0c9)` for primary buttons, active nav, headline text (`background-clip:text`).
- **Background recipe** (fixed layer, cheap — pure CSS, no libs): base vertical gradient `#f4f8fe→#e5edf9` + 2–3 blurred radial blobs animated at 18–26s + 26px dot grid masked to the top + SVG fractal-noise texture at 5% multiply.
- **Glass cards**: `rgba(255,255,255,.6-.68)` bg, 1px `rgba(255,255,255,.9)` border, `backdrop-filter: blur(12-14px)`, big soft shadow `0 24px 60px -34px rgba(20,60,120,.5)`, radius 20–26px.
- **Logo**: rotated (−6°) rounded square with blue→teal 135° gradient, inner white droplet, inset highlight + colored drop shadow. Wordmark `losthusky / drop` with gradient slash.
- **Icons**: filled/duotone inline SVG (solid shape + 14–20% opacity backplate).
- **Hero action pattern**: gradient-border card (2px padded gradient wrapper around a glass card) for the single most important action per page.

## Pages not yet built — specs

### 1. Live transfers (admin sub-tab)
Purpose: real-time monitoring of in-flight uploads.
- Same shell (sidebar + animated bg).
- One large card per active session: avatar, uploader name → link, overall ring % + per-file rows (like Drop page queue), live speed sparkline (last 60s), ETA.
- Sticky summary strip on top: total active sessions, combined throughput, Drive write rate.
- Empty state: dashed card "No transfers right now" + last-completed-session summary.
- Completed sessions slide down into a "Finished this hour" list.

### 2. New drop link (modal or page)
- 2-step: (1) Name + destination Drive folder picker, (2) optional protections (PIN, expiry days, size budget, parallelism preset simple/fast/aggressive).
- Big preview of the resulting `/d/slug` URL + copy + QR right in the success state.
- Keep every field optional except the label — "create" must be reachable in one enter press.

### 3. Share gallery page (`/s/…` visitor view)
- Same ambient background but calmer (1 blob).
- Top: gallery title, owner avatar, "N files · M GB", PIN state chip.
- Masonry/grid of media tiles with hover zoom, lazy loading, lightbox with swipe.
- Per-folder tabs when a share spans multiple folders.
- "Download all as zip" pinned bottom-right if enabled.
- Gate screens: Google sign-in card → PIN card (reuse Admin Unlock card style).

### 4. Drop page states not mocked
- **Locked state**: PIN entry card (reuse unlock card) with link label shown.
- **Expired/paused**: friendly full-page notice, owner contact hint.
- **Done state**: confetti-free success card "All 96 files delivered ✓", per-file recap, "add more" button.
- **Budget hit**: amber notice + auto-pause explanation.

### 5. Mobile behaviors (all admin pages)
- Sidebar collapses to a bottom tab bar (Overview / Live / Links / Shares / Activity).
- Stat grids fall to 2 columns; tables become stacked cards.

## Rationale — what was wrong before (from the old style.css / html)
- Flat single-color background → replaced with layered gradient-mesh + noise + dot grid.
- Weak hierarchy: all cards equal weight → introduced hero-action pattern + one accented stat card per grid.
- Activity was a flat undifferentiated table → grouped timeline by day → session, expandable, with type chips and person-first rows.
- Drop page was admin-centric → rewritten uploader-first: who's collecting, one giant add-files action, progress with reassurance banner, retry affordances, trust strip.
- Buttons/links lacked states → every interactive element has hover treatment; primary actions use the signature gradient.
- No iconography → duotone SVG set used consistently.
