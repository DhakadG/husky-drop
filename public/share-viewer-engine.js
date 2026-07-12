// Deterministic state for the share lightbox. This module deliberately has no
// DOM or PhotoSwipe dependency so timing, cancellation and bandwidth policy can
// be exercised in Node before the browser integration changes.

export const ASSET_TIERS = Object.freeze(["base", "max", "full"]);
export const INTENT_STEPS = 6;
export const INTENT_STEP_MS = 1000;
export const RAPID_WINDOW_MS = 500;
export const RAPID_EVENT_COUNT = 4;
export const RAPID_SETTLE_MS = 260;

export function verifyFullAsset(details = {}) {
  const declaredBytes = Math.max(0, Number(details.declaredBytes) || 0);
  const blobBytes = Math.max(0, Number(details.blobBytes) || 0);
  const expectedPixels = Math.max(0, Number(details.expectedWidth) || 0) * Math.max(0, Number(details.expectedHeight) || 0);
  const actualPixels = Math.max(0, Number(details.actualWidth) || 0) * Math.max(0, Number(details.actualHeight) || 0);
  if (!declaredBytes || blobBytes !== declaredBytes) return false;
  return !expectedPixels || actualPixels >= expectedPixels * 0.92;
}

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
    tier: "base",
    presentedTier: "base",
    loading: "",
    intentStep: 0,
    intentSteps: INTENT_STEPS,
    rapid: false,
    error: "",
    failedTier: "",
    progress: 1,
    assetBytes: 0,
    assetWidth: 0,
    assetHeight: 0,
    verifiedFull: false,
    fullSupported: true,
  };
}

export function assetProgress(state) {
  if (!state) return 0;
  if (state.loading) return Math.max(0, Math.min(1, Number(state.progress) || 0));
  if (state.error) return Math.max(0.08, Math.min(1, Number(state.progress) || 0));
  if (state.presentedTier === "full" && state.verifiedFull) return 1;
  if (state.presentedTier === "max" && state.fullSupported === false) return 1;
  if (state.tier === "full" && state.presentedTier !== "full") return 1;
  if (state.intentStep > 0 || (state.tier === "max" && state.presentedTier === "max")) {
    return Math.max(0, Math.min(1, Number(state.intentStep) / (Number(state.intentSteps) || INTENT_STEPS)));
  }
  return 1;
}

function formatAssetBytes(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (!value) return "";
  const units = ["B", "KB", "MB", "GB"];
  const unit = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** unit;
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

export function assetLampState(state) {
  if (state?.error) {
    if (state.failedTier === "full") return { key: "failed", label: "Full resolution failed. High-resolution preview remains available." };
    return { key: "failed", label: "High-resolution preview failed. Tile thumbnail remains available." };
  }
  if (state?.loading === "full") return { key: "full-fetching", label: "Full resolution is loading" };
  if (state?.tier === "full" && state.presentedTier !== "full") return { key: "full-presenting", label: "Displaying verified full resolution" };
  if (state?.presentedTier === "full" && state.verifiedFull) {
    const dimensions = state.assetWidth && state.assetHeight ? ` · ${state.assetWidth}×${state.assetHeight}` : "";
    const bytes = formatAssetBytes(state.assetBytes);
    return { key: "full-ready", label: `Full resolution displayed${dimensions}${bytes ? ` · ${bytes}` : ""}` };
  }
  if (state?.intentStep > 0) {
    return { key: "intent", label: `Full-resolution intent ${state.intentStep} of ${state.intentSteps || INTENT_STEPS}` };
  }
  if (state?.loading === "max") return { key: "max-fetching", label: "High-resolution preview is loading" };
  if (state?.tier === "max" && state.presentedTier !== "max") return { key: "max-presenting", label: "Displaying high-resolution preview" };
  if (state?.presentedTier === "max") {
    return { key: "max-ready", label: state.fullSupported === false ? "High-resolution RAW preview displayed" : "High-resolution preview displayed" };
  }
  return { key: "base-ready", label: state?.rapid ? "Tile thumbnail · rapid browsing" : "Tile thumbnail displayed" };
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
    const record = records.get(file.id);
    record.fullSupported = options.canLoadFull?.(file) !== false;
    return record;
  };

  const snapshot = (record) => ({ ...record });
  const emit = (record) => {
    if (!destroyed) onChange(snapshot(record));
  };

  const applyAssetMeta = (record, asset = {}) => {
    record.assetBytes = Math.max(0, Number(asset.bytes) || 0);
    record.assetWidth = Math.max(0, Number(asset.width) || 0);
    record.assetHeight = Math.max(0, Number(asset.height) || 0);
    if (asset.verifiedFull === true) record.verifiedFull = true;
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
      .then((asset) => {
        if (destroyed) return false;
        applyAssetMeta(record, asset);
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
      if (options.canLoadFull?.(file) !== false) void ensure(file, "full");
      return;
    }
    intentTimer = schedule(() => tickIntent(file), INTENT_STEP_MS);
  };

  const startIntent = (file) => {
    stopIntent();
    const record = recordFor(file);
    if (record.tier === "full" || options.canLoadFull?.(file) === false) return;
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
      if (rapid) return snapshot(record);
      if (!(await ensure(file, "max"))) return snapshot(record);
      if (destroyed || activeId !== file.id || rapid) return snapshot(record);
      if (record.presentedTier === "max") startIntent(file);
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
      if (options.canLoadFull?.(file) === false) return Promise.resolve(false);
      return ensure(file, "full");
    },
    warm(file) {
      return ensure(file, "max");
    },
    confirmPresented(file, tier, asset = {}) {
      const record = recordFor(file);
      if (ASSET_TIERS.indexOf(tier) > ASSET_TIERS.indexOf(record.tier)) return snapshot(record);
      if (tier === "full" && asset.verifiedFull !== true && record.verifiedFull !== true) return snapshot(record);
      const upgraded = ASSET_TIERS.indexOf(tier) > ASSET_TIERS.indexOf(record.presentedTier);
      applyAssetMeta(record, asset);
      if (upgraded) record.presentedTier = tier;
      emit(record);
      if (upgraded && tier === "max" && activeId === file.id && !rapid) startIntent(file);
      return snapshot(record);
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
