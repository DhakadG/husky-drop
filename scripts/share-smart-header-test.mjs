import assert from "node:assert/strict";
import { createSmartHeaderState } from "../public/share-smart-header.js";

const state = createSmartHeaderState();

assert.equal(state.update({ y: 40, stuck: false, enabled: true, locked: false }), false);
assert.equal(state.update({ y: 100, stuck: true, enabled: true, locked: false }), false);
assert.equal(state.update({ y: 105, stuck: true, enabled: true, locked: false }), false);
assert.equal(state.update({ y: 109, stuck: true, enabled: true, locked: false }), true);
assert.equal(state.update({ y: 108, stuck: true, enabled: true, locked: false }), true);
assert.equal(state.update({ y: 104, stuck: true, enabled: true, locked: false }), false);
assert.equal(state.update({ y: 130, stuck: true, enabled: true, locked: true }), false);
assert.equal(state.update({ y: 0, stuck: false, enabled: true, locked: false }), false);
assert.equal(state.reset(200), false);
assert.equal(state.update({ y: 220, stuck: true, enabled: false, locked: false }), false);

console.log("share smart header checks passed");
