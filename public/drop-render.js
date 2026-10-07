import {
  $,
  ATTENTION_STATES,
  MAX_ACTIVE,
  doneRecent,
  queue,
  st,
  totals,
} from "./drop-state.js";
import { pump } from "./drop-queue.js";
import { sendLive } from "./drop-live.js";
import { h, icon, toast } from "./drop-utils.js";
import { renderBench } from "./drop-bench.js";
import { pendingShots, setDrive } from "./drop-court.js";
import { sampleEta, smoothEta } from "./drop-eta.js";

// Rendering. Every fact has one home: the scoreboard owns the totals, the
// bench owns the files uploading right now, the log lists files by status.
const DRIVE_OPENS_AT = 3; // makes before the Drive box rises to collect them
const SEGMENTS = 48; // one chart segment per file up to this many, then a stacked bar

export function schedulePaint() {
  if (st.paintScheduled) return;
  st.paintScheduled = true;
  requestAnimationFrame(flush);
}

export function flush() {
  st.paintScheduled = false;
  updateSpeed();
  renderVisible();
  renderSummary();
  sendLive(false);
}

export function updateSpeed() {
  const now = Date.now();
  if (!st.speedAt) {
    st.speedAt = now;
    st.speedSent = totals.sent;
    return;
  }
  const dt = (now - st.speedAt) / 1000;
  if (dt < 1) return;
  const inst = Math.max(0, (totals.sent - st.speedSent) / dt);
  st.speedBps = st.speedBps ? st.speedBps * 0.6 + inst * 0.4 : inst;
  if (st.active > 0) {
    st.speedHist.push(st.speedBps);
    if (st.speedHist.length > 24) st.speedHist.shift();
  }
  if (st.adaptiveController) {
    const nextLimit = st.adaptiveController.observe({
      bps: st.speedBps,
      errors: st.adaptiveErrors,
      saturated: st.active > 0 && queue.some((item) => item.state === "queued"),
    });
    st.adaptiveErrors = 0;
    if (nextLimit !== st.concurrency) {
      st.concurrency = nextLimit;
      pump();
    }
  }
  const est = sampleEta(st.etaWin, { t: now, sent: totals.sent, files: totals.done + totals.warning }, { bytes: totals.bytes - totals.sent, files: totals.queued + totals.checking + totals.uploading });
  st.eta = smoothEta(st.eta, est, dt);
  st.etaAt = now;
  st.speedAt = now;
  st.speedSent = totals.sent;
}

// The log: one chip per status with its count (a chip only shows once it has
// files), and the files with that status, newest first. Until the sender
// picks one it shows what most needs a look. Files on the bench are not
// listed; the bench already shows them.
const LOG_VIEWS = [
  { key: "failed", label: "failed", count: () => totals.error + totals.canceled + totals.warning, has: (it) => it.state === "error" || it.state === "canceled" || it.state === "warning" },
  { key: "skipped", label: "skipped", count: () => totals.skipped, has: (it) => it.state === "skipped" },
  { key: "drive", label: "in Drive", count: () => totals.done, has: (it) => it.state === "done" },
  { key: "waiting", label: "waiting", count: () => totals.queued + totals.checking, has: (it) => it.state === "queued" || it.state === "checking", oldestFirst: true },
  { key: "all", label: "all", count: () => totals.count, has: () => true, oldestFirst: true },
];
const LOG_ROWS = 150; // a list longer than this is a scroll no one reads

function logView() {
  const picked = LOG_VIEWS.find((v) => v.key === st.logFilter && v.count() > 0);
  return picked || LOG_VIEWS.slice(0, 3).find((v) => v.count() > 0) || null;
}

export function visibleItems(view = logView()) {
  if (!view) return [];
  const out = [];
  if (view.oldestFirst) {
    for (const it of queue) if (view.has(it) && out.push(it) >= LOG_ROWS) break;
  } else {
    for (let i = queue.length - 1; i >= 0; i--) if (view.has(queue[i]) && out.push(queue[i]) >= LOG_ROWS) break;
  }
  return out;
}

export function renderVisible() {
  renderBench(Math.min(st.concurrency, MAX_ACTIVE));
  const view = logView();
  $("log").classList.toggle("hidden", !view);
  if (!view) return;
  renderLogFilters(view);
  const vis = visibleItems(view);
  reconcile($("list"), vis, (item) => item, makeRow, updateRow);
  const total = view.count();
  const more = $("log-more");
  more.classList.toggle("hidden", total <= vis.length);
  more.textContent = `${view.oldestFirst ? "first" : "latest"} ${vis.length} of ${total}`;
}

