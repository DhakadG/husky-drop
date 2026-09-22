import { computeJustifiedRows, hoverZoomOrigin, positionPreview } from "./share-gallery-layout.js";
import { delayedSkeleton, skelFolders, skelTiles } from "./skeleton.js";
import { createSmartHeaderState } from "./share-smart-header.js";
import { switchGoogleAccount } from "./share-access.js";
import {
  $,
  STRIP_WIDTHS,
  canHoverPreview,
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
import { cachedJson, rememberJson } from "./share-cache.js";
import { ensureVideoPoster, heatVideoTile, installHoverPreview, probeVideoMetadata, warmVideoTile } from "./share-preview.js";
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
            // A video with no Drive thumbnail used to stay a blank chip until
            // the pointer landed on it. Pull its own poster as it scrolls near.
            if (entry.isIntersecting && !file.thumb) ensureVideoPoster(file, entry.target);
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
  const returnHash = sessionStorage.getItem(`lhdb_sreturn_${slug}`);
  if (returnHash) {
    sessionStorage.removeItem(`lhdb_sreturn_${slug}`);
    if (location.hash.length <= 1) history.replaceState(null, "", returnHash);
  }
  if (meta.state === "expired") return showShareGone("expired", "This share has closed.", "Ask whoever sent it for a fresh link.");
  if (meta.state !== "active") return showShareGone("paused", "This share is paused right now.", "Ask whoever sent it to reopen it.");
  $("ws-state").dataset.state = "secure";
  document.title = `${meta.label} - LostHusky's DropBox`;
  applyTheme(meta.theme || {});
  logOpenOnce();
  identify({ slug, kind: "share", linkedId: meta.viewer?.email || "" });
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
    // The OAuth round trip lands on /s/:slug; keep the folder path so the
    // viewer comes back to the folder they were sent to.
    if (location.hash.length > 1) sessionStorage.setItem(`lhdb_sreturn_${slug}`, location.hash);
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
  installDownloadFormatControl();
  installFilterControl();
  installGalleryTools();
  window.addEventListener("resize", scheduleLayout);
  window.addEventListener("blur", cancelTouchSelection);
  document.addEventListener("visibilitychange", () => document.hidden && cancelTouchSelection());
  window.addEventListener("popstate", onPopState);
  installTracking();
  crumbs.push({ fid: "", name: meta.label, token: "" });
  // A reload or a shared deep link carries the folder path in the hash;
  // walk it down from the root before the first paint instead of always
  // landing on the root and forgetting where the viewer was.
  const fids = location.hash.slice(1).split("/").filter(Boolean);
  loadFolderStats();
  await navigate(crumbs[0], { push: false, fromHistory: fids.length > 0, quiet: fids.length > 0 });
  await restorePath(fids);
  installSmartGalleryHeader();
}

