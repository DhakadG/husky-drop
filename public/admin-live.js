import { $, icon, liveActive, liveRecent } from "./admin-state.js";
import { setEmpty, upsertCards } from "./admin.js";

// Live tab: active upload sessions, finished-this-hour list, metrics.
export function renderLive() {
  const uploading = liveActive.filter((session) => session.state === "uploading");
  // Disconnected (stale) and failed sessions stay listed until the tracker
  // prunes them into "Finished this hour" as stopped; the badge and metrics
  // count only live transfers.
  const listed = liveActive.filter((session) => session.state !== "done");
  renderMetrics(uploading);
  const badge = $("live-badge");
  if (badge) {
    badge.textContent = uploading.length;
    badge.classList.toggle("hidden", uploading.length === 0);
  }
  const box = $("live-list");
  if (box) reconcile(box, listed, (session) => session.id, makeLiveRow, updateLiveRow);
  $("live-empty")?.classList.toggle("hidden", listed.length !== 0);
  const last = liveRecent.find((session) => !session.stopped);
  if ($("live-last-completed")) $("live-last-completed").innerHTML = last ? `<span class="muted">Last completed: <b>${esc(last.uploader || "anonymous")}</b> → ${esc(last.label || last.slug)} · ${last.files || 0} files · ${fmtBytes(last.bytes || 0)} · ${new Date(last.endedAt).toLocaleTimeString()}</span>` : "";
  const finished = $("live-finished-list");
  if (finished) reconcile(finished, liveRecent, (session) => session.id, makeFinishedLiveRow, updateFinishedLiveRow);
  $("live-finished-section")?.classList.toggle("hidden", liveRecent.length === 0);

  const mini = $("live-mini");
  if (mini) {
    const top = uploading.slice(0, 3);
    reconcile(mini, top, (session) => `m:${session.id}`, makeMiniLiveRow, updateMiniLiveRow);
    setEmpty(mini, top.length === 0, "No active uploads right now.");
  }
}

function makeFinishedLiveRow() {
  const row = document.createElement("div");
  row.className = "finished-live-row";
  return row;
}

function updateFinishedLiveRow(row, session) {
  row.innerHTML = `<span class="avatar">${esc(initialsOf(session.uploader || "anonymous"))}</span><span><b>${esc(session.uploader || "anonymous")} → ${esc(session.label || session.slug)}</b><small>${session.stopped ? `stopped · ${session.files || 0} of ${session.count || "?"} files` : `${session.files || 0} files`} · ${fmtBytes(session.bytes || 0)} · ${fmtTime(session.duration || 0)}</small></span><time>${new Date(session.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>`;
}

export function renderMetrics(sessions) {
  const element = $("live-metrics");
  if (!element) return;
  const throughput = sessions.reduce((sum, session) => sum + (session.speed || 0), 0);
  const remaining = sessions.reduce((sum, session) => sum + Math.max(0, (session.count || 0) - (session.done || 0)), 0);
  upsertCards(element, [["Active sessions", sessions.length], ["Combined throughput", throughput ? `${fmtBytes(throughput)}/s` : "—"], ["Files remaining", remaining]], "live-metric");
  for (const [, card] of element._rows) card.classList.toggle("hot", sessions.length > 0);
}

