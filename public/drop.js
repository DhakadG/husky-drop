const $ = (id) => document.getElementById(id);
const slug = location.pathname.split("/").filter(Boolean).pop();
const sessionId =
  crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

let link = null;
let pin = sessionStorage.getItem(`lhdb_pin_${slug}`) || "";
let concurrency = 4;
let chunkSize = 32 * 1024 * 1024;
let active = 0;
let wakeLock = null;
let liveSocket = null;
let lastLiveSend = 0;
let lastQueueNotice = "";
let liveReconnectDelay = 1000;
let liveConnectedOnce = false;
let lastClientError = "";
let errorReports = 0;
let queuePaused = false;
let showAllFiles = false;

const queue = [];
const MAX_RETRIES = 8;
const MAX_ACTIVE = 8; // hard cap on parallel files
const MAX_CHUNK = 128 * 1024 * 1024; // adaptive chunk ceiling
const MIN_CHUNK = 8 * 1024 * 1024;
const STALL_MS = 60000; // abort a chunk when no progress for this long
const FAST_CHUNK_MS = 3000; // chunk finished quicker than this -> grow chunk
const ATTENTION_STATES = new Set(["error", "warning", "canceled"]);

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

const ATTENTION_CAP = 200;
const DONE_TAIL = 40;
const MAX_VISIBLE = 60;
const uploadingList = [];
const attention = [];
const doneRecent = [];
let tailNote = null;
let paintScheduled = false;

let speedBps = 0;
let speedAt = 0;
let speedSent = 0;

const RESUME_DB = "husky-drop";
const RESUME_STORE = "pending";
const RESUME_MAX_AGE = 6 * 86400 * 1000;
let resumeRecords = new Map(); // matchKey -> record
let resumeDb = null;

init();

async function init() {
  installErrorReporting();
  const r = await fetch(`/api/link/${encodeURIComponent(slug)}`);
  $("loading").classList.add("hidden");
  if (!r.ok) return showGone();
  link = await r.json();
  if (link.expired) return showGone("expired", "This drop has closed.", "Ask the collector for a new link.");
  if (link.paused && link.budgetHit) return showGone("budget reached", "This drop reached its upload budget.", "Files already delivered are safe. Ask the collector to raise the limit or reopen the link.");
  if (link.paused) return showGone("paused", "This link is paused right now.", "Ask the collector to reopen it or try again later.");
  document.title = `${link.label} - LostHusky's DropBox`;
  applyTheme(link.theme || {});
  applySettings(link.settings || {});
  logOpenOnce();
  loadResumeRecords().catch(() => {});

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

function showGone(eyebrow = "closed", title = "This link is not available.", sub = "It expired, was deleted, or the URL is incomplete.") {
  const gone = $("gone");
  gone.querySelector(".eyebrow").textContent = eyebrow;
  gone.querySelector("h1").textContent = title;
  gone.querySelector(".muted").textContent = sub;
  gone.classList.remove("hidden");
}

function applySettings(settings) {
  concurrency = clamp(Number(settings.concurrency) || 4, 1, 8);
  chunkSize = clamp((Number(settings.chunkMB) || 32) * 1024 * 1024, MIN_CHUNK, MAX_CHUNK);
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
  $("collector-name").textContent = link.ownerName ? `${link.ownerName} is collecting` : "Your files are being collected";
  $("welcome").textContent = link.theme?.welcome || "Send original photos and videos here.";

  const meta = $("meta");
  meta.innerHTML = "";
  meta.append(chip(link.requiresPin ? "password protected" : "open link"));
  meta.append(chip(`up to ${fmtBytes(link.settings?.maxTransferBytes || 5 * 1024 ** 4)}`));
  if (link.driveFreeGB != null) {
    meta.append(chip(`~${link.driveFreeGB} GB free in Drive`, link.driveFreeGB < 30 ? "warn" : ""));
  }
  if (link.expiresAt) {
    const d = Math.max(0, Math.ceil((link.expiresAt - Date.now()) / 86400000));
    meta.append(chip(`closes in ${d} day${d === 1 ? "" : "s"}`, d <= 2 ? "warn" : ""));
  }

  setupPromo();
  maybeShowResumeBanner();
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
  zone.addEventListener("drop", async (e) => {
    e.preventDefault();
    zone.classList.remove("drag");
    if (!pickerGate()) return;
    // Traverse dropped directories with the FileSystem API so folder trees
    // keep their relative paths (dataTransfer.files flattens them).
    const collected = await collectDropped(e.dataTransfer);
    addFiles(collected);
  });
  picker.addEventListener("change", () => {
    addFiles(picker.files);
    picker.value = "";
  });

  const folderPicker = $("folderpicker");
  const folderBtn = $("folder-btn");
  if (folderBtn && folderPicker && "webkitdirectory" in folderPicker && !/android|iphone|ipad|ipod/i.test(navigator.userAgent)) {
    folderBtn.classList.remove("hidden");
    folderBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (pickerGate()) folderPicker.click();
    });
    folderPicker.addEventListener("change", () => {
      addFiles(folderPicker.files);
      folderPicker.value = "";
    });
  }

  $("report-btn")?.addEventListener("click", reportProblem);

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
  $("pause-all").addEventListener("click", toggleQueuePause);
  $("show-all-files").addEventListener("click", () => {
    showAllFiles = !showAllFiles;
    schedulePaint();
  });
  $("add-more").addEventListener("click", () => {
    $("done-card").classList.add("hidden");
    if (pickerGate()) $("picker").click();
  });

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

