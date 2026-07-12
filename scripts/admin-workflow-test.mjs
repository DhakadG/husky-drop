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
assert.match(adminHtml, /id="qr-copy"/, "QR handoff has an explicit copy action");
assert.match(adminHtml, /id="qr-download"/, "QR handoff can download a reusable QR asset");
assert.match(adminHtml, /id="qr-open"/, "QR handoff can open the destination for verification");
assert.match(adminHtml, /id="qr-share"/, "share QR handoff supports the device share sheet");
assert.match(adminHtml, /id="share-edit-dialog"/, "share links expose a complete edit dialog");
assert.match(adminHtml, /id="se-clear-pin"/, "share settings can explicitly remove an existing PIN");
assert.match(adminHtml, /id="f-auth"[^>]*checked/, "drop links can require Google sign-in before upload");
assert.match(adminJs, /openShareEditor\(/, "share cards can open the settings editor");
assert.match(adminJs, /function syncShareEditMode\(/, "share settings explain and constrain redirect-only differences");
assert.match(adminJs, /folderPickerMode\s*===\s*"share-edit"/, "the shared Drive picker also edits existing share links");
assert.match(css, /\.folder-browse-button\s*\{[\s\S]*?align-self:\s*end/, "Browse Drive aligns with its destination field");

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
