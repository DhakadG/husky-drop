# Husky Drop Intent-Aware Media Viewer Design

## Objective

Upgrade the existing PhotoSwipe-based share viewer into a speed-first asset manager. Rapid navigation must remain thumbnail-fast, original files must load only after deliberate viewing intent, camera metadata must remain useful to photographers, and every viewer control must be discoverable from both the toolbar and keyboard.

## Evidence and constraints

- Google Drive documents `files.thumbnailLink` as short-lived, commonly lasting hours, unsuitable for direct web-app use because of CORS, and requiring a credentialed request when the file is not public. Husky Drop therefore proxies Drive thumbnails through its own signed, same-origin route and caches the returned bytes; it does not expose or persist OAuth credentials.
- Google does not formally document the `=s<pixels>` URL-rewrite convention. The proxy may use the existing suffix rewrite only as a guarded compatibility optimization and must fall back to the original thumbnail URL if the suffix is not recognized.
- lightGallery exposes transition `mode`, `speed`, and `easing`, plus rotate, autoplay, fullscreen, and thumbnail plugins. Husky Drop keeps PhotoSwipe and implements a curated transition layer because replacing the viewer would discard custom EXIF, Drive security, progressive loading, filmstrip, and telemetry behavior and would introduce lightGallery licensing concerns.
- Lucide icons are ISC licensed, with several older Feather-derived icons under MIT. Only a checked-in, attributed subset is vendored; the page makes no runtime icon-CDN request.
- GSAP is already checked into `public/vendor/gsap.min.js` and loaded before `share.js`.
- Immediate switching remains the default. Reduced-motion users always get immediate switching unless they explicitly change the viewer setting during the session.

## Chosen architecture

Three approaches were evaluated:

1. Extend all loading and navigation state directly inside `public/share.js`. This has the smallest initial diff but leaves timing, cache, and cancellation behavior inseparable from DOM rendering.
2. Add a focused `public/share-viewer-engine.js` module and a signed thumbnail proxy. This creates testable state transitions, explicit cancellation, and a stable interface for the toolbar. This is the selected approach.
3. Replace PhotoSwipe with lightGallery. This would provide many packaged effects but would regress existing Husky Drop features and add a license decision. It is rejected.

`share-viewer-engine.js` owns per-file asset state, rapid-surf detection, intent timing, cancellation, and preference persistence. `share.js` remains responsible for PhotoSwipe/Swiper integration and passes engine state into DOM renderers. `share-fx.js` gains the GSAP timelines for LEDs, rotation, and optional slide transitions. `src/share.js` owns authenticated thumbnail byte retrieval and Cloudflare caching.

## Asset tiers and state machine

Each file has one record:

```js
{
  fileId,
  tier: "empty" | "base" | "max" | "full",
  loading: "" | "base" | "max" | "full",
  intentStep: 0,
  intentSteps: 6,
  rapid: false,
  error: "",
  progress: 0
}
```

Resolution policy:

| Tier | Requested size | Purpose |
|---|---:|---|
| Base | 512 px | Gallery tiles and rapid surfing |
| Max thumbnail | 1600 px | High-quality Drive-rendered preview |
| Full | Original inline stream | Requested only after six seconds of stable intent or an explicit zoom/actual-size request |

On slide activation the engine displays any ready Base image immediately. After 240 ms without another navigation event it requests Max. Only after Max is visibly presented does a six-step, six-second intent timer begin. Leaving the slide cancels pending timers and aborts any fetch owned by that inactive record. Original bytes are never prefetched for neighbors. Mid remains a gallery-tile derivative and is intentionally skipped in the viewer.

RAW and other browser-unsupported formats stop at the Drive-rendered Max tier and announce that the rendered preview is the highest browser-viewable tier. Video retains its poster-first behavior and starts the stream only for the active slide.

## Rapid-Surf throttle

Rapid mode starts when either condition is true:

- three navigation events occur within 420 ms; or
- an Arrow key or PhotoSwipe chevron remains held.

While rapid mode is active:

- the active slide renders the Base tier even if a larger decoded image is cached;
- Max, intent, and Full work is not started for newly traversed slides;
- optional slide transitions are bypassed;
- the generic PhotoSwipe preloader is suppressed because a valid Base preview is already visible.

`keyup`, `pointerup`, `pointercancel`, window blur, or 260 ms without navigation schedules settle. The engine then refreshes only the final active slide, upgrades it through Mid and Max, and restarts intent detection. This prevents intermediate full-resolution decoding from delaying navigation.

## Compact asset-state rail

Image slides show one Aperture status glyph, an accessible state label, and a smooth progress rail. The rail covers Base, Max, six intent steps, Full fetch/presentation, verified Full readiness, and failure. It is hidden for video and non-image slides so stale image-quality state is never presented as media playback status.

