// An image job must not do the same file twice, even when the runner lost
// its reports and forgot what it handled: a re-sent batch is not counted
// again, and a file this job already replaced is not re-encoded.
import assert from "node:assert/strict";
import { putImageResult, reportImageBatch } from "../src/images-run.js";

const kv = new Map();
const env = {
  GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r",
  KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, String(v)) },
};
const job = (mode) => ({ id: "img-1", status: "running", options: { mode, onlyIfSmaller: false }, files: [{ id: "orig", name: "a.jpg", size: 100, format: "jpeg", folderId: "folder", path: "Trip" }], items: [], progress: { done: 0, failed: 0, skipped: 0, bytesIn: 0, bytesOut: 0 } });
const jobs = () => JSON.parse(kv.get("images:jobs")).jobs;
let uploads = 0;
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  if (url.searchParams.get("fields") === "appProperties") return Response.json({ appProperties: { archivedFrom: "orig", archiveJob: "img-1" } });
  if (url.pathname.startsWith("/upload/")) { uploads += 1; return Response.json({ id: "new", size: "4" }); }
  return Response.json({ files: [] });
};
console.log = () => {};

// A re-sent batch counts once.
kv.set("images:jobs", JSON.stringify({ jobs: [job("copy")] }));
const batch = () => new Request("https://x/", { method: "POST", body: JSON.stringify({ done: [{ id: "orig", newId: "new", size: 4 }] }) });
await reportImageBatch(batch(), env, null, "img-1");
await reportImageBatch(batch(), env, null, "img-1");
assert.equal(jobs()[0].items.length, 1, "a re-sent batch adds no second item");
assert.equal(jobs()[0].progress.done, 1, "nor counts twice");

// A file this job already replaced is not replaced again.
kv.set("images:jobs", JSON.stringify({ jobs: [job("replace")] }));
const put = new Request("https://x/", { method: "PUT", headers: { "x-format": "jpeg" }, body: new Uint8Array([1, 2, 3, 4]) });
const res = await (await putImageResult(put, env, null, "img-1", "orig")).json();
assert.match(res.skipped || "", /already replaced/, "the second replace is a soft skip");
assert.equal(uploads, 0, "and nothing is uploaded");
process.stdout.write("image-idempotency-test: ok\n");
