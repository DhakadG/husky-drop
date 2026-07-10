const $ = (id) => document.getElementById(id);

let overview = null;
let liveActive = [];
let liveRecent = [];
let liveSocket = null;
let liveReconnectDelay = 1000;
let currentDetailSlug = "";
let seriesMetric = "bytes";
let seriesRows = [];
let detailData = null;
let detailSearch = "";
let detailSort = "new";
let detailShowAll = false;
const openSettings = new Set();
let activityFilter = "all";
let activityQuery = "";
let activityOlder = [];
let activityOldestDay = new Date().toISOString().slice(0, 10);
let activityLoading = false;
const openActivitySessions = new Set();

init();

async function init() {
  handleAdminSigninError();
  $("admin-google")?.addEventListener("click", () => {
    location.href = "/api/admin/auth/login";
  });
  $("tok-go").addEventListener("click", tryToken);
  $("tok").addEventListener("keydown", (e) => e.key === "Enter" && tryToken());
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });
  $("tok-eye")?.addEventListener("click", () => {
    const tok = $("tok");
    tok.type = tok.type === "password" ? "text" : "password";
  });
  $("refresh").addEventListener("click", refreshAll);
  $("live-refresh")?.addEventListener("click", refreshAll);
  $("drop-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    createLink();
  });
  $("create-next")?.addEventListener("click", () => showCreateStep(2));
  $("create-back")?.addEventListener("click", () => showCreateStep(1));
  $("folder-browse")?.addEventListener("click", () => openFolderPicker(folderParentId || "root"));
  $("folder-up")?.addEventListener("click", openParentFolder);
  $("folder-select-current")?.addEventListener("click", () => selectDriveFolder(folderParentId, folderParentLabel));
  $("f-folder")?.addEventListener("input", handleFolderInput);
  $("expired-links-toggle")?.addEventListener("click", toggleExpiredLinks);
  document.querySelectorAll('[name="transfer-preset"]').forEach((radio) => radio.addEventListener("change", applyTransferPreset));
  $("create-copy")?.addEventListener("click", () => copyCreatedLink());
  $("create-qr")?.addEventListener("click", () => showQr($("create-success-url").textContent, "New drop link"));
  $("create-another")?.addEventListener("click", resetCreateFlow);
  $("share-create")?.addEventListener("click", createShare);
  document.querySelectorAll('[name="share-mode-choice"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      $("s-mode").value = radio.value;
      const gallery = radio.value === "gallery";
      $("s-pin").disabled = !gallery;
      $("s-auth").disabled = !gallery;
      $("s-zip").disabled = !gallery;
    });
  });
  $("logout")?.addEventListener("click", logout);
  document.addEventListener("click", handleAdminAction);
  document.querySelectorAll("[data-metric]").forEach((b) => {
    b.addEventListener("click", () => {
      seriesMetric = b.dataset.metric;
      document.querySelectorAll("[data-metric]").forEach((x) => x.classList.toggle("active", x === b));
      renderChart();
    });
  });
  // A previous session cookie may still be valid.
  document.querySelectorAll("[data-activity-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      activityFilter = button.dataset.activityFilter || "all";
      document.querySelectorAll("[data-activity-filter]").forEach((item) => item.classList.toggle("active", item === button));
      renderEvents();
    });
  });
  $("activity-query")?.addEventListener("input", (event) => {
    activityQuery = event.target.value;
    renderEvents();
  });
  $("activity-more")?.addEventListener("click", loadEarlierActivity);
  if (await ping()) unlock();
}

function handleAdminSigninError() {
  const msg = new URLSearchParams(location.search).get("adminSigninError");
  if (!msg) return;
  if ($("tok-err")) $("tok-err").textContent = msg;
  history.replaceState(null, "", location.pathname);
}

async function ping() {
  try {
    const r = await fetch("/api/admin/overview");
    return r.ok;
  } catch {
    return false;
  }
}

async function tryToken() {
  $("tok-err").textContent = "";
  const r = await fetch("/api/admin/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: $("tok").value.trim() }),
  });
  if (r.ok) {
    $("tok").value = "";
    unlock();
    return;
  }
  const d = await r.json().catch(() => ({}));
  $("tok-err").textContent = r.status === 429 ? `Too many attempts. Wait ${d.retryAfter || 60}s.` : d.error || "Wrong token.";
}

async function logout() {
  await fetch("/api/admin/logout", { method: "POST" }).catch(() => {});
  location.reload();
}

function unlock() {
  $("auth").classList.add("hidden");
  $("panel").classList.remove("hidden");
  connectLive();
  refreshAll();
  refreshChart();
  setInterval(refreshAll, 15000);
  setInterval(tickLive, 1000);
  setInterval(refreshChart, 5 * 60000);
}

function tickLive() {
  renderLive();
  if (currentDetailSlug) renderDetailLive(currentDetailSlug);
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
  $(`tab-${name}`).classList.remove("hidden");
}

async function refreshAll() {
  try {
    const r = await fetch("/api/admin/overview");
    if (r.status === 401) {
      $("panel").classList.add("hidden");
      $("auth").classList.remove("hidden");
      return;
    }
    if (!r.ok) return;
    overview = await r.json();
    liveActive = overview.active || [];
    renderStats();
    renderLive();
    renderEvents();
    renderLinks(overview.links || []);
    renderShares(overview.shares || []);
    if (currentDetailSlug) renderDetailLive(currentDetailSlug);
  } catch {}
}

async function refreshChart() {
  try {
    const r = await fetch("/api/admin/timeseries?days=30");
    if (!r.ok) return;
    const d = await r.json();
    seriesRows = d.rows || [];
    renderChart();
  } catch {}
}

function connectLive() {
  if (liveSocket && liveSocket.readyState <= 1) return;
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    // Auth rides on the HttpOnly session cookie - no token in the URL.
    liveSocket = new WebSocket(`${protocol}//${location.host}/api/admin/live`);
    liveSocket.onopen = () => {
      liveReconnectDelay = 1000;
      $("live-state").textContent = "live";
    };
    liveSocket.onclose = () => {
      $("live-state").textContent = "offline";
      setTimeout(connectLive, liveReconnectDelay);
      liveReconnectDelay = Math.min(15000, liveReconnectDelay * 2);
    };
    liveSocket.onerror = () => {
      try {
        liveSocket.close();
      } catch {}
    };
    liveSocket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "snapshot") {
        liveActive = msg.active || [];
        liveRecent = msg.recent || [];
        renderLive();
        if (currentDetailSlug) renderDetailLive(currentDetailSlug);
      }
    };
  } catch {
    $("live-state").textContent = "offline";
  }
}

// reconcile() lives in public.js (shared with drop.js/share.js).

function setEmpty(container, isEmpty, text) {
  if (isEmpty) {
    if (!container._empty) {
      container._empty = document.createElement("div");
      container._empty.className = "empty";
    }
    container._empty.textContent = text;
    container.appendChild(container._empty);
  } else if (container._empty) {
    container._empty.remove();
  }
}

function upsertCards(container, pairs, cls) {
  reconcile(
    container,
    pairs,
    ([label]) => label,
    () => {
      const el = document.createElement("div");
      el.className = cls;
      el.innerHTML = `<span></span><b></b>`;
      el._label = el.querySelector("span");
      el._value = el.querySelector("b");
      return el;
    },
    (el, [label, value]) => {
      if (el._label.textContent !== label) el._label.textContent = label;
      const text = String(value);
      if (el._value.textContent !== text) el._value.textContent = text;
    },
  );
}

