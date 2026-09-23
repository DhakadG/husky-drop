#!/usr/bin/env node
// Record that a target has been reviewed at its current content, so
// queue.mjs stops offering it and notices when it changes later.
//
//   node scripts/review/mark.mjs src/share-index.js --findings 4
//   node scripts/review/mark.mjs admin-pipelines --mode surface --findings 7
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const surfaces = JSON.parse(fs.readFileSync(path.join(root, "scripts/review/surfaces.json"), "utf8"));

const argv = process.argv.slice(2);
const target = argv.find((a) => !a.startsWith("--"));
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
if (!target) {
  console.error("usage: mark.mjs <target> [--mode file|surface] [--findings n] [--out dir]");
  process.exit(1);
}

const mode = flag("mode", surfaces[target] ? "surface" : "file");
const OUT = path.resolve(root, flag("out", "review-out"));
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const parts =
  mode === "surface"
    ? [...(surfaces[target]?.files || []), ...(surfaces[target]?.html || [])].filter((f) => fs.existsSync(path.join(root, f)))
    : [target];
if (!parts.length) {
  console.error(`unknown target: ${target}`);
  process.exit(1);
}

const fingerprint = createHash("sha256").update(parts.map(read).join("\n")).digest("hex").slice(0, 16);
const manifestPath = path.join(OUT, "manifest.json");
fs.mkdirSync(OUT, { recursive: true });
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
manifest[target] = { fingerprint, at: Date.now(), findings: Number(flag("findings", 0)) || 0, by: "agent" };
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

const expected = path.join(OUT, `${target.replace(/[/\\]/g, "__")}.json`);
if (!fs.existsSync(expected)) console.warn(`! no review written yet at ${path.relative(root, expected)}`);
console.log(`marked ${mode} ${target} @ ${fingerprint}`);
