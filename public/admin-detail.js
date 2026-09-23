import {
  $,
  detailData,
  detailSearch,
  detailShowAll,
  detailSort,
  icon,
  liveActive,
  setCurrentDetailSlug,
  setDetailData,
  setDetailSearch,
  setDetailShowAll,
  setDetailSort,
  value,
} from "./admin-state.js";
import { skelRows } from "./skeleton.js";
import { showTab, refreshAll, setEmpty } from "./admin.js";
import { initialsOf, makeLiveRow, updateLiveRow } from "./admin-live.js";
import { deleteLink, linkActionButton, openFolderPicker, dropEditFolder, setDropEditFolder } from "./admin-links.js";

// Link detail page: uploads table, settings accordion, live rows.
// ---- Link detail ----

export async function refreshDetail(slug, switchTab, fresh = false, nav = {}) {
  setCurrentDetailSlug(slug);
  const url = `/api/admin/link/${encodeURIComponent(slug)}${fresh ? "?fresh=1" : ""}`;
  const r = await fetch(url);
  if (!r.ok) return;
  const d = await r.json();
  renderDetail(d);
  const tab = $("detail-tab");
  tab.classList.remove("hidden");
  tab.textContent = `Detail: ${d.link.label}`;
  if (switchTab) showTab("detail", nav);
}

