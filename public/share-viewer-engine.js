// Deterministic state for the share lightbox. This module deliberately has no
// DOM or PhotoSwipe dependency so timing, cancellation and bandwidth policy can
// be exercised in Node before the browser integration changes.

export const ASSET_TIERS = Object.freeze(["empty", "base", "mid", "max", "full"]);
export const INTENT_STEPS = 6;
export const INTENT_STEP_MS = 1000;
export const RAPID_WINDOW_MS = 500;
export const RAPID_EVENT_COUNT = 4;
export const RAPID_SETTLE_MS = 260;

export const VIEWER_MOTION_MODES = Object.freeze([
  "fade",
  "soft-zoom",
  "zoom-in",
  "zoom-out",
  "scale-up",
  "slide-horizontal",
  "slide-vertical",
  "slide-up",
  "slide-down",
  "slide-left",
  "slide-right",
  "skew",
  "rotate",
  "rotate-left",
  "rotate-right",
  "flip-x",
  "flip-y",
  "blur",
  "brightness",
  "film-cut",
  "bounce",
  "swing",
]);

export function normalizeRotation(value) {
  return ((Number(value) || 0) % 360 + 360) % 360;
}

export function normalizeViewerMotion(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled === true,
    mode: VIEWER_MOTION_MODES.includes(source.mode) ? source.mode : "fade",
    speed: Math.max(80, Math.min(700, Number(source.speed) || 180)),
  };
}

export function createRapidSurfController(options = {}) {
  const now = options.now || (() => performance.now());
  const schedule = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;
  const onChange = options.onChange || (() => {});
  let events = [];
  let active = false;
  let held = false;
  let settleTimer = 0;

  const setActive = (next, reason) => {
    if (active === next) return;
    active = next;
    onChange({ active, reason });
  };

  const armSettle = (reason) => {
    cancelTimer(settleTimer);
    settleTimer = schedule(() => {
      settleTimer = 0;
      if (!held) setActive(false, reason);
    }, RAPID_SETTLE_MS);
  };

  return {
    note(reason = "navigation", isHeld = false) {
      const time = now();
      events = events.filter((value) => time - value <= RAPID_WINDOW_MS);
      events.push(time);
      held = held || isHeld;
      if (held || events.length >= RAPID_EVENT_COUNT) setActive(true, held ? "held" : reason);
      armSettle("quiet");
      return active;
    },
    release(reason = "release") {
      held = false;
      armSettle(reason);
    },
    cancel(reason = "cancel") {
      held = false;
      events = [];
      cancelTimer(settleTimer);
      settleTimer = 0;
      setActive(false, reason);
    },
    get active() {
      return active;
    },
  };
}

export function createAssetState(fileId) {
  return {
    fileId,
    tier: "empty",
    loading: "",
    intentStep: 0,
    intentSteps: INTENT_STEPS,
    rapid: false,
    error: "",
    failedTier: "",
    progress: 0,
  };
}

export function assetLampState(state) {
  if (state?.error) {
    const failedTier = state.failedTier || "preview";
    if (state.tier === "empty") {
      const label = failedTier === "base" ? "Base preview failed. Retry to load this image." : "Preview failed. Retry to load this image.";
      return { key: "failed", label };
    }
    const available = state.tier === "max" ? "Maximum preview" : state.tier === "mid" ? "Medium preview" : "Thumbnail";
    const failed = failedTier === "full" ? "Full resolution" : `${failedTier[0]?.toUpperCase() || "P"}${failedTier.slice(1)} preview`;
    return { key: "failed", label: `${failed} failed. ${available} remains available.` };
  }
  if (state?.loading === "full") return { key: "full-fetching", label: "Full resolution is loading" };
  if (state?.tier === "full") return { key: "full-ready", label: "Full resolution is ready" };
  if (state?.intentStep > 0) {
    return { key: "intent", label: `Full-resolution intent ${state.intentStep} of ${state.intentSteps || INTENT_STEPS}` };
  }
  if (state?.loading === "max") return { key: "max-fetching", label: "Maximum thumbnail is loading" };
  if (state?.tier === "max") return { key: "max-ready", label: "Maximum thumbnail is ready" };
  if (state?.loading === "mid") return { key: "mid-fetching", label: "Medium preview is loading" };
  if (state?.tier === "mid") return { key: "mid-ready", label: "Medium preview is ready" };
  if (state?.loading === "base") return { key: "base-fetching", label: "Thumbnail is loading" };
  if (state?.tier === "base") {
    return { key: "base-ready", label: state.rapid ? "Thumbnail-only rapid browsing" : "Thumbnail is ready" };
  }
  return { key: "empty", label: "Thumbnail is not ready" };
}

