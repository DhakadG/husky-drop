# Husky Drop Mobile Responsive Design

## Objective

Make every Husky Drop surface reliable and comfortable on phones and tablets without regressing the desktop experience. The share gallery and media viewer receive a purpose-built mobile organization because their desktop interaction density does not translate to touch. The home, drop, authentication, legal, and admin surfaces retain their current information architecture and visual identity; their mobile work is limited to resolving concrete responsive discrepancies.

The result must support photo-heavy and mixed photo/video shares, large galleries, long filenames, safe areas, on-screen keyboards, portrait and landscape orientation, coarse pointers, reduced motion, and the existing desktop workflows.

## Scope

### Deep mobile reorganization

- Public share gallery, folder navigation, toolbar, selection mode, and download actions.
- PhotoSwipe viewer control hierarchy and panel behavior.
- Persistent Swiper thumbnail strip.
- Viewer video creation, activation, playback, error, deactivation, and destruction lifecycle.

### Targeted responsive repair

- Public home and informational pages.
- Drop/upload page and upload queue.
- PIN, identity, and admin authentication gates.
- Legal and documentation pages.
- Admin dashboard, cards, forms, activity timelines, data rows, bottom navigation, folder picker, QR display, and dialogs.

### Non-goals

- Redesigning desktop layouts or replacing their information architecture.
- Replacing PhotoSwipe, Swiper, or the intent-aware viewer asset engine.
- Hiding advanced admin capabilities on mobile.
- Introducing a second mobile-only application or duplicating page markup.
- Retaining touch video scrubbing in gallery tiles.

## Current-state evidence

- `public/share.js` currently renders a justified gallery and integrates PhotoSwipe, Swiper, progressive image tiers, EXIF, rotation, selection, ZIP download, and hover/touch video preview behavior.
- The current viewer video path calls `getPreviewVideo(file)`, reuses the cached gallery-preview element, mutates its controls/mute/loop/class state, appends it into the viewer, and mutates it back during `contentDestroy`.
- The reused video element retains preview-oriented listeners and state. The asynchronous viewer startup also attempts unmuted playback after the original tap, which mobile autoplay policies may reject.
- `public/style.css` has several separate mobile viewer blocks at 640 px. Later rules reduce top-bar buttons to 36 px, below the desired touch target, while the desktop toolbar model still owns most layout decisions.
- The current gallery includes a touch-and-hold video scrub gesture. That gesture conflicts with the approved long-press selection gesture and was originally intended as a desktop inspection aid.
- Non-share pages already contain responsive rules, stacked cards, mobile form layouts, and an admin bottom navigation concept. Their need is consolidation and discrepancy repair rather than structural replacement.

## Approaches considered

### 1. Add more isolated media queries

Keep the current DOM and interaction hierarchy everywhere and append overrides for each visible problem. This minimizes the first diff, but compounds cascade conflicts, retains undersized controls, and cannot resolve gesture or video-lifecycle problems. Rejected.

### 2. Focused responsive architecture with share-specific interaction states

Preserve one DOM and desktop behavior, add explicit responsive foundations, reorganize the share gallery/viewer for touch, isolate the viewer video lifecycle, and audit all other pages for measurable discrepancies. This is the selected approach.

### 3. Separate mobile templates or application

Build alternate mobile markup/routes for share and admin. This permits total layout freedom but duplicates behavior, accessibility, tests, and future maintenance. Rejected.

## Responsive foundation

The design uses content-driven CSS with a small shared viewport matrix rather than device-name detection.

| Range | Intent |
|---|---|
| 320–479 px | Compact phones and narrow split views |
| 480–760 px | Standard phones and phone landscape refinements |
| 761–1024 px | Tablets, small laptops, and wide phone landscape |
| Above 1024 px | Existing desktop experience |

Input capability remains independent of width. Coarse-pointer/touch behavior is selected with input media queries and pointer events, not by assuming every narrow viewport is touch or every wide viewport is a mouse.

Foundation requirements:

