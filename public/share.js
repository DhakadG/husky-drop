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
const MAX_ZIP_BYTES = 3.8 * 1024 ** 3; // no zip64 in microzip

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
    allowZip = d.allowZip !== false;
    render();
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
    for (const file of files) {
      const el = card(file);
      file._el = el;
      grid.appendChild(el);
      if (isViewable(file)) {
        file._lbIndex = lightboxItems.length;
        lightboxItems.push(file);
      }
    }
    section.appendChild(grid);
    if (folder.nextPageToken) {
      const more = document.createElement("button");
      more.className = "mini load-more";
      more.type = "button";
      more.textContent = "load more files";
      more.addEventListener("click", () => loadMore(folder, more));
      section.appendChild(more);
    }
    host.appendChild(section);
  }
  updateSelInfo();
  scheduleLayout();
}

async function loadMore(folder, button) {
  button.disabled = true;
  const here = crumbs[crumbs.length - 1];
  const body = { slug, pin, pageToken: folder.nextPageToken };
  if (here.token) body.folderToken = here.token;
  else body.folderIndex = folder.index;
  const r = await fetch("/api/share/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  button.disabled = false;
  if (!r.ok) return;
  const d = await r.json();
  const page = (d.folders || [])[0];
  if (!page) return;
  folder.files.push(...page.files);
  for (const sub of page.subfolders || []) {
    if (!folder.subfolders.some((s) => s.name === sub.name)) folder.subfolders.push(sub);
  }
  folder.nextPageToken = page.nextPageToken;
  render();
}

function renderMeta() {
  const el = $("meta");
  el.innerHTML = "";
  const folders = current?.folders || [];
  const count = folders.reduce((t, f) => t + f.files.length, 0);
  const subCount = folders.reduce((t, f) => t + (f.subfolders?.length || 0), 0);
  const bytes = folders.reduce((t, f) => t + f.files.reduce((x, y) => x + y.size, 0), 0);
  el.append(chip(`${count} file${count === 1 ? "" : "s"}`));
  if (subCount) el.append(chip(`${subCount} folder${subCount === 1 ? "" : "s"}`));
  el.append(chip(fmtBytes(bytes)));
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
  const media = /^(image|video)\//.test(file.mime) && file.thumb;
  fig.className = `g-card${media ? "" : " plain"}`;
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
    const img = document.createElement("img");
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.alt = file.name;
    img.src = thumbUrl(file, 512);
    img.onerror = () => {
      fig.classList.add("plain");
      img.replaceWith(plainIcon(file));
    };
    fig.prepend(img);
  } else {
    fig.prepend(plainIcon(file));
  }

  const check = fig.querySelector(".g-check");
  check.addEventListener("click", (e) => {
    e.stopPropagation();
    toggleSelect(file, fig);
  });
  fig.querySelector(".g-dl").addEventListener("click", (e) => e.stopPropagation());
  fig.addEventListener("click", () => {
    if (selected.size) return toggleSelect(file, fig);
    if (file._lbIndex != null) openLightbox(file._lbIndex);
    else window.open(file.dl, "_blank");
  });
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
  const a = file.w && file.h ? file.w / file.h : /^(image|video)\//.test(file.mime) && file.thumb ? 4 / 3 : 1;
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
  $("lightbox").addEventListener("click", (e) => {
    if (e.target.id === "lightbox" || e.target.classList.contains("lb-stage")) closeLightbox();
  });
  document.addEventListener("keydown", (e) => {
    if ($("lightbox").classList.contains("hidden")) return;
    if (e.key === "Escape") closeLightbox();
    if (e.key === "ArrowLeft") stepLightbox(-1);
    if (e.key === "ArrowRight") stepLightbox(1);
  });
}

function openLightbox(index) {
  if (index < 0 || index >= lightboxItems.length) return;
  lightboxIndex = index;
  const file = lightboxItems[index];
  const stage = $("lb-stage");
  stage.innerHTML = "";
  if (/^video\//.test(file.mime)) {
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.src = `${file.dl}?inline=1`;
    if (file.thumb) video.poster = thumbUrl(file, 1024);
    stage.appendChild(video);
  } else {
    const img = document.createElement("img");
    img.alt = file.name;
    img.referrerPolicy = "no-referrer";
    img.src = thumbUrl(file, 2048);
    stage.appendChild(img);
  }
  $("lb-name").textContent = file.name;
  $("lb-info").textContent = `${fmtBytes(file.size)}${file.at ? ` - ${new Date(file.at).toLocaleDateString()}` : ""} - ${index + 1}/${lightboxItems.length}`;
  $("lb-dl").href = file.dl;
  $("lb-prev").classList.toggle("hidden", index === 0);
  $("lb-next").classList.toggle("hidden", index === lightboxItems.length - 1);
  $("lightbox").classList.remove("hidden");
  document.body.classList.add("no-scroll");
  // Warm neighbour images for instant arrow navigation.
  for (const n of [index - 1, index + 1]) {
    const f = lightboxItems[n];
    if (f && /^image\//.test(f.mime) && f.thumb) new Image().src = thumbUrl(f, 2048);
  }
}

function stepLightbox(delta) {
  openLightbox(lightboxIndex + delta);
}

function closeLightbox() {
  $("lightbox").classList.add("hidden");
  $("lb-stage").innerHTML = "";
  document.body.classList.remove("no-scroll");
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
  $("select-none").classList.toggle("hidden", files.length === 0);
  const btn = $("zip-btn");
  if (!allowZip || typeof microzip === "undefined") return btn.classList.add("hidden");
  btn.classList.toggle("hidden", files.length === 0);
  btn.textContent = files.length ? `Download ${files.length} as zip (${fmtBytes(bytes)})` : "Download zip";
}

async function downloadZip() {
  let files = [...selected.values()];
  if (!files.length) return;
  const bytes = files.reduce((t, f) => t + f.size, 0);
  if (bytes > MAX_ZIP_BYTES) {
    toast("Selection too large for zip", "Keep it under 3.8 GB, or download files individually.", "warn");
    return;
  }
  // Download tokens live 15 minutes; refresh the listing if it's stale so the
  // zip never dies halfway on an expired URL.
  if (Date.now() - listFetchedAt > 10 * 60000) {
    listingCache.clear();
    const here = crumbs[crumbs.length - 1];
    await navigate(here.token, here.name, false);
    const byId = new Map();
    for (const f of current?.folders || []) for (const file of f.files) byId.set(file.id, file);
    files = files.map((f) => byId.get(f.id) || f).filter(Boolean);
  }

  const btn = $("zip-btn");
  btn.disabled = true;
  dedupe = null; // fresh name-dedupe per zip
  const zipName = `${meta.label.replace(/[^\w-]+/g, "_") || "share"}.zip`;
  try {
    const entries = files.map((f) => ({
      name: dedupeName(f),
      stream: async () => {
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
    updateSelInfo();
  }
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
