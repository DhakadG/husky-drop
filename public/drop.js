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
let lastQueueNotice = "";
let liveReconnectDelay = 1000;
let liveConnectedOnce = false;

const queue = [];
const MAX_RETRIES = 8;
const ATTENTION_STATES = new Set(["error", "warning", "canceled"]);

// Aggregate counters kept up to date as items move between states. The hot
// upload path only mutates these O(1) numbers; it never scans the whole queue.
const totals = {
  count: 0,
  bytes: 0,
  sent: 0,
  queued: 0,
  uploading: 0,
  done: 0,
  error: 0,
  warning: 0,
  canceled: 0,
};

// Bounded render model: we only ever keep a small set of DOM rows alive
// (the files uploading now, anything that needs attention, and a short tail
// of recently finished files). With 600+ files this keeps the DOM tiny.
const ATTENTION_CAP = 200;
const DONE_TAIL = 40;
const MAX_VISIBLE = 60;
const uploadingList = [];
const attention = [];
const doneRecent = [];
const rowEls = new Map();
let tailNote = null;
let paintScheduled = false;

// Throughput sampling for live speed + ETA, smoothed with a light EMA.
let speedBps = 0;
let speedAt = 0;
let speedSent = 0;

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
  concurrency = clamp(Number(settings.concurrency) || 4, 1, 4);
  chunkSize = (Number(settings.chunkMB) || 32) * 1024 * 1024;
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
  meta.append(chip(`${link.settings?.chunkMB || 32} MB chunks`));
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

  // One delegated handler runs every per-row action; rows are reused, not
  // rebuilt, so we never re-attach listeners on each repaint.
  $("list").addEventListener("click", (e) => {
    const row = e.target.closest(".file-row");
    if (!row || !row._item) return;
    const item = row._item;
    if (e.target.closest("[data-act='retry']")) return retryItem(item);
    if (e.target.closest("[data-act='cancel']")) return cancelItem(item);
    if (item.state === "error") retryItem(item);
  });

  $("retry-all").addEventListener("click", retryAll);
  $("cancel-all").addEventListener("click", cancelAll);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && active > 0) acquireWakeLock();
  });
  window.addEventListener("beforeunload", (e) => {
    if (active > 0 || totals.queued > 0) {
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
    toast("Add your name first", "This keeps the Drive folder and admin history organized.", "warn");
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

// Enqueue is allocation-only: no per-file DOM, no layout. Even 600+ files add
// in a couple of milliseconds, then uploads start on the same frame.
function addFiles(files) {
  const incoming = [...files];
  if (!incoming.length) return;
  for (const file of incoming) {
    queue.push({
      file,
      sent: 0,
      state: "queued",
      retries: 0,
      uri: null,
      fileId: "",
      stat: "",
      xhr: null,
      canceled: false,
    });
    totals.count++;
    totals.queued++;
    totals.bytes += file.size || 0;
  }
  lastQueueNotice = "";
  $("transfer-panel").classList.remove("hidden");
  connectLive();
  pump();
  schedulePaint();
  toast(
    `${incoming.length} file${incoming.length === 1 ? "" : "s"} added`,
    "Keep this page open until the queue finishes.",
    "ok"
  );
}

// Centralised state transitions keep the aggregate counters and the small
// render lists consistent without ever walking the full queue.
function setState(item, next) {
  if (item.state === next) return;
  totals[item.state]--;
  if (item.state === "uploading") removeFrom(uploadingList, item);
  if (ATTENTION_STATES.has(item.state)) removeFrom(attention, item);

  item.state = next;
  totals[next]++;
  if (next === "uploading") {
    if (!item.stat) item.stat = "starting";
    uploadingList.push(item);
  } else if (ATTENTION_STATES.has(next)) {
    attention.push(item);
    if (attention.length > ATTENTION_CAP) attention.shift();
  } else if (next === "done") {
    item.stat = "";
    doneRecent.push(item);
    if (doneRecent.length > DONE_TAIL) doneRecent.shift();
  }
  schedulePaint();
}

function removeFrom(list, item) {
  const i = list.indexOf(item);
  if (i !== -1) list.splice(i, 1);
}

function setSent(item, value) {
  totals.sent += value - item.sent;
  item.sent = value;
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
      schedulePaint();
    });
  }
  if (active > 0) acquireWakeLock();
}

