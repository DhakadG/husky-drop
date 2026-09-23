// Adding a folder to a gallery share used to leave it unindexed (no counts,
// cover or warm previews) until the nightly run. A folder change now plans an
// index job right away; an edit that keeps the folders does not.
import assert from "node:assert/strict";
import { patchShare } from "../src/share-admin.js";
import { loadJobs } from "../src/share-index.js";

const kv = new Map();
const r2 = new Map();
const env = {
  GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r",
  KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, String(v)), delete: async (k) => void kv.delete(k) },
  MEDIA_BUCKET: {
    get: async (k) => (r2.has(k) ? { json: async () => JSON.parse(r2.get(k)), text: async () => r2.get(k) } : null),
    put: async (k, v) => void r2.set(k, String(v)),
    delete: async (k) => void r2.delete(k),
    list: async () => ({ objects: [], truncated: false }),
  },
};
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  return Response.json({ id: url.pathname.split("/").pop(), name: "Folder", mimeType: "application/vnd.google-apps.folder", files: [] });
};
console.log = () => {};
const ctx = { waitUntil: (p) => p?.catch?.(() => {}) };
kv.set("share:album", JSON.stringify({ slug: "album", label: "Album", mode: "gallery", folderIds: ["1AbCdEfGhIjKlMnOpQrStUvWxYz0123"], folderNames: ["A"] }));
const patch = (body) => patchShare(new Request("https://x/", { method: "PATCH", body: JSON.stringify(body) }), env, "album", ctx);
const jobs = () => loadJobs(env);

await patch({ label: "Renamed" });
assert.equal((await jobs()).length, 0, "an edit that keeps the folders plans nothing");
const res = await patch({ folders: ["1AbCdEfGhIjKlMnOpQrStUvWxYz0123", "1ZyXwVuTsRqPoNmLkJiHgFeDcBa9876"] });
assert.equal(res.status, 200);
assert.equal((await jobs())[0]?.trigger, "edit", "a folder change plans an index job");
process.stdout.write("share-edit-index-test: ok\n");
