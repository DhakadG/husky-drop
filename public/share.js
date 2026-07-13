import {
  VIEWER_MOTION_MODES,
  assetLampState,
  assetProgress,
  createRapidSurfController,
  createViewerAssetEngine,
  normalizeRotation,
  normalizeViewerMotion,
  verifyFullAsset,
} from "./share-viewer-engine.js";
import { createDragSelectionController } from "./share-selection-engine.js";

// Share gallery: Google-sign-in + PIN gate, folder navigation keyed on a
// stable folder id (never on the rotating signed "ls" token), a justified
// (Google-Photos-style) tile layout, a PhotoSwipe + Swiper media viewer,
// scrubbable hover previews, accelerated parallel-range downloads, and a
// batched browsing-analytics beacon.

const $ = (id) => document.getElementById(id);
const slug = location.pathname.split("/").filter(Boolean).pop();
// ponytail: share-fx.js is a plain <script> loaded before this module in
// share.html, so window.shareFx is always set by the time this runs.
const fx = window.shareFx;
const { uiIcon, uiIconDefinition } = window;

let meta = null;
let viewer = null;
let pin = sessionStorage.getItem(`lhdb_spin_${slug}`) || "";
let allowZip = true;
let listFetchedAt = 0;
let current = null; // active listing: { folders: [...] }
let sortMode = localStorage.getItem("lhdb_sort") || "name";
let tileScale = readScale("lhdb_gallery_scale", localStorage.getItem("lhdb_tile_size") === "compact" ? 3 : localStorage.getItem("lhdb_tile_size") === "large" ? 7 : 5);
const STRIP_WIDTHS = [34, 40, 46, 54, 64, 76, 90, 106, 124, 144, 168, 192, 216];
const STRIP_HEIGHTS = [26, 30, 35, 42, 49, 58, 68, 80, 94, 108, 126, 144, 162];
let stripScale = readScale("lhdb_strip_scale", 5, STRIP_WIDTHS.length);
// crumbs: [{ fid, name, token }]. fid "" = root. Navigation is keyed on the
// stable fid, never on `token` (a signed "ls" token that is re-minted with a
// new signature on every listing call and therefore compares unequal across
// requests - keying on it was the root cause of duplicate breadcrumbs).
const crumbs = [];
const listingCache = new Map(); // fid -> { d, token, at }
const selected = new Map(); // fileId -> file
const visibleFiles = new Map(); // fileId -> currently rendered file
let lightboxItems = [];
let summarySeq = 0;
const TOKEN_REFRESH_MS = 90 * 1000;
const canHoverPreview = fx.canHoverPreview;
const previewVideos = new Map(); // fileId -> video
const decodedImages = new Map(); // `${fileId}:${tier}` -> decoded blob-backed image asset
const assetControllers = new Map();
const viewerTransforms = new Map();
const fileInfoCache = new Map();
const FULL_CACHE_LIMIT = 4;
const VIEWER_MOTION_KEY = "husky-share-viewer-motion-v1";
const VIEWER_MOTION_LABELS = Object.freeze({
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
let viewerMotion = loadViewerMotion();
const cardObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              const file = entry.target._file;
              if (file && /^video\//.test(file.mime) && !file.aspect && !file.thumb) probeVideoMetadata(file);
              cardObserver.unobserve(entry.target);
            }
          }
        },
        { rootMargin: "700px" },
      )
    : null;
const moreObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.target._folder) prefetchMore(entry.target._folder);
          }
        },
        { rootMargin: "700px" },
      )
    : null;

init();

async function init() {
  const r = await fetch(`/api/share/meta/${encodeURIComponent(slug)}`);
  $("loading").classList.add("hidden");
  if (!r.ok) return $("gone").classList.remove("hidden");
  meta = await r.json();
  if (meta.state !== "active") return $("gone").classList.remove("hidden");
  document.title = `${meta.label} - LostHusky's DropBox`;
  applyTheme(meta.theme || {});
  logOpenOnce();
  viewer = meta.viewer || null;

  const needsAuth = !!meta.requiresAuth && !viewer;
  if (needsAuth) return showGate(true, !!meta.requiresPin);

  if (meta.requiresPin) {
    if (pin && (await verifyPinValue(pin, true))) return enter();
    return showGate(false, true);
  }
  enter();
}

function applyTheme(theme) {
  document.documentElement.style.setProperty("--accent", theme.accentColor || "#2f6bff");
  document.documentElement.style.setProperty("--page-bg", theme.backgroundColor || "#eaf0f9");
  if (theme.backgroundUrl) document.body.style.backgroundImage = `url("${theme.backgroundUrl}")`;
  if (theme.logoUrl) {
    $("link-logo").src = theme.logoUrl;
    $("link-logo").classList.remove("hidden");
  }
}

