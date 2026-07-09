const $ = (id) => document.getElementById(id);

let overview = null;
let liveActive = [];
let liveSocket = null;
let liveReconnectDelay = 1000;
let currentDetailSlug = "";
let seriesMetric = "bytes";
let seriesRows = [];
let detailData = null;
let detailSearch = "";
let detailSort = "new";
const openSettings = new Set();

init();

async function init() {
  $("tok-go").addEventListener("click", tryToken);
  $("tok").addEventListener("keydown", (e) => e.key === "Enter" && tryToken());
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });
  $("refresh").addEventListener("click", refreshAll);
  $("live-refresh")?.addEventListener("click", refreshAll);
  $("create").addEventListener("click", createLink);
  $("share-create")?.addEventListener("click", createShare);
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
  if (await ping()) unlock();
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
  $("tok-err").textContent =
    r.status === 429 ? `Too many attempts. Wait ${d.retryAfter || 60}s.` : d.error || "Wrong token.";
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
    if (!liveActive.length) liveActive = overview.active || [];
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
        renderLive();
        if (currentDetailSlug) renderDetailLive(currentDetailSlug);
      }
    };
  } catch {
    $("live-state").textContent = "offline";
  }
}

// ---- Keyed reconciliation helpers (reuse DOM nodes across refreshes) ----

function reconcile(container, items, keyOf, createEl, updateEl) {
  const map = container._rows || (container._rows = new Map());
  const seen = new Set();
  let prev = null;
  for (const item of items) {
    const key = keyOf(item);
    seen.add(key);
    let el = map.get(key);
    if (!el) {
      el = createEl(item);
      map.set(key, el);
    }
    updateEl(el, item);
    if (prev) {
      if (prev.nextSibling !== el) prev.after(el);
    } else if (container.firstChild !== el) {
      container.prepend(el);
    }
    prev = el;
  }
  for (const [key, el] of map) {
    if (!seen.has(key)) {
      el.remove();
      map.delete(key);
    }
  }
}

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
  const map = container._cards || (container._cards = new Map());
  const seen = new Set();
  let prev = null;
  for (const [label, value] of pairs) {
    seen.add(label);
    let el = map.get(label);
    if (!el) {
      el = document.createElement("div");
      el.className = cls;
      el.innerHTML = `<span></span><b></b>`;
      el._label = el.querySelector("span");
      el._value = el.querySelector("b");
      el._label.textContent = label;
      map.set(label, el);
    }
    const text = String(value);
    if (el._value.textContent !== text) el._value.textContent = text;
    if (prev) {
      if (prev.nextSibling !== el) prev.after(el);
    } else if (container.firstChild !== el) {
      container.prepend(el);
    }
    prev = el;
  }
  for (const [label, el] of map) {
    if (!seen.has(label)) {
      el.remove();
      map.delete(label);
    }
  }
}

function renderStats() {
  const t = overview?.totals || {};
  const q = overview?.quota;
  const cards = [
    ["Links", t.links || 0],
    ["Opens", t.opens || 0],
    ["Sessions", t.sessions || 0],
    ["Files", t.files || 0],
    ["Received", fmtBytes(t.bytes || 0)],
  ];
  if (q && q.free != null) cards.push(["Drive free", fmtBytes(q.free)]);
  upsertCards($("stats"), cards, "stat-card");
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
  points.forEach((p, i) => {
    const x = pad + i * step;
    const bh = Math.max(p.v > 0 ? 3 : 1.5, ((h - 6) * p.v) / max);
    const label = seriesMetric === "bytes" ? fmtBytes(p.v) : p.v;
    bars += `<rect class="${p.v ? "" : "zero"}" x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${esc(p.day)}: ${esc(String(label))}</title></rect>`;
  });
  const totalLabel = seriesMetric === "bytes" ? fmtBytes(total) : total;
  const note = total
    ? `${totalLabel} ${seriesMetric} in the last 30 days`
    : `No ${seriesMetric} in the last 30 days yet - the chart fills in as activity happens.`;
  const labels = [points[0], points[10], points[20], points[29]]
    .map((p) => `<span>${esc(p.day.slice(5))}</span>`)
    .join("");
  host.innerHTML = `
    <div class="chart-note muted">${esc(note)}</div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="30 day ${escAttr(seriesMetric)}">${bars}</svg>
    <div class="chart-labels">${labels}</div>`;
}

