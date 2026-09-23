// A ban must reach the Durable Object with the exact id isBanned() will
// compare against. Fingerprint Pro visitor ids are mixed-case; lowercasing
// them made every fingerprint ban a no-op.
import assert from "node:assert/strict";
import { adminBans } from "../src/identity.js";

const sent = [];
const env = {
  LIVE_TRACKER: {
    idFromName: () => "live",
    get: () => ({ fetch: async (_url, init) => (sent.push(JSON.parse(init.body)), new Response('{"ok":true}')) }),
  },
};
const post = (body) => new Request("https://drop.test/api/admin/bans", { method: "POST", body: JSON.stringify(body) });

await adminBans(post({ kind: "fp", value: "8nDmJ7vkaSR2PQY0MfRW" }), env);
assert.equal(sent.at(-1).value, "8nDmJ7vkaSR2PQY0MfRW", "fingerprint ids keep their case");
await adminBans(post({ kind: "email", value: "Guest@Example.com" }), env);
assert.equal(sent.at(-1).value, "guest@example.com", "e-mails are still normalised");
console.log("identity-ban-test: ok");
