import { computeJustifiedRows } from "./share-gallery-layout.js";
import { createSmartHeaderState } from "./share-smart-header.js";
import { switchGoogleAccount } from "./share-access.js";
import {
  $,
  STRIP_WIDTHS,
  crumbs,
  current,
  fx,
  lightboxItems,
  listingCache,
  meta,
  pin,
  selected,
  setAllowZip,
  setCurrent,
  setLightboxItems,
  setListFetchedAt,
  setMeta,
  setPin,
  setSortMode,
  setViewer,
  slug,
  sortMode,
  uiIcon,
  viewer,
  visibleFiles,
} from "./share-state.js";
import { toast, fmtDur } from "./share-utils.js";
import { identify } from "./identity.js";
import { trackEvent, installTracking } from "./share-beacon.js";
import { downloadFile } from "./share-download.js";
import { heatVideoTile, installHoverPreview, probeVideoMetadata, warmVideoTile } from "./share-preview.js";
import { openViewer } from "./share-viewer.js";
import {
  cancelTouchSelection,
  downloadZip,
  installTouchSelection,
  selectAll,
  toggleSelect,
  updateSelInfo,
} from "./share-select.js";


// Share gallery: Google-sign-in + PIN gate, folder navigation keyed on a
// stable folder id (never on the rotating signed "ls" token), a justified
// (Google-Photos-style) tile layout, a PhotoSwipe + Swiper media viewer,
// scrubbable hover previews, accelerated parallel-range downloads, and a
// batched browsing-analytics beacon.


// Gallery density runs 1-9 in quarter steps; the strip slider stays integer.
const clampTileScale = (value) => {
  const n = Number(value);
  return Math.max(1, Math.min(9, Number.isFinite(n) ? Math.round(n * 4) / 4 : 5));
};
let tileScale = clampTileScale(localStorage.getItem("lhdb_gallery_scale") ?? (localStorage.getItem("lhdb_tile_size") === "compact" ? 3 : localStorage.getItem("lhdb_tile_size") === "large" ? 7 : 5));
let summarySeq = 0;

const cardObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const file = entry.target._file;
            if (!file) continue;
            if (!/^video\//.test(file.mime)) {
              cardObserver.unobserve(entry.target);
              continue;
            }
            warmVideoTile(file, entry.isIntersecting);
            if (entry.isIntersecting && !file.aspect && !file.thumb) probeVideoMetadata(file);
          }
        },
        { rootMargin: "700px" },
      )
    : null;
// Second, margin-less observer: only tiles really in view buffer ahead.
const hotObserver =
  "IntersectionObserver" in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) if (entry.target._file) heatVideoTile(entry.target._file, entry.isIntersecting);
      })
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

function showShareGone(eyebrow = "closed", title = "This share is not available.", sub = "It expired, was paused, or the URL is incomplete.") {
  const gone = $("gone");
  gone.querySelector(".eyebrow").textContent = eyebrow;
  gone.querySelector("h1").textContent = title;
  gone.querySelector(".muted").textContent = sub;
  gone.classList.remove("hidden");
  const pill = $("ws-state");
  pill.dataset.state = "closed";
  pill.textContent = "share closed";
}

