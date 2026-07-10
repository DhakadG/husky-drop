import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const mockupRoot = new URL("docs/Personal Dropbox UI Redesign/redesign-package/", root);
const publicRoot = new URL("public/", root);

const extractPathData = (source) =>
  new Set([...source.matchAll(/<path\b[^>]*\bd=(["'])(.*?)\1/gs)].map((match) => match[2]));

const mockupFiles = (await readdir(mockupRoot)).filter((name) => name.endsWith(".dc.html")).sort();
const productionFiles = (await readdir(publicRoot)).filter((name) => name.endsWith(".html") || name.endsWith(".js"));
const productionSource = (
  await Promise.all(productionFiles.map((name) => readFile(new URL(name, publicRoot), "utf8")))
).join("\n");
const productionPaths = extractPathData(productionSource);

const missingByMockup = [];
for (const name of mockupFiles) {
  const source = await readFile(new URL(name, mockupRoot), "utf8");
  const missing = [...extractPathData(source)].filter((path) => !productionPaths.has(path));
  if (missing.length) missingByMockup.push(`${name}:\n${missing.map((path) => `  ${path}`).join("\n")}`);
}

assert.equal(
  missingByMockup.length,
  0,
  `Production is missing approved mockup icon geometry:\n${missingByMockup.join("\n")}`,
);

const adminSource = await readFile(new URL("admin.js", publicRoot), "utf8");
const sharedSource = await readFile(new URL("public.js", publicRoot), "utf8");
const css = await readFile(new URL("style.css", publicRoot), "utf8");

assert.match(adminSource, /class="stat-label"/, "Overview stat cards use an explicit label hook");
assert.doesNotMatch(adminSource, /querySelector\(["']div > span["']\)/, "stat labels never target the icon span structurally");
assert.match(sharedSource, /throw new Error\(`Unknown icon:/, "unknown dynamic icons fail loudly instead of rendering blank");
assert.match(css, /\.stat-card\.v3 \.stat-ico\s*\{[\s\S]*?margin-bottom:\s*0;/, "stat icon tiles reset legacy span spacing");
assert.match(css, /\.stat-card\.v3 \.stat-label\s*\{/, "stat label typography is scoped to the explicit label hook");

console.log(`icon audit passed (${mockupFiles.length} mockups, ${productionPaths.size} production paths)`);
