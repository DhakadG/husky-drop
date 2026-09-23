// Up to 20 video runner shards report at once. Each report used to
// read-modify-write previews:index in KV, so concurrent reports erased each
// other's finished previews, failure counts and run totals. The Durable
// Object now applies them through serialBatches; checked here with a KV
// whose reads and writes take time, as they do in production.
import assert from "node:assert/strict";
import { applyPreviewReports, previewIndex, serialBatches } from "../src/previews.js";

const kv = new Map();
let writes = 0;
const tick = () => new Promise((r) => setTimeout(r, 5));
const env = {
  KV: {
    get: async (k, t) => (await tick(), kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
    put: async (k, v) => { await tick(); writes++; kv.set(k, String(v)); },
  },
};
console.log = () => {};
const report = (shard) => ({ runId: "run-1", trigger: "manual", startedAt: 1, done: [{ id: `orig-${shard}`, name: `v${shard}.mp4`, size: 100, previewId: `prev-${shard}`, previewSize: 10 }], skipped: [{ id: `bad-${shard}`, name: `b${shard}.mov`, error: "boom" }] });

const queue = serialBatches((bodies) => applyPreviewReports(env, null, bodies));
await Promise.all(Array.from({ length: 12 }, (_, i) => queue(report(i))));

const index = await previewIndex(env);
assert.equal(Object.keys(index.files).length, 12, "every shard's finished preview is kept");
assert.equal(Object.keys(index.failed).length, 12, "and every failure");
assert.equal(index.runs[0].done, 12);
assert.equal(index.runs[0].skipped, 12);
assert.ok(writes < 12, `a burst is coalesced (${writes} writes for 12 reports)`);
// The share-index job's duration backfill goes through the same queue, so
// it neither loses a report landing at the same time nor is lost to one.
await Promise.all([
  queue({ durations: { "orig-0": { previewId: "prev-0", ms: 4200, w: 1280, h: 720 }, "orig-1": { previewId: "stale", ms: 9 } } }),
  queue(report(12)),
]);
const after = await previewIndex(env);
assert.equal(after.files["orig-0"].ms, 4200, "a backfilled duration lands");
assert.equal(after.files["orig-1"].ms, 0, "but not on an entry whose preview was replaced");
assert.ok(after.files["orig-12"], "and a report sent at the same time is kept");
process.stdout.write("preview-report-test: ok\n");
