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

assert.match(
  css,
  /body\.home,\s*body\.legal-page\s*\{[^}]*overflow-x:\s*clip/,
  "home and legal pages clip decorative overflow on phones",
);
assert.match(
  css,
  /\.home-v3\s*\{[^}]*padding-inline-start:\s*var\(--mobile-safe-left\)[^}]*padding-inline-end:\s*var\(--mobile-safe-right\)/,
  "home content respects phone safe areas",
);
assert.match(
  css,
  /\.hero-actions\s*\{[^}]*grid-template-columns:\s*1fr/,
  "home calls to action stack at narrow phone widths",
);
assert.match(
  css,
  /\.legal-card\s*\{[^}]*overflow-wrap:\s*anywhere/,
  "legal copy cannot widen the page",
);
assert.match(
  css,
  /\.legal-shell \.topbar\s*\{[^}]*flex-wrap:\s*wrap/,
  "legal navigation wraps below the brand on narrow phones",
);
assert.match(
  css,
  /\.home-v3 \.brand\s*\{[^}]*font-size:\s*13\.5px/,
  "the home brand remains readable beside the admin action at 320px",
);
assert.match(
  css,
  /body\.drop-page\s*\{[^}]*min-height:\s*var\(--mobile-vh\)[^}]*overflow-x:\s*clip/,
  "the uploader cannot create document-level horizontal overflow",
);
assert.match(
  css,
  /\.drop-v3\s*\{[^}]*width:\s*100%[^}]*padding-inline-start:\s*var\(--mobile-safe-left\)/,
  "the uploader shell uses phone-safe full-width geometry",
);
assert.match(
  css,
  /\.drop-topbar\s*\{[^}]*flex-wrap:\s*wrap/,
  "the uploader status wraps instead of widening small screens",
);
assert.match(
  css,
  /body\.admin-page \.admin-shell\s*\{[^}]*padding-bottom:\s*var\(--mobile-safe-bottom\)/,
  "signed-out admin pages do not inherit desktop bottom padding",
);
assert.match(
  css,
  /\.auth-wrap\s*\{[^}]*min-height:\s*calc\(var\(--mobile-vh\) - 40px\)[^}]*overflow-y:\s*auto/,
  "admin authentication stays reachable with short mobile viewports",
);

console.log("mobile responsive contracts passed");