async function restorePath(fids) {
  for (const [i, fid] of fids.entries()) {
    const sub = (current?.folders || []).flatMap((f) => f.subfolders || []).find((s) => s.fid === fid);
    if (!sub) {
      // Stale or foreign path: stay where we got to and fix the URL.
      history.replaceState(null, "", crumbs.length > 1 ? `#${crumbs.slice(1).map((c) => c.fid).join("/")}` : location.pathname);
      render();
      loadSummary();
      return;
    }
    await navigate({ fid: sub.fid, name: sub.name, token: sub.ls }, { push: true, fromHistory: true, quiet: i < fids.length - 1 });
  }
  // Belt and braces: the URL always reflects the crumbs we ended up on.
  const path = crumbs.slice(1).map((c) => c.fid).join("/");
  if (fids.length && location.hash.slice(1) !== path) history.replaceState({ fid: crumbs.at(-1)?.fid || "" }, "", path ? `#${path}` : location.pathname);
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
const LISTING_TTL_MS = 5 * 60000;

function keepListing(fid, d, token) {
  listingCache.set(fid, { d, token, at: Date.now() });
  rememberJson("listing", `${slug}/${fid}`, { d, token });
}

async function resolveListing(entry) {
  const cached = listingCache.get(entry.fid);
  if (cached && Date.now() - cached.at < LISTING_TTL_MS) return cached.d;
  // L0: a listing this browser fetched a moment ago (its signed tokens are
  // minted for 15 min, so a 5 min old copy is still fully usable).
  const stored = await cachedJson("listing", `${slug}/${entry.fid}`, LISTING_TTL_MS);
  if (stored?.data?.d) {
    listingCache.set(entry.fid, { d: stored.data.d, token: stored.data.token, at: stored.at });
    if (stored.data.token) entry.token = stored.data.token;
    return stored.data.d;
  }
  try {
    const d = await fetchListing(entry.token);
    keepListing(entry.fid, d, entry.token);
    return d;
  } catch (err) {
    if (err.status !== 403 || !entry.fid) throw err;
    // The "ls" token for this folder expired. Re-list the parent (which we
    // do have a live token for) to mint a fresh one for the same fid.
    const parent = crumbs[crumbs.length - 2] || crumbs[0];
    const parentListing = await fetchListing(parent.token);
    keepListing(parent.fid, parentListing, parent.token);
    const fresh = (parentListing.folders || []).flatMap((f) => f.subfolders || []).find((s) => s.fid === entry.fid);
    if (!fresh) throw err;
    entry.token = fresh.ls;
    const d = await fetchListing(fresh.ls);
    keepListing(entry.fid, d, fresh.ls);
    return d;
  }
}

// quiet: an intermediate hop while restoring a deep link - keep the crumb,
// skip the paint, the summary call and the analytics event.
export async function navigate(entry, { push = true, fromHistory = false, quiet = false } = {}) {
  cancelTouchSelection();
  setGalleryToolsOpen(false);
  if (navigating) return;
  const fid = entry.fid || "";
  if (push && crumbs.length && crumbs[crumbs.length - 1].fid === fid) return;
  navigating = true;
  const host = $("folders");
  // Cached listings paint immediately; only a fetch slow enough to notice
  // gets a skeleton.
  const done = delayedSkeleton(host, (entry.fid ? skelFolders(3) : "") + skelTiles(12));
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
    if (quiet) return;
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
    done();
    navigating = false;
    host.removeAttribute("aria-busy");
  }
}

async function onPopState() {
  const fids = (location.hash.slice(1) || "").split("/").filter(Boolean);
  const targetFid = fids.at(-1) || "";
  const idx = crumbs.findIndex((c) => c.fid === targetFid);
  if (idx < 0) {
    // Forward/back into a folder the crumbs no longer hold (we went up via a
    // breadcrumb, then back): rebuild the path from the root listing.
    crumbs.splice(1);
    await navigate(crumbs[0], { push: false, fromHistory: true, quiet: fids.length > 0 });
    return restorePath(fids);
  }
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
  const arr = [...files].filter((f) => filterMode === "all" || fileKind(f) === filterMode);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const kindRank = { photos: { photos: 0, videos: 1, other: 2 }, videos: { videos: 0, photos: 1, other: 2 } };
  if (sortMode === "new") arr.sort((a, b) => b.at - a.at || byName(a, b));
  else if (sortMode === "old") arr.sort((a, b) => a.at - b.at || byName(a, b));
  else if (sortMode === "size") arr.sort((a, b) => b.size - a.size || byName(a, b));
  else if (sortMode === "type") arr.sort((a, b) => a.mime.localeCompare(b.mime) || byName(a, b));
  else if (kindRank[sortMode]) arr.sort((a, b) => kindRank[sortMode][fileKind(a)] - kindRank[sortMode][fileKind(b)] || b.at - a.at || byName(a, b));
  else arr.sort(byName);
  return arr;
}

// Folders sort on their stats (loose-ends spec §5) when they have any; a
// folder without stats sorts as if empty, after the ones with numbers.
function sortFolders(subs) {
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
  const st = (sub) => folderStats?.[sub.fid] || null;
  const num = (sub, key) => st(sub)?.[key] || 0;
  const arr = [...subs].filter(folderPassesFilter);
  if (sortMode === "new") arr.sort((a, b) => num(b, "newest") - num(a, "newest") || byName(a, b));
  else if (sortMode === "old") arr.sort((a, b) => (num(a, "oldest") || Infinity) - (num(b, "oldest") || Infinity) || byName(a, b));
  else if (sortMode === "size") arr.sort((a, b) => num(b, "bytes") - num(a, "bytes") || byName(a, b));
  else if (sortMode === "photos") arr.sort((a, b) => num(b, "photos") - num(a, "photos") || byName(a, b));
  else if (sortMode === "videos") arr.sort((a, b) => num(b, "videos") - num(a, "videos") || byName(a, b));
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
    const subs = sortFolders(folder.subfolders || []);
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
  if (!revealOnlyIds) warmVisible();
}

