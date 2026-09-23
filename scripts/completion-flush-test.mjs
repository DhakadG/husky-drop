// A completion batch whose KV write fails is retried. The retry must count
// each file exactly once: it used to write recent:<slug> first, so a failed
// stats write was retried as "already recorded" and the files never reached
// the link's counters or the day rollup.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Analytics } from "../src/live-analytics.js";
import { CompletionQueue } from "../src/live-completions.js";

const db = new DatabaseSync(":memory:");
const sql = { exec: (q, ...args) => { const st = db.prepare(q); const rows = /^\s*(SELECT|WITH)/i.test(q) ? st.all(...args) : (st.run(...args), []); return { toArray: () => rows }; } };
const exec = sql.exec;
sql.exec = (q, ...args) => (args.length || /^\s*SELECT/i.test(q) ? exec(q, ...args) : (db.exec(q), { toArray: () => [] }));
const analytics = new Analytics(sql);
analytics.init();

const kv = new Map();
let failOn = "";
const env = {
  KV: {
    get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null),
    put: async (k, v) => {
      if (failOn && k.startsWith(failOn)) { failOn = ""; throw new Error("KV write limit"); }
      kv.set(k, v);
    },
  },
};
const q = new CompletionQueue(env, analytics);
const batch = (slug, n) => ({ recents: Array.from({ length: n }, (_, i) => ({ f: `${slug}-${i}`, n: `f${i}.jpg`, s: 10, at: 1_700_000_000_000 + i })), label: slug });
const files = (slug) => JSON.parse(kv.get(`stats:${slug}`) || "{}").files;

for (const [slug, key] of [["a", "stats:"], ["b", "recent:"]]) {
  const pend = batch(slug, 3);
  failOn = key;
  await assert.rejects(q.flushOne(slug, pend));
  await q.flushOne(slug, pend); // the retry
  assert.equal(files(slug), 3, `a failed ${key} write is counted once on retry`);
  await q.flushOne(slug, pend); // a re-synced completion
  assert.equal(files(slug), 3, "and a re-sync never inflates it");
}
console.log("completion-flush-test: ok");
