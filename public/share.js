// Share gallery: folder navigation with breadcrumbs, a justified
// (Google-Photos-style) tile layout that never crops, an image/video
// lightbox, sorting, selection and streaming zip downloads.

const $ = (id) => document.getElementById(id);
const slug = location.pathname.split("/").filter(Boolean).pop();

let meta = null;
let pin = sessionStorage.getItem(`lhdb_spin_${slug}`) || "";
let allowZip = true;
let listFetchedAt = 0;
let current = null; // active listing: { folders: [...] }
let sortMode = localStorage.getItem("lhdb_sort") || "name";
const crumbs = []; // [{ token, name }]
const listingCache = new Map(); // token -> { d, at }
const selected = new Map(); // fileId -> file
let lightboxItems = [];
let lightboxIndex = -1;
let summarySeq = 0;
let lightboxVideo = null;
const MAX_ZIP_BYTES = 3.8 * 1024 ** 3; // no zip64 in microzip
const TOKEN_REFRESH_MS = 90 * 1000;
const canHoverPreview = matchMedia("(hover: hover) and (pointer: fine)").matches;
const previewVideos = new Map(); // fileId -> video
const cardObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          const file = entry.target._file;
          if (file && /^video\//.test(file.mime) && !file.aspect && !file.thumb) probeVideoMetadata(file);
          cardObserver.unobserve(entry.target);
        }
      }
    }, { rootMargin: "700px" })
  : null;
const moreObserver = "IntersectionObserver" in window
  ? new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.target._folder) prefetchMore(entry.target._folder);
      }
    }, { rootMargin: "700px" })
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

  if (meta.requiresPin) {
    if (pin && (await verifyPinValue(pin))) return enter();
    $("pin-label").textContent = meta.label;
    $("pin-gate").classList.remove("hidden");
    $("pin-go").addEventListener("click", tryPin);
    $("pin").addEventListener("keydown", (e) => e.key === "Enter" && tryPin());
  } else {
    enter();
  }
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

async function tryPin() {
  const candidate = $("pin").value.trim();
  if (!(await verifyPinValue(candidate))) return;
  pin = candidate;
  sessionStorage.setItem(`lhdb_spin_${slug}`, pin);
  $("pin-gate").classList.add("hidden");
  enter();
}

async function verifyPinValue(candidate) {
  $("pin-err").textContent = "";
  const r = await fetch("/api/share/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, pin: candidate }),
  });
  if (r.ok) return true;
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) {
    $("pin-err").textContent = `Too many attempts. Try again in ${d.retryAfter || 60}s.`;
  } else {
    $("pin-err").textContent = d.error || "Wrong password.";
  }
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
  installLightbox();
  crumbs.push({ token: "", name: meta.label });
  await navigate("", meta.label, false);
}

// ---- Navigation ----

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
    throw new Error(d.error || `HTTP ${r.status}`);
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
async function navigate(token, name, push = true) {
  // Guard against double-clicks / re-entrancy pushing duplicate crumbs.
  if (navigating) return;
  if (push && crumbs.length && crumbs[crumbs.length - 1].token === token) return;
  navigating = true;
  const host = $("folders");
  host.setAttribute("aria-busy", "true");
  try {
    const cached = listingCache.get(token);
    let d;
    if (cached && Date.now() - cached.at < 5 * 60000) {
      d = cached.d;
    } else {
      d = await fetchListing(token);
      listingCache.set(token, { d, at: Date.now() });
      listFetchedAt = Date.now();
    }
    if (push) crumbs.push({ token, name });
    current = d;
    current.summary = null;
    allowZip = d.allowZip !== false;
    render();
    loadSummary();
  } catch (err) {
    toast("Could not open folder", String(err.message || err).slice(0, 80), "err");
  } finally {
    navigating = false;
    host.removeAttribute("aria-busy");
  }
}

