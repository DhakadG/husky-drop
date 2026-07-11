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
assert.match(shareHtml, /id="tile-size"/);
assert.match(shareJs, /newRevealTargets/);
assert.match(shareCss, /\.pswp-file-info/);
assert.match(shareCss, /\.tile-size-control/);
assert.match(shareCss, /url\("\/logo-mark\.svg"\)/);
assert.match(pkg, /share-viewer-test\.mjs/);

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