State colors remain white for Base, teal for Max, blue for intent/Full work, green for verified Full, and red for failure. GSAP pops the glyph only when the semantic state changes; active fetching/presentation states animate the glyph with CSS transforms. Progress uses `scaleX`, and all motion is disabled under `prefers-reduced-motion`. The DOM and accessible labels update synchronously first.

## Interaction and keyboard map

| Key | Action |
|---|---|
| Left / Right | Previous / next |
| Shift+Left / Shift+Right | Skip 10 |
| `,` or `<` | Skip 10 left |
| `.` or `>` | Skip 10 right |
| Home / End | First / last |
| `I` | Toggle File info |
| `P` | Pin/unpin File info while it is open |
| `[` / `]` | Rotate left/right |
| `0` | Reset rotation |
| `F` | Toggle fullscreen |
| `T` | Toggle filmstrip |
| `A` | Toggle configured transitions |
| `?` | Open viewer guide |
| Escape | Close the active panel; then close the viewer |

Shortcuts do nothing while a form control or editable element has focus. Buttons expose `title`, `aria-label`, `aria-keyshortcuts`, `aria-pressed`, and visible focus states.

## EXIF drawer

Toolbar File info opens an unpinned drawer. Pointer departure or an outside interaction closes it after the existing grace period. A dedicated Lucide Pin button in the drawer header sets `fileInfoPinned`; when pinned, slide changes, rotation, zoom, and canvas interactions keep it open and refresh its data. Escape or the close button explicitly clears the pin.

The exposure summary uses Lucide Timer for shutter, Aperture for f-number, and Gauge for ISO. General metadata shows Date taken from Drive `imageMediaMetadata.time`, Created, and Modified as separate values. Full camera rows retain the exact shutter decimal and reciprocal presentation, camera/lens data, focal length, bias, metering, white balance, flash, color space, sensor, orientation, and GPS when present.

## Rotation state

Rotation supports images and active video content in 90-degree steps. A 140 ms GSAP turn gives directional feedback, then PhotoSwipe refreshes the item dimensions. Once rotation is non-zero, a compact angle badge and Reset button appear in the toolbar. Reset and status disappear at 0 degrees. State persists per file for the page session and is reported through share telemetry.

## Transition engine

Viewer settings expose:

- master toggle, default Off;
- mode: Fade, Soft zoom, Zoom in, Zoom out, Scale up, Slide vertical, Skew, Rotate, and Film cut;
- speed: 80–700 ms, default 180 ms when enabled.

The effects are Husky Drop implementations inspired by lightGallery mode names, not copied lightGallery code. They animate only the current content element and never PhotoSwipe's pan/zoom transform container. Immediate mode, rapid mode, and reduced-motion bypass the effect. Preferences are stored in `localStorage` under versioned keys.

## Visual language

The viewer remains a dark photographic inspection surface. Controls use crisp white strokes, a blue/teal hover glow, visible tooltips, and small spring motion on activation. The asset ladder is the signature element: a compact camera-recorder-style status rail that communicates resolution without adding text over the image. Disabled controls remain distinguishable but are not rendered as universally grey; unavailable media-specific controls use lower contrast and a clear not-allowed cursor.

## Error handling and resource guards

- Thumbnail proxy sizes are allowlisted and clamped; arbitrary upstream URLs never come from the client.
- The proxy resolves the file from a verified share token, checks active share/auth state, fetches metadata server-side, and caches by file ID, modified revision, and size.
- A failed Max tier leaves Base visible and may retry once when the file becomes active again.
- A failed Full fetch leaves Max visible, marks the final LED red, and offers retry. It never reports a download event.
- Object URLs are revoked when records are evicted or the page exits.
- The engine caps decoded originals with a small LRU budget rather than retaining an unbounded gallery.

## Testing and completion evidence

- Pure Node behavior tests cover rapid-entry/settle thresholds, intent cancellation, six-step completion, no Full request before intent, URL tier selection, transition defaults, and rotation normalization.
- Worker smoke tests cover thumbnail route signature validation, size clamping, upstream credentialing, revision cache keys, and response headers.
- Viewer source/structure checks cover Lucide attribution, toolbar controls, EXIF pin semantics, keyboard map, status ladder, and no neighbor original warmup.
- Browser verification covers press-and-hold Arrow navigation, chevron hold, pinned/unpinned File info behavior, toolbar alignment, every compact asset state, rotation feedback/reset, transition toggle/speed, mobile layout, and reduced motion.
- `npm test`, `git diff --check`, and `npx wrangler deploy --dry-run` are mandatory release gates.

## Source references

- Google Drive File resource: https://developers.google.com/workspace/drive/api/reference/rest/v3/files
- lightGallery settings: https://www.lightgalleryjs.com/docs/settings/
- Lucide license: https://lucide.dev/license
- Lucide Aperture: https://lucide.dev/icons/aperture
- Lucide Timer: https://lucide.dev/icons/timer
- Lucide Gauge: https://lucide.dev/icons/gauge
