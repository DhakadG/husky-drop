import assert from "node:assert/strict";

let viewerEngine;
try {
  viewerEngine = await import("../public/share-viewer-engine.js");
} catch (error) {
  assert.fail(`share viewer engine must exist and import cleanly: ${error.message}`);
}

const {
  ASSET_TIERS,
  INTENT_STEPS,
  RAPID_EVENT_COUNT,
  RAPID_SETTLE_MS,
  RAPID_WINDOW_MS,
  assetLampState,
  createAssetState,
  createRapidSurfController,
  createViewerAssetEngine,
  normalizeRotation,
  normalizeViewerMotion,
} = viewerEngine;

function fakeClock() {
  let time = 0;
  let id = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimeout(fn, delay) {
      const key = ++id;
      timers.set(key, { at: time + delay, fn });
      return key;
    },
    clearTimeout(key) {
      timers.delete(key);
    },
    tick(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > end) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
      }
      time = end;
    },
    pending: () => timers.size,
  };
}

const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve();
};

assert.deepEqual(ASSET_TIERS, ["empty", "base", "mid", "max", "full"]);
assert.equal(INTENT_STEPS, 6);
assert.equal(RAPID_EVENT_COUNT, 4);
assert.equal(RAPID_WINDOW_MS, 500);
assert.equal(RAPID_SETTLE_MS, 260);

{
  const clock = fakeClock();
  const changes = [];
  const rapid = createRapidSurfController({ ...clock, onChange: (state) => changes.push(state) });
  for (let index = 0; index < 3; index++) {
    rapid.note("key");
    clock.tick(100);
  }
  assert.equal(rapid.active, false, "three moves must remain settled");
  rapid.note("key");
  assert.equal(rapid.active, true, "four moves inside 500ms must enter rapid mode");
  rapid.release("keyup");
  clock.tick(259);
  assert.equal(rapid.active, true, "release must retain rapid mode through debounce");
  clock.tick(1);
  assert.equal(rapid.active, false, "rapid mode must settle after 260ms");
  assert.deepEqual(changes.map(({ active }) => active), [true, false]);
}

{
  const clock = fakeClock();
  const rapid = createRapidSurfController({ ...clock });
  rapid.note("held-arrow", true);
  assert.equal(rapid.active, true, "a held control must enter rapid mode immediately");
  rapid.release("pointerup");
  clock.tick(RAPID_SETTLE_MS);
  assert.equal(rapid.active, false);
  rapid.note("old");
  clock.tick(RAPID_WINDOW_MS + 1);
  rapid.note("new");
  rapid.note("new");
  rapid.note("new");
  assert.equal(rapid.active, false, "events outside the rolling window must be discarded");
  rapid.cancel("destroy");
  assert.equal(clock.pending(), 0, "destroy must clear settle timers");
}

{
  const state = createAssetState("photo-1");
  assert.deepEqual(state, {
    fileId: "photo-1",
    tier: "empty",
    loading: "",
    intentStep: 0,
    intentSteps: 6,
    rapid: false,
    error: "",
    progress: 0,
  });
}

{
  const clock = fakeClock();
  const calls = [];
  const states = [];
  const engine = createViewerAssetEngine({
    ...clock,
    loadTier: async (file, tier) => calls.push(`${file.id}:${tier}`),
    onChange: (state) => states.push(state),
  });
  const file = { id: "photo-1" };
  await engine.activate(file);
  assert.deepEqual(calls, ["photo-1:base", "photo-1:mid", "photo-1:max"]);
  assert.equal(engine.stateFor(file).tier, "max");
  clock.tick(5999);
  await flush();
  assert.equal(calls.includes("photo-1:full"), false, "full resolution must not start before the six-second gate");
  clock.tick(1);
  await flush();
  assert.equal(calls.at(-1), "photo-1:full");
  assert.equal(engine.stateFor(file).tier, "full");
  assert.equal(states.some((state) => state.intentStep === 6), true);
  engine.destroy();
  assert.equal(clock.pending(), 0);
}

{
  const clock = fakeClock();
  const calls = [];
  const aborted = [];
  const engine = createViewerAssetEngine({
    ...clock,
    loadTier: async (file, tier) => calls.push(`${file.id}:${tier}`),
    abort: (fileId) => aborted.push(fileId),
  });
  const file = { id: "photo-2" };
  engine.setRapid(true);
  await engine.activate(file);
  assert.deepEqual(calls, ["photo-2:base"], "rapid mode must fetch Base only");
  engine.setRapid(false);
  await engine.activate(file);
  assert.deepEqual(calls, ["photo-2:base", "photo-2:mid", "photo-2:max"]);
  clock.tick(2500);
  engine.deactivate(file.id);
  clock.tick(5000);
  await flush();
  assert.equal(calls.includes("photo-2:full"), false, "leaving before intent completes must cancel Full");
  assert.equal(aborted.includes(file.id), true);
}

{
  const clock = fakeClock();
  const calls = [];
  const engine = createViewerAssetEngine({
    ...clock,
    loadTier: async (file, tier) => calls.push(`${file.id}:${tier}`),
  });
  const file = { id: "photo-3" };
  await engine.activate(file);
  await engine.ensureFull(file);
  assert.equal(calls.at(-1), "photo-3:full", "explicit Full intent must bypass the dwell timer");
}

{
  const clock = fakeClock();
  const resolvers = new Map();
  const calls = [];
  const engine = createViewerAssetEngine({
    ...clock,
    loadTier: (file, tier) => {
      calls.push(`${file.id}:${tier}`);
      return new Promise((resolve) => resolvers.set(`${file.id}:${tier}`, resolve));
    },
  });
  const first = { id: "first" };
  const second = { id: "second" };
  const firstActivation = engine.activate(first);
  await flush();
  const secondActivation = engine.activate(second);
  await flush();
  resolvers.get("first:base")();
  await flush();
  assert.equal(calls.includes("first:mid"), false, "stale activation must not promote an inactive slide");
  resolvers.get("second:base")();
  await flush();
  resolvers.get("second:mid")();
  await flush();
  resolvers.get("second:max")();
  await Promise.all([firstActivation, secondActivation]);
}

assert.equal(normalizeRotation(-90), 270);
assert.equal(normalizeRotation(630), 270);
assert.equal(normalizeRotation(360), 0);

assert.deepEqual(normalizeViewerMotion(null), { enabled: false, mode: "fade", speed: 180 });
assert.deepEqual(normalizeViewerMotion({ enabled: true, mode: "skew", speed: 20 }), { enabled: true, mode: "skew", speed: 80 });
assert.deepEqual(normalizeViewerMotion({ enabled: true, mode: "unknown", speed: 900 }), { enabled: true, mode: "fade", speed: 700 });

assert.deepEqual(assetLampState(createAssetState("x")), { key: "empty", label: "Thumbnail is not ready" });
assert.equal(assetLampState({ ...createAssetState("x"), loading: "base" }).key, "base-fetching");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "base" }).key, "base-ready");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "mid" }).key, "mid-ready");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "max" }).key, "max-ready");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "max", intentStep: 3 }).key, "intent");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "max", loading: "full" }).key, "full-fetching");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "full" }).key, "full-ready");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "max", error: "failed" }).key, "failed");

console.log("share viewer engine tests passed");
