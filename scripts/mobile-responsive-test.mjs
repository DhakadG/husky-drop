import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
const htmlPaths = [
  "public/index.html",
  "public/drop.html",
  "public/privacy.html",
  "public/terms.html",
  "public/admin.html",
  "public/share.html",
];
const [css, ...pages] = await Promise.all([
  read("public/style.css"),
  ...htmlPaths.map(read),
]);

for (const [index, page] of pages.entries()) {
  assert.match(
    page,
    /<meta[^>]+name="viewport"[^>]+width=device-width/,
    `${htmlPaths[index]} must keep mobile viewport semantics`,
  );
  assert.match(
    page,
    /href="\/style\.css"/,
    `${htmlPaths[index]} must load the shared stylesheet`,
  );
  assert.doesNotMatch(
    page,
    /user-scalable\s*=\s*no/i,
    `${htmlPaths[index]} must keep browser zoom enabled`,
  );
}

assert.match(css, /--mobile-gutter:\s*12px/);
assert.match(
  css,
  /--mobile-safe-left:\s*max\(var\(--mobile-gutter\), env\(safe-area-inset-left\)\)/,
);
assert.match(
  css,
  /--mobile-safe-right:\s*max\(var\(--mobile-gutter\), env\(safe-area-inset-right\)\)/,
);
assert.match(css, /--mobile-safe-bottom:\s*max\(12px, env\(safe-area-inset-bottom\)\)/);
assert.match(css, /--mobile-control:\s*44px/);
assert.match(css, /--mobile-vh:\s*100dvh/);
assert.match(css, /@media \(max-width: 640px\)/);
assert.match(css, /@media \(max-width: 900px\)/);
assert.match(css, /@media \(max-height: 500px\) and \(orientation: landscape\)/);
assert.doesNotMatch(
  css,
  /(?:^|})\s*body\s*\{[^}]*touch-action:\s*none/im,
  "document scrolling must not be disabled globally",
);

console.log("mobile responsive contracts passed");
