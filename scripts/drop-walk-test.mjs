// A dropped folder becomes files with their relative paths, in natural
// order; and when walking it fails, the drop still delivers the flat list
// instead of losing files.
import assert from "node:assert/strict";
import { filesFromDrop } from "../public/drop-walk.js";

const file = (name) => ({ name, size: 1 });
const fileEntry = (name, { fails = false } = {}) => ({
  isFile: true,
  isDirectory: false,
  file: (ok, no) => setTimeout(() => (fails ? no(new Error("NotReadableError")) : ok(file(name)))),
});
// readEntries hands children over in batches, then an empty batch.
const dirEntry = (name, children, { fails = false } = {}) => ({
  isFile: false,
  isDirectory: true,
  name,
  createReader: () => {
    let batches = [children.slice(0, 2), children.slice(2), []];
    return { readEntries: (ok, no) => setTimeout(() => (fails ? no(new Error("NotFoundError")) : ok(batches.shift() || []))) };
  },
});
const drop = (entries, flat) => ({ files: flat, items: entries.map((e) => ({ webkitGetAsEntry: () => e })) });

// A folder tree keeps its paths and comes back in natural order.
const tree = dirEntry("Trip", [fileEntry("IMG_10.jpg"), fileEntry("IMG_2.jpg"), dirEntry("Day 1", [fileEntry("a.heic")]), fileEntry("IMG_1.jpg")]);
const walked = await filesFromDrop(drop([tree], [file("flat.jpg")]));
assert.deepEqual(walked.map((x) => x.rel), ["Trip/Day 1/a.heic", "Trip/IMG_1.jpg", "Trip/IMG_2.jpg", "Trip/IMG_10.jpg"]);

// A directory that cannot be read: the flat list is delivered instead.
const flat = [file("one.jpg"), file("two.jpg")];
assert.deepEqual(await filesFromDrop(drop([dirEntry("Trip", [], { fails: true })], flat)), flat, "unreadable folder falls back to the flat list");

// A file inside the tree that cannot be read: same fallback, nothing silently lost.
assert.deepEqual(await filesFromDrop(drop([dirEntry("Trip", [fileEntry("ok.jpg"), fileEntry("bad.jpg", { fails: true })])], flat)), flat, "unreadable file falls back to the flat list");

// Old browsers without the entry API: the flat list.
assert.deepEqual(await filesFromDrop({ files: flat, items: [] }), flat);

console.log("drop walk tests passed");
