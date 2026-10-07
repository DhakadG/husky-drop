// The preview migration uploaded twelve WebPs in parallel; each found no cached
// `_share_previews` id and no folder in Drive's lagging search, so each created
// one and prod grew eleven. Concurrent callers must now share one folder, and
// the merge must fold existing duplicates into the oldest.
import assert from "node:assert/strict";
import { driveEnsureFolder, driveMergeFolders } from "../src/drive.js";

const env = { GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r", KV: { get: async () => null, put: async () => {} } };
let files = [];
let seq = 0;
let searchLag = false;
const isFolder = (f) => f.mimeType === "application/vnd.google-apps.folder";
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  const method = init.method || "GET";
  const id = url.pathname.split("/files/")[1];
  if (method === "POST") {
    const body = JSON.parse(init.body);
    const f = { id: `n${++seq}`, name: body.name, mimeType: body.mimeType, parents: body.parents || ["root"], t: seq, visible: !searchLag };
    files.push(f);
    return Response.json({ id: f.id, name: f.name });
  }
  if (method === "PATCH") {
    const f = files.find((x) => x.id === id);
    if (url.searchParams.get("addParents")) f.parents = [url.searchParams.get("addParents")];
    if (init.body && JSON.parse(init.body).trashed) f.trashed = true;
    return Response.json({ id });
  }
  const q = url.searchParams.get("q");
  const parent = q.match(/'([^']+)' in parents/)?.[1];
  const name = q.match(/name='([^']+)'/)?.[1];
  const hits = files
    .filter((f) => f.visible && !f.trashed && (!name || f.name === name) && (!q.includes("folder'") || isFolder(f)) && (!parent || f.parents.includes(parent)))
    .sort((a, b) => a.t - b.t);
  const size = Number(url.searchParams.get("pageSize")) || 100;
  return Response.json({ files: hits.slice(0, size), ...(hits.length > size ? { nextPageToken: "more" } : {}) });
};

// Twelve concurrent callers in one isolate, search index lagging: one folder.
searchLag = true;
const ids = new Set((await Promise.all(Array.from({ length: 12 }, () => driveEnsureFolder(env, "_share_previews")))).map((f) => f.id));
assert.equal(ids.size, 1, "concurrent callers share one folder");
assert.equal(files.filter(isFolder).length, 1, "only one folder was created");

// A racer from another isolate that created its own copy yields to the oldest.
files = [{ id: "old", name: "_x", mimeType: "application/vnd.google-apps.folder", parents: ["root"], t: 0, visible: false }];
searchLag = false;
const origFetch = globalThis.fetch;
let finds = 0;
globalThis.fetch = (input, init) => {
  // first lookup misses (lag), then the oldest becomes visible
  if (!init?.method && String(input).includes("name%3D%27_x%27") && ++finds === 2) files[0].visible = true;
  return origFetch(input, init);
};
const won = await driveEnsureFolder(env, "_x");
assert.equal(won.id, "old", "the oldest folder wins");
assert.ok(files.find((f) => f.id !== "old" && f.name === "_x").trashed, "the losing copy is trashed");
globalThis.fetch = origFetch;

// Merge: children of every duplicate move into the oldest; dupes are trashed.
const folder = (id, t) => ({ id, name: "_share_previews", mimeType: "application/vnd.google-apps.folder", parents: ["root"], t, visible: true });
const file = (id, parent) => ({ id, name: `${id}.webp`, mimeType: "image/webp", parents: [parent], t: 99, visible: true });
files = [folder("a", 1), folder("b", 2), folder("c", 3), file("w1", "a"), file("w2", "b"), file("w3", "c"), file("w4", "c")];
const dry = await driveMergeFolders(env, "_share_previews", undefined, { dryRun: true });
assert.deepEqual([dry.keeper, dry.duplicates, dry.remaining, dry.moved], ["a", 2, 3, 0], "dry run only counts");
const partial = await driveMergeFolders(env, "_share_previews", undefined, { dryRun: false, limit: 2 });
assert.deepEqual([partial.moved, partial.trashed, partial.remaining], [2, 1, 1], "bounded: a half-moved folder is not trashed");
const done = await driveMergeFolders(env, "_share_previews", undefined, { dryRun: false });
assert.deepEqual([done.duplicates, done.remaining], [1, 0]);
assert.ok(files.filter((f) => f.mimeType === "image/webp").every((f) => f.parents[0] === "a"), "every file lives in the keeper");
assert.ok(files.filter((f) => f.id !== "a" && isFolder(f)).every((f) => f.trashed), "duplicates are trashed");
// A duplicate holding more than one listing page is never trashed with files inside.
files = [folder("a", 1), folder("big", 2), ...Array.from({ length: 1001 }, (_, i) => file(`x${i}`, "big"))];
const first = await driveMergeFolders(env, "_share_previews", undefined, { dryRun: false, limit: 1000 });
assert.deepEqual([first.moved, first.trashed], [1000, 0], "a folder with an unlisted page is kept");
const last = await driveMergeFolders(env, "_share_previews", undefined, { dryRun: false });
assert.deepEqual([last.moved, last.trashed, last.remaining], [1, 1, 0]);
console.log("drive-folder-race-test: ok");
