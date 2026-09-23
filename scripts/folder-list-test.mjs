// The admin folder picker used to show only the first 100 subfolders; the
// rest could only be reached by pasting an ID. Pages are followed now.
import assert from "node:assert/strict";
import { driveListFolders } from "../src/drive.js";

const env = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", KV: { get: async () => null, put: async () => {} } };
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  const page = Number(url.searchParams.get("pageToken") || 0);
  return Response.json({ files: [{ id: `f${page}`, name: `Folder ${page}` }], ...(page < 2 ? { nextPageToken: String(page + 1) } : {}) });
};
const folders = await driveListFolders(env, "root");
assert.deepEqual(folders.map((f) => f.id), ["f0", "f1", "f2"], "every page is listed");
console.log("folder-list-test: ok");
