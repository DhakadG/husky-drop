// Share-index chunks of different shares run in parallel and each wrote back
// the whole job list it read at its start, so one job's "done" was
// overwritten with "running" and it stayed running for days (blocking the
// orphan sweep). Job changes are now ops applied to a fresh read, serialized
// by the Durable Object; checked with a KV whose calls take time.
import assert from "node:assert/strict";
import { serialBatches } from "../src/previews.js";
import { applyJobOps, loadJobs } from "../src/share-index.js";

const kv = new Map();
const tick = () => new Promise((r) => setTimeout(r, 5));
const env = {
  KV: {
    get: async (k, t) => (await tick(), kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
    put: async (k, v) => { await tick(); kv.set(k, String(v)); },
  },
};
const queue = serialBatches((ops) => applyJobOps(env, ops));
await queue({ add: { id: "a", slug: "alpha", status: "running" } });
await queue({ add: { id: "b", slug: "beta", status: "running" } });
await Promise.all([
  queue({ patch: { id: "a", status: "done", finishedAt: 1 } }),
  queue({ add: { id: "c", slug: "gamma", status: "running" } }),
  queue({ patch: { id: "b", status: "failed", error: "boom" } }),
]);
const jobs = await loadJobs(env);
const by = Object.fromEntries(jobs.map((j) => [j.id, j.status]));
assert.deepEqual(by, { a: "done", b: "failed", c: "running" }, "no finish is lost to a parallel add");
console.log("share-index-jobs-test: ok");