async function init() {
  $("ws-state").dataset.state = "checking";
  let r;
  try {
    r = await fetch(`/api/share/meta/${encodeURIComponent(slug)}`);
  } catch {
    $("loading").classList.add("hidden");
    return showShareGone("offline", "Can't reach this share.", "Check your connection and reload.");
  }
  $("loading").classList.add("hidden");
  if (r.status === 404) return showShareGone();
  if (r.status === 410) return showShareGone("expired", "This share has closed.", "Ask whoever sent it for a fresh link.");
  if (!r.ok) return showShareGone("hiccup", "Something went wrong on our side.", "Reload in a moment.");
  setMeta(await r.json());
  if (meta.state === "expired") return showShareGone("expired", "This share has closed.", "Ask whoever sent it for a fresh link.");
  if (meta.state !== "active") return showShareGone("paused", "This share is paused right now.", "Ask whoever sent it to reopen it.");
  $("ws-state").dataset.state = "secure";
  document.title = `${meta.label} - LostHusky's DropBox`;
  applyTheme(meta.theme || {});
  logOpenOnce();
  identify({ slug });
  setViewer(meta.viewer || null);

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

export function showGate(needsAuth, needsPin) {
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
  $("pin").inputMode = meta?.pinDigits === false ? "text" : "numeric";
  $("pin-go").classList.toggle("hidden", !needsPin || needsAuth);
  const startGoogleSignIn = () => {
    location.href = `/api/auth/login?slug=${encodeURIComponent(slug)}`;
  };
  $("google-signin").onclick = startGoogleSignIn;
  const switchAccount = $("switch-google-account");
  switchAccount.onclick = () =>
    void switchGoogleAccount({
      button: switchAccount,
      error: $("gate-err"),
      logout: () => fetch("/api/auth/logout", { method: "POST" }),
      navigate: startGoogleSignIn,
    });
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
  setPin(candidate);
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
    setSortMode(sortEl.value);
    localStorage.setItem("lhdb_sort", sortMode);
    render();
  });
  installTileSizeControl();
  installGalleryTools();
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("blur", cancelTouchSelection);
  document.addEventListener("visibilitychange", () => document.hidden && cancelTouchSelection());
  window.addEventListener("popstate", onPopState);
  installTracking();
  crumbs.push({ fid: "", name: meta.label, token: "" });
  await navigate(crumbs[0], { push: false });
  installSmartGalleryHeader();
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