- Use `100dvh` for active full-screen surfaces with an appropriate `100vh`/`100svh` fallback.
- Apply `env(safe-area-inset-*)` to full-screen viewer chrome, fixed action bars, admin navigation, and dialogs.
- Maintain a minimum 44 by 44 CSS-pixel target for primary touch controls and at least 8 px separation where targets are adjacent.
- Prevent document-level horizontal overflow while allowing intentional local horizontal scrolling for breadcrumbs and thumbnail strips.
- Let text, URLs, filenames, chips, and action groups wrap or truncate within an explicitly bounded container.
- Preserve visible focus, logical tab order, screen-reader names, reduced-motion behavior, and sufficient contrast.
- Ensure fixed/sticky UI does not cover the focused field, submit action, current gallery row, or final legal content.
- Preserve the existing desktop layout and interactions outside the responsive/input-specific rules.

## Share gallery layout

### Header and toolbar

The share header keeps the current title, owner/expiry context, folder path, sort, density, selection, and download capabilities. On phones:

- Breadcrumbs become a single locally scrollable row with the current folder kept visible.
- Title and share metadata wrap independently instead of forcing action controls offscreen.
- Common browse controls remain visible; lower-frequency density and bulk actions live in a compact overflow sheet.
- Sticky behavior respects the top safe area and must not cause content jumps when browser chrome changes height.
- Controls use labels or accessible names; icon-only controls retain at least a 44 px hit target.

### Adaptive justified rows

The approved phone layout is an adaptive justified gallery, not a square crop grid or single-column feed.

- Media remains in source/sort order from left to right and top to bottom.
- Normal rows target two items on compact phones.
- Very wide media may occupy a full-width row when a two-item row would make it illegible.
- Row computation uses the existing aspect metadata and justified-layout path rather than introducing CSS masonry or a second ordering model.
- Media should not be arbitrarily square-cropped. Existing thumbnail behavior may use bounded cover presentation only where required to fill the justified row box.
- Gaps are compact and consistent; captions/status overlays do not permanently consume tile height.
- Video tiles keep a visible play/duration marker.
- Layout recomputation is scheduled and stable when metadata arrives, orientation changes, or the toolbar height changes.

### Selection state machine

Normal tap opens the viewer. Long-press and drag provides file-browser-style multi-selection.

States:

```text
idle -> pending-hold -> selecting-drag -> idle
                    \-> cancelled-scroll -> idle
```

Rules:

1. `pointerdown` on a selectable media tile starts a hold timer and records pointer identity, start coordinates, and the tile.
2. Movement beyond a small pre-hold slop cancels the hold and leaves normal vertical page scrolling untouched.
3. When the hold threshold completes, the starting tile toggles. Its resulting state becomes the gesture's paint mode: select or deselect.
4. Pointer capture begins only after activation. The app emits haptic feedback with `navigator.vibrate` when available and permitted.
5. As the pointer crosses new media tiles, each tile is processed at most once for that gesture and is set to the paint mode. Re-entering a processed tile does not toggle it repeatedly.
6. Near the top or bottom viewport edge, a requestAnimationFrame-driven auto-scroll loop moves the page proportionally while hit testing continues.
7. Pointer up, pointer cancel, lost capture, window blur, viewer opening, route/folder change, or component destruction cancels timers and auto-scroll and releases capture.
8. The resulting selection uses the existing `selected` map and mobile selection action bar. Download/clear actions remain reachable above the safe area.
9. Keyboard and desktop checkbox selection remain available and accessible.

Touch-and-hold video scrubbing is removed from coarse-pointer/touch input. Desktop fine-pointer hover preview and Shift-assisted scrubbing remain unchanged.

## Mobile media viewer

### Approved hierarchy

The viewer combines Layout A's immersive control hierarchy with Layout B's persistent thumbnail strip.

- A minimal safe-area top rail contains close/back, current position, file information, and an overflow action.
- Primary thumb-reachable actions contain rotation, details, download, and more/settings.
- Lower-frequency viewer guide, motion, strip size, fullscreen support, rotation reset, and related actions live in one mutually exclusive mobile sheet.
- Tapping unobstructed image space may hide/show chrome. Controls, video, panels, and thumbnail-strip interactions never trigger chrome toggling.
- The existing quality/asset ladder remains visible in a compact form without overlapping the media or top rail.
- Previous/next swipe and pinch zoom remain PhotoSwipe-owned for images.
- File-info, guide, settings, and other panels become safe-area bottom sheets on phones and remain drawers/popovers on desktop.
- Only one viewer panel can be open at a time. Escape/back first closes the active panel, then the viewer.

