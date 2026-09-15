import { STRIP_HEIGHTS, STRIP_WIDTHS, lightboxItems, readScale, uiIcon } from "./share-state.js";
import { trackEvent } from "./share-beacon.js";
import { stripSizeDescription, iconFor, thumbUrl } from "./share.js";

// PhotoSwipe viewer + Swiper thumbstrip.
import { vs, viewerChrome } from "./share-viewer-state.js";
import { syncViewerPanelState, closeViewerPanels, nextViewerPanelInvoker } from "./share-viewer-panels.js";

// Swiper thumbstrip and its size control.
export function mountStrip(instance, bar) {
  if (typeof Swiper === "undefined" || lightboxItems.length < 2) return;
  const host = document.createElement("div");
  host.className = "swiper lb-strip";
  const wrapper = document.createElement("div");
  wrapper.className = "swiper-wrapper";
  host.appendChild(wrapper);
  lightboxItems.forEach((f, i) => wrapper.appendChild(stripSlide(f, i)));
  bar.appendChild(host);
  vs.strip = new Swiper(host, {
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
    if (!slide || !host.contains(slide) || vs.strip?.allowClick === false) return;
    const idx = Number(slide.dataset.i);
    if (!Number.isFinite(idx)) return;
    event.preventDefault();
    instance.goTo(idx);
  });
  stopFilmstripPropagation(host);
  applyStripScale(instance.element, false);
  syncStripActive();
}

export function stopFilmstripPropagation(host) {
  // These listeners are installed after Swiper, so Swiper receives the event
  // first and PhotoSwipe's parent gesture/zoom handlers do not receive it.
  for (const type of ["pointerdown", "pointerup", "pointercancel", "mousedown", "touchstart", "touchmove", "touchend", "wheel", "click"]) {
    host.addEventListener(type, (event) => event.stopPropagation(), { passive: type !== "touchmove" });
  }
}

export function mountStripSizeControl(instance) {
  if (vs.stripSettingsPanel) return closeViewerPanels();
  const invoker = nextViewerPanelInvoker();
  closeViewerPanels("filmstrip");
  vs.viewerPanelInvoker = invoker;
  const panel = document.createElement("section");
  panel.className = "pswp-strip-settings";
  panel.setAttribute("aria-label", "Filmstrip size settings");
  panel.innerHTML = `<header><div><span>Viewer layout</span><b>Filmstrip size</b></div><button type="button" aria-label="Close filmstrip settings">×</button></header>`;
  const control = document.createElement("div");
  control.className = "pswp-strip-size size-control";
  control.innerHTML = `<div class="size-control-head"><span>Filmstrip scale</span><output class="size-control-value">${stripSizeDescription(vs.stripScale)}</output></div><div class="size-control-rail"><span class="size-control-end">${uiIcon("grid-3x3")}<small>Browse</small></span><input type="range" min="1" max="13" step="1" value="${vs.stripScale}" aria-label="Filmstrip thumbnail size" aria-valuetext="${stripSizeDescription(vs.stripScale)}"/><span class="size-control-end">${uiIcon("grid-2x2", "large")}<small>Inspect</small></span></div>`;
  const range = control.querySelector("input");
  range.addEventListener("input", () => {
    vs.stripScale = readScale("", range.value, STRIP_WIDTHS.length);
    localStorage.setItem("lhdb_strip_scale", String(vs.stripScale));
    const label = stripSizeDescription(vs.stripScale);
    range.setAttribute("aria-valuetext", label);
    control.querySelector(".size-control-value").textContent = label;
    applyStripScale(instance.element, true);
    trackEvent("filmstrip_size", label, { step: vs.stripScale });
  });
  range.addEventListener("keydown", (event) => event.stopPropagation());
  for (const type of ["pointerdown", "mousedown", "touchstart", "touchmove", "wheel", "click"]) {
    control.addEventListener(type, (event) => event.stopPropagation());
  }
  panel.querySelector("button").addEventListener("click", () => closeViewerPanels());
  panel.appendChild(control);
  instance.element.appendChild(panel);
  vs.stripSettingsPanel = panel;
  applyStripScale(instance.element, false);
  syncViewerPanelState();
  panel.querySelector("button")?.focus({ preventScroll: true });
}

export function applyStripScale(root, update) {
  const width = STRIP_WIDTHS[vs.stripScale - 1];
  const height = STRIP_HEIGHTS[vs.stripScale - 1];
  root?.style.setProperty("--strip-w", `${width}px`);
  root?.style.setProperty("--strip-h", `${height}px`);
  root?.querySelector(".pswp-strip-size")?.style.setProperty("--size-progress", `${((vs.stripScale - 1) / (STRIP_WIDTHS.length - 1)) * 100}%`);
  root?.querySelectorAll(".lb-thumb").forEach((slide) => Object.assign(slide.style, { width: `${width}px`, height: `${height}px` }));
  if (update && vs.strip && !vs.strip.destroyed) {
    vs.strip.update();
    centerStripSlide(vs.pswp?.currIndex || 0);
    vs.viewerChromeMetrics.refresh();
  }
}

export function stripHeightForScale() {
  return STRIP_HEIGHTS[vs.stripScale - 1];
}

// Explicit inline size on every slide, in addition to the CSS - belt and
// suspenders against any stylesheet-load-order regression (a vendor CSS
// file loading after ours previously overrode .lb-thumb's width/height with
// Swiper's own 100%/100% slide defaults, which is what made one thumbnail
// balloon to fill the whole viewer).
export function stripSlide(f, i) {
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

export function syncStripActive() {
  if (!vs.strip) return;
  vs.strip.slides.forEach((el) => {
    el.classList.toggle("active", Number(el.dataset.i) === vs.pswp?.currIndex);
  });
}

export function syncStrip(index) {
  if (!vs.strip) return;
  vs.strip.update();
  vs.strip.slideTo(index, 0, false);
  requestAnimationFrame(() => centerStripSlide(index));
  syncStripActive();
}

export function centerStripSlide(index) {
  if (!vs.strip || vs.strip.destroyed) return;
  const slide = vs.strip.slides?.[index];
  const host = vs.strip.el;
  const wrapper = vs.strip.wrapperEl;
  if (!slide || !host || !wrapper || !host.clientWidth) return;
  const max = Math.max(0, wrapper.scrollWidth - host.clientWidth);
  const target = Math.max(0, Math.min(max, slide.offsetLeft - host.clientWidth / 2 + slide.clientWidth / 2));
  vs.strip.setTransition(0);
  vs.strip.setTranslate(-target);
  vs.strip.updateProgress(-target);
  vs.strip.updateActiveIndex(index);
  vs.strip.updateSlidesClasses();
}

export function destroyStrip() {
  vs.strip?.destroy(true, true);
  vs.strip = null;
  vs.captionEl = null;
}


viewerChrome.bottom = stripHeightForScale() + 70;
