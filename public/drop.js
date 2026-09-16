import {
  $,
  IS_MOBILE,
  MAX_ACTIVE,
  MAX_CHUNK,
  MIN_CHUNK,
  queue,
  resumeRecords,
  slug,
  st,
  totals,
} from "./drop-state.js";
import {
  toggleQueuePause,
  setNetworkPaused,
  pump,
  retryItem,
  cancelItem,
  retryAll,
  cancelAll,
  syncNameStep,
} from "./drop-queue.js";
import { resumeKey, loadResumeRecords, maybeShowResumeBanner, hideResumeBanner } from "./drop-resume.js";
import { crumb, installErrorReporting, reportProblem } from "./drop-report.js";
import { schedulePaint } from "./drop-render.js";
import { connectLive, acquireWakeLock, startCountdown } from "./drop-live.js";
import { toast, clamp } from "./drop-utils.js";

// Drop page: boot, the pre-upload gate, main-page setup, pickers and the
// add-files entry point. Engine and views live in drop-*.js.
async function init() {
  installErrorReporting();
  let r;
  try {
    r = await fetch(`/api/link/${encodeURIComponent(slug)}`);
  } catch {
    return showGone("offline", "Can't reach the drop.", "Check your connection and reload.", { icon: "wifi-off", tone: "warn", retry: true });
  }
  if (r.status === 404) return showGone("closed", "This link is not available.", "It expired, was deleted, or the URL is incomplete.");
  if (!r.ok) return showGone("hiccup", "Something went wrong on our side.", "Reload in a moment; nothing you sent is lost.", { tone: "warn", retry: true });
  st.link = await r.json();
  if (st.link.expired) return showGone("expired", "This drop has closed.", "Ask the collector for a new link.");
  if (st.link.paused && st.link.budgetHit) return showGone("budget reached", "This drop reached its upload budget.", "Files already delivered are safe. Ask the collector to raise the limit or reopen the link.");
  if (st.link.paused) return showGone("paused", "This link is paused right now.", "Ask the collector to reopen it or try again later.", { icon: "pause" });
  document.title = `${st.link.label} - LostHusky's DropBox`;
  applyTheme(st.link.theme || {});
  applySettings(st.link.settings || {});
  logOpenOnce();
  loadResumeRecords().catch(() => {});

  if (st.link.requiresAuth && !st.link.viewer) return showSignIn();
  if (st.link.requiresPin) {
    if (st.pin && (await verifyPinValue(st.pin))) return showMain();
    return showPinGate();
  }
  showMain();
}

// ---- Gate: the single card every pre-upload state renders into ----

export function showGate(state, { icon = "circle-alert", tone = "", eyebrow = "", title = "", sub = "", body = "" }) {
  const gate = $("gate");
  gate.dataset.state = state;
  gate.dataset.tone = tone;
  $("gate-icon").innerHTML = uiIcon(icon, state === "loading" ? "ico-spin" : "ico");
  $("gate-eyebrow").textContent = eyebrow;
  $("gate-title").textContent = title;
  $("gate-sub").textContent = sub;
  $("gate-body").innerHTML = body;
  $("gate-err").textContent = "";
  gate.classList.remove("hidden");
  $("main").classList.add("hidden");
  setConnection(state === "loading" ? "checking" : state === "closed" ? "closed" : "secure");
}

export function showGone(eyebrow, title, sub, { icon = "circle-alert", tone = "err", retry = false } = {}) {
  showGate("closed", {
    icon, tone, eyebrow, title, sub,
    body: retry
      ? `<button class="btn" id="gate-retry" type="button">${uiIcon("refresh-cw")}Try again</button><a class="btn ghost" href="/">Back to losthusky/drop</a>`
      : `<a class="btn ghost" href="/">${uiIcon("arrow-left")}Back to losthusky/drop</a>`,
  });
  $("gate-retry")?.addEventListener("click", () => location.reload());
}

export function showSignIn() {
  showGate("signin", {
    icon: "user-round",
    eyebrow: st.link.ownerName ? `${st.link.ownerName} is collecting` : "identified upload",
    title: st.link.label,
    sub: "Sign in with Google so your files are labelled with your name. We only read your name and email; nothing is posted or shared.",
    body: `<button class="btn google-btn" id="auth-go" type="button">${uiIcon("google-g", "ico-brand")}Continue with Google</button>`,
  });
  const signinError = new URLSearchParams(location.search).get("signinError");
  if (signinError) $("gate-err").textContent = signinError;
  $("auth-go").addEventListener("click", () => {
    $("auth-go").disabled = true;
    $("auth-go").innerHTML = `${uiIcon("loader-circle", "ico-spin")}Opening Google…`;
    location.href = `/api/auth/login?kind=drop&slug=${encodeURIComponent(slug)}`;
  });
}

