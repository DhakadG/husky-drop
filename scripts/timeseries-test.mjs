// The Overview chart's drop metrics must not include share traffic. Share
// rollups live in day_stats under "share:<slug>" with the same columns, and
// the series used to sum every slug: a guest's 4 GB ZIP showed up as 4 GB of
// "Data received". Checked against real SQLite and the in-memory pending path.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { Analytics } from "../src/live-analytics.js";

const db = new DatabaseSync(":memory:");
const sql = { exec: (q, ...args) => { const st = db.prepare(q); const rows = /^\s*(SELECT|WITH)/i.test(q) ? st.all(...args) : (st.run(...args), []); return { toArray: () => rows }; } };
// Multi-statement schema strings go through exec without params.
const exec = sql.exec;
sql.exec = (q, ...args) => (args.length || /^\s*SELECT/i.test(q) ? exec(q, ...args) : (db.exec(q), { toArray: () => [] }));

const a = new Analytics(sql);
a.init();
a.bumpDay("wedding", { opens: 3, sessions: 1, files: 5, bytes: 1000 });
a.bumpDay("share:album", { opens: 7, downloads: 2, bytes: 4_000_000 });
a.flushDays();
a.bumpDay("share:album", { downloads: 1, bytes: 500 }); // still pending

const [today] = a.timeseries(1);
assert.equal(today.bytes, 1000, "Data received counts drop uploads only");
assert.equal(today.opens, 3, "Link opens counts drop links only");
assert.equal(today.files, 5);
assert.equal(today.shareOpens, 7, "gallery opens get their own series");
assert.equal(today.downloads, 3, "downloads include the pending share delta");
assert.equal(today.servedBytes, 4_000_500);
console.log("timeseries-test: ok");
