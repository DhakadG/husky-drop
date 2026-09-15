import { fileInfoCache, lightboxItems, pin, slug, uiIcon } from "./share-state.js";
import { trackEvent } from "./share-beacon.js";
import { ensureFreshDownload } from "./share-download.js";

// PhotoSwipe viewer + Swiper thumbstrip.
import { vs, viewerChrome } from "./share-viewer-state.js";
import { syncViewerPanelState, closeViewerPanels } from "./share-viewer-panels.js";
import { mountStrip, stripHeightForScale } from "./share-viewer-strip.js";

// Caption, chrome metrics and the file-info (EXIF) panel.
export function updateCaption(file) {
  if (!vs.captionEl || !file) return;
  const parts = [];
  if (file.w && file.h) parts.push(`${file.w} × ${file.h}`, `${megapixels(file)} MP`);
  parts.push(fmtBytes(file.size));
  if (file.at) parts.push(formatLongDate(file.at));
  vs.captionEl.innerHTML = `<b>${esc(file.name)}</b><span>${esc(parts.join(" - "))}</span>`;
}

export function megapixels(file) {
  return file?.w && file?.h ? Math.round((file.w * file.h) / 10000) / 100 : 0;
}

export function formatLongDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const month = new Intl.DateTimeFormat(undefined, { month: "long" }).format(date);
  return `${String(date.getDate()).padStart(2, "0")} ${month} ${date.getFullYear()}`;
}

// Bottom bar = caption + thumbstrip stacked in one flex column, so they
// share one anchor point instead of two separately-positioned absolute
// elements that have to agree on pixel heights by hand.
export function mountBottomBar(instance) {
  const bar = document.createElement("div");
  bar.className = "pswp-bottom-bar";
  vs.captionEl = document.createElement("div");
  vs.captionEl.className = "pswp-caption";
  bar.appendChild(vs.captionEl);
  instance.element.appendChild(bar);
  mountStrip(instance, bar);
  mountFileInfo(instance);
}

export function mountViewerChromeMetrics(instance) {
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


export function mountFileInfo(instance) {
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
    vs.fileInfoPanel = null;
    vs.fileInfoPinned = false;
  });
}

export function toggleFileInfo(pinPanel = false, forceOpen = false) {
  if (!vs.pswp?.element) return;
  closeViewerPanels("file-info");
  if (!vs.fileInfoPanel) {
    vs.fileInfoPanel = document.createElement("aside");
    vs.fileInfoPanel.className = "pswp-file-info";
    vs.fileInfoPanel.setAttribute("aria-label", "File info and EXIF");
    vs.fileInfoPanel.innerHTML = `<header><div><span>File info</span><b>EXIF & attributes</b></div><div class="pswp-info-actions"><button type="button" class="pswp-info-pin" aria-label="Pin file info" aria-pressed="false">${uiIcon("pin")}</button><button type="button" class="pswp-info-close" aria-label="Close file info">×</button></div></header><div class="pswp-file-info-body"></div>`;
    vs.fileInfoPanel.querySelector(".pswp-info-pin").addEventListener("click", toggleFileInfoPin);
    vs.fileInfoPanel.querySelector(".pswp-info-close").addEventListener("click", () => {
      vs.fileInfoPinned = false;
      setFileInfoOpen(false);
    });
    vs.fileInfoPanel.addEventListener("mouseenter", () => {
      clearFileInfoClose();
      setFileInfoOpen(true);
    });
    vs.fileInfoPanel.addEventListener("mouseleave", scheduleFileInfoClose);
    vs.pswp.element.appendChild(vs.fileInfoPanel);
  }
  if (pinPanel) vs.fileInfoPinned = !vs.fileInfoPinned;
  const currentlyOpen = vs.fileInfoPanel.classList.contains("open");
  if (currentlyOpen && !forceOpen && !pinPanel) vs.fileInfoPinned = false;
  const shouldOpen = forceOpen || pinPanel ? true : !currentlyOpen;
  setFileInfoOpen(shouldOpen);
  if (shouldOpen) {
    refreshFileInfo(vs.pswp.currSlide?.data?.file);
    trackEvent("file_info_open", vs.pswp.currSlide?.data?.file?.name || "");
  }
}

