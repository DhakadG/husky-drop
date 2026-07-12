# Media Viewer v5 — Inventory

Source design: `docs/superpowers/specs/2026-07-12-viewer-intent-resolution-design.md`.

**Viewer architecture constraint:** Keep the existing PhotoSwipe + Swiper share viewer. `public/share.js` remains the integration controller, while deterministic loading/navigation behavior moves into `public/share-viewer-engine.js`. Do not introduce lightGallery runtime code or duplicate the share page.

## Current state and release disposition

| Requirement | Current state | Release disposition | Plan |
|---|---|---|---|
| Modern enabled toolbar icons | Hand-authored grey inline SVG | Vendor attributed Lucide subset and restyle | `plans/00-foundations-and-icon-catalog.md` |
| `I`, ±10, and expanded shortcuts | Home/End and rotate only | Implement complete keyboard map | `plans/01-keyboard-and-toolbar.md` |
| Transient vs pinned EXIF | Toolbar click implicitly pins; generic panel close clears it | Separate open and pin state | `plans/02-exif-drawer-and-metadata.md` |
| Photographer exposure icons | Text-only cards | Lucide Timer/Aperture/Gauge | `plans/02-exif-drawer-and-metadata.md` |
| Date taken | Already returned as `exif.time` and displayed | Preserve; add Created and truthful fallbacks | `plans/02-exif-drawer-and-metadata.md` |
| Rotation animation/status/reset | Per-file rotation exists; refresh is immediate | Add 140 ms directional feedback and contextual cluster | `plans/03-rotation-state-and-animation.md` |
| Rapid keyboard/chevron surfing | Every slide starts heavy warming | Add frequency/hold throttle and settle debounce | `plans/04-rapid-surf-navigation.md` |
| Tiered Drive resolution | Client rewrites raw `thumbnailLink`; originals start immediately | Add signed same-origin Base/Mid/Max proxy and defer Full | `plans/05-tiered-drive-assets.md` |
| LED asset state | Generic PhotoSwipe spinner only | Add 10-cell resolution/intent ladder | `plans/06-led-loading-state-machine.md` |
| Optional transitions | Hard-coded Immediate | Add opt-in mode/speed settings; rapid mode overrides | `plans/07-transition-engine.md` |
| Behavioral coverage | Mostly source-regex assertions | Add pure engine tests plus route/browser checks | `plans/08-integration-tests-and-docs.md` |

## State tables

### File info

| Drawer | Pin | Outside interaction | Slide change | Escape |
|---|---|---|---|---|
| Closed | Off | No change | No change | Viewer closes |
| Open | Off | Auto-close after grace period | Close | Close drawer |
| Open | On | Stay open | Stay open and refresh | Clear pin and close drawer |

### Rotation

| Rotation | Toolbar status | Reset | Dimensions |
|---:|---|---|---|
| 0° | Hidden | Hidden | Original |
| 90° | `90°` | Visible | Swapped |
| 180° | `180°` | Visible | Original |
| 270° | `270°` | Visible | Swapped |

### Rapid surf

| State | Entry | Render policy | Exit |
|---|---|---|---|
| Settled | Default | Base → Mid → Max → six-second intent → Full | Repeated/held navigation |
| Rapid | Repeated key or four moves/500 ms | Base only; no transition; no Full promotion | Key/pointer release plus 260 ms quiet |

### Asset tiers

| Tier | Size | Network source | Ready color |
|---|---:|---|---|
| Base | 512 | `/api/share/thumb/<token>/base` | White |
| Mid | 1024 or 1280 | `/api/share/thumb/<token>/mid` | Yellow |
| Max | 1600 | `/api/share/thumb/<token>/max` | Orange |
| Full | Original | existing signed `dl?inline=1` | Green |

### LED ladder

| Cells | Meaning |
|---|---|
| 0–8 | Six-second dwell/progress rail; unused cells stay dim until Max is ready |
| 9 | State lamp: grey, white pulse/solid, yellow, orange, blue pulse, green, red |

### Transitions

| Setting | Default | Options |
|---|---|---|
| Enabled | Off | On/Off |
| Mode | Fade when enabled | Fade, Soft zoom, Zoom in, Zoom out, Scale up, Slide vertical, Skew, Rotate, Film cut |
| Speed | 180 ms | 80–700 ms |
| Overrides | Immediate | Rapid mode and reduced-motion |

## Backend support and gaps

| Capability | Existing backend | Required change |
|---|---|---|
| Signed file capability | 15-minute HMAC `dl` token | Add dedicated `th` token and asset refresh |
| Thumbnail metadata | Raw Drive URL returned to client | Keep URL server-side; return app-owned tier routes |
| Thumbnail bytes | No app cache | Cache by file ID + modified time + tier |
| Original bytes | Worker stream and ≤100 MiB edge cache | Keep route; invoke only after intent or explicit action |
| EXIF capture time | `imageMediaMetadata.time` | No API expansion; presentation only |

## Visual/icon audit

- Current toolbar controls use uniform low-contrast grey and look disabled. v5 uses near-white 2 px Lucide strokes on 42–44 px glass hit areas, blue/teal hover and pressed states, a visible focus ring, and no idle animation.
- Filmstrip uses Lucide `GalleryHorizontalEnd`; metadata uses `FileText`; guide uses `CircleHelp`; download uses `Download`; rotation uses `RotateCcw`/`RotateCw`; pinning uses `Pin`/`PinOff`; skip controls use chevrons plus a visible `10` badge.
- Exposure cards use `Timer`, `Aperture`, and `Gauge`, with equal-height icon/value groups.
- The signature element is the compact ten-cell resolution ladder, styled like a camera recorder status rail rather than a decorative loading bar.

## Husky Drop vs lightGallery

| Capability | Husky Drop v5 target | lightGallery reference |
|---|---|---|
| Secure Drive shares | Signed routes, PIN/auth, byte proxy | Host-app responsibility |
| EXIF inspector | Full camera drawer and pinning | Not a standard core plugin |
| Rapid surfing | Explicit thumbnail-only throttle | DOM-window/preload settings |
| Resolution intent | Base/Mid/Max/Full ladder | Responsive sources + preload |
| Transitions | Nine PhotoSwipe-compatible presets, default Off | 31 named `mode` values |
| Rotation | Per-file angle, status, reset | Rotate plugin |
| Filmstrip | Drag/wheel/click and 13 sizes | Thumbnail plugin |
| Bulk ZIP/telemetry | Integrated | Host-app responsibility |

## Dependency order

1. `00-foundations-and-icon-catalog.md`
2. `05-tiered-drive-assets.md`
3. `04-rapid-surf-navigation.md`
4. `06-led-loading-state-machine.md`
5. `01-keyboard-and-toolbar.md`, `02-exif-drawer-and-metadata.md`, and `03-rotation-state-and-animation.md`
6. `07-transition-engine.md`
7. `08-integration-tests-and-docs.md`

## Risks and fallbacks

1. Drive's `=sNNN` suffix is undocumented. The Worker attempts it only for known Google thumbnail hosts and retries the unmodified URL on failure.
2. A proxy increases Worker traffic. Three bounded tiers, revision-aware Cache API keys, and browser caching prevent repeated Drive fetches.
3. Large originals can consume memory. Full decode starts only after intent and uses an LRU cap with object-URL cleanup.
4. PhotoSwipe owns pan transforms. Optional transitions animate only the media content element and never the slide transform container.
5. No status may depend on GSAP. GSAP decorates synchronous state changes; CSS and accessible text remain authoritative.
