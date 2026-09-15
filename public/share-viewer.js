import { createRapidSurfController, createViewerAssetEngine } from "./share-viewer-engine.js";
import { VIEWER_MOTION_KEY, lightboxItems } from "./share-state.js";
import { trackEvent } from "./share-beacon.js";
import { stopHoverPreview, videoWarmLease } from "./share-preview.js";
import { cancelTouchSelection } from "./share-select.js";
import { setGalleryToolsOpen, thumbUrl } from "./share.js";

// PhotoSwipe viewer + Swiper thumbstrip.
import { vs, viewerChrome } from "./share-viewer-state.js";
import {
  rotationFor,
  setRotation,
  highestCachedTier,
  canDecodeOriginal,
  abortAssetLoad,
  loadTierAsset,
  imageForTier,
  renderTierIntoWrap,
  renderActiveAsset,
  updateAssetLadder,
  syncAssetLadderVisibility,
  handleAssetState,
  noteRapidNavigation,
  endRapidNavigation,
  promoteActiveSlide,
  warmViewerNeighbors,
  bindRapidPointer,
  installViewerNavigationTransitions,
} from "./share-viewer-assets.js";
import { registerVideoContent, cleanupTilePreview } from "./share-viewer-video.js";
import {
  hasOpenViewerPanel,
  closeViewerPanels,
  toggleViewerMotion,
  applyViewerTransition,
  toggleFilmstrip,
  toggleViewerFullscreen,
  toggleViewerGuide,
  mountMobileViewerControls,
  registerUi,
} from "./share-viewer-panels.js";
import {
  updateCaption,
  mountBottomBar,
  mountViewerChromeMetrics,
  toggleFileInfo,
  toggleFileInfoPin,
  refreshFileInfo,
} from "./share-viewer-info.js";
import { syncStrip, destroyStrip } from "./share-viewer-strip.js";

// PhotoSwipe viewer: opening, slide items, progressive image content,
// rotation. The rest of the viewer lives in share-viewer-*.js.
// ---- PhotoSwipe viewer + Swiper thumbstrip ----

export function saveViewerMotion() {
  localStorage.setItem(VIEWER_MOTION_KEY, JSON.stringify(vs.viewerMotion));
}

export function loadPswp() {
  if (!vs.pswpModulePromise) vs.pswpModulePromise = import("/vendor/photoswipe.esm.min.js").then((m) => m.default);
  return vs.pswpModulePromise;
}

export function pswpItem(file) {
  const isVideo = /^video\//.test(file.mime);
  const ratio = file.aspect || (file.w && file.h ? file.w / file.h : 16 / 9);
  let width = file.w || 1600;
  let height = file.h || Math.round(width / Math.min(2.8, Math.max(0.4, ratio)));
  const rotation = rotationFor(file);
  if (Math.abs(rotation / 90) % 2 === 1) [width, height] = [height, width];
  return {
    file,
    type: isVideo ? "video" : "image",
    width,
    height,
    msrc: file.thumb ? thumbUrl(file, "base") : "",
    src: isVideo ? undefined : thumbUrl(file, "max"),
  };
}

