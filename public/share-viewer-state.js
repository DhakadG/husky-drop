// Viewer state shared by the share-viewer-* modules. Everything here gets
// reassigned while the viewer runs, so it lives on one object instead of
// per-module bindings.

import { readScale, STRIP_WIDTHS, VIEWER_MOTION_KEY } from "./share-state.js";
import { normalizeViewerMotion } from "./share-viewer-engine.js";

export function loadViewerMotion() {
  try {
    return normalizeViewerMotion(JSON.parse(localStorage.getItem(VIEWER_MOTION_KEY) || "null"));
  } catch {
    return normalizeViewerMotion(null);
  }
}

export const vs = {
  stripScale: readScale("lhdb_strip_scale", matchMedia("(max-width: 640px)").matches ? 3 : 5, STRIP_WIDTHS.length),
  viewerChromeMetrics: { refresh: () => {}, cleanup: () => {} },
  mobileViewerControlsCleanup: () => {},
  viewerMotion: loadViewerMotion(),
  pswp: null,
  pswpModulePromise: null,
  strip: null,
  viewerAssets: null,
  rapidController: null,
  rapidSurf: false,
  activeAssetState: null,
  assetLadderElement: null,
  neighborWarmGeneration: 0,
  neighborWarmIds: new Set(),
  viewerMotionButton: null,
  viewerMotionPanel: null,
  suppressNextViewerTransition: false,
  viewerRefreshPanelException: "",
  syncRotationUi: () => {},
  viewerGuidePanel: null,
  viewerGuideButton: null,
  stripSettingsPanel: null,
  viewerPanelInvoker: null,
  mobileViewerDock: null,
  mobileViewerActions: null,
  captionEl: null,
  fileInfoPanel: null,
  fileInfoPinned: false,
  fileInfoToolbarButton: null,
  fileInfoRequest: 0,
  fileInfoCloseTimer: 0,
};
// Set once the strip module is loaded (needs stripHeightForScale).
export const viewerChrome = { top: 104, bottom: 0 };