function goToCrumb(index) {
  if (index < 0 || index >= crumbs.length - 1) return;
  const target = crumbs[index];
  crumbs.splice(index + 1);
  navigate(target.token, target.name, false);
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
    if (i < crumbs.length - 1) {
      el.type = "button";
      el.addEventListener("click", () => goToCrumb(i));
    }
    box.appendChild(el);
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
  for (const folder of folders) {
    const section = document.createElement("section");
    section.className = "gallery-folder";
    if (folders.length > 1 && folder.name) {
      const head = document.createElement("div");
      head.className = "section-subtitle";
      head.textContent = `${folder.name} - ${folder.files.length} file${folder.files.length === 1 ? "" : "s"}`;
      section.appendChild(head);
    }
    const subs = [...(folder.subfolders || [])].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { numeric: true })
    );
    if (subs.length) {
      const row = document.createElement("div");
      row.className = "folder-row";
      for (const sub of subs) row.appendChild(folderCard(sub));
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
  button.querySelector(".load-more-main").textContent =
    state === "loading" ? "Loading more files..." : state === "error" ? "Could not load. Try again" : `Load next ${next}`;
  button.querySelector(".load-more-sub").textContent = total
    ? `${loaded} of ${total} shown`
    : `${loaded} shown - counting total`;
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
      if (!folder.subfolders.some((s) => s.name === sub.name)) folder.subfolders.push(sub);
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
  folder._prefetchPromise = fetchMorePage(folder).then((page) => {
    folder._prefetch = page;
    return page;
  }).finally(() => {
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
  el.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg><span></span>`;
  el.querySelector("span").textContent = sub.name;
  el.addEventListener("click", () => navigate(sub.ls, sub.name, true));
  return el;
}

// ---- Cards ----

function isViewable(file) {
  return (/^image\//.test(file.mime) && file.thumb) || /^video\//.test(file.mime);
}

function thumbUrl(file, size) {
  if (!file.thumb) return "";
  return file.thumb.replace(/=s\d+(-c)?$/, `=s${size}`);
}

function card(file) {
  const fig = document.createElement("figure");
  fig._file = file;
  const media = /^(image|video)\//.test(file.mime) && file.thumb;
  fig.className = `g-card${media ? "" : " plain"}${/^video\//.test(file.mime) ? " video-card" : ""}`;
  const dur = file.dur ? `<span class="g-dur">${fmtDur(file.dur)}</span>` : "";
  const play = /^video\//.test(file.mime)
    ? `<span class="g-play"><svg viewBox="0 0 24 24"><polygon points="8 5 19 12 8 19 8 5"/></svg></span>`
    : "";
  fig.innerHTML = `
    <button class="g-check" type="button" aria-label="select ${escAttr(file.name)}">
      <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
    </button>
    <a class="g-dl" href="${escAttr(file.dl)}" download aria-label="download ${escAttr(file.name)}">
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
    img.srcset = [320, 512, 768, 1024].map((s) => `${thumbUrl(file, s)} ${s}w`).join(", ");
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
    if (file._lbIndex != null) openLightbox(file._lbIndex, fig);
    else downloadFile(file);
  });
  installHoverPreview(fig, file);
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

async function downloadFile(file) {
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

function installHoverPreview(fig, file) {
  if (!canHoverPreview || !/^video\//.test(file.mime)) return;
  let hoverTimer = 0;
  fig.addEventListener("pointerenter", () => {
    if (selected.size) return;
    hoverTimer = setTimeout(() => startHoverPreview(fig, file), 180);
  });
  fig.addEventListener("pointerleave", () => {
    clearTimeout(hoverTimer);
    stopHoverPreview(fig, file);
  });
}

async function startHoverPreview(fig, file) {
  if (!fig.isConnected || selected.size) return;
  try {
    const video = await getPreviewVideo(file);
    if (!fig.isConnected || selected.size || lightboxVideo === video) return;
    const media = fig.querySelector(".g-media") || fig.querySelector(".file-ico");
    video.className = "g-video-preview";
    video.controls = false;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    if (media && video.parentNode !== media) media.appendChild(video);
    fig.classList.add("previewing");
    await video.play().catch(() => {});
  } catch {
    // Some browser/codec combinations refuse hover preview; click playback still works.
  }
}

function stopHoverPreview(fig, file) {
  const video = previewVideos.get(file.id);
  if (!video || lightboxVideo === video) return;
  video.pause();
  fig.classList.remove("previewing");
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

// ---- Lightbox ----

function installLightbox() {
  $("lb-close").addEventListener("click", closeLightbox);
  $("lb-prev").addEventListener("click", () => stepLightbox(-1));
  $("lb-next").addEventListener("click", () => stepLightbox(1));
  $("lb-dl").addEventListener("click", () => {
    const file = lightboxItems[lightboxIndex];
    if (file) downloadFile(file);
  });
  $("lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox" || e.target.classList.contains("lb-stage")) closeLightbox();
  });
  let touchX = 0;
  $("lb-stage").addEventListener("touchstart", (e) => {
    touchX = e.changedTouches[0]?.clientX || 0;
  }, { passive: true });
  $("lb-stage").addEventListener("touchend", (e) => {
    const dx = (e.changedTouches[0]?.clientX || 0) - touchX;
    if (Math.abs(dx) > 48) stepLightbox(dx > 0 ? -1 : 1);
  }, { passive: true });
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") stepLightbox(-1);
    if (e.key === "ArrowRight") stepLightbox(1);
  });
}

async function openLightbox(index, sourceEl = null) {
  if (index < 0 || index >= lightboxItems.length) return;
  lightboxIndex = index;
  const file = lightboxItems[index];
  const stage = $("lb-stage");
  releaseLightboxVideo();
  stage.innerHTML = "";
  if (/^video\//.test(file.mime)) {
    let video = previewVideos.get(file.id);
    if (!video) video = await getPreviewVideo(file);
    if (!tokenFresh(file)) {
      await ensureFreshDownload(file);
      video.src = `${file.dl}?inline=1`;
    }
    lightboxVideo = video;
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.muted = false;
    video.loop = false;
    if (file.thumb) video.poster = thumbUrl(file, 1024);
    stage.appendChild(video);
    video.play().catch(() => {});
  } else {
    const img = document.createElement("img");
    img.alt = file.name;
    img.referrerPolicy = "no-referrer";
    img.decoding = "async";
    img.src = thumbUrl(file, 2048);
    stage.appendChild(img);
  }
  $("lb-name").textContent = file.name;
  $("lb-info").textContent = `${fmtBytes(file.size)}${file.at ? ` - ${new Date(file.at).toLocaleDateString()}` : ""} - ${index + 1}/${lightboxItems.length}`;
  $("lb-quality").disabled = !/^video\//.test(file.mime);
  $("lb-prev").classList.toggle("hidden", index === 0);
  $("lb-next").classList.toggle("hidden", index === lightboxItems.length - 1);
  $("lightbox").classList.remove("hidden");
  document.body.classList.add("no-scroll");
  renderLightboxStrip();
  animateFromTile(sourceEl);
  // Warm neighbour images for instant arrow navigation.
  for (const n of [index - 1, index + 1]) {
    const f = lightboxItems[n];
    if (f && /^image\//.test(f.mime) && f.thumb) new Image().src = thumbUrl(f, 2048);
    if (f && /^video\//.test(f.mime) && f.thumb) getPreviewVideo(f).catch(() => {});
  }
}

function stepLightbox(delta) {
  openLightbox(lightboxIndex + delta);
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
  $("lb-stage").innerHTML = "";
  $("lb-strip").innerHTML = "";
  releaseLightboxVideo();
  document.body.classList.remove("no-scroll");
}

function releaseLightboxVideo() {
  if (!lightboxVideo) return;
  lightboxVideo.pause();
  lightboxVideo.controls = false;
  lightboxVideo.muted = true;
  lightboxVideo.loop = true;
  lightboxVideo.removeAttribute("autoplay");
  lightboxVideo = null;
}

function renderLightboxStrip() {
  const strip = $("lb-strip");
  strip.innerHTML = "";
  const start = Math.max(0, lightboxIndex - 18);
  const end = Math.min(lightboxItems.length, lightboxIndex + 19);
  for (let i = start; i < end; i++) {
    const file = lightboxItems[i];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `lb-thumb${i === lightboxIndex ? " active" : ""}`;
    btn.setAttribute("aria-label", `open ${file.name}`);
    if (file.thumb) {
      const img = document.createElement("img");
      img.src = thumbUrl(file, 160);
      img.alt = "";
      img.loading = "lazy";
      img.referrerPolicy = "no-referrer";
      btn.appendChild(img);
    } else {
      btn.innerHTML = `<span>${iconFor(file.mime)}</span>`;
    }
    btn.addEventListener("click", () => openLightbox(i));
    strip.appendChild(btn);
  }
  strip.querySelector(".active")?.scrollIntoView({ block: "nearest", inline: "center" });
}

function animateFromTile(sourceEl) {
  if (!sourceEl || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const from = sourceEl.getBoundingClientRect();
  const to = $("lb-stage").getBoundingClientRect();
  if (!from.width || !to.width) return;
  const ghost = sourceEl.cloneNode(true);
  ghost.className = "lb-open-ghost";
  Object.assign(ghost.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
  });
  document.body.appendChild(ghost);
  requestAnimationFrame(() => {
    Object.assign(ghost.style, {
      left: `${to.left + to.width * 0.08}px`,
      top: `${to.top + to.height * 0.08}px`,
      width: `${to.width * 0.84}px`,
      height: `${to.height * 0.84}px`,
      opacity: "0",
      borderRadius: "14px",
    });
  });
  setTimeout(() => ghost.remove(), 280);
}

// ---- Selection + zip ----

function toggleSelect(file, fig) {
  if (selected.has(file.id)) selected.delete(file.id);
  else selected.set(file.id, file);
  fig.classList.toggle("selected", selected.has(file.id));
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
  const bytes = files.reduce((t, f) => t + f.size, 0);

  const btn = $("zip-btn");
  btn.disabled = true;
  $("mobile-zip").disabled = true;
  dedupe = null; // fresh name-dedupe per zip
  const zipName = `${meta.label.replace(/[^\w-]+/g, "_") || "share"}.zip`;
  try {
    btn.textContent = "Preparing zip...";
    $("mobile-zip").textContent = "Preparing...";
    const ticket = await createServerZipTicket(files);
    const a = document.createElement("a");
    a.href = ticket.url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast("Zip download started", `${files.length} files - ${fmtBytes(bytes)}`, "ok");
    btn.disabled = false;
    $("mobile-zip").disabled = false;
    updateSelInfo();
    return;
  } catch (serverErr) {
    if (bytes > MAX_ZIP_BYTES) {
      toast("Zip failed", "Server zip could not start, and this selection is too large for browser zip.", "err");
      return;
    }
    if (typeof microzip === "undefined") {
      toast("Zip failed", String(serverErr.message || serverErr).slice(0, 80), "err");
      return;
    }
    toast("Using browser zip fallback", "Keeping this tab open while the archive is built.", "warn");
  }

  try {
    const entries = files.map((f) => ({
      name: dedupeName(f),
      stream: async () => {
        await ensureFreshDownload(f);
        const r = await fetch(f.dl);
        if (!r.ok || !r.body) throw new Error(`download failed: ${f.name}`);
        return r.body;
      },
    }));

    if ("showSaveFilePicker" in window) {
      // Stream straight to disk - constant memory even for multi-GB zips.
      const handle = await window.showSaveFilePicker({
        suggestedName: zipName,
        types: [{ description: "Zip archive", accept: { "application/zip": [".zip"] } }],
      });
      const writable = await handle.createWritable();
      let doneBytes = 0;
      await microzip.zipStream(entries, async (chunk) => {
        await writable.write(chunk);
        doneBytes += chunk.length;
        btn.textContent = `zipping... ${fmtBytes(doneBytes)}`;
      });
      await writable.close();
      toast("Zip saved", zipName, "ok");
    } else {
      if (bytes > 1024 ** 3) {
        toast("Zip too large for this browser", "Use Chrome/Edge for streaming zips, or download files individually.", "warn");
        return;
      }
      const parts = [];
      await microzip.zipStream(entries, async (chunk) => parts.push(chunk));
      const blob = new Blob(parts, { type: "application/zip" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = zipName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 30000);
      toast("Zip ready", zipName, "ok");
    }
  } catch (err) {
    if (err?.name !== "AbortError") toast("Zip failed", String(err.message || err).slice(0, 80), "err");
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
    throw new Error(d.error || "server zip failed");
  }
  return r.json();
}

const usedNames = () => {
  const s = new Set();
  return (f) => {
    let name = f.name;
    let i = 1;
    while (s.has(name)) {
      const dot = f.name.lastIndexOf(".");
      name = dot > 0 ? `${f.name.slice(0, dot)} (${i})${f.name.slice(dot)}` : `${f.name} (${i})`;
      i++;
    }
    s.add(name);
    return name;
  };
};
let dedupe = null;
function dedupeName(f) {
  if (!dedupe) dedupe = usedNames();
  return dedupe(f);
}

// ---- Utilities ----

function chip(text, cls = "") {
  const el = document.createElement("span");
  el.className = `chip ${cls}`;
  el.textContent = text;
  return el;
}

function toast(title, message = "", tone = "") {
  const stack = $("toasts");
  if (!stack) return;
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.innerHTML = `<b></b>${message ? `<span></span>` : ""}`;
  item.querySelector("b").textContent = title;
  if (message) item.querySelector("span").textContent = message;
  stack.appendChild(item);
  requestAnimationFrame(() => item.classList.add("show"));
  setTimeout(() => {
    item.classList.remove("show");
    setTimeout(() => item.remove(), 260);
  }, 4200);
}

function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

function escAttr(s) {
  return esc(s).replace(/`/g, "&#96;");
}
