// Image-preview runners PUT finished WebPs from eight shards at once. Each PUT
// used to read-modify-write share-previews:index, so concurrent PUTs lost
// each other's Drive ids and those previews 404'd. The Durable Object now
// applies them through serialBatches; checked with a KV that takes time.
import assert from "node:assert/strict";
import { serialBatches } from "../src/previews.js";
import { applySharePreviewPuts, sharePreviewIndex } from "../src/share-previews.js";

const kv = new Map();
const tick = () => new Promise((r) => setTimeout(r, 5));
const env = {
  KV: {
    get: async (k, t) => (await tick(), kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null),
    put: async (k, v) => { await tick(); kv.set(k, String(v)); },
    list: async () => ({ keys: [] }),
  },
};
const trashed = [];
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  trashed.push(url.pathname.split("/").pop());
  return Response.json({});
};
Object.assign(env, { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r" });

const queue = serialBatches((puts) => applySharePreviewPuts(env, puts));
await Promise.all(Array.from({ length: 16 }, (_, i) => queue({ id: `file-${i}`, r: "rev1", s: 10, d: `drive-${i}` })));
let index = await sharePreviewIndex(env);
assert.equal(Object.values(index.files).filter((f) => f.d).length, 16, "every PUT keeps its Drive id");

await queue({ id: "file-0", r: "rev2", s: 12, d: "drive-new" });
index = await sharePreviewIndex(env);
assert.equal(index.files["file-0"].d, "drive-new");
assert.ok(trashed.includes("drive-0"), "the replaced WebP is trashed");
process.stdout.write("share-preview-put-test: ok\n");