function renderLogFilters(view) {
  const host = $("log-filters");
  if (!host.children.length) {
    for (const v of LOG_VIEWS) host.append(h("button", { class: `log-chip chip-${v.key}`, type: "button", "data-filter": v.key }, h("i", { "aria-hidden": "true" }), h("span", {}, v.label), h("b", {})));
  }
  LOG_VIEWS.forEach((v, i) => {
    const chip = host.children[i];
    const n = v.count();
    chip.hidden = n === 0;
    chip.lastChild.textContent = String(n);
    chip.classList.toggle("on", v === view);
    chip.setAttribute("aria-pressed", String(v === view));
  });
}

export function makeRow(item) {
  const row = h(
    "div",
    { class: "file-row" },
    h("i", { class: "file-dot", "aria-hidden": "true" }),
    h("div", { class: "file-name", title: item.relativePath || item.file.name }, item.relativePath || item.file.name),
    h("div", { class: "file-stat" }),
    h("div", { class: "file-actions" }, h("button", { class: "row-btn", "data-act": "retry", type: "button" }, "retry"), h("button", { class: "row-btn danger", "data-act": "cancel", type: "button" }, "cancel")),
  );
  row._item = item;
  row._stat = row.querySelector(".file-stat");
  row._retry = row.querySelector("[data-act='retry']");
  row._cancel = row.querySelector("[data-act='cancel']");
  return row;
}

export function updateRow(el, item) {
  el._stat.textContent = rowStat(item);
  el._stat.className = `file-stat ${statClass(item.state)}`;
  el._stat.title = item.state === "error" && item.errorDetail ? `${item.errorCode || "E_UNKNOWN"} · ${item.errorDetail}` : "";
  el.className = `file-row ${item.state}`;
  const canRetry = ATTENTION_STATES.has(item.state);
  const canCancel = item.state === "queued" || item.state === "uploading";
  el._retry.textContent = item.state === "skipped" ? "upload anyway" : "retry";
  el._retry.classList.toggle("hidden", !canRetry);
  el._cancel.classList.toggle("hidden", !canCancel);
  el.classList.toggle("has-actions", canRetry || canCancel);
}

export function rowStat(item) {
  if (item.state === "done") return `${fmtBytes(item.file.size)} · in Drive`;
  if (item.stat) return item.stat;
  if (item.state === "checking") return "checking";
  if (item.state === "skipped") return "already in Drive, skipped";
  if (item.state === "error" && item.errorCode) return `${item.errorCode} · failed`;
  if (item.state === "uploading") return `${fmtBytes(item.sent)} / ${fmtBytes(item.file.size)}`;
  if (item.state === "warning") return "Drive saved - log delayed";
  if (item.state === "canceled") return "canceled";
  return item.state;
}

export function statClass(state) {
  if (state === "done") return "ok";
  if (state === "error" || state === "canceled") return "err";
  if (state === "warning" || state === "skipped") return "warn";
  return "";
}

