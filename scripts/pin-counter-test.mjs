// Wrong PINs used to cost two KV writes each (per-IP and per-link counters),
// so scripted guessing could burn the whole daily KV write budget. With the
// Durable Object bound, attempts are counted there and KV is written only
// when a lockout starts.
import assert from "node:assert/strict";
import { gatePin } from "../src/store.js";
import { makePinFields, LOCK_ATTEMPTS } from "../src/util.js";

const kv = new Map();
const buckets = new Map();
const env = {
  KV: {
    get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
    put: async (k, v) => void kv.set(k, String(v)),
    delete: async (k) => void kv.delete(k),
  },
  // Same counting rule as LiveTracker.rateLimit; /event (logEvent) is ignored.
  LIVE_TRACKER: {
    idFromName: () => "global",
    get: () => ({
      fetch: async (url, init) => {
        const body = JSON.parse(init?.body || "{}");
        if (!String(url).endsWith("/ratelimit")) return Response.json({ ok: true });
        const b = buckets.get(body.key) || { count: 0 };
        b.count++;
        buckets.set(body.key, b);
        return Response.json({ allowed: b.count <= body.max, retryAfter: 0 });
      },
    }),
  },
};
const link = { slug: "wedding", label: "Wedding", ...(await makePinFields("1234")) };
const req = () => new Request("https://x/", { headers: { "cf-connecting-ip": "203.0.113.9" } });

for (let i = 1; i < LOCK_ATTEMPTS; i++) {
  const res = await gatePin(req(), env, link, "0000");
  assert.equal(res.status, 403, "wrong PIN");
}
const pinWrites = [...kv.keys()].filter((k) => k.startsWith("bf"));
assert.equal(pinWrites.length, 0, `no KV writes before the lockout (${pinWrites.join(",")})`);
const locked = await gatePin(req(), env, link, "0000");
assert.equal(locked.status, 429, "the fifth wrong PIN locks the IP out");
assert.ok(kv.has([...kv.keys()].find((k) => k.startsWith("bf:"))), "the lockout is recorded in KV");
assert.equal((await gatePin(req(), env, link, "1234")).status, 429, "even the right PIN waits out the lockout");
console.log("pin-counter-test: ok");
