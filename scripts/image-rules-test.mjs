// Pausing or enabling a recurring image rule must not change what it does.
// The toggle used to re-post the stored options, whose regex lives under
// `excludeRe` while the normaliser only read `exclude` - so every toggle
// silently dropped the rule's name exclusions (and auto-confirmed REPLACE).
import assert from "node:assert/strict";
import { upsertImageRule, listImageRules } from "../src/images-rules.js";
import { reportImageBatch } from "../src/images-run.js";
import { readFileSync } from "node:fs";

const kv = new Map();
const env = { KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, String(v)) } };
const post = (body) => new Request("https://drop.test/api/admin/images/rules", { method: "POST", body: JSON.stringify(body) });
const log = console.log;
console.log = () => {}; // appLog falls back to console without a Durable Object

const created = await (await upsertImageRule(post({ name: "Nightly", options: { folderIds: ["f1"], excludeFolderIds: ["f2"], exclude: "_edited|\\.psd$", mode: "replace" }, confirm: "REPLACE" }), env)).json();
const id = created.rule.id;
assert.equal(created.rule.options.excludeRe, "_edited|\\.psd$");

let res = await upsertImageRule(post({ id, enabled: false }), env);
assert.equal(res.status, 200, "a replace rule can be paused without re-typing REPLACE");
res = await upsertImageRule(post({ id, enabled: true }), env);
let rule = (await (await listImageRules(env)).json()).rules[0];
assert.equal(rule.enabled, true);
assert.equal(rule.options.excludeRe, "_edited|\\.psd$", "toggling keeps the exclude regex");
assert.deepEqual(rule.options.excludeFolderIds, ["f2"], "and the excluded folders");

// An older client re-posting the stored options must not lose it either.
await upsertImageRule(post({ ...rule, confirm: "REPLACE" }), env);
rule = (await (await listImageRules(env)).json()).rules[0];
assert.equal(rule.options.excludeRe, "_edited|\\.psd$", "re-saving stored options keeps the regex");

// Gain-map HDR photos are kept as they are: the archive runner must check
// for them (sharp would flatten them to SDR), and the worker counts that as
// a deliberate skip, not a failure.
assert.match(readFileSync(new URL("./transcode-images.mjs", import.meta.url), "utf8"), /await hasGainMap\(input, file\)/, "the archive runner checks for gain-map HDR before encoding");
kv.set("images:jobs", JSON.stringify({ jobs: [{ id: "img-1", status: "running", options: { mode: "archive" }, files: [{ id: "a", size: 10, name: "IMG_1.jpg" }], items: [], progress: { done: 0, failed: 0, skipped: 0, bytesIn: 0, bytesOut: 0 } }] }));
const report = new Request("https://drop.test/x", { method: "POST", body: JSON.stringify({ skipped: [{ id: "a", error: "gain-map HDR: original kept" }] }) });
const progress = (await (await reportImageBatch(report, env, null, "img-1")).json()).progress;
assert.deepEqual([progress.skipped, progress.failed], [1, 0], "a kept HDR original is a skip, not a failure");

console.log = log;
console.log("image-rules-test: ok");