function logOpenOnce() {
  const key = `lhdb_sopen_${slug}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "1");
  fetch("/api/share/opened", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug }),
  }).catch(() => {});
}

// ---- Gate: Google sign-in + PIN combined on one screen ----

function showGate(needsAuth, needsPin) {
  const gate = $("gate");
  gate.classList.remove("hidden");
  fx.fadeIn(gate);
  $("gate-label").textContent = needsAuth ? "Sign in to continue" : meta.label;
  $("gate-signed-out").classList.toggle("hidden", !needsAuth);
  $("gate-signed-in").classList.toggle("hidden", !viewer);
  if (viewer) {
    const avatar = $("viewer-avatar");
    if (viewer.picture) {
      avatar.src = viewer.picture;
      avatar.classList.remove("hidden");
    } else {
      avatar.classList.add("hidden");
    }
    $("viewer-name").textContent = viewer.name || "";
    $("viewer-email").textContent = viewer.email || "";
  }
  $("gate-pin").classList.toggle("hidden", !needsPin);
  $("pin-go").classList.toggle("hidden", !needsPin || needsAuth);
  $("google-signin").onclick = () => {
    location.href = `/api/auth/login?slug=${encodeURIComponent(slug)}`;
  };
  $("pin-go").onclick = tryPin;
  $("pin")?.addEventListener("keydown", (e) => e.key === "Enter" && tryPin());
  handleSigninError();
}

function handleSigninError() {
  const q = new URLSearchParams(location.search);
  const err = q.get("signinError");
  if (!err) return;
  $("gate-err").textContent = err;
  fx.shake($("gate"));
  q.delete("signinError");
  const clean = location.pathname + (q.toString() ? `?${q}` : "");
  history.replaceState(null, "", clean);
}

async function tryPin() {
  const candidate = $("pin").value.trim();
  if (!(await verifyPinValue(candidate))) return;
  pin = candidate;
  sessionStorage.setItem(`lhdb_spin_${slug}`, pin);
  $("gate").classList.add("hidden");
  enter();
}

async function verifyPinValue(candidate, silent = false) {
  if (!silent) $("gate-err").textContent = "";
  const r = await fetch("/api/share/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, pin: candidate }),
  });
  if (r.ok) return true;
  if (silent) return false;
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 && d.authRequired) {
    $("gate-err").textContent = "Please sign in with Google first.";
  } else if (r.status === 429) {
    $("gate-err").textContent = `Too many attempts. Try again in ${d.retryAfter || 60}s.`;
  } else {
    $("gate-err").textContent = d.error || "Wrong password.";
  }
  fx.shake($("gate"));
  return false;
}

function enter() {
  if (meta.mode === "redirect") return doRedirect();
  showGallery();
}

async function doRedirect() {
  $("redirect-panel").classList.remove("hidden");
  $("redirect-label").textContent = meta.label;
  const r = await fetch("/api/share/redirect", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, pin }),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.urls?.length) {
    $("redirect-label").textContent = d.error || "Could not open this share.";
    return;
  }
  const box = $("redirect-links");
  box.innerHTML = "";
  d.urls.forEach((url, i) => {
    const a = document.createElement("a");
    a.className = "btn";
    a.href = url;
    a.rel = "noreferrer";
    a.textContent = d.urls.length === 1 ? "Open the folder in Google Drive" : `Open folder ${i + 1} in Google Drive`;
    box.appendChild(a);
  });
  if (d.urls.length === 1) location.href = d.urls[0];
}

async function showGallery() {
  $("main").classList.remove("hidden");
  $("label").textContent = meta.label;
  $("select-all").addEventListener("click", () => selectAll(true));
  $("select-none").addEventListener("click", () => selectAll(false));
  $("zip-btn").addEventListener("click", downloadZip);
  $("mobile-clear")?.addEventListener("click", () => selectAll(false));
  $("mobile-zip")?.addEventListener("click", downloadZip);
  const sortEl = $("sort");
  sortEl.value = sortMode;
  sortEl.addEventListener("change", () => {
    sortMode = sortEl.value;
    localStorage.setItem("lhdb_sort", sortMode);
    render();
  });
  installTileSizeControl();
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("blur", cancelTouchSelection);
  document.addEventListener("visibilitychange", () => document.hidden && cancelTouchSelection());
  window.addEventListener("popstate", onPopState);
  installTracking();
  crumbs.push({ fid: "", name: meta.label, token: "" });
  await navigate(crumbs[0], { push: false });
}

// ---- Navigation core (stable fid, dedupe, browser history) ----

async function fetchListing(token) {
  const body = { slug, pin };
  if (token) body.folderToken = token;
  const r = await fetch("/api/share/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const err = new Error(d.error || `HTTP ${r.status}`);
    err.status = r.status;
    err.authRequired = !!d.authRequired;
    throw err;
  }
  return r.json();
}

async function loadSummary() {
  const seq = ++summarySeq;
  const here = crumbs[crumbs.length - 1];
  const body = { slug, pin };
  if (here?.token) body.folderToken = here.token;
  try {
    const r = await fetch("/api/share/summary", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return;
    const d = await r.json();
    if (seq !== summarySeq || !current) return;
    current.summary = d;
    renderMeta();
    refreshLoadMoreCopy();
  } catch {
    // Exact counts are a progressive enhancement; listing still works.
  }
}

let navigating = false;

// Fetches a listing for the given fid, using (and repairing) the cache.
// When a cached signed token has expired, the parent listing is re-fetched
// to mint a fresh one for the same fid before retrying once.
async function resolveListing(entry) {
  const cached = listingCache.get(entry.fid);
  if (cached && Date.now() - cached.at < 5 * 60000) return cached.d;
  try {
    const d = await fetchListing(entry.token);
    listingCache.set(entry.fid, { d, token: entry.token, at: Date.now() });
    return d;
  } catch (err) {
    if (err.status !== 403 || !entry.fid) throw err;
    // The "ls" token for this folder expired. Re-list the parent (which we
    // do have a live token for) to mint a fresh one for the same fid.
    const parent = crumbs[crumbs.length - 2] || crumbs[0];
    const parentListing = await fetchListing(parent.token);
    listingCache.set(parent.fid, { d: parentListing, token: parent.token, at: Date.now() });
    const fresh = (parentListing.folders || []).flatMap((f) => f.subfolders || []).find((s) => s.fid === entry.fid);
    if (!fresh) throw err;
    entry.token = fresh.ls;
    const d = await fetchListing(fresh.ls);
    listingCache.set(entry.fid, { d, token: fresh.ls, at: Date.now() });
    return d;
  }
}

async function navigate(entry, { push = true, fromHistory = false } = {}) {
  cancelTouchSelection();
  if (navigating) return;
  const fid = entry.fid || "";
  if (push && crumbs.length && crumbs[crumbs.length - 1].fid === fid) return;
  navigating = true;
  const host = $("folders");
  host.setAttribute("aria-busy", "true");
  try {
    const d = await resolveListing(entry);
    if (push) {
      const dupAt = crumbs.findIndex((c) => c.fid === fid);
      if (dupAt >= 0) crumbs.splice(dupAt + 1);
      else crumbs.push({ fid, name: entry.name, token: entry.token });
    }
    if (!fromHistory) {
      const path = crumbs
        .map((c) => c.fid)
        .filter(Boolean)
        .join("/");
      history.pushState({ fid }, "", path ? `#${path}` : location.pathname);
    }
    listFetchedAt = Date.now();
    current = d;
    current.summary = null;
    allowZip = d.allowZip !== false;
    render();
    loadSummary();
    trackEvent("nav", entry.name || meta.label);
  } catch (err) {
    if (err.authRequired) {
      viewer = null;
      $("main").classList.add("hidden");
      showGate(true, !!meta.requiresPin);
    } else {
      toast("Could not open folder", String(err.message || err).slice(0, 80), "err");
    }
  } finally {
    navigating = false;
    host.removeAttribute("aria-busy");
  }
}

function onPopState() {
  const fids = (location.hash.slice(1) || "").split("/").filter(Boolean);
  const targetFid = fids.at(-1) || "";
  let idx = crumbs.findIndex((c) => c.fid === targetFid);
  if (idx < 0) idx = 0; // unknown state (e.g. reload mid-path) - fall back to root
  const target = crumbs[idx];
  crumbs.splice(idx + 1);
  navigate(target, { push: false, fromHistory: true });
}

function goToCrumb(index) {
  if (index < 0 || index >= crumbs.length - 1) return;
  // Do NOT trim crumbs here first: navigate()'s own dedupe check compares
  // the target against the *current last* crumb, and only trims down to
  // the target once the fetch succeeds. Pre-trimming made that check see
  // the target as already-current (since it had just become the last
  // crumb) and return immediately without ever navigating - clicking a
  // breadcrumb silently did nothing, while browser back/forward (which
  // calls navigate with push:false, skipping that check) worked fine.
  navigate(crumbs[index], { push: true });
}

function renderCrumbs() {
  const box = $("crumbs");
  box.innerHTML = "";
  crumbs.forEach((c, i) => {
    if (i > 0) {
      const sep = document.createElement("span");
      sep.className = "crumb-sep";
      sep.textContent = "/";
      box.appendChild(sep);
    }
    const el = document.createElement(i === crumbs.length - 1 ? "span" : "button");
    el.className = "crumb" + (i === crumbs.length - 1 ? " here" : "");
    el.textContent = c.name;
    el.dataset.cursor = "link";
    if (i < crumbs.length - 1) {
      el.type = "button";
      el.addEventListener("click", () => goToCrumb(i));
    }
    box.appendChild(el);
  });
  fx.crumbSwap(box);
}

// ---- Rendering ----

function sortFiles(files) {
  const arr = [...files];
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  if (sortMode === "new") arr.sort((a, b) => b.at - a.at || byName(a, b));
  else if (sortMode === "old") arr.sort((a, b) => a.at - b.at || byName(a, b));
  else if (sortMode === "size") arr.sort((a, b) => b.size - a.size || byName(a, b));
  else if (sortMode === "type") arr.sort((a, b) => a.mime.localeCompare(b.mime) || byName(a, b));
  else arr.sort(byName);
  return arr;
}

