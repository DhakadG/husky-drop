#!/usr/bin/env node
// The work queue for a review done by an agent rather than by the API runner.
//
// A full pass is 150-odd targets and a session will compact several times
// before it finishes, so the state of the work lives here, on disk, not in
// anyone's head: what is left, what is done, and what the next thing is.
//
//   node scripts/review/queue.mjs            # the whole board
//   node scripts/review/queue.mjs --next     # the next target, and nothing else
//   node scripts/review/queue.mjs --next 5   # the next five
//   node scripts/review/queue.mjs --mode surface --next
//   node scripts/review/queue.mjs --stale    # done, but the file changed since
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const surfaces = JSON.parse(fs.readFileSync(path.join(root, "scripts/review/surfaces.json"), "utf8"));

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args.set(a.slice(2), next && !next.startsWith("--") ? (i++, next) : "true");
}
const MODE = args.get("mode") || "all";
const OUT = path.resolve(root, args.get("out") || "review-out");
const NEXT = args.has("next") ? Math.max(1, Number(args.get("next") === "true" ? 1 : args.get("next"))) : 0;

const SKIP = /^(public\/vendor\/|public\/icons\.svg|docs\/archive\/|docs\/assets\/|graphify-out\/|review-out\/)|\.(png|jpe?g|webm|mp4|mov|svg)$|package-lock\.json$/;
const CODE = /\.(js|mjs|css|html|jsonc?|yml)$/;
const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");

const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => CODE.test(f) && !SKIP.test(f));

// Biggest first: the large modules carry the most risk and are the ones you
// want reviewed while the session is fresh.
const fileTargets = files
  .map((f) => ({ mode: "file", key: f, bytes: fs.statSync(path.join(root, f)).size, fingerprint: sha(read(f)) }))
  .sort((a, b) => b.bytes - a.bytes);

const surfaceTargets = Object.entries(surfaces).map(([key, s]) => {
  const parts = [...(s.files || []), ...(s.html || [])].filter((f) => fs.existsSync(path.join(root, f)));
  return { mode: "surface", key, title: s.title, parts, fingerprint: sha(parts.map(read).join("\n")) };
});

const all = MODE === "file" ? fileTargets : MODE === "surface" ? surfaceTargets : [...surfaceTargets, ...fileTargets];

const manifestPath = path.join(OUT, "manifest.json");
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};
const hasOutput = (key) => fs.existsSync(path.join(OUT, `${key.replace(/[/\\]/g, "__")}.json`));

const state = (t) => {
  if (!hasOutput(t.key)) return "todo";
  return manifest[t.key]?.fingerprint === t.fingerprint ? "done" : "stale";
};

const todo = all.filter((t) => state(t) === "todo");
const stale = all.filter((t) => state(t) === "stale");
const done = all.filter((t) => state(t) === "done");

if (args.has("stale")) {
  for (const t of stale) console.log(`${t.mode}\t${t.key}`);
  process.exit(0);
}

if (NEXT) {
  for (const t of [...todo, ...stale].slice(0, NEXT)) {
    if (t.mode === "surface") console.log(`surface\t${t.key}\t${t.title}\n\tfiles: ${t.parts.join(" ")}`);
    else console.log(`file\t${t.key}\t${t.bytes} bytes`);
  }
  if (!todo.length && !stale.length) console.log("nothing left: every target is reviewed at its current content");
  process.exit(0);
}

const pct = all.length ? Math.round((done.length / all.length) * 100) : 0;
console.log(`review queue (${MODE}): ${done.length}/${all.length} done (${pct}%), ${todo.length} to do, ${stale.length} stale`);
console.log(`output: ${path.relative(root, OUT)}/\n`);
for (const group of ["surface", "file"]) {
  const rows = all.filter((t) => t.mode === group);
  if (!rows.length) continue;
  console.log(`--- ${group} ---`);
  for (const t of rows) {
    const mark = { done: "[x]", stale: "[~]", todo: "[ ]" }[state(t)];
    const findings = manifest[t.key]?.findings;
    console.log(`${mark} ${t.key}${findings != null ? ` (${findings} findings)` : ""}${t.bytes ? `  ${t.bytes}b` : ""}`);
  }
  console.log("");
}
if (stale.length) console.log(`${stale.length} target(s) changed since their review - re-review or accept them.`);
