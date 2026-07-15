# Video Viewer Continuity Design

## Purpose

Fix the regressions introduced by the external video player without returning to native controls or weakening Range streaming. The result must start previews quickly, preserve warmed media across the tile-to-viewer handoff, keep playback controls independent from slide gestures, and make every navigation path reliable on desktop and mobile.

## Confirmed interaction contract

- Tapping the video picture toggles play or pause.
- A deliberate horizontal swipe across the video picture navigates to the previous or next slide.
- The external control bar owns its gestures completely. Seeking, tapping play, muting, or entering fullscreen must never move the slide.
- The filmstrip owns its gestures completely. Clicking a thumbnail navigates exactly once; dragging the strip scrolls it without moving the main slide.
- Desktop pointer movement over the video and its controls must continue updating the custom cursor.
- Mobile hover-only behavior and desktop Shift-hover scrubbing remain separate; scrubbing stays disabled on small/coarse-pointer devices.

## Root causes

1. The player paints the range value from raw `currentTime`. At media end, browser timelines may stop a fraction short of the reported `duration`, while both formatted labels round to the same second.
2. The video element stops bubbling `pointermove`, but the cursor follower listens at `window` during the bubble phase. The cursor therefore freezes as soon as the pointer enters the player.
3. Viewer activation calls `ensureFreshDownload(file, true)`, which mints a different signed URL even when the hover preview already has a fresh, cacheable URL. A different URL prevents browser cache reuse and causes another media request.
4. Hover preview startup is delayed by a 140 ms timer before source resolution even begins.
5. Video, control, PhotoSwipe, and Swiper handlers all consume overlapping pointer/touch streams. Broad `stopPropagation()` calls hide events from the cursor and can leave gallery/strip gesture state inconsistent.
6. Filmstrip navigation relies on Swiper's derived `clickedSlide` callback calling the PhotoSwipe method that is also wrapped by the asynchronous transition controller. The path has no explicit ownership or cancellation boundary.

## Architecture

Keep separate video elements for the gallery preview and the viewer. Reusing the same DOM node would preserve its media buffer perfectly, but it would also transfer loop, mute, preview scrub, poster, accessibility, and cleanup listeners between two independent components. Instead, both elements use one stable inline URL while its token is fresh. The browser can reuse cached byte ranges and validators, and the server continues forwarding any missing Range request immediately.

Three focused boundaries govern the behavior:

1. `share-video-session.js` owns playback state and exports a pure timeline projection used by the external controls.
2. A small source-continuity helper owns the stable inline URL and the hover-to-viewer warm lease for each file.
3. One viewer navigation controller owns immediate and animated `goTo`, `next`, `previous`, and filmstrip navigation.

No service worker, player library, MediaSource pipeline, blob download, or duplicated cache is added.

## Timeline and controls

The timeline projection clamps invalid values and returns:

- `duration`: finite positive media duration or zero;
- `position`: `duration` whenever `ended` is true, otherwise clamped `currentTime`;
- `progress`: `position / duration`, clamped to zero through one;
- formatted accessible text.

The `ended` listener paints the range at its exact maximum and exposes 100 percent through `aria-valuenow` and `aria-valuetext`. Seeking away from the end returns to the ordinary live position.

The mute button contains only SVG. It switches between `volume-2` and `volume-x`; its `aria-label`, `title`, and pressed state describe the action and current muted state. Visible Mute/Unmute text is removed.

## Cursor and gesture ownership

The custom cursor's global pointer tracker moves to capture phase so descendant components cannot starve it. Cursor state resolution still uses the event target and existing `data-cursor` attributes.

The video picture uses a gesture intent threshold:

- movement below the threshold is a tap and toggles playback;
- horizontal movement beyond the threshold is left to PhotoSwipe for deliberate slide navigation;
- controls and error actions stop their own pointer/touch/click events and use `touch-action: manipulation` or the range-specific action;
- the actual `<video>` rendering layer does not independently drag or pan.

