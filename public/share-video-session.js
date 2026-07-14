export function createVideoSession({ video, resolveSource, onState = () => {} }) {
  let state = "idle";
  let error = null;
  let active = false;
  let userPaused = false;
  let internalPause = false;
  let destroyed = false;
  let controller = null;
  let loadPromise = null;

  video.controls = true;
  video.playsInline = true;
  video.preload = "metadata";

  const snapshot = () => ({ state, error, active, userPaused });
  const emit = (next, nextError = null) => {
    state = next;
    error = nextError;
    onState(snapshot());
  };
  const onPlay = () => {
    userPaused = false;
    emit("playing");
  };
  const onPause = () => {
    if (!internalPause && active && !video.ended) userPaused = true;
    if (!destroyed && state !== "error") emit("paused");
  };
  const onLoadedData = () => {
    if (!destroyed && state !== "playing") emit("ready");
  };
  const onError = () => {
    if (!destroyed) emit("error", new Error("Video could not be played by this browser."));
  };
  const listeners = [
    ["play", onPlay],
    ["pause", onPause],
    ["loadeddata", onLoadedData],
    ["error", onError],
  ];
  for (const [name, handler] of listeners) video.addEventListener(name, handler);

  const pauseInternally = () => {
    if (video.paused) return;
    internalPause = true;
    video.pause();
    internalPause = false;
  };

  const load = () => {
    if (destroyed) return Promise.reject(new Error("Video session is destroyed."));
    if (video.src && state !== "error") return Promise.resolve(video.src);
    if (loadPromise) return loadPromise;

    controller?.abort();
    const request = new AbortController();
    controller = request;
    emit("loading");

    const pending = Promise.resolve()
      .then(() => resolveSource(request.signal))
      .then((source) => {
        if (destroyed || request.signal.aborted) throw new DOMException("Aborted", "AbortError");
        video.src = source;
        video.load();
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

  const playFromUser = async () => {
    userPaused = false;
    await load();
    try {
      return await video.play();
    } catch (cause) {
      const playbackError = cause instanceof Error ? cause : new Error(String(cause));
      emit("error", playbackError);
      throw playbackError;
    }
  };

  return {
    load,
    async activate({ autoplay = false } = {}) {
      active = true;
      await load();
      if (autoplay && !userPaused) await video.play().catch(() => {});
    },
    playFromUser,
    deactivate() {
      active = false;
      pauseInternally();
    },
    pauseForVisibility() {
      pauseInternally();
    },
    retry() {
      if (destroyed) return Promise.reject(new Error("Video session is destroyed."));
      controller?.abort();
      controller = null;
      loadPromise = null;
      video.removeAttribute("src");
      video.load();
      error = null;
      state = "idle";
      return load();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      active = false;
      controller?.abort();
      controller = null;
      loadPromise = null;
      pauseInternally();
      for (const [name, handler] of listeners) video.removeEventListener(name, handler);
      video.removeAttribute("src");
      video.load();
      emit("destroyed");
    },
    snapshot,
  };
}
