// Media URLs carry a signature with no expiry. Taking a folder out of a share
// (or changing its PIN) used to leave every URL a guest had already loaded
// working for good. Such edits bump share.tokenEpoch, which retires them.
import assert from "node:assert/strict";
import { mediaSig, sigScope, verifyMediaSig } from "../src/share-token.js";
import { patchShare } from "../src/share-admin.js";

const kv = new Map();
const env = {
  SHARE_SIGNING_KEY: "k".repeat(48),
  KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, String(v)), delete: async (k) => void kv.delete(k) },
};
const A = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123";
const B = "1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876";
kv.set("share:album", JSON.stringify({ slug: "album", label: "Album", mode: "gallery", folderIds: [A, B], folderNames: ["A", "B"] }));
const share = () => JSON.parse(kv.get("share:album"));
const patch = (body) => patchShare(new Request("https://x/", { method: "PATCH", body: JSON.stringify(body) }), env, "album", null);

const oldSig = await mediaSig(env, sigScope(share()), "file-1");
assert.equal(await mediaSig(env, "album", "file-1"), oldSig, "epoch 0 signs exactly as before");

await patch({ label: "Renamed" });
assert.ok(await verifyMediaSig(env, sigScope(share()), "file-1", oldSig), "an unrelated edit keeps URLs valid");
await patch({ folders: [A] });
assert.equal(share().tokenEpoch, 1);
assert.equal(await verifyMediaSig(env, sigScope(share()), "file-1", oldSig), false, "removing a folder retires old URLs");
await patch({ folders: [A, B] });
assert.equal(share().tokenEpoch, 1, "adding a folder does not");
await patch({ pin: "4321" });
assert.equal(share().tokenEpoch, 2, "a PIN change does");
console.log("media-epoch-test: ok");
