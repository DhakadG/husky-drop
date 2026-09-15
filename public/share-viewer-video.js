import { createVideoSession, projectVideoTimeline } from "./share-video-session.js";
import { fx, uiIcon } from "./share-state.js";
import { downloadFile, ensureFreshDownload, tokenFresh } from "./share-download.js";
import { adoptPreviewVideo, videoWarmLease } from "./share-preview.js";
import { inlineUrl, thumbUrl } from "./share.js";

// PhotoSwipe viewer + Swiper thumbstrip.
import { formatVideoTime, syncRefreshedVideoThumbnails, applyImageTransform } from "./share-viewer.js";

// Viewer video slides: session, controls, rotation, tile preview cleanup.
export function registerVideoContent(instance) {
  const sessions = new Set();
  const finePointer = matchMedia("(hover: hover) and (pointer: fine)");
  const pauseHidden = () => {
    if (document.hidden) sessions.forEach((session) => session.pauseForVisibility());
  };
  const suspendPage = () => sessions.forEach((session) => session.deactivate());
  const resumePage = () => {
    const content = instance.currSlide?.content;
    if (!content?._videoSession || !content.element?.classList.contains("is-active")) return;
    content._videoPromise = content._videoSession.activate({ autoplay: false }).catch(() => {});
  };
  document.addEventListener("visibilitychange", pauseHidden);
  window.addEventListener("pagehide", suspendPage);
  window.addEventListener("pageshow", resumePage);
  instance.on("destroy", () => {
    document.removeEventListener("visibilitychange", pauseHidden);
    window.removeEventListener("pagehide", suspendPage);
    window.removeEventListener("pageshow", resumePage);
    sessions.forEach((session) => session.destroy());
    sessions.clear();
  });

  instance.on("contentLoad", (event) => {
    const { content } = event;
    if (content.data.type !== "video") return;
    event.preventDefault();
    const file = content.data.file;
    const wrap = document.createElement("div");
    wrap.className = "pswp-video-wrap";
    wrap.dataset.fileId = file.id;
    applyImageTransform(wrap, file);

    const media = document.createElement("div");
    media.className = "pswp-video-media";
    wrap.appendChild(media);

    const poster = document.createElement("img");
    poster.className = "pswp-video-poster";
    poster.src = file.thumb ? thumbUrl(file, "base") : "";
    poster.alt = "";
    poster.draggable = false;
    if (poster.src) media.appendChild(poster);

    const status = document.createElement("div");
    status.className = "pswp-video-status hidden";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "Loading video";
    wrap.appendChild(status);

    const video = adoptPreviewVideo(file) || document.createElement("video");
    video.className = "pswp-video";
    video.controls = false;
    video.playsInline = true;
    video.preload = "metadata";
    video.setAttribute("aria-label", file.name);
    video.setAttribute("controlslist", "nodownload");
    media.appendChild(video);

    const controls = document.createElement("div");
    controls.className = "pswp-video-controls";
    controls.setAttribute("role", "group");
    controls.setAttribute("aria-label", `Video controls for ${file.name}`);
    controls.innerHTML = `<button type="button" data-video-play aria-label="Play">${uiIcon("play", "pswp-video-control-icon")}</button><output>0:00 / 0:00</output><input type="range" min="0" max="0" step="0.01" value="0" aria-label="Video position" disabled><button type="button" data-video-mute aria-label="Mute">${uiIcon("volume-2", "pswp-video-control-icon")}</button><button type="button" data-video-fullscreen aria-label="Enter video fullscreen">${uiIcon("maximize", "pswp-video-control-icon")}</button>`;
    wrap.appendChild(controls);
    const play = controls.querySelector("[data-video-play]");
    const time = controls.querySelector("output");
    const seek = controls.querySelector("input");
    const mute = controls.querySelector("[data-video-mute]");
    const fullscreen = controls.querySelector("[data-video-fullscreen]");

    const errorPanel = document.createElement("div");
    errorPanel.className = "pswp-video-error hidden";
    errorPanel.setAttribute("role", "alert");
    errorPanel.innerHTML = `<p></p><div><button type="button" data-video-retry>Retry stream</button><button type="button" data-video-download>Download original</button></div>`;
    wrap.appendChild(errorPanel);
    const retry = errorPanel.querySelector("[data-video-retry]");
    const downloadOriginal = errorPanel.querySelector("[data-video-download]");

    let hasPlayed = false;
    let resumeAfterRefresh = false;
    let refreshAttempted = false;
    let refreshAt = 0;
    let session;
    const warmLease = videoWarmLease(file);
    warmLease.claim(content);
    session = createVideoSession({
      video,
      resolveSource: async (signal, { force }) => {
        let source = !force && warmLease.sourceFor((candidate) => tokenFresh(file) && candidate === inlineUrl(file));
        if (!source) {
          await ensureFreshDownload(file, force, signal);
          source = warmLease.remember(inlineUrl(file));
        }
        syncRefreshedVideoThumbnails(file, poster);
        return source;
      },
      onState: ({ state, error, errorKind }) => {
        if (state === "playing") hasPlayed = true;
        if (state === "playing") resumeAfterRefresh = true;
        if (["paused", "ended"].includes(state)) resumeAfterRefresh = false;
        wrap.dataset.videoState = state;
        poster.classList.toggle("hidden", hasPlayed && state !== "error");
        status.classList.toggle("hidden", state !== "loading");
        errorPanel.classList.toggle("hidden", state !== "error");
        errorPanel.querySelector("p").textContent = errorKind === "codec"
          ? `${error?.message || "This video is unsupported."} Download the original to open it in another app.`
          : error?.message || "The video stream could not be loaded.";
        const playing = state === "playing";
        play.innerHTML = uiIcon(playing ? "pause" : "play", "pswp-video-control-icon");
        play.setAttribute("aria-label", playing ? "Pause" : "Play");
        if (state === "error" && errorKind === "network" && !refreshAttempted) {
          refreshAttempted = true;
          refreshAt = Number(video.currentTime) || 0;
          const resume = resumeAfterRefresh;
          queueMicrotask(() => session.retry({ play: resume, preserveTime: true }).catch(() => {}));
        }
      },
    });
    const syncTime = () => {
      const { currentTime, duration } = projectVideoTimeline(video);
      seek.max = String(duration);
      seek.value = String(currentTime);
      seek.disabled = !duration;
      time.textContent = `${formatVideoTime(currentTime)} / ${formatVideoTime(duration)}`;
      seek.setAttribute("aria-valuetext", time.textContent);
      if (refreshAttempted && currentTime >= refreshAt + 2) refreshAttempted = false;
    };
    const playFromButton = (inputEvent) => {
      inputEvent.stopPropagation();
      if (video.paused) void session.playFromUser().catch(() => {});
      else video.pause();
    };
    const retryFromButton = (inputEvent) => {
      inputEvent.stopPropagation();
      refreshAttempted = false;
      void session.retry({ play: true, preserveTime: true }).catch(() => {});
    };
    const seekVideo = () => { if (Number.isFinite(video.duration)) video.currentTime = Number(seek.value) || 0; };
    let mediaPointerStart = null;
    let suppressMediaClick = false;
    const noteMediaPointerStart = (inputEvent) => {
      mediaPointerStart = { id: inputEvent.pointerId, x: inputEvent.clientX, y: inputEvent.clientY };
      suppressMediaClick = false;
    };
    const noteMediaPointerEnd = (inputEvent) => {
      if (!mediaPointerStart || mediaPointerStart.id !== inputEvent.pointerId) return;
      suppressMediaClick = Math.hypot(inputEvent.clientX - mediaPointerStart.x, inputEvent.clientY - mediaPointerStart.y) > 8;
      mediaPointerStart = null;
    };
    const cancelMediaPointer = () => {
      suppressMediaClick = true;
      mediaPointerStart = null;
    };
    const togglePlaybackFromMedia = (inputEvent) => {
      if (suppressMediaClick || inputEvent.defaultPrevented) {
        suppressMediaClick = false;
        return;
      }
      inputEvent.stopPropagation();
      if (video.paused) void session.playFromUser().catch(() => {});
      else video.pause();
    };
    const toggleMute = () => {
      video.muted = !video.muted;
      mute.innerHTML = uiIcon(video.muted ? "volume-x" : "volume-2", "pswp-video-control-icon");
      mute.setAttribute("aria-label", video.muted ? "Unmute" : "Mute");
    };
    const enterFullscreen = () => {
      if (wrap.requestFullscreen) void wrap.requestFullscreen().catch(() => {});
      else video.webkitEnterFullscreen?.();
    };
    const downloadFromFallback = () => void downloadFile(file);
    play.addEventListener("click", playFromButton);
    retry.addEventListener("click", retryFromButton);
    seek.addEventListener("input", seekVideo);
    mute.addEventListener("click", toggleMute);
    fullscreen.addEventListener("click", enterFullscreen);
    downloadOriginal.addEventListener("click", downloadFromFallback);
    media.addEventListener("pointerdown", noteMediaPointerStart);
    media.addEventListener("pointerup", noteMediaPointerEnd);
    media.addEventListener("pointercancel", cancelMediaPointer);
    media.addEventListener("click", togglePlaybackFromMedia);
    for (const type of ["loadedmetadata", "durationchange", "timeupdate", "ended"]) video.addEventListener(type, syncTime);
    let timeRaf = 0;
    const tickTime = () => {
      syncTime();
      timeRaf = video.paused ? 0 : requestAnimationFrame(tickTime);
    };
    const startTimeRaf = () => { if (!timeRaf) timeRaf = requestAnimationFrame(tickTime); };
    video.addEventListener("play", startTimeRaf);
    const stopPlayerGesture = (inputEvent) => inputEvent.stopPropagation();
    const playerEvents = ["pointerdown", "pointermove", "pointerup", "pointercancel", "touchstart", "touchmove", "touchend", "click"];
    for (const type of playerEvents) {
      controls.addEventListener(type, stopPlayerGesture, { passive: true });
      errorPanel.addEventListener(type, stopPlayerGesture, { passive: true });
    }

    content._video = video;
    content._videoSession = session;
    content._videoCleanup = () => {
      play.removeEventListener("click", playFromButton);
      retry.removeEventListener("click", retryFromButton);
      seek.removeEventListener("input", seekVideo);
      mute.removeEventListener("click", toggleMute);
      fullscreen.removeEventListener("click", enterFullscreen);
      downloadOriginal.removeEventListener("click", downloadFromFallback);
      media.removeEventListener("pointerdown", noteMediaPointerStart);
      media.removeEventListener("pointerup", noteMediaPointerEnd);
      media.removeEventListener("pointercancel", cancelMediaPointer);
      media.removeEventListener("click", togglePlaybackFromMedia);
      for (const type of ["loadedmetadata", "durationchange", "timeupdate", "ended"]) video.removeEventListener(type, syncTime);
      video.removeEventListener("play", startTimeRaf);
      cancelAnimationFrame(timeRaf);
      timeRaf = 0;
      for (const type of playerEvents) {
        controls.removeEventListener(type, stopPlayerGesture);
        errorPanel.removeEventListener(type, stopPlayerGesture);
      }
      warmLease.release(content);
    };
    content.element = wrap;
    sessions.add(session);
    content._videoPromise = null;
  });

  instance.on("contentActivate", ({ content }) => {
    if (!content?._videoSession) return;
    content.element?.classList.add("is-active");
    content._videoPromise = content._videoSession.activate({ autoplay: finePointer.matches }).catch(() => {});
  });
  instance.on("contentDeactivate", ({ content }) => {
    content?.element?.classList.remove("is-active");
    content?._videoSession?.deactivate();
  });
  instance.on("contentDestroy", ({ content }) => {
    const session = content?._videoSession;
    if (!session) return;
    sessions.delete(session);
    content._videoCleanup?.();
    session.destroy();
    content._videoSession = null;
    content._videoPromise = null;
    content._videoCleanup = null;
    content._video = null;
  });
}