const STAT_ICONS = {
  links: ['rgba(47,107,255,0.12)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#2f6bff"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l2.8-2.8a3 3 0 0 1 4.2 4.2l-2 2a1 1 0 1 1-1.4-1.4l2-2a1 1 0 0 0-1.4-1.4l-2.8 2.8a1 1 0 0 1-1.4 0z"></path><path d="M13.4 10.6a1 1 0 0 1 0 1.4l-2.8 2.8a3 3 0 0 1-4.2-4.2l2-2a1 1 0 0 1 1.4 1.4l-2 2a1 1 0 1 0 1.4 1.4l2.8-2.8a1 1 0 0 1 1.4 0z" opacity="0.55"></path></svg>'],
  opens: ['rgba(21,192,201,0.14)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#0e9aa7"><path d="M12 5c5 0 8.6 3.6 10 7-1.4 3.4-5 7-10 7S3.4 15.4 2 12c1.4-3.4 5-7 10-7z" opacity="0.2"></path><path d="M12 7c3.9 0 6.8 2.6 8 5-1.2 2.4-4.1 5-8 5s-6.8-2.6-8-5c1.2-2.4 4.1-5 8-5zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"></path></svg>'],
  sessions: ['rgba(123,107,255,0.14)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#7b6bff"><circle cx="9" cy="8" r="3.4"></circle><path d="M9 13c3.6 0 6.5 1.9 6.5 4.2V19H2.5v-1.8C2.5 14.9 5.4 13 9 13z" opacity="0.55"></path><circle cx="17" cy="9" r="2.6" opacity="0.55"></circle><path d="M17 13.2c2.6 0 4.5 1.4 4.5 3.1V18h-4"></path></svg>'],
  files: ['rgba(47,107,255,0.12)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#2f6bff"><path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" opacity="0.2"></path><path d="M6.5 4h7l4.5 4.5V20h-11.5V4zM13 5.5V9h3.5L13 5.5z"></path></svg>'],
  received: ['', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#ffffff"><path d="M12 3a1 1 0 0 1 1 1v9.6l2.8-2.8a1 1 0 0 1 1.4 1.4l-4.5 4.5a1 1 0 0 1-1.4 0L6.8 12.2a1 1 0 1 1 1.4-1.4L11 13.6V4a1 1 0 0 1 1-1z"></path><path d="M4 17a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1a1 1 0 0 1 1-1z" opacity="0.7"></path></svg>'],
  "drive free": ['rgba(31,178,122,0.14)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#1fb27a"><ellipse cx="12" cy="6" rx="8" ry="3" opacity="0.55"></ellipse><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0 1.7-3.6 3-8 3S4 7.7 4 6zm16 6c0 1.7-3.6 3-8 3s-8-1.3-8-3"></path></svg>'],
};

function renderStats() {
  const t = overview?.totals || {};
  const q = overview?.quota;
  const cards = [
    ["links", t.links || 0],
    ["opens", t.opens || 0],
    ["sessions", t.sessions || 0],
    ["files", (t.files || 0).toLocaleString()],
    ["received", fmtBytes(t.bytes || 0)],
  ];
  if (q && q.free != null) cards.push(["drive free", fmtBytes(q.free)]);
  reconcile(
    $("stats"),
    cards,
    ([label]) => label,
    ([label]) => {
      const el = document.createElement("div");
      el.className = `stat-card v3${label === "received" ? " accent" : ""}`;
      const [tint, svg] = STAT_ICONS[label] || STAT_ICONS.links;
      el.innerHTML = `<span class="stat-ico"${tint ? ` style="background:${tint}"` : ""}>${svg}</span><div><b></b><span class="stat-label"></span></div>`;
      el._value = el.querySelector("b");
      el._label = el.querySelector(".stat-label");
      return el;
    },
    (el, [label, value]) => {
      if (el._label.textContent !== label) el._label.textContent = label;
      const text = String(value);
      if (el._value.textContent !== text) el._value.textContent = text;
    },
  );
}

// ---- 30-day activity chart (inline SVG, no dependencies) ----

function renderChart() {
  const host = $("chart");
  if (!host) return;
  // Zero-fill every one of the last 30 days: quiet days render as empty
  // slots instead of the chart silently collapsing to active days only.
  const byDay = new Map(seriesRows.map((r) => [r.day, r]));
  const points = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const row = byDay.get(day) || {};
    points.push({ day, v: Number(row[seriesMetric]) || 0 });
  }
  const total = points.reduce((t, p) => t + p.v, 0);
  const w = 900;
  const h = 150;
  const pad = 2;
  const max = Math.max(...points.map((p) => p.v), 1);
  const step = (w - pad * 2) / points.length;
  const bw = Math.max(4, step - 3);
  let bars = "";
  const maxV = Math.max(...points.map((p) => p.v));
  points.forEach((p, i) => {
    const x = pad + i * step;
    const bh = Math.max(p.v > 0 ? 3 : 1.5, ((h - 6) * p.v) / max);
    const label = seriesMetric === "bytes" ? fmtBytes(p.v) : p.v;
    const cls = !p.v ? "zero" : p.v === maxV ? "peak" : "";
    bars += `<rect class="${cls}" x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${esc(p.day)}: ${esc(String(label))}</title></rect>`;
  });
  const totalLabel = seriesMetric === "bytes" ? fmtBytes(total) : total;
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a), points[0]);
  const peakLabel = seriesMetric === "bytes" ? fmtBytes(peak.v) : peak.v;
  const busiest = total && peak.v ? ` · busiest day ${peak.day.slice(5)} (${peakLabel})` : "";
  const note = total ? `${totalLabel} ${seriesMetric} in the last 30 days${busiest}` : `No ${seriesMetric} in the last 30 days yet - the chart fills in as activity happens.`;
  const labels = [points[0], points[10], points[20], points[29]].map((p) => `<span>${esc(p.day.slice(5))}</span>`).join("");
  host.innerHTML = `
    <div class="chart-note muted">${esc(note)}</div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="30 day ${escAttr(seriesMetric)}">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7aa4ff"/><stop offset="1" stop-color="#2f6bff"/></linearGradient>
        <linearGradient id="barGradPeak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6bff"/><stop offset="1" stop-color="#15c0c9"/></linearGradient>
      </defs>${bars}</svg>
    <div class="chart-labels">${labels}</div>`;
}

function renderLive() {
  const uploading = liveActive.filter((session) => session.state === "uploading");
  renderMetrics(uploading);
  const badge = $("live-badge");
  if (badge) {
    badge.textContent = uploading.length;
    badge.classList.toggle("hidden", uploading.length === 0);
  }
  const box = $("live-list");
  if (box) reconcile(box, uploading, (session) => session.id, makeLiveRow, updateLiveRow);
  $("live-empty")?.classList.toggle("hidden", uploading.length !== 0);
  const last = liveRecent[0];
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
  row.innerHTML = `<span class="avatar">${esc(initialsOf(session.uploader || "anonymous"))}</span><span><b>${esc(session.uploader || "anonymous")} → ${esc(session.label || session.slug)}</b><small>${session.files || 0} files · ${fmtBytes(session.bytes || 0)} · ${fmtTime(session.duration || 0)}</small></span><time>${new Date(session.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>`;
}

function renderMetrics(sessions) {
  const element = $("live-metrics");
  if (!element) return;
  const throughput = sessions.reduce((sum, session) => sum + (session.speed || 0), 0);
  upsertCards(element, [["Active sessions", sessions.length], ["Combined throughput", throughput ? `${fmtBytes(throughput)}/s` : "—"], ["Drive write rate", throughput ? `${fmtBytes(throughput)}/s` : "—"]], "live-metric");
  for (const [, card] of element._rows) card.classList.toggle("hot", sessions.length > 0);
}

