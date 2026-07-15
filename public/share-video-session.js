function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function mediaPlaybackError(video) {
  const code = Number(video.error?.code) || 0;
  if (code === 4) return Object.assign(new Error("This video format or codec is not supported by this browser."), { kind: "codec" });
  if (code === 3) return Object.assign(new Error("This video could not be decoded by this browser."), { kind: "codec" });
  if (code === 2) return Object.assign(new Error("The video stream was interrupted."), { kind: "network" });
  return Object.assign(new Error("Video playback failed."), { kind: "playback" });
}

export function projectVideoTimeline({ currentTime, duration, ended }) {
  const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const mediaTime = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
  const safeTime = safeDuration ? (ended ? safeDuration : Math.min(mediaTime, safeDuration)) : 0;
  return {
    currentTime: safeTime,
    duration: safeDuration,
  };
}

export function createVideoWarmLease({
  releaseDelay = 500,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onRelease = () => {},
} = {}) {
  let source = "";
  let timer = null;
  const owners = new Set();
  const cancelRelease = () => {
    if (timer == null) return;
    clearTimer(timer);
    timer = null;
  };
  const scheduleRelease = () => {
    cancelRelease();
    if (!source || owners.size) return;
    timer = setTimer(() => {
      timer = null;
      if (owners.size || !source) return;
      const released = source;
      source = "";
      onRelease(released);
    }, releaseDelay);
  };
  return {
    remember(nextSource) {
      if (nextSource) source = String(nextSource);
      cancelRelease();
      return source;
    },
    claim(owner) {
      owners.add(owner);
      cancelRelease();
      return source;
    },
    release(owner) {
      owners.delete(owner);
      scheduleRelease();
    },
    scheduleRelease,
    sourceFor(isValid = () => true) {
      return source && isValid(source) ? source : "";
    },
  };
}

export function createVideoSession({ video, resolveSource, onState = () => {} }) {
  let state = "idle";
  let error = null;
  let active = false;
  let userPaused = false;
  let systemPausePending = false;
  let destroyed = false;
  let epoch = 0;
  let controller = null;
  let loadPromise = null;

  video.controls = false;
  video.playsInline = true;
  video.preload = "metadata";

  const snapshot = () => ({ state, error, errorKind: error?.kind || "", active, userPaused });
  const emit = (next, nextError = null) => {
    state = next;
    error = nextError;
    onState(snapshot());
  };
  const hasSource = () => typeof video.getAttribute === "function" ? Boolean(video.getAttribute("src")) : Boolean(video.src);
  const onPlay = () => {
    userPaused = false;
    emit("playing");
  };
  const onPause = () => {
    const systemPause = systemPausePending;
    systemPausePending = false;
    if (!systemPause && active && !video.ended) userPaused = true;
    if (!destroyed && state !== "error") emit(video.ended ? "ended" : "paused");
  };
  const onReady = () => {
    if (!destroyed && state !== "playing" && video.readyState >= 2) emit("ready");
  };
  const onError = () => {
    if (!destroyed && hasSource()) emit("error", mediaPlaybackError(video));
  };
  const listeners = [
    ["play", onPlay],
    ["pause", onPause],
    ["loadedmetadata", onReady],
    ["loadeddata", onReady],
    ["canplay", onReady],
    ["error", onError],
  ];
  for (const [name, handler] of listeners) video.addEventListener(name, handler);

  const pauseInternally = () => {
    if (video.paused) return;
    systemPausePending = true;
    video.pause();
  };

  const invalidateLoad = () => {
    epoch += 1;
    controller?.abort();
    controller = null;
    loadPromise = null;
    return epoch;
  };

  const load = (operation = epoch, force = false) => {
    if (destroyed) return Promise.reject(new Error("Video session is destroyed."));
    if (hasSource() && state !== "error") return Promise.resolve(video.src);
    if (loadPromise) return loadPromise;

    const request = new AbortController();
    controller = request;
    emit("loading");
    const pending = Promise.resolve()
      .then(() => resolveSource(request.signal, { force }))
      .then((source) => {
        if (destroyed || request.signal.aborted || operation !== epoch) throw abortError();
        video.src = source;
        video.load();
        if (video.readyState >= 2) emit("ready");
        return source;
      })
      .catch((cause) => {
        if (cause?.name !== "AbortError" && !destroyed && controller === request) {
          emit("error", cause instanceof Error ? cause : new Error(String(cause)));
        }
        throw cause;
      })
      .finally(() => {
        if (loadPromise === pending) loadPromise = null;
        if (controller === request) controller = null;
      });
    loadPromise = pending;
    return pending;
  };

  const playCurrent = async (operation) => {
    if (destroyed || !active || operation !== epoch) return;
    try {
      await video.play();
    } catch (cause) {
      if (operation !== epoch || !active) return;
      const playbackError = cause instanceof Error ? cause : new Error(String(cause));
      playbackError.kind ||= "policy";
      emit("error", playbackError);
      throw playbackError;
    }
  };

  return {
    load,
    async activate({ autoplay = false } = {}) {
      active = true;
      const operation = invalidateLoad();
      try {
        await load(operation);
      } catch (cause) {
        if (cause?.name === "AbortError") return;
        throw cause;
      }
      if (autoplay && !userPaused) await playCurrent(operation).catch(() => {});
    },
    async playFromUser() {
      userPaused = false;
      const operation = epoch;
      await load(operation);
      return playCurrent(operation);
    },
    deactivate() {
      active = false;
      invalidateLoad();
      pauseInternally();
    },
    pauseForVisibility() {
      pauseInternally();
    },
    async retry({ play = false, preserveTime = true } = {}) {
      if (destroyed) throw new Error("Video session is destroyed.");
      const resumeAt = preserveTime ? Math.max(0, Number(video.currentTime) || 0) : 0;
      const operation = invalidateLoad();
      video.removeAttribute("src");
      video.load();
      error = null;
      state = "idle";
      await load(operation, true);
      if (resumeAt && operation === epoch) {
        try {
          video.currentTime = resumeAt;
        } catch {
          video.addEventListener("loadedmetadata", () => {
            if (!destroyed && operation === epoch) video.currentTime = resumeAt;
          }, { once: true });
        }
      }
      if (play) await playCurrent(operation);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      invalidateLoad();
      pauseInternally();
      for (const [name, handler] of listeners) video.removeEventListener(name, handler);
      video.removeAttribute("src");
      video.load();
      emit("destroyed");
    },
    snapshot,
  };
}
