import assert from "node:assert/strict";
import { createSmartHeaderState } from "../public/share-smart-header.js";

const state = createSmartHeaderState({ hideDelta: 8, showDelta: 4 });

assert.equal(state.update({ y: 40, stuck: false, enabled: true, locked: false }).hidden, false);
assert.equal(state.update({ y: 100, stuck: true, enabled: true, locked: false }).hidden, false);
assert.equal(state.update({ y: 105, stuck: true, enabled: true, locked: false }).hidden, false);
assert.equal(state.update({ y: 109, stuck: true, enabled: true, locked: false }).hidden, true);
assert.equal(state.update({ y: 108, stuck: true, enabled: true, locked: false }).hidden, true);
assert.equal(state.update({ y: 104, stuck: true, enabled: true, locked: false }).hidden, false);
assert.equal(state.update({ y: 130, stuck: true, enabled: true, locked: true }).hidden, false);
assert.equal(state.update({ y: 0, stuck: false, enabled: true, locked: false }).hidden, false);
state.reset(200);
assert.equal(state.update({ y: 220, stuck: true, enabled: false, locked: false }).hidden, false);

console.log("share smart header checks passed");
