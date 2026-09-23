// A redirect share's folder is made "anyone with the link" in Drive. When the
// revoke failed, the share still forgot the permission and the folder stayed
// public with no record to retry. Failed revokes are now kept and retried by
// the nightly cron, which skips folders a share has granted again since.
import assert from "node:assert/strict";
import { retryPendingRevokes, revokeSharePermissions } from "../src/share-admin.js";

const kv = new Map();
const env = {
  GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r",
  KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, String(v)), delete: async (k) => void kv.delete(k) },
};
let deleteStatus = 503;
const deleted = [];
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  if (init.method === "DELETE") { deleted.push(url.pathname.split("/")[4]); return new Response(null, { status: deleteStatus }); }
  return Response.json({});
};
console.error = () => {};
const pending = () => JSON.parse(kv.get("drive:revoke-pending") || "{}");

const share = { slug: "s1", mode: "redirect", permissionIds: { folderA: "anyoneWithLink", folderB: "anyoneWithLink" } };
await revokeSharePermissions(env, share);
assert.deepEqual(share.permissionIds, {});
assert.deepEqual(pending(), { folderA: "anyoneWithLink", folderB: "anyoneWithLink" }, "failed revokes are kept");

// folderB was granted again by another share; revoking it would cut that share off.
kv.set("shares:index", JSON.stringify(["s2"]));
kv.set("share:s2", JSON.stringify({ slug: "s2", mode: "redirect", permissionIds: { folderB: "anyoneWithLink" } }));
deleteStatus = 204;
deleted.length = 0;
await retryPendingRevokes(env, null);
assert.deepEqual(deleted, ["folderA"], "only the folder nobody holds is revoked");
assert.deepEqual(pending(), {}, "and nothing is left to retry");

deleteStatus = 404; // already gone counts as revoked
await revokeSharePermissions(env, { slug: "s3", permissionIds: { folderC: "p" } });
assert.deepEqual(pending(), {});
console.log("revoke-retry-test: ok");
