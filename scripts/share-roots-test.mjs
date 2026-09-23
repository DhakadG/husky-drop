// A folder removed from a share kept root: true in the share's stats from
// earlier walks, so pruneUnreachable treated it as reachable forever.
import assert from "node:assert/strict";
import { dropRemovedRoots } from "../src/share-index.js";

const state = {
  folders: {
    A: { root: true, subfolders: ["A1"] },
    A1: { subfolders: [] },
    B: { root: true, subfolders: ["B1"] },
    B1: { subfolders: [] },
  },
  files: [{ id: "a", f: "A1" }, { id: "b", f: "B1" }, { id: "b0", f: "B" }],
};
dropRemovedRoots(state, ["A"]);
assert.deepEqual(Object.keys(state.folders).sort(), ["A", "A1"], "the removed root and its subtree are pruned");
assert.deepEqual(state.files.map((f) => f.id), ["a"], "with their files");

const kept = { folders: { A: { root: true, subfolders: [] } }, files: [{ id: "a", f: "A" }] };
dropRemovedRoots(kept, ["A"]);
assert.equal(kept.files.length, 1, "current roots are untouched");
console.log("share-roots-test: ok");
