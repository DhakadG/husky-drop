// Shared gallery state for the share page modules. Reads are live ES
// bindings; anything reassigned after load goes through a setter so the
// binding updates for every importer.

export const $ = (id) => document.getElementById(id);
export const slug = location.pathname.split("/").filter(Boolean).pop();
// ponytail: share-fx.js is a plain <script> loaded before this module in
// share.html, so window.shareFx is always set by the time this runs.
export const fx = window.shareFx;
export const { uiIcon } = window;

export let meta = null;
export let viewer = null;
export let pin = sessionStorage.getItem(`lhdb_spin_${slug}`) || "";
export let allowZip = true;
export let listFetchedAt = 0;
export let current = null; // active listing: { folders: [...] }
export let sortMode = localStorage.getItem("lhdb_sort") || "name";
export let lightboxItems = [];
export function setMeta(v) { meta = v; }
export function setViewer(v) { viewer = v; }
export function setPin(v) { pin = v; }
export function setAllowZip(v) { allowZip = v; }
export function setListFetchedAt(v) { listFetchedAt = v; }
export function setCurrent(v) { current = v; }
export function setSortMode(v) { sortMode = v; }
export function setLightboxItems(v) { lightboxItems = v; }

export const STRIP_WIDTHS = [34, 40, 46, 54, 64, 76, 90, 106, 124, 144, 168, 192, 216];
export const STRIP_HEIGHTS = [26, 30, 35, 42, 49, 58, 68, 80, 94, 108, 126, 144, 162];
// crumbs: [{ fid, name, token }]. fid "" = root. Navigation is keyed on the
// stable fid, never on `token` (a signed "ls" token that is re-minted with a
// new signature on every listing call and therefore compares unequal across
// requests - keying on it was the root cause of duplicate breadcrumbs).
export const crumbs = [];
export const listingCache = new Map(); // fid -> { d, token, at }
export const selected = new Map(); // fileId -> file
export const visibleFiles = new Map(); // fileId -> currently rendered file
export const TOKEN_REFRESH_MS = 90 * 1000;
export const canHoverPreview = fx.canHoverPreview;
export const previewVideos = new Map(); // fileId -> video
export const videoWarmLeases = new Map(); // fileId -> shared signed source ownership
export const decodedImages = new Map(); // `${fileId}:${tier}` -> decoded blob-backed image asset
export const assetControllers = new Map();
export const viewerTransforms = new Map();
export const fileInfoCache = new Map();
export const FULL_CACHE_LIMIT = 4;
export const VIEWER_MOTION_KEY = "husky-share-viewer-motion-v1";
export const VIEWER_MOTION_LABELS = Object.freeze({
  fade: "Fade",
  "soft-zoom": "Soft zoom",
  "zoom-in": "Zoom in",
  "zoom-out": "Zoom out",
  "scale-up": "Scale up",
  "slide-horizontal": "Slide horizontal",
  "slide-vertical": "Slide vertical",
  "slide-up": "Slide up",
  "slide-down": "Slide down",
  "slide-left": "Slide left",
  "slide-right": "Slide right",
  skew: "Skew",
  rotate: "Rotate",
  "rotate-left": "Rotate left",
  "rotate-right": "Rotate right",
  "flip-x": "Flip horizontal",
  "flip-y": "Flip vertical",
  blur: "Focus blur",
  brightness: "Light flash",
  "film-cut": "Film cut",
  bounce: "Soft bounce",
  swing: "Swing",
});

export function readScale(key, fallback, max = 9) {
  const stored = key ? localStorage.getItem(key) : null;
  const value = stored == null ? Number(fallback) : Number(stored);
  return Math.max(1, Math.min(max, Number.isFinite(value) ? Math.round(value) : 5));
}
