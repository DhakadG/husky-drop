const $ = (id) => document.getElementById(id);

let token = localStorage.getItem("lhdb_admin") || "";
let overview = null;
let liveActive = [];
let liveSocket = null;
let liveReconnectDelay = 1000;
let currentDetailSlug = "";
const expandedUploads = new Set();
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
  document.addEventListener("click", handleAdminAction);
  if (token && (await ping())) unlock();
}

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function ping() {
  try {
    const r = await fetch("/api/admin/overview", { headers: auth() });
    return r.ok;
  } catch {
    return false;
  }
}

async function tryToken() {
  token = $("tok").value.trim();
  if (await ping()) {
    localStorage.setItem("lhdb_admin", token);
    unlock();
  } else {
    $("tok-err").textContent = "Wrong token.";
  }
}

function unlock() {
  $("auth").classList.add("hidden");
  $("panel").classList.remove("hidden");
  connectLive();
  refreshAll();
  setInterval(refreshAll, 15000);
  setInterval(tickLive, 1000);
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
    const r = await fetch("/api/admin/overview", { headers: auth() });
    if (!r.ok) return;
    overview = await r.json();
    if (!liveActive.length) liveActive = overview.active || [];
    renderStats();
    renderLive();
    renderEvents();
    renderLinks(overview.links || []);
    if (currentDetailSlug) renderDetailLive(currentDetailSlug);
  } catch {}
}

