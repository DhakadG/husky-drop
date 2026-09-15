import { VIEWER_MOTION_MODES, normalizeViewerMotion, resolvePanelReturnTarget, restorePanelFocus } from "./share-viewer-engine.js";
import { VIEWER_MOTION_LABELS, fx, lightboxItems, uiIcon } from "./share-state.js";
import { trackEvent } from "./share-beacon.js";
import { downloadFile } from "./share-download.js";

// PhotoSwipe viewer + Swiper thumbstrip.
import { vs } from "./share-viewer-state.js";
import { rotateCurrentMedia, resetCurrentRotation, saveViewerMotion } from "./share-viewer.js";
import { rotationFor, updateAssetLadder, syncAssetLadderVisibility } from "./share-viewer-assets.js";
import { SHORTCUTS, GUIDE_SECTIONS } from "./share-viewer-video.js";
import { toggleFileInfo, setFileInfoOpen } from "./share-viewer-info.js";
import { mountStripSizeControl } from "./share-viewer-strip.js";

// Viewer panels and chrome: motion, guide, fullscreen, filmstrip toggle,
// mobile dock/sheet, toolbar registration.
export function hasOpenViewerPanel() {
  return Boolean(vs.viewerGuidePanel || vs.stripSettingsPanel || vs.viewerMotionPanel || (vs.mobileViewerActions && !vs.mobileViewerActions.hidden) || vs.fileInfoPanel?.classList.contains("open"));
}

export function syncViewerPanelState() {
  vs.pswp?.element?.classList.toggle("pswp-panel-open", hasOpenViewerPanel());
}

export function closeViewerPanels(options = {}) {
  if (typeof options === "string") options = { except: options };
  const { except = "", forceInfo = false } = options;
  const activeElement = document.activeElement;
  const closingPanels = [
    except !== "guide" && vs.viewerGuidePanel,
    except !== "filmstrip" && vs.stripSettingsPanel,
    except !== "motion" && vs.viewerMotionPanel,
  ].filter(Boolean);
  const mobileActionsHadFocus = vs.mobileViewerActions?.contains(document.activeElement);
  if (except !== "guide") {
    vs.viewerGuidePanel?.remove();
    vs.viewerGuidePanel = null;
    vs.viewerGuideButton?.classList.remove("is-active");
    vs.viewerGuideButton?.setAttribute("aria-pressed", "false");
  }
  if (except !== "filmstrip") {
    vs.stripSettingsPanel?.remove();
    vs.stripSettingsPanel = null;
  }
  if (except !== "motion") {
    vs.viewerMotionPanel?.remove();
    vs.viewerMotionPanel = null;
  }
  if (except !== "mobile-actions" && vs.mobileViewerActions) {
    vs.mobileViewerActions.hidden = true;
    const more = vs.mobileViewerDock?.querySelector(".pswp-mobile-more");
    more?.setAttribute("aria-expanded", "false");
    if (mobileActionsHadFocus) more?.focus({ preventScroll: true });
  }
  if (except !== "file-info" && (forceInfo || !vs.fileInfoPinned)) {
    if (forceInfo) vs.fileInfoPinned = false;
    setFileInfoOpen(false);
  }
  if (closingPanels.length) {
    restorePanelFocus({ activeElement, panels: closingPanels, returnTarget: vs.viewerPanelInvoker });
    vs.viewerPanelInvoker = null;
  }
  syncViewerPanelState();
}

export function nextViewerPanelInvoker() {
  return resolvePanelReturnTarget({
    activeElement: document.activeElement,
    panels: [vs.viewerGuidePanel, vs.stripSettingsPanel, vs.viewerMotionPanel].filter(Boolean),
    mobileActions: vs.mobileViewerActions,
    mobileMore: vs.mobileViewerDock?.querySelector(".pswp-mobile-more"),
    previousTarget: vs.viewerPanelInvoker,
  });
}

export function syncViewerMotionUi() {
  vs.viewerMotionButton?.classList.toggle("is-active", vs.viewerMotion.enabled);
  vs.viewerMotionButton?.setAttribute("aria-pressed", String(vs.viewerMotion.enabled));
  vs.viewerMotionPanel?.querySelector("[data-motion-toggle]")?.setAttribute("aria-pressed", String(vs.viewerMotion.enabled));
  syncMobileViewerActions();
}

export function toggleViewerMotion() {
  vs.viewerMotion = normalizeViewerMotion({ ...vs.viewerMotion, enabled: !vs.viewerMotion.enabled });
  saveViewerMotion();
  syncViewerMotionUi();
  trackEvent("viewer_motion_toggle", vs.viewerMotion.enabled ? "on" : "off", { mode: vs.viewerMotion.mode, speed: vs.viewerMotion.speed });
}

