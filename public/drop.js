const $ = (id) => document.getElementById(id);
const slug = location.pathname.split("/").filter(Boolean).pop();
const sessionId =
  crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let link = null;
let pin = sessionStorage.getItem(`lhdb_pin_${slug}`) || "";
let concurrency = 2;
let chunkSize = 8 * 1024 * 1024;
let active = 0;
let wakeLock = null;
let liveSocket = null;
let lastLiveSend = 0;

const queue = [];
const MAX_RETRIES = 8;

init();

async function init() {
  const r = await fetch(`/api/link/${encodeURIComponent(slug)}`);
  $("loading").classList.add("hidden");
  if (!r.ok) return $("gone").classList.remove("hidden");
  link = await r.json();
  if (link.expired) return $("gone").classList.remove("hidden");
  document.title = `${link.label} · LostHusky's DropBox`;
  applyTheme(link.theme || {});
  applySettings(link.settings || {});
  logOpenOnce();

  if (link.requiresPin) {
    if (pin && (await verifyPinValue(pin))) return showMain();
    $("pin-label").textContent = link.label;
    $("pin-gate").classList.remove("hidden");
    $("pin-go").addEventListener("click", tryPin);
    $("pin").addEventListener("keydown", (e) => e.key === "Enter" && tryPin());
  } else {
    showMain();
  }
}

function applySettings(settings) {
  concurrency = clamp(Number(settings.concurrency) || 2, 1, 4);
  chunkSize = (Number(settings.chunkMB) || 8) * 1024 * 1024;
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

async function logOpenOnce() {
  const key = `lhdb_open_${slug}`;
  if (sessionStorage.getItem(key)) return;
  sessionStorage.setItem(key, "1");
  fetch("/api/opened", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ linkId: slug }),
  }).catch(() => {});
}

async function tryPin() {
  const candidate = $("pin").value.trim();
  if (!(await verifyPinValue(candidate))) return;
  pin = candidate;
  sessionStorage.setItem(`lhdb_pin_${slug}`, pin);
  $("pin-gate").classList.add("hidden");
  showMain();
}

async function verifyPinValue(candidate) {
  $("pin-err").textContent = "";
  const r = await fetch("/api/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ linkId: slug, pin: candidate }),
  });
  if (r.ok) return true;
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) {
    startCountdown($("pin-err"), Number(d.retryAfter || r.headers.get("retry-after") || 60));
  } else {
    $("pin-err").textContent = d.error || "Wrong password.";
  }
  return false;
}

