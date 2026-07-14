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
const [css, shareJs, ...pages] = await Promise.all([
  read("public/style.css"),
  read("public/share.js"),
  ...htmlPaths.map(read),
]);
const shareHtml = pages[htmlPaths.indexOf("public/share.html")];

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
assert.match(
  css,
  /\.admin-side :is\(\.tab, \.tab-more\) \.tab-label\s*\{[^}]*display:\s*block/,
  "mobile admin destinations keep visible labels",
);
assert.match(
  css,
  /\.admin-side\s*\{[^}]*position:\s*fixed[^}]*top:\s*auto/,
  "the fixed admin bar clears the desktop sticky top inset",
);
assert.match(
  css,
  /\.admin-mobile-more\s*\{[^}]*bottom:\s*calc\(76px \+ env\(safe-area-inset-bottom\)\)/,
  "the admin More sheet clears the bottom safe area and navigation",
);
assert.match(
  css,
  /\.admin-content \.link-action\s*\{[^}]*min-height:\s*var\(--mobile-control\)/,
  "admin card actions remain usable touch targets",
);
assert.match(
  css,
  /:is\(\.qr-card, \.share-edit-card, \.folder-picker-panel, \.confirm-card\)\s*\{[^}]*max-height:\s*calc\(var\(--mobile-vh\)/,
  "admin dialogs remain reachable inside short phone viewports",
);
assert.match(
  css,
  /\.qr-actions \.btn:last-child\s*\{[^}]*grid-column:\s*1 \/ -1/,
  "the QR dialog keeps its final action balanced on phones",
);
assert.match(
  css,
  /\.folder-picker-panel :is\(button, input\)\s*\{[^}]*min-height:\s*var\(--mobile-control\)/,
  "Drive browser controls remain usable touch targets",
);
assert.match(
  css,
  /\.share-mode-card > input\s*\{[^}]*width:\s*1px[^}]*min-height:\s*0/,
  "hidden share-mode radios cannot widen the mobile admin page",
);

assert.match(
  shareJs,
  /import\s+\{\s*createSmartHeaderState\s*\}\s+from\s+"\.\/share-smart-header\.js";/,
  "the share gallery imports its DOM-free smart-header state",
);
assert.equal(
  (shareJs.match(/\binstallSmartGalleryHeader\(\);/g) || []).length,
  1,
  "the smart gallery header is installed once after navigation",
);
assert.match(
  shareJs,
  /window\.addEventListener\("scroll",\s*schedule,\s*\{\s*passive:\s*true\s*\}\)/,
  "the smart toolbar uses one passive window scroll listener",
);
assert.match(
  shareJs,
  /if\s*\(frame\)\s*return;[\s\S]*frame\s*=\s*requestAnimationFrame\(refresh\)/,
  "scroll work is coalesced into one animation frame",
);
assert.match(
  shareJs,
  /parseFloat\(getComputedStyle\(toolbar\)\.top\)[\s\S]*toolbar\.getBoundingClientRect\(\)\.top\s*<=\s*top\s*\+\s*1/,
  "sticky state is measured against the toolbar's computed top inset",
);
assert.match(
  shareJs,
  /document\.body\.classList\.contains\("gallery-tools-open"\)[\s\S]*toolbar\.contains\(document\.activeElement\)/,
  "open gallery tools and toolbar focus lock the smart header visible",
);
assert.match(
  shareJs,
  /toolbar\.classList\.toggle\("is-scroll-hidden",\s*result\.hidden\)/,
  "the smart header toggles only its hidden-state class",
);

assert.match(shareHtml, /<span class="sort-control">[\s\S]*<select id="sort"[^>]*aria-label="sort files"/);
assert.match(shareHtml, /<\/select>\s*<svg[^>]*aria-hidden="true"/);

assert.match(
  css,
  /body\.share-page \.gallery-toolbar\s*\{[^}]*--gallery-toolbar-top:\s*max\(6px, env\(safe-area-inset-top\)\)[^}]*top:\s*var\(--gallery-toolbar-top\)[^}]*transform:\s*translate3d\(0, 0, 0\)[^}]*transition:\s*transform/,
  "the phone toolbar keeps its safe-area inset and animates only its transform",
);
assert.match(
  css,
  /body\.share-page \.gallery-toolbar\.is-scroll-hidden\s*\{[^}]*transform:\s*translate3d\(0, calc\(-100% - var\(--gallery-toolbar-top\) - 6px\), 0\)[^}]*pointer-events:\s*none/,
  "the hidden toolbar moves out of view without changing layout",
);
assert.match(
  css,
  /@media \(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]*body\.share-page \.gallery-toolbar\s*\{[^}]*transition:\s*none/,
  "reduced-motion users do not receive the toolbar transition",
);
assert.match(
  css,
  /body\.share-page \.toolbar-tools\s*\{[^}]*grid-template-columns:\s*max-content minmax\(0, 1fr\)/,
  "the phone toolbar reserves intrinsic sort width and lets the layout action fill",
);
assert.match(
  css,
  /body\.share-page \.sort-control\s*\{[^}]*width:\s*max-content[^}]*max-width:\s*min\(48vw, 190px\)/,
  "the phone sort wrapper stays compact",
);
assert.match(
  css,
  /body\.share-page \.sort-select\s*\{[^}]*width:\s*auto[^}]*min-height:\s*44px[^}]*appearance:\s*none/,
  "the native sort remains accessible and intrinsic-width",
);
assert.match(
  css,
  /body\.share-page \.sort-control > svg\s*\{[^}]*pointer-events:\s*none/,
  "the decorative sort chevron cannot intercept the native select",
);
assert.match(
  css,
  /body\.share-page \.gallery-tools-toggle\s*\{[^}]*width:\s*100%[^}]*min-height:\s*44px/,
  "only the layout button stretches across its grid track",
);

console.log("mobile responsive contracts passed");
