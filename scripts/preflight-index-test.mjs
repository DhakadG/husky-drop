// Preflight ("already in Drive?") used to match only the newest 200 recent
// rows in KV, so re-dropping an old folder uploaded everything again. The DO
// keeps a per-link index of every verified completion; checked here against
// real SQLite.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Analytics } from "../src/live-analytics.js";

const db = new DatabaseSync(":memory:");
const sql = { exec: (q, ...args) => { const st = db.prepare(q); const rows = /^\s*(SELECT|WITH)/i.test(q) ? st.all(...args) : (st.run(...args), []); return { toArray: () => rows }; } };
const exec = sql.exec;
sql.exec = (q, ...args) => (args.length || /^\s*SELECT/i.test(q) ? exec(q, ...args) : (db.exec(q), { toArray: () => [] }));

const a = new Analytics(sql);
a.init();
const metas = Array.from({ length: 1000 }, (_, i) => ({ f: `id${i}`, n: `IMG_${i}.jpg`, s: 1000 + i, lm: 5000 + i, at: 1_700_000_000_000 + i }));
a.recordCompleted("wedding", metas);
a.recordCompleted("wedding", metas.slice(0, 10)); // a retried flush is a no-op

const m = a.matchCompleted("wedding", [
  { name: "IMG_0.jpg", size: 1000, lastModified: 5000 }, // oldest, far past any recent cap
  { name: "IMG_999.jpg", size: 1999, lastModified: 0 }, // no lastModified: name + size decides
  { name: "IMG_5.jpg", size: 1005, lastModified: 1 }, // same name and size, different file
  { name: "IMG_6.jpg", size: 1 }, // size differs
]);
assert.deepEqual(m[0], { fileId: "id0", at: 1_700_000_000_000 });
assert.equal(m[1]?.fileId, "id999");
assert.equal(m[2], null, "a different lastModified is a different file");
assert.equal(m[3], null);
assert.equal(a.matchCompleted("other", [{ name: "IMG_0.jpg", size: 1000 }])[0], null, "scoped per link");
console.log("preflight-index-test: ok");