function render(revealOnlyIds = null) {
  cancelTouchSelection();
  renderCrumbs();
  renderMeta();
  const host = $("folders");
  host.innerHTML = "";
  visibleFiles.clear();
  lightboxItems = [];
  const folders = current?.folders || [];
  if (!folders.length || folders.every((f) => !f.files.length && !f.subfolders?.length)) {
    host.innerHTML = `<div class="empty">Nothing in this folder yet.</div>`;
    updateSelInfo();
    return;
  }
  const revealTargets = [];
  const newRevealTargets = [];
  for (const folder of folders) {
    const section = document.createElement("section");
    section.className = "gallery-folder";
    if (folders.length > 1 && folder.name) {
      const head = document.createElement("div");
      head.className = "section-subtitle";
      head.textContent = `${folder.name} - ${folder.files.length} file${folder.files.length === 1 ? "" : "s"}`;
      section.appendChild(head);
    }
    // Folders always render before files within a listing.
    const subs = [...(folder.subfolders || [])].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (subs.length) {
      const row = document.createElement("div");
      row.className = "folder-row";
      for (const sub of subs) {
        const fc = folderCard(sub);
        row.appendChild(fc);
        revealTargets.push(fc);
      }
      section.appendChild(row);
    }
    const files = sortFiles(folder.files || []);
    const grid = document.createElement("div");
    grid.className = "justified";
    grid._files = files;
    files.forEach((file, i) => {
      file._renderIndex = i;
      const el = card(file);
      file._el = el;
      visibleFiles.set(file.id, file);
      grid.appendChild(el);
      revealTargets.push(el);
      if (revealOnlyIds?.has(file.id)) newRevealTargets.push(el);
      if (isViewable(file)) {
        file._lbIndex = lightboxItems.length;
        lightboxItems.push(file);
      }
    });
    section.appendChild(grid);
    if (folder.nextPageToken) {
      const more = loadMoreButton(folder);
      section.appendChild(more);
    }
    host.appendChild(section);
  }
  updateSelInfo();
  scheduleLayout();
  fx.reveal(revealOnlyIds ? newRevealTargets : revealTargets);
}

function loadMoreButton(folder) {
  const more = document.createElement("button");
  more.className = "load-more-card";
  more.type = "button";
  more._folder = folder;
  more.innerHTML = `
    <span class="load-more-main">Load next files</span>
    <span class="load-more-sub"></span>
    <i aria-hidden="true"></i>`;
  more.addEventListener("click", () => loadMore(folder, more));
  updateLoadMoreCopy(more, folder);
  moreObserver?.observe(more);
  return more;
}

function refreshLoadMoreCopy() {
  document.querySelectorAll(".load-more-card").forEach((button) => {
    if (button._folder) updateLoadMoreCopy(button, button._folder);
  });
}

function updateLoadMoreCopy(button, folder, state = "") {
  const loaded = (folder.files || []).length;
  const total = current?.summary?.files || 0;
  const remaining = total ? Math.max(0, total - loaded) : 0;
  const next = Math.min(200, remaining || 200);
  button.classList.toggle("loading", state === "loading");
  button.classList.toggle("error", state === "error");
  button.querySelector(".load-more-main").textContent = state === "loading" ? "Loading more files..." : state === "error" ? "Could not load. Try again" : `Load next ${next}`;
  button.querySelector(".load-more-sub").textContent = total ? `${loaded} of ${total} shown` : `${loaded} shown - counting total`;
}

async function loadMore(folder, button) {
  button.disabled = true;
  updateLoadMoreCopy(button, folder, "loading");
  try {
    const page = await prefetchMore(folder);
    folder._prefetch = null;
    folder._prefetchPromise = null;
    if (!page) throw new Error("No page returned");
    const newIds = new Set((page.files || []).map((file) => file.id));
    folder.files.push(...page.files);
    for (const sub of page.subfolders || []) {
      if (!folder.subfolders.some((s) => s.fid === sub.fid)) folder.subfolders.push(sub);
    }
    folder.nextPageToken = page.nextPageToken;
    render(newIds);
  } catch {
    button.disabled = false;
    updateLoadMoreCopy(button, folder, "error");
  }
}

async function prefetchMore(folder) {
  if (folder._prefetch) return folder._prefetch;
  if (folder._prefetchPromise) return folder._prefetchPromise;
  if (!folder.nextPageToken) return null;
  folder._prefetchPromise = fetchMorePage(folder)
    .then((page) => {
      folder._prefetch = page;
      return page;
    })
    .finally(() => {
      folder._prefetchPromise = null;
    });
  return folder._prefetchPromise;
}