function initialsOf(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function makeMiniLiveRow() {
  const el = document.createElement("div");
  el.className = "live-mini-row glass-tile";
  return el;
}

function updateMiniLiveRow(el, s) {
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
function makeLiveRow() {
  const el = document.createElement("article");
  el.className = "live-row";
  return el;
}

function updateLiveRow(el, s) {
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
  return `<div class="live-card-head"><div class="live-ring"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" fill="none" stroke="rgba(12,26,43,.08)" stroke-width="4"></circle><circle cx="22" cy="22" r="18" fill="none" stroke="#2f6bff" stroke-width="4" stroke-linecap="round" stroke-dasharray="113.1" stroke-dashoffset="${113.1 * (1 - (session.pct || 0) / 100)}"></circle></svg><b>${session.pct || 0}%</b></div><span class="avatar">${esc(initialsOf(session.uploader || "anonymous"))}</span><div class="live-card-copy"><h2>${esc(session.uploader || "anonymous")} → <button data-open-detail="${escAttr(session.slug)}" type="button">${esc(session.label || session.slug)}</button></h2><p>${session.done || 0} of ${session.count || 0} files · ${fmtBytes(session.sent || 0)} of ${fmtBytes(session.total || 0)}${session.speed ? ` · ${fmtBytes(session.speed)}/s` : ""}${session.eta ? ` · ~${fmtTime(session.eta)} left` : ""}${session.paused ? " · paused" : ""}</p></div><span class="state-pill">${session.paused ? "paused" : "uploading"}</span></div><div class="live-spark"><span>Last 60 seconds</span>${speedSparkline(session.speedHist || [])}</div><div class="filelist live-queue">${files}${more}</div><div class="row-actions"><button class="mini" data-open-detail="${escAttr(session.slug)}" type="button">${icon("list")}detail</button><button class="mini" data-open-folder="${escAttr(session.slug)}" type="button">${icon("folder")}Drive folder</button><button class="mini danger" data-close-session="${escAttr(session.id)}" data-close-slug="${escAttr(session.slug)}" type="button">dismiss</button></div>`;
}

function speedSparkline(samples) {
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

function handleAdminAction(e) {
  const close = e.target.closest("[data-close-session]");
  if (close) return closeLiveSession(close.dataset.closeSession, close.dataset.closeSlug);
  const detail = e.target.closest("[data-open-detail]");
  if (detail) return refreshDetail(detail.dataset.openDetail, true);
  const folder = e.target.closest("[data-open-folder]");
  if (folder) return openDriveFolder(folder.dataset.openFolder);
  const copy = e.target.closest("[data-copy-link]");
  if (copy) {
    navigator.clipboard?.writeText(`${location.origin}${copy.dataset.copyLink}`).catch(() => {});
    flash(copy, "copied");
    return;
  }
  const qr = e.target.closest("[data-qr-link]");
  if (qr) return showQr(`${location.origin}${qr.dataset.qrLink}`, qr.dataset.qrLabel || "");
  const shareBtn = e.target.closest("[data-share-link]");
  if (shareBtn) {
    const url = `${location.origin}${shareBtn.dataset.shareLink}`;
    if (navigator.share) navigator.share({ url }).catch(() => {});
    else {
      navigator.clipboard?.writeText(url).catch(() => {});
      flash(shareBtn, "copied");
    }
    return;
  }
  const pause = e.target.closest("[data-pause-link]");
  if (pause) return toggleLinkPause(pause.dataset.pauseLink, pause.dataset.paused === "1");
  const del = e.target.closest("[data-del-link]");
  if (del) return deleteLink(del.dataset.delLink, del.dataset.delLabel);
  const spause = e.target.closest("[data-pause-share]");
  if (spause) return toggleSharePause(spause.dataset.pauseShare, spause.dataset.paused === "1");
  const sauth = e.target.closest("[data-toggle-share-auth]");
  if (sauth) return toggleShareAuth(sauth.dataset.toggleShareAuth, sauth.dataset.auth === "1");
  const sdel = e.target.closest("[data-del-share]");
  if (sdel) return deleteShare(sdel.dataset.delShare, sdel.dataset.delLabel);
  const refresh = e.target.closest("[data-refresh-detail]");
  if (refresh) return refreshDetail(refresh.dataset.refreshDetail, false);
  const sync = e.target.closest("[data-sync-detail]");
  const shareActivity = e.target.closest("[data-view-share-activity]");
  if (shareActivity) {
    activityFilter = "all";
    activityQuery = shareActivity.dataset.viewShareActivity;
    if ($("activity-query")) $("activity-query").value = activityQuery;
    document.querySelectorAll("[data-activity-filter]").forEach((button) => button.classList.toggle("active", button.dataset.activityFilter === "all"));
    renderEvents();
    return showTab("activity");
  }
  if (sync) return refreshDetail(sync.dataset.syncDetail, false, true);
  const goto = e.target.closest("[data-goto-tab]");
  if (goto) return showTab(goto.dataset.gotoTab);
  const prev = e.target.closest("[data-preview]");
  if (prev) return previewFile(prev.dataset.preview, prev);
  const qrClose = e.target.closest("#qr-modal");
  if (qrClose && e.target.id === "qr-modal") $("qr-modal").classList.add("hidden");
}

function showQr(url, label) {
  const modal = $("qr-modal");
  if (!modal || typeof qrcode === "undefined") {
    navigator.clipboard?.writeText(url).catch(() => {});
    return;
  }
  try {
    const q = qrcode(0, "M");
    q.addData(url);
    q.make();
    $("qr-box").innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    $("qr-caption").textContent = label ? `${label} - ${url}` : url;
    modal.classList.remove("hidden");
  } catch {
    navigator.clipboard?.writeText(url).catch(() => {});
  }
}

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function openDriveFolder(slug) {
  const link = overview?.links?.find((l) => l.slug === slug);
  if (link?.folderId) {
    window.open(`https://drive.google.com/drive/folders/${encodeURIComponent(link.folderId)}`, "_blank");
  } else {
    refreshDetail(slug, true);
  }
}

async function closeLiveSession(id, slug) {
  if (!id && !slug) return;
  await fetch("/api/admin/live/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, slug }),
  });
  liveActive = liveActive.filter((s) => s.id !== id);
  renderLive();
  if (currentDetailSlug) renderDetailLive(currentDetailSlug);
  refreshAll();
}

function renderEvents() {
  const fresh = overview?.events || [];
  const all = [...fresh, ...activityOlder].sort((a, b) => (b.at || 0) - (a.at || 0));
  const filtered = all.filter(activityMatches);
  const days = groupActivityDays(filtered);
  const box = $("events");
  if (box) {
    reconcile(box, days, (day) => day.key, makeActivityDay, updateActivityDay);
    setEmpty(box, days.length === 0, activityQuery || activityFilter !== "all" ? "No activity matches these filters." : "No activity yet.");
  }

  const mini = $("events-mini");
  if (mini) {
    const top = fresh.slice(0, 5);
    reconcile(mini, top, (event) => `mini:${eventKey(event)}`, makeCompactEventRow, updateCompactEventRow);
    setEmpty(mini, top.length === 0, "No activity yet.");
  }
}

function activityMatches(event) {
  const type = event.t || "";
  const groups = {
    uploads: ["open", "start", "file", "sessionclose", "autopause"],
    opens: ["open", "share-open"],
    views: ["share-view", "share-browse"],
    downloads: ["share-dl"],
    errors: ["clienterror", "autopause", "lock", "global-lock"],
  };
  if (activityFilter !== "all" && !(groups[activityFilter] || []).includes(type)) return false;
  const query = activityQuery.trim().toLowerCase();
  if (!query) return true;
  return [event.u, event.l, event.s, event.f, event.m, event.c?.o, event.c?.l].some((value) => String(value || "").toLowerCase().includes(query));
}

function groupActivityDays(events) {
  const days = new Map();
  for (const event of events) {
    const dayKey = new Date(event.at || Date.now()).toISOString().slice(0, 10);
    if (!days.has(dayKey)) days.set(dayKey, []);
    days.get(dayKey).push(event);
  }
  return [...days.entries()].map(([key, dayEvents]) => ({ key, sessions: groupActivitySessions(dayEvents) }));
}

function groupActivitySessions(events) {
  const sessions = new Map();
  for (const event of events) {
    const tenMinuteWindow = Math.floor((event.at || 0) / 600000);
    const key = event.si || `${event.u || "anonymous"}:${event.s || event.l || "system"}:${tenMinuteWindow}`;
    if (!sessions.has(key)) sessions.set(key, { key, events: [] });
    sessions.get(key).events.push(event);
  }
  return [...sessions.values()]
    .map((session) => ({ ...session, events: session.events.sort((a, b) => (a.at || 0) - (b.at || 0)) }))
    .sort((a, b) => (b.events.at(-1)?.at || 0) - (a.events.at(-1)?.at || 0));
}

function makeActivityDay() {
  const section = document.createElement("section");
  section.className = "activity-day";
  section.innerHTML = `<div class="activity-day-head"><span></span><b></b></div><div class="activity-session-list"></div>`;
  section._label = section.querySelector(".activity-day-head span");
  section._count = section.querySelector(".activity-day-head b");
  section._list = section.querySelector(".activity-session-list");
  return section;
}

function updateActivityDay(section, day) {
  const date = new Date(`${day.key}T00:00:00`);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const prefix = day.key === today ? "Today" : day.key === yesterday ? "Yesterday" : date.toLocaleDateString(undefined, { weekday: "long" });
  section._label.textContent = `${prefix} · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  section._count.textContent = `${day.sessions.length} session${day.sessions.length === 1 ? "" : "s"}`;
  reconcile(section._list, day.sessions, (session) => session.key, makeActivitySession, updateActivitySession);
}

function makeActivitySession() {
  const article = document.createElement("article");
  article.className = "activity-session glass-tile";
  return article;
}

function updateActivitySession(article, session) {
  const events = session.events;
  const first = events[0] || {};
  const last = events.at(-1) || first;
  const actor = last.u || first.u || "anonymous";
  const place = last.l || last.s || first.l || first.s || "system";
  const context = last.c || first.c || {};
  const fileCount = new Set(events.map((event) => event.f).filter(Boolean)).size;
  const hasError = events.some((event) => ["clienterror", "autopause", "lock", "global-lock"].includes(event.t));
  const expanded = openActivitySessions.has(session.key);
  const counts = activityCounts(events);
  article.className = `activity-session glass-tile${expanded ? " expanded" : ""}${hasError ? " has-error" : ""}`;
  article.innerHTML = `
    <button class="activity-session-summary" type="button" aria-expanded="${expanded}">
      <span class="avatar">${esc(initialsOf(actor))}</span>
      <span class="activity-person"><b>${esc(actor)} <i>·</i> ${esc(place)}</b><small>${esc(context.o || "Unknown device")}${context.l ? ` · ${esc(context.l)}` : ""} · ${activityTimeRange(first.at, last.at)}</small></span>
      <span class="activity-counts">${counts}${fileCount ? `<em>${fileCount} file${fileCount === 1 ? "" : "s"}</em>` : ""}</span>
      ${icon("chevron", "activity-chevron")}
    </button>
    <div class="activity-timeline">${events.map(activityTimelineRow).join("")}</div>`;
  article.querySelector(".activity-session-summary").onclick = () => {
    if (openActivitySessions.has(session.key)) openActivitySessions.delete(session.key);
    else openActivitySessions.add(session.key);
    updateActivitySession(article, session);
  };
}

function activityCounts(events) {
  const labels = [];
  const uploads = events.filter((event) => event.t === "file").length;
  const opens = events.filter((event) => event.t === "open" || event.t === "share-open").length;
  const views = events.filter((event) => event.t === "share-view" || event.t === "share-browse").length;
  const downloads = events.filter((event) => event.t === "share-dl").length;
  if (uploads) labels.push(`<em>${uploads} upload${uploads === 1 ? "" : "s"}</em>`);
  if (opens) labels.push(`<em>${opens} open${opens === 1 ? "" : "s"}</em>`);
  if (views) labels.push(`<em>${views} view${views === 1 ? "" : "s"}</em>`);
  if (downloads) labels.push(`<em>${downloads} download${downloads === 1 ? "" : "s"}</em>`);
  return labels.join("");
}

function activityTimelineRow(event) {
  const label = event.f || event.m || activityTypeLabel(event.t);
  const meta = [event.t, event.s ? `/d/${event.s}` : "", event.m === "first open" ? "first open of this share" : ""].filter(Boolean).join(" · ");
  return `<div class="activity-timeline-row ${escAttr(event.t || "event")}"><span class="activity-type-icon">${icon(eventTypeIcon(event.t))}</span><span><b>${esc(label)}</b><small>${esc(meta)}</small></span><time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>`;
}

function activityTypeLabel(type) {
  const labels = { open: "Opened drop link", start: "Started upload", file: "Uploaded file", sessionclose: "Session finished", "share-open": "Opened share", "share-view": "Viewed file", "share-browse": "Browsed gallery", "share-dl": "Downloaded file", clienterror: "Client error", autopause: "Link auto-paused", lock: "Link locked", "global-lock": "Uploads locked" };
  return labels[type] || "Activity";
}

function activityTimeRange(firstAt, lastAt) {
  const first = new Date(firstAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const last = new Date(lastAt || firstAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return first === last ? first : `${first}–${last}`;
}

function makeCompactEventRow() {
  const row = document.createElement("div");
  row.className = "event-mini-row";
  return row;
}

function updateCompactEventRow(row, event) {
  const actor = event.u || "anonymous";
  row.innerHTML = `<span class="activity-type-icon">${icon(eventTypeIcon(event.t))}</span><span><b>${esc(actor)}</b><small>${esc(activityTypeLabel(event.t))}${event.l || event.s ? ` · ${esc(event.l || event.s)}` : ""}</small></span><time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>`;
}

function eventKey(event) {
  return `${event.at}:${event.t}:${event.s}:${event.u}:${event.f}`;
}

function eventTypeIcon(type) {
  if (type === "start") return "play";
  if (type === "file" || type === "share-view" || type === "share-browse") return "image";
  if (type === "open" || type === "share-open") return "eye";
  if (type === "share-dl") return "download";
  if (type === "lock" || type === "global-lock" || type === "autopause") return "lock";
  if (type === "sessionclose" || type === "clienterror") return "alert";
  return "list";
}
async function loadEarlierActivity() {
  if (activityLoading) return;
  activityLoading = true;
  $("activity-more").disabled = true;
  $("activity-more").textContent = "Loading…";
  $("activity-err").textContent = "";
  try {
    const response = await fetch(`/api/admin/events?before=${encodeURIComponent(activityOldestDay)}&days=3`);
    const data = await response.json().catch(() => ({ days: [] }));
    if (!response.ok) throw new Error(data.error || "Could not load earlier activity.");
    const incoming = (data.days || []).flatMap((day) => day.events || []);
    const known = new Set(activityOlder.map(eventKey));
    for (const event of incoming) if (!known.has(eventKey(event))) activityOlder.push(event);
    activityOldestDay = data.oldest || activityOldestDay;
    renderEvents();
  } catch (error) {
    $("activity-err").textContent = error.message;
  } finally {
    activityLoading = false;
    $("activity-more").disabled = false;
    $("activity-more").textContent = "Load earlier days";
  }
}

// ---- Drop links table ----

function renderLinks(links) {
  const active = links.filter((link) => link.state !== "expired");
  const expired = links.filter((link) => link.state === "expired");
  reconcile($("rows"), active, (link) => link.slug, makeLinkCard, updateLinkCard);
  reconcile($("expired-rows"), expired, (link) => link.slug, makeLinkCard, updateLinkCard);
  setEmpty($("rows"), active.length === 0, "No active drop links yet.");
  $("expired-links-section").classList.toggle("hidden", expired.length === 0);
  $("expired-links-count").textContent = expired.length;
}

function makeLinkCard() {
  const article = document.createElement("article");
  article.className = "link-card panel";
  return article;
}

function updateLinkCard(article, link) {
  const budgetLimit = link.settings.maxTotalBytes || 0;
  const budgetPct = budgetLimit ? Math.min(100, Math.round((link.stats.bytes / budgetLimit) * 100)) : 0;
  const expires = link.expiresAt ? `expires ${new Date(link.expiresAt).toLocaleDateString()}` : "never expires";
  const access = link.hasPin ? "PIN" : "open";
  article.className = `link-card panel ${escAttr(link.state || "active")}`;
  article.innerHTML = `
    <div class="link-card-head">
      <div><button class="link-card-title" data-open-detail="${escAttr(link.slug)}" type="button">${esc(link.label)}</button><div class="link-meta"><code>/d/${esc(link.slug)}</code><span>·</span><span>${esc(expires)}</span><span>·</span><span>${link.settings.adaptiveConcurrency ? `auto 2–8× parallel` : `${link.settings.concurrency}× parallel`}</span><span>·</span><span>${link.settings.chunkMB} MB chunks</span><span>·</span><span>${link.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</span></div></div>
      <span class="link-status ${escAttr(link.state || "active")}">${esc(access)}${link.state === "expired" ? " · expired" : link.disabled ? " · paused" : ""}</span>
    </div>
    <div class="link-action-row" aria-label="Actions for ${escAttr(link.label)}">
      ${linkActionButton("copy", "Copy link", `data-copy-link="/d/${escAttr(link.slug)}"`)}
      ${linkActionButton("qr", "Show QR", `data-qr-link="/d/${escAttr(link.slug)}" data-qr-label="${escAttr(link.label)}"`)}
      ${linkActionButton("folder", "Open Drive folder", `data-open-folder="${escAttr(link.slug)}"`)}
      ${linkActionButton(link.disabled ? "play" : "pause", link.disabled ? "Resume" : "Pause", `data-pause-link="${escAttr(link.slug)}" data-paused="${link.disabled ? "1" : "0"}"`)}
      ${linkActionButton("detail", "Details", `data-open-detail="${escAttr(link.slug)}"`)}
      ${linkActionButton("trash", "Delete", `data-del-link="${escAttr(link.slug)}" data-del-label="${escAttr(link.label)}"`, true)}
    </div>
    <div class="link-stat-grid">
      ${linkStat("Opens", link.stats.opens || 0)}
      ${linkStat("Sessions", link.stats.sessions || 0)}
      ${linkStat("Files", link.stats.files || 0)}
      <div class="link-stat budget ${budgetPct >= 85 ? "warn" : ""}"><span>Budget</span><b>${budgetLimit ? `${budgetPct}%` : "∞"}</b><small>${budgetLimit ? `${fmtBytes(link.stats.bytes)} of ${fmtBytes(budgetLimit)}` : `${fmtBytes(link.stats.bytes)} received`}</small>${budgetLimit ? `<div class="trail"><i style="width:${budgetPct}%"></i></div>` : ""}</div>
    </div>`;
}

function linkStat(label, value) {
  return `<div class="link-stat"><span>${esc(label)}</span><b>${esc(String(value))}</b></div>`;
}

function linkActionButton(name, label, attributes, danger = false) {
  return `<button class="link-action${danger ? " danger" : ""}" ${attributes} type="button">${icon(name)}<span>${esc(label)}</span></button>`;
}

let folderParentId = "root";
let folderParentLabel = "My Drive";
let folderBreadcrumbs = [{ id: "root", name: "My Drive" }];
let selectedFolderName = "";

function showCreateStep(step) {
  if (step === 2 && !value("f-label")) {
    $("f-label").reportValidity();
    return;
  }
  $("create-step-1").classList.toggle("hidden", step !== 1);
  $("create-step-2").classList.toggle("hidden", step !== 2);
  document.querySelectorAll("[data-create-indicator]").forEach((indicator) => indicator.classList.toggle("active", Number(indicator.dataset.createIndicator) === step));
}

function applyTransferPreset(event) {
  const values = {
    auto: [4, 32, true],
    steady: [2, 16, false],
    balanced: [4, 32, false],
    fast: [6, 32, false],
    maximum: [8, 64, false],
  };
  const [concurrency, chunkMB, adaptive] = values[event.target.value] || values.auto;
  $("f-conc").value = concurrency;
  $("f-chunk").value = chunkMB;
  $("f-adaptive").value = adaptive ? "1" : "0";
}

function toggleExpiredLinks() {
  const button = $("expired-links-toggle");
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  $("expired-rows").classList.toggle("expanded", !expanded);
}

async function openFolderPicker(parentId) {
  folderParentId = parentId || "root";
  $("folder-picker-panel").classList.remove("hidden");
  $("folder-list").innerHTML = '<div class="empty">Loading Drive folders…</div>';
  $("folder-err").textContent = "";
  try {
    const response = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(folderParentId)}`);
    const data = await response.json().catch(() => ({ folders: [] }));
    if (!response.ok) throw new Error(data.error || "Drive folder list failed.");
    folderBreadcrumbs = data.breadcrumbs?.length ? data.breadcrumbs : [{ id: "root", name: "My Drive" }];
    const current = folderBreadcrumbs.at(-1);
    folderParentId = current?.id || folderParentId;
    folderParentLabel = current?.name || "My Drive";
    renderFolderBreadcrumbs();
    $("folder-up").disabled = folderBreadcrumbs.length <= 1;
    $("folder-list").innerHTML = (data.folders || []).length
      ? data.folders.map((folder) => `<div class="folder-option"><button class="folder-open" type="button" data-open-folder-picker="${escAttr(folder.id)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path></svg><span>${esc(folder.name)}</span><span class="folder-open-cue">Open →</span></button><button class="mini folder-pick" type="button" data-pick-folder="${escAttr(folder.id)}" data-folder-name="${escAttr(folder.name)}">Select</button></div>`).join("")
      : '<div class="empty">No child folders here.</div>';
    $("folder-list").querySelectorAll("[data-pick-folder]").forEach((button) => button.addEventListener("click", () => {
      selectDriveFolder(button.dataset.pickFolder, button.dataset.folderName);
    }));
    $("folder-list").querySelectorAll("[data-open-folder-picker]").forEach((button) => button.addEventListener("click", () => openFolderPicker(button.dataset.openFolderPicker)));
  } catch (error) {
    $("folder-list").innerHTML = "";
    $("folder-err").textContent = error.message;
  }
}

function renderFolderBreadcrumbs() {
  $("folder-breadcrumbs").innerHTML = folderBreadcrumbs.map((crumb, index) => {
    const current = index === folderBreadcrumbs.length - 1;
    return `${index ? '<span aria-hidden="true">/</span>' : ""}<button type="button" data-folder-crumb="${escAttr(crumb.id)}" ${current ? 'aria-current="page" disabled' : ""}>${esc(crumb.name)}</button>`;
  }).join("");
  $("folder-breadcrumbs").querySelectorAll("[data-folder-crumb]:not([disabled])").forEach((button) => button.addEventListener("click", () => openFolderPicker(button.dataset.folderCrumb)));
}

function openParentFolder() {
  if (folderBreadcrumbs.length <= 1) return;
  openFolderPicker(folderBreadcrumbs.at(-2).id);
}

function selectDriveFolder(id, name) {
  $("f-folder").value = id || "root";
  selectedFolderName = name || "My Drive";
  if (folderBreadcrumbs.at(-1)?.id !== (id || "root")) {
    folderBreadcrumbs = [...folderBreadcrumbs, { id: id || "root", name: selectedFolderName }];
  }
  folderParentId = id || "root";
  folderParentLabel = selectedFolderName;
  $("folder-selection").textContent = `Selected destination: ${selectedFolderName}`;
  $("folder-selection").classList.add("selected");
  $("folder-picker-panel").classList.add("hidden");
  updateCreateButtonLabel();
}

function handleFolderInput() {
  selectedFolderName = "";
  const hasFolder = !!value("f-folder");
  $("folder-selection").textContent = hasFolder ? "Using the Drive folder ID entered above." : "No folder selected — a new Drive folder will be created.";
  $("folder-selection").classList.toggle("selected", hasFolder);
  updateCreateButtonLabel();
}

function updateCreateButtonLabel() {
  const button = $("create");
  if (!button) return;
  if (selectedFolderName) button.textContent = `Create in ${selectedFolderName.length > 28 ? `${selectedFolderName.slice(0, 27)}…` : selectedFolderName}`;
  else button.textContent = value("f-folder") ? "Create in selected folder" : "Create and make Drive folder";
}

function copyCreatedLink() {
  const url = $("create-success-url").textContent;
  navigator.clipboard?.writeText(url).catch(() => {});
}

function resetCreateFlow() {
  $("drop-create-form").reset();
  $("f-conc").value = "4";
  $("f-chunk").value = "32";
  $("f-adaptive").value = "1";
  selectedFolderName = "";
  handleFolderInput();
  $("f-accent").value = "#2f6bff";
  $("f-bgcolor").value = "#eaf0f9";
  $("create-success").classList.add("hidden");
  $("drop-create-form").classList.remove("hidden");
  showCreateStep(1);
  $("f-label").focus();
}
async function toggleLinkPause(slug, isPaused) {
  await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disabled: !isPaused }),
  });
  refreshAll();
}