### Persistent thumbnail strip

- The Swiper strip remains mounted whenever the gallery has at least two viewable media items.
- It sits above the bottom action dock and safe area, with the caption immediately above it.
- Thumbnails use the compact B-style scale on phones, remain horizontally draggable, and center the active item without animating the main slide.
- Active state is visually unambiguous; video items show a play marker.
- Strip pointer/touch events are stopped from reaching PhotoSwipe only after Swiper can process them.
- The strip can still be hidden through advanced settings for accessibility or maximum viewport preference, but is visible by default.
- Media padding is derived from measured top/bottom chrome rather than fixed magic values so caption, strip scale, orientation, and safe-area changes cannot cover content.

## Dedicated viewer video lifecycle

Gallery preview elements and viewer player elements are separate resources.

Each video content instance owns:

```js
{
  element,
  video,
  poster,
  loadingState,
  abortController,
  cleanup,
  userInitiatedPlayback
}
```

Lifecycle:

1. `contentLoad` creates a new wrapper, poster, status/error surface, and dedicated `<video>` for that content instance.
2. The player receives `playsinline`, `preload="metadata"`, a same-origin inline source, and native controls. It does not share gallery preview listeners or buffered bars.
3. The poster remains visible until the player has usable frame data. Loading and retry states are explicit and screen-reader announced.
4. Mobile playback starts only after an explicit play/tap action. The design does not depend on unmuted autoplay surviving asynchronous module/token work.
5. Desktop may preserve an intentional autoplay behavior only if browser policy permits it; failure is non-fatal and leaves a visible play action.
6. `contentActivate` marks the player current but does not restart playback that the user paused.
7. `contentDeactivate`, viewer close, `visibilitychange` to hidden, and page lifecycle events pause playback.
8. Navigation away and destruction abort pending source/token work, detach listeners, remove the owned element, and clear references. The player is never mutated back into a gallery preview.
9. Video controls and seeking gestures stop PhotoSwipe navigation from stealing their input. Swipes beginning outside the player remain viewer navigation.
10. Rotation applies to the video presentation wrapper while native-control geometry remains usable. Quarter turns recompute the available media box.

Error states distinguish token/source refresh failure, unsupported codec/playback failure, and general network failure where practical. A retry recreates or reloads only the active video player and does not reload the entire gallery.

## Non-share discrepancy repair

The home, drop, authentication, legal, and admin pages retain their current DOM order, page hierarchy, and desktop styling. Changes require an observed mobile discrepancy or a shared responsive invariant.

### Public home and informational pages

- Repair overflowing navigation, hero copy, CTA groups, decorative layers, badges, and footer columns.
- Keep current section order and visual composition.
- Disable or simplify decorative motion only when it causes overflow, poor performance, or conflicts with reduced motion.

### Drop/upload page

- Preserve the current upload workflow and queue.
- Make file-picker/drop targets touch-appropriate, keep queue rows readable, and keep pause/resume/retry/cancel actions reachable.
- Ensure progress, errors, filenames, and aggregate status wrap without overlapping.
- Validate browser keyboard, camera/file input, backgrounding, and orientation changes.

### Authentication and PIN gates

- Preserve the current cards and sequence.
- Use correct input modes, autocomplete behavior, error association, and focus management.
- Keep the focused input and submit action visible when the on-screen keyboard changes viewport height.

### Legal pages

- Preserve content and hierarchy.
- Repair readable measure, font size/line height, long URL/code wrapping, heading anchors, and footer overlap.

### Admin

- Preserve the existing dashboard panes, cards, forms, detail pages, and bottom-navigation concept.
- Refine the bottom navigation into five stable, labeled destinations: Overview, Live, Drops, Shares, and More. Activity and secondary/session actions remain accessible through More; create actions remain prominent without squeezing seven unlabeled icons into the bar.
- Keep the chosen action-first card presentation for narrow data views. Existing desktop tables remain tables; only genuinely dense narrow rows may use labeled card presentation.
- Group secondary card actions in an overflow menu while keeping the primary action visible.
- Make QR, confirmation, share-edit, and Drive picker dialogs viewport/safe-area aware with internal scrolling.
- Repair activity timelines, statistics grids, breadcrumbs, status pills, long identifiers, and action rows at compact widths.
- Do not remove advanced settings or creation modes on mobile.

