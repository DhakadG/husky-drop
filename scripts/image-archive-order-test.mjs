// Archive mode must never move an original away unless its replacement is
// stored and verified. It used to move first, so a failed upload left the
// folder (and any share gallery on it) without the photo.
import assert from "node:assert/strict";
import { putImageResult } from "../src/images-run.js";

const kv = new Map();
const env = {
  GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r",
  KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, String(v)) },
};
kv.set("images:jobs", JSON.stringify({ jobs: [{ id: "img-1", status: "running", options: { mode: "archive", onlyIfSmaller: false }, files: [{ id: "orig", name: "IMG_1.jpg", size: 100, format: "jpeg", folderId: "folder", path: "Trip" }], items: [], progress: {} }] }));

const calls = [];
let uploadStatus = 500;
let parentOfOrig = "folder";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  if (url.pathname.startsWith("/upload/")) {
    calls.push("upload");
    return uploadStatus === 200 ? Response.json({ id: "new", size: "4" }) : new Response("boom", { status: uploadStatus });
  }
  if (method === "PATCH" && url.searchParams.get("addParents")) {
    calls.push("move");
    parentOfOrig = url.searchParams.get("addParents");
    return Response.json({});
  }
  if (method === "PATCH") { calls.push("trash"); return Response.json({}); }
  if (method === "POST") return Response.json({ id: "archive-folder", name: "x" }); // folder create
  if (url.searchParams.get("fields") === "parents") return Response.json({ parents: [parentOfOrig] });
  if (url.searchParams.get("q")?.includes("folder")) return Response.json({ files: [] }); // folder lookup
  return Response.json({ files: [] });
};
const put = () => new Request("https://drop.test/x", { method: "PUT", headers: { "x-format": "jpeg" }, body: new Uint8Array([1, 2, 3, 4]) });
console.error = () => {};

let res = await putImageResult(put(), env, null, "img-1", "orig");
assert.equal(res.status, 502, "a failed upload is reported");
assert.ok(!calls.includes("move"), "and the original never moved");

uploadStatus = 200;
calls.length = 0;
res = await putImageResult(put(), env, null, "img-1", "orig");
assert.equal(res.status, 200);
assert.ok(calls.indexOf("upload") < calls.indexOf("move"), "the original moves only after its replacement is stored");
console.log("image-archive-order-test: ok");