The filmstrip attaches navigation directly to each thumbnail's click after Swiper has rejected a drag. It sends the target index to the single viewer navigation controller. A strip drag never produces a thumbnail navigation click, and its events never reach PhotoSwipe.

## Hover preview and warm handoff

Pointer entry starts source resolution immediately. The preview switches to `preload="auto"` only while hovered, remains muted and looping, and plays as soon as the browser has enough data. The still thumbnail stays visible until the first frame is ready.

Pointer exit pauses immediately and returns preload intent to metadata. A short 500 ms release grace period allows the click that opens the viewer to claim the warm source. If no viewer claims it and the pointer does not return, the preview aborts further loading by clearing the media source and calling `load()`.

Opening a video viewer:

1. claims the file's warm lease before the gallery preview cleanup runs;
2. uses the exact same inline URL when the token remains fresh;
3. never forces token refresh during ordinary activation;
4. refreshes the token only when expired, explicitly retried, or after a network failure;
5. preserves server validators and browser Range-cache reuse even if the browser performs a lightweight validation request.

Viewer deactivation pauses playback and releases the claim. It does not destroy another slide's warm lease. Network retry retains the existing current-time and play-intent behavior.

## Filmstrip navigation

`installViewerNavigationTransitions()` returns a navigation interface instead of only monkey-patching PhotoSwipe methods. Arrows, keyboard navigation, swipe navigation, and filmstrip clicks share the same planned index and cancellation generation.

A new navigation request cancels a pending blur exit before scheduling the next target. A filmstrip click cannot be lost while a video is playing, and rapid repeated clicks resolve to the latest selected thumbnail. The active strip marker updates from PhotoSwipe's authoritative `change` event.

## Error handling

- An expired token is refreshed once and retains playback position.
- Abort caused by hover exit is silent and does not show a playback error.
- Codec failures retain the existing precise unsupported-format message and Download original action.
- A rejected autoplay leaves the video ready and exposes the Play button; it does not trigger token refresh.
- Invalid or infinite media duration disables the seek control without producing NaN values.

## Testing

Tests are added before production changes.

### Unit coverage

- ended timelines project to exact duration and 100 percent;
- ordinary timelines clamp negative, excessive, infinite, and NaN values;
- a fresh hover URL is reused by the viewer without calling forced refresh;
- hover exit pauses immediately and aborts only after the grace period;
- a viewer claim cancels pending hover-source release;
- network retry is the only ordinary path that forces a refreshed source;
- navigation cancellation resolves repeated filmstrip selections to the latest index.

### DOM and contract coverage

- mute/unmute controls render `volume-2` and `volume-x` SVG with accessible labels;
- the cursor tracks pointer movement in capture phase;
- video surface and control-bar gesture handlers are distinct;
- filmstrip thumbnails have an explicit navigation listener and strip drag suppression;
- viewer activation does not call `ensureFreshDownload(file, true)`.

### Runtime verification

Using the local media fixture on desktop and a mobile viewport:

- let a video end and verify the range thumb, value, and accessible percentage reach 100 percent;
- move the pointer across a playing video and control bar and verify the custom cursor follows continuously;
- tap the picture to play/pause and swipe it horizontally to navigate;
- seek and tap every control without changing slides;
- click multiple filmstrip thumbnails while a video is active and verify exact navigation;
- hover a video and confirm the first request begins without the old timer;
- click the warmed tile and verify the viewer uses the same URL and does not perform a second full origin download;
- leave an unclaimed tile and verify preview loading is cancelled after the grace period.

Run the complete test suite and `wrangler deploy --dry-run` before committing the implementation. Publish to `origin/main` only after the local and remote commit are verified.

## Non-goals

- Adding codecs the browser does not support.
- Buffering the whole video before playback.
- Persisting media in Cache Storage or IndexedDB.
- Replacing PhotoSwipe or Swiper.
- Reintroducing native video controls.
- Moving the same `<video>` DOM node between the gallery and viewer.