## State, data, and error handling

- Responsive layout state is CSS-driven wherever possible. JavaScript owns only behavior that requires gesture state, measured viewer chrome, or lifecycle control.
- Selection remains keyed by file ID in the existing `selected` map and survives relayout without relying on DOM identity.
- Folder or sort changes reconcile selection deliberately and cancel active gestures before replacing nodes.
- Viewer content owns its asynchronous work. All fetches and timers that outlive the active slide must be cancellable.
- Resize/orientation work is coalesced with requestAnimationFrame or ResizeObserver and avoids per-frame layout reads inside loops.
- A mobile error must appear in the surface where recovery happens; toast-only errors are insufficient for blocked video, authentication, or upload actions.

## Accessibility and motion

- All mobile icon buttons have accessible names and visible focus styles.
- Selection activation and count changes are announced through an appropriate live region without announcing every tile crossed during a fast drag.
- Long-press selection is not the sole selection mechanism: keyboard, checkbox, and select-all controls remain available.
- Native video controls provide the baseline accessible playback interface.
- Panels use dialog semantics, trap focus only when modal, restore focus on close, and support Escape/back behavior.
- Animations use opacity/transform, avoid layout-dependent motion, and obey `prefers-reduced-motion`.
- Browser zoom is not disabled.

## Verification strategy

### Automated behavior coverage

- Long-press activation, pre-hold scroll cancellation, paint-mode selection and deselection, per-gesture de-duplication, edge auto-scroll, pointer cancellation, and cleanup.
- Touch/coarse-pointer video scrubbing absence and fine-pointer desktop preview/scrub preservation.
- Viewer video element ownership, no preview-node reuse, explicit mobile playback, user-pause preservation, deactivation/background pause, retry, abort, and destruction.
- Thumbnail strip mounting, active synchronization, click/touch navigation, propagation boundaries, persistent default, and measured viewer padding.
- Existing share-viewer, admin-workflow, UI, smoke, security/budget, and backend regression suites.

### Viewport and input matrix

Exercise every relevant route at:

- 320 × 568
- 360 × 800
- 390 × 844
- 430 × 932
- 568 × 320 phone landscape
- 768 × 1024 tablet portrait
- 1024 × 768 tablet landscape

For applicable routes, repeat with coarse touch input, fine pointer, reduced motion, keyboard-open forms, long content, empty/error/loading states, safe-area simulation, and orientation changes.

### Acceptance criteria

- No page has unintended document-level horizontal overflow at the target matrix.
- No required primary mobile action is obscured, unreachable, or smaller than the touch-target contract.
- Share media ordering remains stable and adaptive rows do not collapse into unusably small tiles.
- Long-press drag selection supports select and deselect painting, scrolling before activation, edge auto-scroll after activation, and reliable cancellation.
- Touch gallery video scrubbing is absent; desktop fine-pointer preview/scrubbing still works.
- The viewer uses the approved immersive hierarchy and shows the persistent compact thumbnail strip by default.
- Mobile video starts reliably from explicit user intent, pauses on navigation/background, preserves deliberate pause state, exposes recovery errors, and releases resources on destroy.
- Image swipe/zoom, video controls, viewer panels, and thumbnail-strip gestures do not steal one another's input.
- Home, drop, authentication, legal, and admin pages retain their current visual/information architecture while all observed responsive discrepancies are resolved.
- The full existing test suite and new mobile behavior tests pass.

## Delivery sequence

1. Consolidate responsive tokens, viewport/safe-area helpers, and test fixtures.
2. Implement and test mobile selection state independently from gallery rendering.
3. Apply adaptive phone gallery rows and toolbar/action layout.
4. Reorganize viewer chrome and persistent strip using measured padding.
5. Replace preview-element reuse with the dedicated viewer video lifecycle.
6. Audit and repair non-share routes without structural redesign.
7. Run automated, viewport, input, accessibility, and regression verification; repair every observed discrepancy before completion.
