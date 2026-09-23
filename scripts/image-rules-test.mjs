// Pausing or enabling a recurring image rule must not change what it does.
// The toggle used to re-post the stored options, whose regex lives under
// `excludeRe` while the normaliser only read `exclude` - so every toggle
// silently dropped the rule's name exclusions (and auto-confirmed REPLACE).
import assert from "node:assert/strict";
import { upsertImageRule, listImageRules } from "../src/images-rules.js";

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

console.log = log;
console.log("image-rules-test: ok");