export async function navigate(entry, { push = true, fromHistory = false } = {}) {
  cancelTouchSelection();
  setGalleryToolsOpen(false);
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
    setListFetchedAt(Date.now());
    setCurrent(d);
    current.summary = null;
    setAllowZip(d.allowZip !== false);
    render();
    loadSummary();
    trackEvent("nav", entry.name || meta.label);
  } catch (err) {
    if (err.authRequired) {
      setViewer(null);
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
  requestAnimationFrame(() => {
    box.scrollLeft = box.scrollWidth;
  });
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

export function render(revealOnlyIds = null) {
  cancelTouchSelection();
  renderCrumbs();
  renderMeta();
  const host = $("folders");
  host.innerHTML = "";
  visibleFiles.clear();
  setLightboxItems([]);
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
  // A share whose root holds only folders looked empty at first glance.
  if (!folders.some((f) => f.files.length) && folders.some((f) => f.subfolders?.length)) {
    const hint = document.createElement("div");
    hint.className = "empty folder-hint";
    hint.innerHTML = `${uiIcon("folder-open")}<span>Everything is inside the folder${folders.reduce((n, f) => n + (f.subfolders?.length || 0), 0) === 1 ? "" : "s"} above - open one to browse.</span>`;
    host.appendChild(hint);
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

export function refreshLoadMoreCopy() {
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

export async function prefetchMore(folder) {
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

export function renderMeta() {
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
    tileScale = clampTileScale(next);
    range.value = String(tileScale);
    const label = sizeDescription(tileScale);
    range.setAttribute("aria-valuetext", label);
    control.querySelector(".size-control-value").textContent = label;
    control.style.setProperty("--size-progress", `${((tileScale - 1) / 8) * 100}%`);
    control.style.setProperty("--size-frac", String((tileScale - 1) / 8));
    localStorage.setItem("lhdb_gallery_scale", String(tileScale));
    scheduleLayout();
    if (report) trackEvent("layout", label, { control: "tile-size", step: tileScale });
  };
  range.addEventListener("input", () => apply(range.value, true));
  // Wheel over the slider nudges a quarter step; double-click resets.
  control.addEventListener("wheel", (e) => {
    e.preventDefault();
    apply(tileScale + (e.deltaY < 0 ? 0.25 : -0.25), true);
  }, { passive: false });
  control.addEventListener("dblclick", () => apply(5, true));
  apply(tileScale);
}

const galleryToolsMedia = matchMedia("(max-width: 640px)");
let galleryToolsInstalled = false;
let smartGalleryHeaderInstalled = false;
let refreshSmartGalleryHeader = () => {};

export function setGalleryToolsOpen(open) {
  const sheet = $("gallery-tools-sheet");
  const toggle = $("gallery-tools-toggle");
  if (!sheet || !toggle) return;
  const wasOpen = !sheet.hidden;
  sheet.hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("gallery-tools-open", open);
  if (open) refreshSmartGalleryHeader();
  if (open) sheet.querySelector("button, input, select")?.focus();
  else if (wasOpen && galleryToolsMedia.matches) toggle.focus({ preventScroll: true });
}

function installSmartGalleryHeader() {
  if (smartGalleryHeaderInstalled) return;
  const toolbar = document.querySelector(".gallery-toolbar");
  if (!toolbar) return;
  smartGalleryHeaderInstalled = true;
  const media = matchMedia("(max-width: 640px)");
  const state = createSmartHeaderState();
  let frame = 0;

  const refresh = () => {
    frame = 0;
    const y = Math.max(0, window.scrollY || 0);
    const top = parseFloat(getComputedStyle(toolbar).top) || 0;
    const stuck = y > 0 && toolbar.getBoundingClientRect().top <= top + 1;
    const locked = document.body.classList.contains("gallery-tools-open") || toolbar.contains(document.activeElement);
    const hidden = state.update({ y, stuck, enabled: media.matches, locked });
    toolbar.classList.toggle("is-scroll-hidden", hidden);
  };

  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(refresh);
  };

  const onBreakpointChange = () => {
    if (!media.matches) {
      state.reset(window.scrollY);
      toolbar.classList.remove("is-scroll-hidden");
    }
    schedule();
  };

  refreshSmartGalleryHeader = () => {
    state.reset(window.scrollY);
    toolbar.classList.remove("is-scroll-hidden");
    schedule();
  };
  window.addEventListener("scroll", schedule, { passive: true });
  document.addEventListener("focusin", schedule);
  if (media.addEventListener) media.addEventListener("change", onBreakpointChange);
  else media.addListener(onBreakpointChange);
  refresh();
}

function syncGalleryToolsPlacement() {
  const sort = $("sort");
  const toolbar = sort?.closest(".toolbar-tools");
  const sortControl = sort?.closest(".sort-control") || sort;
  const slot = $("gallery-tools-slot");
  if (!toolbar || !slot) return;
  if (galleryToolsMedia.matches) {
    slot.append($("tile-size"), $("select-all"), $("select-none"));
    return;
  }
  setGalleryToolsOpen(false);
  toolbar.insertBefore($("tile-size"), sortControl);
  toolbar.insertBefore($("select-all"), $("sel-info"));
  toolbar.insertBefore($("select-none"), $("sel-info"));
}

function installGalleryTools() {
  if (galleryToolsInstalled) return syncGalleryToolsPlacement();
  galleryToolsInstalled = true;
  $("gallery-tools-toggle").addEventListener("click", () => setGalleryToolsOpen($("gallery-tools-sheet").hidden));
  $("gallery-tools-close").addEventListener("click", () => setGalleryToolsOpen(false));
  const onBreakpointChange = () => syncGalleryToolsPlacement();
  if (galleryToolsMedia.addEventListener) galleryToolsMedia.addEventListener("change", onBreakpointChange);
  else galleryToolsMedia.addListener(onBreakpointChange);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("gallery-tools-sheet").hidden) setGalleryToolsOpen(false);
  });
  document.addEventListener("pointerdown", (event) => {
    const sheet = $("gallery-tools-sheet");
    if (sheet.hidden || sheet.contains(event.target) || $("gallery-tools-toggle").contains(event.target)) return;
    setGalleryToolsOpen(false);
  });
  syncGalleryToolsPlacement();
}


function sizeDescription(step) {
  return ["Maximum density", "High density", "Dense", "Compact", "Balanced", "Spacious", "Large tiles", "Detail view", "Maximum detail"][Math.round(step) - 1];
}

export function stripSizeDescription(step) {
  return `${STRIP_WIDTHS[step - 1]} px`;
}

function folderCard(sub) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "folder-card";
  el.dataset.cursor = "folder";
  el.innerHTML = `${uiIcon("folder")}<span></span>`;
  el.querySelector("span").textContent = sub.name;
  el.addEventListener("click", () => navigate({ fid: sub.fid, name: sub.name, token: sub.ls }, { push: true }));
  return el;
}

// ---- Cards ----