export function cleanupTilePreview(file) {
  const fig = file?._el;
  if (!fig) return;
  fig.classList.remove("previewing", "buffering", "scrubbing");
  fig.style.removeProperty("--scrub-x");
  fig.querySelector(".buffer-bar")?.remove();
  fig._scrubBadge = null;
  fx.setScrubbing(false, fig);
}

export const SHORTCUTS = [
  ["← / →", "Previous / next"],
  ["Shift + ← / →", "Skip back / forward 10"],
  [", / .", "Skip back / forward 10"],
  ["Home / End", "First / last file"],
  ["[ / ]", "Rotate left / right"],
  ["0", "Reset rotation"],
  ["I", "Open or close File info"],
  ["P", "Pin or unpin File info"],
  ["T", "Show or hide the filmstrip"],
  ["A", "Enable or disable viewer motion"],
  ["F", "Enter or leave fullscreen"],
  ["?", "Open this viewer guide"],
  ["Esc", "Close the active panel, then viewer"],
  ["Scroll wheel or drag", "Browse the filmstrip"],
  ["Shift + hover a tile", "Scrub a video (desktop)"],
  ["Touch + hold a tile", "Select, then drag across more items"],
];

export const GUIDE_SECTIONS = [
  ["Navigate", ["Use the arrow buttons, keyboard arrows, ±10 buttons, or a filmstrip thumbnail.", "Rapid browsing stays on small previews; the viewer promotes the settled image through higher-quality tiers."]],
  ["Inspect", ["Zoom or use File info for dimensions, dates, exposure, camera, lens, and GPS metadata.", "Pin File info when you want it to remain visible while changing images or using other tools."]],
  ["Shape the view", ["The filmstrip supports 13 sizes and can be hidden entirely.", "Rotation works for images and videos, shows its current angle, and can be reset with 0."]],
  ["Motion", ["Motion is optional and defaults to Immediate for the fastest browsing.", "Choose a transition style and speed from the Motion settings panel."]],
];
