// Activity cards built person keys in the browser without the People tab's
// merges, so a merged device's "profile" button found nobody. The tracker
// now attaches the resolved key `k` to every event it returns.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { LiveTracker } from "../src/live.js";
import { IDENTITY_SCHEMA, setAlias } from "../src/people.js";

const db = new DatabaseSync(":memory:");
const sql = { exec: (q, ...args) => { const st = db.prepare(q); const rows = /^\s*(SELECT|WITH)/i.test(q) ? st.all(...args) : (st.run(...args), []); return { toArray: () => rows }; } };
for (const s of [].concat(IDENTITY_SCHEMA)) db.exec(s);
setAlias(sql, "device:dev-1", "Jane@Example.com");

const t = Object.create(LiveTracker.prototype);
t.state = { storage: { sql } };
const [merged, plain] = t.withIdentity([{ t: "open", d: "dev-1", s: "wedding" }, { t: "open", d: "dev-2", s: "wedding" }]);
assert.equal(merged.k, "email:jane@example.com", "a merged device resolves to its person");
assert.equal(plain.k, "device:dev-2");
console.log("activity-person-key-test: ok");