// chip() lives in public.js (shared with admin.js/share.js).

// Recursively walk dropped FileSystemEntry trees, capturing each file's
// relative path ("Trip/Day 1/IMG.jpg") so the Drive folder tree can be
// mirrored server-side. Falls back to the flat file list on old browsers.
async function collectDropped(dt) {
  const entries = [...(dt.items || [])].map((it) => it.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const out = [];
  const CAP = 20000;
  const entryFile = (entry) => new Promise((resolve) => entry.file(resolve, () => resolve(null)));
  const readBatch = (reader) => new Promise((resolve) => reader.readEntries(resolve, () => resolve([])));
  async function walk(entry, path) {
    if (out.length >= CAP) return;
    if (entry.isFile) {
      const file = await entryFile(entry);
      if (file) out.push({ file, rel: path ? `${path}${file.name}` : "" });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await readBatch(reader);
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${path}${entry.name}/`);
      }
    }
  }
  for (const entry of entries) await walk(entry, "");
  return out;
}

function addFiles(files) {
  const incoming = [...files].map((f) =>
    f instanceof File ? { file: f, rel: f.webkitRelativePath || "" } : f
  );
  if (!incoming.length) return;
  let skippedEmpty = 0;
  let skippedDupe = 0;
  let resumed = 0;
  const seen = new Set(queue.map((q) => `${q.relativePath}:${q.file.name}:${q.file.size}`));
  for (const { file, rel } of incoming) {
    if (!file.size) {
      skippedEmpty++;
      continue;
    }
    const dupeKey = `${rel}:${file.name}:${file.size}`;
    if (seen.has(dupeKey)) {
      skippedDupe++;
      continue;
    }
    seen.add(dupeKey);
    const item = {
      file,
      relativePath: rel || "",
      sent: 0,
      state: "queued",
      retries: 0,
      uri: null,
      resumedUri: false,
      fileId: "",
      chunk: chunkSize,
      stat: "",
      xhr: null,
      canceled: false,
    };
    const rec = resumeRecords.get(resumeKey(file));
    if (rec && rec.uri) {
      item.uri = rec.uri;
      item.resumedUri = true;
      item.fileId = rec.fileId || "";
      resumed++;
    }
    queue.push(item);
    totals.count++;
    totals.queued++;
    totals.bytes += file.size || 0;
  }
  lastQueueNotice = "";
  $("transfer-panel").classList.remove("hidden");
  connectLive();
  pump();
  schedulePaint();
  const added = incoming.length - skippedEmpty - skippedDupe;
  const notes = [];
  if (resumed) notes.push(`${resumed} resuming`);
  if (skippedDupe) notes.push(`${skippedDupe} duplicate${skippedDupe === 1 ? "" : "s"} skipped`);
  if (skippedEmpty) notes.push(`${skippedEmpty} empty skipped`);
  toast(
    `${added} file${added === 1 ? "" : "s"} added${notes.length ? ` (${notes.join(", ")})` : ""}`,
    "Keep this page open until the queue finishes.",
    "ok"
  );
  hideResumeBanner();
}

function toggleQueuePause() {
  queuePaused = !queuePaused;
  $("pause-all").textContent = queuePaused ? "Resume" : "Pause";
  $("pause-all").classList.toggle("active", queuePaused);
  sendLive(true);
  schedulePaint();
  if (!queuePaused) pump();
}

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

function itemWeight(item) {
  return Math.min(item.file.size - item.sent, item.chunk || chunkSize);
}

function activeWeight() {
  let w = 0;
  for (const it of uploadingList) w += itemWeight(it);
  return w;
}

function pump() {
  if (queuePaused) {
    sendLive(true);
    schedulePaint();
    return;
  }
  const windowBytes = concurrency * chunkSize;
  while (active < MAX_ACTIVE) {
    const next = queue.find((q) => q.state === "queued");
    if (!next) break;
    const w = Math.min(next.file.size, next.chunk || chunkSize);
    if (active > 0 && activeWeight() + w > windowBytes) break;
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
    prefetchNextSessions();

    let offset = item.sent;
    if (item.resumedUri) {
      item.stat = "checking previous upload";
      schedulePaint();
      try {
        offset = await probeOffset(item);
        setSent(item, offset);
        if (offset > 0) toast("Resuming upload", `${item.file.name} continues from ${fmtBytes(offset)}.`, "ok");
      } catch {
        item.uri = null;
        setSent(item, 0);
        offset = 0;
        await ensureSession(item);
      }
      item.resumedUri = false;
    }

    while (offset < item.file.size) {
      if (item.canceled) return;
      const chunkStarted = Date.now();
      try {
        offset = await putChunk(item, offset);
        item.retries = 0;
        const took = Date.now() - chunkStarted;
        if (took < FAST_CHUNK_MS && item.chunk < MAX_CHUNK) {
          item.chunk = Math.min(MAX_CHUNK, item.chunk * 2);
        }
      } catch (err) {
        if (item.canceled) return;
        if (err.dead) {
          item.uri = null;
          setSent(item, 0);
          offset = 0;
          await ensureSession(item);
          continue;
        }
        if (item.chunk > MIN_CHUNK) item.chunk = Math.max(MIN_CHUNK, item.chunk / 2);
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
    setState(item, "done");
    finalizeComplete(item);
  } catch (err) {
    if (item.canceled) return;
    if (err.status === 413) {
      queuePaused = true;
      $("pause-all").textContent = "Resume";
      $("budget-notice").classList.remove("hidden");
    }
    item.stat = err.message.slice(0, 80);
    setState(item, "error");
    reportError("upload", err, item.file.name);
    toast("Upload paused", `${item.file.name}: ${err.message.slice(0, 80)}`, "err");
  }
}

function sessionBody(item) {
  return JSON.stringify({
    linkId: slug,
    pin,
    filename: item.file.name,
    size: item.file.size,
    mimeType: item.file.type || "application/octet-stream",
    uploaderName: $("who").value.trim(),
    sessionId,
    relativePath: item.relativePath || "",
  });
}

async function ensureSession(item) {
  if (item.uri) return;
  const r = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: sessionBody(item),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Error(`locked for ${d.retryAfter || 60}s`);
  if (!r.ok) {
    const error = new Error(d.error || `session HTTP ${r.status}`);
    error.status = r.status;
    throw error;
  }
  item.uri = d.sessionUri;
  saveResumeRecord(item);
}

function prefetchNextSessions() {
  let spare = 0;
  for (const q of queue) {
    if (q.state === "queued" && q.uri) spare++;
  }
  let want = 2 - spare;
  if (want <= 0) return;
  for (const next of queue) {
    if (want <= 0) break;
    if (next.state !== "queued" || next.uri || next._prefetching) continue;
    want--;
    next._prefetching = true;
    fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sessionBody(next),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.sessionUri) {
          next.uri = d.sessionUri;
          saveResumeRecord(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        next._prefetching = false;
      });
  }
}

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
        deleteResumeRecord(item);
      } else {
        item.stat = "Drive saved - log delayed";
        setState(item, "warning");
      }
    })
    .catch(() => {
      item.stat = "Drive saved - log delayed";
      setState(item, "warning");
    });
}

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
    const size = item.chunk || chunkSize;
    const end = Math.min(offset + size, item.file.size);
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("PUT", item.uri);
    xhr.setRequestHeader("Content-Range", `bytes ${offset}-${end - 1}/${item.file.size}`);
    const clear = () => {
      if (item.xhr === xhr) item.xhr = null;
      clearTimeout(stallTimer);
    };
    let stallTimer = setTimeout(() => xhr.abort(), STALL_MS);
    xhr.upload.onprogress = (e) => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => xhr.abort(), STALL_MS);
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
          saveResumeRecord(item);
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
      reject(item.canceled ? new Error("canceled") : new Error("stalled"));
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
        try {
          item.fileId = item.fileId || JSON.parse(xhr.responseText).id;
        } catch {}
        resolve(item.file.size);
      } else reject(new Error(`probe HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("probe network"));
    xhr.send();
  });
}