function showMain() {
  $("main").classList.remove("hidden");
  $("label").textContent = link.label;
  $("welcome").textContent = link.theme?.welcome || "Send original photos and videos here.";

  const meta = $("meta");
  meta.innerHTML = "";
  meta.append(chip(link.requiresPin ? "password protected" : "open link"));
  meta.append(chip(`up to ${fmtBytes(link.settings?.maxTransferBytes || 5 * 1024 ** 4)}`));
  meta.append(chip(`${concurrency} parallel file${concurrency === 1 ? "" : "s"}`));
  meta.append(chip(`${link.settings?.chunkMB || 8} MB chunks`));
  if (link.expiresAt) {
    const d = Math.max(0, Math.ceil((link.expiresAt - Date.now()) / 86400000));
    meta.append(chip(`closes in ${d} day${d === 1 ? "" : "s"}`, d <= 2 ? "warn" : ""));
  }

  setupPromo();
  $("who").value = localStorage.getItem("lhdb_name") || "";
  const zone = $("zone");
  const picker = $("picker");
  zone.addEventListener("click", () => pickerGate() && picker.click());
  zone.addEventListener("keydown", (e) => {
    if ((e.key === "Enter" || e.key === " ") && pickerGate()) picker.click();
  });
  zone.addEventListener("dragover", (e) => {
    e.preventDefault();
    zone.classList.add("drag");
  });
  zone.addEventListener("dragleave", () => zone.classList.remove("drag"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    if (pickerGate()) addFiles(e.dataTransfer.files);
  });
  picker.addEventListener("change", () => {
    addFiles(picker.files);
    picker.value = "";
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && active > 0) acquireWakeLock();
  });
  window.addEventListener("beforeunload", (e) => {
    if (active > 0 || queue.some((q) => q.state === "queued" || q.state === "uploading")) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function setupPromo() {
  const t = link.theme || {};
  if (!t.promoTitle && !t.promoText && !t.videoUrl && !t.ctaUrl) return;
  $("promo").classList.remove("hidden");
  $("promo-title").textContent = t.promoTitle || "Transfer note";
  $("promo-text").textContent = t.promoText || "";
  if (t.videoUrl) {
    $("promo-video").classList.remove("hidden");
    $("promo-video").innerHTML = `<iframe src="${escAttr(t.videoUrl)}" loading="lazy" allowfullscreen></iframe>`;
  }
  if (t.ctaUrl && t.ctaLabel) {
    $("promo-cta").classList.remove("hidden");
    $("promo-cta").href = t.ctaUrl;
    $("promo-cta").textContent = t.ctaLabel;
  }
}

function pickerGate() {
  const name = $("who").value.trim();
  if (!name) {
    $("who").focus();
    $("who").classList.add("invalid");
    setTimeout(() => $("who").classList.remove("invalid"), 1200);
    return false;
  }
  localStorage.setItem("lhdb_name", name);
  return true;
}

function chip(text, cls = "") {
  const el = document.createElement("span");
  el.className = `chip ${cls}`;
  el.textContent = text;
  return el;
}

function addFiles(files) {
  for (const file of files) {
    const item = {
      file,
      sent: 0,
      state: "queued",
      retries: 0,
      uri: null,
      fileId: "",
      el: null,
    };
    item.el = renderRow(item);
    queue.push(item);
  }
  $("transfer-panel").classList.remove("hidden");
  connectLive();
  pump();
  sendLive(true);
}

function renderRow(item) {
  const row = document.createElement("div");
  row.className = "file-row";
  row.innerHTML = `
    <div class="file-top">
      <div class="file-name"></div>
      <div class="file-stat">queued</div>
    </div>
    <div class="trail"><i></i></div>`;
  row.querySelector(".file-name").textContent = item.file.name;
  $("list").prepend(row);
  return row;
}

function paint(item, statText, statCls = "") {
  const pct = item.file.size ? (item.sent / item.file.size) * 100 : 100;
  item.el.querySelector(".trail > i").style.width = `${Math.min(100, pct)}%`;
  const stat = item.el.querySelector(".file-stat");
  stat.textContent = statText;
  stat.className = `file-stat ${statCls}`;
  item.el.className = `file-row ${item.state}`;
  paintTotal();
}

function paintTotal() {
  const total = queue.reduce((t, q) => t + q.file.size, 0);
  const sent = queue.reduce((t, q) => t + q.sent, 0);
  const pct = total ? Math.floor((sent / total) * 100) : 0;
  $("pct").textContent = pct;
  $("totalbar").style.width = `${pct}%`;
  const done = queue.filter((q) => q.state === "done").length;
  const errors = queue.filter((q) => q.state === "error").length;
  $("detail").textContent =
    active > 0
      ? `${done}/${queue.length} files in - ${fmtBytes(sent)} of ${fmtBytes(total)}`
      : errors
      ? `${done} done, ${errors} failed - tap failed files to retry`
      : done === queue.length && queue.length
      ? `all ${done} files are in Drive`
      : "waiting";
  sendLive(false);
}

function pump() {
  while (active < concurrency) {
    const next = queue.find((q) => q.state === "queued");
    if (!next) break;
    active++;
    uploadFile(next).finally(() => {
      active--;
      if (active === 0 && !queue.some((q) => q.state === "queued")) releaseWakeLock();
      pump();
      paintTotal();
    });
  }
  if (active > 0) acquireWakeLock();
}

async function uploadFile(item) {
  item.state = "uploading";
  paint(item, "starting");
  try {
    if (!item.uri) {
      const r = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          linkId: slug,
          pin,
          filename: item.file.name,
          size: item.file.size,
          mimeType: item.file.type || "application/octet-stream",
          uploaderName: $("who").value.trim(),
          sessionId,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 429) throw new Error(`locked for ${d.retryAfter || 60}s`);
      if (!r.ok) throw new Error(d.error || `session HTTP ${r.status}`);
      item.uri = d.sessionUri;
    }

    let offset = item.sent;
    while (offset < item.file.size) {
      try {
        offset = await putChunk(item, offset);
        item.retries = 0;
      } catch (err) {
        if (++item.retries > MAX_RETRIES) throw err;
        const wait = Math.min(30000, 1000 * 2 ** item.retries);
        paint(item, `retrying in ${Math.round(wait / 1000)}s`, "err");
        await sleep(wait);
        offset = await probeOffset(item).catch(() => offset);
        item.sent = offset;
      }
    }

    item.state = "done";
    item.sent = item.file.size;
    paint(item, `${fmtBytes(item.file.size)} done`, "ok");
    fetch("/api/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        linkId: slug,
        filename: item.file.name,
        size: item.file.size,
        mimeType: item.file.type,
        uploader: $("who").value.trim(),
        fileId: item.fileId || "",
      }),
    }).catch(() => {});
  } catch (err) {
    item.state = "error";
    paint(item, err.message.slice(0, 80), "err");
    item.el.style.cursor = "pointer";
    item.el.onclick = () => {
      item.el.onclick = null;
      item.el.style.cursor = "";
      item.state = "queued";
      paint(item, "queued");
      pump();
    };
  }
}

