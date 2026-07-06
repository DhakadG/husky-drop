const $ = (id) => document.getElementById(id);
const slug = location.pathname.split("/").filter(Boolean).pop();

let meta = null;
let pin = sessionStorage.getItem(`lhdb_spin_${slug}`) || "";
let folders = [];
let allowZip = true;
let listFetchedAt = 0;
const selected = new Map(); // fileId -> file
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
  document.documentElement.style.setProperty("--accent", theme.accentColor || "#f2a33c");
  document.documentElement.style.setProperty("--page-bg", theme.backgroundColor || "#101418");
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
  $("welcome").textContent = "Browse and download the files below. Everything stays private to this link.";
  $("select-all").addEventListener("click", () => selectAll(true));
  $("select-none").addEventListener("click", () => selectAll(false));
  $("zip-btn").addEventListener("click", downloadZip);
  await loadList();
}

async function loadList() {
  const r = await fetch("/api/share/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, pin }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    toast("Could not load files", d.error || `HTTP ${r.status}`, "err");
    return;
  }
  const d = await r.json();
  folders = d.folders || [];
  allowZip = d.allowZip !== false;
  listFetchedAt = Date.now();
  renderMeta();
  renderFolders();
}

function renderMeta() {
  const el = $("meta");
  el.innerHTML = "";
  const count = folders.reduce((t, f) => t + f.files.length, 0);
  const bytes = folders.reduce((t, f) => t + f.files.reduce((x, y) => x + y.size, 0), 0);
  el.append(chip(`${count} file${count === 1 ? "" : "s"}`));
  el.append(chip(fmtBytes(bytes)));
  if (meta.expiresAt) {
    const days = Math.max(0, Math.ceil((meta.expiresAt - Date.now()) / 86400000));
    el.append(chip(`closes in ${days} day${days === 1 ? "" : "s"}`, days <= 2 ? "warn" : ""));
  }
}

function renderFolders() {
  const host = $("folders");
  host.innerHTML = "";
  if (!folders.length) {
    host.innerHTML = `<div class="empty">Nothing shared yet.</div>`;
    return;
  }
  for (const folder of folders) {
    const section = document.createElement("section");
    section.className = "gallery-folder";
    const showName = folders.length > 1;
    section.innerHTML = `${showName ? `<div class="section-subtitle">${esc(folder.name)} - ${folder.files.length} files</div>` : ""}<div class="gallery-grid"></div>`;
    const grid = section.querySelector(".gallery-grid");
    for (const file of folder.files) grid.appendChild(galleryItem(file));
    if (folder.nextPageToken) {
      const more = document.createElement("button");
      more.className = "mini";
      more.type = "button";
      more.textContent = "load more files";
      more.addEventListener("click", () => loadMore(folder, more));
      section.appendChild(more);
    }
    host.appendChild(section);
  }
  updateSelInfo();
}

async function loadMore(folder, button) {
  button.disabled = true;
  const r = await fetch("/api/share/list", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, pin, folderIndex: folder.index, pageToken: folder.nextPageToken }),
  });
  button.disabled = false;
  if (!r.ok) return;
  const d = await r.json();
  const page = (d.folders || [])[0];
  if (!page) return;
  folder.files.push(...page.files);
  folder.nextPageToken = page.nextPageToken;
  renderMeta();
  renderFolders();
}

function galleryItem(file) {
  const fig = document.createElement("figure");
  fig.className = "gallery-item";
  const isMedia = /^image\//.test(file.mime) || /^video\//.test(file.mime);
  fig.innerHTML = `
    <input class="g-check" type="checkbox" aria-label="select file" />
    ${file.thumb ? `<img loading="lazy" referrerpolicy="no-referrer" alt="" />` : `<div class="file-ico">${iconFor(file.mime)}</div>`}
    <figcaption>${esc(file.name)}<span>${fmtBytes(file.size)}</span></figcaption>
    <div class="g-actions">
      <a class="mini" href="${escAttr(file.dl)}" download>download</a>
    </div>`;
  if (file.thumb) {
    const img = fig.querySelector("img");
    img.src = file.thumb;
    img.onerror = () => {
      const ico = document.createElement("div");
      ico.className = "file-ico";
      ico.textContent = iconFor(file.mime);
      img.replaceWith(ico);
    };
  }
  const check = fig.querySelector(".g-check");
  check.checked = selected.has(file.id);
  check.addEventListener("change", () => {
    if (check.checked) selected.set(file.id, file);
    else selected.delete(file.id);
    fig.classList.toggle("selected", check.checked);
    updateSelInfo();
  });
  fig.classList.toggle("selected", check.checked);
  if (!isMedia) fig.querySelector(".file-ico, img")?.classList?.add?.("plain");
  return fig;
}

function iconFor(mime) {
  if (/^image\//.test(mime)) return "IMG";
  if (/^video\//.test(mime)) return "VID";
  if (/^audio\//.test(mime)) return "AUD";
  if (/pdf/.test(mime)) return "PDF";
  return "FILE";
}

function selectAll(on) {
  selected.clear();
  if (on) {
    for (const f of folders) for (const file of f.files) selected.set(file.id, file);
  }
  renderFolders();
}

function updateSelInfo() {
  const files = [...selected.values()];
  const bytes = files.reduce((t, f) => t + f.size, 0);
  $("sel-info").textContent = files.length ? `${files.length} selected - ${fmtBytes(bytes)}` : "";
  const btn = $("zip-btn");
  if (!allowZip || typeof microzip === "undefined") return btn.classList.add("hidden");
  btn.classList.toggle("hidden", files.length === 0);
  btn.textContent = files.length ? `Download ${files.length} as zip (${fmtBytes(bytes)})` : "Download selected as zip";
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
    await loadList();
    const byId = new Map();
    for (const f of folders) for (const file of f.files) byId.set(file.id, file);
    files = files.map((f) => byId.get(f.id)).filter(Boolean);
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