async function deleteLink(slug, label) {
  if (!confirm(`Delete "${label}"? Drive files stay put.`)) return;
  await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, { method: "DELETE" });
  if (currentDetailSlug === slug) {
    currentDetailSlug = "";
    $("detail-tab").classList.add("hidden");
    showTab("links");
  }
  refreshAll();
}

async function createLink() {
  $("create-err").textContent = "";
  if (!value("f-label")) {
    $("f-label").reportValidity();
    return;
  }
  document.querySelectorAll('#drop-create-form button[type="submit"]').forEach((button) => (button.disabled = true));
  const gb = Number(value("f-budget-gb")) || 0;
  const body = {
    label: value("f-label"),
    slug: value("f-slug"),
    pin: value("f-pin"),
    expiresDays: Number(value("f-days")) || 0,
    folderId: value("f-folder"),
    settings: {
      concurrency: Number(value("f-conc")) || 4,
      chunkMB: Number(value("f-chunk")) || 32,
      adaptiveConcurrency: value("f-adaptive") === "1",
      perUploaderFolders: $("f-folders").checked,
      maxTotalBytes: gb > 0 ? Math.round(gb * 1024 ** 3) : 0,
      maxTotalFiles: Number(value("f-budget-files")) || 0,
      maxSessions: Number(value("f-budget-sessions")) || 0,
    },
    notify: { enabled: $("f-notify").checked, start: $("f-notify-start").checked, complete: $("f-notify-complete").checked },
    theme: {
      logoUrl: value("f-logo"), backgroundUrl: value("f-bg"), accentColor: value("f-accent"), backgroundColor: value("f-bgcolor"), welcome: value("f-welcome"), promoTitle: value("f-promo-title"), promoText: value("f-promo-text"), videoUrl: value("f-video"), ctaLabel: value("f-cta-label"), ctaUrl: value("f-cta-url"),
    },
  };
  try {
    const response = await fetch("/api/admin/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not create link.");
    const url = `${location.origin}/d/${data.slug}`;
    $("create-success-url").textContent = url;
    $("drop-create-form").classList.add("hidden");
    $("create-success").classList.remove("hidden");
    navigator.clipboard?.writeText(url).catch(() => {});
    refreshAll();
  } catch (error) {
    $("create-err").textContent = error.message;
  } finally {
    document.querySelectorAll('#drop-create-form button[type="submit"]').forEach((button) => (button.disabled = false));
  }
}

