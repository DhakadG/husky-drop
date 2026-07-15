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
  VIEWER_MOTION_MODES,
  assetProgress,
  assetLampState,
  createAssetState,
  createRapidSurfController,
  createViewerNavigationController,
  createViewerAssetEngine,
  normalizeRotation,
  normalizeViewerMotion,
  resolvePanelReturnTarget,
  restorePanelFocus,
  verifyFullAsset,
} = viewerEngine;

{
  const pending = [];
  const navigated = [];
  let current = 0;
  const controller = createViewerNavigationController({
    getCurrentIndex: () => current,
    getCurrentElement: () => ({ current }),
    getLength: () => 4,
    navigateImmediately: (index) => { current = index; navigated.push(index); },
    shouldTransition: () => true,
    exit: () => new Promise((resolve) => pending.push(resolve)),
    cancel: () => {},
  });
  controller.goTo(1);
  controller.goTo(2);
  pending[0](true);
  await Promise.resolve();
  assert.deepEqual(navigated, [], "a stale filmstrip transition cannot navigate after a newer request");
  pending[1](true);
  await Promise.resolve();
  assert.deepEqual(navigated, [2], "the latest filmstrip request wins exactly once");
}

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

{
  const desktopButton = { focus() {} };
  const mobileAction = { focus() {} };
  const mobileMore = { focus() {} };
  const panelControl = { focus() {} };
  const panel = { contains: (element) => element === panelControl };
  const mobileActions = { contains: (element) => element === mobileAction };
  assert.equal(resolvePanelReturnTarget({ activeElement: desktopButton }), desktopButton);
  assert.equal(resolvePanelReturnTarget({ activeElement: mobileAction, mobileActions, mobileMore }), mobileMore);
  assert.equal(
    resolvePanelReturnTarget({ activeElement: panelControl, panels: [panel], previousTarget: desktopButton }),
    desktopButton,
    "switching nested panels preserves the original invoker",
  );
}

{
  const panelControl = { focus() {} };
  const outside = { focus() {} };
  const panel = { contains: (element) => element === panelControl };
  const calls = [];
  const returnTarget = { isConnected: true, focus: (options) => calls.push(options) };
  assert.equal(restorePanelFocus({ activeElement: panelControl, panels: [panel], returnTarget }), true);
  assert.deepEqual(calls, [{ preventScroll: true }]);
  assert.equal(restorePanelFocus({ activeElement: outside, panels: [panel], returnTarget }), false);
  returnTarget.isConnected = false;
  assert.equal(restorePanelFocus({ activeElement: panelControl, panels: [panel], returnTarget }), false);
  assert.equal(calls.length, 1, "a detached invoker is never focused");
}

assert.deepEqual(ASSET_TIERS, ["base", "max", "full"]);
assert.equal(INTENT_STEPS, 6);
assert.equal(RAPID_EVENT_COUNT, 4);
assert.equal(RAPID_WINDOW_MS, 500);
assert.equal(RAPID_SETTLE_MS, 260);
assert.ok(VIEWER_MOTION_MODES.length >= 20, "the motion picker must expose at least 20 distinct effects");
assert.equal(new Set(VIEWER_MOTION_MODES).size, VIEWER_MOTION_MODES.length, "motion effects must be unique");

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
    tier: "base",
    presentedTier: "base",
    loading: "",
    intentStep: 0,
    intentSteps: 6,
    rapid: false,
    error: "",
    failedTier: "",
    progress: 1,
    assetBytes: 0,
    assetWidth: 0,
    assetHeight: 0,
    verifiedFull: false,
    fullSupported: true,
  });
}

{
  const clock = fakeClock();
  const calls = [];
  let fail = true;
  const engine = createViewerAssetEngine({
    ...clock,
    loadTier: async (file, tier) => {
      calls.push(`${file.id}:${tier}`);
      if (fail) throw new Error(`${tier} failed`);
    },
  });
  const file = { id: "broken-max" };
  await engine.activate(file);
  assert.deepEqual(calls, ["broken-max:max"], "a high-resolution preview failure must stop promotion");
  assert.equal(engine.stateFor(file).failedTier, "max");
  assert.equal(engine.stateFor(file).tier, "base");
  fail = false;
  await engine.activate(file);
  assert.deepEqual(calls, ["broken-max:max", "broken-max:max"], "retry must clear the failure and load only the high-resolution preview");
  assert.equal(engine.stateFor(file).failedTier, "");
  assert.equal(engine.stateFor(file).tier, "max");
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
  assert.deepEqual(calls, ["photo-1:max"]);
  assert.equal(engine.stateFor(file).tier, "max");
  assert.equal(engine.stateFor(file).presentedTier, "base", "decoded high resolution is not ready until the DOM confirms presentation");
  assert.equal(clock.pending(), 0, "full-resolution intent must wait until high resolution is visibly presented");
  engine.confirmPresented(file, "max", { width: 1600, height: 1067, bytes: 350000 });
  clock.tick(5999);
  await flush();
  assert.equal(calls.includes("photo-1:full"), false, "full resolution must not start before the six-second gate");
  clock.tick(1);
  await flush();
  assert.equal(calls.at(-1), "photo-1:full");
  assert.equal(engine.stateFor(file).tier, "full");
  assert.equal(engine.stateFor(file).presentedTier, "max");
  assert.equal(assetLampState(engine.stateFor(file)).key, "full-presenting", "decoded Full must not be called ready before it is mounted");
  engine.confirmPresented(file, "full", { width: 6165, height: 4110, bytes: 26500000, verifiedFull: true });
  assert.equal(assetLampState(engine.stateFor(file)).key, "full-ready");
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
  assert.deepEqual(calls, [], "rapid mode must keep the already-cached tile thumbnail without fetching");
  engine.setRapid(false);
  await engine.activate(file);
  assert.deepEqual(calls, ["photo-2:max"]);
  engine.confirmPresented(file, "max");
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
  resolvers.get("first:max")();
  await flush();
  resolvers.get("second:max")();
  await Promise.all([firstActivation, secondActivation]);
}

