import assert from "node:assert/strict";
import { computeJustifiedRows } from "../public/share-gallery-layout.js";

const items = [
  { id: "a", aspect: 1.5 },
  { id: "b", aspect: 0.75 },
  { id: "c", aspect: 2.4 },
  { id: "d", aspect: 1 },
  { id: "e", aspect: 1.2 },
];

const phone = computeJustifiedRows(items, {
  containerWidth: 320,
  gap: 3,
  targetHeight: 150,
  maxItems: 2,
  wideThreshold: 2.2,
});
assert.deepEqual(
  phone.map((row) => row.items.map((item) => item.id)),
  [["a", "b"], ["c"], ["d", "e"]],
);
assert.equal(phone[1].items[0].width, 320);
assert.ok(phone.every((row) => row.items.every((item) => item.width > 0 && item.height > 0)));

const desktop = computeJustifiedRows(items.slice(0, 4), {
  containerWidth: 1200,
  gap: 3,
  targetHeight: 250,
  maxItems: Infinity,
  wideThreshold: Infinity,
});
assert.deepEqual(
  desktop.flatMap((row) => row.items.map((item) => item.id)),
  ["a", "b", "c", "d"],
);
assert.ok(desktop.at(-1).height <= 250, "the final row never stretches above its target");

console.log("share gallery layout checks passed");