export function renderSummary() {
  // Skipped files (already in Drive) never send bytes: count them as landed,
  // not as missing progress.
  const landed = totals.done + totals.warning + totals.skipped;
  const inFlight = totals.queued + totals.checking + totals.uploading;
  const settled = totals.count > 0 && !inFlight;
  const completed = settled && landed === totals.count;
  const phase = phaseOf(completed);
  document.body.dataset.phase = phase;
  if (completed && !st.finishedAt) st.finishedAt = Date.now();
  if (!completed) st.finishedAt = 0;

  $("bench").classList.toggle("hidden", !inFlight);
  $("pause-all").classList.toggle("hidden", !inFlight);
  $("cancel-all").classList.toggle("hidden", !(totals.queued + totals.uploading));
  const failed = totals.error + totals.warning + totals.canceled;
  $("retry-all").classList.toggle("hidden", failed === 0);
  $("retry-all").replaceChildren(icon("refresh-cw"), `Retry ${failed} failed`);

  renderScoreboard(phase, landed);
  // The Drive box rises once a few have gone through the hoop (or the batch
  // is done); the court then empties the floor into it.
  const made = totals.done + totals.warning - pendingShots();
  if (made >= DRIVE_OPENS_AT || (completed && made > 0)) openDriveBox();

  $("done-card").classList.toggle("hidden", !completed);
  if (completed) {
    const owner = st.link.ownerName;
    $("done-title").textContent = owner ? `In ${owner}'s Drive` : "In the collector's Drive";
    const videos = doneRecent.some((it) => /^video\//.test(it.file.type || ""));
    $("done-recap").textContent = `${videos ? "Videos get a streaming copy overnight so they play instantly when shared. " : ""}You can close this page now.`;
  }
  maybeQueueNotice();
}

function phaseOf(completed) {
  if (!totals.count) return "ready";
  if (completed) return "done";
  if (st.networkPaused) return "offline";
  if (!$("budget-notice").classList.contains("hidden")) return "budget";
  if (st.queuePaused) return "paused";
  return totals.error ? "attention" : "uploading";
}

const TAGS = { ready: "ready", uploading: "live", attention: "live", paused: "paused", offline: "offline", budget: "budget", done: "final" };

function renderScoreboard(phase, landed) {
  const sb = $("scoreboard");
  sb.classList.toggle("idle", !totals.count);
  if (!totals.count) return;
  sb.dataset.phase = phase;
  $("sb-tag").textContent = TAGS[phase] || "live";

  // MADE counts files Drive confirmed, minus cards still in the air: it ticks
  // when the file lands in the tray, not when it is thrown.
  tickMade(sb, Math.max(0, totals.done + totals.warning - pendingShots()));
  $("sb-of").textContent = `/${totals.count}`;
  const pct = totals.bytes ? Math.min(100, Math.floor((totals.sent / totals.bytes) * 100)) : 0;
  $("sb-sent").textContent = fmtBytes(totals.sent);
  $("sb-sent-sub").textContent = `of ${fmtBytes(totals.bytes)} · ${phase === "done" ? 100 : pct}%`;

  renderClock(phase, landed);
  renderChart($("sb-chart"));
  const hist = st.speedHist;
  const max = Math.max(1, ...hist);
  $("sb-spark").setAttribute("points", hist.map((v, i) => `${(i * 72) / 23},${(19 - (v / max) * 17).toFixed(1)}`).join(" "));
  $("sb-speed").textContent = st.active && st.speedBps ? `${fmtBytes(st.speedBps)}/s` : "";
  $("sb-lanes").textContent = phase === "done" ? `${totals.done} delivered` : `${Math.min(st.concurrency, MAX_ACTIVE)}/${MAX_ACTIVE} lanes`;
}

// MADE counts toward its target instead of jumping: one at a time for a few
// files, in strides for a burst, so a thousand screenshots landing together
// read as a fast count, not a flicker. The pulse is rationed to one per
// 450 ms however many land.
let madeShown = 0;
let madeTarget = 0;
let madeRaf = 0;
let lastPulse = 0;

function tickMade(sb, made) {
  madeTarget = made;
  if (made < madeShown) madeShown = made; // a new, smaller batch
  if (!madeRaf && madeShown !== madeTarget) madeRaf = requestAnimationFrame(() => stepMade(sb));
}

function stepMade(sb) {
  madeRaf = 0;
  const gap = madeTarget - madeShown;
  if (gap <= 0) return;
  madeShown += Math.max(1, Math.ceil(gap / 10));
  const el = $("sb-made");
  el.textContent = String(madeShown);
  const now = performance.now();
  if (now - lastPulse > 450) {
    lastPulse = now;
    for (const node of [el, sb]) {
      node.classList.remove("tick");
      void node.offsetWidth;
      node.classList.add("tick");
    }
  }
  if (madeShown < madeTarget) madeRaf = requestAnimationFrame(() => stepMade(sb));
}

function openDriveBox() {
  const tray = $("tray");
  if (tray.classList.contains("open")) return;
  tray.classList.add("open");
  setDrive(true);
}

// The Drive box's arrivals: the latest few by name, newest first, with
// "+N more" for what a burst carried in beyond them.
const ARRIVALS = 3;
let arrivedExtra = 0;

export function trayArrivals(metas, extra = 0) {
  const list = $("tray-arrivals");
  arrivedExtra += extra;
  for (const m of metas) {
    const li = h("li", { class: `fam-${m.family || "file"}` }, h("b", {}, (m.ext || "file").toUpperCase().slice(0, 4)), h("span", {}, m.name || ""));
    li.title = m.name || "";
    list.prepend(li);
  }
  const rows = [...list.querySelectorAll("li:not(.more)")];
  for (const li of rows.slice(ARRIVALS)) {
    li.remove();
    arrivedExtra++;
  }
  let more = list.querySelector(".more");
  if (arrivedExtra) {
    if (!more) more = list.appendChild(h("li", { class: "more" }));
    more.textContent = `+${arrivedExtra} more`;
    list.append(more);
  }
}

// CLOCK: time left and the time it will be done; total time once FINAL.
function renderClock(phase, landed) {
  const clock = $("sb-clock");
  const sub = $("sb-clock-sub");
  if (phase === "done") {
    clock.textContent = st.startedAt ? clockText((st.finishedAt - st.startedAt) / 1000) : "0:00";
    sub.textContent = "total time";
  } else if (phase === "paused" || phase === "offline" || phase === "budget") {
    clock.textContent = "--:--";
    sub.textContent = phase === "offline" ? "waiting for the connection" : "paused";
  } else if (st.eta != null && totals.bytes > totals.sent) {
    const eta = Math.max(0, st.eta - (Date.now() - st.etaAt) / 1000);
    clock.textContent = clockText(eta);
    sub.textContent = `in by ${new Date(Date.now() + eta * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } else {
    clock.textContent = "--:--";
    sub.textContent = landed === totals.count ? "finishing" : "estimating";
  }
}

const clockText = (sec) => {
  const s = Math.max(0, Math.round(sec));
  const pad = (n) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
};

function segKind(it) {
  if (it.state === "done" || it.state === "warning") return "made";
  if (it.state === "uploading") return it.stat === "verifying" ? "verify" : "fly";
  if (it.state === "skipped") return "skip";
  if (it.state === "error" || it.state === "canceled") return "miss";
  return "q";
}

// One segment per file (the shot chart); past SEGMENTS files it becomes one
// stacked bar, because 300 two-pixel segments read as noise.
function renderChart(el) {
  const n = queue.length;
  const stacked = n > SEGMENTS;
  el.classList.toggle("stacked", stacked);
  const want = stacked ? 5 : n;
  while (el.children.length < want) el.appendChild(document.createElement("i"));
  while (el.children.length > want) el.lastChild.remove();
  if (stacked) {
    const counts = { made: 0, fly: 0, verify: 0, skip: 0, miss: 0, q: 0 };
    for (const it of queue) counts[segKind(it)]++;
    counts.fly += counts.verify;
    ["made", "fly", "skip", "miss", "q"].forEach((k, i) => {
      const c = el.children[i];
      c.className = k;
      c.style.flexGrow = String(counts[k]);
    });
    return;
  }
  queue.forEach((it, i) => {
    const c = el.children[i];
    const k = segKind(it);
    if (c.className !== k) c.className = k;
    if (k === "fly") c.style.setProperty("--p", `${it.file.size ? Math.min(100, (it.sent / it.file.size) * 100) : 0}%`);
  });
}

// The row shows what the uploader can act on, never a stack-trace fragment;
// the raw message still goes to the admin via reportError().
// Short codes for the error taxonomy (upload spec §1.4); the plain line
// comes from humanError(), the raw message sits in the row's title.
export function errorCode(err) {
  const status = Number(err?.status) || 0;
  const message = String(err?.message || "");
  if (/stalled/i.test(message)) return "E_STALL";
  if (/timeout/i.test(message)) return "E_TIMEOUT";
  if (!navigator.onLine || /network|offline|failed to fetch|probe/i.test(message)) return "E_NET";
  if (status === 401) return "E_AUTH";
  if (status === 403) return "E_CLOSED";
  if (status === 410) return "E_EXPIRED";
  if (status === 413) return "E_BUDGET";
  if (status === 507) return "E_QUOTA";
  if (status === 400 || status === 404 || /dead|unsupported|corrupt/i.test(message)) return "E_REJECTED";
  if (status >= 500 || /is not defined|TypeError|internal error|KV/i.test(message)) return "E_SERVER";
  return "E_UNKNOWN";
}

export function humanError(err) {
  const status = Number(err?.status) || 0;
  const message = String(err?.message || "");
  if (!navigator.onLine || /network|offline|failed to fetch|probe/i.test(message)) return "Connection dropped - tap retry";
  if (status === 401) return "Sign-in expired - reload the page";
  if (status === 403) return "This link no longer accepts uploads";
  if (status === 410) return "This link has closed";
  if (status === 413) return "Upload budget reached";
  if (status === 507) return "The collector's Drive is full";
  if (status >= 500 || /is not defined|TypeError|internal error|KV/i.test(message)) return "Server hiccup - tap retry";
  if (/too large/i.test(message)) return "File too large for this link";
  return message && message.length < 60 && !/[{}<>]/.test(message) ? message : "Couldn't upload - tap retry";
}

export function maybeQueueNotice() {
  const stateKey = `${totals.done}:${totals.error}:${totals.warning}:${totals.canceled}:${totals.skipped}:${totals.checking}:${totals.count}:${st.active}`;
  if (totals.checking) return;
  if (!totals.count || st.active !== 0 || stateKey === st.lastQueueNotice) return;
  st.lastQueueNotice = stateKey;
  if (totals.error || totals.canceled) {
    const need = totals.error + totals.canceled;
    toast(`${need} file${need === 1 ? "" : "s"} need attention`, "Tap a row's retry button to resend it.", "err");
  } else if (totals.warning) {
    toast("Upload needs verification", "Drive received the files; tap retry to finish the dashboard log.", "warn");
  } else if (totals.done === totals.count) {
    toast("Upload complete", `${totals.done} file${totals.done === 1 ? "" : "s"} saved to Drive.`, "ok");
  }
}