function renderLive() {
  const uploading = liveActive.filter((s) => s.state === "uploading");
  renderMetrics(uploading);
  const badge = $("live-badge");
  if (badge) {
    badge.textContent = uploading.length;
    badge.classList.toggle("hidden", uploading.length === 0);
  }
  const box = $("live-list");
  if (box) {
    reconcile(box, liveActive, (s) => s.id, makeLiveRow, updateLiveRow);
    setEmpty(box, liveActive.length === 0, "No active uploads right now.");
  }
  const mini = $("live-mini");
  if (mini) {
    const top = liveActive.slice(0, 3);
    reconcile(mini, top, (s) => `m:${s.id}`, makeLiveRow, updateLiveRow);
    setEmpty(
      mini,
      top.length === 0,
      "No active uploads right now."
    );
    if (mini._more) mini._more.remove();
    if (liveActive.length > top.length) {
      mini._more = document.createElement("div");
      mini._more.className = "list-note";
      mini._more.textContent = `+${liveActive.length - top.length} more session${liveActive.length - top.length === 1 ? "" : "s"} in the Live transfers tab`;
      mini.appendChild(mini._more);
    }
  }
}

function renderMetrics(sessions) {
  const el = $("live-metrics");
  if (!el) return;
  const remaining = sessions.reduce((t, s) => t + Math.max(0, (s.total || 0) - (s.sent || 0)), 0);
  const speed = sessions.reduce((t, s) => t + (s.speed || 0), 0);
  const files = sessions.reduce((t, s) => t + Math.max(0, (s.count || 0) - (s.done || 0)), 0);
  const eta = speed > 0 ? remaining / speed : 0;
  upsertCards(
    el,
    [
      ["Active uploaders", sessions.length],
      ["Files in flight", files],
      ["Throughput", speed ? `${fmtBytes(speed)}/s` : "-"],
      ["ETA - all done", speed ? fmtTime(eta) : "-"],
    ],
    "live-metric"
  );
  const hot = sessions.length > 0;
  for (const [, card] of el._cards) card.classList.toggle("hot", hot);
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

function liveRowInner(s) {
  // Show every in-flight file the uploader reported (up to the 20-file wire
  // sample); the list scrolls via CSS instead of hiding files behind "+N".
  const inFlight = s.files || [];
  const files = inFlight
    .map((f) => `<li class="${escAttr(f.state || "")}">${esc(f.name)} <span>${fmtBytes(f.sent)} / ${fmtBytes(f.size)}</span></li>`)
    .join("");
  const more =
    s.count > s.done + inFlight.length
      ? `<li class="more">${s.count - s.done - inFlight.length} more queued</li>`
      : "";
  const age = Math.max(0, Math.round((Date.now() - Number(s.lastSeen || Date.now())) / 1000));
  const state = s.state === "stale" ? "abandoned" : s.state === "done" ? "complete" : "uploading";
  const tags = [];
  if (s.count) tags.push(`<span class="tag">${s.done || 0}/${s.count} files</span>`);
  if (s.state === "uploading" && s.speed) tags.push(`<span class="tag rate">${fmtBytes(s.speed)}/s</span>`);
  if (s.state === "uploading" && s.eta) tags.push(`<span class="tag eta">~${fmtTime(s.eta)} left</span>`);
  if (s.error) tags.push(`<span class="tag err">${s.error} need attention</span>`);
  const meta = tags.length ? `<div class="live-meta">${tags.join("")}</div>` : "";
  return `
    <div class="live-top">
      <div>
        <b>${esc(s.uploader)}</b>
        <div class="muted">${esc(s.slug)} - ${s.pct || 0}% - ${fmtBytes(s.sent || 0)} of ${fmtBytes(s.total || 0)} - ${age}s ago</div>
      </div>
      <span class="state-pill">${esc(state)}</span>
    </div>
    <div class="trail"><i style="width:${s.pct || 0}%"></i></div>
    ${meta}
    <ul>${files}${more}</ul>
    <div class="row-actions">
      <button class="mini" data-open-detail="${escAttr(s.slug)}" type="button">${icon("list")}detail</button>
      <button class="mini" data-open-folder="${escAttr(s.slug)}" type="button">${icon("folder")}open</button>
      <button class="mini danger" data-close-session="${escAttr(s.id)}" data-close-slug="${escAttr(s.slug)}" type="button">dismiss</button>
    </div>`;
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
  const events = overview?.events || [];
  const box = $("events");
  if (box) {
    reconcile(box, events, eventKey, makeEventRow, updateEventRow);
    setEmpty(box, events.length === 0, "No activity yet.");
  }
  const mini = $("events-mini");
  if (mini) {
    const top = events.slice(0, 8);
    reconcile(mini, top, (e) => `m:${eventKey(e)}`, makeEventRow, updateEventRow);
    setEmpty(mini, top.length === 0, "No activity yet.");
  }
}

function eventKey(e) {
  return `${e.at}:${e.t}:${e.s}:${e.u}:${e.f}`;
}

function makeEventRow() {
  const el = document.createElement("div");
  el.className = "event-row";
  return el;
}

function updateEventRow(el, e) {
  const c = e.c || {};
  const hasDetails = c.o || c.l || e.m;

  if (hasDetails) {
    el.classList.add("expandable");
    el.onclick = () => el.classList.toggle("expanded");
  } else {
    el.classList.remove("expandable", "expanded");
    el.onclick = null;
  }

  let typeIcon = "list";
  if (e.t === "start") typeIcon = "play";
  if (e.t === "file") typeIcon = "file";
  if (e.t === "open" || e.t === "share-open") typeIcon = "eye";
  if (e.t === "share-view") typeIcon = "eye";
  if (e.t === "share-dl") typeIcon = "download";
  if (e.t === "lock" || e.t === "global-lock" || e.t === "autopause") typeIcon = "lock";
  if (e.t === "sessionclose") typeIcon = "shield-alert";
  if (e.t === "clienterror") typeIcon = "shield-alert";

  el.innerHTML = `
    <code class="${escAttr(e.t)}">${icon(typeIcon)}${esc(e.t)}</code>
    <span>${esc(e.l || e.s || "")}${e.u ? " - " + esc(e.u) : ""}${e.f ? " - " + esc(e.f) : ""}</span>
    <time>${new Date(e.at).toLocaleString()}</time>
    ${hasDetails ? `
      <div class="event-row-details">
        ${e.m ? `<div class="detail-item">${icon("list")}${esc(e.m)}</div>` : ""}
        ${c.o ? `<div class="detail-item">${icon(c.i || "laptop")}${esc(c.o)}</div>` : ""}
        ${c.l ? `<div class="detail-item">${icon("globe")}${esc(c.l)}</div>` : ""}
      </div>
    ` : ""}
  `;
}

// ---- Drop links table ----

function renderLinks(links) {
  reconcile($("rows"), links, (l) => l.slug, makeLinkRow, updateLinkRow);
}

function makeLinkRow() {
  return document.createElement("tr");
}

function stateBadge(state) {
  if (state === "paused") return `<span class="tag err">paused</span>`;
  if (state === "expired") return `<span class="tag warn">expired</span>`;
  return "";
}

function updateLinkRow(tr, l) {
  const budget = l.settings.maxTotalBytes
    ? `<br><span class="muted">budget ${fmtBytes(l.stats.bytes)} / ${fmtBytes(l.settings.maxTotalBytes)}</span>`
    : "";
  tr.innerHTML = `
    <td><b>${esc(l.label)}</b> ${stateBadge(l.state)}<br><code>/d/${esc(l.slug)}</code></td>
    <td>${l.hasPin ? "password" : "open"} - ${l.settings.concurrency}x - ${l.settings.chunkMB} MB<br>
      <span class="muted">${l.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</span></td>
    <td>${l.stats.opens} opens - ${l.stats.files} files<br><span class="muted">${fmtBytes(l.stats.bytes)}</span>${budget}</td>
    <td class="actions">
      <button class="mini" data-open-detail="${escAttr(l.slug)}" type="button">detail</button>
      <button class="mini" data-copy-link="/d/${escAttr(l.slug)}" type="button">copy</button>
      <button class="mini" data-qr-link="/d/${escAttr(l.slug)}" data-qr-label="${escAttr(l.label)}" type="button">qr</button>
      <button class="mini" data-open-folder="${escAttr(l.slug)}" type="button">folder</button>
      <button class="mini" data-pause-link="${escAttr(l.slug)}" data-paused="${l.disabled ? "1" : "0"}" type="button">${l.disabled ? "resume" : "pause"}</button>
      <button class="mini danger" data-del-link="${escAttr(l.slug)}" data-del-label="${escAttr(l.label)}" type="button">delete</button>
    </td>`;
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
  $("create").disabled = true;
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
      perUploaderFolders: $("f-folders").checked,
      maxTotalBytes: gb > 0 ? Math.round(gb * 1024 ** 3) : 0,
      maxTotalFiles: Number(value("f-budget-files")) || 0,
      maxSessions: Number(value("f-budget-sessions")) || 0,
    },
    notify: {
      enabled: $("f-notify").checked,
      start: $("f-notify-start").checked,
      complete: $("f-notify-complete").checked,
    },
    theme: {
      logoUrl: value("f-logo"),
      backgroundUrl: value("f-bg"),
      accentColor: value("f-accent"),
      backgroundColor: value("f-bgcolor"),
      welcome: value("f-welcome"),
      promoTitle: value("f-promo-title"),
      promoText: value("f-promo-text"),
      videoUrl: value("f-video"),
      ctaLabel: value("f-cta-label"),
      ctaUrl: value("f-cta-url"),
    },
  };
  const r = await fetch("/api/admin/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  $("create").disabled = false;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return ($("create-err").textContent = d.error || "failed");
  navigator.clipboard?.writeText(`${location.origin}/d/${d.slug}`).catch(() => {});
  ["f-label", "f-slug", "f-pin", "f-folder", "f-budget-gb", "f-budget-files", "f-budget-sessions", "f-logo", "f-bg", "f-welcome", "f-promo-title", "f-promo-text", "f-video", "f-cta-label", "f-cta-url"].forEach((id) => {
    if ($(id)) $(id).value = "";
  });
  showTab("links");
  refreshAll();
  showQr(`${location.origin}/d/${d.slug}`, "Link created - URL copied to clipboard");
}

