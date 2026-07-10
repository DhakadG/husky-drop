import assert from "node:assert/strict";
import fs from "node:fs";

const adminHtml = fs.readFileSync(new URL("../public/admin.html", import.meta.url), "utf8");
const adminJs = fs.readFileSync(new URL("../public/admin.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../public/style.css", import.meta.url), "utf8");

// Details must be able to call this helper from renderDetail (top-level scope).
assert.match(
  adminJs,
  /function uploadRow\([\s\S]*?<\/tr>`;\s*}\s*\n\s*function detailStatCard\(/,
  "detailStatCard stays at top level so the Details button can render its view"
);

assert.match(adminHtml, /id="folder-breadcrumbs"/, "Drive browser exposes real breadcrumbs");
assert.match(adminHtml, /id="folder-select-current"/, "Drive browser has an explicit Select this folder action");
assert.match(adminJs, /function selectDriveFolder\(/, "folder selection is separate from opening a folder");
assert.match(adminJs, /function updateCreateButtonLabel\(/, "create CTA reflects the selected destination");
assert.match(css, /\.folder-breadcrumbs\s*\{/, "Drive breadcrumbs are styled");

assert.match(adminHtml, /value="auto"[^>]*checked/, "smart automatic parallelism is the recommended default");
assert.match(adminHtml, /value="balanced"/, "balanced preset is available");
assert.match(adminHtml, /value="maximum"/, "maximum preset is available");
assert.match(adminJs, /adaptiveConcurrency:\s*value\("f-adaptive"\)\s*===\s*"1"/, "adaptive mode is saved with the link");

await import(new URL("../public/adaptive-concurrency.js", import.meta.url));
const createAdaptiveConcurrency = globalThis.createAdaptiveConcurrency;
assert.equal(typeof createAdaptiveConcurrency, "function", "adaptive concurrency controller is available to the uploader");

const controller = createAdaptiveConcurrency({ min: 2, max: 8, initial: 3, cooldownSamples: 2 });
assert.equal(controller.limit, 3);
controller.observe({ bps: 10_000_000, saturated: true });
controller.observe({ bps: 11_000_000, saturated: true });
assert.equal(controller.limit, 4, "healthy saturated uploads ramp up parallelism");
controller.observe({ bps: 9_000_000, saturated: true, errors: 1 });
assert.equal(controller.limit, 2, "network errors promptly reduce parallelism");
assert.equal(controller.seed({ effectiveType: "2g", downlink: 0.4 }), 2, "slow connections start conservatively");

console.log("admin workflow tests passed");
