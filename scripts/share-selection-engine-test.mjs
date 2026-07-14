import assert from "node:assert/strict";
import { createDragSelectionController } from "../public/share-selection-engine.js";

function createHarness(initialSelected = []) {
  const selected = new Set(initialSelected);
  const holds = new Map();
  const frames = new Map();
  let nextId = 1;
  let captured = 0;
  let released = 0;
  let scrolled = 0;
  let vibrated = 0;
  let hit = "a";

  const controller = createDragSelectionController({
    holdMs: 420,
    slopPx: 12,
    edgePx: 72,
    maxScrollPx: 18,
    isSelected: (id) => selected.has(id),
    setSelected: (id, on) => on ? selected.add(id) : selected.delete(id),
    hitTest: () => hit,
    scrollBy: (delta) => { scrolled += delta; },
    viewportHeight: () => 800,
    scheduleHold: (fn) => {
      const id = nextId++;
      holds.set(id, () => { holds.delete(id); fn(); });
      return id;
    },
    cancelHold: (id) => holds.delete(id),
    scheduleFrame: (fn) => {
      const id = nextId++;
      frames.set(id, () => { frames.delete(id); fn(); });
      return id;
    },
    cancelFrame: (id) => frames.delete(id),
    vibrate: () => { vibrated += 1; },
  });

  const down = (fileId = "a") => controller.pointerDown({
    pointerId: 7,
    x: 40,
    y: 400,
    fileId,
    capture: () => { captured += 1; },
    release: () => { released += 1; },
  });

  return {
    controller,
    down,
    selected,
    holds,
    frames,
    setHit: (value) => { hit = value; },
    values: () => ({ captured, released, scrolled, vibrated }),
  };
}

{
  const h = createHarness();
  h.down();
  assert.equal(h.controller.pointerMove({ pointerId: 7, x: 60, y: 400 }), false);
  assert.equal(h.holds.size, 0, "pre-hold movement cancels without selecting");
  assert.deepEqual([...h.selected], []);
}

{
  const h = createHarness();
  h.down();
  [...h.holds.values()][0]();
  assert.equal(h.controller.isActive(), true);
  assert.deepEqual([...h.selected], ["a"]);
  assert.equal(h.values().captured, 1);
  assert.equal(h.values().vibrated, 1);

  h.setHit("b");
  assert.equal(h.controller.pointerMove({ pointerId: 7, x: 80, y: 410 }), true);
  assert.deepEqual([...h.selected].sort(), ["a", "b"]);
  h.controller.pointerMove({ pointerId: 7, x: 82, y: 412 });
  assert.deepEqual([...h.selected].sort(), ["a", "b"], "re-entering a tile does not toggle twice");

  h.controller.pointerMove({ pointerId: 7, x: 82, y: 795 });
  assert.equal(h.frames.size, 1);
  [...h.frames.values()][0]();
  assert.ok(h.values().scrolled > 0, "bottom-edge drag auto-scrolls downward");
  assert.equal(h.controller.pointerUp(7), true);
  assert.equal(h.controller.isActive(), false);
  assert.equal(h.values().released, 1);
  assert.equal(h.frames.size, 0, "pointer release cancels edge scrolling");
}

{
  const h = createHarness(["c"]);
  h.setHit("c");
  h.down("c");
  [...h.holds.values()][0]();
  assert.equal(h.selected.has("c"), false, "starting on selected media creates deselect paint mode");
  h.controller.cancel();
}

{
  const h = createHarness();
  h.down();
  [...h.holds.values()][0]();
  assert.equal(h.controller.pointerMove({ pointerId: 99, x: 80, y: 410 }), false, "unrelated pointers are ignored");
  h.controller.cancel();
  assert.equal(h.values().released, 1, "cancel releases an active capture");
}

console.log("share selection engine checks passed");