export function applyViewerTransition(element = vs.pswp?.currSlide?.content?.element) {
  if (!element || !vs.viewerMotion.enabled || vs.rapidSurf || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  fx.animateViewerTransition(element, vs.viewerMotion.mode, vs.viewerMotion.speed);
}

export function toggleFilmstrip() {
  const root = vs.pswp?.element;
  if (!root) return;
  const hidden = root.classList.toggle("pswp-filmstrip-hidden");
  vs.viewerChromeMetrics.refresh();
  syncMobileViewerActions();
  trackEvent("filmstrip_toggle", hidden ? "hidden" : "visible");
}

export async function toggleViewerFullscreen() {
  if (!vs.pswp?.element) return;
  if (document.fullscreenElement) await document.exitFullscreen?.();
  else await vs.pswp.element.requestFullscreen?.();
  syncMobileViewerActions();
}

export function mountViewerMotionPanel(instance) {
  if (vs.viewerMotionPanel) return closeViewerPanels();
  const invoker = nextViewerPanelInvoker();
  closeViewerPanels("motion");
  vs.viewerPanelInvoker = invoker;
  const panel = document.createElement("section");
  panel.className = "pswp-motion-settings";
  panel.setAttribute("aria-label", "Viewer motion settings");
  const options = VIEWER_MOTION_MODES.map((mode) => `<option value="${mode}"${mode === vs.viewerMotion.mode ? " selected" : ""}>${esc(VIEWER_MOTION_LABELS[mode] || mode)}</option>`).join("");
  panel.innerHTML = `<header><div><span>Viewer motion</span><b>Transitions and speed</b></div><button type="button" aria-label="Close motion settings">×</button></header><div class="pswp-motion-body"><button type="button" class="pswp-motion-toggle" data-motion-toggle aria-pressed="${vs.viewerMotion.enabled}"><span>Transitions</span><b>${vs.viewerMotion.enabled ? "On" : "Immediate"}</b></button><label><span>Style</span><select data-motion-mode>${options}</select></label><label><span>Speed</span><input data-motion-speed type="range" min="120" max="700" step="20" value="${vs.viewerMotion.speed}"><output>${vs.viewerMotion.speed} ms</output></label><p>Immediate is the default and always wins during rapid browsing.</p></div>`;
  panel.querySelector("header button").addEventListener("click", () => closeViewerPanels());
  panel.querySelector("[data-motion-toggle]").addEventListener("click", () => {
    toggleViewerMotion();
    panel.querySelector("[data-motion-toggle] b").textContent = vs.viewerMotion.enabled ? "On" : "Immediate";
  });
  panel.querySelector("[data-motion-mode]").addEventListener("change", (event) => {
    vs.viewerMotion = normalizeViewerMotion({ ...vs.viewerMotion, mode: event.target.value, enabled: true });
    saveViewerMotion();
    syncViewerMotionUi();
    applyViewerTransition();
  });
  panel.querySelector("[data-motion-speed]").addEventListener("input", (event) => {
    vs.viewerMotion = normalizeViewerMotion({ ...vs.viewerMotion, speed: Number(event.target.value) });
    event.target.nextElementSibling.textContent = `${vs.viewerMotion.speed} ms`;
    saveViewerMotion();
  });
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
  instance.element.appendChild(panel);
  vs.viewerMotionPanel = panel;
  syncViewerMotionUi();
  syncViewerPanelState();
  panel.querySelector("button")?.focus({ preventScroll: true });
}

export function toggleViewerGuide(instance) {
  if (vs.viewerGuidePanel) return closeViewerPanels();
  const invoker = nextViewerPanelInvoker();
  closeViewerPanels("guide");
  vs.viewerPanelInvoker = invoker;
  const panel = document.createElement("section");
  panel.className = "pswp-guide";
  panel.setAttribute("aria-label", "Viewer guide");
  panel.innerHTML = `<header><div><span>Viewer guide</span><b>Browse, inspect, and control media</b></div><button type="button" aria-label="Close viewer guide">×</button></header><p class="pswp-guide-intro">Everything stays keyboard- and pointer-friendly. Opening another viewer tool automatically closes this guide.</p><div class="pswp-guide-grid">${GUIDE_SECTIONS.map(([title, items]) => `<section><h3>${esc(title)}</h3><ul>${items.map((item) => `<li>${esc(item)}</li>`).join("")}</ul></section>`).join("")}</div><section class="pswp-guide-shortcuts"><h3>Keyboard map</h3><ul>${SHORTCUTS.map(([key, desc]) => `<li><span>${key}</span>${esc(desc)}</li>`).join("")}</ul></section>`;
  panel.querySelector("button").addEventListener("click", () => closeViewerPanels());
  panel.addEventListener("pointerdown", (event) => event.stopPropagation());
  instance.element.appendChild(panel);
  vs.viewerGuidePanel = panel;
  vs.viewerGuideButton?.classList.add("is-active");
  vs.viewerGuideButton?.setAttribute("aria-pressed", "true");
  syncViewerPanelState();
  panel.querySelector("button")?.focus({ preventScroll: true });
}

export function downloadCurrentViewerFile() {
  closeViewerPanels();
  const file = vs.pswp?.currSlide?.data?.file;
  if (file) void downloadFile(file);
}

export function setMobileActionsOpen(open, { restoreFocus = true } = {}) {
  if (!vs.mobileViewerActions || !vs.mobileViewerDock) return;
  const wasOpen = !vs.mobileViewerActions.hidden;
  if (open) closeViewerPanels({ except: "mobile-actions", forceInfo: true });
  vs.mobileViewerActions.hidden = !open;
  const more = vs.mobileViewerDock.querySelector(".pswp-mobile-more");
  more?.setAttribute("aria-expanded", String(open));
  if (open) vs.mobileViewerActions.querySelector("button:not([disabled])")?.focus();
  else if (wasOpen && restoreFocus) more?.focus({ preventScroll: true });
  syncViewerPanelState();
}

export function syncMobileViewerActions() {
  if (!vs.mobileViewerActions) return;
  const rotation = rotationFor(vs.pswp?.currSlide?.data?.file);
  const reset = vs.mobileViewerActions.querySelector('[data-mobile-action="reset-rotation"]');
  if (reset) {
    reset.disabled = rotation === 0;
    const label = rotation ? `Reset ${rotation}°` : "Reset rotation";
    reset.querySelector("span").textContent = label;
  }
  const filmstrip = vs.mobileViewerActions.querySelector('[data-mobile-action="toggle-filmstrip"]');
  if (filmstrip) {
    const label = vs.pswp?.element?.classList.contains("pswp-filmstrip-hidden") ? "Show filmstrip" : "Hide filmstrip";
    filmstrip.querySelector("span").textContent = label;
  }
  const motion = vs.mobileViewerActions.querySelector('[data-mobile-action="motion-settings"]');
  if (motion) motion.querySelector("span").textContent = `Motion settings · ${vs.viewerMotion.enabled ? "On" : "Off"}`;
  const fullscreen = vs.mobileViewerActions.querySelector('[data-mobile-action="fullscreen"]');
  if (fullscreen) {
    const active = Boolean(document.fullscreenElement);
    const label = active ? "Exit fullscreen" : "Fullscreen";
    fullscreen.disabled = !active && typeof vs.pswp?.element?.requestFullscreen !== "function";
    fullscreen.querySelector("span").textContent = label;
  }
}

export function mountMobileViewerControls(instance) {
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
  vs.mobileViewerDock = dock;
  vs.mobileViewerActions = sheet;
  const syncFullscreen = () => syncMobileViewerActions();
  document.addEventListener("fullscreenchange", syncFullscreen);
  syncMobileViewerActions();

  return () => {
    more.removeEventListener("click", toggleMore);
    document.removeEventListener("fullscreenchange", syncFullscreen);
    dock.remove();
    sheet.remove();
    if (vs.mobileViewerDock === dock) vs.mobileViewerDock = null;
    if (vs.mobileViewerActions === sheet) vs.mobileViewerActions = null;
  };
}

export function registerUi(instance) {
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
        vs.assetLadderElement = element;
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
        vs.fileInfoToolbarButton = element;
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
        vs.viewerGuideButton = element;
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
        vs.viewerMotionButton = element;
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
    vs.syncRotationUi = () => {
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
    vs.syncRotationUi();
  });
  instance.on("afterInit", () => {
    syncRotateButtons();
    vs.syncRotationUi();
    instance.scrollWrap?.addEventListener("pointerdown", () => closeViewerPanels());
    instance.element?.querySelector(".pswp__button--zoom")?.addEventListener("click", () => {
      closeViewerPanels();
      const file = instance.currSlide?.data?.file;
      if (file && /^image\//.test(file.mime)) void vs.viewerAssets?.ensureFull(file, { reason: "explicit-zoom" });
    });
  });
  instance.on("destroy", () => {
    vs.viewerMotionButton = null;
    vs.viewerGuideButton = null;
    vs.fileInfoToolbarButton = null;
    closeViewerPanels({ forceInfo: true });
  });
}

// Caption updates are deliberately immediate: the image and its identity are
// one unit, so the text must never trail the current slide with an animation.