export function showPinGate() {
  const digits = st.link.pinDigits !== false;
  showGate("pin", {
    icon: "lock-keyhole",
    eyebrow: st.link.ownerName ? `${st.link.ownerName} is collecting` : "protected drop",
    title: st.link.label,
    sub: digits ? "Enter the code the collector shared with you." : "Enter the password the collector shared with you.",
    body: `<label class="gate-field"><span>${digits ? "Drop code" : "Password"}</span><span class="gate-input"><input id="pin" type="password" inputmode="${digits ? "numeric" : "text"}" autocomplete="one-time-code" autocapitalize="off" spellcheck="false" placeholder="${digits ? "• • • •" : "Enter password"}" aria-describedby="gate-err" /><button class="icon-btn" id="pin-eye" type="button" aria-label="show code" aria-pressed="false">${uiIcon("eye")}</button></span></label><button class="btn" id="pin-go" type="button">${uiIcon("log-in")}Open drop</button>`,
  });
  const input = $("pin");
  input.focus();
  $("pin-eye").addEventListener("click", () => {
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    $("pin-eye").setAttribute("aria-pressed", String(show));
    $("pin-eye").setAttribute("aria-label", show ? "hide code" : "show code");
    $("pin-eye").innerHTML = uiIcon(show ? "eye-off" : "eye");
    input.focus();
  });
  input.addEventListener("input", () => { $("gate-err").textContent = ""; });
  $("pin-go").addEventListener("click", tryPin);
  input.addEventListener("keydown", (e) => e.key === "Enter" && tryPin());
}

// Topbar pill: the one place the page says how it is doing.
export function setConnection(state, text) {
  const pill = $("ws-state");
  const labels = { checking: "checking link", secure: "secure drop", live: "live progress", offline: "offline", paused: "paused", closed: "link closed" };
  pill.dataset.state = state;
  pill.textContent = text || labels[state] || state;
}

export function applySettings(settings) {
  st.concurrency = clamp(Number(settings.concurrency) || 4, 1, MAX_ACTIVE);
  st.chunkSize = clamp((Number(settings.chunkMB) || 32) * 1024 * 1024, MIN_CHUNK, MAX_CHUNK);
  st.adaptiveController = settings.adaptiveConcurrency && typeof createAdaptiveConcurrency === "function"
    ? createAdaptiveConcurrency({ min: 2, max: MAX_ACTIVE, initial: Math.max(st.concurrency, IS_MOBILE ? 4 : 6) })
    : null;
  if (st.adaptiveController) st.concurrency = st.adaptiveController.seed(navigator.connection || {});
}

export function applyTheme(theme) {
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

export async function tryPin() {
  const input = $("pin");
  const candidate = input.value.trim();
  if (!candidate) {
    $("gate-err").textContent = "Enter the code first.";
    input.focus();
    return;
  }
  const go = $("pin-go");
  go.disabled = true;
  go.innerHTML = `${uiIcon("loader-circle", "ico-spin")}Checking…`;
  const ok = await verifyPinValue(candidate);
  go.disabled = false;
  go.innerHTML = `${uiIcon("log-in")}Open drop`;
  if (!ok) {
    input.select();
    $("gate").classList.remove("shake");
    void $("gate").offsetWidth;
    $("gate").classList.add("shake");
    return;
  }
  st.pin = candidate;
  sessionStorage.setItem(`lhdb_pin_${slug}`, st.pin);
  showMain();
}

export async function verifyPinValue(candidate) {
  const err = $("gate-err");
  if (err) err.textContent = "";
  let r;
  try {
    r = await fetch("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: slug, pin: candidate }),
    });
  } catch {
    if (err) err.textContent = "You're offline. Check the connection and try again.";
    return false;
  }
  if (r.ok) return true;
  const d = await r.json().catch(() => ({}));
  if (!err) return false;
  if (r.status === 429) {
    startCountdown(err, Number(d.retryAfter || r.headers.get("retry-after") || 60));
  } else if (r.status === 410) {
    showGone("expired", "This drop has closed.", "Ask the collector for a new link.");
  } else if (r.status === 403 && /paused/i.test(d.error || "")) {
    showGone("paused", "This link is paused right now.", "Ask the collector to reopen it or try again later.", { icon: "pause" });
  } else {
    err.textContent = r.status === 403 ? "That code didn't match. Check with the collector and try again." : d.error || "Couldn't check the code. Try again.";
  }
  return false;
}