async function fetchMorePage(folder) {
  const here = crumbs[crumbs.length - 1];
  const body = { slug, pin, pageToken: folder.nextPageToken };
  if (here.token) body.folderToken = here.token;
  else body.folderIndex = folder.index;
  const r = await fetch("/api/share/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("load failed");
  const d = await r.json();
  return (d.folders || [])[0] || null;
}

function renderMeta() {
  const el = $("meta");
  el.innerHTML = "";
  const folders = current?.folders || [];
  const loadedCount = folders.reduce((t, f) => t + f.files.length, 0);
  const subCount = folders.reduce((t, f) => t + (f.subfolders?.length || 0), 0);
  const loadedBytes = folders.reduce((t, f) => t + f.files.reduce((x, y) => x + y.size, 0), 0);
  const summary = current?.summary;
  const count = summary?.files ?? loadedCount;
  const folderCount = summary?.folders ?? subCount;
  const bytes = summary?.bytes ?? loadedBytes;
  el.append(chip(summary ? `${count} file${count === 1 ? "" : "s"}` : `${loadedCount} shown - counting`));
  if (folderCount) el.append(chip(`${folderCount} folder${folderCount === 1 ? "" : "s"}`));
  el.append(chip(fmtBytes(bytes)));
  if (summary?.videos) el.append(chip(`${summary.videos} video${summary.videos === 1 ? "" : "s"}`));
  if (meta.expiresAt) {
    const days = Math.max(0, Math.ceil((meta.expiresAt - Date.now()) / 86400000));
    el.append(chip(`closes in ${days} day${days === 1 ? "" : "s"}`, days <= 2 ? "warn" : ""));
  }
}

function installTileSizeControl() {
  const control = $("tile-size");
  const range = $("tile-size-range");
  if (!control || !range) return;
  const apply = (next, report = false) => {
    tileScale = readScale("", next);
    range.value = String(tileScale);
    const label = sizeDescription(tileScale);
    range.setAttribute("aria-valuetext", label);
    control.querySelector(".size-control-value").textContent = label;
    control.style.setProperty("--size-progress", `${((tileScale - 1) / 8) * 100}%`);
    localStorage.setItem("lhdb_gallery_scale", String(tileScale));
    scheduleLayout();
    if (report) trackEvent("layout", sizeDescription(tileScale), { control: "tile-size", step: tileScale });
  };
  range.addEventListener("input", () => apply(range.value, true));
  apply(tileScale);
}

function readScale(key, fallback, max = 9) {
  const value = key ? Number(localStorage.getItem(key)) : Number(fallback);
  return Math.max(1, Math.min(max, Number.isFinite(value) ? Math.round(value) : 5));
}

function sizeDescription(step) {
  return ["Maximum density", "High density", "Dense", "Compact", "Balanced", "Spacious", "Large tiles", "Detail view", "Maximum detail"][step - 1];
}

function stripSizeDescription(step) {
  return `${STRIP_WIDTHS[step - 1]} px`;
}

function folderCard(sub) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "folder-card";
  el.dataset.cursor = "folder";
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg><span></span>`;
  el.querySelector("span").textContent = sub.name;
  el.addEventListener("click", () => navigate({ fid: sub.fid, name: sub.name, token: sub.ls }, { push: true }));
  return el;
}

// ---- Cards ----

function isViewable(file) {
  return (/^image\//.test(file.mime) && file.thumb) || /^video\//.test(file.mime);
}

function thumbTierForSize(size) {
  return size <= 512 ? "base" : size <= 1280 ? "mid" : "max";
}

function thumbUrl(file, sizeOrTier = "base") {
  if (!file?.thumb && !file?.thumbs) return "";
  if (/^data:/i.test(file.thumb || "")) return file.thumb;
  const tier = typeof sizeOrTier === "string" ? sizeOrTier : thumbTierForSize(sizeOrTier);
  return file.thumbs?.[tier] || file.thumb || "";
}

function card(file) {
  const fig = document.createElement("figure");
  fig._file = file;
  const media = /^(image|video)\//.test(file.mime) && file.thumb;
  const isVideo = /^video\//.test(file.mime);
  const blocked = !!file.downloadBlocked;
  fig.className = `g-card${media ? "" : " plain"}${isVideo ? " video-card" : ""}${blocked ? " download-blocked" : ""}`;
  fig.dataset.cursor = isVideo ? "video" : media ? "photo" : "";
  const dur = file.dur ? `<span class="g-dur">${fmtDur(file.dur)}</span>` : "";
  const play = isVideo ? `<span class="g-play"><svg viewBox="0 0 24 24"><polygon points="8 5 19 12 8 19 8 5"/></svg></span>` : "";
  fig.innerHTML = `
    <button class="g-check" type="button" aria-label="select ${escAttr(file.name)}" data-cursor="link">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    </button>
    <a class="g-dl${blocked ? " blocked" : ""}" href="${escAttr(file.dl)}" download aria-label="${blocked ? "download blocked for" : "download"} ${escAttr(file.name)}" title="${blocked ? escAttr(file.downloadBlockReason || "Download blocked") : ""}" data-cursor="link">
      <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
    </a>
    ${play}${dur}
    <figcaption><b>${esc(file.name)}</b><span>${fmtBytes(file.size)}</span></figcaption>`;

  if (file.thumb) {
    const mediaBox = document.createElement("div");
    mediaBox.className = "g-media";
    const img = document.createElement("img");
    img.loading = file._renderIndex < 18 ? "eager" : "lazy";
    img.decoding = "async";
    img.fetchPriority = file._renderIndex < 8 ? "high" : "auto";
    img.referrerPolicy = "no-referrer";
    img.alt = file.name;
    img.sizes = "(max-width: 640px) 48vw, (max-width: 1280px) 24vw, 320px";
    if (!/^data:/i.test(file.thumb)) {
      img.srcset = [320, 512, 768, 1024].map((s) => `${thumbUrl(file, s)} ${s}w`).join(", ");
    }
    img.src = thumbUrl(file, 512);
    img.onload = () => {
      if (!file.aspect && img.naturalWidth && img.naturalHeight) {
        file.aspect = img.naturalWidth / img.naturalHeight;
        scheduleLayout();
      }
    };
    img.onerror = () => {
      fig.classList.add("plain");
      mediaBox.replaceWith(plainIcon(file));
    };
    mediaBox.appendChild(img);
    fig.prepend(mediaBox);
  } else {
    fig.prepend(plainIcon(file));
  }

  const check = fig.querySelector(".g-check");
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSelect(file, fig);
  });
  fig.querySelector(".g-dl").addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    downloadFile(file);
  });
  fig.addEventListener("click", () => {
    if (selected.size) return toggleSelect(file, fig);
    if (file._lbIndex != null) openViewer(file._lbIndex, fig);
    else downloadFile(file);
  });
  installTouchSelection(fig, file);
  installHoverPreview(fig, file);
  fx.tileDepth(fig);
  if (cardObserver) cardObserver.observe(fig);
  fig.classList.toggle("selected", selected.has(file.id));
  return fig;
}

function plainIcon(file) {
  const ico = document.createElement("div");
  ico.className = "file-ico";
  ico.innerHTML = `<span>${iconFor(file.mime)}</span><b>${esc(shortName(file.name))}</b>`;
  return ico;
}

function shortName(name) {
  return name.length > 34 ? `${name.slice(0, 20)}…${name.slice(-11)}` : name;
}

function iconFor(mime) {
  if (/^image\//.test(mime)) return "IMG";
  if (/^video\//.test(mime)) return "VID";
  if (/^audio\//.test(mime)) return "AUD";
  if (/pdf/.test(mime)) return "PDF";
  if (/zip|compressed|tar/.test(mime)) return "ZIP";
  return "FILE";
}

// ---- Download tokens + accelerated parallel-range download ----

function tokenFresh(file) {
  return file.dl && file.dlExpiresAt && file.dlExpiresAt - Date.now() > TOKEN_REFRESH_MS;
}

async function ensureFreshDownload(file, force = false, signal) {
  if (!force && tokenFresh(file)) return file.dl;
  const r = await fetch("/api/share/refresh-dl", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, pin, dl: file.dl }),
    signal,
  });
  if (!r.ok) throw new Error("download link expired");
  const d = await r.json();
  file.dl = d.dl;
  file.dlExpiresAt = d.dlExpiresAt;
  file.thumbs = d.thumbs || file.thumbs;
  file.thumbsExpireAt = d.thumbsExpireAt || file.thumbsExpireAt;
  file.thumb = file.thumbs?.base || file.thumb;
  if (file._el) {
    const a = file._el.querySelector(".g-dl");
    if (a) a.href = file.dl;
  }
  return file.dl;
}

// Always a plain anchor-click download: the browser's native progressive
// download straight to the Downloads folder, on every device, with no
// dialog of any kind - which is the universal fallback in the first place,
// so there's nothing else to fall back to. A previous version used the File
// System Access API's showSaveFilePicker() for large files to parallelize
// the transfer, but that pops a native OS "Save As" file-explorer dialog on
// every single download (Chrome/Edge only; unsupported elsewhere), which
// reads as broken compared to how downloads work on every other site.
async function downloadFile(file) {
  trackEvent("download", file.name, { size: file.size, mime: file.mime, blocked: !!file.downloadBlocked });
  if (file.downloadBlocked) {
    toast("Download blocked", file.downloadBlockReason || "This public share blocks risky file types.", "warn");
    return;
  }
  try {
    const url = await ensureFreshDownload(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name || "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    trackEvent("download_handoff", file.name, { size: file.size, mime: file.mime });
  } catch (err) {
    trackEvent("download_failed", file.name, { message: String(err.message || err).slice(0, 120) });
    toast("Download failed", String(err.message || err).slice(0, 80), "err");
  }
}

// ---- Hover preview: play by default, deliberate scrubbing, buffered bar ----
//
// One state machine per card (idle -> playing -> scrubbing). Desktop scrub
// reads e.shiftKey live on every pointermove instead of tracking a global
// "is Shift down" flag - a global flag goes stale the moment a keyup is
// missed (losing focus, a browser shortcut, alt-tabbing while the key is
// down), which is exactly what caused scrubbing to get stuck on. Reading
// the key state directly off each event is self-correcting: the very next
// mouse move always reflects reality.

function installHoverPreview(fig, file) {
  if (!/^video\//.test(file.mime)) return;
  let hoverTimer = 0;
  let scrubRaf = 0;
  let startPromise = null;
  const state = { scrubbing: false };

  const requestPreview = () => {
    if (!startPromise) {
      startPromise = startHoverPreview(fig, file, { reset: true }).finally(() => {
        startPromise = null;
      });
    }
    return startPromise;
  };

  const beginScrub = () => {
    const video = previewVideos.get(file.id);
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0 || !fig.classList.contains("previewing")) return false;
    state.scrubbing = true;
    video.pause();
    fig.classList.add("scrubbing");
    fx.setScrubbing(true, fig);
    return true;
  };

  // Always sets --scrub-x (and the timestamp badge) in the same synchronous
  // step that turns scrubbing on, so the playhead/badge never has a frame
  // where it's showing at its CSS default (dead center) before JS catches up.
  const scrubTo = (clientX) => {
    const video = previewVideos.get(file.id);
    if (!video || !video.duration) return;
    const r = fig.getBoundingClientRect();
    const pct = Math.max(0, Math.min(0.999, (clientX - r.left) / r.width));
    const t = pct * video.duration;
    fig.style.setProperty("--scrub-x", `${pct * 100}%`);
    updateScrubBadge(fig, video, t);
    if (!scrubRaf) {
      scrubRaf = requestAnimationFrame(() => {
        scrubRaf = 0;
        if (Math.abs(video.currentTime - t) > 0.08) {
          if (video.fastSeek) video.fastSeek(t);
          else video.currentTime = t;
        }
      });
    }
  };

  const endScrub = ({ resume = true, stopPreview = false } = {}) => {
    if (!state.scrubbing) return;
    cancelAnimationFrame(scrubRaf);
    scrubRaf = 0;
    state.scrubbing = false;
    fig.classList.remove("scrubbing");
    fig.style.removeProperty("--scrub-x");
    fx.setScrubbing(false, fig);
    const video = previewVideos.get(file.id);
    if (stopPreview) stopHoverPreview(fig, file, { removeBar: true });
    else if (resume && video && fig.classList.contains("previewing")) video.play().catch(() => {});
  };

  if (canHoverPreview) {
    fig.addEventListener("pointerenter", (e) => {
      if (selected.size || e.pointerType !== "mouse") return;
      hoverTimer = setTimeout(requestPreview, 140);
    });

    // The single desktop mouse handler: Shift held -> scrub; Shift not held
    // while a scrub was in progress -> resume normal playback. No separate
    // "shift mode" flag to fall out of sync with the key.
    fig.addEventListener("pointermove", (e) => {
      if (selected.size || e.pointerType !== "mouse") return;
      if (e.shiftKey) {
        if (!fig.classList.contains("previewing")) return requestPreview();
        if (!state.scrubbing && !beginScrub()) return;
        scrubTo(e.clientX);
      } else if (state.scrubbing) {
        endScrub({ resume: true });
      }
    });

    fig.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      clearTimeout(hoverTimer);
      endScrub({ resume: false });
      stopHoverPreview(fig, file);
    });
  }

}

async function startHoverPreview(fig, file, opts = {}) {
  if (!fig.isConnected || selected.size) return;
  try {
    const video = await getPreviewVideo(file);
    if (!fig.isConnected || selected.size) return;
    if (opts.reset) resetPreviewTime(video);
    const media = fig.querySelector(".g-media") || fig.querySelector(".file-ico");
    const hadThumb = !!file.thumb;
    video.className = "g-video-preview";
    video.controls = false;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    if (media && video.parentNode !== media) {
      // Keep the still thumbnail visible underneath until the video can
      // actually play, instead of a black frame while it buffers.
      fig.classList.add("buffering");
      video.style.opacity = "0";
      media.appendChild(video);
      attachBufferBar(media, video, fig);
    }
    revealPreviewWhenReady(fig, file, video, hadThumb);
    fig.classList.add("previewing");
    await video.play().catch(() => {});
  } catch {
    // Some browser/codec combinations refuse hover preview; click playback still works.
  }
}

function stopHoverPreview(fig, file, opts = {}) {
  const video = previewVideos.get(file.id);
  if (!video) return;
  video.pause();
  fig.classList.remove("previewing", "buffering");
  if (opts.removeBar) {
    fig.querySelector(".buffer-bar")?.remove();
    fig._scrubBadge = null;
  }
}

function resetPreviewTime(video) {
  const reset = () => {
    try {
      video.currentTime = 0;
    } catch {}
  };
  if (video.readyState >= 1) reset();
  else video.addEventListener("loadedmetadata", reset, { once: true });
}

function revealPreviewWhenReady(fig, file, video, hadThumb) {
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (!hadThumb) promoteVideoFrameAsThumb(file, fig, video);
    video.style.opacity = "";
    fig.classList.remove("buffering");
    updateScrubBadge(fig, video);
  };
  if (video.readyState >= 2) reveal();
  else {
    fig.classList.add("buffering");
    video.style.opacity = "0";
    video.addEventListener("loadeddata", reveal, { once: true });
    video.addEventListener("canplay", reveal, { once: true });
  }
}

// Captures a representative frame and keeps it as this file's thumbnail for
// the rest of the session, so a no-thumbnail tile doesn't go blank again the
// moment the pointer leaves it. Seeks a little into the clip first - frame 0
// is frequently black or still fading in right after a cut - and falls back
// to whatever frame is already showing if the seek doesn't settle quickly.
// Runs once per file (guarded by file.thumb / _sessionThumbFailed) and never
// blocks the live hover preview, which keeps playing throughout.
function promoteVideoFrameAsThumb(file, fig, video) {
  if (file.thumb || file._sessionThumbFailed || !video.videoWidth || !video.videoHeight) return;

  const capture = () => {
    try {
      const maxW = 720;
      const scale = Math.min(1, maxW / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      file.thumb = canvas.toDataURL("image/jpeg", 0.78);
      file.aspect = video.videoWidth / video.videoHeight;

      const img = document.createElement("img");
      img.loading = "eager";
      img.decoding = "async";
      img.alt = file.name;
      img.src = file.thumb;

      const host = video.parentElement;
      if (host?.classList.contains("file-ico")) {
        const mediaBox = document.createElement("div");
        mediaBox.className = "g-media session-thumb";
        mediaBox.appendChild(img);
        host.replaceWith(mediaBox);
        mediaBox.appendChild(video);
        attachBufferBar(mediaBox, video, fig);
      } else if (host?.classList.contains("g-media") && !host.querySelector("img")) {
        host.prepend(img);
      }
      fig.classList.remove("plain");
      fig.dataset.cursor = "video";
      scheduleLayout();
    } catch {
      file._sessionThumbFailed = true;
    }
  };

  const target = Math.min(1, (video.duration || 0) * 0.1);
  if (!target || video.currentTime >= target - 0.05) {
    capture();
    return;
  }
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    video.removeEventListener("seeked", finish);
    capture();
  };
  const timer = setTimeout(finish, 600);
  video.addEventListener("seeked", finish, { once: true });
  try {
    if (video.fastSeek) video.fastSeek(target);
    else video.currentTime = target;
  } catch {
    finish();
  }
}

// Small buffered/played bar pinned to the bottom of a hovering video tile -
// there are no native controls in hover mode, so this is the only feedback
// for "how much of this video has loaded" while scrubbing.
function attachBufferBar(host, video, fig) {
  const existing = host.querySelector(".buffer-bar");
  if (existing) {
    fig._scrubBadge = existing.querySelector(".scrub-time");
    return;
  }
  const bar = document.createElement("div");
  bar.className = "buffer-bar";
  bar.innerHTML = `<i class="buffered"></i><i class="played"></i><em class="scrub-time"></em>`;
  host.appendChild(bar);
  const buffered = bar.querySelector(".buffered");
  const played = bar.querySelector(".played");
  fig._scrubBadge = bar.querySelector(".scrub-time");
  const paint = () => {
    const d = video.duration || 0;
    let buf = 0;
    for (let i = 0; i < video.buffered.length; i++) buf = Math.max(buf, video.buffered.end(i));
    buffered.style.width = d ? `${Math.min(100, (buf / d) * 100)}%` : "0%";
    played.style.width = d ? `${Math.min(100, (video.currentTime / d) * 100)}%` : "0%";
    updateScrubBadge(fig, video);
  };
  for (const ev of ["progress", "timeupdate", "loadedmetadata", "seeking"]) video.addEventListener(ev, paint);
  fig?.addEventListener("pointerleave", () => bar.remove(), { once: true });
}

function updateScrubBadge(fig, video, time = video.currentTime) {
  const badge = fig?._scrubBadge;
  if (!badge || !video.duration) return;
  badge.textContent = `${fmtDur(time)} / ${fmtDur(video.duration)}`;
}

function waitForVideoDuration(video, timeoutMs = 1200) {
  if (video && Number.isFinite(video.duration) && video.duration > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      video.removeEventListener("loadedmetadata", finish);
      video.removeEventListener("durationchange", finish);
      video.removeEventListener("canplay", finish);
      resolve(Number.isFinite(video.duration) && video.duration > 0);
    };
    const timer = setTimeout(finish, timeoutMs);
    video.addEventListener("loadedmetadata", finish);
    video.addEventListener("durationchange", finish);
    video.addEventListener("canplay", finish);
  });
}

async function probeVideoMetadata(file) {
  if (!/^video\//.test(file.mime) || file.aspect) return;
  try {
    const video = await getPreviewVideo(file);
    if (video.videoWidth && video.videoHeight) {
      file.aspect = video.videoWidth / video.videoHeight;
      scheduleLayout();
    }
  } catch {
    // Keep the stable placeholder ratio.
  }
}

async function getPreviewVideo(file) {
  let video = previewVideos.get(file.id);
  if (video) return video;
  await ensureFreshDownload(file);
  video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.src = `${file.dl}?inline=1`;
  video.addEventListener("loadedmetadata", () => {
    if (!file.aspect && video.videoWidth && video.videoHeight) {
      file.aspect = video.videoWidth / video.videoHeight;
      scheduleLayout();
    }
  });
  previewVideos.set(file.id, video);
  return video;
}

// ---- Justified layout (Google-Photos style rows, no cropping) ----

let layoutScheduled = false;
function scheduleLayout() {
  if (layoutScheduled) return;
  layoutScheduled = true;
  requestAnimationFrame(() => {
    layoutScheduled = false;
    document.querySelectorAll(".justified").forEach(layoutGallery);
  });
}

function aspectOf(file) {
  const a = file.aspect || (file.w && file.h ? file.w / file.h : /^(image|video)\//.test(file.mime) && file.thumb ? 4 / 3 : 1);
  return Math.min(2.8, Math.max(0.45, a));
}

function layoutGallery(grid) {
  const files = grid._files || [];
  const W = grid.clientWidth;
  if (!W || !files.length) return;
  const GAP = 2;
  const base = [0.52, 0.62, 0.72, 0.84, 1, 1.18, 1.36, 1.58, 1.82][tileScale - 1];
  const target = Math.round((W < 640 ? 148 : W < 1280 ? 210 : 250) * base);
  const rows = [];
  let row = [];
  let sum = 0;
  for (const f of files) {
    row.push(f);
    sum += aspectOf(f);
    if (sum * target + GAP * (row.length - 1) >= W) {
      rows.push({ items: row, sum });
      row = [];
      sum = 0;
    }
  }
  if (row.length) rows.push({ items: row, sum, last: true });
  for (const r of rows) {
    const gaps = GAP * (r.items.length - 1);
    let h = r.last ? Math.min(target, (W - gaps) / r.sum) : (W - gaps) / r.sum;
    h = Math.min(h, target * 1.35);
    for (const f of r.items) {
      const el = f._el;
      if (!el) continue;
      el.style.width = `${Math.floor(aspectOf(f) * h)}px`;
      el.style.height = `${Math.round(h)}px`;
    }
  }
}

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
let syncRotationUi = () => {};

function loadViewerMotion() {
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

function inlineUrl(file) {
  if (!file?.dl) return thumbUrl(file, "max");
  return `${file.dl}${file.dl.includes("?") ? "&" : "?"}inline=1`;
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
  assetLadderElement.dataset.state = mapped.key;
  assetLadderElement.dataset.tier = state.tier;
  assetLadderElement.querySelector(".pswp-asset-label").textContent = mapped.label;
  const progress = assetProgress(state);
  assetLadderElement.style.setProperty("--asset-progress", `${Math.round(progress * 100)}%`);
  const bar = assetLadderElement.querySelector(".pswp-asset-progress");
  bar?.setAttribute("aria-valuenow", String(Math.round(progress * 100)));
  bar?.classList.toggle("indeterminate", Boolean(state.loading && !state.progress));
  fx.animateViewerLed(assetLadderElement.querySelector(".pswp-asset-lamp"), mapped.key);
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
  button.addEventListener("pointerdown", () => noteRapidNavigation(`arrow-${direction}`, true));
  for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
    button.addEventListener(type, () => endRapidNavigation(`arrow-${direction}-release`));
  }
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

async function openViewer(index, sourceEl) {
  if (index < 0 || index >= lightboxItems.length) return;
  cancelTouchSelection();
  const PhotoSwipe = await loadPswp();
  const file = lightboxItems[index];
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
    paddingFn: () => ({ top: window.innerWidth <= 640 ? 116 : 104, bottom: pswp?.element?.classList.contains("pswp-filmstrip-hidden") ? 56 : stripHeightForScale() + 70, left: 0, right: 0 }),
    appendToEl: document.body,
  });

  registerProgressiveImageContent(pswp);
  registerVideoContent(pswp);
  registerUi(pswp);
  pswp.on("change", () => {
    noteRapidNavigation("slide-change");
    closeViewerPanels({ except: fileInfoPinned ? "file-info" : "" });
    const current = lightboxItems[pswp.currIndex];
    updateCaption(current);
    syncStrip(pswp.currIndex);
    refreshFileInfo(current);
    if (/^image\//.test(current?.mime || "")) {
      void viewerAssets.activate(current).then(() => warmViewerNeighbors(pswp.currIndex));
    }
    applyViewerTransition();
    syncRotationUi();
    trackEvent("view", current?.name || "");
  });
  const editableTarget = (target) => target instanceof Element && target.closest("input, button, select, textarea, [contenteditable]");
  const goRelative = (amount) => pswp?.goTo(Math.max(0, Math.min(lightboxItems.length - 1, pswp.currIndex + amount)));
  const onViewerKeydown = (event) => {
    if (editableTarget(event.target)) return;
    const key = event.key;
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
    if (key === "Escape" && hasOpenViewerPanel()) {
      event.preventDefault();
      event.stopImmediatePropagation();
      closeViewerPanels({ forceInfo: true });
      return;
    }
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
    destroyStrip();
    closeViewerPanels({ forceInfo: true });
    pswp = null;
  });

  pswp.init();
  mountBottomBar(pswp);
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
    if (instance.currSlide?.data?.file?.id === file.id) {
      if (suppressNextViewerTransition) suppressNextViewerTransition = false;
      else applyViewerTransition(wrap);
    }
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

function rotateCurrentMedia(delta) {
  const file = pswp?.currSlide?.data?.file;
  if (!file || !/^(image|video)\//.test(file.mime)) return;
  closeViewerPanels();
  const rotation = setRotation(file, rotationFor(file) + delta);
  suppressNextViewerTransition = true;
  pswp.options.dataSource[pswp.currIndex] = pswpItem(file);
  pswp.refreshSlideContent(pswp.currIndex);
  syncRotationUi();
  trackEvent("media_rotate", `${rotation}°`, { file: file.name, direction: delta < 0 ? "left" : "right", mime: file.mime });
}

function resetCurrentRotation() {
  const file = pswp?.currSlide?.data?.file;
  const currentRotation = rotationFor(file);
  if (!file || !currentRotation) return;
  setRotation(file, 0);
  suppressNextViewerTransition = true;
  pswp.options.dataSource[pswp.currIndex] = pswpItem(file);
  pswp.refreshSlideContent(pswp.currIndex);
  syncRotationUi();
  trackEvent("media_rotation_reset", file.name, { mime: file.mime });
}

function registerVideoContent(instance) {
  instance.on("contentLoad", (e) => {
    const { content } = e;
    if (content.data.type !== "video") return;
    e.preventDefault();
    const file = content.data.file;
    const wrap = document.createElement("div");
    wrap.className = "pswp-video-wrap";
    wrap.dataset.fileId = file.id;
    applyImageTransform(wrap, file);
    if (file.thumb) {
      const poster = document.createElement("img");
      poster.className = "pswp-video-poster";
      poster.src = thumbUrl(file, "base");
      poster.alt = "";
      wrap.appendChild(poster);
    }
    const loading = document.createElement("div");
    loading.className = "pswp-video-loading";
    loading.textContent = "Loading video";
    wrap.appendChild(loading);
    content._startVideo = () => content._videoPromise ||= getPreviewVideo(file)
      .then((video) => {
        cleanupTilePreview(file);
        video.pause();
        video.controls = true;
        video.muted = false;
        video.loop = false;
        video.playsInline = true;
        video.preload = "metadata";
        video.className = "pswp-video";
        video.style.opacity = "";
        loading.remove();
        wrap.appendChild(video);
        content._video = video;
        if (instance.currSlide?.data?.file?.id === file.id) video.play().catch(() => {});
      })
      .catch(() => {
        loading.textContent = "Video could not be loaded";
      });
    content.element = wrap;
  });
  instance.on("contentActivate", (e) => {
    if (!e.content?._video) e.content?._startVideo?.();
    const video = e.content?._video;
    if (video) video.play().catch(() => {});
  });
  instance.on("contentDeactivate", (e) => {
    const video = e.content?._video;
    if (video) video.pause();
  });
  instance.on("contentDestroy", (e) => {
    const video = e.content?._video;
    if (video) {
      video.pause();
      video.controls = false;
      video.muted = true;
      video.loop = true;
      video.className = "g-video-preview";
      video.style.opacity = "0";
      video.remove();
    }
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
  ["Touch + hold a tile", "Scrub a video (touch)"],
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

function hasOpenViewerPanel() {
  return Boolean(viewerGuidePanel || stripSettingsPanel || viewerMotionPanel || fileInfoPanel?.classList.contains("open"));
}

function syncViewerPanelState() {
  pswp?.element?.classList.toggle("pswp-panel-open", hasOpenViewerPanel());
}

function closeViewerPanels(options = {}) {
  if (typeof options === "string") options = { except: options };
  const { except = "", forceInfo = false } = options;
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
  if (except !== "file-info" && (forceInfo || !fileInfoPinned)) {
    if (forceInfo) fileInfoPinned = false;
    setFileInfoOpen(false);
  }
  syncViewerPanelState();
}

function syncViewerMotionUi() {
  viewerMotionButton?.classList.toggle("is-active", viewerMotion.enabled);
  viewerMotionButton?.setAttribute("aria-pressed", String(viewerMotion.enabled));
  viewerMotionPanel?.querySelector("[data-motion-toggle]")?.setAttribute("aria-pressed", String(viewerMotion.enabled));
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
  pswp.updateSize(true);
  trackEvent("filmstrip_toggle", hidden ? "hidden" : "visible");
}

async function toggleViewerFullscreen() {
  if (!pswp?.element) return;
  if (document.fullscreenElement) await document.exitFullscreen?.();
  else await pswp.element.requestFullscreen?.();
}

function mountViewerMotionPanel(instance) {
  if (viewerMotionPanel) return closeViewerPanels();
  closeViewerPanels("motion");
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
}

function toggleViewerGuide(instance) {
  if (viewerGuidePanel) return closeViewerPanels();
  closeViewerPanels("guide");
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
  const icon = (name, id) => {
    const definition = uiIconDefinition(name);
    return { isCustomSVG: true, size: 24, inner: definition.body, outlineID: id };
  };
  const shortcut = (value) => (element) => element.setAttribute("aria-keyshortcuts", value);
  instance.on("uiRegister", () => {
    instance.ui.registerElement({
      name: "asset-ladder",
      order: 7,
      isButton: false,
      tagName: "div",
      html: '<span class="pswp-asset-lamp" aria-hidden="true"></span><span class="pswp-asset-label">Preview</span><span class="pswp-asset-progress" role="progressbar" aria-label="Image loading and full-resolution intent" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></span>',
      onInit: (element) => {
        element.className += " pswp-asset-ladder";
        element.setAttribute("role", "status");
        element.setAttribute("aria-live", "polite");
        assetLadderElement = element;
        updateAssetLadder();
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
      onClick: (_evt, _el, pswpInstance) => {
        closeViewerPanels();
        const file = pswpInstance.currSlide?.data?.file;
        if (file) downloadFile(file);
      },
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
      if (!rotationReset) return;
      rotationReset.disabled = rotation === 0;
      rotationReset.setAttribute("aria-disabled", String(rotation === 0));
      rotationReset.setAttribute("aria-label", rotation ? `Reset ${rotation} degree rotation` : "Image orientation is unchanged");
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

function formatShortDate(value) {
  const date = new Date(value);
  return [String(date.getDate()).padStart(2, "0"), String(date.getMonth() + 1).padStart(2, "0"), date.getFullYear()].join(" ");
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
  body.innerHTML = `<div class="pswp-info-loading"><i></i><span>Reading image metadata…</span></div>`;
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
    slideToClickedSlide: true,
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
    on: {
      click: (sw) => {
        const idx = Number(sw.clickedSlide?.dataset?.i);
        if (Number.isFinite(idx)) instance.goTo(idx);
      },
    },
  });
  stopFilmstripPropagation(host);
  applyStripScale(instance.element, false);
  syncStripActive();
}

function stopFilmstripPropagation(host) {
  // These listeners are installed after Swiper, so Swiper receives the event
  // first and PhotoSwipe's parent gesture/zoom handlers do not receive it.
  for (const type of ["pointerdown", "mousedown", "touchstart", "touchmove", "wheel", "click"]) {
    host.addEventListener(type, (event) => event.stopPropagation(), { passive: type !== "touchmove" });
  }
}

function mountStripSizeControl(instance) {
  if (stripSettingsPanel) return closeViewerPanels();
  closeViewerPanels("filmstrip");
  const panel = document.createElement("section");
  panel.className = "pswp-strip-settings";
  panel.setAttribute("aria-label", "Filmstrip size settings");
  panel.innerHTML = `<header><div><span>Viewer layout</span><b>Filmstrip size</b></div><button type="button" aria-label="Close filmstrip settings">×</button></header>`;
  const control = document.createElement("div");
  control.className = "pswp-strip-size size-control";
  control.innerHTML = `<div class="size-control-head"><span>Filmstrip scale</span><output class="size-control-value">${stripSizeDescription(stripScale)}</output></div><div class="size-control-rail"><span class="size-control-end"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="5" height="12" rx="1"/><rect x="11" y="6" width="5" height="12" rx="1"/><rect x="18" y="6" width="2" height="12" rx="1"/></svg><small>Browse</small></span><input type="range" min="1" max="13" step="1" value="${stripScale}" aria-label="Filmstrip thumbnail size" aria-valuetext="${stripSizeDescription(stripScale)}"/><span class="size-control-end"><svg class="large" viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="18" rx="2"/></svg><small>Inspect</small></span></div>`;
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
    pswp?.updateSize(true);
  }
}

function stripHeightForScale() {
  return STRIP_HEIGHTS[stripScale - 1];
}

// Explicit inline size on every slide, in addition to the CSS - belt and
// suspenders against any stylesheet-load-order regression (a vendor CSS
// file loading after ours previously overrode .lb-thumb's width/height with
// Swiper's own 100%/100% slide defaults, which is what made one thumbnail
// balloon to fill the whole viewer).
function stripSlide(f, i) {
  const el = document.createElement("div");
  el.className = "swiper-slide lb-thumb";
  el.dataset.i = i;
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
    el.insertAdjacentHTML("beforeend", `<i class="strip-play"><svg viewBox="0 0 24 24"><polygon points="8 5 19 12 8 19 8 5"/></svg></i>`);
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

// ---- Selection + zip ----

const touchSelection = createDragSelectionController({
  isSelected: (fileId) => selected.has(fileId),
  setSelected: (fileId, on) => {
    const file = visibleFiles.get(fileId);
    if (!file?._el) return;
    document.body.classList.add("drag-selecting");
    setSelection(file, file._el, on);
  },
  hitTest: (x, y) => document.elementFromPoint(x, y)?.closest(".g-card")?._file?.id || "",
  scrollBy: (delta) => window.scrollBy(0, delta),
  viewportHeight: () => window.visualViewport?.height || window.innerHeight,
  vibrate: (duration) => {
    if (typeof navigator.vibrate === "function") navigator.vibrate(duration);
  },
});

function cancelTouchSelection() {
  touchSelection.cancel();
  document.body.classList.remove("drag-selecting");
}

function installTouchSelection(fig, file) {
  let suppressClickUntil = 0;

  fig.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch" || event.target.closest("button, a")) return;
      touchSelection.pointerDown({
        pointerId: event.pointerId,
        fileId: file.id,
        x: event.clientX,
        y: event.clientY,
        capture: (pointerId) => {
          try {
            fig.setPointerCapture(pointerId);
          } catch {}
        },
        release: (pointerId) => {
          try {
            if (fig.hasPointerCapture(pointerId)) fig.releasePointerCapture(pointerId);
          } catch {}
        },
      });
    },
    { passive: true },
  );

  fig.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "touch") return;
      const active = touchSelection.pointerMove({ pointerId: event.pointerId, x: event.clientX, y: event.clientY });
      if (active) event.preventDefault();
    },
    { passive: false },
  );

  fig.addEventListener(
    "pointerup",
    (event) => {
      if (event.pointerType !== "touch") return;
      const wasActive = touchSelection.pointerUp(event.pointerId);
      document.body.classList.remove("drag-selecting");
      if (!wasActive) return;
      suppressClickUntil = performance.now() + 500;
      event.preventDefault();
      event.stopPropagation();
    },
    { passive: false },
  );

  const cancelPointer = () => cancelTouchSelection();
  fig.addEventListener("pointercancel", cancelPointer);
  fig.addEventListener("lostpointercapture", cancelPointer);
  fig.addEventListener(
    "click",
    (event) => {
      if (performance.now() >= suppressClickUntil) return;
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}

function setSelection(file, fig, on) {
  const changed = selected.has(file.id) !== on;
  if (on) selected.set(file.id, file);
  else selected.delete(file.id);
  fig.classList.toggle("selected", on);
  if (changed && on) fx.pop(fig.querySelector(".g-check"));
  document.body.classList.toggle("selecting", selected.size > 0);
  updateSelInfo();
}

function toggleSelect(file, fig) {
  setSelection(file, fig, !selected.has(file.id));
}

function selectAll(on) {
  cancelTouchSelection();
  selected.clear();
  if (on) {
    for (const f of current?.folders || []) for (const file of f.files) selected.set(file.id, file);
  }
  document.querySelectorAll(".g-card").forEach((el) => el.classList.remove("selected"));
  if (on) document.querySelectorAll(".g-card").forEach((el) => el.classList.add("selected"));
  document.body.classList.toggle("selecting", selected.size > 0);
  updateSelInfo();
}

function updateSelInfo() {
  const files = [...selected.values()];
  const bytes = files.reduce((t, f) => t + f.size, 0);
  $("sel-info").textContent = files.length ? `${files.length} selected - ${fmtBytes(bytes)}` : "";
  $("mobile-sel-info").textContent = files.length ? `${files.length} selected - ${fmtBytes(bytes)}` : "";
  $("select-none").classList.toggle("hidden", files.length === 0);
  $("mobile-select-bar").classList.toggle("hidden", files.length === 0);
  const btn = $("zip-btn");
  const mobileZip = $("mobile-zip");
  if (!allowZip) {
    btn.classList.add("hidden");
    mobileZip.classList.add("hidden");
    return;
  }
  btn.classList.toggle("hidden", files.length === 0);
  mobileZip.classList.toggle("hidden", files.length === 0);
  btn.textContent = files.length ? `Download ${files.length} as zip (${fmtBytes(bytes)})` : "Download zip";
  mobileZip.textContent = files.length ? `Zip ${files.length}` : "Download zip";
}

async function downloadZip() {
  trackEvent("zip_requested", meta?.label || slug, { selected: selected.size });
  let files = [...selected.values()];
  if (!files.length) return;
  const locallyBlocked = files.filter((f) => f.downloadBlocked);
  files = files.filter((f) => !f.downloadBlocked);
  if (!files.length) {
    toast("Zip blocked", "Every selected file is blocked by the public-download safety policy.", "warn");
    return;
  }
  if (locallyBlocked.length) {
    toast("Skipped blocked files", `${locallyBlocked.length} risky file${locallyBlocked.length === 1 ? "" : "s"} excluded.`, "warn");
  }
  const bytes = files.reduce((t, f) => t + f.size, 0);

  const btn = $("zip-btn");
  btn.disabled = true;
  $("mobile-zip").disabled = true;
  const zipName = `${meta.label.replace(/[^\w-]+/g, "_") || "share"}.zip`;
  try {
    btn.textContent = "Preparing zip...";
    $("mobile-zip").textContent = "Preparing...";
    const ticket = await createServerZipTicket(files);
    if (ticket.blocked?.length) {
      toast("Skipped blocked files", `${ticket.blocked.length} risky file${ticket.blocked.length === 1 ? "" : "s"} excluded.`, "warn");
    }
    const a = document.createElement("a");
    a.href = ticket.url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    trackEvent("zip_started", zipName, { count: ticket.count || files.length, bytes });
    toast("Zip download started", `${ticket.count || files.length} files - ${fmtBytes(bytes)}`, "ok");
  } catch (err) {
    trackEvent("zip_failed", meta?.label || slug, { message: String(err.message || err).slice(0, 120) });
    toast(err.downloadBlocked ? "Zip blocked" : "Zip failed", String(err.message || err).slice(0, 100), "err");
  } finally {
    btn.disabled = false;
    $("mobile-zip").disabled = false;
    updateSelInfo();
  }
}

async function createServerZipTicket(files) {
  const r = await fetch("/api/share/zip-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug,
      pin,
      files: files.map((f) => ({ dl: f.dl, name: f.name, size: f.size, mime: f.mime })),
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const err = new Error(d.error || "server zip failed");
    err.status = r.status;
    err.downloadBlocked = r.status === 451;
    err.blocked = d.blocked || [];
    throw err;
  }
  return r.json();
}

// ---- Browsing-session analytics beacon ----
// Batches folder navigation + media-view events and flushes them via
// sendBeacon (so a closed tab still delivers) rather than a KV write per
// click - lets the owner see who browsed what and where load is slow.

const trackQueue = [];
const trackSessionId =
  window.shareTrekker?.sessionId || window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function trackEvent(t, name, data = {}) {
  const mapped = t === "view" ? "media_view_start" : t;
  if (window.shareTrekker) {
    window.shareTrekker.track(mapped, name, data);
    window.clarity?.("event", mapped);
    return;
  }
  trackQueue.push({ t: mapped, name: String(name || "").slice(0, 160), data });
  if (trackQueue.length >= 20) flushTrack();
  window.clarity?.("event", t);
}

function flushTrack(useBeacon = false) {
  if (!trackQueue.length) return;
  const events = trackQueue.splice(0, trackQueue.length);
  const payload = JSON.stringify({ slug, sessionId: trackSessionId, events });
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/share/track", new Blob([payload], { type: "application/json" }));
    return;
  }
  fetch("/api/share/track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

function installTracking() {
  setInterval(() => flushTrack(false), 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushTrack(true);
  });
  window.addEventListener("pagehide", () => flushTrack(true));
  window.clarity?.("identify", viewer?.email || `anon-${trackSessionId}`, trackSessionId, slug, viewer?.name);
  window.clarity?.("set", "slug", slug);
}

// ---- Utilities ----

// chip/fmtBytes/esc/escAttr live in public.js (shared with admin.js/drop.js).

function toast(title, message = "", tone = "", sticky = false) {
  const stack = $("toasts");
  if (!stack) return null;
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.innerHTML = `<b></b><span></span>`;
  item.querySelector("b").textContent = title;
  item.querySelector("span").textContent = message;
  stack.appendChild(item);
  requestAnimationFrame(() => item.classList.add("show"));
  if (!sticky) {
    setTimeout(() => {
      item.classList.remove("show");
      setTimeout(() => item.remove(), 260);
    }, 4200);
  }
  return item;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
