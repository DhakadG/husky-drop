// "dismiss" on a session that was still uploading deleted it, and the
// uploader's next progress frame re-created it a second later. Dismissed ids
// are now remembered for ten minutes and their frames are not stored.
import assert from "node:assert/strict";
import { LiveTracker } from "../src/live.js";

const t = Object.create(LiveTracker.prototype);
Object.assign(t, { state: { storage: { sql: null } }, sessions: new Map(), dismissed: new Map(), digests: { note() {} }, markDirty() {}, armAlarm: async () => {} });
const frame = { sessionId: "sess-1", slug: "wedding", uploader: "Riya", count: 10, done: 2, sent: 5, total: 100, state: "uploading" };

t.recordProgress(frame);
assert.ok(t.sessions.has("sess-1"));
const res = await t.fetch(new Request("https://live.internal/close", { method: "POST", body: JSON.stringify({ id: "sess-1" }) }));
assert.equal((await res.json()).closed, 1);
t.recordProgress({ ...frame, done: 3 });
assert.equal(t.sessions.has("sess-1"), false, "the next frame does not bring the card back");
t.dismissed.set("sess-1", Date.now() - 1);
t.recordProgress({ ...frame, done: 4 });
assert.ok(t.sessions.has("sess-1"), "after the hold expires the session shows again");
// A session that died mid-upload is listed as stopped when it is pruned,
// instead of vanishing from the Live tab.
Object.assign(t, { recentDone: [], state: { storage: { sql: null, put: async () => {} } } });
const dead = t.sessions.get("sess-1");
dead.state = "stale";
dead.lastSeen = 0;
t.prune();
assert.equal(t.sessions.has("sess-1"), false);
assert.equal(t.recentDone[0]?.stopped, true, "a pruned unfinished session is kept as stopped");
assert.equal(t.recentDone[0].count, 10);
console.log("live-dismiss-test: ok");
