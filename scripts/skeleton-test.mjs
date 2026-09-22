// The skeleton grammar: shapes must carry the stagger index and the restore
// must not wipe content that something else painted in the meantime.
import assert from "node:assert/strict";
import { showSkeleton, skelCards, skelFolders, skelLines, skelRows, skelTiles } from "../public/skeleton.js";

assert.equal((skelRows(5).match(/skel-row"/g) || []).length, 5, "skelRows makes n rows");
assert.ok(skelRows(2, 44).includes("height:44px"), "row height is honored");
assert.ok(skelRows(3).includes("--i:2"), "rows carry the stagger index");
assert.equal((skelLines(4).match(/skel-bone/g) || []).length, 4, "skelLines makes n lines");
assert.ok(!/width:(0|NaN)%/.test(skelLines(9)), "line widths stay sane past the width list");
assert.equal((skelCards(3).match(/skel-panel/g) || []).length, 3, "skelCards makes n panels");
assert.equal((skelTiles(7).match(/skel-tile"/g) || []).length, 7, "skelTiles makes n tiles");
assert.ok(!/flex-grow:undefined|width:NaNpx/.test(skelTiles(30)), "tile widths wrap past the width list");
assert.equal((skelFolders(4).match(/skel-folder"/g) || []).length, 4, "skelFolders makes n cards");

const host = { dataset: {}, innerHTML: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; } };
const restore = showSkeleton(host, "<b>bones</b>");
assert.equal(host.innerHTML, "<b>bones</b>", "the skeleton paints");
assert.equal(host.attrs["aria-busy"], "true", "and marks the host busy");
restore();
assert.equal(host.attrs["aria-busy"], undefined, "restore clears busy");

const first = showSkeleton(host, "<i>one</i>");
showSkeleton(host, "<i>two</i>");
first();
assert.equal(host.attrs["aria-busy"], "true", "a stale restore does not clear a newer skeleton");

assert.equal(showSkeleton(null, "x")(), undefined, "a missing host is a no-op");
console.log("skeleton tests passed");
