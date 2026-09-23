// Undoing an archive job whose original cannot be moved back used to end
// with "undone" and the job marked undone, while the file sat in _archive/.
// The failure is now counted, the job stays retryable, and a retry clears it.
import assert from "node:assert/strict";
import { undoImageJob } from "../src/images-run.js";

const kv = new Map();
const env = {
  GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r",
  KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, String(v)) },
};
kv.set("images:jobs", JSON.stringify({ jobs: [{ id: "img-1", status: "done", options: { mode: "archive" }, files: [{ id: "orig", name: "a.jpg", folderId: "folder" }], items: [{ id: "orig", ok: true, newId: "copy" }], progress: {} }] }));

let moveFails = true;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  if (url.searchParams.get("fields") === "parents") return Response.json({ parents: ["archive"] });
  if (init.method === "PATCH" && url.searchParams.get("addParents") && moveFails) return new Response("forbidden", { status: 403 });
  return Response.json({});
};
console.log = () => {};
console.error = () => {};

let d = await (await undoImageJob(env, null, "img-1")).json();
assert.equal(d.failed, 1, "the file that could not be restored is counted");
assert.notEqual(d.status, "undone", "and the job is not marked undone");

moveFails = false;
d = await (await undoImageJob(env, null, "img-1")).json();
assert.equal(d.failed, 0);
assert.equal(d.status, "undone", "a retry finishes the undo");
process.stdout.write("image-undo-test: ok\n");
