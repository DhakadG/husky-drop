# Husky Drop viewer vs lightGallery

Updated: 12 July 2026

This inventory compares the share-link viewer implemented on top of PhotoSwipe with lightGallery and its official plugins. It includes Husky Drop features that are custom rather than native PhotoSwipe behavior.

Official lightGallery references: [core feature list](https://www.lightgalleryjs.com/docs/getting-started/), [plugin settings](https://www.lightgalleryjs.com/docs/settings/), and [HTML5/external video support](https://www.lightgalleryjs.com/demos/video-gallery/).

## Current Husky Drop viewer inventory

- Justified, responsive Drive gallery with nine density levels.
- Image and HTML5 video lightbox with keyboard, pointer, touch, pan, pinch, wheel zoom, and vertical-drag closing.
- Interactive filmstrip with click, drag, wheel navigation, active-item centering, and thirteen user-selectable thumbnail sizes.
- Thumbnail-first progressive loading, decoded-image reuse, neighbor warming, retry handling, and smart signed-URL refresh.
- Direct downloads, multi-file selection, ZIP handoff, and download/view telemetry that distinguishes viewing from downloading.
- On-demand camera metadata with an exposure triangle, shutter speed, aperture, ISO, lens, focal length, exposure bias, metering, white balance, flash, sensor, orientation, subject distance, color space, dates, dimensions, megapixels, file size, and GPS when Drive reports it.
- Rotate left/right controls with per-file state for the current browser session.
- Authentication, PIN gates, multi-folder navigation, Drive-backed permissions, admin activity reporting, and detailed session analytics.
- Immediate, transition-free image and caption switching by design.

## Feature matrix

| Capability | Husky Drop | lightGallery | Assessment |
|---|---|---|---|
| Responsive image lightbox | Yes | Yes | Equivalent core capability. |
| Touch, swipe, mouse drag | Yes | Yes | Equivalent. |
| Pinch, wheel and actual-size zoom | Yes | Yes, through Zoom | Equivalent; Husky Drop uses PhotoSwipe zoom behavior. |
| Keyboard navigation and accessibility labels | Yes | Yes | Equivalent baseline; continue auditing focus order as toolbar tools grow. |
| Thumbnail filmstrip | Yes | Yes, through Thumbnail | Husky Drop adds wheel/drag navigation and thirteen live size levels. |
| Progressive thumbnail-to-full-image loading | Yes | Smart preload | Husky Drop explicitly retains the thumbnail until full decode and reuses decoded images. |
| EXIF and camera inspection | Yes | Not a standard plugin | Husky Drop advantage. |
| Resolution, megapixels, file size and dates | Yes | Caption-dependent | Husky Drop advantage. |
| Rotate left/right | Yes | Yes, through Rotate | Equivalent after the toolbar update. |
| Flip horizontal/vertical | Not yet | Yes, through Rotate | Good next transform addition. |
| Native fullscreen | Not yet | Yes, through Fullscreen | High-value next addition. |
| Slideshow autoplay | Not yet | Yes, through Autoplay | Optional; should default off and stop on user interaction. |
| Social sharing | Not yet | Yes, through Share | Prefer a privacy-safe Copy slide link first; social networks can follow. |
| URL hash/deep link to a slide | Not yet | Yes, through Hash | Useful prerequisite for sharing a specific media item. |
| Pager dots alternative | No | Yes, through Pager | Low value because the scalable filmstrip is more informative. |
| External YouTube/Vimeo/Wistia playback | No | Yes, through Video | Outside the current Drive-file scope. Native Drive-hosted video works. |
| Iframe/HTML slides | No | Yes | Intentionally outside the secure file-sharing scope. |
| Comments | No | Facebook/Disqus plugin | Not recommended until there is a first-party identity/moderation design. |
| Multiple galleries/inline carousel | Share pages are isolated instances | Yes | Different product architecture; no current gap for share links. |
| Animated slide transitions | Intentionally disabled | 20+ modes | Deliberate difference: Husky Drop prioritizes immediate switching. |
| Responsive source selection | Drive thumbnail sizes plus original stream | `srcset`, `sizes`, responsive sets | Husky Drop is optimized around Drive derivatives rather than author-provided sources. |
| Bulk selection and ZIP | Yes | Not a core viewer feature | Husky Drop advantage. |
| Secure Google/PIN access | Yes | Host application concern | Husky Drop advantage. |
| Per-click session telemetry and admin activity | Yes | Events only; storage is host-owned | Husky Drop advantage. |

## Recommended order for remaining gaps

1. Native fullscreen with a toolbar button and `F` shortcut.
2. Horizontal and vertical flip in a compact transform menu, rather than four more permanently visible toolbar buttons.
3. Deep links for individual files, followed by a privacy-safe Copy slide link action.
4. Optional slideshow autoplay with an obvious progress/stop state.
5. Social destinations only after per-slide links and privacy behavior are settled.

Pager dots, iframe slides, third-party comments, and decorative transitions do not currently justify their complexity for a private Drive sharing product.
