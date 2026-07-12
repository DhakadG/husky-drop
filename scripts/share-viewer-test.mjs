import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [shareJs, shareHtml, shareCss, shareFx, publicJs, viewerEngine, shareBackend, worker, drive, pkg] = await Promise.all([
  read("public/share.js"),
  read("public/share.html"),
  read("public/style.css"),
  read("public/share-fx.js"),
  read("public/public.js"),
  read("public/share-viewer-engine.js"),
  read("src/share.js"),
  read("src/worker.js"),
  read("src/drive.js"),
  read("package.json"),
]);

assert.match(worker, /\/api\/share\/file-info/);
assert.match(worker, /\/api\/share\/thumb\//);
assert.match(shareBackend, /export async function shareFileInfo/);
assert.match(shareBackend, /export async function shareThumbnail/);
assert.match(shareBackend, /verifyShareToken\(env, token, "th"\)/);
assert.match(drive, /imageMediaMetadata\(aperture,cameraMake,cameraModel/);
assert.match(drive, /DRIVE_THUMB_SIZES/);
assert.match(shareJs, /from "\.\/share-viewer-engine\.js"/);
assert.match(shareJs, /className = "pswp-file-info"/);
assert.match(shareJs, /File info/);
assert.match(shareJs, /megapixels/);
assert.match(shareJs, /\?inline=1/);
assert.match(shareJs, /decodedImages/);
assert.match(shareJs, /ensureFreshDownload\(file, true, controller\.signal\)/, "expired thumbnail tokens must force refresh through the cancellable tier request");
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
assert.match(shareJs, /rotation-status/);
assert.match(shareJs, /rotation-reset-button/);
assert.match(shareJs, /function rotateCurrentMedia/);
assert.match(shareJs, /function resetCurrentRotation/);
assert.match(shareJs, /viewerTransforms/);
assert.match(shareJs, /function closeViewerPanels/);
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
assert.match(shareCss, /\.pswp-info-hover-zone[\s\S]+width:\s*(?:9[6-9]|1\d\d)px/);
assert.match(shareCss, /--info-drawer-width/);
assert.match(shareCss, /\.pswp-info-open[\s\S]+arrow--next/);
assert.match(shareCss, /\.tile-size-control/);
assert.match(shareCss, /\.size-control-value/);
assert.match(shareCss, /\.size-control-rail/);
assert.match(shareCss, /\.pswp\.pswp-panel-open\s+\.pswp-info-hover-zone/);
assert.match(shareCss, /\.pswp-guide-grid/);
assert.match(shareCss, /\.pswp-strip-settings/);
assert.match(shareCss, /\.pswp-exposure-summary/);
assert.match(shareCss, /--media-rotation/);
assert.match(shareCss, /\.pswp-asset-ladder/);
assert.match(shareCss, /data-state="full-ready"/);
assert.match(shareCss, /\.pswp-motion-settings/);
assert.match(shareCss, /\.pswp-rotation-status/);
assert.match(shareCss, /\.pswp-info-pin\[aria-pressed="true"\]/);
assert.match(shareFx, /animateViewerLed/);
assert.match(shareFx, /animateViewerRotation/);
assert.match(shareFx, /animateViewerTransition/);
for (const icon of ["file-text", "circle-help", "gallery-horizontal-end", "rotate-ccw", "rotate-cw", "pin", "pin-off", "timer", "aperture", "gauge", "wand-sparkles", "chevrons-left", "chevrons-right"]) {
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