async function uploadFile(item) {
  item.canceled = false;
  item.stat = "";
  setState(item, "uploading");
  schedulePaint();
  try {
    await ensureSession(item);
    if (item.canceled) return;
    // Pre-warm the next file's session while this one uploads so back-to-back
    // files have a near-zero gap.
    prefetchNextSession();

    let offset = item.sent;
    while (offset < item.file.size) {
      if (item.canceled) return;
      try {
        offset = await putChunk(item, offset);
        item.retries = 0;
      } catch (err) {
        if (item.canceled) return;
        if (err.dead) {
          // The Drive resumable session expired or was lost. Mint a fresh one
          // and restart; the old partial upload was never finalized, so this
          // creates no duplicate file in Drive.
          item.uri = null;
          setSent(item, 0);
          offset = 0;
          await ensureSession(item);
          continue;
        }
        if (++item.retries > MAX_RETRIES) throw err;
        const wait = Math.min(30000, 1000 * 2 ** item.retries);
        item.stat = `retrying in ${Math.round(wait / 1000)}s`;
        schedulePaint();
        await sleep(wait);
        if (item.canceled) return;
        offset = await probeOffset(item).catch(() => offset);
        setSent(item, offset);
      }
    }

    setSent(item, item.file.size);
    // The bytes are in Drive. Mark done immediately and log the completion in
    // the background so the next file starts without waiting on the Worker.
    setState(item, "done");
    finalizeComplete(item);
  } catch (err) {
    if (item.canceled) return;
    item.stat = err.message.slice(0, 80);
    setState(item, "error");
    toast("Upload paused", `${item.file.name}: ${err.message.slice(0, 80)}`, "err");
  }
}

async function ensureSession(item) {
  if (item.uri) return;
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

// Mint the Drive resumable session for the next queued file while the current
// file is still uploading so back-to-back files have zero gap.
function prefetchNextSession() {
  const next = queue.find((q) => q.state === "queued" && !q.uri && !q._prefetching);
  if (!next) return;
  next._prefetching = true;
  fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      linkId: slug,
      pin,
      filename: next.file.name,
      size: next.file.size,
      mimeType: next.file.type || "application/octet-stream",
      uploaderName: $("who").value.trim(),
      sessionId,
    }),
  })
    .then((r) => r.json())
    .then((d) => {
      if (d.sessionUri) next.uri = d.sessionUri;
    })
    .catch(() => {})
    .finally(() => {
      next._prefetching = false;
    });
}

// Record a finished file with the Worker. The file is already safe in Drive, so
// this only updates the dashboard log; a failure downgrades to "warning" and a
// success (including a retry) settles it to "done". The Worker de-dupes by file
// id, so re-sending a completion never double-counts.
function finalizeComplete(item) {
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
  })
    .then((r) => {
      if (r.ok) {
        item.stat = "";
        if (item.state !== "done") setState(item, "done");
        else schedulePaint();
      } else {
        item.stat = "Drive saved · log delayed";
        setState(item, "warning");
      }
    })
    .catch(() => {
      item.stat = "Drive saved · log delayed";
      setState(item, "warning");
    });
}

// Manual retry / sync for one file. Dedup-safe:
//  - If the file already has a Drive id, only the dashboard record is missing,
//    so we just re-send the completion (no re-upload, no duplicate).
//  - Otherwise nothing was finalized in Drive yet, so it is safe to re-queue
//    and resume/restart the upload.
function retryItem(item) {
  if (!ATTENTION_STATES.has(item.state)) return;
  item.canceled = false;
  item.retries = 0;
  if (item.fileId) {
    item.stat = "verifying";
    setState(item, "uploading");
    finalizeComplete(item);
  } else {
    item.stat = "";
    setState(item, "queued");
    pump();
  }
}

function cancelItem(item) {
  if (item.state === "done" || item.state === "canceled") return;
  item.canceled = true;
  try {
    item.xhr?.abort();
  } catch {}
  item.xhr = null;
  item.stat = "canceled";
  setState(item, "canceled");
}

function retryAll() {
  let n = 0;
  for (const it of queue) {
    if (ATTENTION_STATES.has(it.state)) {
      retryItem(it);
      n++;
    }
  }
  if (n) toast("Retrying", `${n} file${n === 1 ? "" : "s"} re-queued.`, "ok");
}

function cancelAll() {
  let n = 0;
  for (const it of queue) {
    if (it.state === "queued" || it.state === "uploading") {
      cancelItem(it);
      n++;
    }
  }
  if (n) toast("Canceled", `${n} file${n === 1 ? "" : "s"} stopped.`, "warn");
}

