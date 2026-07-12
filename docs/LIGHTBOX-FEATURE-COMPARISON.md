# Husky Drop viewer vs lightGallery

Updated: 12 July 2026

This inventory compares the share-link viewer implemented on top of PhotoSwipe with lightGallery and its official plugins. It includes Husky Drop features that are custom rather than native PhotoSwipe behavior.

Official lightGallery references: [core feature list](https://www.lightgalleryjs.com/docs/getting-started/), [plugin settings](https://www.lightgalleryjs.com/docs/settings/), and [HTML5/external video support](https://www.lightgalleryjs.com/demos/video-gallery/).

## Current Husky Drop viewer inventory

- Justified, responsive Drive gallery with nine density levels.
- Image and HTML5 video lightbox with keyboard, pointer, touch, pan, pinch, wheel zoom, and vertical-drag closing.
- Interactive filmstrip with click, drag, wheel navigation, active-item centering, and thirteen user-selectable thumbnail sizes.
- Four-stage Base → Mid → Max → Full loading through same-origin signed Drive thumbnail routes, decoded-image reuse, a four-item full-resolution LRU, and smart signed-URL refresh.
- Intent-based bandwidth control: Full is requested only after six seconds on the active slide or an explicit zoom action; rapid navigation forces the Base tier until the user settles.
- A ten-cell loading ladder with grey, white, yellow, orange, blue and green states for empty, thumbnail, intermediate, intent/fetch and full-resolution readiness.
- Direct downloads, multi-file selection, ZIP handoff, and download/view telemetry that distinguishes viewing from downloading.
- On-demand camera metadata with an exposure triangle, shutter speed, aperture, ISO, lens, focal length, exposure bias, metering, white balance, flash, sensor, orientation, subject distance, color space, dates, dimensions, megapixels, file size, and GPS when Drive reports it.
- Rotate left/right controls for images and videos, a 140 ms visual turn, contextual angle status, and one-action reset.
- Keyboard shortcuts for inspection, pinning, ±10 navigation, first/last media, filmstrip, motion, rotation/reset, fullscreen, and the viewer guide.
- Optional transitions with 22 modes and adjustable speed; Immediate remains the saved default.
- Native fullscreen and an explicit pin toggle that keeps EXIF visible across slides and other toolbar tools.
- Authentication, PIN gates, multi-folder navigation, Drive-backed permissions, admin activity reporting, and detailed session analytics.
- Immediate image and caption switching by default, with motion available as an explicit visitor preference.

## Feature matrix

| Capability | Husky Drop | lightGallery | Assessment |
|---|---|---|---|
| Responsive image lightbox | Yes | Yes | Equivalent core capability. |
| Touch, swipe, mouse drag | Yes | Yes | Equivalent. |
| Pinch, wheel and actual-size zoom | Yes | Yes, through Zoom | Equivalent; Husky Drop uses PhotoSwipe zoom behavior. |
| Keyboard navigation and accessibility labels | Yes, including ±10, Home/End and tool shortcuts | Yes | Husky Drop adds asset-manager-style skip and inspection shortcuts. |
| Thumbnail filmstrip | Yes | Yes, through Thumbnail | Husky Drop adds wheel/drag navigation and thirteen live size levels. |
| Progressive thumbnail-to-full-image loading | Base/Mid/Max/Full with intent gating | Smart preload | Husky Drop retains a decoded lower tier until its replacement is ready and avoids speculative full-resolution downloads. |
| Rapid-surf bandwidth throttle | Yes | Preload tuning | Husky Drop advantage for large private Drive libraries. |
| Visible asset readiness state | Ten-cell tier/intent ladder | Loader/preloader | Husky Drop exposes more specific loading intent and quality state. |
| EXIF and camera inspection | Yes | Not a standard plugin | Husky Drop advantage. |
| Resolution, megapixels, file size and dates | Yes | Caption-dependent | Husky Drop advantage. |
| Rotate left/right | Yes, image and video, with status/reset | Yes, through Rotate | Husky Drop adds contextual state and a reset action. |
| Flip horizontal/vertical | Not yet | Yes, through Rotate | Good next transform addition. |
| Native fullscreen | Yes, toolbar and `F` | Yes, through Fullscreen | Equivalent. |
| Slideshow autoplay | Not yet | Yes, through Autoplay | Optional; should default off and stop on user interaction. |
| Social sharing | Not yet | Yes, through Share | Prefer a privacy-safe Copy slide link first; social networks can follow. |
| URL hash/deep link to a slide | Not yet | Yes, through Hash | Useful prerequisite for sharing a specific media item. |
| Pager dots alternative | No | Yes, through Pager | Low value because the scalable filmstrip is more informative. |
| External YouTube/Vimeo/Wistia playback | No | Yes, through Video | Outside the current Drive-file scope. Native Drive-hosted video works. |
| Iframe/HTML slides | No | Yes | Intentionally outside the secure file-sharing scope. |
| Comments | No | Facebook/Disqus plugin | Not recommended until there is a first-party identity/moderation design. |
| Multiple galleries/inline carousel | Share pages are isolated instances | Yes | Different product architecture; no current gap for share links. |
| Animated slide transitions | Optional, 22 modes, speed control; default off | 20+ modes | Comparable breadth while retaining Husky Drop's speed-first default and reduced-motion guard. |
| Responsive source selection | Drive thumbnail sizes plus original stream | `srcset`, `sizes`, responsive sets | Husky Drop is optimized around Drive derivatives rather than author-provided sources. |
| Bulk selection and ZIP | Yes | Not a core viewer feature | Husky Drop advantage. |
| Secure Google/PIN access | Yes | Host application concern | Husky Drop advantage. |
| Per-click session telemetry and admin activity | Yes | Events only; storage is host-owned | Husky Drop advantage. |

## Recommended order for remaining gaps

1. Horizontal and vertical persistent transforms in a compact transform menu; the transition engine already offers flip effects, but those do not alter the media itself.
2. Deep links for individual files, followed by a privacy-safe Copy slide link action.
3. Optional slideshow autoplay with an obvious progress/stop state.
4. Social destinations only after per-slide links and privacy behavior are settled.

Pager dots, iframe slides, and third-party comments do not currently justify their complexity for a private Drive sharing product.
