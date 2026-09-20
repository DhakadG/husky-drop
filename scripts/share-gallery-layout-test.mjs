import assert from "node:assert/strict";
import { computeJustifiedRows, hoverZoomOrigin, positionPreview } from "../public/share-gallery-layout.js";

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

// Hover zoom: an edge tile grows inward instead of past the viewport.
const tile = { left: 8, right: 258, top: 300, bottom: 550, width: 250, height: 250 };
assert.equal(hoverZoomOrigin(tile, 1.5, 1600, 900), "left center");
assert.equal(hoverZoomOrigin({ ...tile, left: 1350, right: 1600 }, 1.5, 1600, 900), "right center");
assert.equal(hoverZoomOrigin({ ...tile, left: 600, right: 850, top: 10, bottom: 260 }, 1.5, 1600, 900), "center top");
assert.equal(hoverZoomOrigin({ ...tile, left: 600, right: 850 }, 1.5, 1600, 900), "center center");
assert.equal(hoverZoomOrigin(tile, 1, 1600, 900), "", "no zoom, no override");

// Hover card placement (loose-ends spec §3.3): right of the anchor, flip
// left when it would overflow, above when the bottom is short, below when
// flipping up would leave the top.
const card = { width: 300, height: 220 };
assert.deepEqual(positionPreview(card, { left: 100, right: 340, top: 200, bottom: 300 }, 1600, 900), { left: 348, top: 200 });
assert.deepEqual(positionPreview(card, { left: 1300, right: 1540, top: 200, bottom: 300 }, 1600, 900), { left: 992, top: 200 });
assert.deepEqual(positionPreview(card, { left: 100, right: 340, top: 780, bottom: 880 }, 1600, 900), { left: 348, top: 660 });
assert.deepEqual(positionPreview(card, { left: 100, right: 340, top: 4, bottom: 104 }, 1600, 300), { left: 348, top: 8 });

console.log("share gallery layout checks passed");