function putChunk(item, offset) {
  return new Promise((resolve, reject) => {
    const end = Math.min(offset + chunkSize, item.file.size);
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("PUT", item.uri);
    xhr.setRequestHeader("Content-Range", `bytes ${offset}-${end - 1}/${item.file.size}`);
    xhr.timeout = 120000;
    const clear = () => {
      if (item.xhr === xhr) item.xhr = null;
    };
    xhr.upload.onprogress = (e) => {
      item.stat = "";
      setSent(item, offset + e.loaded);
      schedulePaint();
    };
    xhr.onload = () => {
      clear();
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range");
        const next = range ? parseInt(range.split("-").pop(), 10) + 1 : end;
        setSent(item, next);
        resolve(next);
      } else if (xhr.status === 200 || xhr.status === 201) {
        try {
          item.fileId = JSON.parse(xhr.responseText).id;
        } catch {}
        setSent(item, item.file.size);
        resolve(item.file.size);
      } else {
        const err = new Error(`upload HTTP ${xhr.status}`);
        if (xhr.status === 400 || xhr.status === 404 || xhr.status === 410) err.dead = true;
        reject(err);
      }
    };
    xhr.onerror = () => {
      clear();
      reject(new Error("network drop"));
    };
    xhr.ontimeout = () => {
      clear();
      reject(new Error("timeout"));
    };
    xhr.onabort = () => {
      clear();
      reject(new Error("canceled"));
    };
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

// ---- Rendering: coalesced to one pass per animation frame ----

function schedulePaint() {
  if (paintScheduled) return;
  paintScheduled = true;
  requestAnimationFrame(flush);
}

function flush() {
  paintScheduled = false;
  updateSpeed();
  renderVisible();
  renderSummary();
  sendLive(false);
}

function updateSpeed() {
  const now = Date.now();
  if (!speedAt) {
    speedAt = now;
    speedSent = totals.sent;
    return;
  }
  const dt = (now - speedAt) / 1000;
  if (dt < 1) return;
  const inst = Math.max(0, (totals.sent - speedSent) / dt);
  speedBps = speedBps ? speedBps * 0.6 + inst * 0.4 : inst;
  speedAt = now;
  speedSent = totals.sent;
}

function visibleItems() {
  const att = attention.length > 50 ? attention.slice(-50) : attention;
  const pinned = uploadingList.length + att.length + doneRecent.length;
  // Fill any leftover budget with the next queued files so small and medium
  // batches list completely; large batches stay capped and summarised.
  const room = Math.max(0, MAX_VISIBLE - pinned);
  const queued = [];
  if (room > 0 && totals.queued > 0) {
    for (const it of queue) {
      if (it.state !== "queued") continue;
      queued.push(it);
      if (queued.length >= room) break;
    }
  }
  return [...uploadingList, ...att, ...queued, ...doneRecent];
}

function renderVisible() {
  const list = $("list");
  const vis = visibleItems();
  const visSet = new Set(vis);

  for (const [item, el] of rowEls) {
    if (!visSet.has(item)) {
      el.remove();
      rowEls.delete(item);
    }
  }

  let prev = null;
  for (const item of vis) {
    let el = rowEls.get(item);
    if (!el) {
      el = makeRow(item);
      rowEls.set(item, el);
    }
    updateRow(el, item);
    if (prev) {
      if (prev.nextSibling !== el) prev.after(el);
    } else if (list.firstChild !== el) {
      list.prepend(el);
    }
    prev = el;
  }

  const hidden = totals.count - vis.length;
  if (hidden > 0) {
    if (!tailNote) {
      tailNote = document.createElement("div");
      tailNote.className = "list-note";
    }
    tailNote.textContent = `+${hidden} more file${hidden === 1 ? "" : "s"} not shown — totals above stay accurate`;
    list.appendChild(tailNote);
  } else if (tailNote) {
    tailNote.remove();
    tailNote = null;
  }
}

function makeRow(item) {
  const row = document.createElement("div");
  row.className = "file-row";
  row.innerHTML = `
    <div class="file-top">
      <div class="file-name"></div>
      <div class="file-stat"></div>
    </div>
    <div class="trail"><i></i></div>
    <div class="file-actions">
      <button class="row-btn" data-act="retry" type="button">retry</button>
      <button class="row-btn danger" data-act="cancel" type="button">cancel</button>
    </div>`;
  row.querySelector(".file-name").textContent = item.file.name;
  row._item = item;
  row._bar = row.querySelector(".trail > i");
  row._stat = row.querySelector(".file-stat");
  row._retry = row.querySelector("[data-act='retry']");
  row._cancel = row.querySelector("[data-act='cancel']");
  return row;
}

function updateRow(el, item) {
  const pct = item.file.size ? Math.min(100, (item.sent / item.file.size) * 100) : 100;
  el._bar.style.width = `${pct}%`;
  el._stat.textContent = rowStat(item);
  el._stat.className = `file-stat ${statClass(item.state)}`;
  el.className = `file-row ${item.state}`;
  const canRetry = ATTENTION_STATES.has(item.state);
  const canCancel = item.state === "queued" || item.state === "uploading";
  el._retry.classList.toggle("hidden", !canRetry);
  el._cancel.classList.toggle("hidden", !canCancel);
  el.classList.toggle("has-actions", canRetry || canCancel);
}

function rowStat(item) {
  if (item.stat) return item.stat;
  if (item.state === "uploading") return `${fmtBytes(item.sent)} / ${fmtBytes(item.file.size)}`;
  if (item.state === "done") return `${fmtBytes(item.file.size)} done`;
  if (item.state === "warning") return "Drive saved · log delayed";
  if (item.state === "canceled") return "canceled";
  return item.state;
}

function statClass(state) {
  if (state === "done") return "ok";
  if (state === "error" || state === "canceled") return "err";
  if (state === "warning") return "warn";
  return "";
}

function renderSummary() {
  const pct = totals.bytes ? Math.floor((totals.sent / totals.bytes) * 100) : 0;
  $("pct").textContent = pct;
  $("totalbar").style.width = `${pct}%`;
  $("detail").textContent = detailText();

  const failed = totals.error + totals.warning + totals.canceled;
  const pending = totals.queued + totals.uploading;
  const retryBtn = $("retry-all");
  const cancelBtn = $("cancel-all");
  if (retryBtn) {
    retryBtn.classList.toggle("hidden", failed === 0);
    retryBtn.textContent = failed ? `retry ${failed} failed` : "retry failed";
  }
  if (cancelBtn) cancelBtn.classList.toggle("hidden", pending === 0);

  maybeQueueNotice();
}

function detailText() {
  const { done, error, warning, canceled, count, sent, bytes } = totals;
  if (active > 0) {
    const remaining = Math.max(0, bytes - sent);
    const eta = speedBps > 0 ? ` · ~${fmtTime(remaining / speedBps)} left` : "";
    const rate = speedBps > 0 ? ` · ${fmtBytes(speedBps)}/s` : "";
    return `${done}/${count} files · ${fmtBytes(sent)} of ${fmtBytes(bytes)}${rate}${eta}`;
  }
  const need = error + warning + canceled;
  if (need) return `${done} done · ${need} need attention — tap retry`;
  if (count && done === count) return `all ${done} files are in Drive`;
  return "waiting";
}

function maybeQueueNotice() {
  const stateKey = `${totals.done}:${totals.error}:${totals.warning}:${totals.canceled}:${totals.count}:${active}`;
  if (!totals.count || active !== 0 || stateKey === lastQueueNotice) return;
  lastQueueNotice = stateKey;
  if (totals.error || totals.canceled) {
    const need = totals.error + totals.canceled;
    toast(`${need} file${need === 1 ? "" : "s"} need attention`, "Tap a row's retry button to resend it.", "err");
  } else if (totals.warning) {
    toast("Upload needs verification", "Drive received the files; tap retry to finish the dashboard log.", "warn");
  } else if (totals.done === totals.count) {
    toast("Upload complete", `${totals.done} file${totals.done === 1 ? "" : "s"} saved to Drive.`, "ok");
  }
}

function connectLive() {
  if (liveSocket && liveSocket.readyState <= 1) return;
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    liveSocket = new WebSocket(`${protocol}//${location.host}/api/live/upload/${encodeURIComponent(slug)}`);
    liveSocket.onopen = () => {
      liveReconnectDelay = 1000;
      $("ws-state").textContent = "live progress";
      if (!liveConnectedOnce) {
        liveConnectedOnce = true;
        toast("Live progress connected", "The admin dashboard can see this transfer.", "ok");
      }
      sendLive(true);
    };
    liveSocket.onclose = () => {
      $("ws-state").textContent = "progress offline";
      // Reconnect with backoff while there is still work to report.
      if (totals.uploading > 0 || totals.queued > 0) {
        setTimeout(connectLive, liveReconnectDelay);
        liveReconnectDelay = Math.min(15000, liveReconnectDelay * 2);
      }
    };
  } catch {
    $("ws-state").textContent = "progress offline";
  }
}

// Live payload is O(1) + capped: a small sample of files (uploading first,
// then anything needing attention) instead of serialising the whole queue.
function sendLive(force) {
  if (!liveSocket || liveSocket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && now - lastLiveSend < 1200) return;
  lastLiveSend = now;
  const sample = [...uploadingList, ...attention].slice(0, 20).map((q) => ({
    name: q.file.name,
    sent: q.sent,
    size: q.file.size,
    state: q.state,
  }));
  liveSocket.send(
    JSON.stringify({
      type: "progress",
      sessionId,
      slug,
      label: link.label,
      uploader: $("who").value.trim() || "anonymous",
      sent: totals.sent,
      total: totals.bytes,
      count: totals.count,
      done: totals.done,
      error: totals.error + totals.canceled,
      speed: Math.round(speedBps),
      state: totals.count && totals.done === totals.count ? "done" : "uploading",
      files: sample,
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

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function escAttr(value) {
  return String(value || "").replace(/"/g, "&quot;");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