{
  const clock = fakeClock();
  const calls = [];
  const engine = createViewerAssetEngine({ ...clock, loadTier: async (file, tier) => calls.push(`${file.id}:${tier}`) });
  const file = { id: "neighbor" };
  await engine.warm(file);
  assert.deepEqual(calls, ["neighbor:max"], "neighbor warming must cache only the high-resolution preview");
  assert.equal(clock.pending(), 0, "warming must never arm full-resolution intent");
}

assert.equal(normalizeRotation(-90), 270);
assert.equal(normalizeRotation(630), 270);
assert.equal(normalizeRotation(360), 0);

assert.deepEqual(normalizeViewerMotion(null), { enabled: false, mode: "fade", speed: 180 });
assert.deepEqual(normalizeViewerMotion({ enabled: true, mode: "skew", speed: 20 }), { enabled: true, mode: "skew", speed: 80 });
assert.deepEqual(normalizeViewerMotion({ enabled: true, mode: "unknown", speed: 900 }), { enabled: true, mode: "fade", speed: 700 });

assert.equal(assetLampState({ ...createAssetState("x"), tier: "base" }).key, "base-ready");
assert.equal(assetLampState({ ...createAssetState("x"), loading: "max", progress: 0.45 }).key, "max-fetching");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "max", presentedTier: "base" }).key, "max-presenting");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "max", presentedTier: "max" }).key, "max-ready");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "max", presentedTier: "max", intentStep: 3 }).key, "intent");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "max", loading: "full" }).key, "full-fetching");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "full", presentedTier: "max" }).key, "full-presenting");
assert.equal(assetLampState({ ...createAssetState("x"), tier: "full", presentedTier: "full", verifiedFull: true }).key, "full-ready");
assert.deepEqual(assetLampState({ ...createAssetState("x"), error: "failed", failedTier: "max" }), {
  key: "failed",
  label: "High-resolution preview failed. Tile thumbnail remains available.",
});
assert.deepEqual(assetLampState({ ...createAssetState("x"), tier: "max", presentedTier: "max", error: "failed", failedTier: "full" }), {
  key: "failed",
  label: "Full resolution failed. High-resolution preview remains available.",
});
assert.equal(assetProgress(createAssetState("x")), 1);
assert.equal(assetProgress({ ...createAssetState("x"), loading: "max", progress: 0.42 }), 0.42);
assert.equal(assetProgress({ ...createAssetState("x"), tier: "max", presentedTier: "max", intentStep: 3 }), 0.5);
assert.equal(assetProgress({ ...createAssetState("x"), tier: "max", presentedTier: "max", fullSupported: false }), 1);
assert.equal(assetProgress({ ...createAssetState("x"), tier: "full", presentedTier: "full", verifiedFull: true }), 1);

assert.equal(verifyFullAsset({ declaredBytes: 26500000, blobBytes: 26500000, expectedWidth: 6165, expectedHeight: 4110, actualWidth: 6165, actualHeight: 4110 }), true);
assert.equal(verifyFullAsset({ declaredBytes: 26500000, blobBytes: 4500000, expectedWidth: 6165, expectedHeight: 4110, actualWidth: 6165, actualHeight: 4110 }), false, "a resized payload with full dimensions metadata must not pass the byte proof");
assert.equal(verifyFullAsset({ declaredBytes: 26500000, blobBytes: 26500000, expectedWidth: 6165, expectedHeight: 4110, actualWidth: 1600, actualHeight: 1067 }), false, "a thumbnail payload with original byte metadata must not pass the pixel proof");
assert.equal(verifyFullAsset({ declaredBytes: 0, blobBytes: 26500000, expectedWidth: 6165, expectedHeight: 4110, actualWidth: 6165, actualHeight: 4110 }), false, "the original byte proof is required");

console.log("share viewer engine tests passed");
