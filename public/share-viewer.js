import {
  VIEWER_MOTION_MODES,
  assetLampState,
  assetProgress,
  createRapidSurfController,
  createViewerAssetEngine,
  createViewerNavigationController,
  normalizeRotation,
  normalizeViewerMotion,
  resolvePanelReturnTarget,
  restorePanelFocus,
  verifyFullAsset,
} from "./share-viewer-engine.js";
import { createVideoSession, projectVideoTimeline } from "./share-video-session.js";
import {
  FULL_CACHE_LIMIT,
  STRIP_HEIGHTS,
  STRIP_WIDTHS,
  TOKEN_REFRESH_MS,
  VIEWER_MOTION_KEY,
  VIEWER_MOTION_LABELS,
  assetControllers,
  decodedImages,
  fileInfoCache,
  fx,
  lightboxItems,
  pin,
  readScale,
  slug,
  uiIcon,
  viewerTransforms,
} from "./share-state.js";
import { trackEvent } from "./share-beacon.js";
import { downloadFile, ensureFreshDownload, tokenFresh } from "./share-download.js";
import { stopHoverPreview, videoWarmLease } from "./share-preview.js";
import { cancelTouchSelection } from "./share-select.js";
import { inlineUrl, setGalleryToolsOpen, stripSizeDescription, iconFor, thumbUrl } from "./share.js";

// PhotoSwipe viewer + Swiper thumbstrip.
let stripScale = readScale("lhdb_strip_scale", matchMedia("(max-width: 640px)").matches ? 3 : 5, STRIP_WIDTHS.length);
const viewerChrome = { top: 104, bottom: stripHeightForScale() + 70 };
let viewerChromeMetrics = { refresh: () => {}, cleanup: () => {} };
let mobileViewerControlsCleanup = () => {};
let viewerMotion = loadViewerMotion();

// ---- PhotoSwipe viewer + Swiper thumbstrip ----

let pswp = null;
let pswpModulePromise = null;
let strip = null;
let viewerAssets = null;
let rapidController = null;
let rapidSurf = false;
let activeAssetState = null;
let assetLadderElement = null;
let neighborWarmGeneration = 0;
let neighborWarmIds = new Set();
let viewerMotionButton = null;
let viewerMotionPanel = null;
let suppressNextViewerTransition = false;
let viewerRefreshPanelException = "";
let syncRotationUi = () => {};

export function loadViewerMotion() {
  try {
    return normalizeViewerMotion(JSON.parse(localStorage.getItem(VIEWER_MOTION_KEY) || "null"));
  } catch {
    return normalizeViewerMotion(null);
  }
}

function saveViewerMotion() {
  localStorage.setItem(VIEWER_MOTION_KEY, JSON.stringify(viewerMotion));
}

function rotationFor(file) {
  return normalizeRotation(viewerTransforms.get(file?.id)?.rotation);
}

function setRotation(file, value) {
  const rotation = normalizeRotation(value);
  if (rotation) viewerTransforms.set(file.id, { rotation });
  else viewerTransforms.delete(file.id);
  return rotation;
}

function assetKey(file, tier) {
  return `${file.id}:${tier}`;
}

function highestCachedTier(file) {
  return ["full", "max"].find((tier) => decodedImages.has(assetKey(file, tier))) || "base";
}

function canDecodeOriginal(file) {
  return /^image\/(jpeg|jpg|png|webp|gif|avif|bmp)$/i.test(file?.mime || "");
}


function previewUrl(file) {
  return canDecodeOriginal(file) ? inlineUrl(file) : thumbUrl(file, "max");
}

function tierUrl(file, tier) {
  return tier === "full" ? previewUrl(file) : thumbUrl(file, tier);
}

function abortAssetLoad(fileId) {
  const controller = assetControllers.get(fileId);
  if (controller) controller.abort();
  assetControllers.delete(fileId);
}

function enforceFullCacheLimit() {
  const full = [...decodedImages.entries()]
    .filter(([key]) => key.endsWith(":full"))
    .sort((a, b) => a[1].at - b[1].at);
  while (full.length > FULL_CACHE_LIMIT) {
    const [key, asset] = full.shift();
    if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
    decodedImages.delete(key);
  }
}

async function responseBlobWithProgress(response, signal, onProgress) {
  const length = Number(response.headers.get("content-length")) || 0;
  if (!response.body || !length) return response.blob();
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress?.(received / length);
  }
  return new Blob(chunks, { type: response.headers.get("content-type") || "image/jpeg" });
}

async function decodeAssetUrl(url, file, tier, objectUrl = "") {
  const image = new Image();
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.alt = file.name;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error(`${tier} preview could not be decoded`));
    image.src = url;
  });
  try {
    await image.decode();
  } catch {
    // onload + naturalWidth is still a browser-usable decoded frame.
  }
  if (!image.naturalWidth) throw new Error(`${tier} preview is empty`);
  return { image, url, objectUrl, tier, at: performance.now() };
}

async function loadTierAsset(file, tier, onProgress) {
  const key = assetKey(file, tier);
  const cached = decodedImages.get(key);
  if (cached?.image?.complete && cached.image.naturalWidth) {
    cached.at = performance.now();
    return cached;
  }
  abortAssetLoad(file.id);
  const controller = new AbortController();
  assetControllers.set(file.id, controller);
  let objectUrl = "";
  try {
    const thumbnailsExpiring = tier !== "full" && file.thumbsExpireAt && file.thumbsExpireAt - Date.now() < TOKEN_REFRESH_MS;
    if (tier === "full") await ensureFreshDownload(file, false, controller.signal);
    else if (thumbnailsExpiring) await ensureFreshDownload(file, true, controller.signal);
    if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
    let url = tierUrl(file, tier);
    if (!url) throw new Error(`${tier} preview is unavailable`);
    if (/^data:/i.test(url)) {
      const asset = await decodeAssetUrl(url, file, tier);
      decodedImages.set(key, asset);
      return asset;
    }
    let response = await fetch(url, { signal: controller.signal });
    if ([401, 403].includes(response.status)) {
      await ensureFreshDownload(file, true, controller.signal);
      if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
      url = tierUrl(file, tier);
      response = await fetch(url, { signal: controller.signal });
    }
    if (!response.ok) throw new Error(`${tier} preview returned HTTP ${response.status}`);
    const declaredOriginalBytes = tier === "full" ? Number(response.headers.get("x-husky-original-bytes")) || 0 : 0;
    if (tier === "full" && response.headers.get("x-husky-asset-tier") !== "full") throw new Error("full preview response was not verified as the original file");
    const blob = await responseBlobWithProgress(response, controller.signal, onProgress);
    objectUrl = URL.createObjectURL(blob);
    const asset = await decodeAssetUrl(objectUrl, file, tier, objectUrl);
    asset.bytes = blob.size;
    asset.width = asset.image.naturalWidth;
    asset.height = asset.image.naturalHeight;
    if (tier === "full") {
      if (!verifyFullAsset({ declaredBytes: declaredOriginalBytes, blobBytes: blob.size, expectedWidth: file.w, expectedHeight: file.h, actualWidth: asset.width, actualHeight: asset.height }))
        throw new Error(`full preview failed original verification (${blob.size} bytes, ${asset.width}×${asset.height})`);
      asset.verifiedFull = true;
    }
    decodedImages.set(key, asset);
    if (tier === "full") enforceFullCacheLimit();
    return asset;
  } catch (error) {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    throw error;
  } finally {
    if (assetControllers.get(file.id) === controller) assetControllers.delete(file.id);
  }
}

function readyTierFor(file, state, forceBase = false) {
  if (forceBase) return "base";
  const tiers = ["base", "max", "full"];
  const ceiling = Math.max(0, tiers.indexOf(state?.tier || "base"));
  return ["full", "max"].find((tier) => tiers.indexOf(tier) <= ceiling && decodedImages.has(assetKey(file, tier))) || "base";
}

function imageForTier(file, tier, className) {
  const cached = decodedImages.get(assetKey(file, tier));
  const image = document.createElement("img");
  image.className = className;
  image.alt = className === "pswp-progressive-thumb" ? "" : file.name;
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.src = cached?.url || tierUrl(file, tier);
  return image;
}