// ---- Share links ----

function renderShares(shares) {
  const box = $("share-rows");
  if (!box) return;
  reconcile(box, shares, (share) => share.slug, makeShareCard, updateShareCard);
  setEmpty(box, shares.length === 0, "No share links yet.");
}

function makeShareCard() {
  const article = document.createElement("article");
  article.className = "share-card panel";
  return article;
}

function updateShareCard(article, share) {
  const closes = share.expiresAt ? `closes ${new Date(share.expiresAt).toLocaleDateString()}` : "never closes";
  const access = [share.mode, share.hasPin ? "PIN" : "no PIN", share.requireAuth ? "Google sign-in" : "link access"].join(" · ");
  const viewers = (share.recentViewers || []).map((viewer) => `<span class="viewer-chip" title="${escAttr(viewer.email)}"><i>${esc(initialsOf(viewer.name || viewer.email))}</i><span>${esc(viewer.name || viewer.email)}</span></span>`).join("");
  article.className = `share-card panel ${escAttr(share.state || "active")}`;
  article.innerHTML = `
    <div class="share-card-head"><div><h2>${esc(share.label)}</h2><div class="share-mode-line"><span class="share-mode-pill">${share.mode === "gallery" ? icon("lock-small") : icon("redirect")}${esc(access)}</span><code>/s/${esc(share.slug)}</code></div><p>${esc((share.folderNames || []).join(" · ") || `${share.folderIds.length} Drive folder${share.folderIds.length === 1 ? "" : "s"}`)} · ${esc(closes)}</p></div><span class="link-status ${escAttr(share.state || "active")}">${esc(share.state || "active")}</span></div>
    <div class="link-action-row">
      ${shareActionButton("copy-compact", "Copy", `data-copy-link="/s/${escAttr(share.slug)}"`)}
      ${shareActionButton("qr", "QR", `data-qr-link="/s/${escAttr(share.slug)}" data-qr-label="${escAttr(share.label)}"`)}
      ${shareActionButton("share", "Share", `data-share-link="/s/${escAttr(share.slug)}"`)}
      ${shareActionButton("user", share.requireAuth ? "Sign-in on" : "Sign-in off", `data-toggle-share-auth="${escAttr(share.slug)}" data-auth="${share.requireAuth ? "1" : "0"}"`)}
      ${shareActionButton(share.disabled ? "play" : "pause", share.disabled ? "Resume" : "Pause", `data-pause-share="${escAttr(share.slug)}" data-paused="${share.disabled ? "1" : "0"}"`)}
      ${shareActionButton("trash", "Delete", `data-del-share="${escAttr(share.slug)}" data-del-label="${escAttr(share.label)}"`, true)}
    </div>
    <div class="share-stat-grid"><div><span>Opens</span><b>${share.stats.opens || 0}</b></div><div><span>Unique viewers</span><b>${share.viewerCount || 0}</b></div><div><span>File views</span><b>${share.stats.views || 0}</b></div><div><span>Downloaded</span><b>${fmtBytes(share.stats.bytes || 0)}</b></div></div>
    <div class="recent-viewers"><div><span class="muted">Recent viewers</span><div class="viewer-chips">${viewers || '<span class="muted">No identified viewers yet.</span>'}</div></div><button class="mini" data-view-share-activity="${escAttr(share.slug)}" type="button">View activity →</button></div>`;
}

