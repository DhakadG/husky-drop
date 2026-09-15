import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

let switchGoogleAccount;
try {
  ({ switchGoogleAccount } = await import("../public/share-access.js"));
} catch (error) {
  assert.fail(`share access helper must exist and import cleanly: ${error.message}`);
}

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [shareJs, shareHtml, shareCss, shareFx, publicJs, viewerEngine, shareBackend, worker, drive, pkg] = await Promise.all([
  read("public/share.js"),
  read("public/share.html"),
  read("public/style.css"),
  read("public/share-fx.js"),
  read("public/public.js"),
  read("public/share-viewer-engine.js"),
  Promise.all(["share", "share-media", "share-zip", "share-token"].map((n) => read(`src/${n}.js`))).then((parts) => parts.join("\n")),
  read("src/worker.js"),
  read("src/drive.js"),
  read("package.json"),
]);

const makeAccountSwitchUi = () => ({
  button: { disabled: false, textContent: "Use a different Google account" },
  error: { textContent: "" },
});

{
  const { button, error } = makeAccountSwitchUi();
  let navigations = 0;
  const switched = await switchGoogleAccount({
    button,
    error,
    logout: async () => {
      throw new Error("offline");
    },
    navigate: () => navigations++,
  });
  assert.equal(switched, false);
  assert.equal(navigations, 0, "a rejected logout must not launch OAuth");
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Use a different Google account");
  assert.equal(error.textContent, "Could not switch accounts. Please try again.");
}

{
  const { button, error } = makeAccountSwitchUi();
  let navigations = 0;
  const switched = await switchGoogleAccount({
    button,
    error,
    logout: async () => ({ ok: false }),
    navigate: () => navigations++,
  });
  assert.equal(switched, false);
  assert.equal(navigations, 0, "a non-2xx logout must not launch OAuth");
  assert.equal(button.disabled, false);
  assert.equal(error.textContent, "Could not switch accounts. Please try again.");
}

{
  const { button, error } = makeAccountSwitchUi();
  const events = [];
  const switched = await switchGoogleAccount({
    button,
    error,
    logout: async () => (events.push("logout"), { ok: true }),
    navigate: () => events.push("navigate"),
  });
  assert.equal(switched, true);
  assert.deepEqual(events, ["logout", "navigate"], "OAuth starts only after logout succeeds");
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Choosing account...");
  assert.equal(error.textContent, "");
}

{
  const { button, error } = makeAccountSwitchUi();
  let resolveLogout;
  let logoutCalls = 0;
  const logoutResult = new Promise((resolve) => (resolveLogout = resolve));
  const first = switchGoogleAccount({
    button,
    error,
    logout: () => (logoutCalls++, logoutResult),
    navigate: () => {},
  });
  const second = await switchGoogleAccount({ button, error, logout: () => (logoutCalls++, logoutResult), navigate: () => {} });
  assert.equal(second, false);
  assert.equal(logoutCalls, 1, "a disabled switch button prevents concurrent logout attempts");
  resolveLogout({ ok: true });
  await first;
}