function renderTierIntoWrap(wrap, file, state) {
  if (!wrap || wrap.dataset.fileId !== file.id) return;
  const tier = readyTierFor(file, state, rapidSurf);
  if (wrap.dataset.displayTier === tier) return;
  const className = tier === "full" ? "pswp-progressive-full" : "pswp-progressive-tier";
  const image = imageForTier(file, tier, className);
  const finish = () => {
    if (!wrap.isConnected && !wrap.parentNode) return;
    wrap.querySelectorAll(".pswp-progressive-tier, .pswp-progressive-full").forEach((node) => {
      if (node !== image) node.remove();
    });
    wrap.dataset.displayTier = tier;
    wrap.dataset.assetTier = tier;
    wrap.classList.add("ready");
    const asset = decodedImages.get(assetKey(file, tier));
    viewerAssets?.confirmPresented(file, tier, asset ? {
      bytes: asset.bytes,
      width: asset.width,
      height: asset.height,
      verifiedFull: asset.verifiedFull,
    } : {});
    if (tier === "full" && !wrap.dataset.fullPresentationTracked) {
      wrap.dataset.fullPresentationTracked = "1";
      trackEvent("viewer_full_presented", file.name, { bytes: asset?.bytes || 0, width: asset?.width || 0, height: asset?.height || 0 });
    }
  };
  wrap.appendChild(image);
  if (image.complete && image.naturalWidth) finish();
  else image.addEventListener("load", finish, { once: true });
}

function renderActiveAsset(state) {
  const file = pswp?.currSlide?.data?.file;
  if (!file || state?.fileId !== file.id) return;
  pswp.element?.querySelectorAll(`.pswp-progressive-wrap[data-file-id="${CSS.escape(file.id)}"]`).forEach((wrap) => {
    renderTierIntoWrap(wrap, file, state);
  });
}

function updateAssetLadder(state = activeAssetState) {
  if (!assetLadderElement || !state) return;
  const mapped = assetLampState(state);
  const stateChanged = assetLadderElement.dataset.state !== mapped.key;
  assetLadderElement.dataset.state = mapped.key;
  assetLadderElement.dataset.tier = state.tier;
  assetLadderElement.setAttribute("aria-label", mapped.label);
  assetLadderElement.querySelector(".pswp-asset-label").textContent = mapped.label;
  const progress = assetProgress(state);
  assetLadderElement.style.setProperty("--asset-progress", progress.toFixed(4));
  const bar = assetLadderElement.querySelector(".pswp-asset-progress");
  bar?.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  bar?.setAttribute("aria-valuetext", mapped.label);
  bar?.classList.toggle("indeterminate", Boolean(state.loading && !state.progress));
  if (stateChanged) fx.animateViewerLed(assetLadderElement.querySelector(".pswp-asset-lamp"), mapped.key);
}

function syncAssetLadderVisibility(file = pswp?.currSlide?.data?.file) {
  if (assetLadderElement) assetLadderElement.hidden = !/^image\//.test(file?.mime || "");
}

function handleAssetState(state) {
  const currentFile = pswp?.currSlide?.data?.file;
  if (!currentFile || currentFile.id !== state.fileId) return;
  activeAssetState = state;
  updateAssetLadder(state);
  syncAssetError(state, currentFile);
  if (!state.loading || rapidSurf) renderActiveAsset(state);
}

function syncAssetError(state, file) {
  pswp?.element?.querySelectorAll(`.pswp-progressive-wrap[data-file-id="${CSS.escape(file.id)}"]`).forEach((wrap) => {
    let notice = wrap.querySelector(".pswp-progressive-error");
    if (!state.error) {
      notice?.remove();
      return;
    }
    if (notice) return;
    notice = document.createElement("div");
    notice.className = "pswp-progressive-error";
    const hasPreview = state.tier !== "empty";
    notice.innerHTML = `<b>${hasPreview ? "This preview could not be upgraded." : "This preview could not be loaded."}</b><span>${hasPreview ? "The current preview remains available." : "The thumbnail remains visible when available."} Retry now, or refresh the page if this keeps happening.</span><button type="button">Retry</button>`;
    notice.querySelector("button").addEventListener("click", (event) => {
      event.stopPropagation();
      notice.remove();
      if (state.failedTier === "full") void viewerAssets?.ensureFull(file);
      else void viewerAssets?.activate(file);
      trackEvent("viewer_asset_retry", file.name, { tier: state.tier, error: state.error });
    });
    wrap.appendChild(notice);
  });
}

function noteRapidNavigation(reason, held = false) {
  rapidController?.note(reason, held);
}

function endRapidNavigation(reason) {
  rapidController?.release(reason);
}