export function initialsOf(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

export function makeMiniLiveRow() {
  const el = document.createElement("div");
  el.className = "live-mini-row glass-tile";
  return el;
}

export function updateMiniLiveRow(el, s) {
  el.classList.toggle("hot", s.state === "uploading");
  el.innerHTML = `
    <div class="live-mini-head">
      <span class="avatar">${esc(initialsOf(s.uploader))}</span>
      <div class="live-mini-copy">
        <div class="live-mini-title">${esc(s.uploader || "anonymous")} — uploading to <a href="#" data-open-detail="${escAttr(s.slug)}">${esc(s.label || s.slug)}</a></div>
        <div class="live-mini-meta">${s.done || 0} of ${s.count || 0} files${s.speed ? ` · ${fmtBytes(s.speed)}/s` : ""}${s.eta ? ` · ~${fmtTime(s.eta)} left` : ""}${s.paused ? " · paused" : ""}</div>
      </div>
      <span class="live-mini-pct">${s.pct || 0}%</span>
    </div>
    <div class="bar slim"><i style="width:${s.pct || 0}%"></i></div>`;
}
export function makeLiveRow() {
  const el = document.createElement("article");
  el.className = "live-row";
  return el;
}

export function updateLiveRow(el, s) {
  el.className = `live-row ${escAttr(s.state || "uploading")}`;
  el.innerHTML = liveRowInner(s);
}

function liveRowInner(session) {
  const inFlight = session.files || [];
  const files = inFlight.map((file) => {
    const state = liveFileState(file);
    const pct = file.size ? Math.min(100, Math.round((Number(file.sent || 0) / Number(file.size || 0)) * 100)) : 0;
    return `<div class="file-row ${escAttr(state)}"><div class="file-top"><div class="file-name">${esc(file.name || "file")}</div><div class="file-stat ${escAttr(liveFileStatClass(state))}">${fmtBytes(file.sent || 0)} / ${fmtBytes(file.size || 0)}</div></div><div class="trail"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
  const more = session.count > session.done + inFlight.length ? `<div class="list-note">${session.count - session.done - inFlight.length} more queued</div>` : "";
  return `<div class="live-card-head"><div class="live-ring"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" fill="none" stroke="rgba(12,26,43,.08)" stroke-width="4"></circle><circle cx="22" cy="22" r="18" fill="none" stroke="#2f6bff" stroke-width="4" stroke-linecap="round" stroke-dasharray="113.1" stroke-dashoffset="${113.1 * (1 - (session.pct || 0) / 100)}"></circle></svg><b>${session.pct || 0}%</b></div><span class="avatar">${esc(initialsOf(session.uploader || "anonymous"))}</span><div class="live-card-copy"><h2>${esc(session.uploader || "anonymous")} → <button data-open-detail="${escAttr(session.slug)}" type="button">${esc(session.label || session.slug)}</button></h2><p>${session.done || 0} of ${session.count || 0} files · ${fmtBytes(session.sent || 0)} of ${fmtBytes(session.total || 0)}${session.speed ? ` · ${fmtBytes(session.speed)}/s` : ""}${session.eta ? ` · ~${fmtTime(session.eta)} left` : ""}${session.paused ? " · paused" : ""}</p></div><span class="state-pill">${session.state === "stale" ? "disconnected" : session.state === "error" ? "error" : session.paused ? "paused" : "uploading"}</span></div><div class="live-spark"><span>Last 60 seconds</span>${speedSparkline(session.speedHist || [])}</div><div class="filelist live-queue">${files}${more}</div><div class="row-actions"><button class="mini" data-open-detail="${escAttr(session.slug)}" type="button">${icon("list")}detail</button><button class="mini" data-open-folder="${escAttr(session.slug)}" type="button">${icon("folder")}Drive folder</button><button class="mini danger" data-close-session="${escAttr(session.id)}" data-close-slug="${escAttr(session.slug)}" type="button">dismiss</button></div>`;
}

export function speedSparkline(samples) {
  if (!samples.length) return '<div class="spark-empty">Waiting for speed samples…</div>';
  const width = 320;
  const height = 54;
  const max = Math.max(...samples.map((sample) => Number(sample.bps) || 0), 1);
  const points = samples.map((sample, index) => `${(index / Math.max(1, samples.length - 1)) * width},${height - ((Number(sample.bps) || 0) / max) * (height - 4)}`).join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Transfer speed over the last 60 seconds"><defs><linearGradient id="sparkStroke" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f6bff"></stop><stop offset="1" stop-color="#15c0c9"></stop></linearGradient></defs><polyline points="${points}" fill="none" stroke="url(#sparkStroke)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`;
}

function liveFileState(f) {
  const state = String(f.state || "uploading");
  if (state === "done" || state === "error" || state === "warning" || state === "canceled") return state;
  return Number(f.sent || 0) >= Number(f.size || 1) ? "done" : "uploading";
}

function liveFileStatClass(state) {
  if (state === "done") return "ok";
  if (state === "error" || state === "canceled") return "err";
  if (state === "warning") return "warn";
  return "";
}