export async function openViewer(index, sourceEl) {
  if (index < 0 || index >= lightboxItems.length) return;
  cancelTouchSelection();
  setGalleryToolsOpen(false);
  const file = lightboxItems[index];
  const openingLease = /^video\//.test(file?.mime || "") ? videoWarmLease(file) : null;
  const openingOwner = sourceEl || openViewer;
  openingLease?.claim(openingOwner);
  let PhotoSwipe;
  try {
    PhotoSwipe = await loadPswp();
  } catch (error) {
    openingLease?.release(openingOwner);
    throw error;
  }
  if (/^video\//.test(file?.mime || "") && sourceEl) {
    stopHoverPreview(sourceEl, file, { removeBar: true });
    cleanupTilePreview(file);
  }
  vs.viewerAssets = createViewerAssetEngine({
    loadTier: loadTierAsset,
    abort: abortAssetLoad,
    canLoadFull: canDecodeOriginal,
    onChange: handleAssetState,
  });
  for (const item of lightboxItems) {
    if (!/^image\//.test(item.mime || "")) continue;
    const cachedTier = highestCachedTier(item);
    if (cachedTier) vs.viewerAssets.seed(item, cachedTier);
  }
  vs.rapidController = createRapidSurfController({
    onChange: ({ active, reason }) => {
      vs.rapidSurf = active;
      vs.pswp?.element?.classList.toggle("pswp-rapid-surf", active);
      vs.viewerAssets?.setRapid(active);
      if (active) {
        const currentFile = vs.pswp?.currSlide?.data?.file;
        if (currentFile) renderActiveAsset({ ...vs.viewerAssets.stateFor(currentFile), rapid: true });
      } else {
        promoteActiveSlide(reason);
      }
      updateAssetLadder();
    },
  });
  vs.pswp = new PhotoSwipe({
    dataSource: lightboxItems.map(pswpItem),
    index,
    bgOpacity: 0.96,
    showHideAnimationType: "none",
    showAnimationDuration: 0,
    hideAnimationDuration: 0,
    wheelToZoom: true,
    preload: [1, 1],
    loop: false,
    paddingFn: () => ({ top: viewerChrome.top, bottom: viewerChrome.bottom, left: 0, right: 0 }),
    appendToEl: document.body,
  });

  installViewerNavigationTransitions(vs.pswp);
  registerProgressiveImageContent(vs.pswp);
  registerVideoContent(vs.pswp);
  registerUi(vs.pswp);
  vs.pswp.on("change", () => {
    noteRapidNavigation("slide-change");
    const current = lightboxItems[vs.pswp.currIndex];
    syncAssetLadderVisibility(current);
    closeViewerPanels({ except: vs.viewerRefreshPanelException || (vs.fileInfoPinned ? "file-info" : "") });
    updateCaption(current);
    syncStrip(vs.pswp.currIndex);
    refreshFileInfo(current);
    if (/^image\//.test(current?.mime || "")) {
      void vs.viewerAssets.activate(current).then(() => warmViewerNeighbors(vs.pswp.currIndex));
    }
    if (vs.suppressNextViewerTransition) vs.suppressNextViewerTransition = false;
    else applyViewerTransition();
    vs.syncRotationUi();
    trackEvent("view", current?.name || "");
  });
  const editableTarget = (target) => target instanceof Element && target.closest("input, button, select, textarea, [contenteditable]");
  const goRelative = (amount) => vs.pswp?.goTo(Math.max(0, Math.min(lightboxItems.length - 1, vs.pswp.currIndex + amount)));
  const onViewerKeydown = (event) => {
    const key = event.key;
    if (key === "Escape" && hasOpenViewerPanel()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeViewerPanels({ forceInfo: true });
      return;
    }
    if (editableTarget(event.target)) return;
    if ((key === "ArrowLeft" || key === "ArrowRight") && event.repeat) noteRapidNavigation("key-hold", true);
    if (event.shiftKey && key === "ArrowLeft") return event.preventDefault(), goRelative(-10);
    if (event.shiftKey && key === "ArrowRight") return event.preventDefault(), goRelative(10);
    const action = {
      Home: () => vs.pswp.goTo(0),
      End: () => vs.pswp.goTo(lightboxItems.length - 1),
      ",": () => goRelative(-10),
      "<": () => goRelative(-10),
      ".": () => goRelative(10),
      ">": () => goRelative(10),
      "[": () => rotateCurrentMedia(-90),
      "]": () => rotateCurrentMedia(90),
      "0": resetCurrentRotation,
      i: () => toggleFileInfo(false),
      I: () => toggleFileInfo(false),
      p: toggleFileInfoPin,
      P: toggleFileInfoPin,
      t: toggleFilmstrip,
      T: toggleFilmstrip,
      a: toggleViewerMotion,
      A: toggleViewerMotion,
      f: toggleViewerFullscreen,
      F: toggleViewerFullscreen,
      "?": () => toggleViewerGuide(vs.pswp),
    }[key];
    if (action) {
      event.preventDefault();
      action();
    }
  };
  const onViewerKeyup = (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") endRapidNavigation("key-release");
  };
  const onViewerBlur = () => endRapidNavigation("window-blur");
  window.addEventListener("keydown", onViewerKeydown, true);
  window.addEventListener("keyup", onViewerKeyup, true);
  window.addEventListener("blur", onViewerBlur);
  vs.pswp.on("destroy", () => {
    const closing = lightboxItems[vs.pswp.currIndex];
    window.shareTrekker?.track("media_view_end", closing?.name || "", { reason: "viewer_close" });
    window.removeEventListener("keydown", onViewerKeydown, true);
    window.removeEventListener("keyup", onViewerKeyup, true);
    window.removeEventListener("blur", onViewerBlur);
    vs.rapidController?.cancel("viewer-destroy");
    vs.viewerAssets?.destroy();
    vs.rapidController = null;
    vs.viewerAssets = null;
    vs.rapidSurf = false;
    vs.activeAssetState = null;
    vs.assetLadderElement = null;
    vs.neighborWarmGeneration++;
    for (const fileId of vs.neighborWarmIds) abortAssetLoad(fileId);
    vs.neighborWarmIds.clear();
    vs.syncRotationUi = () => {};
    vs.viewerChromeMetrics.cleanup();
    vs.viewerChromeMetrics = { refresh: () => {}, cleanup: () => {} };
    vs.mobileViewerControlsCleanup();
    vs.mobileViewerControlsCleanup = () => {};
    destroyStrip();
    closeViewerPanels({ forceInfo: true });
    vs.pswp = null;
  });

  vs.pswp.init();
  openingLease?.release(openingOwner);
  mountBottomBar(vs.pswp);
  vs.mobileViewerControlsCleanup = mountMobileViewerControls(vs.pswp);
  vs.viewerChromeMetrics = mountViewerChromeMetrics(vs.pswp);
  updateCaption(file);
  bindRapidPointer(vs.pswp.element?.querySelector(".pswp__button--arrow--prev"), "previous");
  bindRapidPointer(vs.pswp.element?.querySelector(".pswp__button--arrow--next"), "next");
  if (/^image\//.test(file.mime)) void vs.viewerAssets.activate(file).then(() => warmViewerNeighbors(index));
}

export function registerProgressiveImageContent(instance) {
  instance.addFilter("isContentLoading", (isLoading, content) =>
    content._progressiveManaged ? Boolean(content._progressiveLoading) : isLoading,
  );
  instance.on("contentLoadImage", (event) => {
    if (event.content._progressiveManaged) event.preventDefault();
  });
  instance.on("contentLoad", (event) => {
    const { content } = event;
    if (content.data.type !== "image") return;
    event.preventDefault();
    const file = content.data.file;
    const wrap = document.createElement("div");
    wrap.className = "pswp-progressive-wrap";
    wrap.dataset.fileId = file.id;
    content.element = wrap;
    content._progressiveManaged = true;
    applyImageTransform(wrap, file);

    // Keep the thumbnail visible until the full image has decoded. More
    // precisely, each promoted tier replaces it only after that tier decodes, so no
    // undecoded rows or blank canvas can replace a usable lightweight frame.
    if (file.thumb) {
      const thumb = imageForTier(file, "base", "pswp-progressive-thumb");
      wrap.appendChild(thumb);
    }
    const state = vs.viewerAssets?.stateFor(file) || { fileId: file.id, tier: "base", presentedTier: "base", loading: "", intentStep: 0, intentSteps: 6, progress: 1 };
    renderTierIntoWrap(wrap, file, state);
    setProgressiveLoading(content, false);
  });
}

export function setProgressiveLoading(content, loading, isError = false) {
  const visibleTier = content.element?.querySelector(".pswp-progressive-thumb, .pswp-progressive-tier, .pswp-progressive-full");
  const next = Boolean(loading && !visibleTier);
  const changed = content._progressiveLoading !== next;
  content._progressiveLoading = next;
  content.instance?.ui?.updatePreloaderVisibility?.();
  if (changed && !loading && content.slide) {
    content.instance.dispatch("loadComplete", { slide: content.slide, content, isError });
  }
}

export function applyImageTransform(wrap, file) {
  const rotation = rotationFor(file);
  wrap.style.setProperty("--media-rotation", `${rotation}deg`);
  wrap.classList.toggle("quarter-turn", rotation === 90 || rotation === 270);
}

export function refreshRotatedMedia(file) {
  const index = vs.pswp.currIndex;
  vs.pswp.options.dataSource[index] = pswpItem(file);
  if (/^video\//.test(file.mime || "")) {
    vs.suppressNextViewerTransition = false;
    applyImageTransform(vs.pswp.currSlide?.content?.element, file);
    return;
  }
  vs.suppressNextViewerTransition = true;
  vs.viewerRefreshPanelException = vs.mobileViewerActions && !vs.mobileViewerActions.hidden ? "mobile-actions" : "";
  try {
    vs.pswp.refreshSlideContent(index);
  } finally {
    vs.viewerRefreshPanelException = "";
  }
}

export function rotateCurrentMedia(delta) {
  const file = vs.pswp?.currSlide?.data?.file;
  if (!file || !/^(image|video)\//.test(file.mime)) return;
  closeViewerPanels("mobile-actions");
  const rotation = setRotation(file, rotationFor(file) + delta);
  refreshRotatedMedia(file);
  vs.syncRotationUi();
  trackEvent("media_rotate", `${rotation}°`, { file: file.name, direction: delta < 0 ? "left" : "right", mime: file.mime });
}

export function resetCurrentRotation() {
  const file = vs.pswp?.currSlide?.data?.file;
  const currentRotation = rotationFor(file);
  if (!file || !currentRotation) return;
  setRotation(file, 0);
  refreshRotatedMedia(file);
  vs.syncRotationUi();
  trackEvent("media_rotation_reset", file.name, { mime: file.mime });
}

export function formatVideoTime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function syncRefreshedVideoThumbnails(file, poster) {
  const source = file.thumb ? thumbUrl(file, "base") : "";
  if (poster && source) poster.src = source;
  vs.strip?.slides?.forEach((slide) => {
    if (slide.dataset.fileId === file.id && source) slide.querySelector("img")?.setAttribute("src", source);
  });
}