function shareActionButton(name, label, attributes, danger = false) {
  return `<button class="link-action${danger ? " danger" : ""}" ${attributes} type="button">${icon(name)}<span>${esc(label)}</span></button>`;
}

async function toggleShareAuth(slug, isRequired) {
  await fetch(`/api/admin/shares/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requireAuth: !isRequired }),
  });
  refreshAll();
}

async function toggleSharePause(slug, isPaused) {
  await fetch(`/api/admin/shares/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disabled: !isPaused }),
  });
  refreshAll();
}

async function deleteShare(slug, label) {
  if (!confirm(`Delete share "${label}"? Drive files stay put; public access is revoked.`)) return;
  await fetch(`/api/admin/shares/${encodeURIComponent(slug)}`, { method: "DELETE" });
  refreshAll();
}

async function createShare() {
  $("share-err").textContent = "";
  $("share-create").disabled = true;
  const body = {
    label: value("s-label"),
    slug: value("s-slug"),
    folders: value("s-folders"),
    mode: $("s-mode").value,
    pin: value("s-pin"),
    expiresDays: Number(value("s-days")) || 0,
    allowZip: $("s-zip").checked,
    requireAuth: $("s-auth") ? $("s-auth").checked : true,
  };
  const r = await fetch("/api/admin/shares", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  $("share-create").disabled = false;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return ($("share-err").textContent = d.error || "failed");
  navigator.clipboard?.writeText(`${location.origin}/s/${d.slug}`).catch(() => {});
  ["s-label", "s-slug", "s-folders", "s-pin"].forEach((id) => {
    if ($(id)) $(id).value = "";
  });
  $("s-mode").value = "gallery";
  document.querySelectorAll('[name="share-mode-choice"]').forEach((radio) => (radio.checked = radio.value === "gallery"));
  $("s-pin").disabled = false;
  $("s-auth").disabled = false;
  $("s-zip").disabled = false;
  refreshAll();
  showQr(`${location.origin}/s/${d.slug}`, "Share link created - URL copied to clipboard");
}

// ---- Link detail ----

async function refreshDetail(slug, switchTab, fresh = false) {
  currentDetailSlug = slug;
  const url = `/api/admin/link/${encodeURIComponent(slug)}${fresh ? "?fresh=1" : ""}`;
  const r = await fetch(url);
  if (!r.ok) return;
  const d = await r.json();
  renderDetail(d);
  const tab = $("detail-tab");
  tab.classList.remove("hidden");
  tab.textContent = `Detail: ${d.link.label}`;
  if (switchTab) showTab("detail");
}

function renderDetail(d) {
  detailData = d;
  const l = d.link;
  const uploads = d.uploads || [];
  const settingsOpen = openSettings.has(l.slug);
  const budgetGb = l.settings.maxTotalBytes ? (l.settings.maxTotalBytes / 1024 ** 3).toFixed(0) : "";
  const maxTransferGb = l.settings.maxTransferBytes && l.settings.maxTransferBytes < 5 * 1024 ** 4 ? (l.settings.maxTransferBytes / 1024 ** 3).toFixed(0) : "";
  const leaders = leaderboard(uploads);
  const expiryDays = l.expiresAt ? Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 86400_000)) : 0;
  $("detail-view").innerHTML = `
    <section class="detail-summary">
      <button class="detail-breadcrumb" data-goto-tab="links" type="button">Drop links <span>/</span> ${esc(l.label)}</button>
      <div class="detail-title-row">
        <div><p class="eyebrow">link detail</p><h1 class="pane-title grad-text">${esc(l.label)}</h1><div class="detail-chips"><span class="link-status ${escAttr(l.state || "active")}">${l.disabled ? "paused" : l.hasPin ? "PIN protected" : "open"}</span><code>/d/${esc(l.slug)}</code></div></div>
        <div class="link-action-row detail-actions">
          ${linkActionButton("copy-compact", "Copy", `data-copy-link="/d/${escAttr(l.slug)}"`)}
          ${linkActionButton("qr", "QR", `data-qr-link="/d/${escAttr(l.slug)}" data-qr-label="${escAttr(l.label)}"`)}
          ${linkActionButton("folder", "Drive", `data-open-folder="${escAttr(l.slug)}"`)}
          ${linkActionButton(l.disabled ? "play" : "pause", l.disabled ? "Resume" : "Pause", `data-pause-link="${escAttr(l.slug)}" data-paused="${l.disabled ? "1" : "0"}"`)}
        </div>
      </div>
      ${l.disabled && l.disabledReason ? `<div class="msg-err">Paused: ${esc(l.disabledReason)}</div>` : ""}
      <div class="stat-grid detail-stats">
        ${detailStatCard("Opens", l.stats.opens, "eye")}
        ${detailStatCard("Sessions", l.stats.sessions, "list")}
        ${detailStatCard("Files", l.stats.files, "file")}
        ${detailStatCard("Received", fmtBytes(l.stats.bytes), "download", true)}
      </div>
      ${budgetBar(l)}
      <div class="detail-two-up">
        <section class="panel detail-subpanel"><div class="section-title"><h2>Top uploaders</h2><span class="muted">recent history</span></div>${leaders || '<div class="empty">No uploads yet.</div>'}</section>
        <section class="panel detail-subpanel"><div class="section-title"><h2><span class="live-dot" aria-hidden="true"></span>Live now</h2></div><div id="detail-live" class="live-list"></div></section>
      </div>
    </section>
    <section class="panel detail-history">
      <div class="section-title">
        <div>
          <p class="eyebrow">verified files</p>
          <h2>Upload history</h2>
        </div>
        <div class="history-tools">
          <span class="muted" id="up-count"></span>
          <button class="mini" data-refresh-detail="${escAttr(l.slug)}" type="button">${icon("refresh")}refresh</button>
          <button class="mini" data-sync-detail="${escAttr(l.slug)}" type="button">${icon("folder-add")}sync from Drive</button>
        </div>
      </div>
      <div class="upload-tools">
        <label class="history-search" for="up-search">${icon("search")}<input id="up-search" type="search" placeholder="Filter by file name or uploader..." value="${escAttr(detailSearch)}" /></label>
        <select id="up-sort" class="sort-select" aria-label="sort uploads">
          <option value="new">Newest first</option>
          <option value="old">Oldest first</option>
          <option value="size">Largest first</option>
          <option value="name">Name A-Z</option>
          <option value="uploader">By uploader</option>
        </select>
      </div>
      <div class="upload-table-wrap">
        <table class="uploads">
          <thead><tr><th>File</th><th>Uploader</th><th class="num">Size</th><th class="num">Uploaded</th><th>Open</th></tr></thead>
          <tbody id="upload-rows"></tbody>
        </table>
      </div>
      <button class="mini upload-show-all hidden" id="up-show-all" type="button"></button>
    </section>
    <section class="panel settings-fold">
      <div class="section-title"><div><p class="eyebrow">configuration</p><h2>${icon("sliders")} Settings</h2></div><span class="muted">Changes apply to this link only.</span></div>
      <div class="settings-accordion">
        <details open><summary><span class="settings-summary-copy">${icon("lock", "settings-role-icon")}<span><b>Access</b><small>${l.hasPin ? "PIN protected" : "Open"} · ${l.expiresAt ? `expires ${new Date(l.expiresAt).toLocaleDateString()}` : "never expires"}</small></span></span>${icon("chevron", "settings-chevron")}</summary><div class="settings-body grid-3"><div class="field"><label>Label</label><input id="d-label" type="text" value="${escAttr(l.label)}" /></div><div class="field"><label>New password (blank keeps current)</label><input id="d-pin" type="password" autocomplete="new-password" /></div><div class="field"><label>Expires in days from now</label><input id="d-days" type="number" min="0" max="30" value="${expiryDays}" /></div></div></details>
        <details><summary><span class="settings-summary-copy">${icon("sliders", "settings-role-icon")}<span><b>Transfer</b><small>${l.settings.adaptiveConcurrency ? "auto 2–8× parallel" : `${l.settings.concurrency}× parallel`} · ${l.settings.chunkMB} MB chunks · ${l.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</small></span></span>${icon("chevron", "settings-chevron")}</summary><div class="settings-body"><div class="grid-3"><div class="field"><label>Starting parallel files</label><select id="d-conc">${opts([1, 2, 3, 4, 6, 8], l.settings.concurrency)}</select></div><div class="field"><label>Chunk size</label><select id="d-chunk">${opts([8, 16, 32, 64], l.settings.chunkMB, " MB")}</select></div><div class="field"><label>Max single file GB</label><input id="d-maxgb" type="number" min="0" value="${escAttr(maxTransferGb)}" /></div></div><div class="check-row"><label class="check"><input id="d-adaptive" type="checkbox" ${l.settings.adaptiveConcurrency ? "checked" : ""} /> Adapt parallelism to live network performance</label><label class="check"><input id="d-folders" type="checkbox" ${l.settings.perUploaderFolders ? "checked" : ""} /> Create subfolders per uploader</label></div></div></details>
        <details><summary><span class="settings-summary-copy">${icon("budget", "settings-role-icon")}<span><b>Budgets</b><small>${l.settings.maxTotalBytes ? `${fmtBytes(l.stats.bytes)} of ${fmtBytes(l.settings.maxTotalBytes)}` : "Unlimited"} · auto-pause at limit</small></span></span>${icon("chevron", "settings-chevron")}</summary><div class="settings-body grid-3"><div class="field"><label>Max total GB</label><input id="d-budget-gb" type="number" min="0" value="${escAttr(budgetGb)}" /></div><div class="field"><label>Max files</label><input id="d-budget-files" type="number" min="0" value="${l.settings.maxTotalFiles || ""}" /></div><div class="field"><label>Max sessions</label><input id="d-budget-sessions" type="number" min="0" value="${l.settings.maxSessions || ""}" /></div></div></details>
        <details><summary><span class="settings-summary-copy">${icon("bell", "settings-role-icon")}<span><b>Notifications</b><small>${l.notify.enabled ? "Email enabled" : "Email disabled"} · ${l.notify.start ? "start alerts" : "no start alerts"} · ${l.notify.complete ? "completion digest" : "no completion digest"}</small></span></span>${icon("chevron", "settings-chevron")}</summary><div class="settings-body check-row"><label class="check"><input id="d-notify" type="checkbox" ${l.notify.enabled ? "checked" : ""} /> Email enabled</label><label class="check"><input id="d-notify-start" type="checkbox" ${l.notify.start ? "checked" : ""} /> On upload start</label><label class="check"><input id="d-notify-complete" type="checkbox" ${l.notify.complete ? "checked" : ""} /> Session digest when done</label></div></details>
        <details><summary><span class="settings-summary-copy">${icon("palette", "settings-role-icon")}<span><b>Branding & promo</b><small>${l.theme.logoUrl || l.theme.backgroundUrl || l.theme.promoTitle ? "Custom theme configured" : "Default losthusky/drop theme"}</small></span></span>${icon("chevron", "settings-chevron")}</summary><div class="settings-body grid-2"><div class="field"><label>Logo URL</label><input id="d-logo" type="url" value="${escAttr(l.theme.logoUrl)}" /></div><div class="field"><label>Background image URL</label><input id="d-bg" type="url" value="${escAttr(l.theme.backgroundUrl)}" /></div><div class="field"><label>Accent</label><input id="d-accent" type="color" value="${escAttr(l.theme.accentColor)}" /></div><div class="field"><label>Background</label><input id="d-bgcolor" type="color" value="${escAttr(l.theme.backgroundColor)}" /></div><div class="field wide"><label>Welcome message</label><input id="d-welcome" type="text" value="${escAttr(l.theme.welcome)}" /></div><div class="field"><label>Promo title</label><input id="d-promo-title" type="text" value="${escAttr(l.theme.promoTitle)}" /></div><div class="field"><label>Promo text</label><input id="d-promo-text" type="text" value="${escAttr(l.theme.promoText)}" /></div><div class="field"><label>YouTube/Vimeo URL</label><input id="d-video" type="url" value="${escAttr(l.theme.videoUrl)}" /></div><div class="field"><label>CTA label</label><input id="d-cta-label" type="text" value="${escAttr(l.theme.ctaLabel)}" /></div><div class="field"><label>CTA URL</label><input id="d-cta-url" type="url" value="${escAttr(l.theme.ctaUrl)}" /></div></div></details>
      </div>
      <div class="settings-actions"><button class="btn" id="save-detail" type="button">${icon("save")}Save settings</button><button class="btn ghost" id="clear-pin" type="button">${icon("lock")}Clear password</button><button class="btn ghost danger" id="detail-delete" type="button">Delete link</button></div>
      <div class="msg-err" id="detail-msg"></div>
    </section>`;
  $("save-detail").addEventListener("click", () => saveDetail(l.slug, false));
  $("clear-pin").addEventListener("click", () => saveDetail(l.slug, true));
  $("detail-delete").addEventListener("click", () => deleteLink(l.slug, l.label));
  $("up-search").addEventListener("input", (e) => {
    detailSearch = e.target.value;
    renderUploadRows();
  });
  const sortEl = $("up-sort");
  sortEl.value = detailSort;
  sortEl.addEventListener("change", () => {
    detailSort = sortEl.value;
    renderUploadRows();
  });
  $("up-show-all")?.addEventListener("click", () => {
    detailShowAll = !detailShowAll;
    renderUploadRows();
  });
  renderUploadRows();
  renderDetailLive(l.slug);
}