export function toggleFileInfoPin() {
  if (!vs.fileInfoPanel?.classList.contains("open")) toggleFileInfo(false, true);
  vs.fileInfoPinned = !vs.fileInfoPinned;
  clearFileInfoClose();
  setFileInfoOpen(true);
  trackEvent("file_info_pin", vs.fileInfoPinned ? "pinned" : "unpinned");
}

export function setFileInfoOpen(open) {
  vs.fileInfoPanel?.setAttribute("aria-hidden", String(!open));
  vs.fileInfoPanel?.toggleAttribute("inert", !open);
  vs.fileInfoPanel?.classList.toggle("open", open);
  vs.fileInfoPanel?.classList.toggle("pinned", Boolean(open && vs.fileInfoPinned));
  const pinButton = vs.fileInfoPanel?.querySelector(".pswp-info-pin");
  if (pinButton) {
    pinButton.setAttribute("aria-pressed", String(vs.fileInfoPinned));
    pinButton.setAttribute("aria-label", vs.fileInfoPinned ? "Unpin file info" : "Pin file info");
    pinButton.innerHTML = uiIcon(vs.fileInfoPinned ? "pin-off" : "pin");
  }
  vs.fileInfoToolbarButton?.setAttribute("aria-pressed", String(Boolean(open)));
  vs.fileInfoToolbarButton?.classList.toggle("is-active", Boolean(open));
  vs.pswp?.element?.classList.toggle("pswp-info-open", open);
  syncViewerPanelState();
}

export function clearFileInfoClose() {
  clearTimeout(vs.fileInfoCloseTimer);
  vs.fileInfoCloseTimer = 0;
}

export function scheduleFileInfoClose() {
  clearFileInfoClose();
  if (vs.fileInfoPinned) return;
  vs.fileInfoCloseTimer = setTimeout(() => setFileInfoOpen(false), 360);
}

export async function fetchFileInfo(file) {
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

export async function refreshFileInfo(file) {
  if (!vs.fileInfoPanel?.classList.contains("open") || !file) return;
  const body = vs.fileInfoPanel.querySelector(".pswp-file-info-body");
  const seq = ++vs.fileInfoRequest;
  body.innerHTML = `<div class="pswp-info-loading"><i></i><span>Reading media details…</span></div>`;
  try {
    const data = await fetchFileInfo(file);
    if (seq !== vs.fileInfoRequest) return;
    renderFileInfo(body, data, file);
  } catch (error) {
    if (seq === vs.fileInfoRequest) body.innerHTML = `<p class="pswp-info-error">${esc(String(error.message || error))}</p>`;
  }
}

export function renderFileInfo(body, data, fallback) {
  const file = data.file || fallback;
  const exif = data.exif || {};
  const general = [
    ["File name", file.name],
    ["Position", vs.pswp ? `${vs.pswp.currIndex + 1} / ${lightboxItems.length}` : ""],
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

export function exposureSummary(exif) {
  const shutter = formatShutterSpeed(exif.exposureTime).split(" (")[0];
  const values = [
    [uiIcon("timer"), "Shutter", shutter],
    [uiIcon("aperture"), "Aperture", exif.aperture ? `f/${exif.aperture}` : ""],
    [uiIcon("gauge"), "Sensitivity", exif.isoSpeed ? `ISO ${exif.isoSpeed}` : ""],
  ].filter(([, , value]) => value);
  if (!values.length) return "";
  return `<section class="pswp-exposure-summary" aria-label="Exposure triangle">${values.map(([iconHtml, label, value]) => `<div>${iconHtml}<span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</section>`;
}

export function formatShutterSpeed(value) {
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

export function formatOrientation(rotation) {
  if (rotation == null || rotation === "") return "";
  if (!Number.isFinite(Number(rotation))) return String(rotation);
  const quarterTurns = ((Number(rotation) % 4) + 4) % 4;
  return ["Landscape / 0°", "Portrait / 90°", "Landscape / 180°", "Portrait / 270°"][quarterTurns] || "";
}

export function infoSection(title, rows) {
  const available = rows.filter(([, value]) => value !== "" && value != null);
  if (!available.length) return `<section><h3>${esc(title)}</h3><p class="pswp-info-empty">No metadata reported.</p></section>`;
  return `<section><h3>${esc(title)}</h3><dl>${available.map(([key, value]) => `<div><dt>${esc(key)}</dt><dd>${esc(String(value))}</dd></div>`).join("")}</dl></section>`;
}
