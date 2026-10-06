import {
  $,
  ATTENTION_STATES,
  MAX_ACTIVE,
  attention,
  doneRecent,
  queue,
  st,
  totals,
} from "./drop-state.js";
import { pump } from "./drop-queue.js";
import { sendLive } from "./drop-live.js";
import { h, icon, toast } from "./drop-utils.js";
import { renderBench } from "./drop-bench.js";
import { pendingShots } from "./drop-court.js";

// Rendering. Every fact has one home: the scoreboard owns the totals, the
// bench owns the files uploading right now, the log owns what needs a look
// (failed, skipped) and what already landed.
const LOG_DONE = 6; // finished rows shown before "Show all"
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
  st.speedAt = now;
  st.speedSent = totals.sent;
}

// The log: what needs a look first, then what landed, newest first. Files on
// the bench are not repeated here; "Show all" lists everything in queue order.
export function visibleItems() {
  if (st.showAllFiles) return queue;
  const att = attention.length > 50 ? attention.slice(-50) : attention;
  return [...att, ...doneRecent.slice(-LOG_DONE).reverse()];
}

export function renderVisible() {
  renderBench(Math.min(st.concurrency, MAX_ACTIVE));
  const vis = visibleItems();
  reconcile($("list"), vis, (item) => item, makeRow, updateRow);
  $("log").classList.toggle("hidden", !vis.length);
  const hidden = totals.count - vis.length;
  const showButton = $("show-all-files");
  showButton.classList.toggle("hidden", hidden <= 0 && !st.showAllFiles);
  showButton.textContent = st.showAllFiles ? "Show what needs a look" : `Show all ${totals.count} files`;
}

export function makeRow(item) {
  const row = h(
    "div",
    { class: "file-row" },
    h("i", { class: "file-dot", "aria-hidden": "true" }),
    h("div", { class: "file-name" }, item.relativePath || item.file.name),
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
  $("sb-speed").textContent = st.active && st.speedBps ? `${fmtBytes(st.speedBps)}/s` : phase === "done" ? `${totals.done} delivered` : "";
  $("sb-lanes").textContent = `${Math.min(st.concurrency, MAX_ACTIVE)} of ${MAX_ACTIVE} lanes`;
}

function tickMade(sb, made) {
  const el = $("sb-made");
  if (el.textContent === String(made)) return;
  const up = made > Number(el.textContent || 0);
  el.textContent = String(made);
  if (!up) return;
  for (const node of [el, sb]) {
    node.classList.remove("tick");
    void node.offsetWidth;
    node.classList.add("tick");
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
  } else if (st.speedBps > 0 && totals.bytes > totals.sent) {
    const eta = (totals.bytes - totals.sent) / st.speedBps;
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
