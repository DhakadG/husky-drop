# Redesign icon fidelity design

## Goal

Faithfully migrate every icon from the eight approved redesign mockups into the production UI without changing routes, data flow, layout, or backend behavior.

The mockup files under `docs/Personal Dropbox UI Redesign/redesign-package/` are the visual source of truth:

- `Home.dc.html`
- `Admin Unlock.dc.html`
- `Admin Overview.dc.html`
- `Admin Activity.dc.html`
- `Admin Drop Links.dc.html`
- `Admin Link Detail.dc.html`
- `Admin Share Links.dc.html`
- `Drop Page.dc.html`

## Current defect

The Overview stat cards create a `.stat-ico` span followed by a nested label span. The selector `el.querySelector("div > span")` matches `.stat-ico` first because the card itself is a `div`. Updating the label therefore replaces the SVG with text such as `LINKS` or `OPENS`.

The broader audit also found exact mockup path geometry missing from Activity, Drop Links, Link Detail, Share Links, Drop Page, and one shared Overview icon. Home and Admin Unlock currently contain all of their mockup path geometry.

## Chosen approach

Use a hybrid exact-geometry migration:

1. Keep structural and one-off icons inline in the HTML screen where they appear.
2. Use a single named icon catalog for icons produced dynamically by JavaScript.
3. Copy the mockups' SVG geometry and presentation semantics exactly: `viewBox`, path `d`, primitive geometry, fill or stroke mode, stroke width, line caps, line joins, and opacity.
4. Reuse a catalog entry only when the source mockups use the same geometry and treatment for that role.

This avoids both incomplete approximations and unnecessary copies of the same dynamic icon.

## Icon contract

Every visible icon must satisfy these rules:

- Its geometry comes from the matching approved mockup, not a substitute icon library.
- Filled, outlined, and duotone icons retain the mockup's rendering mode.
- Icon color continues to follow the mockup or the established component state.
- Decorative SVGs use `aria-hidden="true"`.
- Icon-only controls retain an accessible name; text-labelled controls keep their visible text.
- Unknown dynamic icon keys cannot silently render an empty SVG. The audit test must fail when a requested key is missing.
- Existing data attributes, element IDs, event handlers, and route behavior remain unchanged.

## Component boundaries

### Static screen icons

Navigation, edge-state, trust-strip, upload-zone, radio-card, and other fixed icons remain inline in `public/index.html`, `public/admin.html`, or `public/drop.html`. Their SVG markup is copied from the corresponding mockup.

### Dynamic icons

Icons rendered for activity rows, link actions, detail statistics, share actions, and similar runtime content use a named catalog in the existing shared frontend code. Each entry stores the exact inner SVG geometry plus the required fill/stroke presentation.

### Overview stat cards

Stat cards receive an explicit `.stat-label` hook. Rendering updates `.stat-label` directly and never uses a structural selector that can match `.stat-ico`. CSS resets legacy span rules for `.stat-ico` and scopes label typography to `.stat-label`.

## Audit and regression testing

Add an automated icon audit to the existing test command:

1. Extract every unique SVG path `d` value from all eight mockups.
2. Extract path geometry from production HTML and JavaScript icon definitions.
3. Fail with the mockup filename and missing path when any approved geometry is absent.
4. Assert that every dynamic icon name used by production rendering exists in the catalog.
5. Assert that Overview stat markup uses `.stat-label`, preserves `.stat-ico`, and does not use the ambiguous `div > span` lookup.
6. Assert the CSS scopes icon-tile and label rules independently.

The implementation must also pass the existing smoke and UI v3 tests, JavaScript syntax checks, `git diff --check`, and `wrangler deploy --dry-run`.

## Visual verification

Render and inspect the production Home, Admin Unlock, every admin tab, Link Detail, and Drop Page at desktop and mobile widths. Compare icon shape, treatment, alignment, and state against the matching mockup. The verification focuses on icons; it must not introduce unrelated layout restyling.

## Non-goals

- No backend, API, data-model, authentication, or routing changes.
- No replacement of the established logo mark or typography.
- No new third-party icon package.
- No unrelated redesign or spacing cleanup.
- No separate admin pages; all admin tabs remain in the existing `/admin` document.

## Completion criteria

- Overview stat tiles display SVG icons and separate labels.
- Every approved mockup SVG path is represented in production.
- No dynamic icon request produces a blank SVG.
- All eight screens match their mockup iconography at desktop and mobile sizes.
- All automated and build verification commands pass.
