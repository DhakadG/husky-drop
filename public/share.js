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

let meta = null;
let viewer = null;
let pin = sessionStorage.getItem(`lhdb_spin_${slug}`) || "";
let allowZip = true;
let listFetchedAt = 0;
let current = null; // active listing: { folders: [...] }
let sortMode = localStorage.getItem("lhdb_sort") || "name";
// crumbs: [{ fid, name, token }]. fid "" = root. Navigation is keyed on the
// stable fid, never on `token` (a signed "ls" token that is re-minted with a
// new signature on every listing call and therefore compares unequal across
// requests - keying on it was the root cause of duplicate breadcrumbs).
const crumbs = [];
const listingCache = new Map(); // fid -> { d, token, at }
const selected = new Map(); // fileId -> file
let lightboxItems = [];
let summarySeq = 0;
const TOKEN_REFRESH_MS = 90 * 1000;
const canHoverPreview = fx.canHoverPreview;
const previewVideos = new Map(); // fileId -> video
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
  window.addEventListener("resize", scheduleLayout);
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

function render() {
  renderCrumbs();
  renderMeta();
  const host = $("folders");
  host.innerHTML = "";
  lightboxItems = [];
  const folders = current?.folders || [];
  if (!folders.length || folders.every((f) => !f.files.length && !f.subfolders?.length)) {
    host.innerHTML = `<div class="empty">Nothing in this folder yet.</div>`;
    updateSelInfo();
    return;
  }
  const revealTargets = [];
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
      grid.appendChild(el);
      revealTargets.push(el);
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
  fx.reveal(revealTargets);
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
    folder.files.push(...page.files);
    for (const sub of page.subfolders || []) {
      if (!folder.subfolders.some((s) => s.fid === sub.fid)) folder.subfolders.push(sub);
    }
    folder.nextPageToken = page.nextPageToken;
    render();
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

function thumbUrl(file, size) {
  if (!file.thumb) return "";
  if (/^data:/i.test(file.thumb)) return file.thumb;
  return file.thumb.replace(/=s\d+(-c)?$/, `=s${size}`);
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

async function ensureFreshDownload(file) {
  if (tokenFresh(file)) return file.dl;
  const r = await fetch("/api/share/refresh-dl", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, pin, dl: file.dl }),
  });
  if (!r.ok) throw new Error("download link expired");
  const d = await r.json();
  file.dl = d.dl;
  file.dlExpiresAt = d.dlExpiresAt;
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
  trackEvent("download", file.name);
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
  } catch (err) {
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
  let touchHoldTimer = 0;
  let touchStart = null;
  let touchArmed = false;
  let startPromise = null;
  const state = { scrubbing: false, suppressClickUntil: 0 };

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
    fig.classList.remove("scrubbing", "touch-scrubbing");
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

  // Touch: press-and-hold arms scrubbing, then a horizontal drag scrubs.
  // A plain tap (no hold) still opens the viewer as normal.
  fig.addEventListener(
    "pointerdown",
    (e) => {
      if (e.pointerType !== "touch" || selected.size) return;
      clearTimeout(touchHoldTimer);
      touchStart = { x: e.clientX, y: e.clientY, id: e.pointerId };
      touchArmed = false;
      touchHoldTimer = setTimeout(async () => {
        if (!touchStart) return;
        try {
          fig.setPointerCapture(e.pointerId);
        } catch {}
        await requestPreview();
        const video = previewVideos.get(file.id);
        if (video && !video.duration) await waitForVideoDuration(video);
        if (!touchStart) return;
        touchArmed = true;
        fig.classList.add("touch-scrubbing");
        if (beginScrub()) scrubTo(touchStart.x);
      }, 420);
    },
    { passive: true },
  );

  fig.addEventListener(
    "pointermove",
    (e) => {
      if (e.pointerType !== "touch" || !touchStart) return;
      if (!touchArmed) {
        const moved = Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y);
        if (moved > 12) {
          clearTimeout(touchHoldTimer);
          touchStart = null;
        }
        return;
      }
      e.preventDefault();
      scrubTo(e.clientX);
    },
    { passive: false },
  );

  const finishTouch = (e) => {
    clearTimeout(touchHoldTimer);
    if (touchArmed) {
      e.preventDefault();
      endScrub({ resume: false, stopPreview: true });
      state.suppressClickUntil = performance.now() + 260;
      try {
        fig.releasePointerCapture(touchStart?.id);
      } catch {}
    }
    touchArmed = false;
    touchStart = null;
  };
  fig.addEventListener("pointerup", finishTouch, { passive: false });
  fig.addEventListener("pointercancel", finishTouch, { passive: false });
  fig.addEventListener(
    "click",
    (e) => {
      if (performance.now() >= state.suppressClickUntil) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
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
  const target = W < 640 ? 148 : W < 1280 ? 210 : 250;
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

function loadPswp() {
  if (!pswpModulePromise) pswpModulePromise = import("/vendor/photoswipe.esm.min.js").then((m) => m.default);
  return pswpModulePromise;
}

function pswpItem(file) {
  const isVideo = /^video\//.test(file.mime);
  const ratio = file.aspect || (file.w && file.h ? file.w / file.h : 16 / 9);
  const width = 1600;
  const height = Math.round(width / Math.min(2.8, Math.max(0.4, ratio)));
  return {
    file,
    type: isVideo ? "video" : "image",
    width,
    height,
    msrc: file.thumb ? thumbUrl(file, 512) : "",
    src: isVideo ? undefined : thumbUrl(file, 2048),
  };
}

async function openViewer(index, sourceEl) {
  if (index < 0 || index >= lightboxItems.length) return;
  const PhotoSwipe = await loadPswp();
  const file = lightboxItems[index];
  trackEvent("view", file.name);

  pswp = new PhotoSwipe({
    dataSource: lightboxItems.map(pswpItem),
    index,
    bgOpacity: 0.96,
    showHideAnimationType: sourceEl ? "zoom" : "fade",
    showAnimationDuration: 320,
    hideAnimationDuration: 260,
    wheelToZoom: true,
    preload: [1, 2],
    loop: false,
    paddingFn: () => ({ top: 60, bottom: 96, left: 0, right: 0 }),
    appendToEl: document.body,
  });

  registerVideoContent(pswp);
  registerUi(pswp);
  pswp.on("change", () => {
    const current = lightboxItems[pswp.currIndex];
    updateCaption(current);
    syncStrip(pswp.currIndex);
    animateSlideIn(pswp.currSlide?.content?.element);
    trackEvent("view", current?.name || "");
  });
  const onViewerKeydown = (e) => {
    if (e.key === "Home") {
      e.preventDefault();
      pswp.goTo(0);
    } else if (e.key === "End") {
      e.preventDefault();
      pswp.goTo(lightboxItems.length - 1);
    }
  };
  window.addEventListener("keydown", onViewerKeydown);
  pswp.on("destroy", () => {
    window.removeEventListener("keydown", onViewerKeydown);
    destroyStrip();
    pswp = null;
  });

  pswp.init();
  mountBottomBar(pswp);
  updateCaption(file);
  // Warm neighbour full-res images so arrow navigation feels instant.
  for (const n of [index - 1, index + 1]) {
    const f = lightboxItems[n];
    if (f && /^image\//.test(f.mime) && f.thumb) new Image().src = thumbUrl(f, 2048);
  }
}

// A very short, purely-opacity fade on the slide's own content each time it
// becomes active. PhotoSwipe already pans the whole slide horizontally on
// prev/next; this just softens the cut on the content itself without
// touching (or fighting) PhotoSwipe's own pan/zoom transform.
function animateSlideIn(el) {
  if (!el) return;
  el.classList.remove("pswp-slide-in");
  void el.offsetWidth; // restart the CSS animation
  el.classList.add("pswp-slide-in");
}

function registerVideoContent(instance) {
  instance.on("contentLoad", (e) => {
    const { content } = e;
    if (content.data.type !== "video") return;
    e.preventDefault();
    const file = content.data.file;
    const wrap = document.createElement("div");
    wrap.className = "pswp-video-wrap";
    if (file.thumb) {
      const poster = document.createElement("img");
      poster.className = "pswp-video-poster";
      poster.src = thumbUrl(file, 1024);
      poster.alt = "";
      wrap.appendChild(poster);
    }
    const loading = document.createElement("div");
    loading.className = "pswp-video-loading";
    loading.textContent = "Loading video";
    wrap.appendChild(loading);
    getPreviewVideo(file)
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
  fig.classList.remove("previewing", "buffering", "scrubbing", "touch-scrubbing");
  fig.style.removeProperty("--scrub-x");
  fig.querySelector(".buffer-bar")?.remove();
  fig._scrubBadge = null;
  fx.setScrubbing(false, fig);
}

const SHORTCUTS = [
  ["&larr; &rarr;", "Previous / next"],
  ["Home / End", "First / last file"],
  ["Esc", "Close"],
  ["Scroll wheel or drag", "Browse the filmstrip"],
  ["Shift + hover a tile", "Scrub a video (desktop)"],
  ["Touch + hold a tile", "Scrub a video (touch)"],
];

function registerUi(instance) {
  let panel = null;
  const closePanel = () => {
    panel?.remove();
    panel = null;
  };
  const togglePanel = () => {
    if (panel) return closePanel();
    panel = document.createElement("div");
    panel.className = "pswp-shortcuts";
    panel.innerHTML = `<b>Shortcuts</b><ul>` + SHORTCUTS.map(([key, desc]) => `<li><span>${key}</span>${esc(desc)}</li>`).join("") + `</ul>`;
    instance.element.appendChild(panel);
  };

  instance.on("uiRegister", () => {
    instance.ui.registerElement({
      name: "shortcuts-button",
      order: 7,
      isButton: true,
      tagName: "button",
      html: {
        isCustomSVG: true,
        inner:
          '<circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2.2"/><line x1="12" y1="11" x2="12" y2="16.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><circle cx="12" cy="7.4" r="1.15" fill="currentColor"/>',
        outlineID: "pswp__icn-info",
      },
      onClick: togglePanel,
      title: "Keyboard shortcuts",
    });
    instance.ui.registerElement({
      name: "download-button",
      order: 8,
      isButton: true,
      tagName: "button",
      html: {
        isCustomSVG: true,
        inner:
          '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><polyline points="7 10 12 15 17 10" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/><line x1="12" y1="15" x2="12" y2="3" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>',
        outlineID: "pswp__icn-download",
      },
      onClick: (_evt, _el, pswpInstance) => {
        const file = pswpInstance.currSlide?.data?.file;
        if (file) downloadFile(file);
      },
      title: "Download",
    });
  });
  instance.on("change", closePanel);
  instance.on("destroy", closePanel);
}

// Caption lives in its own bottom info bar now, not PhotoSwipe's cramped top
// toolbar (squeezed between square icon buttons, baseline-aligned against
// them, which is what made it look stuck at an odd position). A short fade
// on text change keeps it feeling responsive without being showy.
let captionEl = null;
function updateCaption(file) {
  if (!captionEl || !file) return;
  const parts = [fmtBytes(file.size)];
  if (file.at) parts.push(new Date(file.at).toLocaleDateString());
  captionEl.classList.remove("pswp-caption-in");
  captionEl.innerHTML = `<b>${esc(file.name)}</b><span>${esc(parts.join(" - "))}</span>`;
  void captionEl.offsetWidth;
  captionEl.classList.add("pswp-caption-in");
}

// Bottom bar = caption + thumbstrip stacked in one flex column, so they
// share one anchor point instead of two separately-positioned absolute
// elements that have to agree on pixel heights by hand.
function mountBottomBar(instance) {
  const bar = document.createElement("div");
  bar.className = "pswp-bottom-bar";
  bar.addEventListener("wheel", (e) => e.stopPropagation(), { capture: true, passive: true });
  // PhotoSwipe's own pan/swipe/close gesture listens for these on its root
  // element and will contest a drag that starts on the strip (grabbing it
  // as a main-image swipe), which is why a strip drag looked like it
  // "snapped back" - it was never reaching Swiper's own handler uncontested.
  // Same capture+stopPropagation trick as the wheel isolation above: it
  // blocks propagation to ancestors but not to other listeners already on
  // this element or its descendants (Swiper's drag handlers live on the
  // strip host itself), so Swiper still gets the gesture.
  for (const type of ["pointerdown", "mousedown", "touchstart"]) {
    bar.addEventListener(type, (e) => e.stopPropagation(), { capture: true });
  }
  captionEl = document.createElement("div");
  captionEl.className = "pswp-caption";
  bar.appendChild(captionEl);
  instance.element.appendChild(bar);
  mountStrip(instance, bar);
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
    centeredSlides: true,
    centeredSlidesBounds: true,
    watchOverflow: true,
    // Swiper's mousewheel module defaults to disabled; { forceToAxis: true }
    // alone does NOT turn it on - enabled: true is required. Without it,
    // scrolling the wheel over the strip silently did nothing.
    mousewheel: { enabled: true, forceToAxis: true, sensitivity: 0.7 },
    keyboard: false, // PhotoSwipe already owns arrow keys for the main image
    initialSlide: instance.currIndex,
    on: {
      click: (sw) => {
        const idx = Number(sw.clickedSlide?.dataset?.i);
        if (Number.isFinite(idx)) instance.goTo(idx);
      },
    },
  });
  syncStripActive();
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
  Object.assign(el.style, { width: "54px", height: "42px", flex: "0 0 auto" });
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
  strip.slideTo(index, 220, false);
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
  strip.setTransition(220);
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

function toggleSelect(file, fig) {
  if (selected.has(file.id)) selected.delete(file.id);
  else selected.set(file.id, file);
  fig.classList.toggle("selected", selected.has(file.id));
  if (selected.has(file.id)) fx.pop(fig.querySelector(".g-check"));
  document.body.classList.toggle("selecting", selected.size > 0);
  updateSelInfo();
}

function selectAll(on) {
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
    toast("Zip download started", `${ticket.count || files.length} files - ${fmtBytes(bytes)}`, "ok");
  } catch (err) {
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
  window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

function trackEvent(t, name) {
  trackQueue.push({ t, name: String(name || "").slice(0, 160) });
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