// Ask the Worker to pre-warm this folder's heavy on-demand tiers (thumb-hi,
// preview-webp) into the edge cache, so opening a photo is instant. The Worker
// pulls them from Drive - the viewer's bandwidth is not spent, so we only skip
// on explicit data-saver / very slow links (out of courtesy for the tiny POST),
// and fire once per folder.
let _warmedFolder = "";
function warmVisible() {
  try {
    const conn = navigator.connection;
    if (conn && (conn.saveData || /2g/.test(conn.effectiveType || ""))) return;
    const key = location.hash || "root";
    if (key === _warmedFolder) return;
    _warmedFolder = key;
    const urls = [];
    for (const file of visibleFiles.values()) {
      if (file.thumbs?.max) urls.push(file.thumbs.max);
      if (file.previewImageUrl) urls.push(file.previewImageUrl);
      if (urls.length >= 15) break;
    }
    if (!urls.length) return;
    fetch("/api/share/warm", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, pin, urls }), keepalive: true }).catch(() => {});
  } catch {
    /* warming is best-effort */
  }
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
  // Tiles in the space the next page will fill, so the page does not sit
  // still while 200 more files are fetched.
  const pending = document.createElement("div");
  pending.className = "load-more-pending";
  pending.innerHTML = skelTiles(8);
  button.insertAdjacentElement("beforebegin", pending);
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
  } finally {
    pending.remove();
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

// How far a tile grows when hovered. Zoom only earns its keep when tiles are
// small: at the densest setting a tile has room to grow and needs the detail,
// at the largest it already fills the row and growing it just shoves the grid
// about. So the chosen strength is scaled down as tiles get bigger, and even
// "large" on the biggest tiles settles near 1.
const ZOOM_STRENGTH = { off: 0, s: 0.14, m: 0.3, l: 0.52, auto: 0.34 };
let hoverZoomPref = localStorage.getItem("lhdb_hover_zoom") || "auto";

export function applyHoverZoom() {
  const density = 1 - (clampTileScale(tileScale) - 1) / 8; // 1 = densest, 0 = largest
  const zoom = 1 + (ZOOM_STRENGTH[hoverZoomPref] ?? ZOOM_STRENGTH.auto) * density;
  document.documentElement.style.setProperty("--hover-zoom", zoom.toFixed(3));
}

function clampHoverZoom(fig) {
  const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--hover-zoom")) || 1;
  // Obstacles: the sticky toolbar (when stuck it covers the top of the
  // grid) and the phone selection bar at the bottom.
  const bounds = {};
  const toolbar = document.querySelector(".gallery-toolbar");
  if (toolbar) {
    const t = toolbar.getBoundingClientRect();
    if (t.bottom > 0 && t.top <= (parseFloat(getComputedStyle(toolbar).top) || 0) + 1) bounds.top = t.bottom + 8;
  }
  const bar = document.querySelector(".mobile-select-bar");
  if (bar && getComputedStyle(bar).display !== "none") bounds.bottom = bar.getBoundingClientRect().top - 8;
  const origin = hoverZoomOrigin(fig.getBoundingClientRect(), zoom, window.innerWidth, window.innerHeight, 8, bounds);
  if (origin) fig.style.transformOrigin = origin;
  else fig.style.removeProperty("transform-origin");
}

function installHoverZoomControl() {
  const select = $("hover-zoom");
  if (!select) return;
  select.value = hoverZoomPref;
  select.addEventListener("change", () => {
    hoverZoomPref = select.value;
    localStorage.setItem("lhdb_hover_zoom", hoverZoomPref);
    applyHoverZoom();
    trackEvent("layout", `hover zoom ${hoverZoomPref}`, { control: "hover-zoom" });
  });
  applyHoverZoom();
}

// Filter (loose-ends spec §5): files by kind; folders by whether the stats
// say they hold that kind (unknown stats keep the folder visible).
let filterMode = localStorage.getItem("lhdb_filter") || "all";
const fileKind = (file) => (/^image\//.test(file.mime) ? "photos" : /^video\//.test(file.mime) ? "videos" : "other");
function folderPassesFilter(sub) {
  if (filterMode === "all") return true;
  const s = folderStats?.[sub.fid];
  if (!s) return true;
  if (filterMode === "photos") return s.photos > 0;
  if (filterMode === "videos") return s.videos > 0;
  return s.files - s.photos - s.videos > 0;
}
function installFilterControl() {
  const select = $("filter");
  if (!select) return;
  select.value = ["all", "photos", "videos", "other"].includes(filterMode) ? filterMode : "all";
  select.addEventListener("change", () => {
    filterMode = select.value;
    localStorage.setItem("lhdb_filter", filterMode);
    trackEvent("layout", `filter ${filterMode}`, { control: "filter" });
    render();
  });
}

function installDownloadFormatControl() {
  const select = $("dl-format");
  if (!select) return;
  select.value = localStorage.getItem("lhdb_dl_format") === "webp" ? "webp" : "original";
  select.addEventListener("change", () => {
    localStorage.setItem("lhdb_dl_format", select.value);
    trackEvent("layout", `download ${select.value}`, { control: "dl-format" });
  });
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
    applyHoverZoom();
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
  installHoverZoomControl();
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

// Folder tiles (spec §2.1). With stats from the share-index blob a tile
// shows the newest photo, counts, size and last change; without them (never
// indexed, or a folder the walk has not reached yet) it stays icon + name.
// Names are set with textContent only - they come from Drive and are not
// trusted.
let folderStats = null; // fid -> { files, photos, videos, bytes, newest, cover }
let folderStatsSeq = 0;

async function loadFolderStats() {
  const seq = ++folderStatsSeq;
  try {
    const cached = await cachedJson("stats", slug, 60_000);
    let d = cached?.data;
    if (!d) {
      const r = await fetch("/api/share/stats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, pin }) });
      if (!r.ok) return;
      d = await r.json();
      rememberJson("stats", slug, d);
    }
    if (seq !== folderStatsSeq || !d?.indexed) return;
    folderStats = d.folders || {};
    document.querySelectorAll(".folder-card[data-fid]").forEach((el) => decorateFolderCard(el, folderStats[el.dataset.fid]));
    // Stats change folder order for every mode except name: re-render.
    if ((sortMode !== "name" || filterMode !== "all") && current) render();
  } catch {
    // Stats are a progressive enhancement; the icon tile is the baseline.
  }
}

function fmtAgo(ms) {
  const diff = Date.now() - ms;
  const d = Math.floor(diff / 86400e3);
  if (d >= 365) return `${Math.floor(d / 365)} y ago`;
  if (d >= 30) return `${Math.floor(d / 30)} mo ago`;
  if (d >= 1) return `${d} d ago`;
  const h = Math.floor(diff / 3600e3);
  return h >= 1 ? `${h} h ago` : "just now";
}

function decorateFolderCard(el, stats) {
  if (!stats || el.classList.contains("rich") || !(stats.files || stats.folders)) return;
  el.classList.add("rich");
  const cover = document.createElement("span");
  cover.className = "folder-cover";
  if (stats.cover) {
    const img = document.createElement("img");
    img.src = stats.cover;
    img.alt = "";
    img.loading = "lazy";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.remove();
    cover.appendChild(img);
  } else cover.innerHTML = uiIcon("folder");
  const body = document.createElement("span");
  body.className = "folder-body";
  const name = document.createElement("b");
  name.textContent = el.dataset.name;
  const row = document.createElement("small");
  const parts = [];
  if (stats.photos) parts.push(`${uiIcon("image")}${stats.photos}`);
  if (stats.videos) parts.push(`${uiIcon("video")}${stats.videos}`);
  if (!stats.photos && !stats.videos && stats.files) parts.push(`${uiIcon("file")}${stats.files}`);
  if (stats.folders) parts.push(`${uiIcon("folder")}${stats.folders}`);
  parts.push(`<i>${esc(fmtBytes(stats.bytes || 0))}</i>`);
  row.innerHTML = parts.map((p) => `<span>${p}</span>`).join("");
  const when = document.createElement("em");
  when.textContent = stats.newest ? `Modified ${fmtAgo(stats.newest)}` : "";
  body.append(name, row, when);
  el.replaceChildren(cover, body);
}

// Hover card (loose-ends spec §5): everything the stats know about a folder,
// positioned with the measure-then-flip-or-clamp rule from §3.3. One shared
// element; closes on leave, scroll or Escape. Mouse only.
let hoverCard = null;
let hoverTimer = 0;
function folderHoverCard() {
  if (hoverCard) return hoverCard;
  hoverCard = document.createElement("div");
  hoverCard.className = "folder-hover";
  hoverCard.setAttribute("role", "tooltip");
  hoverCard.hidden = true;
  document.body.appendChild(hoverCard);
  const hide = () => hideFolderHover();
  window.addEventListener("scroll", hide, { passive: true });
  window.addEventListener("resize", hide);
  document.addEventListener("keydown", (e) => e.key === "Escape" && hide());
  return hoverCard;
}
function hideFolderHover() {
  clearTimeout(hoverTimer);
  hoverTimer = 0;
  if (hoverCard) hoverCard.hidden = true;
}
function showFolderHover(el, sub) {
  const s = folderStats?.[sub.fid];
  if (!s || !(s.files || s.folders)) return;
  const card = folderHoverCard();
  const other = Math.max(0, s.files - s.photos - s.videos);
  const range = s.oldest && s.newest ? `${new Date(s.oldest).toLocaleDateString(undefined, { year: "numeric", month: "short" })} – ${new Date(s.newest).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" })}` : "";
  card.replaceChildren();
  if (s.cover) {
    const img = document.createElement("img");
    img.src = s.cover;
    img.alt = "";
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    card.appendChild(img);
  }
  const body = document.createElement("div");
  const title = document.createElement("b");
  title.textContent = sub.name;
  body.appendChild(title);
  const rows = [
    [`${s.files} file${s.files === 1 ? "" : "s"}`, fmtBytes(s.bytes || 0)],
    s.photos ? ["Photos", String(s.photos)] : null,
    s.videos ? ["Videos", String(s.videos)] : null,
    other ? ["Other files", String(other)] : null,
    s.folders ? ["Subfolders", String(s.folders)] : null,
    range ? ["Taken", range] : null,
    s.newest ? ["Modified", fmtAgo(s.newest)] : null,
  ].filter(Boolean);
  const dl = document.createElement("dl");
  for (const [k, v] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    dl.append(dt, dd);
  }
  body.appendChild(dl);
  const hint = document.createElement("small");
  hint.textContent = "Click to open";
  body.appendChild(hint);
  card.appendChild(body);
  // First frame hidden but laid out, so the measurement is real (§0.1).
  card.hidden = false;
  card.style.visibility = "hidden";
  const { left, top } = positionPreview(card.getBoundingClientRect(), el.getBoundingClientRect(), window.innerWidth, window.innerHeight);
  card.style.left = `${left}px`;
  card.style.top = `${top}px`;
  card.style.visibility = "";
}
function installFolderHover(el, sub) {
  if (!canHoverPreview) return;
  el.addEventListener("pointerenter", (e) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showFolderHover(el, sub), 380);
  });
  el.addEventListener("pointerleave", hideFolderHover);
  el.addEventListener("click", hideFolderHover);
}

function folderCard(sub) {
  const el = document.createElement("button");
  el.type = "button";
  el.className = "folder-card";
  el.dataset.cursor = "folder";
  el.dataset.fid = sub.fid;
  el.dataset.name = sub.name;
  installFolderHover(el, sub);
  el.innerHTML = `${uiIcon("folder")}<span></span>${folderStats ? "" : `<i class="skel-bone folder-pending"></i>`}`;
  el.querySelector("span").textContent = sub.name;
  el.addEventListener("click", () => navigate({ fid: sub.fid, name: sub.name, token: sub.ls }, { push: true }));
  if (folderStats) decorateFolderCard(el, folderStats[sub.fid]);
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
  const dur = isVideo ? `<span class="g-dur">${file.dur ? fmtDur(file.dur) : "video"}</span>` : "";
  fig.innerHTML = `
    <button class="g-check" type="button" aria-label="select ${escAttr(file.name)}" data-cursor="link">
      ${uiIcon("check")}
    </button>
    <a class="g-dl${blocked ? " blocked" : ""}" href="${escAttr(file.dl)}" download aria-label="${blocked ? "download blocked for" : "download"} ${escAttr(file.name)}" title="${blocked ? escAttr(file.downloadBlockReason || "Download blocked") : ""}" data-cursor="link">
      ${uiIcon("download")}
    </a>
    ${dur}
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
  fig.addEventListener("pointerenter", () => clampHoverZoom(fig));
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