assert.match(worker, /\/api\/share\/file-info/);
assert.match(worker, /\/api\/share\/thumb\//);
assert.match(shareBackend, /export async function shareFileInfo/);
assert.match(shareBackend, /export async function shareThumbnail/);
assert.match(shareBackend, /x-husky-asset-tier/);
assert.match(shareBackend, /media\.internal\.share\/f-v3\//);
assert.match(shareBackend, /verifyShareToken\(env, token, "th"\)/);
assert.match(drive, /imageMediaMetadata\(aperture,cameraMake,cameraModel/);
assert.match(drive, /export async function driveFileChunk/);
assert.match(drive, /response\.body\.getReader\(\)/, "RAW metadata reads must remain bounded even if Drive ignores Range");
assert.match(shareBackend, /parseRawExif/);
assert.match(shareBackend, /mergeExifMetadata/);
assert.match(drive, /DRIVE_THUMB_SIZES/);
assert.match(shareJs, /from "\.\/share-viewer-engine\.js"/);
assert.match(shareJs, /from "\.\/share-selection-engine\.js"/);
assert.match(shareJs, /from "\.\/share-video-session\.js"/);
assert.match(shareJs, /document\.createElement\("video"\)/);
assert.match(shareJs, /content\._videoSession/);
assert.match(shareJs, /content\._videoPromise = content\._videoSession\.activate/);
assert.match(shareJs, /pauseForVisibility/);
assert.match(shareJs, /video\.playsInline = true/);
assert.match(shareJs, /pswp-video-controls/);
assert.match(shareJs, /Download original/);
assert.match(shareJs, /video\.controls = false/);
assert.match(shareJs, /window\.addEventListener\("pagehide", suspendPage\)/);
assert.match(shareJs, /errorKind === "network"[\s\S]+session\.retry\(\{ play: resume, preserveTime: true \}\)/, "expired or interrupted video capabilities refresh once without losing playback state");
const videoStart = shareJs.indexOf("function registerVideoContent(instance)");
const videoEnd = shareJs.indexOf("\nfunction cleanupTilePreview", videoStart);
const videoContent = shareJs.slice(videoStart, videoEnd);
assert.doesNotMatch(videoContent, /getPreviewVideo\(/, "viewer video must not reuse gallery preview nodes");
assert.doesNotMatch(videoContent, /className = "g-video-preview"/);
assert.doesNotMatch(videoContent, /refreshSlideContent/, "rotating video must preserve its live session and playback time");
assert.match(videoContent, /className = "pswp-video-media"/, "only the media layer rotates; external controls stay upright");
assert.match(shareJs, /function mountViewerChromeMetrics/);
assert.match(shareJs, /new ResizeObserver/);
assert.match(shareJs, /viewerChrome\.top/);
assert.match(shareJs, /viewerChrome\.bottom/);
assert.match(shareJs, /matchMedia\("\(max-width: 640px\)"\)\.matches \? 3 : 5/);
assert.match(shareCss, /--viewer-bottom-space/);
assert.match(shareCss, /\.pswp \.lb-strip[\s\S]+?touch-action: pan-x/);
assert.match(shareJs, /function mountMobileViewerControls/);
assert.match(shareJs, /pswp-mobile-dock/);
assert.match(shareJs, /pswp-mobile-actions/);
assert.match(shareJs, /setMobileActionsOpen/);
assert.match(shareJs, /mobileViewerActions && !mobileViewerActions\.hidden/);
assert.match(shareJs, /uiIcon\("ellipsis", "pswp-mobile-action-icon"\)/, "More uses the shared SVG icon catalog");
assert.doesNotMatch(shareJs, /•••/, "More no longer uses a text bullet glyph");
assert.match(shareJs, /uiIcon\(iconName, "pswp-mobile-sheet-icon"\)/, "every mobile More action renders its catalog icon");
assert.doesNotMatch(
  shareJs,
  /setMobileActionsOpen\(false, \{ restoreFocus: false \}\)/,
  "reversible More actions stay available until the user touches the media or opens another panel",
);
assert.match(shareJs, /closeViewerPanels\("mobile-actions"\)/, "rotation preserves an already-open mobile More sheet");
assert.match(shareJs, /function syncMobileViewerActions\(\)/, "More action labels and availability are synchronized from viewer state");
const mobileActionSync = shareJs.slice(
  shareJs.indexOf("function syncMobileViewerActions()"),
  shareJs.indexOf("\nfunction mountMobileViewerControls", shareJs.indexOf("function syncMobileViewerActions()")),
);
const mobileActionBuilder = shareJs.slice(
  shareJs.indexOf("const sheetActions ="),
  shareJs.indexOf("\n  const toggleMore", shareJs.indexOf("const sheetActions =")),
);
assert.doesNotMatch(mobileActionSync, /setAttribute\("aria-label"/, "live visible More labels are also their accessible names");
assert.doesNotMatch(mobileActionBuilder, /setAttribute\("aria-label"/, "More actions do not override visible labels with stale names");
assert.match(mobileActionSync, /Motion settings · \$\{viewerMotion\.enabled \? "On" : "Off"\}/);
assert.match(
  shareJs,
  /const mobileActionsHadFocus = mobileViewerActions\?\.contains\(document\.activeElement\);[\s\S]*if \(mobileActionsHadFocus\) more\?\.focus/,
  "closing More never strands focus inside hidden content",
);
assert.match(shareJs, /toggleAttribute\("inert", !open\)/);
assert.match(shareCss, /\.pswp-mobile-dock/);
assert.match(shareCss, /min-height:\s*44px/);
assert.match(shareCss, /100dvh/);
assert.match(shareJs, /createDragSelectionController/);
assert.match(shareJs, /function setSelection\(/);
assert.match(shareJs, /document\.elementFromPoint/);
assert.match(shareJs, /navigator\.vibrate/);
assert.match(shareJs, /lostpointercapture/);
assert.match(shareJs, /img\.draggable\s*=\s*false/);
assert.match(shareJs, /addEventListener\(\s*["']touchmove["'][\s\S]+touchSelection\.isActive\(\)[\s\S]+preventDefault\(\)[\s\S]+passive:\s*false/);
assert.match(shareJs, /addEventListener\(\s*["']contextmenu["'][\s\S]+firesTouchEvents[\s\S]+preventDefault\(\)/);
assert.doesNotMatch(shareJs, /document\.addEventListener\(\s*["']contextmenu["']/);
assert.match(shareJs, /if \(selected\.size\) return toggleSelect\(file, fig\);[\s\S]+openViewer/);
assert.doesNotMatch(shareJs, /touchHoldTimer/);
assert.doesNotMatch(shareJs, /touch-scrubbing/);
assert.match(shareHtml, /id="mobile-sel-info"[^>]+aria-live="polite"/);
assert.match(shareHtml, /id="gallery-tools-toggle"/);
assert.match(shareHtml, /id="gallery-tools-sheet"/);
assert.match(shareJs, /function setGalleryToolsOpen/);
assert.match(shareJs, /box\.scrollLeft = box\.scrollWidth/);
assert.match(shareJs, /Math\.floor\(grid\.getBoundingClientRect\(\)\.width\)/);
assert.match(shareCss, /body\.share-page\.drag-selecting/);
assert.match(shareCss, /body\.share-page \.g-card \.g-check[\s\S]+opacity:\s*0[\s\S]+pointer-events:\s*none/);
assert.match(shareCss, /body\.share-page\.selecting \.g-card \.g-check[\s\S]+opacity:\s*1[\s\S]+pointer-events:\s*auto/);
assert.match(shareCss, /body\.share-page\.drag-selecting \.g-card \.g-check/);
assert.match(shareCss, /body\.share-page \.g-card[\s\S]+touch-action:\s*pan-y pinch-zoom/);
assert.match(shareCss, /body\.share-page \.g-card \.g-dl[\s\S]+width:\s*44px[\s\S]+height:\s*44px/);
assert.match(shareCss, /body\.share-page \.g-card \.g-dl::before[\s\S]+width:\s*30px[\s\S]+height:\s*30px/);
assert.match(shareCss, /@media \(max-width: 640px\)[\s\S]+?\.gallery-tools-sheet/);
assert.match(shareCss, /body\.share-page #gallery-tools-close/);
assert.match(shareCss, /env\(safe-area-inset-bottom\)/);
assert.match(
  shareHtml,
  /id="switch-google-account"[^>]*>Use a different Google account<\/button>/,
  "the signed-in share gate exposes an account switch action",
);
assert.match(
  shareJs,
  /switchGoogleAccount\(\{[\s\S]*logout: \(\) => fetch\("\/api\/auth\/logout", \{ method: "POST" \}\)[\s\S]*navigate: startGoogleSignIn/,
  "account switching waits for the local viewer session to clear before reopening the account chooser",
);
assert.match(shareJs, /className = "pswp-file-info"/);
assert.match(shareJs, /File info/);
assert.match(shareJs, /Reading media details…/);
assert.doesNotMatch(shareJs, /Reading image metadata…/);
assert.match(shareJs, /megapixels/);
assert.match(shareJs, /function inlineUrl\(file\)[\s\S]*inline=1/);
assert.match(shareJs, /pointerenter[\s\S]*void requestPreview\(\)/, "desktop hover starts the stream without an artificial timer");
assert.match(shareJs, /createVideoWarmLease/, "hover and viewer video nodes share a warm signed-source lease");
assert.match(shareFx, /"pointermove",[\s\S]*\{ passive: true, capture: true \}/, "the custom cursor observes pointer movement before media handlers");
assert.match(shareCss, /\.pswp-video\s*\{[\s\S]*pointer-events:\s*none/, "the external media surface owns gallery gestures instead of the video element");
assert.match(shareJs, /media\.addEventListener\("click", togglePlaybackFromMedia\)/, "a deliberate tap on the video picture toggles playback");
assert.match(shareJs, /decodedImages/);
assert.doesNotMatch(shareJs, /thumbUrl\(file, "mid"\)/, "the viewer must skip the redundant medium tier");
assert.match(shareJs, /verifiedFull/);
assert.match(shareJs, /confirmPresented/);
assert.match(shareJs, /warmViewerNeighbors/);
assert.match(shareJs, /viewerAssets\?\.warm/);
assert.match(shareJs, /ensureFreshDownload\(file, true, controller\.signal\)/, "expired thumbnail tokens must force refresh through the cancellable tier request");
assert.match(shareJs, /\[401,\s*403\]\.includes\(response\.status\)/, "rejected preview capabilities must refresh once before failing");
assert.match(shareJs, /for \(const position of \["top", "bottom"\]\)/);
assert.match(shareJs, /pswp-info-hover-zone--\$\{position\}/);
assert.match(shareJs, /pswp-progressive-thumb/);
assert.match(shareJs, /pswp-progressive-full/);
assert.match(shareJs, /Keep the thumbnail visible until the full image has decoded/);
assert.match(shareJs, /showHideAnimationType:\s*"none"/); // viewer opening remains immediate
assert.match(shareJs, /function formatShutterSpeed/);
assert.match(shareJs, /\["Shutter speed",\s*formatShutterSpeed/);
assert.match(shareJs, /\["Maximum aperture"/);
assert.match(shareJs, /\["Orientation"/);
assert.match(shareJs, /GPS altitude/);
assert.match(shareJs, /instance\.on\("contentLoadImage"[\s\S]+?_progressiveManaged[\s\S]+?preventDefault/);
assert.match(shareJs, /addFilter\("isContentLoading"/);
assert.match(shareJs, /_progressiveLoading/);
assert.match(shareJs, /dispatch\("loadComplete"/);
assert.match(shareJs, /VIEWER_MOTION_KEY/);
assert.match(shareJs, /motion-settings-button/);
assert.match(shareJs, /viewerMotion\.enabled/);
assert.match(shareJs, /asset-ladder/);
assert.match(shareJs, /updateAssetLadder/);
assert.match(shareJs, /uiIcon\("aperture", "pswp-asset-glyph"\)/, "the compact asset state uses the existing photographic aperture glyph");
assert.match(shareJs, /aria-label="Media preview loading progress"/, "asset progress wording stays media-neutral");
assert.match(shareJs, /assetLadderElement\.setAttribute\("aria-label", mapped\.label\)/, "mobile assistive technology receives the current asset state even when the visible label is hidden");
assert.match(shareJs, /bar\?\.setAttribute\("aria-valuetext", mapped\.label\)/, "the progressbar exposes the semantic state as value text");
assert.match(shareJs, /function syncAssetLadderVisibility[\s\S]*assetLadderElement\.hidden = !\/\^image\\\/\//, "the image quality ladder is hidden instead of showing stale state on videos and files");
assert.match(shareJs, /assetLadderElement = element;[\s\S]*updateAssetLadder\(\);[\s\S]*syncAssetLadderVisibility\(\);/, "direct-opening a video hides the ladder after PhotoSwipe registers its UI");
assert.doesNotMatch(shareJs, /Image loading and full-resolution intent|Image orientation is unchanged/);
assert.match(shareJs, /refresh the page if this keeps happening/i);
assert.match(shareJs, /createViewerAssetEngine/);
assert.match(shareJs, /createRapidSurfController/);
assert.match(shareJs, /noteRapidNavigation/);
assert.doesNotMatch(shareJs, /function warmNeighbors/);
assert.doesNotMatch(shareJs, /pswp-caption-in/);
assert.match(shareHtml, /id="tile-size"/);
assert.match(shareHtml, /type="range"[^>]+max="9"/);
assert.match(shareJs, /newRevealTargets/);
assert.match(shareJs, /mountStripSizeControl/);
assert.match(shareJs, /stopFilmstripPropagation/);
assert.match(shareJs, /filmstrip-settings-button/);
assert.match(shareJs, /rotate-left-button/);
assert.match(shareJs, /rotate-right-button/);
assert.doesNotMatch(shareJs, /name:\s*"rotation-status"/);
assert.match(shareJs, /dataset\.rotation/);
assert.match(shareJs, /rotation-reset-button/);
assert.match(shareJs, /function rotateCurrentMedia/);
assert.match(shareJs, /function resetCurrentRotation/);
assert.match(shareJs, /viewerTransforms/);
assert.match(
  shareJs,
  /viewerRefreshPanelException = mobileViewerActions && !mobileViewerActions\.hidden \? "mobile-actions" : "";[\s\S]*try \{[\s\S]*refreshSlideContent\(index\)[\s\S]*finally \{[\s\S]*viewerRefreshPanelException = "";/,
  "rotation refresh preserves an open mobile More sheet only for its synchronous PhotoSwipe change event",
);
assert.match(
  shareJs,
  /closeViewerPanels\(\{ except: viewerRefreshPanelException \|\| \(fileInfoPinned \? "file-info" : ""\) \}\)/,
  "real slide navigation still closes More while pinned File info survives",
);
assert.match(shareJs, /function closeViewerPanels/);
assert.match(
  shareJs,
  /if \(except !== "file-info" && \(forceInfo \|\| !fileInfoPinned\)\)/,
  "a deliberate file-info pin survives ordinary viewer interactions on compact screens",
);
assert.doesNotMatch(
  shareJs,
  /forceInfo \|\| compactViewer/,
  "compact layout alone cannot clear a deliberate file-info pin",
);
assert.ok(
  shareJs.indexOf('if (key === "Escape" && hasOpenViewerPanel())') <
    shareJs.indexOf("if (editableTarget(event.target)) return;"),
  "Escape closes the active viewer panel even when one of its controls has focus",
);
assert.match(shareJs, /viewerGuideButton[\s\S]+pointerdown[\s\S]+stopPropagation/);
assert.match(shareJs, /closest\("input, button, select, textarea/);
assert.match(shareJs, /range\.addEventListener\("keydown", \(event\) => event\.stopPropagation\(\)\)/);
assert.match(shareJs, /pswp-guide-grid/);
assert.match(shareJs, /pswp-strip-settings/);
assert.match(shareJs, /pswp-exposure-summary/);
assert.match(shareJs, /toggleFileInfoPin/);
assert.match(shareJs, /aria-pressed/);
assert.match(shareJs, /Taken \(camera metadata\)/);
assert.match(shareJs, /Created in Drive/);
assert.match(shareJs, /uiIcon\("timer"\)/);
assert.match(shareJs, /uiIcon\("aperture"\)/);
assert.match(shareJs, /uiIcon\("gauge"\)/);
assert.match(shareJs, /["']I["']/);
assert.match(shareJs, /goRelative\(-10\)/);
assert.match(shareJs, /goRelative\(10\)/);
assert.match(shareJs, /const STRIP_WIDTHS\s*=\s*\[[^\]]*216/);
assert.match(shareJs, /max="13"/);
assert.doesNotMatch(shareJs, /bar\.addEventListener\([^\n]+capture:\s*true/);
assert.match(shareCss, /\.pswp-file-info/);
assert.match(shareCss, /\.pswp-progressive-thumb/);
assert.match(shareCss, /\.pswp-progressive-full/);
assert.match(shareCss, /\.pswp__counter[\s\S]+left:\s*50%/);
assert.doesNotMatch(shareCss, /pswp-info-open\s+\.pswp__counter/);
assert.match(shareCss, /\.pswp-info-hover-zone[\s\S]+width:\s*(?:9[6-9]|1\d\d)px/);
assert.match(shareCss, /--info-drawer-width/);
assert.match(shareCss, /\.pswp-info-open\s+\.pswp__button--arrow--next\s*\{[\s\S]*?right:\s*0/);
assert.match(shareCss, /\.pswp-info-hover-zone--top/);
assert.match(shareCss, /\.pswp-info-hover-zone--bottom/);
assert.match(shareCss, /\.tile-size-control/);
assert.match(shareCss, /\.size-control-value/);
assert.match(shareCss, /\.size-control-rail/);
assert.match(shareCss, /\.pswp\.pswp-panel-open\s+\.pswp-info-hover-zone/);
assert.match(shareCss, /\.pswp-guide-grid/);
assert.match(shareCss, /\.pswp-strip-settings/);
assert.match(shareCss, /\.pswp-exposure-summary/);
assert.match(shareCss, /--media-rotation/);
assert.match(shareCss, /\.pswp-video-media[\s\S]+rotate\(var\(--media-rotation/);
assert.doesNotMatch(shareCss, /\.pswp[^\n]+pswp-video-controls[^\n]+rotate/, "external video controls never inherit media rotation");
assert.match(shareCss, /\.pswp-asset-ladder/);
assert.match(shareCss, /\.pswp-asset-ladder\[hidden\]\s*\{\s*display:\s*none/, "author styles cannot override the hidden state on video slides");
assert.match(shareCss, /\.pswp-asset-progress/);
assert.match(shareCss, /--asset-progress/);
assert.match(shareCss, /\.pswp-asset-progress i\s*\{[\s\S]*?transform:\s*scaleX\(var\(--asset-progress\)\)/, "determinate asset progress animates a compositor-friendly transform");
assert.match(shareCss, /\.pswp-asset-lamp \.pswp-asset-glyph/, "the asset-state glyph has an explicit, aligned icon box");
assert.match(shareCss, /@keyframes pswpAssetGlyphSpin/, "active asset states animate the glyph rather than the pill layout");
assert.doesNotMatch(shareCss, /\.pswp-asset-cells/);
assert.match(shareCss, /data-state="full-ready"/);
assert.match(shareCss, /\.pswp-motion-settings/);
assert.doesNotMatch(shareCss, /\.pswp-rotation-status/);
assert.match(shareCss, /rotation-reset-button[\s\S]+data-rotation/);
assert.match(shareCss, /\.pswp-info-pin\[aria-pressed="true"\]/);
assert.match(shareCss, /button--file-info-button[\s\S]+?\.pswp__icn[\s\S]+?fill:\s*none[\s\S]+?stroke:/, "PhotoSwipe custom icons must render as stroked icons, not filled silhouettes");
assert.match(shareFx, /animateViewerLed/);
assert.match(
  shareJs,
  /const stateChanged = assetLadderElement\.dataset\.state !== mapped\.key;[\s\S]+if \(stateChanged\) fx\.animateViewerLed/,
  "asset LED animation runs only when the semantic state changes, not on byte-progress emissions",
);
assert.doesNotMatch(shareFx, /animateViewerRotation/);
assert.match(shareJs, /suppressNextViewerTransition/);
assert.match(shareFx, /animateViewerTransition/);
assert.match(shareFx, /function animateViewerExit/);
assert.match(shareFx, /onInterrupt:[^\n]+resolve\(false\)/, "interrupted outgoing blur cannot commit a stale slide change");
assert.match(shareFx, /mode === "blur" \? duration \/ 2 : duration/, "the configured blur speed is split across outgoing and incoming phases");
assert.match(shareJs, /function installViewerNavigationTransitions/);
assert.match(shareJs, /createViewerNavigationController\(\{[\s\S]+exit: \(element\) => fx\.animateViewerExit\(element, viewerMotion\.speed\)/, "blur navigation is routed through the latest-wins controller");
assert.match(viewerEngine, /currentOperation !== operation/, "stale outgoing transitions cannot commit an old slide target");
assert.match(shareJs, /document\.createElement\("button"\)[\s\S]+className = "swiper-slide lb-thumb"/, "filmstrip thumbnails are explicit accessible controls");
assert.match(shareJs, /strip\?\.allowClick === false[\s\S]+instance\.goTo\(idx\)/, "filmstrip clicks navigate only when Swiper did not classify the gesture as a drag");
assert.match(shareJs, /if \(suppressNextViewerTransition\) suppressNextViewerTransition = false;[\s\S]+else applyViewerTransition\(\);/, "rotation refresh suppresses only its synthetic incoming transition");
assert.doesNotMatch(videoContent, /applyViewerTransition\(/, "content creation does not duplicate the central slide transition");
for (const icon of ["file-text", "circle-help", "gallery-horizontal-end", "rotate-ccw", "rotate-cw", "rotate-ccw-square", "ellipsis", "maximize", "pin", "pin-off", "timer", "aperture", "gauge", "wand-sparkles", "chevrons-left", "chevrons-right", "volume-2", "volume-x"]) {
  assert.match(publicJs, new RegExp(`(?:"${icon}"|${icon}):`), `${icon} must exist in the shared icon catalog`);
}
assert.match(publicJs, /Lucide Icons/);
assert.match(viewerEngine, /INTENT_STEPS\s*=\s*6/);
assert.match(viewerEngine, /RAPID_SETTLE_MS\s*=\s*260/);
assert.match(shareCss, /url\("\/logo-mark\.svg"\)/);
assert.match(pkg, /share-viewer-test\.mjs/);

const comparison = await read("docs/LIGHTBOX-FEATURE-COMPARISON.md");
assert.match(comparison, /lightGallery/i);
assert.match(comparison, /EXIF/);
assert.match(comparison, /Fullscreen/);
assert.match(comparison, /Autoplay/);
assert.match(comparison, /Social sharing/);

const shutterSource = shareJs.match(/function formatShutterSpeed\(value\) \{[\s\S]*?\n\}/)?.[0];
assert.ok(shutterSource, "shutter formatter must be extractable for behavior checks");
const formatShutterSpeed = Function(`${shutterSource}; return formatShutterSpeed;`)();
assert.equal(formatShutterSpeed(0.00625), "1/160 sec (0.00625 s)");
assert.equal(formatShutterSpeed("1/250"), "1/250 sec");
assert.equal(formatShutterSpeed(2), "2 sec");
assert.equal(formatShutterSpeed(0.8), "0.8 sec");
assert.match(shareBackend, /if\s*\(!inline[^)]*\)\s*await bumpDownloadStats/);
for (const call of shareBackend.matchAll(/await bumpDownloadStats/g)) {
  const guard = shareBackend.slice(Math.max(0, call.index - 160), call.index);
  assert.match(guard, /!inline/, `download stat call at ${call.index} must be guarded from inline viewing`);
}

for (const asset of [
  "public/logo-mark.svg",
  "public/logo-mark.png",
  "public/logo-lockup.svg",
  "public/logo-lockup.png",
  "public/favicon.svg",
  "public/favicon.png",
]) {
  const info = await stat(new URL(`../${asset}`, import.meta.url));
  assert.ok(info.size > 100, `${asset} should be a real asset`);
}

for (const tracker of ["public/share-trekker.js", "public/drop-trekker.js"]) {
  const source = await read(tracker);
  assert.match(source, /visibilitychange/);
  assert.match(source, /pagehide/);
  assert.match(source, /performance/);
  assert.match(source, /data-track/);
}

console.log("share viewer regression checks passed");
