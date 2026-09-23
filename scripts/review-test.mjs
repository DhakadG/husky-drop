#!/usr/bin/env node
// The review runner spends real money in Actions, so its plumbing is checked
// here against a fake Anthropic endpoint: every surface names files that
// exist, the prompts carry this repo's own rules, sharding covers every target
// exactly once, unchanged targets are skipped on a re-run, and the renderer
// turns results into the three documents a person works from.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fileReviewPrompt, surfaceReviewPrompt } from "./review/prompts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The fake API lives in this process, so the runner has to be spawned
// asynchronously - execFileSync would block the event loop that serves it.
const run = promisify(execFile);
const surfaces = JSON.parse(fs.readFileSync(path.join(root, "scripts/review/surfaces.json"), "utf8"));

// ---- surfaces point at real files ----
const covered = new Set();
for (const [key, surface] of Object.entries(surfaces)) {
  assert.ok(surface.title && surface.what, `${key} needs a title and a description`);
  for (const file of [...(surface.files || []), ...(surface.html || [])]) {
    assert.ok(fs.existsSync(path.join(root, file)), `surface ${key} names ${file}, which does not exist`);
    covered.add(file);
  }
}
// Every server module and admin/share/drop client module belongs to a surface;
// a new one that belongs nowhere is how a whole feature goes unreviewed.
const shouldBeCovered = execFileSync("git", ["ls-files", "src/*.js", "public/admin*.js", "public/share*.js", "public/drop*.js"], { cwd: root, encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .filter((f) => !/share-(beacon|trekker|fx|utils|access)\.js|share-video-session\.js|admin-chart\.js|src\/index\.js/.test(f));
const orphans = shouldBeCovered.filter((f) => !covered.has(f));
assert.deepEqual(orphans, [], `these modules belong to no surface in surfaces.json: ${orphans.join(", ")}`);

// ---- prompts carry the repo's rules, not generic advice ----
const filePrompt = fileReviewPrompt({ path: "src/demo.js", role: "a demo", imports: ["util.js"], importedBy: ["worker.js"], source: "   1 | const x = 1;", context: "CONTEXT" });
for (const needle of ["compare-and-set", "esc()", "waitUntil", "JSON only", "src/demo.js", "will be discarded"]) {
  assert.ok(filePrompt.includes(needle), `the file prompt must mention ${needle}`);
}
assert.ok(/React, TypeScript/.test(filePrompt), "the prompt must rule out framework suggestions");

const surfacePrompt = surfaceReviewPrompt({ title: "T", what: "W", api: ["/api/x"], files: "FILES", context: "CONTEXT" });
for (const needle of ["missing_features", "interlinks", "dead end", "Is it organised?"]) {
  assert.ok(surfacePrompt.includes(needle), `the surface prompt must ask about ${needle}`);
}

// ---- sharding covers everything exactly once ----
const shards = 8;
const seen = new Map();
for (let shard = 0; shard < shards; shard++) {
  const out = execFileSync(process.execPath, ["scripts/review/run.mjs", "--mode", "file", "--dry", "--shards", String(shards), "--shard", String(shard), "--out", path.join(os.tmpdir(), `review-shard-${shard}`)], { cwd: root, encoding: "utf8" });
  for (const [, target] of out.matchAll(/^~ (\S+):/gm)) seen.set(target, (seen.get(target) || 0) + 1);
}
const duplicated = [...seen.entries()].filter(([, n]) => n !== 1);
assert.deepEqual(duplicated, [], `sharding must cover each file once: ${JSON.stringify(duplicated)}`);
assert.ok(seen.size > 100, `expected the whole repo to be in scope, got ${seen.size} files`);
assert.ok(!seen.has("public/vendor/gsap.min.js"), "vendor bundles must not be reviewed");
assert.ok(seen.has("src/worker.js") && seen.has("public/share.js"), "the big modules must be in scope");

// ---- a real run against a fake endpoint ----
// The fake Anthropic API runs in this process; the runner child talks to it
// over localhost through a shim that repoints fetch.
const work = fs.mkdtempSync(path.join(os.tmpdir(), "review-run-"));
const reply = {
  content: [
    {
      text: JSON.stringify({
        verdict: "fine",
        findings: [
          { severity: "critical", category: "correctness", lines: "10-12", title: "loses a write", scenario: "two tabs", consequence: "data gone", fix: "one key per writer", confidence: 0.9 },
          { severity: "low", category: "ux", lines: "4", title: "nit", scenario: "always", consequence: "meh", fix: "tidy", confidence: 0.5 },
        ],
        missing: ["a way to retry"],
        missing_features: [{ title: "Retry button", why: "a failed job strands", where: "Pipelines card", effort: "small", depends_on: "already available" }],
        interlinks: [{ from: "share card", to: "the Pipelines row", why: "saves hunting" }],
        layout: ["put running work first"],
      }),
    },
  ],
  usage: { input_tokens: 100, output_tokens: 50 },
};
let calls = 0;
const server = createServer((req, res) => {
  calls += 1;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(reply));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const shim = path.join(work, "shim.mjs");
fs.writeFileSync(
  shim,
  `const real = globalThis.fetch;
globalThis.fetch = (url, init) => real("http://127.0.0.1:${port}/v1/messages", init);
await import(${JSON.stringify(pathToFileURL(path.join(root, "scripts/review/run.mjs")).href)});
`,
);
const out = path.join(work, "out");
const runner = (args) => run(process.execPath, [shim, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, ANTHROPIC_API_KEY: "test" } });
await runner(["--mode", "file", "--only", "src/util.js", "--out", out]);

const saved = JSON.parse(fs.readFileSync(path.join(out, "src__util.js.json"), "utf8"));
assert.equal(saved.target, "src/util.js");
assert.equal(saved.findings.length, 2, "findings are stored");
assert.ok(fs.readFileSync(path.join(out, "src__util.js.md"), "utf8").includes("CRITICAL · loses a write"), "markdown leads with the worst finding");

const manifest = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
assert.ok(manifest["src/util.js"]?.fingerprint, "the manifest records a fingerprint");

// second run: unchanged content must cost nothing
const { stdout: again } = await runner(["--mode", "file", "--only", "src/util.js", "--out", out]);
assert.match(again, /= skip src\/util\.js \(unchanged/, "an unchanged file is skipped on a re-run");
assert.match(again, /0 reviewed, 1 skipped/, "and nothing is spent");

// ---- the renderer produces the three working documents ----
execFileSync(process.execPath, ["scripts/review/render.mjs", "--out", out], { cwd: root, encoding: "utf8" });
const index = fs.readFileSync(path.join(out, "INDEX.md"), "utf8");
const top = fs.readFileSync(path.join(out, "TOP.md"), "utf8");
const plan = fs.readFileSync(path.join(out, "PLAN.md"), "utf8");
assert.match(index, /1 targets reviewed · \*\*1 critical\*\*/, "the index counts severities");
assert.match(top, /CRITICAL · loses a write/, "TOP.md leads with critical findings");
assert.ok(!top.split("## Everything else")[0].includes("nit"), "low findings are demoted below the fold");
assert.match(plan, /Retry button/, "PLAN.md carries missing features");
assert.match(plan, /share card \| the Pipelines row/, "PLAN.md carries missing links");
assert.match(plan, /put running work first/, "PLAN.md carries layout changes");

// ---- the agent path: queue and mark ----
// A session without an API key does the reviewing itself, so the queue has to
// know what is left, and only count a target done when a review actually
// exists for it at its current content.
const queue = (extra) => execFileSync(process.execPath, ["scripts/review/queue.mjs", "--out", out, ...extra], { cwd: root, encoding: "utf8" });
assert.match(queue([]), /review queue \(all\): 1\/\d+ done/, "the queue counts the file reviewed above as done");
assert.match(queue(["--next", "1"]), /^surface	/, "surfaces are handed out before files");

const marked = spawnSync(process.execPath, ["scripts/review/mark.mjs", "public/skeleton.js", "--out", out, "--findings", "3"], { cwd: root, encoding: "utf8" });
assert.match(marked.stderr, /! no review written yet/, "marking without a review warns");
assert.match(marked.stdout, /marked file public\/skeleton\.js/, "and still records the fingerprint");
assert.ok(!queue([]).includes("[x] public/skeleton.js"), "and does not count as done, because no review exists");

fs.writeFileSync(path.join(out, "public__skeleton.js.json"), JSON.stringify({ target: "public/skeleton.js", mode: "file", findings: [] }));
assert.match(queue([]), /\[x\] public\/skeleton\.js/, "with both a review and a mark, it is done");

const stale = JSON.parse(fs.readFileSync(path.join(out, "manifest.json"), "utf8"));
stale["public/skeleton.js"].fingerprint = "0000000000000000";
fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(stale, null, 2));
assert.match(queue(["--stale"]), /public\/skeleton\.js/, "a changed file goes back on the board as stale");

assert.equal(calls, 1, "exactly one model call for one changed file");
server.close();
fs.rmSync(work, { recursive: true, force: true });
console.log(`review tooling checks passed (${Object.keys(surfaces).length} surfaces, ${seen.size} files in scope)`);