function connectLive() {
  if (liveSocket && liveSocket.readyState <= 1) return;
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    liveSocket = new WebSocket(`${protocol}//${location.host}/api/admin/live?token=${encodeURIComponent(token)}`);
    liveSocket.onopen = () => {
      liveReconnectDelay = 1000;
      $("live-state").textContent = "live";
    };
    liveSocket.onclose = () => {
      $("live-state").textContent = "offline";
      // The dashboard is long-lived; always try to reconnect with backoff so a
      // dropped socket never silently freezes the live view.
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

// ---- Keyed reconciliation: reuse DOM nodes across refreshes so nothing fades
// out and back in, and scrollable lists never collapse (no scrollbar flicker).

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

// Fixed-count card grids (stats, live metrics): create once, then only patch the
// value text that actually changed. Zero re-creation means zero flicker.
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
  upsertCards(
    $("stats"),
    [
      ["Links", t.links || 0],
      ["Opens", t.opens || 0],
      ["Sessions", t.sessions || 0],
      ["Files", t.files || 0],
      ["Bytes", fmtBytes(t.bytes || 0)],
    ],
    "stat-card"
  );
}

function renderLive() {
  renderMetrics(liveActive.filter((s) => s.state === "uploading"));
  const box = $("live-list");
  if (!box) return;
  reconcile(box, liveActive, (s) => s.id, makeLiveRow, updateLiveRow);
  setEmpty(box, liveActive.length === 0, "No active uploads right now.");
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
      ["Throughput", speed ? `${fmtBytes(speed)}/s` : "—"],
      ["ETA · all done", speed ? fmtTime(eta) : "—"],
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
  const files = (s.files || [])
    .slice(0, 3)
    .map((f) => `<li>${esc(f.name)} <span>${fmtBytes(f.sent)} / ${fmtBytes(f.size)}</span></li>`)
    .join("");
  const more = (s.files || []).length > 3 ? `<li class="more">uploading ${(s.files || []).length - 3} more in parallel</li>` : "";
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
        <div class="muted">${esc(s.slug)} · ${s.pct || 0}% · ${fmtBytes(s.sent || 0)} of ${fmtBytes(s.total || 0)} · ${age}s ago</div>
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
  if (close) {
    closeLiveSession(close.dataset.closeSession, close.dataset.closeSlug);
    return;
  }
  const detail = e.target.closest("[data-open-detail]");
  if (detail) {
    refreshDetail(detail.dataset.openDetail, true);
    return;
  }
  const folder = e.target.closest("[data-open-folder]");
  if (folder) {
    openDriveFolder(folder.dataset.openFolder);
    return;
  }
  const copy = e.target.closest("[data-copy-link]");
  if (copy) {
    navigator.clipboard?.writeText(`${location.origin}/d/${copy.dataset.copyLink}`).catch(() => {});
    flash(copy, "copied");
    return;
  }
  const del = e.target.closest("[data-del-link]");
  if (del) {
    deleteLink(del.dataset.delLink, del.dataset.delLabel);
    return;
  }
  const refresh = e.target.closest("[data-refresh-detail]");
  if (refresh) {
    refreshDetail(refresh.dataset.refreshDetail, false);
    return;
  }
  const sync = e.target.closest("[data-sync-detail]");
  if (sync) {
    refreshDetail(sync.dataset.syncDetail, false, true);
    return;
  }
  const history = e.target.closest("[data-toggle-history]");
  if (history) {
    const slug = history.dataset.toggleHistory;
    if (expandedUploads.has(slug)) expandedUploads.delete(slug);
    else expandedUploads.add(slug);
    refreshDetail(slug, false);
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
    headers: { ...auth(), "content-type": "application/json" },
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
  reconcile(box, events, eventKey, makeEventRow, updateEventRow);
  setEmpty(box, events.length === 0, "No activity yet.");
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
  if (e.t === "open") typeIcon = "eye";
  if (e.t === "lock" || e.t === "global-lock") typeIcon = "lock";
  if (e.t === "sessionclose") typeIcon = "shield-alert";

  el.innerHTML = `
    <code class="${escAttr(e.t)}">${icon(typeIcon)}${esc(e.t)}</code>
    <span>${esc(e.l || e.s || "")}${e.u ? " · " + esc(e.u) : ""}${e.f ? " · " + esc(e.f) : ""}</span>
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

function renderLinks(links) {
  // Rows are <tr>; an empty-state <div> would be invalid inside <tbody>, so the
  // table simply stays empty when there are no links.
  reconcile($("rows"), links, (l) => l.slug, makeLinkRow, updateLinkRow);
}

function makeLinkRow() {
  return document.createElement("tr");
}

function updateLinkRow(tr, l) {
  tr.innerHTML = `
    <td><b>${esc(l.label)}</b><br><code>/d/${esc(l.slug)}</code></td>
    <td>${l.hasPin ? "password" : "open"} · ${l.settings.concurrency}x · ${l.settings.chunkMB} MB<br>
      <span class="muted">${l.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</span></td>
    <td>${l.stats.opens} opens · ${l.stats.files} files<br><span class="muted">${fmtBytes(l.stats.bytes)}</span></td>
    <td class="actions">
      <button class="mini" data-open-detail="${escAttr(l.slug)}" type="button">detail</button>
      <button class="mini" data-copy-link="${escAttr(l.slug)}" type="button">copy</button>
      <button class="mini" data-open-folder="${escAttr(l.slug)}" type="button">folder</button>
      <button class="mini danger" data-del-link="${escAttr(l.slug)}" data-del-label="${escAttr(l.label)}" type="button">delete</button>
    </td>`;
}

async function deleteLink(slug, label) {
  if (!confirm(`Delete "${label}"? Drive files stay put.`)) return;
  await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, { method: "DELETE", headers: auth() });
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
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  $("create").disabled = false;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return ($("create-err").textContent = d.error || "failed");
  navigator.clipboard?.writeText(`${location.origin}/d/${d.slug}`).catch(() => {});
  ["f-label", "f-slug", "f-pin", "f-folder", "f-logo", "f-bg", "f-welcome", "f-promo-title", "f-promo-text", "f-video", "f-cta-label", "f-cta-url"].forEach((id) => ($(id).value = ""));
  showTab("links");
  refreshAll();
}

async function refreshDetail(slug, switchTab, fresh = false) {
  currentDetailSlug = slug;
  const url = `/api/admin/link/${encodeURIComponent(slug)}${fresh ? "?fresh=1" : ""}`;
  const r = await fetch(url, { headers: auth() });
  if (!r.ok) return;
  const d = await r.json();
  renderDetail(d);
  $("detail-tab").classList.remove("hidden");
  if (switchTab) showTab("detail");
}

function renderDetail(d) {
  const l = d.link;
  const uploads = d.uploads || [];
  const showAll = expandedUploads.has(l.slug);
  const visibleUploads = showAll ? uploads : uploads.slice(0, 8);
  const settingsOpen = openSettings.has(l.slug);
  $("detail-view").innerHTML = `
    <section class="panel detail-summary">
      <div class="section-title">
        <div>
          <p class="eyebrow">link detail</p>
          <h2>${esc(l.label)}</h2>
        </div>
        <span class="muted">/d/${esc(l.slug)}</span>
      </div>
      <div class="stat-grid small">
        ${staticCard("Opens", l.stats.opens)}
        ${staticCard("Sessions", l.stats.sessions)}
        ${staticCard("Files", l.stats.files)}
        ${staticCard("Bytes", fmtBytes(l.stats.bytes))}
      </div>
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
          <span class="muted">${uploads.length} files · ${fmtBytes(d.totalBytes)}</span>
          <button class="mini" data-refresh-detail="${escAttr(l.slug)}" type="button">${icon("refresh")}refresh</button>
          <button class="mini" data-sync-detail="${escAttr(l.slug)}" type="button">${icon("folder")}sync from Drive</button>
          ${
            uploads.length > 8
              ? `<button class="mini" data-toggle-history="${escAttr(l.slug)}" type="button">${icon("list")}${showAll ? "compact" : "show all"}</button>`
              : ""
          }
        </div>
      </div>
      <div class="upload-list ${showAll ? "scrollable" : "compact"}">
        ${uploads.length ? visibleUploads.map(uploadRow).join("") : `<div class="empty">No files yet. Use “sync from Drive” to pull any files saved with a delayed log.</div>`}
      </div>
      ${
        !showAll && uploads.length > visibleUploads.length
          ? `<div class="list-note">Showing latest ${visibleUploads.length}. Use show all for the full history.</div>`
          : ""
      }
    </section>
    <details class="panel settings-fold" ${settingsOpen ? "open" : ""}>
      <summary>
        <div>
          <p class="eyebrow">configuration</p>
          <h2>${icon("sliders")}Edit settings</h2>
        </div>
        <span class="muted">password, expiry, upload tuning, notifications, branding</span>
      </summary>
      <div class="settings-grid">
        <div class="settings-card">
          <h3>Transfer</h3>
          <div class="grid-3">
            <div class="field"><label>Parallel files</label><select id="d-conc">${opts([1,2,3,4], l.settings.concurrency)}</select></div>
            <div class="field"><label>Chunk size</label><select id="d-chunk">${opts([8,16,32], l.settings.chunkMB, " MB")}</select></div>
            <label class="check"><input id="d-folders" type="checkbox" ${l.settings.perUploaderFolders ? "checked" : ""} /> Per-uploader folders</label>
          </div>
        </div>
        <div class="settings-card">
          <h3>Access</h3>
          <div class="grid-2">
            <div class="field"><label>New password (blank keeps current)</label><input id="d-pin" type="password" /></div>
            <div class="field"><label>Expires in days from now</label><input id="d-days" type="number" min="0" max="30" value="0" /></div>
          </div>
        </div>
        <div class="settings-card">
          <h3>Branding</h3>
          <div class="grid-2">
            <div class="field"><label>Logo URL</label><input id="d-logo" type="url" value="${escAttr(l.theme.logoUrl)}" /></div>
            <div class="field"><label>Background image URL</label><input id="d-bg" type="url" value="${escAttr(l.theme.backgroundUrl)}" /></div>
            <div class="field"><label>Accent</label><input id="d-accent" type="color" value="${escAttr(l.theme.accentColor)}" /></div>
            <div class="field"><label>Background</label><input id="d-bgcolor" type="color" value="${escAttr(l.theme.backgroundColor)}" /></div>
            <div class="field wide"><label>Welcome</label><input id="d-welcome" type="text" value="${escAttr(l.theme.welcome)}" /></div>
          </div>
        </div>
        <div class="settings-card">
          <h3>Notifications</h3>
          <div class="check-row">
            <label class="check"><input id="d-notify" type="checkbox" ${l.notify.enabled ? "checked" : ""} /> Email enabled</label>
            <label class="check"><input id="d-notify-start" type="checkbox" ${l.notify.start ? "checked" : ""} /> Start</label>
            <label class="check"><input id="d-notify-complete" type="checkbox" ${l.notify.complete ? "checked" : ""} /> Complete</label>
          </div>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn" id="save-detail" type="button">${icon("save")}Save settings</button>
        <button class="btn ghost" id="clear-pin" type="button">${icon("lock")}Clear password</button>
      </div>
      <div class="msg-err" id="detail-msg"></div>
    </details>`;
  $("save-detail").addEventListener("click", () => saveDetail(l.slug, false));
  $("clear-pin").addEventListener("click", () => saveDetail(l.slug, true));
  document.querySelector(".settings-fold")?.addEventListener("toggle", (event) => {
    if (event.currentTarget.open) openSettings.add(l.slug);
    else openSettings.delete(l.slug);
  });
  document.querySelectorAll("[data-preview]").forEach((b) => {
    b.addEventListener("click", () => previewFile(b.dataset.preview, b));
  });
  renderDetailLive(l.slug);
}

function renderDetailLive(slug) {
  const box = $("detail-live");
  if (!box) return;
  const rows = liveActive.filter((s) => s.slug === slug);
  reconcile(box, rows, (s) => s.id, makeLiveRow, updateLiveRow);
  setEmpty(box, rows.length === 0, "No active uploads for this link.");
}

async function saveDetail(slug, clearPin) {
  const body = {
    ...(clearPin ? { pin: "" } : value("d-pin") ? { pin: value("d-pin") } : {}),
    expiresDays: Number(value("d-days")) || 0,
    settings: {
      concurrency: Number(value("d-conc")) || 4,
      chunkMB: Number(value("d-chunk")) || 32,
      perUploaderFolders: $("d-folders").checked,
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
    },
  };
  const r = await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  $("detail-msg").textContent = r.ok ? "Saved." : "Save failed.";
  refreshAll();
}

function uploadRow(u) {
  return `
    <div class="upload-row">
      <div><b>${esc(u.u)}</b><br><span>${esc(u.n)}</span></div>
      <div>${fmtBytes(u.s)}<br><span>${new Date(u.at).toLocaleString()}</span></div>
      <button class="mini" data-preview="${escAttr(u.f)}" ${u.f ? "" : "disabled"} type="button">preview</button>
    </div>`;
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
    "shield-alert": '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  };
  return `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || ""}</svg>`;
}

async function previewFile(fileId, button) {
  if (!fileId) return;
  button.disabled = true;
  const r = await fetch(`/api/admin/thumb/${encodeURIComponent(fileId)}`, { headers: auth() });
  const d = await r.json().catch(() => ({}));
  button.disabled = false;
  if (d.webViewLink) window.open(d.webViewLink, "_blank");
}

function opts(values, selected, suffix = "") {
  return values.map((v) => `<option value="${v}" ${Number(selected) === v ? "selected" : ""}>${v}${suffix}</option>`).join("");
}

function value(id) {
  return $(id).value.trim();
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
