const $ = (id) => document.getElementById(id);

let token = localStorage.getItem("lhdb_admin") || "";
let overview = null;
let liveActive = [];
let liveSocket = null;
let currentDetailSlug = "";
const expandedUploads = new Set();

init();

async function init() {
  $("tok-go").addEventListener("click", tryToken);
  $("tok").addEventListener("keydown", (e) => e.key === "Enter" && tryToken());
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });
  $("refresh").addEventListener("click", refreshAll);
  $("create").addEventListener("click", createLink);
  document.addEventListener("click", handleAdminAction);
  if (token && (await ping())) unlock();
}

function auth() {
  return { authorization: `Bearer ${token}` };
}

async function ping() {
  const r = await fetch("/api/admin/overview", { headers: auth() });
  return r.ok;
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
}

function showTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
  $(`tab-${name}`).classList.remove("hidden");
}

async function refreshAll() {
  const r = await fetch("/api/admin/overview", { headers: auth() });
  if (!r.ok) return;
  overview = await r.json();
  if (!liveActive.length) liveActive = overview.active || [];
  renderStats();
  renderLive();
  renderEvents();
  renderLinks(overview.links || []);
  if (currentDetailSlug) refreshDetail(currentDetailSlug, false);
}

function connectLive() {
  if (liveSocket && liveSocket.readyState <= 1) return;
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    liveSocket = new WebSocket(`${protocol}//${location.host}/api/admin/live?token=${encodeURIComponent(token)}`);
    liveSocket.onopen = () => ($("live-state").textContent = "live");
    liveSocket.onclose = () => ($("live-state").textContent = "offline");
    liveSocket.onmessage = (event) => {
      const msg = JSON.parse(event.data);
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

function renderStats() {
  const t = overview?.totals || {};
  $("stats").innerHTML = [
    statCard("Links", t.links || 0),
    statCard("Opens", t.opens || 0),
    statCard("Sessions", t.sessions || 0),
    statCard("Files", t.files || 0),
    statCard("Bytes", fmtBytes(t.bytes || 0)),
  ].join("");
}

function statCard(label, value) {
  return `<div class="stat-card"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function renderLive() {
  const box = $("live-list");
  if (!box) return;
  box.innerHTML = liveActive.length
    ? liveActive.map((s) => liveRow(s)).join("")
    : `<div class="empty">No active uploads right now.</div>`;
}

function liveRow(s) {
  const files = (s.files || [])
    .slice(0, 3)
    .map((f) => `<li>${esc(f.name)} <span>${fmtBytes(f.sent)} / ${fmtBytes(f.size)}</span></li>`)
    .join("");
  const more = (s.files || []).length > 3 ? `<li class="more">+${(s.files || []).length - 3} more files</li>` : "";
  const age = Math.max(0, Math.round((Date.now() - Number(s.lastSeen || Date.now())) / 1000));
  const state = s.state === "stale" ? "abandoned" : s.state === "done" ? "complete" : "uploading";
  return `
    <article class="live-row ${escAttr(s.state || "uploading")}">
      <div class="live-top">
        <div>
          <b>${esc(s.uploader)}</b>
          <div class="muted">${esc(s.slug)} · ${s.pct || 0}% · ${age}s ago</div>
        </div>
        <span class="state-pill">${esc(state)}</span>
      </div>
      <div class="trail"><i style="width:${s.pct || 0}%"></i></div>
      <ul>${files}${more}</ul>
      <div class="row-actions">
        <button class="mini" data-open-detail="${escAttr(s.slug)}">open</button>
        <button class="mini danger" data-close-session="${escAttr(s.id)}" data-close-slug="${escAttr(s.slug)}">dismiss</button>
      </div>
    </article>`;
}

function handleAdminAction(e) {
  const close = e.target.closest("[data-close-session]");
  if (close) {
    closeLiveSession(close.dataset.closeSession, close.dataset.closeSlug);
    return;
  }
  const detail = e.target.closest("[data-open-detail]");
  if (detail) refreshDetail(detail.dataset.openDetail, true);
  const history = e.target.closest("[data-toggle-history]");
  if (history) {
    const slug = history.dataset.toggleHistory;
    if (expandedUploads.has(slug)) expandedUploads.delete(slug);
    else expandedUploads.add(slug);
    refreshDetail(slug, false);
  }
}

async function closeLiveSession(id, slug) {
  if (!id && !slug) return;
  await fetch("/api/admin/live/close", {
    method: "POST",
    headers: { ...auth(), "content-type": "application/json" },
    body: JSON.stringify({ id, slug }),
  });
  liveActive = liveActive.filter((s) => s.id !== id && (!slug || s.slug !== slug || id));
  renderLive();
  if (currentDetailSlug) renderDetailLive(currentDetailSlug);
  refreshAll();
}

function renderEvents() {
  const events = overview?.events || [];
  $("events").innerHTML = events.length
    ? events
        .map(
          (e) => `
          <div class="event-row">
            <code>${esc(e.t)}</code>
            <span>${esc(e.l || e.s || "")}${e.u ? " · " + esc(e.u) : ""}${e.f ? " · " + esc(e.f) : ""}</span>
            <time>${new Date(e.at).toLocaleString()}</time>
          </div>`
        )
        .join("")
    : `<div class="empty">No activity yet.</div>`;
}

function renderLinks(links) {
  const tbody = $("rows");
  tbody.innerHTML = "";
  for (const l of links) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><b>${esc(l.label)}</b><br><code>/d/${esc(l.slug)}</code></td>
      <td>${l.hasPin ? "password" : "open"} · ${l.settings.concurrency}x · ${l.settings.chunkMB} MB<br>
        <span class="muted">${l.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</span></td>
      <td>${l.stats.opens} opens · ${l.stats.files} files<br><span class="muted">${fmtBytes(l.stats.bytes)}</span></td>
      <td class="actions"></td>`;
    const actions = tr.querySelector(".actions");
    actions.append(
      mini("detail", () => refreshDetail(l.slug, true)),
      mini("copy", () => navigator.clipboard?.writeText(`${location.origin}/d/${l.slug}`)),
      mini("folder", () => window.open(`https://drive.google.com/drive/folders/${l.folderId}`, "_blank")),
      mini("delete", async () => {
        if (!confirm(`Delete "${l.label}"? Drive files stay put.`)) return;
        await fetch(`/api/admin/links/${l.slug}`, { method: "DELETE", headers: auth() });
        refreshAll();
      }, "danger")
    );
    tbody.appendChild(tr);
  }
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
      concurrency: Number(value("f-conc")) || 2,
      chunkMB: Number(value("f-chunk")) || 8,
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

async function refreshDetail(slug, switchTab) {
  currentDetailSlug = slug;
  const r = await fetch(`/api/admin/link/${encodeURIComponent(slug)}`, { headers: auth() });
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
  $("detail-view").innerHTML = `
    <section class="panel">
      <div class="section-title">
        <h2>${esc(l.label)}</h2>
        <span class="muted">/d/${esc(l.slug)}</span>
      </div>
      <div class="stat-grid small">
        ${statCard("Opens", l.stats.opens)}
        ${statCard("Sessions", l.stats.sessions)}
        ${statCard("Files", l.stats.files)}
        ${statCard("Bytes", fmtBytes(l.stats.bytes))}
      </div>
      <div id="detail-live" class="live-list"></div>
    </section>
    <section class="panel">
      <div class="section-title">
        <h2>Upload history</h2>
        <div class="history-tools">
          <span class="muted">${uploads.length} files · ${fmtBytes(d.totalBytes)}</span>
          ${
            uploads.length > 8
              ? `<button class="mini" data-toggle-history="${escAttr(l.slug)}">${showAll ? "compact" : "show all"}</button>`
              : ""
          }
        </div>
      </div>
      <div class="upload-list ${showAll ? "scrollable" : "compact"}">
        ${uploads.length ? visibleUploads.map(uploadRow).join("") : `<div class="empty">No files yet.</div>`}
      </div>
      ${
        !showAll && uploads.length > visibleUploads.length
          ? `<div class="list-note">Showing latest ${visibleUploads.length}. Use show all for the full history.</div>`
          : ""
      }
    </section>
    <details class="panel settings-fold">
      <summary>
        <h2>Edit settings</h2>
        <span class="muted">password, expiry, upload tuning, notifications, branding</span>
      </summary>
      <div class="grid-3">
        <div class="field"><label>Parallel files</label><select id="d-conc">${opts([1,2,3,4], l.settings.concurrency)}</select></div>
        <div class="field"><label>Chunk size</label><select id="d-chunk">${opts([8,16,32], l.settings.chunkMB, " MB")}</select></div>
        <label class="check"><input id="d-folders" type="checkbox" ${l.settings.perUploaderFolders ? "checked" : ""} /> Per-uploader folders</label>
      </div>
      <div class="grid-2">
        <div class="field"><label>New password (blank keeps current)</label><input id="d-pin" type="password" /></div>
        <div class="field"><label>Expires in days from now</label><input id="d-days" type="number" min="0" max="30" value="0" /></div>
        <div class="field"><label>Logo URL</label><input id="d-logo" type="url" value="${escAttr(l.theme.logoUrl)}" /></div>
        <div class="field"><label>Background image URL</label><input id="d-bg" type="url" value="${escAttr(l.theme.backgroundUrl)}" /></div>
        <div class="field"><label>Accent</label><input id="d-accent" type="color" value="${escAttr(l.theme.accentColor)}" /></div>
        <div class="field"><label>Background</label><input id="d-bgcolor" type="color" value="${escAttr(l.theme.backgroundColor)}" /></div>
        <div class="field wide"><label>Welcome</label><input id="d-welcome" type="text" value="${escAttr(l.theme.welcome)}" /></div>
      </div>
      <div class="check-row">
        <label class="check"><input id="d-notify" type="checkbox" ${l.notify.enabled ? "checked" : ""} /> Email enabled</label>
        <label class="check"><input id="d-notify-start" type="checkbox" ${l.notify.start ? "checked" : ""} /> Start</label>
        <label class="check"><input id="d-notify-complete" type="checkbox" ${l.notify.complete ? "checked" : ""} /> Complete</label>
      </div>
      <button class="btn" id="save-detail">Save settings</button>
      <button class="btn ghost" id="clear-pin">Clear password</button>
      <div class="msg-err" id="detail-msg"></div>
    </details>`;
  $("save-detail").addEventListener("click", () => saveDetail(l.slug, false));
  $("clear-pin").addEventListener("click", () => saveDetail(l.slug, true));
  document.querySelectorAll("[data-preview]").forEach((b) => {
    b.addEventListener("click", () => previewFile(b.dataset.preview, b));
  });
  renderDetailLive(l.slug);
}

function renderDetailLive(slug) {
  const box = $("detail-live");
  if (!box) return;
  const rows = liveActive.filter((s) => s.slug === slug);
  box.innerHTML = rows.length ? rows.map(liveRow).join("") : `<div class="empty">No active uploads for this link.</div>`;
}

async function saveDetail(slug, clearPin) {
  const body = {
    ...(clearPin ? { pin: "" } : value("d-pin") ? { pin: value("d-pin") } : {}),
    expiresDays: Number(value("d-days")) || 0,
    settings: {
      concurrency: Number(value("d-conc")) || 2,
      chunkMB: Number(value("d-chunk")) || 8,
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
      <button class="mini" data-preview="${escAttr(u.f)}" ${u.f ? "" : "disabled"}>preview</button>
    </div>`;
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

function mini(label, fn, cls = "") {
  const b = document.createElement("button");
  b.className = `mini ${cls}`;
  b.textContent = label;
  b.addEventListener("click", fn);
  return b;
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