function promoteActiveSlide(reason = "settled") {
  const file = pswp?.currSlide?.data?.file;
  if (!file || !/^image\//.test(file.mime) || rapidSurf) return;
  void viewerAssets?.activate(file, { reason }).then(() => warmViewerNeighbors(pswp?.currIndex || 0));
}

async function warmViewerNeighbors(index) {
  if (!viewerAssets || rapidSurf) return;
  const generation = ++neighborWarmGeneration;
  const candidates = [index - 1, index + 1, index - 2, index + 2]
    .map((position) => lightboxItems[position])
    .filter((file) => file && /^image\//.test(file.mime || ""));
  const nextIds = new Set(candidates.map((file) => file.id));
  const activeId = lightboxItems[index]?.id;
  for (const fileId of neighborWarmIds) {
    if (!nextIds.has(fileId) && fileId !== activeId) abortAssetLoad(fileId);
  }
  neighborWarmIds = nextIds;
  for (let offset = 0; offset < candidates.length; offset += 2) {
    if (generation !== neighborWarmGeneration || rapidSurf) return;
    await Promise.allSettled(candidates.slice(offset, offset + 2).map((file) => viewerAssets?.warm(file)));
  }
}

function bindRapidPointer(button, direction) {
  if (!button) return;
  let holdTimer = 0;
  button.addEventListener("pointerdown", () => {
    noteRapidNavigation(`arrow-${direction}`);
    clearTimeout(holdTimer);
    holdTimer = setTimeout(() => noteRapidNavigation(`arrow-${direction}-hold`, true), 240);
  });
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    button.addEventListener(type, () => {
      clearTimeout(holdTimer);
      endRapidNavigation(`arrow-${direction}-release`);
    });
  }
}

function installViewerNavigationTransitions(instance) {
  const goImmediately = instance.goTo.bind(instance);
  const navigation = createViewerNavigationController({
    getCurrentIndex: () => instance.currIndex,
    getCurrentElement: () => instance.currSlide?.content?.element,
    getLength: () => lightboxItems.length,
    navigateImmediately: goImmediately,
    shouldTransition: (element) => Boolean(element && viewerMotion.enabled && viewerMotion.mode === "blur" && !rapidSurf && !matchMedia("(prefers-reduced-motion: reduce)").matches),
    exit: (element) => fx.animateViewerExit(element, viewerMotion.speed),
    cancel: (element) => fx.cancelViewerTransition?.(element),
    isDestroying: () => instance.isDestroying,
  });
  instance.goTo = navigation.goTo;
  instance.next = navigation.next;
  instance.prev = navigation.prev;
  instance.on("change", () => navigation.changed(instance.currIndex));
  instance.on("destroy", navigation.destroy);
}

function loadPswp() {
  if (!pswpModulePromise) pswpModulePromise = import("/vendor/photoswipe.esm.min.js").then((m) => m.default);
  return pswpModulePromise;
}

function pswpItem(file) {
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
  viewerAssets = createViewerAssetEngine({
    loadTier: loadTierAsset,
    abort: abortAssetLoad,
    canLoadFull: canDecodeOriginal,
    onChange: handleAssetState,
  });
  for (const item of lightboxItems) {
    if (!/^image\//.test(item.mime || "")) continue;
    const cachedTier = highestCachedTier(item);
    if (cachedTier) viewerAssets.seed(item, cachedTier);
  }
  rapidController = createRapidSurfController({
    onChange: ({ active, reason }) => {
      rapidSurf = active;
      pswp?.element?.classList.toggle("pswp-rapid-surf", active);
      viewerAssets?.setRapid(active);
      if (active) {
        const currentFile = pswp?.currSlide?.data?.file;
        if (currentFile) renderActiveAsset({ ...viewerAssets.stateFor(currentFile), rapid: true });
      } else {
        promoteActiveSlide(reason);
      }
      updateAssetLadder();
    },
  });
  pswp = new PhotoSwipe({
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

  installViewerNavigationTransitions(pswp);
  registerProgressiveImageContent(pswp);
  registerVideoContent(pswp);
  registerUi(pswp);
  pswp.on("change", () => {
    noteRapidNavigation("slide-change");
    const current = lightboxItems[pswp.currIndex];
    syncAssetLadderVisibility(current);
    closeViewerPanels({ except: viewerRefreshPanelException || (fileInfoPinned ? "file-info" : "") });
    updateCaption(current);
    syncStrip(pswp.currIndex);
    refreshFileInfo(current);
    if (/^image\//.test(current?.mime || "")) {
      void viewerAssets.activate(current).then(() => warmViewerNeighbors(pswp.currIndex));
    }
    if (suppressNextViewerTransition) suppressNextViewerTransition = false;
    else applyViewerTransition();
    syncRotationUi();
    trackEvent("view", current?.name || "");
  });
  const editableTarget = (target) => target instanceof Element && target.closest("input, button, select, textarea, [contenteditable]");
  const goRelative = (amount) => pswp?.goTo(Math.max(0, Math.min(lightboxItems.length - 1, pswp.currIndex + amount)));
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
      Home: () => pswp.goTo(0),
      End: () => pswp.goTo(lightboxItems.length - 1),
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
      "?": () => toggleViewerGuide(pswp),
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
  pswp.on("destroy", () => {
    const closing = lightboxItems[pswp.currIndex];
    window.shareTrekker?.track("media_view_end", closing?.name || "", { reason: "viewer_close" });
    window.removeEventListener("keydown", onViewerKeydown, true);
    window.removeEventListener("keyup", onViewerKeyup, true);
    window.removeEventListener("blur", onViewerBlur);
    rapidController?.cancel("viewer-destroy");
    viewerAssets?.destroy();
    rapidController = null;
    viewerAssets = null;
    rapidSurf = false;
    activeAssetState = null;
    assetLadderElement = null;
    neighborWarmGeneration++;
    for (const fileId of neighborWarmIds) abortAssetLoad(fileId);
    neighborWarmIds.clear();
    syncRotationUi = () => {};
    viewerChromeMetrics.cleanup();
    viewerChromeMetrics = { refresh: () => {}, cleanup: () => {} };
    mobileViewerControlsCleanup();
    mobileViewerControlsCleanup = () => {};
    destroyStrip();
    closeViewerPanels({ forceInfo: true });
    pswp = null;
  });

  pswp.init();
  openingLease?.release(openingOwner);
  mountBottomBar(pswp);
  mobileViewerControlsCleanup = mountMobileViewerControls(pswp);
  viewerChromeMetrics = mountViewerChromeMetrics(pswp);
  updateCaption(file);
  bindRapidPointer(pswp.element?.querySelector(".pswp__button--arrow--prev"), "previous");
  bindRapidPointer(pswp.element?.querySelector(".pswp__button--arrow--next"), "next");
  if (/^image\//.test(file.mime)) void viewerAssets.activate(file).then(() => warmViewerNeighbors(index));
}

function registerProgressiveImageContent(instance) {
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
    const state = viewerAssets?.stateFor(file) || { fileId: file.id, tier: "base", presentedTier: "base", loading: "", intentStep: 0, intentSteps: 6, progress: 1 };
    renderTierIntoWrap(wrap, file, state);
    setProgressiveLoading(content, false);
  });
}

function setProgressiveLoading(content, loading, isError = false) {
  const visibleTier = content.element?.querySelector(".pswp-progressive-thumb, .pswp-progressive-tier, .pswp-progressive-full");
  const next = Boolean(loading && !visibleTier);
  const changed = content._progressiveLoading !== next;
  content._progressiveLoading = next;
  content.instance?.ui?.updatePreloaderVisibility?.();
  if (changed && !loading && content.slide) {
    content.instance.dispatch("loadComplete", { slide: content.slide, content, isError });
  }
}

function applyImageTransform(wrap, file) {
  const rotation = rotationFor(file);
  wrap.style.setProperty("--media-rotation", `${rotation}deg`);
  wrap.classList.toggle("quarter-turn", rotation === 90 || rotation === 270);
}

function refreshRotatedMedia(file) {
  const index = pswp.currIndex;
  pswp.options.dataSource[index] = pswpItem(file);
  if (/^video\//.test(file.mime || "")) {
    suppressNextViewerTransition = false;
    applyImageTransform(pswp.currSlide?.content?.element, file);
    return;
  }
  suppressNextViewerTransition = true;
  viewerRefreshPanelException = mobileViewerActions && !mobileViewerActions.hidden ? "mobile-actions" : "";
  try {
    pswp.refreshSlideContent(index);
  } finally {
    viewerRefreshPanelException = "";
  }
}

function rotateCurrentMedia(delta) {
  const file = pswp?.currSlide?.data?.file;
  if (!file || !/^(image|video)\//.test(file.mime)) return;
  closeViewerPanels("mobile-actions");
  const rotation = setRotation(file, rotationFor(file) + delta);
  refreshRotatedMedia(file);
  syncRotationUi();
  trackEvent("media_rotate", `${rotation}°`, { file: file.name, direction: delta < 0 ? "left" : "right", mime: file.mime });
}

function resetCurrentRotation() {
  const file = pswp?.currSlide?.data?.file;
  const currentRotation = rotationFor(file);
  if (!file || !currentRotation) return;
  setRotation(file, 0);
  refreshRotatedMedia(file);
  syncRotationUi();
  trackEvent("media_rotation_reset", file.name, { mime: file.mime });
}

function formatVideoTime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function syncRefreshedVideoThumbnails(file, poster) {
  const source = file.thumb ? thumbUrl(file, "base") : "";
  if (poster && source) poster.src = source;
  strip?.slides?.forEach((slide) => {
    if (slide.dataset.fileId === file.id && source) slide.querySelector("img")?.setAttribute("src", source);
  });
}

function registerVideoContent(instance) {
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

    const video = document.createElement("video");
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

function cleanupTilePreview(file) {
  const fig = file?._el;
  if (!fig) return;
  fig.classList.remove("previewing", "buffering", "scrubbing");
  fig.style.removeProperty("--scrub-x");
  fig.querySelector(".buffer-bar")?.remove();
  fig._scrubBadge = null;
  fx.setScrubbing(false, fig);
}

const SHORTCUTS = [
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

const GUIDE_SECTIONS = [
  ["Navigate", ["Use the arrow buttons, keyboard arrows, ±10 buttons, or a filmstrip thumbnail.", "Rapid browsing stays on small previews; the viewer promotes the settled image through higher-quality tiers."]],
  ["Inspect", ["Zoom or use File info for dimensions, dates, exposure, camera, lens, and GPS metadata.", "Pin File info when you want it to remain visible while changing images or using other tools."]],
  ["Shape the view", ["The filmstrip supports 13 sizes and can be hidden entirely.", "Rotation works for images and videos, shows its current angle, and can be reset with 0."]],
  ["Motion", ["Motion is optional and defaults to Immediate for the fastest browsing.", "Choose a transition style and speed from the Motion settings panel."]],
];

let viewerGuidePanel = null;
let viewerGuideButton = null;
let stripSettingsPanel = null;
let viewerPanelInvoker = null;
let mobileViewerDock = null;
let mobileViewerActions = null;

function hasOpenViewerPanel() {
  return Boolean(viewerGuidePanel || stripSettingsPanel || viewerMotionPanel || (mobileViewerActions && !mobileViewerActions.hidden) || fileInfoPanel?.classList.contains("open"));
}

function syncViewerPanelState() {
  pswp?.element?.classList.toggle("pswp-panel-open", hasOpenViewerPanel());
}

function closeViewerPanels(options = {}) {
  if (typeof options === "string") options = { except: options };
  const { except = "", forceInfo = false } = options;
  const activeElement = document.activeElement;
  const closingPanels = [
    except !== "guide" && viewerGuidePanel,
    except !== "filmstrip" && stripSettingsPanel,
    except !== "motion" && viewerMotionPanel,
  ].filter(Boolean);
  const mobileActionsHadFocus = mobileViewerActions?.contains(document.activeElement);
  if (except !== "guide") {
    viewerGuidePanel?.remove();
    viewerGuidePanel = null;
    viewerGuideButton?.classList.remove("is-active");
    viewerGuideButton?.setAttribute("aria-pressed", "false");
  }
  if (except !== "filmstrip") {
    stripSettingsPanel?.remove();
    stripSettingsPanel = null;
  }
  if (except !== "motion") {
    viewerMotionPanel?.remove();
    viewerMotionPanel = null;
  }
  if (except !== "mobile-actions" && mobileViewerActions) {
    mobileViewerActions.hidden = true;
    const more = mobileViewerDock?.querySelector(".pswp-mobile-more");
    more?.setAttribute("aria-expanded", "false");
    if (mobileActionsHadFocus) more?.focus({ preventScroll: true });
  }
  if (except !== "file-info" && (forceInfo || !fileInfoPinned)) {
    if (forceInfo) fileInfoPinned = false;
    setFileInfoOpen(false);
  }
  if (closingPanels.length) {
    restorePanelFocus({ activeElement, panels: closingPanels, returnTarget: viewerPanelInvoker });
    viewerPanelInvoker = null;
  }
  syncViewerPanelState();
}

function nextViewerPanelInvoker() {
  return resolvePanelReturnTarget({
    activeElement: document.activeElement,
    panels: [viewerGuidePanel, stripSettingsPanel, viewerMotionPanel].filter(Boolean),
    mobileActions: mobileViewerActions,
    mobileMore: mobileViewerDock?.querySelector(".pswp-mobile-more"),
    previousTarget: viewerPanelInvoker,
  });
}

function syncViewerMotionUi() {
  viewerMotionButton?.classList.toggle("is-active", viewerMotion.enabled);
  viewerMotionButton?.setAttribute("aria-pressed", String(viewerMotion.enabled));
  viewerMotionPanel?.querySelector("[data-motion-toggle]")?.setAttribute("aria-pressed", String(viewerMotion.enabled));
  syncMobileViewerActions();
}

function toggleViewerMotion() {
  viewerMotion = normalizeViewerMotion({ ...viewerMotion, enabled: !viewerMotion.enabled });
  saveViewerMotion();
  syncViewerMotionUi();
  trackEvent("viewer_motion_toggle", viewerMotion.enabled ? "on" : "off", { mode: viewerMotion.mode, speed: viewerMotion.speed });
}

function applyViewerTransition(element = pswp?.currSlide?.content?.element) {
  if (!element || !viewerMotion.enabled || rapidSurf || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  fx.animateViewerTransition(element, viewerMotion.mode, viewerMotion.speed);
}

function toggleFilmstrip() {
  const root = pswp?.element;
  if (!root) return;
  const hidden = root.classList.toggle("pswp-filmstrip-hidden");
  viewerChromeMetrics.refresh();
  syncMobileViewerActions();
  trackEvent("filmstrip_toggle", hidden ? "hidden" : "visible");
}

async function toggleViewerFullscreen() {
  if (!pswp?.element) return;
  if (document.fullscreenElement) await document.exitFullscreen?.();
  else await pswp.element.requestFullscreen?.();
  syncMobileViewerActions();
}

function mountViewerMotionPanel(instance) {
  if (viewerMotionPanel) return closeViewerPanels();
  const invoker = nextViewerPanelInvoker();
  closeViewerPanels("motion");
  viewerPanelInvoker = invoker;
  const panel = document.createElement("section");
  panel.className = "pswp-motion-settings";
  panel.setAttribute("aria-label", "Viewer motion settings");
  const options = VIEWER_MOTION_MODES.map((mode) => `<option value="${mode}"${mode === viewerMotion.mode ? " selected" : ""}>${esc(VIEWER_MOTION_LABELS[mode] || mode)}</option>`).join("");
  panel.innerHTML = `<header><div><span>Viewer motion</span><b>Transitions and speed</b></div><button type="button" aria-label="Close motion settings">×</button></header><div class="pswp-motion-body"><button type="button" class="pswp-motion-toggle" data-motion-toggle aria-pressed="${viewerMotion.enabled}"><span>Transitions</span><b>${viewerMotion.enabled ? "On" : "Immediate"}</b></button><label><span>Style</span><select data-motion-mode>${options}</select></label><label><span>Speed</span><input data-motion-speed type="range" min="120" max="700" step="20" value="${viewerMotion.speed}"><output>${viewerMotion.speed} ms</output></label><p>Immediate is the default and always wins during rapid browsing.</p></div>`;
  panel.querySelector("header button").addEventListener("click", () => closeViewerPanels());
  panel.querySelector("[data-motion-toggle]").addEventListener("click", () => {
    toggleViewerMotion();
    panel.querySelector("[data-motion-toggle] b").textContent = viewerMotion.enabled ? "On" : "Immediate";
  });
  panel.querySelector("[data-motion-mode]").addEventListener("change", (event) => {
    viewerMotion = normalizeViewerMotion({ ...viewerMotion, mode: event.target.value, enabled: true });
    saveViewerMotion();
    syncViewerMotionUi();
    applyViewerTransition();
  });
  panel.querySelector("[data-motion-speed]").addEventListener("input", (event) => {
    viewerMotion = normalizeViewerMotion({ ...viewerMotion, speed: Number(event.target.value) });
    event.target.nextElementSibling.textContent = `${viewerMotion.speed} ms`;
    saveViewerMotion();
  });
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
  instance.element.appendChild(panel);
  viewerMotionPanel = panel;
  syncViewerMotionUi();
  syncViewerPanelState();
  panel.querySelector("button")?.focus({ preventScroll: true });
}

function toggleViewerGuide(instance) {
  if (viewerGuidePanel) return closeViewerPanels();
  const invoker = nextViewerPanelInvoker();
  closeViewerPanels("guide");
  viewerPanelInvoker = invoker;
  const panel = document.createElement("section");
  panel.className = "pswp-guide";
  panel.setAttribute("aria-label", "Viewer guide");
  panel.innerHTML = `<header><div><span>Viewer guide</span><b>Browse, inspect, and control media</b></div><button type="button" aria-label="Close viewer guide">×</button></header><p class="pswp-guide-intro">Everything stays keyboard- and pointer-friendly. Opening another viewer tool automatically closes this guide.</p><div class="pswp-guide-grid">${GUIDE_SECTIONS.map(([title, items]) => `<section><h3>${esc(title)}</h3><ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>`).join("")}</div><section class="pswp-guide-shortcuts"><h3>Keyboard map</h3><ul>${SHORTCUTS.map(([key, desc]) => `<li><span>${key}</span>${esc(desc)}</li>`).join("")}</ul></section>`;
  panel.querySelector("button").addEventListener("click", () => closeViewerPanels());
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
  instance.element.appendChild(panel);
  viewerGuidePanel = panel;
  viewerGuideButton?.classList.add("is-active");
  viewerGuideButton?.setAttribute("aria-pressed", "true");
  syncViewerPanelState();
  panel.querySelector("button")?.focus({ preventScroll: true });
}

function downloadCurrentViewerFile() {
  closeViewerPanels();
  const file = pswp?.currSlide?.data?.file;
  if (file) void downloadFile(file);
}

function setMobileActionsOpen(open, { restoreFocus = true } = {}) {
  if (!mobileViewerActions || !mobileViewerDock) return;
  const wasOpen = !mobileViewerActions.hidden;
  if (open) closeViewerPanels({ except: "mobile-actions", forceInfo: true });
  mobileViewerActions.hidden = !open;
  const more = mobileViewerDock.querySelector(".pswp-mobile-more");
  more?.setAttribute("aria-expanded", String(open));
  if (open) mobileViewerActions.querySelector("button:not([disabled])")?.focus();
  else if (wasOpen && restoreFocus) more?.focus({ preventScroll: true });
  syncViewerPanelState();
}

function syncMobileViewerActions() {
  if (!mobileViewerActions) return;
  const rotation = rotationFor(pswp?.currSlide?.data?.file);
  const reset = mobileViewerActions.querySelector('[data-mobile-action="reset-rotation"]');
  if (reset) {
    reset.disabled = rotation === 0;
    const label = rotation ? `Reset ${rotation}°` : "Reset rotation";
    reset.querySelector("span").textContent = label;
  }
  const filmstrip = mobileViewerActions.querySelector('[data-mobile-action="toggle-filmstrip"]');
  if (filmstrip) {
    const label = pswp?.element?.classList.contains("pswp-filmstrip-hidden") ? "Show filmstrip" : "Hide filmstrip";
    filmstrip.querySelector("span").textContent = label;
  }
  const motion = mobileViewerActions.querySelector('[data-mobile-action="motion-settings"]');
  if (motion) motion.querySelector("span").textContent = `Motion settings · ${viewerMotion.enabled ? "On" : "Off"}`;
  const fullscreen = mobileViewerActions.querySelector('[data-mobile-action="fullscreen"]');
  if (fullscreen) {
    const active = Boolean(document.fullscreenElement);
    const label = active ? "Exit fullscreen" : "Fullscreen";
    fullscreen.disabled = !active && typeof pswp?.element?.requestFullscreen !== "function";
    fullscreen.querySelector("span").textContent = label;
  }
}

function mountMobileViewerControls(instance) {
  const dock = document.createElement("nav");
  dock.className = "pswp-mobile-dock";
  dock.setAttribute("aria-label", "Viewer actions");
  const actions = [
    ["rotate-ccw", "Rotate", () => rotateCurrentMedia(-90)],
    ["file-text", "Details", () => toggleFileInfo(false)],
    ["download", "Save", downloadCurrentViewerFile],
  ];
  for (const [iconName, label, handler] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "pswp-mobile-action";
    button.setAttribute("aria-label", label);
    button.innerHTML = `${uiIcon(iconName, "pswp-mobile-action-icon")}<span>${label}</span>`;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handler();
    });
    dock.appendChild(button);
  }

  const more = document.createElement("button");
  more.type = "button";
  more.className = "pswp-mobile-action pswp-mobile-more";
  more.setAttribute("aria-label", "More viewer actions");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-controls", "pswp-mobile-actions");
  more.innerHTML = `${uiIcon("ellipsis", "pswp-mobile-action-icon")}<span>More</span>`;
  dock.appendChild(more);

  const sheet = document.createElement("section");
  sheet.id = "pswp-mobile-actions";
  sheet.className = "pswp-mobile-actions";
  sheet.setAttribute("aria-label", "More viewer actions");
  sheet.setAttribute("role", "dialog");
  sheet.tabIndex = -1;
  sheet.hidden = true;
  const sheetActions = [
    ["rotate-cw", "Rotate right", "rotate-right", () => rotateCurrentMedia(90), true],
    ["rotate-ccw-square", "Reset rotation", "reset-rotation", resetCurrentRotation, true],
    ["gallery-horizontal-end", "Filmstrip size", "filmstrip-size", () => mountStripSizeControl(instance), lightboxItems.length >= 2],
    ["images", "Hide filmstrip", "toggle-filmstrip", toggleFilmstrip, lightboxItems.length >= 2],
    ["wand-sparkles", "Motion settings", "motion-settings", () => mountViewerMotionPanel(instance), true],
    ["circle-help", "Viewer guide", "viewer-guide", () => toggleViewerGuide(instance), true],
    ["maximize", "Fullscreen", "fullscreen", toggleViewerFullscreen, true],
  ];
  for (const [iconName, label, actionName, handler, enabled] of sheetActions) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.mobileAction = actionName;
    button.innerHTML = `${uiIcon(iconName, "pswp-mobile-sheet-icon")}<span>${label}</span>`;
    button.disabled = !enabled;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      handler();
      syncMobileViewerActions();
    });
    sheet.appendChild(button);
  }

  const toggleMore = (event) => {
    event.stopPropagation();
    setMobileActionsOpen(sheet.hidden);
  };
  more.addEventListener("click", toggleMore);
  dock.addEventListener("pointerdown", (event) => event.stopPropagation());
  sheet.addEventListener("pointerdown", (event) => event.stopPropagation());
  instance.element.append(dock, sheet);
  mobileViewerDock = dock;
  mobileViewerActions = sheet;
  const syncFullscreen = () => syncMobileViewerActions();
  document.addEventListener("fullscreenchange", syncFullscreen);
  syncMobileViewerActions();

  return () => {
    more.removeEventListener("click", toggleMore);
    document.removeEventListener("fullscreenchange", syncFullscreen);
    dock.remove();
    sheet.remove();
    if (mobileViewerDock === dock) mobileViewerDock = null;
    if (mobileViewerActions === sheet) mobileViewerActions = null;
  };
}

function registerUi(instance) {
  const rotateButtons = [];
  const syncRotateButtons = () => {
    const enabled = /^(image|video)\//.test(instance.currSlide?.data?.file?.mime || "");
    rotateButtons.forEach((button) => {
      button.disabled = !enabled;
      button.setAttribute("aria-disabled", String(!enabled));
    });
  };
  // PhotoSwipe wraps `inner` in its own <svg>; the <use> carries the Lucide
  // stroke styling (see .pswp-lucide) since the sprite symbols are bare.
  const icon = (name, id) => {
    uiIcon(name); // validates the name against the catalog
    return { isCustomSVG: true, size: 24, inner: `<use class="pswp-lucide" href="/icons.svg#${name}"></use>`, outlineID: id };
  };
  const shortcut = (value) => (element) => element.setAttribute("aria-keyshortcuts", value);
  instance.on("uiRegister", () => {
    instance.ui.registerElement({
      name: "asset-ladder",
      order: 7,
      isButton: false,
      tagName: "div",
      html: `<span class="pswp-asset-lamp" aria-hidden="true">${uiIcon("aperture", "pswp-asset-glyph")}</span><span class="pswp-asset-label">Preview</span><span class="pswp-asset-progress" role="progressbar" aria-label="Media preview loading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></span>`,
      onInit: (element) => {
        element.className += " pswp-asset-ladder";
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        assetLadderElement = element;
        updateAssetLadder();
        syncAssetLadderVisibility();
      },
    });
    for (const [name, amount, iconName, title, keys] of [
      ["skip-back-button", -10, "chevrons-left", "Skip back 10", "Shift+ArrowLeft ,"],
      ["skip-forward-button", 10, "chevrons-right", "Skip forward 10", "Shift+ArrowRight ."],
    ]) {
      instance.ui.registerElement({
        name,
        order: amount < 0 ? 9 : 10,
        isButton: true,
        tagName: "button",
        html: icon(iconName, `pswp__icn-${name}`),
        onClick: () => instance.goTo(Math.max(0, Math.min(lightboxItems.length - 1, instance.currIndex + amount))),
        onInit: (element) => {
          element.dataset.step = "10";
          shortcut(keys)(element);
        },
        title,
      });
    }
    instance.ui.registerElement({
      name: "file-info-button",
      order: 11,
      isButton: true,
      tagName: "button",
      html: icon("file-text", "pswp__icn-file-info"),
      onClick: () => toggleFileInfo(false),
      onInit: (element) => {
        fileInfoToolbarButton = element;
        shortcut("I")(element);
      },
      title: "File info and EXIF",
    });
    instance.ui.registerElement({
      name: "shortcuts-button",
      order: 12,
      isButton: true,
      tagName: "button",
      html: icon("circle-help", "pswp__icn-info"),
      onClick: (event) => {
        event?.stopPropagation?.();
        toggleViewerGuide(instance);
      },
      onInit: (element) => {
        viewerGuideButton = element;
        element.setAttribute("aria-pressed", "false");
        element.addEventListener("pointerdown", (event) => event.stopPropagation());
        shortcut("?")(element);
      },
      title: "Viewer guide and keyboard shortcuts",
    });
    instance.ui.registerElement({
      name: "download-button",
      order: 13,
      isButton: true,
      tagName: "button",
      html: icon("download", "pswp__icn-download"),
      onClick: downloadCurrentViewerFile,
      title: "Download",
    });
    instance.ui.registerElement({
      name: "filmstrip-settings-button",
      order: 14,
      isButton: true,
      tagName: "button",
      html: icon("gallery-horizontal-end", "pswp__icn-filmstrip-settings"),
      onClick: () => mountStripSizeControl(instance),
      onInit: (element) => {
        element.hidden = lightboxItems.length < 2;
      },
      title: "Filmstrip size",
    });
    instance.ui.registerElement({
      name: "motion-settings-button",
      order: 15,
      isButton: true,
      tagName: "button",
      html: icon("wand-sparkles", "pswp__icn-motion"),
      onClick: () => mountViewerMotionPanel(instance),
      onInit: (element) => {
        viewerMotionButton = element;
        shortcut("A")(element);
        syncViewerMotionUi();
      },
      title: "Viewer motion settings",
    });
    instance.ui.registerElement({
      name: "rotate-left-button",
      order: 15,
      isButton: true,
      tagName: "button",
      html: icon("rotate-ccw", "pswp__icn-rotate-left"),
      onClick: () => rotateCurrentMedia(-90),
      onInit: (element) => (rotateButtons.push(element), shortcut("[")(element)),
      title: "Rotate left",
    });
    instance.ui.registerElement({
      name: "rotate-right-button",
      order: 16,
      isButton: true,
      tagName: "button",
      html: icon("rotate-cw", "pswp__icn-rotate-right"),
      onClick: () => rotateCurrentMedia(90),
      onInit: (element) => (rotateButtons.push(element), shortcut("]")(element)),
      title: "Rotate right",
    });
    let rotationReset = null;
    instance.ui.registerElement({
      name: "rotation-reset-button",
      order: 18,
      isButton: true,
      tagName: "button",
      html: icon("rotate-ccw-square", "pswp__icn-rotation-reset"),
      onClick: resetCurrentRotation,
      onInit: (element) => {
        rotationReset = element;
        shortcut("0")(element);
      },
      title: "Reset rotation",
    });
    instance.ui.registerElement({
      name: "fullscreen-button",
      order: 20,
      isButton: true,
      tagName: "button",
      html: icon("maximize", "pswp__icn-fullscreen"),
      onClick: toggleViewerFullscreen,
      onInit: shortcut("F"),
      title: "Toggle fullscreen",
    });
    syncRotationUi = () => {
      const rotation = rotationFor(instance.currSlide?.data?.file);
      syncMobileViewerActions();
      if (!rotationReset) return;
      rotationReset.disabled = rotation === 0;
      rotationReset.setAttribute("aria-disabled", String(rotation === 0));
      rotationReset.setAttribute("aria-label", rotation ? `Reset ${rotation} degree rotation` : "Media orientation is unchanged");
      if (rotation) rotationReset.dataset.rotation = `${rotation}°`;
      else delete rotationReset.dataset.rotation;
    };
  });
  instance.on("change", () => {
    syncRotateButtons();
    syncRotationUi();
  });
  instance.on("afterInit", () => {
    syncRotateButtons();
    syncRotationUi();
    instance.scrollWrap?.addEventListener("pointerdown", () => closeViewerPanels());
    instance.element?.querySelector(".pswp__button--zoom")?.addEventListener("click", () => {
      closeViewerPanels();
      const file = instance.currSlide?.data?.file;
      if (file && /^image\//.test(file.mime)) void viewerAssets?.ensureFull(file, { reason: "explicit-zoom" });
    });
  });
  instance.on("destroy", () => {
    viewerMotionButton = null;
    viewerGuideButton = null;
    fileInfoToolbarButton = null;
    closeViewerPanels({ forceInfo: true });
  });
}

// Caption updates are deliberately immediate: the image and its identity are
// one unit, so the text must never trail the current slide with an animation.
let captionEl = null;
function updateCaption(file) {
  if (!captionEl || !file) return;
  const parts = [];
  if (file.w && file.h) parts.push(`${file.w} × ${file.h}`, `${megapixels(file)} MP`);
  parts.push(fmtBytes(file.size));
  if (file.at) parts.push(formatLongDate(file.at));
  captionEl.innerHTML = `<b>${esc(file.name)}</b><span>${esc(parts.join(" - "))}</span>`;
}

function megapixels(file) {
  return file?.w && file?.h ? Math.round((file.w * file.h) / 10000) / 100 : 0;
}

function formatLongDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
  return `${String(date.getDate()).padStart(2, "0")} ${month} ${date.getFullYear()}`;
}

// Bottom bar = caption + thumbstrip stacked in one flex column, so they
// share one anchor point instead of two separately-positioned absolute
// elements that have to agree on pixel heights by hand.
function mountBottomBar(instance) {
  const bar = document.createElement("div");
  bar.className = "pswp-bottom-bar";
  captionEl = document.createElement("div");
  captionEl.className = "pswp-caption";
  bar.appendChild(captionEl);
  instance.element.appendChild(bar);
  mountStrip(instance, bar);
  mountFileInfo(instance);
}

function mountViewerChromeMetrics(instance) {
  const root = instance.element;
  const top = root.querySelector(".pswp__top-bar");
  const counter = root.querySelector(".pswp__counter");
  const assetLadder = root.querySelector(".pswp-asset-ladder");
  const bottom = root.querySelector(".pswp-bottom-bar");
  let scheduled = 0;
  const measure = () => {
    scheduled = 0;
    if (!root?.isConnected) return;
    const rootRect = root.getBoundingClientRect();
    const bottomRect = bottom?.getBoundingClientRect();
    const topBottom = [top, counter, assetLadder].reduce((furthest, element) => {
      const rect = element?.getBoundingClientRect();
      return Math.max(furthest, rect ? rect.bottom - rootRect.top : 0);
    }, 56);
    const nextTop = Math.ceil(topBottom) + 8;
    const measuredBottom = bottomRect ? Math.ceil(rootRect.bottom - bottomRect.top) + 8 : stripHeightForScale() + 62;
    const nextBottom = root.classList.contains("pswp-filmstrip-hidden") ? Math.max(64, measuredBottom) : measuredBottom;
    const changed = viewerChrome.top !== nextTop || viewerChrome.bottom !== nextBottom;
    viewerChrome.top = nextTop;
    viewerChrome.bottom = nextBottom;
    root.style.setProperty("--viewer-top-space", `${viewerChrome.top}px`);
    root.style.setProperty("--viewer-bottom-space", `${viewerChrome.bottom}px`);
    if (changed) instance.updateSize(true);
  };
  const schedule = () => {
    cancelAnimationFrame(scheduled);
    scheduled = requestAnimationFrame(measure);
  };
  const observer = new ResizeObserver(schedule);
  if (top) observer.observe(top);
  if (counter) observer.observe(counter);
  if (assetLadder) observer.observe(assetLadder);
  if (bottom) observer.observe(bottom);
  window.addEventListener("orientationchange", schedule);
  window.visualViewport?.addEventListener("resize", schedule);
  schedule();
  return {
    refresh: schedule,
    cleanup() {
      cancelAnimationFrame(scheduled);
      observer.disconnect();
      window.removeEventListener("orientationchange", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
    },
  };
}

let fileInfoPanel = null;
let fileInfoPinned = false;
let fileInfoToolbarButton = null;
let fileInfoRequest = 0;
let fileInfoCloseTimer = 0;

function mountFileInfo(instance) {
  for (const position of ["top", "bottom"]) {
    const hoverZone = document.createElement("div");
    hoverZone.className = `pswp-info-hover-zone pswp-info-hover-zone--${position}`;
    hoverZone.setAttribute("aria-hidden", "true");
    hoverZone.addEventListener("mouseenter", () => {
      clearFileInfoClose();
      toggleFileInfo(false, true);
    });
    hoverZone.addEventListener("mouseleave", scheduleFileInfoClose);
    instance.element.appendChild(hoverZone);
  }
  instance.on("destroy", () => {
    clearFileInfoClose();
    fileInfoPanel = null;
    fileInfoPinned = false;
  });
}

function toggleFileInfo(pinPanel = false, forceOpen = false) {
  if (!pswp?.element) return;
  closeViewerPanels("file-info");
  if (!fileInfoPanel) {
    fileInfoPanel = document.createElement("aside");
    fileInfoPanel.className = "pswp-file-info";
    fileInfoPanel.setAttribute("aria-label", "File info and EXIF");
    fileInfoPanel.innerHTML = `<header><div><span>File info</span><b>EXIF & attributes</b></div><div class="pswp-info-actions"><button type="button" class="pswp-info-pin" aria-label="Pin file info" aria-pressed="false">${uiIcon("pin")}</button><button type="button" class="pswp-info-close" aria-label="Close file info">×</button></div></header><div class="pswp-file-info-body"></div>`;
    fileInfoPanel.querySelector(".pswp-info-pin").addEventListener("click", toggleFileInfoPin);
    fileInfoPanel.querySelector(".pswp-info-close").addEventListener("click", () => {
      fileInfoPinned = false;
      setFileInfoOpen(false);
    });
    fileInfoPanel.addEventListener("mouseenter", () => {
      clearFileInfoClose();
      setFileInfoOpen(true);
    });
    fileInfoPanel.addEventListener("mouseleave", scheduleFileInfoClose);
    pswp.element.appendChild(fileInfoPanel);
  }
  if (pinPanel) fileInfoPinned = !fileInfoPinned;
  const currentlyOpen = fileInfoPanel.classList.contains("open");
  if (currentlyOpen && !forceOpen && !pinPanel) fileInfoPinned = false;
  const shouldOpen = forceOpen || pinPanel ? true : !currentlyOpen;
  setFileInfoOpen(shouldOpen);
  if (shouldOpen) {
    refreshFileInfo(pswp.currSlide?.data?.file);
    trackEvent("file_info_open", pswp.currSlide?.data?.file?.name || "");
  }
}

function toggleFileInfoPin() {
  if (!fileInfoPanel?.classList.contains("open")) toggleFileInfo(false, true);
  fileInfoPinned = !fileInfoPinned;
  clearFileInfoClose();
  setFileInfoOpen(true);
  trackEvent("file_info_pin", fileInfoPinned ? "pinned" : "unpinned");
}

function setFileInfoOpen(open) {
  fileInfoPanel?.setAttribute("aria-hidden", String(!open));
  fileInfoPanel?.toggleAttribute("inert", !open);
  fileInfoPanel?.classList.toggle("open", open);
  fileInfoPanel?.classList.toggle("pinned", Boolean(open && fileInfoPinned));
  const pinButton = fileInfoPanel?.querySelector(".pswp-info-pin");
  if (pinButton) {
    pinButton.setAttribute("aria-pressed", String(fileInfoPinned));
    pinButton.setAttribute("aria-label", fileInfoPinned ? "Unpin file info" : "Pin file info");
    pinButton.innerHTML = uiIcon(fileInfoPinned ? "pin-off" : "pin");
  }
  fileInfoToolbarButton?.setAttribute("aria-pressed", String(Boolean(open)));
  fileInfoToolbarButton?.classList.toggle("is-active", Boolean(open));
  pswp?.element?.classList.toggle("pswp-info-open", open);
  syncViewerPanelState();
}

function clearFileInfoClose() {
  clearTimeout(fileInfoCloseTimer);
  fileInfoCloseTimer = 0;
}

function scheduleFileInfoClose() {
  clearFileInfoClose();
  if (fileInfoPinned) return;
  fileInfoCloseTimer = setTimeout(() => setFileInfoOpen(false), 360);
}

async function fetchFileInfo(file) {
  if (fileInfoCache.has(file.id)) return fileInfoCache.get(file.id);
  const promise = ensureFreshDownload(file).then(() =>
    fetch("/api/share/file-info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, pin, dl: file.dl }),
    }).then(async (response) => {
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || "Metadata unavailable");
      return response.json();
    }),
  );
  fileInfoCache.set(file.id, promise);
  promise.catch(() => fileInfoCache.delete(file.id));
  return promise;
}

async function refreshFileInfo(file) {
  if (!fileInfoPanel?.classList.contains("open") || !file) return;
  const body = fileInfoPanel.querySelector(".pswp-file-info-body");
  const seq = ++fileInfoRequest;
  body.innerHTML = `<div class="pswp-info-loading"><i></i><span>Reading media details…</span></div>`;
  try {
    const data = await fetchFileInfo(file);
    if (seq !== fileInfoRequest) return;
    renderFileInfo(body, data, file);
  } catch (error) {
    if (seq === fileInfoRequest) body.innerHTML = `<p class="pswp-info-error">${esc(String(error.message || error))}</p>`;
  }
}

function renderFileInfo(body, data, fallback) {
  const file = data.file || fallback;
  const exif = data.exif || {};
  const general = [
    ["File name", file.name],
    ["Position", pswp ? `${pswp.currIndex + 1} / ${lightboxItems.length}` : ""],
    ["Type", file.mime],
    ["Size", fmtBytes(file.size)],
    ["Dimensions", file.width && file.height ? `${file.width} × ${file.height} (${file.megapixels || megapixels(fallback)} MP)` : ""],
    ["Taken (camera metadata)", exif.time ? formatLongDate(exif.time) : ""],
    ["Created in Drive", file.createdAt ? formatLongDate(file.createdAt) : ""],
    ["Modified in Drive", file.modifiedAt ? formatLongDate(file.modifiedAt) : ""],
  ];
  const camera = [
    ["Make", exif.cameraMake],
    ["Model", exif.cameraModel],
    ["Lens", exif.lens],
    ["Shutter speed", formatShutterSpeed(exif.exposureTime)],
    ["Aperture", exif.aperture ? `f/${exif.aperture}` : ""],
    ["Maximum aperture", exif.maxApertureValue ? `f/${exif.maxApertureValue}` : ""],
    ["ISO", exif.isoSpeed ? `ISO ${exif.isoSpeed}` : ""],
    ["Focal length", exif.focalLength ? `${exif.focalLength} mm` : ""],
    ["35 mm equivalent", exif.focalLength35mm ? `${exif.focalLength35mm} mm` : ""],
    ["Exposure bias", exif.exposureBias != null ? `${exif.exposureBias} EV` : ""],
    ["Exposure mode", exif.exposureMode],
    ["Exposure program", exif.exposureProgram],
    ["Metering", exif.meteringMode],
    ["White balance", exif.whiteBalance],
    ["Flash", exif.flashUsed == null ? "" : typeof exif.flashUsed === "boolean" ? (exif.flashUsed ? "Fired" : "Did not fire") : exif.flashUsed],
    ["Color space", exif.colorSpace],
    ["Sensor", exif.sensor],
    ["Subject distance", exif.subjectDistance ? `${exif.subjectDistance} m` : ""],
    ["Orientation", formatOrientation(exif.rotation)],
    ["GPS", exif.location?.latitude != null && exif.location?.longitude != null ? `${exif.location.latitude}, ${exif.location.longitude}` : ""],
    ["GPS altitude", exif.location?.altitude != null ? `${exif.location.altitude} m` : ""],
    ["Software / firmware", exif.software],
    ["Artist", exif.artist],
    ["Copyright", exif.copyright],
    ["Description", exif.description],
    ["Light source", exif.lightSource],
    ["Contrast", exif.contrast],
    ["Saturation", exif.saturation],
    ["Sharpness", exif.sharpness],
    ["Rendering", exif.customRendered],
  ];
  const sourceNote = exif.source === "embedded-raw" ? '<p class="pswp-info-source">Additional fields read from the embedded RAW metadata.</p>' : "";
  body.innerHTML = exposureSummary(exif) + sourceNote + infoSection("File and attributes", general) + infoSection("EXIF", camera);
}

function exposureSummary(exif) {
  const shutter = formatShutterSpeed(exif.exposureTime).split(" (")[0];
  const values = [
    [uiIcon("timer"), "Shutter", shutter],
    [uiIcon("aperture"), "Aperture", exif.aperture ? `f/${exif.aperture}` : ""],
    [uiIcon("gauge"), "Sensitivity", exif.isoSpeed ? `ISO ${exif.isoSpeed}` : ""],
  ].filter(([, , value]) => value);
  if (!values.length) return "";
  return `<section class="pswp-exposure-summary" aria-label="Exposure triangle">${values.map(([iconHtml, label, value]) => `<div>${iconHtml}<span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</section>`;
}

function formatShutterSpeed(value) {
  if (value == null || value === "") return "";
  const raw = String(value).trim();
  if (/^\d+\s*\/\s*\d+$/.test(raw)) return `${raw.replace(/\s+/g, "")} sec`;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return raw;
  if (seconds < 1) {
    const reciprocal = 1 / seconds;
    const denominator = Math.round(reciprocal);
    const exact = seconds.toFixed(seconds < 0.01 ? 5 : 4).replace(/0+$/, "").replace(/\.$/, "");
    if (denominator >= 2 && Math.abs(reciprocal - denominator) / reciprocal < 0.025) {
      return `1/${denominator} sec (${exact} s)`;
    }
    return `${exact} sec`;
  }
  return `${Number(seconds.toFixed(2))} sec`;
}

function formatOrientation(rotation) {
  if (rotation == null || rotation === "") return "";
  if (!Number.isFinite(Number(rotation))) return String(rotation);
  const quarterTurns = ((Number(rotation) % 4) + 4) % 4;
  return ["Landscape / 0°", "Portrait / 90°", "Landscape / 180°", "Portrait / 270°"][quarterTurns] || "";
}

function infoSection(title, rows) {
  const available = rows.filter(([, value]) => value !== "" && value != null);
  if (!available.length) return `<section><h3>${esc(title)}</h3><p class="pswp-info-empty">No metadata reported.</p></section>`;
  return `<section><h3>${esc(title)}</h3><dl>${available.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(String(value))}</dd></div>`).join("")}</dl></section>`;
}

function mountStrip(instance, bar) {
  if (typeof Swiper === "undefined" || lightboxItems.length < 2) return;
  const host = document.createElement("div");
  host.className = "swiper lb-strip";
  const wrapper = document.createElement("div");
  wrapper.className = "swiper-wrapper";
  host.appendChild(wrapper);
  lightboxItems.forEach((f, i) => wrapper.appendChild(stripSlide(f, i)));
  bar.appendChild(host);
  strip = new Swiper(host, {
    slidesPerView: "auto",
    spaceBetween: 6,
    freeMode: { enabled: true, sticky: false, momentumRatio: 0.7, momentumBounce: false },
    grabCursor: true,
    simulateTouch: true,
    slideToClickedSlide: false,
    centeredSlides: false,
    centeredSlidesBounds: false,
    watchOverflow: true,
    nested: true,
    touchMoveStopPropagation: true,
    // Swiper's mousewheel module defaults to disabled; { forceToAxis: true }
    // alone does NOT turn it on - enabled: true is required. Without it,
    // scrolling the wheel over the strip silently did nothing.
    mousewheel: { enabled: true, forceToAxis: false, releaseOnEdges: false, sensitivity: 0.8 },
    keyboard: false, // PhotoSwipe already owns arrow keys for the main image
    initialSlide: instance.currIndex,
  });
  host.addEventListener("click", (event) => {
    const slide = event.target.closest?.(".lb-thumb");
    if (!slide || !host.contains(slide) || strip?.allowClick === false) return;
    const idx = Number(slide.dataset.i);
    if (!Number.isFinite(idx)) return;
    event.preventDefault();
    instance.goTo(idx);
  });
  stopFilmstripPropagation(host);
  applyStripScale(instance.element, false);
  syncStripActive();
}

function stopFilmstripPropagation(host) {
  // These listeners are installed after Swiper, so Swiper receives the event
  // first and PhotoSwipe's parent gesture/zoom handlers do not receive it.
  for (const type of ["pointerdown", "pointerup", "pointercancel", "mousedown", "touchstart", "touchmove", "touchend", "wheel", "click"]) {
    host.addEventListener(type, (event) => event.stopPropagation(), { passive: type !== "touchmove" });
  }
}

function mountStripSizeControl(instance) {
  if (stripSettingsPanel) return closeViewerPanels();
  const invoker = nextViewerPanelInvoker();
  closeViewerPanels("filmstrip");
  viewerPanelInvoker = invoker;
  const panel = document.createElement("section");
  panel.className = "pswp-strip-settings";
  panel.setAttribute("aria-label", "Filmstrip size settings");
  panel.innerHTML = `<header><div><span>Viewer layout</span><b>Filmstrip size</b></div><button type="button" aria-label="Close filmstrip settings">×</button></header>`;
  const control = document.createElement("div");
  control.className = "pswp-strip-size size-control";
  control.innerHTML = `<div class="size-control-head"><span>Filmstrip scale</span><output class="size-control-value">${stripSizeDescription(stripScale)}</output></div><div class="size-control-rail"><span class="size-control-end">${uiIcon("grid-3x3")}<small>Browse</small></span><input type="range" min="1" max="13" step="1" value="${stripScale}" aria-label="Filmstrip thumbnail size" aria-valuetext="${stripSizeDescription(stripScale)}"/><span class="size-control-end">${uiIcon("grid-2x2", "large")}<small>Inspect</small></span></div>`;
  const range = control.querySelector("input");
  range.addEventListener("input", () => {
    stripScale = readScale("", range.value, STRIP_WIDTHS.length);
    localStorage.setItem("lhdb_strip_scale", String(stripScale));
    const label = stripSizeDescription(stripScale);
    range.setAttribute("aria-valuetext", label);
    control.querySelector(".size-control-value").textContent = label;
    applyStripScale(instance.element, true);
    trackEvent("filmstrip_size", label, { step: stripScale });
  });
  range.addEventListener("keydown", (event) => event.stopPropagation());
  for (const type of ["pointerdown", "mousedown", "touchstart", "touchmove", "wheel", "click"]) {
    control.addEventListener(type, (event) => event.stopPropagation());
  }
  panel.querySelector("button").addEventListener("click", () => closeViewerPanels());
  panel.appendChild(control);
  instance.element.appendChild(panel);
  stripSettingsPanel = panel;
  applyStripScale(instance.element, false);
  syncViewerPanelState();
  panel.querySelector("button")?.focus({ preventScroll: true });
}

function applyStripScale(root, update) {
  const width = STRIP_WIDTHS[stripScale - 1];
  const height = STRIP_HEIGHTS[stripScale - 1];
  root?.style.setProperty("--strip-w", `${width}px`);
  root?.style.setProperty("--strip-h", `${height}px`);
  root?.querySelector(".pswp-strip-size")?.style.setProperty("--size-progress", `${((stripScale - 1) / (STRIP_WIDTHS.length - 1)) * 100}%`);
  root?.querySelectorAll(".lb-thumb").forEach((slide) => Object.assign(slide.style, { width: `${width}px`, height: `${height}px` }));
  if (update && strip && !strip.destroyed) {
    strip.update();
    centerStripSlide(pswp?.currIndex || 0);
    viewerChromeMetrics.refresh();
  }
}

export function stripHeightForScale() {
  return STRIP_HEIGHTS[stripScale - 1];
}

// Explicit inline size on every slide, in addition to the CSS - belt and
// suspenders against any stylesheet-load-order regression (a vendor CSS
// file loading after ours previously overrode .lb-thumb's width/height with
// Swiper's own 100%/100% slide defaults, which is what made one thumbnail
// balloon to fill the whole viewer).
function stripSlide(f, i) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "swiper-slide lb-thumb";
  el.setAttribute("aria-label", `Open ${f.name || `item ${i + 1}`}`);
  el.dataset.i = i;
  el.dataset.fileId = f.id;
  Object.assign(el.style, { width: "var(--strip-w, 54px)", height: "var(--strip-h, 42px)", flex: "0 0 auto" });
  const isVideo = /^video\//.test(f.mime);
  if (f.thumb) {
    const img = document.createElement("img");
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.src = thumbUrl(f, 160);
    img.alt = "";
    el.appendChild(img);
  } else {
    const span = document.createElement("span");
    span.textContent = iconFor(f.mime);
    el.appendChild(span);
  }
  if (isVideo) {
    el.insertAdjacentHTML("beforeend", `<i class="strip-play">${uiIcon("play")}</i>`);
  }
  return el;
}

function syncStripActive() {
  if (!strip) return;
  strip.slides.forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.i) === pswp?.currIndex);
  });
}

function syncStrip(index) {
  if (!strip) return;
  strip.update();
  strip.slideTo(index, 0, false);
  requestAnimationFrame(() => centerStripSlide(index));
  syncStripActive();
}

function centerStripSlide(index) {
  if (!strip || strip.destroyed) return;
  const slide = strip.slides?.[index];
  const host = strip.el;
  const wrapper = strip.wrapperEl;
  if (!slide || !host || !wrapper || !host.clientWidth) return;
  const max = Math.max(0, wrapper.scrollWidth - host.clientWidth);
  const target = Math.max(0, Math.min(max, slide.offsetLeft - host.clientWidth / 2 + slide.clientWidth / 2));
  strip.setTransition(0);
  strip.setTranslate(-target);
  strip.updateProgress(-target);
  strip.updateActiveIndex(index);
  strip.updateSlidesClasses();
}

function destroyStrip() {
  strip?.destroy(true, true);
  strip = null;
  captionEl = null;
}
