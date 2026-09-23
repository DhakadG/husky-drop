// The nightly identity stitch sent e-mail addresses and device/fingerprint
// ids to a third-party model. The prompt now carries opaque ids only, and
// the model's answer is mapped back to real keys on the Worker.
import assert from "node:assert/strict";
import { runIdentityStitch } from "../src/stitch.js";

let posted = null;
const people = [
  { key: "email:jane@example.com", emails: ["jane@example.com"], names: ["jane"], places: ["Pune"], devices: [{ id: "did-jane" }], links: [{ slug: "wedding" }], shares: [], first: 1, last: 2, uploads: 3 },
  { key: "device:did-secret-123", emails: [], names: ["jane"], places: ["Pune"], devices: [{ id: "did-secret-123" }], links: [{ slug: "wedding" }], shares: [], first: 1, last: 2, uploads: 0 },
];
const env = {
  GEMINI_API_KEY: "k",
  LIVE_TRACKER: {
    idFromName: () => "global",
    get: () => ({
      fetch: async (url, init) => {
        const u = String(url);
        if (u.includes("/people")) return Response.json({ people });
        if (u.includes("/sessions")) return Response.json({ sessions: [{ did: "did-secret-123", os: "Android", meta: { tz: "Asia/Kolkata" } }] });
        if (u.includes("/suggestions")) { posted = JSON.parse(init.body); return Response.json({ ok: true }); }
        return Response.json({ ok: true });
      },
    }),
  },
};
let prompt = "";
globalThis.fetch = async (url, init) => {
  prompt = JSON.parse(init.body).contents[0].parts[0].text;
  const text = JSON.stringify({ suggestions: [{ visit: "U1", account: "A1", confidence: 0.8, reason: "same name and place" }] });
  return Response.json({ candidates: [{ content: { parts: [{ text }] } }], usageMetadata: {} });
};
console.log = () => {};

await runIdentityStitch(env, null, { force: true });
assert.ok(!prompt.includes("jane@example.com"), "no e-mail address reaches the model");
assert.ok(!prompt.includes("did-secret-123"), "nor a device id");
assert.ok(prompt.includes("Pune") && prompt.includes('"U1"') && prompt.includes('"A1"'), "matching details and opaque ids do");
assert.deepEqual(posted.rows.map((r) => [r.key, r.email]), [["device:did-secret-123", "jane@example.com"]], "the answer maps back to real keys");
process.stdout.write("stitch-test: ok\n");