export function showMain() {
  $("gate").classList.add("hidden");
  $("main").classList.remove("hidden");
  setConnection("secure");
  document.body.dataset.phase = "ready";
  syncNameStep();
  $("label").textContent = st.link.label;
  $("collector-name").textContent = st.link.ownerName ? `${st.link.ownerName} is collecting` : "Your files are being collected";
  $("welcome").textContent = st.link.theme?.welcome || "Send original photos and videos here.";

  // One quiet line of facts instead of a row of chips competing with the title.
  const facts = [
    st.link.requiresPin ? "password protected" : "private link",
    st.link.requiresAuth && st.link.viewer ? `signed in as ${st.link.viewer.name || st.link.viewer.email}` : "",
    `files up to ${fmtBytes(st.link.settings?.maxTransferBytes || 5 * 1024 ** 4)}`,
    st.link.settings?.perUploaderFolders ? "your own subfolder" : "",
  ];
  if (st.link.driveFreeGB != null && st.link.driveFreeGB < 100) facts.push(`~${st.link.driveFreeGB} GB free in Drive`);
  if (st.link.expiresAt) {
    const d = Math.max(0, Math.ceil((st.link.expiresAt - Date.now()) / 86400000));
    facts.push(d === 0 ? "closes today" : `closes in ${d} day${d === 1 ? "" : "s"}`);
  }
  $("meta").textContent = facts.filter(Boolean).join("  ·  ");

  setupPromo();
  maybeShowResumeBanner();
  $("who").value = localStorage.getItem("lhdb_name") || "";
  syncNameStep();
  const zone = $("zone");
  const picker = $("picker");
  zone.addEventListener("click", (e) => {
    if (e.target.closest("button")) return;
    if (pickerGate()) picker.click();
  });
  $("pick-files").addEventListener("click", () => pickerGate() && picker.click());
  $("add-more-files").addEventListener("click", () => pickerGate() && picker.click());
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
  // The admin already chose the folder layout when per-uploader folders are
  // on, so the uploader gets no folder picker (and dropped trees flatten).
  const keepTree = !st.link.settings?.perUploaderFolders;
  if (keepTree && folderBtn && folderPicker && "webkitdirectory" in folderPicker && !/android|iphone|ipad|ipod/i.test(navigator.userAgent)) {
    folderBtn.classList.remove("hidden");
    $("add-more-folder").classList.remove("hidden");
    for (const button of [folderBtn, $("add-more-folder")]) {
      button.addEventListener("click", (e) => {
        e.stopPropagation();
        if (pickerGate()) folderPicker.click();
      });
    }
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

  $("who").addEventListener("input", syncNameStep);
  window.addEventListener("offline", () => setNetworkPaused(true));
  window.addEventListener("online", () => setNetworkPaused(false));
  $("retry-all").addEventListener("click", retryAll);
  $("cancel-all").addEventListener("click", cancelAll);
  $("pause-all").addEventListener("click", toggleQueuePause);
  $("show-all-files").addEventListener("click", () => {
    st.showAllFiles = !st.showAllFiles;
    schedulePaint();
  });
  $("add-more").addEventListener("click", () => {
    $("done-card").classList.add("hidden");
    if (pickerGate()) $("picker").click();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && st.active > 0) acquireWakeLock();
  });
  window.addEventListener("beforeunload", (e) => {
    if (st.active > 0 || totals.queued > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
}

function setupPromo() {
  const t = st.link.theme || {};
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

export function pickerGate() {
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

export function addFiles(files) {
  crumb(`addFiles: ${(files || []).length} file(s)`);
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
      chunk: st.chunkSize,
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
  // Upload in the order a person would expect - folder by folder, files in
  // natural name order - so Drive fills up predictably and IMG_2 never lands
  // before IMG_1. Only files still waiting move; active ones keep their slot.
  const waiting = queue.filter((q) => q.state === "queued");
  waiting.sort((a, b) => (a.relativePath || a.file.name).localeCompare(b.relativePath || b.file.name, undefined, { numeric: true, sensitivity: "base" }));
  let w = 0;
  for (let i = 0; i < queue.length; i++) if (queue[i].state === "queued") queue[i] = waiting[w++];
  st.lastQueueNotice = "";
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

init();
