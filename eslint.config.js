// Static guard for the src/ split and the page scripts: every identifier
// must resolve. This is what would have caught the missing notifyEmail
// import (#22) and the undefined `button` in the create-link error path.
import globals from "globals";

const PAGE_GLOBALS = {
  ...globals.browser,
  // public.js (classic script) helpers shared by every page
  uiIcon: "readonly", chip: "readonly", reconcile: "readonly", fmtBytes: "readonly", fmtTime: "readonly",
  fmtDateDMY: "readonly", esc: "readonly", escAttr: "readonly", $: "readonly",
  // other classic scripts / vendor libs loaded via <script src>
  createAdaptiveConcurrency: "readonly", qrcode: "readonly", gsap: "readonly",
  PhotoSwipeLightbox: "readonly", PhotoSwipe: "readonly", Swiper: "readonly",
};
const RULES = {
  "no-undef": "error",
  // page scripts legitimately define the helpers listed as globals above
  "no-redeclare": ["error", { builtinGlobals: false }],
  "no-dupe-keys": "error",
  "no-unreachable": "error",
};

export default [
  { ignores: ["public/vendor/**", "node_modules/**", "graphify-out/**", ".wrangler/**"] },
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.serviceworker, WebSocketPair: "readonly", crypto: "readonly", caches: "readonly", URLPattern: "readonly", FixedLengthStream: "readonly" },
    },
    rules: { ...RULES, "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }] },
  },
  {
    files: ["public/**/*.js"],
    ignores: ["public/share*.js", "public/admin*.js", "public/drop.js", "public/drop-*.js"],
    languageOptions: { ecmaVersion: 2024, sourceType: "script", globals: PAGE_GLOBALS },
    rules: RULES,
  },
  {
    files: ["public/share*.js", "public/admin*.js", "public/drop.js", "public/drop-*.js", "public/identity.js"],
    // modules import their helpers explicitly; no classic-script globals here
    languageOptions: { ecmaVersion: 2024, sourceType: "module", globals: { ...PAGE_GLOBALS, $: "off" } },
    rules: { ...RULES, "no-import-assign": "error", "no-unused-vars": ["error", { args: "none", caughtErrors: "none", vars: "all" }] },
  },
];