function renderDetail(d) {
  setDetailData(d);
  const l = d.link;
  const uploads = d.uploads || [];
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
          ${linkActionButton("copy", "Copy", `data-copy-link="/d/${escAttr(l.slug)}"`)}
          ${linkActionButton("qr-code", "QR", `data-qr-link="/d/${escAttr(l.slug)}" data-qr-label="${escAttr(l.label)}"`)}
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
          <button class="mini" data-refresh-detail="${escAttr(l.slug)}" type="button">${icon("refresh-cw")}refresh</button>
          <button class="mini" data-sync-detail="${escAttr(l.slug)}" type="button">${icon("folder-plus")}sync from Drive</button>
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
    <section class="panel detail-sessions">
      <div class="section-title"><div><p class="eyebrow">debug</p><h2>${icon("activity")} Upload sessions</h2></div><span class="muted">Every state change the upload page reported, per browser session (30 days).</span></div>
      <div class="sessions-filters"><select id="us-type" class="mini-select"><option value="">All events</option><option value="upload_error">Errors</option><option value="upload_retry">Retries</option><option value="upload_skipped_duplicate">Skipped duplicates</option><option value="upload_complete">Completed</option><option value="network_offline">Went offline</option></select><input id="us-file" class="mini-input" placeholder="filter by file name" /><button id="us-refresh" class="mini" type="button">Refresh</button></div>
      <div id="upload-sessions" class="sessions-list">${skelRows(3, 58)}</div>
    </section>
    <section class="panel settings-fold">
      <div class="section-title"><div><p class="eyebrow">configuration</p><h2>${icon("sliders-horizontal")} Settings</h2></div><span class="muted">Changes apply to this link only.</span></div>
      <div class="settings-accordion">
        <details open><summary><span class="settings-summary-copy">${icon("lock", "settings-role-icon")}<span><b>Access & destination</b><small>${l.requireAuth ? "Google sign-in" : l.hasPin ? "PIN protected" : "Open"} · ${l.expiresAt ? `expires ${fmtDateDMY(l.expiresAt)}` : "never expires"}</small></span></span>${icon("chevron-down", "settings-chevron")}</summary><div class="settings-body"><div class="grid-3"><div class="field"><label>Label</label><input id="d-label" type="text" value="${escAttr(l.label)}" /></div><div class="field"><label>New password (blank keeps current)</label><input id="d-pin" type="password" autocomplete="new-password" /></div><div class="field"><label>Expires in days from now</label><input id="d-days" type="number" min="0" max="30" value="${expiryDays}" /></div></div><div class="folder-picker"><div class="field"><label>Destination Drive folder</label><input id="d-folder" type="text" value="${escAttr(l.folderId || "")}" /><small id="d-folder-name">${esc(l.folderName || "Automatic folder")}</small></div><button class="mini folder-browse-button" id="d-folder-browse" type="button">Browse Drive</button></div><label class="check"><input id="d-auth" type="checkbox" ${l.requireAuth ? "checked" : ""} /> Require Google sign-in before upload</label></div></details>
        <details><summary><span class="settings-summary-copy">${icon("sliders-horizontal", "settings-role-icon")}<span><b>Transfer</b><small>${l.settings.adaptiveConcurrency ? "auto 2–8× parallel" : `${l.settings.concurrency}× parallel`} · ${l.settings.chunkMB} MB chunks · ${l.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</small></span></span>${icon("chevron-down", "settings-chevron")}</summary><div class="settings-body"><div class="grid-3"><div class="field"><label>Starting parallel files</label><select id="d-conc">${opts([1, 2, 3, 4, 6, 8], l.settings.concurrency)}</select></div><div class="field"><label>Chunk size</label><select id="d-chunk">${opts([8, 16, 32, 64], l.settings.chunkMB, " MB")}</select></div><div class="field"><label>Max single file GB</label><input id="d-maxgb" type="number" min="0" value="${escAttr(maxTransferGb)}" /></div></div><div class="check-row"><label class="check"><input id="d-adaptive" type="checkbox" ${l.settings.adaptiveConcurrency ? "checked" : ""} /> Adapt parallelism to live network performance</label><label class="check"><input id="d-folders" type="checkbox" ${l.settings.perUploaderFolders ? "checked" : ""} /> Create subfolders per uploader</label></div></div></details>
        <details><summary><span class="settings-summary-copy">${icon("circle-gauge", "settings-role-icon")}<span><b>Budgets</b><small>${l.settings.maxTotalBytes ? `${fmtBytes(l.stats.bytes)} of ${fmtBytes(l.settings.maxTotalBytes)}` : "Unlimited"} · auto-pause at limit</small></span></span>${icon("chevron-down", "settings-chevron")}</summary><div class="settings-body grid-3"><div class="field"><label>Max total GB</label><input id="d-budget-gb" type="number" min="0" value="${escAttr(budgetGb)}" /></div><div class="field"><label>Max files</label><input id="d-budget-files" type="number" min="0" value="${l.settings.maxTotalFiles || ""}" /></div><div class="field"><label>Max sessions</label><input id="d-budget-sessions" type="number" min="0" value="${l.settings.maxSessions || ""}" /></div></div></details>
        <details><summary><span class="settings-summary-copy">${icon("bell", "settings-role-icon")}<span><b>Notifications</b><small>${l.notify.enabled ? "Email enabled" : "Email disabled"} · ${l.notify.start ? "start alerts" : "no start alerts"} · ${l.notify.complete ? "completion digest" : "no completion digest"}</small></span></span>${icon("chevron-down", "settings-chevron")}</summary><div class="settings-body check-row"><label class="check"><input id="d-notify" type="checkbox" ${l.notify.enabled ? "checked" : ""} /> Email enabled</label><label class="check"><input id="d-notify-start" type="checkbox" ${l.notify.start ? "checked" : ""} /> On upload start</label><label class="check"><input id="d-notify-complete" type="checkbox" ${l.notify.complete ? "checked" : ""} /> Session digest when done</label></div></details>
        <details><summary><span class="settings-summary-copy">${icon("palette", "settings-role-icon")}<span><b>Branding & promo</b><small>${l.theme.logoUrl || l.theme.backgroundUrl || l.theme.promoTitle ? "Custom theme configured" : "Default losthusky/drop theme"}</small></span></span>${icon("chevron-down", "settings-chevron")}</summary><div class="settings-body grid-2"><div class="field"><label>Logo URL</label><input id="d-logo" type="url" value="${escAttr(l.theme.logoUrl)}" /></div><div class="field"><label>Background image URL</label><input id="d-bg" type="url" value="${escAttr(l.theme.backgroundUrl)}" /></div><div class="field"><label>Accent</label><input id="d-accent" type="color" value="${escAttr(l.theme.accentColor)}" /></div><div class="field"><label>Background</label><input id="d-bgcolor" type="color" value="${escAttr(l.theme.backgroundColor)}" /></div><div class="field wide"><label>Welcome message</label><input id="d-welcome" type="text" value="${escAttr(l.theme.welcome)}" /></div><div class="field"><label>Promo title</label><input id="d-promo-title" type="text" value="${escAttr(l.theme.promoTitle)}" /></div><div class="field"><label>Promo text</label><input id="d-promo-text" type="text" value="${escAttr(l.theme.promoText)}" /></div><div class="field"><label>YouTube/Vimeo URL</label><input id="d-video" type="url" value="${escAttr(l.theme.videoUrl)}" /></div><div class="field"><label>CTA label</label><input id="d-cta-label" type="text" value="${escAttr(l.theme.ctaLabel)}" /></div><div class="field"><label>CTA URL</label><input id="d-cta-url" type="url" value="${escAttr(l.theme.ctaUrl)}" /></div></div></details>
      </div>
      <div class="settings-actions"><button class="btn" id="save-detail" type="button">${icon("save")}Save settings</button><button class="btn ghost" id="clear-pin" type="button">${icon("lock")}Clear password</button><button class="btn ghost danger" id="detail-delete" type="button">Delete link</button></div>
      <div class="msg-err" id="detail-msg"></div>
    </section>`;
  $("save-detail").addEventListener("click", () => saveDetail(l.slug, false));
  $("clear-pin").addEventListener("click", () => saveDetail(l.slug, true));
  $("detail-delete").addEventListener("click", () => deleteLink(l.slug, l.label));
  setDropEditFolder(l.folderId ? { id: l.folderId, name: l.folderName || l.folderId } : null);
  $("d-folder-browse")?.addEventListener("click", () => openFolderPicker("root", "drop-edit"));
  $("up-search").addEventListener("input", (e) => {
    setDetailSearch(e.target.value);
    renderUploadRows();
  });
  const sortEl = $("up-sort");
  sortEl.value = detailSort;
  sortEl.addEventListener("change", () => {
    setDetailSort(sortEl.value);
    renderUploadRows();
  });
  $("up-show-all")?.addEventListener("click", () => {
    setDetailShowAll(!detailShowAll);
    renderUploadRows();
  });
  renderUploadRows();
  renderDetailLive(l.slug);
  const reloadSessions = () => renderUploadSessions(l.slug);
  $("us-type")?.addEventListener("change", reloadSessions);
  $("us-file")?.addEventListener("change", reloadSessions);
  $("us-refresh")?.addEventListener("click", reloadSessions);
  reloadSessions();
}

// Upload spec §1.5: the per-file event stream, grouped by session, with the
// filters that turn "it failed and nobody knows why" into a lookup.
async function renderUploadSessions(slug) {
  const box = $("upload-sessions");
  if (!box) return;
  const params = new URLSearchParams({ type: $("us-type")?.value || "", file: $("us-file")?.value.trim() || "" });
  box.innerHTML = skelRows(3, 58);
  const r = await fetch(`/api/admin/upload-sessions/${encodeURIComponent(slug)}?${params}`).catch(() => null);
  const d = r?.ok ? await r.json() : { sessions: [] };
  if (!d.sessions.length) {
    box.innerHTML = `<div class="empty">No upload events recorded${params.get("type") || params.get("file") ? " for this filter" : " yet"}.</div>`;
    return;
  }
  const label = (e) => `${esc(e.t.replaceAll("_", " "))}${e.name ? ` · ${esc(e.name)}` : ""}${e.data?.status ? ` · HTTP ${esc(String(e.data.status))}` : ""}${e.data?.message ? ` · ${esc(String(e.data.message))}` : ""}${e.data?.percent != null ? ` · ${esc(String(e.data.percent))}%` : ""}${e.data?.retry ? ` · retry ${esc(String(e.data.retry))}` : ""}`;
  box.innerHTML = d.sessions.map((s) => `<details class="session-card${s.errors ? " has-errors" : ""}"><summary><b>${esc(s.viewer || "anonymous")}</b><span>${esc(fmtDateDMY(s.startedAt || s.lastAt))}</span><span>${s.files} file${s.files === 1 ? "" : "s"}</span><span>${s.events.length} events</span>${s.errors ? `<span class="err">${s.errors} problem${s.errors === 1 ? "" : "s"}</span>` : ""}<code>${esc(s.sessionId.slice(0, 10))}</code></summary><ol class="session-events">${s.events.map((e) => `<li class="${/error|fail/.test(e.t) ? "err" : /retry|offline|stall|skipped/.test(e.t) ? "warn" : ""}"><time>${esc(new Date(e.at).toLocaleTimeString())}</time>${label(e)}</li>`).join("")}</ol></details>`).join("");
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

export function renderDetailLive(slug) {
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
    requireAuth: $("d-auth")?.checked === true,
    folderId: value("d-folder"),
    folderName: dropEditFolder?.name || $("d-folder-name")?.textContent || "",
    // The field shows whole days left, so resending it on every save pushed
    // the expiry out by up to a day. Only an edited value moves it.
    ...($("d-days").value !== $("d-days").defaultValue ? { expiresDays: Number(value("d-days")) || 0 } : {}),
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
      <td class="num"><button class="mini" data-preview="${escAttr(u.f)}" ${u.f ? "" : "disabled"} type="button">open</button> <button class="mini danger" data-trash-upload="${escAttr(u.f)}" data-trash-name="${escAttr(u.n)}" ${u.f ? "" : "disabled"} type="button">remove</button></td>
    </tr>`;
}
function detailStatCard(label, value, iconName, accent = false) {
  return `<div class="stat-card v3${accent ? " accent" : ""}"><span class="stat-ico">${icon(iconName)}</span><div><b>${esc(String(value))}</b><span class="stat-label">${esc(label)}</span></div></div>`;
}

export async function previewFile(fileId, button) {
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


// fmtBytes/fmtTime/esc/escAttr live in public.js (shared with drop.js/share.js).
