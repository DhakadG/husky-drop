import { assetLampState, assetProgress, createViewerNavigationController, normalizeRotation, verifyFullAsset } from "./share-viewer-engine.js";
import {
  FULL_CACHE_LIMIT,
  TOKEN_REFRESH_MS,
  assetControllers,
  decodedImages,
  fx,
  lightboxItems,
  viewerTransforms,
} from "./share-state.js";
import { trackEvent } from "./share-beacon.js";
import { ensureFreshDownload } from "./share-download.js";
import { inlineUrl, thumbUrl } from "./share.js";

// PhotoSwipe viewer + Swiper thumbstrip.
import { vs } from "./share-viewer-state.js";

// Viewer assets: tiered loading (base/mid/max/full), decode cache, asset
// ladder, rapid-navigation warming.
export function rotationFor(file) {
  return normalizeRotation(viewerTransforms.get(file?.id)?.rotation);
}

export function setRotation(file, value) {
  const rotation = normalizeRotation(value);
  if (rotation) viewerTransforms.set(file.id, { rotation });
  else viewerTransforms.delete(file.id);
  return rotation;
}

export function assetKey(file, tier) {
  return `${file.id}:${tier}`;
}

export function highestCachedTier(file) {
  return ["full", "max"].find((tier) => decodedImages.has(assetKey(file, tier))) || "base";
}

export function canDecodeOriginal(file) {
  return /^image\/(jpeg|jpg|png|webp|gif|avif|bmp)$/i.test(file?.mime || "");
}


export function previewUrl(file) {
  return canDecodeOriginal(file) ? inlineUrl(file) : thumbUrl(file, "max");
}

export function tierUrl(file, tier) {
  return tier === "full" ? previewUrl(file) : thumbUrl(file, tier);
}

export function abortAssetLoad(fileId) {
  const controller = assetControllers.get(fileId);
  if (controller) controller.abort();
  assetControllers.delete(fileId);
}

export function enforceFullCacheLimit() {
  const full = [...decodedImages.entries()]
    .filter(([key]) => key.endsWith(":full"))
    .sort((a, b) => a[1].at - b[1].at);
  while (full.length > FULL_CACHE_LIMIT) {
    const [key, asset] = full.shift();
    if (asset.objectUrl) URL.revokeObjectURL(asset.objectUrl);
    decodedImages.delete(key);
  }
}