function putChunk(item, offset) {
  return new Promise((resolve, reject) => {
    const end = Math.min(offset + chunkSize, item.file.size);
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", item.uri);
    xhr.setRequestHeader("Content-Range", `bytes ${offset}-${end - 1}/${item.file.size}`);
    xhr.timeout = 120000;
    xhr.upload.onprogress = (e) => {
      item.sent = offset + e.loaded;
      paint(item, `${fmtBytes(item.sent)} / ${fmtBytes(item.file.size)}`);
    };
    xhr.onload = () => {
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range");
        const next = range ? parseInt(range.split("-").pop(), 10) + 1 : end;
        item.sent = next;
        resolve(next);
      } else if (xhr.status === 200 || xhr.status === 201) {
        try {
          item.fileId = JSON.parse(xhr.responseText).id;
        } catch {}
        item.sent = item.file.size;
        resolve(item.file.size);
      } else {
        reject(new Error(`upload HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error("network drop"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(item.file.slice(offset, end));
  });
}

function probeOffset(item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", item.uri);
    xhr.setRequestHeader("Content-Range", `bytes */${item.file.size}`);
    xhr.onload = () => {
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range");
        resolve(range ? parseInt(range.split("-").pop(), 10) + 1 : 0);
      } else if (xhr.status === 200 || xhr.status === 201) {
        resolve(item.file.size);
      } else reject(new Error(`probe HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("probe network"));
    xhr.send();
  });
}

function connectLive() {
  if (liveSocket && liveSocket.readyState <= 1) return;
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    liveSocket = new WebSocket(`${protocol}//${location.host}/api/live/upload/${encodeURIComponent(slug)}`);
    liveSocket.onopen = () => {
      $("ws-state").textContent = "live progress";
      sendLive(true);
    };
    liveSocket.onclose = () => ($("ws-state").textContent = "progress offline");
  } catch {
    $("ws-state").textContent = "progress offline";
  }
}

function sendLive(force) {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && now - lastLiveSend < 1200) return;
  lastLiveSend = now;
  const total = queue.reduce((t, q) => t + q.file.size, 0);
  const sent = queue.reduce((t, q) => t + q.sent, 0);
  liveSocket.send(
    JSON.stringify({
      type: "progress",
      sessionId,
      slug,
      label: link.label,
      uploader: $("who").value.trim() || "anonymous",
      sent,
      total,
      state: queue.every((q) => q.state === "done") ? "done" : "uploading",
      files: queue.map((q) => ({
        name: q.file.name,
        sent: q.sent,
        size: q.file.size,
        state: q.state,
      })),
    })
  );
}

async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator && (!wakeLock || wakeLock.released)) {
      wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch {}
}

function releaseWakeLock() {
  try {
    wakeLock?.release();
  } catch {}
  wakeLock = null;
}

function startCountdown(el, seconds) {
  let left = Math.max(1, seconds);
  el.textContent = `Too many attempts. Try again in ${left}s.`;
  const timer = setInterval(() => {
    left--;
    el.textContent = left > 0 ? `Too many attempts. Try again in ${left}s.` : "Try again now.";
    if (left <= 0) clearInterval(timer);
  }, 1000);
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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function escAttr(value) {
  return String(value || "").replace(/"/g, "&quot;");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