export function isViewable(file) {
  return (/^image\//.test(file.mime) && file.thumb) || /^video\//.test(file.mime);
}

function thumbTierForSize(size) {
  return size <= 512 ? "base" : size <= 1280 ? "mid" : "max";
}

export function thumbUrl(file, sizeOrTier = "base") {
  if (!file?.thumb && !file?.thumbs) return "";
  if (/^data:/i.test(file.thumb || "")) return file.thumb;
  const tier = typeof sizeOrTier === "string" ? sizeOrTier : thumbTierForSize(sizeOrTier);
  return file.thumbs?.[tier] || file.thumb || "";
}

export function card(file) {
  const fig = document.createElement("figure");
  fig._file = file;
  const media = /^(image|video)\//.test(file.mime) && file.thumb;
  const isVideo = /^video\//.test(file.mime);
  const blocked = !!file.downloadBlocked;
  fig.className = `g-card${media ? "" : " plain"}${isVideo ? " video-card" : ""}${blocked ? " download-blocked" : ""}`;
  fig.dataset.cursor = isVideo ? "video" : media ? "photo" : "";
  const dur = file.dur ? `<span class="g-dur">${fmtDur(file.dur)}</span>` : "";
  const play = isVideo ? `<span class="g-play">${uiIcon("play")}</span>` : "";
  fig.innerHTML = `
    <button class="g-check" type="button" aria-label="select ${escAttr(file.name)}" data-cursor="link">
      ${uiIcon("check")}
    </button>
    <a class="g-dl${blocked ? " blocked" : ""}" href="${escAttr(file.dl)}" download aria-label="${blocked ? "download blocked for" : "download"} ${escAttr(file.name)}" title="${blocked ? escAttr(file.downloadBlockReason || "Download blocked") : ""}" data-cursor="link">
      ${uiIcon("download")}
    </a>
    ${play}${dur}
    <figcaption><b>${esc(file.name)}</b><span>${fmtBytes(file.size)}</span></figcaption>`;

  if (file.thumb) {
    const mediaBox = document.createElement("div");
    mediaBox.className = "g-media";
    const img = document.createElement("img");
    img.draggable = false;
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
  if (hotObserver && /^video\//.test(file.mime)) hotObserver.observe(fig);
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

export function iconFor(mime) {
  if (/^image\//.test(mime)) return "IMG";
  if (/^video\//.test(mime)) return "VID";
  if (/^audio\//.test(mime)) return "AUD";
  if (/pdf/.test(mime)) return "PDF";
  if (/zip|compressed|tar/.test(mime)) return "ZIP";
  return "FILE";
}

export function inlineUrl(file) {
  if (!file?.dl) return thumbUrl(file, "max");
  return `${file.dl}${file.dl.includes("?") ? "&" : "?"}inline=1`;
}

// Low-res transcode (see src/previews.js) when one exists and its token is
// still good; otherwise the original.
export function previewUrl(file) {
  return file?.preview && file.previewExpiresAt - Date.now() > 60_000 ? `${file.preview}?inline=1` : "";
}

// ---- Justified layout (Google-Photos style rows, no cropping) ----

let layoutScheduled = false;
export function scheduleLayout() {
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
  const W = Math.floor(grid.getBoundingClientRect().width);
  if (!W || !files.length) return;
  const stops = [0.52, 0.62, 0.72, 0.84, 1, 1.18, 1.36, 1.58, 1.82];
  const lo = Math.min(8, Math.floor(tileScale) - 1);
  const base = stops[lo] + (stops[Math.min(8, lo + 1)] - stops[lo]) * (tileScale - 1 - lo);
  const target = Math.round((W < 640 ? 148 : W < 1280 ? 210 : 250) * base);
  const planned = computeJustifiedRows(
    files.map((file) => ({ id: file.id, aspect: aspectOf(file) })),
    {
      containerWidth: W,
      gap: W <= 640 ? 3 : 2,
      targetHeight: target,
      maxItems: W <= 640 ? 2 : Infinity,
      wideThreshold: W <= 640 ? 2.2 : Infinity,
    },
  );
  const byId = new Map(files.map((file) => [file.id, file]));
  for (const row of planned) {
    for (const item of row.items) {
      const el = byId.get(item.id)?._el;
      if (!el) continue;
      el.style.width = `${item.width}px`;
      el.style.height = `${item.height}px`;
    }
  }
}
