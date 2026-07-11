#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");

for (const heading of [
  "## See it in action",
  "## Why Husky Drop",
  "## How it works",
  "## Security model",
  "## Quick start",
  "## Configuration",
  "## Project map",
  "## Documentation",
  "## Known limits",
]) {
  assert.ok(readme.includes(heading), `README is missing required section: ${heading}`);
}

assert.match(readme, /docs\/assets\/readme\/husky-drop-banner\.png/, "README uses the project hero banner");
assert.match(readme, /https:\/\/dropbox\.losthusky\.qzz\.io\//, "README links to the live site");
assert.match(readme, /browser[^\n]{0,120}directly[^\n]{0,120}Google Drive/i, "README explains the direct-to-Drive data path");
assert.match(readme, /wrangler\.example\.jsonc/, "README tells self-hosters to start from the safe Wrangler example");
assert.doesNotMatch(readme, /\b(?:TBD|TODO|FIXME)\b/, "README contains no unfinished placeholders");
assert.doesNotMatch(readme, /(?:ghanisht|gmail\.com|REDACTED_DRIVE_PARENT_ID)/i, "README contains no personal data or real Drive folder ID");
assert.doesNotMatch(
  readme,
  /(?:provides?|includes?|uses?|supports?|offers?)\s+end-to-end encrypt/i,
  "README must not claim end-to-end encryption",
);
assert.match(
  readme,
  /not end-to-end encryption/i,
  "README must state the encryption boundary",
);

const localTargets = new Set();
for (const match of readme.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/g)) {
  const target = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
  if (target && !/^(?:https?:|mailto:|#)/i.test(target)) localTargets.add(decodeURIComponent(target));
}
for (const match of readme.matchAll(/<(?:img|a)\b[^>]+(?:src|href)=["']([^"']+)["']/gi)) {
  const target = match[1].trim().split("#")[0];
  if (target && !/^(?:https?:|mailto:|#)/i.test(target)) localTargets.add(decodeURIComponent(target));
}
for (const target of localTargets) {
  const resolved = path.resolve(root, target);
  assert.ok(resolved.startsWith(root), `README target escapes the repository: ${target}`);
  assert.ok(fs.existsSync(resolved), `README local target does not exist: ${target}`);
}

for (const asset of ["husky-drop-banner.png", "admin-overview.png", "drop-page.png", "share-links.png"]) {
  const file = path.join(root, "docs", "assets", "readme", asset);
  assert.ok(fs.existsSync(file), `README asset is missing: ${asset}`);
  assert.ok(fs.statSync(file).size > 10_000, `README asset is unexpectedly small: ${asset}`);
  assert.ok(fs.statSync(file).size < 2_500_000, `README asset is too large for a repository landing page: ${asset}`);
}

console.log("README checks passed");