export async function responseBlobWithProgress(response, signal, onProgress) {
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

export async function decodeAssetUrl(url, file, tier, objectUrl = "") {
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

export async function loadTierAsset(file, tier, onProgress) {
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

export function readyTierFor(file, state, forceBase = false) {
  if (forceBase) return "base";
  const tiers = ["base", "max", "full"];
  const ceiling = Math.max(0, tiers.indexOf(state?.tier || "base"));
  return ["full", "max"].find((tier) => tiers.indexOf(tier) <= ceiling && decodedImages.has(assetKey(file, tier))) || "base";
}

export function imageForTier(file, tier, className) {
  const cached = decodedImages.get(assetKey(file, tier));
  const image = document.createElement("img");
  image.className = className;
  image.alt = className === "pswp-progressive-thumb" ? "" : file.name;
  image.decoding = "async";
  image.referrerPolicy = "no-referrer";
  image.src = cached?.url || tierUrl(file, tier);
  return image;
}

export function renderTierIntoWrap(wrap, file, state) {
  if (!wrap || wrap.dataset.fileId !== file.id) return;
  const tier = readyTierFor(file, state, vs.rapidSurf);
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
    vs.viewerAssets?.confirmPresented(file, tier, asset ? {
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

export function renderActiveAsset(state) {
  const file = vs.pswp?.currSlide?.data?.file;
  if (!file || state?.fileId !== file.id) return;
  vs.pswp.element?.querySelectorAll(`.pswp-progressive-wrap[data-file-id="${CSS.escape(file.id)}"]`).forEach((wrap) => {
    renderTierIntoWrap(wrap, file, state);
  });
}

export function updateAssetLadder(state = vs.activeAssetState) {
  if (!vs.assetLadderElement || !state) return;
  const mapped = assetLampState(state);
  const stateChanged = vs.assetLadderElement.dataset.state !== mapped.key;
  vs.assetLadderElement.dataset.state = mapped.key;
  vs.assetLadderElement.dataset.tier = state.tier;
  vs.assetLadderElement.setAttribute("aria-label", mapped.label);
  vs.assetLadderElement.querySelector(".pswp-asset-label").textContent = mapped.label;
  const progress = assetProgress(state);
  vs.assetLadderElement.style.setProperty("--asset-progress", progress.toFixed(4));
  const bar = vs.assetLadderElement.querySelector(".pswp-asset-progress");
  bar?.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  bar?.setAttribute("aria-valuetext", mapped.label);
  bar?.classList.toggle("indeterminate", Boolean(state.loading && !state.progress));
  if (stateChanged) fx.animateViewerLed(vs.assetLadderElement.querySelector(".pswp-asset-lamp"), mapped.key);
}

export function syncAssetLadderVisibility(file = vs.pswp?.currSlide?.data?.file) {
  if (vs.assetLadderElement) vs.assetLadderElement.hidden = !/^image\//.test(file?.mime || "");
}

export function handleAssetState(state) {
  const currentFile = vs.pswp?.currSlide?.data?.file;
  if (!currentFile || currentFile.id !== state.fileId) return;
  vs.activeAssetState = state;
  updateAssetLadder(state);
  syncAssetError(state, currentFile);
  if (!state.loading || vs.rapidSurf) renderActiveAsset(state);
}

export function syncAssetError(state, file) {
  vs.pswp?.element?.querySelectorAll(`.pswp-progressive-wrap[data-file-id="${CSS.escape(file.id)}"]`).forEach((wrap) => {
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
      if (state.failedTier === "full") void vs.viewerAssets?.ensureFull(file);
      else void vs.viewerAssets?.activate(file);
      trackEvent("viewer_asset_retry", file.name, { tier: state.tier, error: state.error });
    });
    wrap.appendChild(notice);
  });
}

export function noteRapidNavigation(reason, held = false) {
  vs.rapidController?.note(reason, held);
}

export function endRapidNavigation(reason) {
  vs.rapidController?.release(reason);
}

export function promoteActiveSlide(reason = "settled") {
  const file = vs.pswp?.currSlide?.data?.file;
  if (!file || !/^image\//.test(file.mime) || vs.rapidSurf) return;
  void vs.viewerAssets?.activate(file, { reason }).then(() => warmViewerNeighbors(vs.pswp?.currIndex || 0));
}

export async function warmViewerNeighbors(index) {
  if (!vs.viewerAssets || vs.rapidSurf) return;
  const generation = ++vs.neighborWarmGeneration;
  const candidates = [index - 1, index + 1, index - 2, index + 2]
    .map((position) => lightboxItems[position])
    .filter((file) => file && /^image\//.test(file.mime || ""));
  const nextIds = new Set(candidates.map((file) => file.id));
  const activeId = lightboxItems[index]?.id;
  for (const fileId of vs.neighborWarmIds) {
    if (!nextIds.has(fileId) && fileId !== activeId) abortAssetLoad(fileId);
  }
  vs.neighborWarmIds = nextIds;
  for (let offset = 0; offset < candidates.length; offset += 2) {
    if (generation !== vs.neighborWarmGeneration || vs.rapidSurf) return;
    await Promise.allSettled(candidates.slice(offset, offset + 2).map((file) => vs.viewerAssets?.warm(file)));
  }
}

export function bindRapidPointer(button, direction) {
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

export function installViewerNavigationTransitions(instance) {
  const goImmediately = instance.goTo.bind(instance);
  const navigation = createViewerNavigationController({
    getCurrentIndex: () => instance.currIndex,
    getCurrentElement: () => instance.currSlide?.content?.element,
    getLength: () => lightboxItems.length,
    navigateImmediately: goImmediately,
    shouldTransition: (element) => Boolean(element && vs.viewerMotion.enabled && vs.viewerMotion.mode === "blur" && !vs.rapidSurf && !matchMedia("(prefers-reduced-motion: reduce)").matches),
    exit: (element) => fx.animateViewerExit(element, vs.viewerMotion.speed),
    cancel: (element) => fx.cancelViewerTransition?.(element),
    isDestroying: () => instance.isDestroying,
  });
  instance.goTo = navigation.goTo;
  instance.next = navigation.next;
  instance.prev = navigation.prev;
  instance.on("change", () => navigation.changed(instance.currIndex));
  instance.on("destroy", navigation.destroy);
}