function resumeKey(file) {
  return `${slug}:${file.name}:${file.size}:${file.lastModified || 0}`;
}

function openResumeDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no idb"));
    const req = indexedDB.open(RESUME_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(RESUME_STORE)) {
        req.result.createObjectStore(RESUME_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadResumeRecords() {
  try {
    resumeDb = await openResumeDb();
  } catch {
    return;
  }
  const tx = resumeDb.transaction(RESUME_STORE, "readwrite");
  const store = tx.objectStore(RESUME_STORE);
  const req = store.getAll();
  req.onsuccess = () => {
    const now = Date.now();
    for (const rec of req.result || []) {
      if (!rec.key.startsWith(`${slug}:`)) continue;
      if (now - (rec.at || 0) > RESUME_MAX_AGE || rec.completed) {
        store.delete(rec.key);
        continue;
      }
      resumeRecords.set(rec.key, rec);
    }
    if (resumeRecords.size) maybeShowResumeBanner();
  };
}

function saveResumeRecord(item) {
  if (!resumeDb || !item.uri) return;
  try {
    const tx = resumeDb.transaction(RESUME_STORE, "readwrite");
    tx.objectStore(RESUME_STORE).put({
      key: resumeKey(item.file),
      uri: item.uri,
      fileId: item.fileId || "",
      at: Date.now(),
    });
  } catch {}
}

function deleteResumeRecord(item) {
  resumeRecords.delete(resumeKey(item.file));
  if (!resumeDb) return;
  try {
    const tx = resumeDb.transaction(RESUME_STORE, "readwrite");
    tx.objectStore(RESUME_STORE).delete(resumeKey(item.file));
  } catch {}
}

function maybeShowResumeBanner() {
  const banner = $("resume-banner");
  if (!banner || !resumeRecords.size || !link || $("main").classList.contains("hidden")) return;
  banner.classList.remove("hidden");
  banner.querySelector("b").textContent = `You have ${resumeRecords.size} unfinished upload${resumeRecords.size === 1 ? "" : "s"} from a previous visit.`;
}

function hideResumeBanner() {
  $("resume-banner")?.classList.add("hidden");
}

function installErrorReporting() {
  window.addEventListener("error", (e) => {
    lastClientError = `${e.message} @ ${e.filename}:${e.lineno}`;
    autoReport("window.onerror", e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason?.message || String(e.reason || "unhandled rejection");
    lastClientError = msg;
    autoReport("unhandledrejection", msg);
  });
}

function autoReport(name, message) {
  if (errorReports >= 3) return;
  errorReports++;
  sendErrorReport(name, message);
}

function reportError(name, err, context = "") {
  lastClientError = `${context ? context + ": " : ""}${err?.message || err}`;
  autoReport(name, lastClientError);
}

function reportProblem() {
  sendErrorReport(
    "manual-report",
    lastClientError || `no captured error - ${totals.done}/${totals.count} done, ${totals.error} errors`
  );
  toast("Report sent", "Thanks - the admin can now see what went wrong.", "ok");
}

function sendErrorReport(name, message) {
  fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      linkId: slug,
      uploader: $("who")?.value?.trim() || "",
      name,
      message: String(message || "").slice(0, 300),
    }),
  }).catch(() => {});
}

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
  const room = Math.max(0, MAX_VISIBLE - pinned);
  const queued = [];
  if (showAllFiles) return queue;
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
  reconcile(list, vis, (item) => item, makeRow, updateRow);

  const hidden = totals.count - vis.length;
  if (tailNote) {
    tailNote.remove();
    tailNote = null;
  }
  const showButton = $("show-all-files");
  showButton.classList.toggle("hidden", hidden <= 0 && !showAllFiles);
  showButton.textContent = showAllFiles ? "Show active and recent only" : `Show all ${totals.count} files`;
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
  row.querySelector(".file-name").textContent = item.relativePath || item.file.name;
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
  if (item.state === "warning") return "Drive saved - log delayed";
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
  $("progress-ring-value").style.strokeDashoffset = String(163.36 * (1 - pct / 100));
  $("detail").textContent = queuePaused ? `Paused · ${detailText()}` : detailText();
  $("queue-title").textContent = totals.done === totals.count && totals.count ? `Delivered ${totals.done} of ${totals.count} files` : queuePaused ? `Paused — ${totals.done} of ${totals.count} files delivered` : `Uploading — ${totals.done} of ${totals.count} files`;
  const completed = totals.count > 0 && totals.done === totals.count;
  $("done-card").classList.toggle("hidden", !completed);
  if (completed) {
    $("done-title").textContent = `All ${totals.done} files delivered ✓`;
    $("done-recap").textContent = `${fmtBytes(totals.bytes)} saved to the collector’s Drive.`;
  }

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
    const eta = speedBps > 0 ? ` - ~${fmtTime(remaining / speedBps)} left` : "";
    const rate = speedBps > 0 ? ` - ${fmtBytes(speedBps)}/s` : "";
    return `${done}/${count} files - ${fmtBytes(sent)} of ${fmtBytes(bytes)}${rate}${eta}`;
  }
  const need = error + warning + canceled;
  if (need) return `${done} done - ${need} need attention, tap retry`;
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
      if (totals.uploading > 0 || totals.queued > 0) {
        setTimeout(connectLive, liveReconnectDelay);
        liveReconnectDelay = Math.min(15000, liveReconnectDelay * 2);
      }
    };
  } catch {
    $("ws-state").textContent = "progress offline";
  }
}

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
      paused: queuePaused,
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

// fmtBytes/fmtTime/escAttr live in public.js (shared with admin.js/share.js).

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
