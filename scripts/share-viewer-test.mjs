import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const [shareJs, shareHtml, shareCss, shareBackend, worker, drive, pkg] = await Promise.all([
  read("public/share.js"),
  read("public/share.html"),
  read("public/style.css"),
  read("src/share.js"),
  read("src/worker.js"),
  read("src/drive.js"),
  read("package.json"),
]);

assert.match(worker, /\/api\/share\/file-info/);
assert.match(shareBackend, /export async function shareFileInfo/);
assert.match(drive, /imageMediaMetadata\(aperture,cameraMake,cameraModel/);
assert.match(shareJs, /className = "pswp-file-info"/);
assert.match(shareJs, /File info/);
assert.match(shareJs, /megapixels/);
assert.match(shareJs, /\?inline=1/);
assert.match(shareJs, /warmedImages/);
assert.match(shareJs, /decodedImages/);
assert.match(shareJs, /pswp-progressive-thumb/);
assert.match(shareJs, /pswp-progressive-full/);
assert.match(shareJs, /Keep the thumbnail visible until the full image has decoded/);
assert.match(shareJs, /showHideAnimationType:\s*"none"/);
assert.match(shareJs, /function formatShutterSpeed/);
assert.match(shareJs, /\["Shutter speed",\s*formatShutterSpeed/);
assert.match(shareJs, /\["Maximum aperture"/);
assert.match(shareJs, /\["Orientation"/);
assert.match(shareJs, /GPS altitude/);
assert.match(shareJs, /instance\.on\("contentLoadImage"[\s\S]+?_progressiveManaged[\s\S]+?preventDefault/);
assert.match(shareJs, /addFilter\("isContentLoading"/);
assert.match(shareJs, /_progressiveLoading/);
assert.match(shareJs, /dispatch\("loadComplete"/);
assert.doesNotMatch(shareJs, /function animateSlideIn/);
assert.doesNotMatch(shareJs, /pswp-caption-in/);
assert.match(shareHtml, /id="tile-size"/);
assert.match(shareHtml, /type="range"[^>]+max="9"/);
assert.match(shareJs, /newRevealTargets/);
assert.match(shareJs, /mountStripSizeControl/);
assert.match(shareJs, /stopFilmstripPropagation/);
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
assert.match(shareCss, /url\("\/logo-mark\.svg"\)/);
assert.match(pkg, /share-viewer-test\.mjs/);

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