function renderUploadRows() {
  const tbody = $("upload-rows");
  if (!tbody || !detailData) return;
  const all = detailData.uploads || [];
  let ups = all;
  const q = detailSearch.trim().toLowerCase();
  if (q) {
    ups = all.filter((u) => (u.n || "").toLowerCase().includes(q) || (u.u || "").toLowerCase().includes(q));
  }
  const cmp = {
    new: (a, b) => b.at - a.at,
    old: (a, b) => a.at - b.at,
    size: (a, b) => b.s - a.s,
    name: (a, b) => (a.n || "").localeCompare(b.n || "", undefined, { numeric: true }),
    uploader: (a, b) => (a.u || "").localeCompare(b.u || "") || b.at - a.at,
  }[detailSort];
  ups = [...ups].sort(cmp);
  const visible = detailShowAll || q ? ups : ups.slice(0, 8);
  tbody.innerHTML = visible.length
    ? visible.map(uploadRow).join("")
    : `<tr><td colspan="5" class="empty-cell">${all.length ? "No files match the filter." : 'No files yet. Use "sync from Drive" to pull any files saved with a delayed log.'}</td></tr>`;
  const shown = visible.length === all.length ? `${all.length}` : `${visible.length} of ${all.length}`;
  $("up-count").textContent = `${shown} files · ${fmtBytes(detailData.totalBytes)}`;
  const toggle = $("up-show-all");
  if (toggle) {
    toggle.classList.toggle("hidden", !q && all.length <= 8);
    toggle.textContent = detailShowAll ? "Show recent 8" : `Show all ${all.length}`;
  }
}

