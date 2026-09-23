#!/usr/bin/env node
// Documentation rots quietly: a file gets renamed, a doc keeps pointing at the
// old name, and the next session trusts it. These checks make that a build
// failure instead of a wrong turn.
//
//  - every relative link in the current docs resolves
//  - CONTEXT.md still has the sections a session reads it for
//  - every path CONTEXT.md names actually exists
//  - everything parked in docs/archive is explained in its README
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const exists = (p) => fs.existsSync(path.join(root, p));

const docs = ["README.md", "CLAUDE.md", "docs/README.md", "docs/CONTEXT.md", "docs/RUNBOOK.md", "docs/archive/README.md"];
for (const doc of docs) assert.ok(exists(doc), `${doc} must exist`);

// ---- links resolve ----
for (const doc of [...docs, ...fs.readdirSync(path.join(root, "docs")).filter((f) => f.endsWith(".md")).map((f) => `docs/${f}`)]) {
  const dir = path.dirname(doc);
  for (const [, target] of read(doc).matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
    if (/^(https?:|mailto:|tel:)/.test(target)) continue;
    const resolved = path.posix.normalize(path.posix.join(dir === "." ? "" : dir, decodeURIComponent(target)));
    assert.ok(exists(resolved), `${doc} links to ${target}, which does not exist (${resolved})`);
  }
}

// ---- CLAUDE.md sends you to the primer ----
assert.match(read("CLAUDE.md"), /docs\/CONTEXT\.md/, "CLAUDE.md must point at docs/CONTEXT.md");

// ---- CONTEXT.md keeps its shape ----
const context = read("docs/CONTEXT.md");
for (const heading of [
  "## 1. What this is",
  "## 2. Stack and bindings",
  "## 3. Where things live",
  "## 4. How a request flows",
  "## 5. Data stores at a glance",
  "## 6. Conventions that are load-bearing",
  "## 7. Traps already hit",
  "## 8. SOP",
  "## 9. Probing production",
  "## 10. Where to look when",
]) {
  assert.ok(context.includes(heading), `docs/CONTEXT.md is missing section: ${heading}`);
}

// ---- every path CONTEXT.md names exists ----
// Full paths are checked as written. Bare file names inside the "Where things
// live" tables are resolved against the directory their section is about, so a
// renamed module fails here instead of quietly misleading the next session.
// Globs and brace groups (`share*.js`, `drop-{queue,render}.js`) are prose
// shorthand, not paths.
const named = new Map();
const isGlob = (t) => /[*{}<>]/.test(t);
let section = "";
for (const line of context.split(/\r?\n/)) {
  const heading = line.match(/^#{2,4} .*`((?:src|public|scripts|\.github)\/[^`]*)`/);
  if (heading) section = heading[1].replace(/\/$/, "");
  else if (/^#{2,4} /.test(line)) section = "";
  for (const [, token] of line.matchAll(/`([\w./-]+\.(?:js|mjs|md|json|jsonc|yml|svg|html|css))`/g)) {
    if (isGlob(token)) continue;
    if (/^(?:src|public|scripts|docs|\.github)\//.test(token)) named.set(token, line);
    // A bare name in a section is that section's file - unless it is one of
    // the repo-root files (wrangler.jsonc, package.json) a section mentions.
    else if (section && exists(`${section}/${token}`)) named.set(`${section}/${token}`, line);
    else if (exists(token)) named.set(token, line);
    else if (section) named.set(`${section}/${token}`, line);
  }
}
for (const token of named.keys()) {
  assert.ok(exists(token), `docs/CONTEXT.md names ${token}, which does not exist`);
}
assert.ok(named.size > 60, `expected CONTEXT.md to name the real files (found ${named.size})`);

// ---- the archive explains itself ----
const archiveIndex = read("docs/archive/README.md");
for (const entry of fs.readdirSync(path.join(root, "docs/archive"))) {
  if (entry === "README.md") continue;
  assert.ok(archiveIndex.includes(entry), `docs/archive/README.md does not say what ${entry} is`);
}

console.log(`docs checks passed (${named.size} paths named in CONTEXT.md, all present)`);