// ---- Share links ----

function renderShares(shares) {
  const box = $("share-rows");
  if (!box) return;
  reconcile(box, shares, (s) => s.slug, makeLinkRow, updateShareRow);
}

function updateShareRow(tr, s) {
  tr.innerHTML = `
    <td><b>${esc(s.label)}</b> ${stateBadge(s.state)}<br><code>/s/${esc(s.slug)}</code></td>
    <td>${esc(s.mode)}${s.hasPin ? " - password" : ""}${s.requireAuth ? ` - <span class="tag">google sign-in</span>` : ""}<br><span class="muted">${s.folderNames.map(esc).join(", ") || "-"}</span></td>
    <td>${s.stats.opens} opens - ${s.stats.downloads} downloads<br><span class="muted">${fmtBytes(s.stats.bytes)}</span></td>
    <td class="actions">
      <button class="mini" data-copy-link="/s/${escAttr(s.slug)}" type="button">copy</button>
      <button class="mini" data-qr-link="/s/${escAttr(s.slug)}" data-qr-label="${escAttr(s.label)}" type="button">qr</button>
      <button class="mini" data-share-link="/s/${escAttr(s.slug)}" type="button">share</button>
      <button class="mini" data-toggle-share-auth="${escAttr(s.slug)}" data-auth="${s.requireAuth ? "1" : "0"}" type="button">${s.requireAuth ? "require sign-in: on" : "require sign-in: off"}</button>
      <button class="mini" data-pause-share="${escAttr(s.slug)}" data-paused="${s.disabled ? "1" : "0"}" type="button">${s.disabled ? "resume" : "pause"}</button>
      <button class="mini danger" data-del-share="${escAttr(s.slug)}" data-del-label="${escAttr(s.label)}" type="button">delete</button>
    </td>`;
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
  const maxTransferGb =
    l.settings.maxTransferBytes && l.settings.maxTransferBytes < 5 * 1024 ** 4
      ? (l.settings.maxTransferBytes / 1024 ** 3).toFixed(0)
      : "";
  const leaders = leaderboard(uploads);
  const expiryDays = l.expiresAt ? Math.max(0, Math.ceil((l.expiresAt - Date.now()) / 86400_000)) : 0;
  $("detail-view").innerHTML = `
    <section class="panel detail-summary">
      <div class="section-title">
        <div>
          <p class="eyebrow">link detail ${stateBadge(l.state)}</p>
          <h2>${esc(l.label)}</h2>
        </div>
        <div class="history-tools">
          <span class="muted">/d/${esc(l.slug)}</span>
          <button class="mini" data-copy-link="/d/${escAttr(l.slug)}" type="button">copy</button>
          <button class="mini" data-qr-link="/d/${escAttr(l.slug)}" data-qr-label="${escAttr(l.label)}" type="button">qr</button>
          <button class="mini" data-share-link="/d/${escAttr(l.slug)}" type="button">share</button>
          <button class="mini" data-open-folder="${escAttr(l.slug)}" type="button">${icon("folder")}folder</button>
          <button class="mini" data-pause-link="${escAttr(l.slug)}" data-paused="${l.disabled ? "1" : "0"}" type="button">${l.disabled ? "resume" : "pause"}</button>
        </div>
      </div>
      ${l.disabled && l.disabledReason ? `<div class="msg-err">Paused: ${esc(l.disabledReason)}</div>` : ""}
      <div class="stat-grid small">
        ${staticCard("Opens", l.stats.opens)}
        ${staticCard("Sessions", l.stats.sessions)}
        ${staticCard("Files", l.stats.files)}
        ${staticCard("Received", fmtBytes(l.stats.bytes))}
      </div>
      ${budgetBar(l)}
      ${leaders}
      <div class="section-subtitle">Live now</div>
      <div id="detail-live" class="live-list"></div>
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
          <button class="mini" data-sync-detail="${escAttr(l.slug)}" type="button">${icon("folder")}sync from Drive</button>
        </div>
      </div>
      <div class="upload-tools">
        <input id="up-search" type="search" placeholder="Filter by file name or uploader..." value="${escAttr(detailSearch)}" />
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
          <thead><tr><th>File</th><th>Uploader</th><th class="num">Size</th><th class="num">Uploaded</th><th></th></tr></thead>
          <tbody id="upload-rows"></tbody>
        </table>
      </div>
    </section>
    <details class="panel settings-fold" ${settingsOpen ? "open" : ""}>
      <summary>
        <div>
          <p class="eyebrow">configuration</p>
          <h2>${icon("sliders")}Edit settings</h2>
        </div>
        <span class="muted">label, access, upload tuning, budgets, notifications, branding, promo</span>
      </summary>
      <div class="settings-grid">
        <div class="settings-card">
          <h3>Access</h3>
          <div class="grid-3">
            <div class="field"><label>Label</label><input id="d-label" type="text" value="${escAttr(l.label)}" /></div>
            <div class="field"><label>New password (blank keeps current)</label><input id="d-pin" type="password" autocomplete="new-password" /></div>
            <div class="field"><label>Expires in days from now (0 = permanent)</label><input id="d-days" type="number" min="0" max="30" value="${expiryDays}" /></div>
          </div>
          <span class="muted">${l.hasPin ? "This link currently requires a password." : "This link is currently open (no password)."}${l.expiresAt ? ` Expires ${new Date(l.expiresAt).toLocaleDateString()}.` : " Never expires."}</span>
        </div>
        <div class="settings-card">
          <h3>Transfer</h3>
          <div class="grid-3">
            <div class="field"><label>Parallel files</label><select id="d-conc">${opts([1, 2, 3, 4, 6, 8], l.settings.concurrency)}</select></div>
            <div class="field"><label>Chunk size</label><select id="d-chunk">${opts([8, 16, 32, 64], l.settings.chunkMB, " MB")}</select></div>
            <div class="field"><label>Max single file GB (blank = 5 TB)</label><input id="d-maxgb" type="number" min="0" value="${escAttr(maxTransferGb)}" /></div>
          </div>
          <label class="check"><input id="d-folders" type="checkbox" ${l.settings.perUploaderFolders ? "checked" : ""} /> Create subfolders per uploader</label>
        </div>
        <div class="settings-card">
          <h3>Budgets (0 = unlimited, auto-pauses when reached)</h3>
          <div class="grid-3">
            <div class="field"><label>Max total GB</label><input id="d-budget-gb" type="number" min="0" value="${escAttr(budgetGb)}" /></div>
            <div class="field"><label>Max files</label><input id="d-budget-files" type="number" min="0" value="${l.settings.maxTotalFiles || ""}" /></div>
            <div class="field"><label>Max sessions</label><input id="d-budget-sessions" type="number" min="0" value="${l.settings.maxSessions || ""}" /></div>
          </div>
        </div>
        <div class="settings-card">
          <h3>Notifications</h3>
          <div class="check-row">
            <label class="check"><input id="d-notify" type="checkbox" ${l.notify.enabled ? "checked" : ""} /> Email enabled</label>
            <label class="check"><input id="d-notify-start" type="checkbox" ${l.notify.start ? "checked" : ""} /> On upload start</label>
            <label class="check"><input id="d-notify-complete" type="checkbox" ${l.notify.complete ? "checked" : ""} /> Session digest when done</label>
          </div>
        </div>
        <div class="settings-card">
          <h3>Branding</h3>
          <div class="grid-2">
            <div class="field"><label>Logo URL</label><input id="d-logo" type="url" value="${escAttr(l.theme.logoUrl)}" /></div>
            <div class="field"><label>Background image URL</label><input id="d-bg" type="url" value="${escAttr(l.theme.backgroundUrl)}" /></div>
            <div class="field"><label>Accent</label><input id="d-accent" type="color" value="${escAttr(l.theme.accentColor)}" /></div>
            <div class="field"><label>Background</label><input id="d-bgcolor" type="color" value="${escAttr(l.theme.backgroundColor)}" /></div>
            <div class="field wide"><label>Welcome message</label><input id="d-welcome" type="text" value="${escAttr(l.theme.welcome)}" /></div>
          </div>
        </div>
        <div class="settings-card">
          <h3>Promo panel (shown beside the dropzone)</h3>
          <div class="grid-2">
            <div class="field"><label>Promo title</label><input id="d-promo-title" type="text" value="${escAttr(l.theme.promoTitle)}" /></div>
            <div class="field"><label>Promo text</label><input id="d-promo-text" type="text" value="${escAttr(l.theme.promoText)}" /></div>
            <div class="field"><label>YouTube/Vimeo URL</label><input id="d-video" type="url" value="${escAttr(l.theme.videoUrl)}" /></div>
            <div class="field"><label>CTA label</label><input id="d-cta-label" type="text" value="${escAttr(l.theme.ctaLabel)}" /></div>
            <div class="field"><label>CTA URL</label><input id="d-cta-url" type="url" value="${escAttr(l.theme.ctaUrl)}" /></div>
          </div>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn" id="save-detail" type="button">${icon("save")}Save settings</button>
        <button class="btn ghost" id="clear-pin" type="button">${icon("lock")}Clear password</button>
        <button class="btn ghost danger" id="detail-delete" type="button">Delete link</button>
      </div>
      <div class="msg-err" id="detail-msg"></div>
    </details>`;
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
  document.querySelector(".settings-fold")?.addEventListener("toggle", (event) => {
    if (event.currentTarget.open) openSettings.add(l.slug);
    else openSettings.delete(l.slug);
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
    ups = all.filter(
      (u) => (u.n || "").toLowerCase().includes(q) || (u.u || "").toLowerCase().includes(q)
    );
  }
  const cmp = {
    new: (a, b) => b.at - a.at,
    old: (a, b) => a.at - b.at,
    size: (a, b) => b.s - a.s,
    name: (a, b) => (a.n || "").localeCompare(b.n || "", undefined, { numeric: true }),
    uploader: (a, b) => (a.u || "").localeCompare(b.u || "") || b.at - a.at,
  }[detailSort];
  ups = [...ups].sort(cmp);
  tbody.innerHTML = ups.length
    ? ups.map(uploadRow).join("")
    : `<tr><td colspan="5" class="empty-cell">${all.length ? "No files match the filter." : 'No files yet. Use "sync from Drive" to pull any files saved with a delayed log.'}</td></tr>`;
  const shown = ups.length === all.length ? `${all.length}` : `${ups.length} of ${all.length}`;
  $("up-count").textContent = `${shown} files - ${fmtBytes(detailData.totalBytes)}`;
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
  const rows = [...byUploader.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 6)
    .map(([name, v]) => `<div class="leader-row"><b>${esc(name)}</b><span>${v.files} files - ${fmtBytes(v.bytes)}</span></div>`)
    .join("");
  return `<div class="section-subtitle">Top uploaders (recent history)</div><div class="leaderboard">${rows}</div>`;
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

function staticCard(label, value) {
  return `<div class="stat-card"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function icon(name) {
  const paths = {
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
    sliders: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16M3 21v-5h5M3 12A9 9 0 0 1 18.5 5.8L21 8M21 3v5h-5"/>',
    smartphone: '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><path d="M12 18h.01"/>',
    laptop: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M2 20h20"/>',
    monitor: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><path d="M8 21h8M12 17v4"/>',
    terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
    play: '<polygon points="5 3 19 12 5 21 5 3"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
    file: '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
    "shield-alert": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  };
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
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