function budgetBar(l) {
  if (!l.settings.maxTotalBytes) return "";
  const pct = Math.min(100, Math.round((l.stats.bytes / l.settings.maxTotalBytes) * 100));
  return `<div class="budget-bar"><span class="muted">budget: ${fmtBytes(l.stats.bytes)} of ${fmtBytes(l.settings.maxTotalBytes)} (${pct}%)</span><div class="trail"><i style="width:${pct}%"></i></div></div>`;
}

// Uploader leaderboard aggregated from the recent history.
function leaderboard(uploads) {
  if (!uploads.length) return "";
  const byUploader = new Map();
  for (const u of uploads) {
    const cur = byUploader.get(u.u) || { files: 0, bytes: 0 };
    cur.files++;
    cur.bytes += u.s || 0;
    byUploader.set(u.u, cur);
  }
  const sorted = [...byUploader.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6);
  const total = sorted.reduce((sum, [, value]) => sum + value.bytes, 0) || 1;
  const rows = sorted.map(([name, value]) => {
    const pct = Math.round((value.bytes / total) * 100);
    return `<div class="leader-row"><div><span class="avatar">${esc(initialsOf(name))}</span><span><b>${esc(name || "anonymous")}</b><small>${value.files} files · ${fmtBytes(value.bytes)}</small></span><em>${pct}%</em></div><div class="trail"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
  return `<div class="leaderboard">${rows}</div>`;
}

function renderDetailLive(slug) {
  const box = $("detail-live");
  if (!box) return;
  const rows = liveActive.filter((s) => s.slug === slug);
  reconcile(box, rows, (s) => s.id, makeLiveRow, updateLiveRow);
  setEmpty(box, rows.length === 0, "No active uploads for this link.");
}

async function saveDetail(slug, clearPin) {
  const gb = Number(value("d-budget-gb")) || 0;
  const maxGb = Number(value("d-maxgb")) || 0;
  const body = {
    ...(clearPin ? { pin: "" } : value("d-pin") ? { pin: value("d-pin") } : {}),
    label: value("d-label"),
    expiresDays: Number(value("d-days")) || 0,
    settings: {
      concurrency: Number(value("d-conc")) || 4,
      chunkMB: Number(value("d-chunk")) || 32,
      adaptiveConcurrency: $("d-adaptive").checked,
      perUploaderFolders: $("d-folders").checked,
      maxTransferBytes: maxGb > 0 ? Math.round(maxGb * 1024 ** 3) : 0,
      maxTotalBytes: gb > 0 ? Math.round(gb * 1024 ** 3) : 0,
      maxTotalFiles: Number(value("d-budget-files")) || 0,
      maxSessions: Number(value("d-budget-sessions")) || 0,
    },
    notify: {
      enabled: $("d-notify").checked,
      start: $("d-notify-start").checked,
      complete: $("d-notify-complete").checked,
    },
    theme: {
      logoUrl: value("d-logo"),
      backgroundUrl: value("d-bg"),
      accentColor: value("d-accent"),
      backgroundColor: value("d-bgcolor"),
      welcome: value("d-welcome"),
      promoTitle: value("d-promo-title"),
      promoText: value("d-promo-text"),
      videoUrl: value("d-video"),
      ctaLabel: value("d-cta-label"),
      ctaUrl: value("d-cta-url"),
    },
  };
  const r = await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  $("detail-msg").textContent = r.ok ? "Saved." : "Save failed.";
  refreshAll();
  refreshDetail(slug, false);
}

function uploadRow(u) {
  return `
    <tr>
      <td class="up-name"><b>${esc(u.n)}</b></td>
      <td>${esc(u.u)}</td>
      <td class="num">${fmtBytes(u.s)}</td>
      <td class="num">${new Date(u.at).toLocaleString()}</td>
      <td class="num"><button class="mini" data-preview="${escAttr(u.f)}" ${u.f ? "" : "disabled"} type="button">open</button></td>
    </tr>`;
}
function detailStatCard(label, value, iconName, accent = false) {
  return `<div class="stat-card v3${accent ? " accent" : ""}"><span class="stat-ico">${icon(iconName)}</span><div><b>${esc(String(value))}</b><span class="stat-label">${esc(label)}</span></div></div>`;
}

function staticCard(label, value) {
  return `<div class="stat-card"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function icon(name, className = "ico") {
  return uiIcon(name, className);
}

async function previewFile(fileId, button) {
  if (!fileId) return;
  button.disabled = true;
  const r = await fetch(`/api/admin/thumb/${encodeURIComponent(fileId)}`);
  const d = await r.json().catch(() => ({}));
  button.disabled = false;
  if (d.webViewLink) window.open(d.webViewLink, "_blank");
}

function opts(values, selected, suffix = "") {
  return values.map((v) => `<option value="${v}" ${Number(selected) === v ? "selected" : ""}>${v}${suffix}</option>`).join("");
}

function value(id) {
  return $(id) ? $(id).value.trim() : "";
}

// fmtBytes/fmtTime/esc/escAttr live in public.js (shared with drop.js/share.js).