export function createViewerAssetEngine(options = {}) {
  if (typeof options.loadTier !== "function") throw new TypeError("loadTier is required");
  const schedule = options.setTimeout || setTimeout;
  const cancelTimer = options.clearTimeout || clearTimeout;
  const onChange = options.onChange || (() => {});
  const records = new Map();
  const pending = new Map();
  let activeId = "";
  let rapid = false;
  let intentTimer = 0;
  let intentOwner = "";
  let destroyed = false;

  const recordFor = (file) => {
    if (!file?.id) throw new TypeError("file.id is required");
    if (!records.has(file.id)) records.set(file.id, createAssetState(file.id));
    return records.get(file.id);
  };

  const snapshot = (record) => ({ ...record });
  const emit = (record) => {
    if (!destroyed) onChange(snapshot(record));
  };

  const stopIntent = () => {
    cancelTimer(intentTimer);
    intentTimer = 0;
    intentOwner = "";
  };

  const ensure = async (file, tier) => {
    if (destroyed) return false;
    const record = recordFor(file);
    const requestedIndex = ASSET_TIERS.indexOf(tier);
    if (requestedIndex < 1) throw new TypeError(`unsupported asset tier: ${tier}`);
    if (ASSET_TIERS.indexOf(record.tier) >= requestedIndex) return true;
    const key = `${file.id}:${tier}`;
    if (pending.has(key)) return pending.get(key);
    record.loading = tier;
    record.error = "";
    record.failedTier = "";
    record.progress = 0;
    emit(record);
    const promise = Promise.resolve()
      .then(() =>
        options.loadTier(file, tier, (progress) => {
          record.progress = Math.max(0, Math.min(1, Number(progress) || 0));
          emit(record);
        }),
      )
      .then(() => {
        if (destroyed) return false;
        record.tier = tier;
        record.loading = "";
        record.failedTier = "";
        record.progress = 1;
        if (tier === "full") record.intentStep = INTENT_STEPS;
        emit(record);
        return true;
      })
      .catch((error) => {
        if (destroyed) return false;
        record.loading = "";
        record.progress = 0;
        if (error?.name !== "AbortError") {
          record.error = String(error?.message || error || "asset failed");
          record.failedTier = tier;
        }
        emit(record);
        return false;
      })
      .finally(() => pending.delete(key));
    pending.set(key, promise);
    return promise;
  };

  const tickIntent = (file) => {
    if (destroyed || rapid || activeId !== file.id || intentOwner !== file.id) return stopIntent();
    const record = recordFor(file);
    record.intentStep = Math.min(INTENT_STEPS, record.intentStep + 1);
    emit(record);
    if (record.intentStep >= INTENT_STEPS) {
      stopIntent();
      void ensure(file, "full");
      return;
    }
    intentTimer = schedule(() => tickIntent(file), INTENT_STEP_MS);
  };

  const startIntent = (file) => {
    stopIntent();
    const record = recordFor(file);
    if (record.tier === "full") return;
    record.intentStep = 0;
    intentOwner = file.id;
    intentTimer = schedule(() => tickIntent(file), INTENT_STEP_MS);
  };

  return {
    async activate(file) {
      if (destroyed) return createAssetState(file?.id || "");
      if (activeId && activeId !== file.id) options.abort?.(activeId);
      activeId = file.id;
      stopIntent();
      const record = recordFor(file);
      record.rapid = rapid;
      record.intentStep = 0;
      emit(record);
      if (!(await ensure(file, "base"))) return snapshot(record);
      if (destroyed || activeId !== file.id || rapid) return snapshot(record);
      if (!(await ensure(file, "mid"))) return snapshot(record);
      if (destroyed || activeId !== file.id || rapid) return snapshot(record);
      if (!(await ensure(file, "max"))) return snapshot(record);
      if (destroyed || activeId !== file.id || rapid) return snapshot(record);
      startIntent(file);
      return snapshot(record);
    },
    setRapid(value) {
      rapid = Boolean(value);
      if (rapid) {
        stopIntent();
        if (activeId) options.abort?.(activeId, "rapid");
      }
      for (const record of records.values()) {
        record.rapid = rapid;
        if (record.fileId === activeId) emit(record);
      }
    },
    deactivate(fileId) {
      if (activeId === fileId) activeId = "";
      stopIntent();
      options.abort?.(fileId, "inactive");
    },
    ensureFull(file) {
      stopIntent();
      return ensure(file, "full");
    },
    seed(file, tier) {
      const record = recordFor(file);
      if (ASSET_TIERS.indexOf(tier) > ASSET_TIERS.indexOf(record.tier)) record.tier = tier;
      emit(record);
      return snapshot(record);
    },
    stateFor(file) {
      return snapshot(recordFor(file));
    },
    destroy() {
      if (destroyed) return;
      stopIntent();
      if (activeId) options.abort?.(activeId, "destroy");
      activeId = "";
      destroyed = true;
      options.destroy?.();
      records.clear();
      pending.clear();
    },
  };
}
