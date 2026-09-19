import { $, icon, overview, value } from "./admin-state.js";
import { showTab, refreshAll, setEmpty, showQr } from "./admin.js";
import { initialsOf } from "./admin-live.js";
import { confirmAction, renderShareFolderSelection, shareEditSelectedFolders, shareSelectedFolders } from "./admin-links.js";

// Share links: list cards, create/edit, pause/auth toggles.
// ---- Share links ----

export function renderShares(shares) {
  const box = $("share-rows");
  if (!box) return;
  const live = shares.filter((s) => !s.archived);
  const archived = shares.filter((s) => s.archived);
  reconcile(box, live, (share) => share.slug, makeShareCard, updateShareCard);
  setEmpty(box, live.length === 0, "No share links yet.");
  let arc = $("share-archived");
  if (!arc) {
    arc = document.createElement("details");
    arc.id = "share-archived";
    arc.className = "people-unknown";
    arc.innerHTML = `<summary></summary><div class="share-card-list"></div>`;
    box.after(arc);
  }
  arc.classList.toggle("hidden", archived.length === 0);
  arc.querySelector("summary").textContent = `Archived · ${archived.length}`;
  reconcile(arc.querySelector("div"), archived, (share) => share.slug, makeShareCard, updateShareCard);
}

function makeShareCard() {
  const article = document.createElement("article");
  article.className = "share-card panel";
  return article;
}

function updateShareCard(article, share) {
  const closes = share.expiresAt ? `closes ${fmtDateDMY(share.expiresAt)}` : "never closes";
  const access = [share.mode, share.hasPin ? "PIN" : "no PIN", share.requireAuth ? "Google sign-in" : "link access"].join(" · ");
  const viewers = (share.recentViewers || []).map((viewer) => `<span class="viewer-chip" title="${escAttr(viewer.email)}"><i>${esc(initialsOf(viewer.name || viewer.email))}</i><span>${esc(viewer.name || viewer.email)}</span></span>`).join("");
  article.className = `share-card panel ${escAttr(share.state || "active")}`;
  const ix = share.index;
  const indexLine = share.mode !== "gallery" ? "" : ix?.active
    ? `<span class="index-state busy">${icon("loader-circle")}Indexing${ix.active.full ? "" : " changes"}${ix.indexedAt ? ` · last ${esc(fmtAgo(ix.indexedAt))}` : ""}</span>`
    : ix?.indexedAt
      ? `<span class="index-state${ix.needsReindex ? " stale" : ""}">${icon("database")}Indexed ${esc(fmtAgo(ix.indexedAt))}${ix.complete ? "" : " (partial)"}${ix.needsReindex ? " · changes pending" : ""}${ix.last?.status === "failed" ? ` · last run failed: ${esc(ix.last.error)}` : ""}</span>`
      : `<span class="index-state">${icon("database")}Not indexed yet${ix?.last?.status === "failed" ? ` · failed: ${esc(ix.last.error)}` : ""}</span>`;
  article.innerHTML = `
    <div class="share-card-head"><div><h2>${esc(share.label)}</h2><div class="share-mode-line"><span class="share-mode-pill">${share.mode === "gallery" ? icon("lock") : icon("external-link")}${esc(access)}</span><code>/s/${esc(share.slug)}</code></div><p>${esc((share.folderNames || []).join(" · ") || `${share.folderIds.length} Drive folder${share.folderIds.length === 1 ? "" : "s"}`)} · ${esc(closes)}</p>${indexLine}</div><span class="link-status ${escAttr(share.state || "active")}">${esc(share.state || "active")}</span></div>
    <div class="share-stat-grid"><div><span>Opens</span><b>${share.stats.opens || 0}</b></div><div><span>Unique viewers</span><b>${share.viewerCount || 0}</b></div><div><span>File views</span><b>${share.stats.views || 0}</b></div><div><span>Downloaded</span><b>${fmtBytes(share.stats.bytes || 0)}</b></div></div>
    <div class="recent-viewers"><div><span class="muted">Recent viewers</span><div class="viewer-chips">${viewers || '<span class="muted">No identified viewers yet.</span>'}</div></div><button class="mini" data-view-share-activity="${escAttr(share.slug)}" type="button">View activity →</button></div>
    <div class="link-action-row">
      ${shareActionButton("copy", "Copy", `data-copy-link="/s/${escAttr(share.slug)}"`)}
      ${shareActionButton("qr-code", "QR", `data-qr-link="/s/${escAttr(share.slug)}" data-qr-label="${escAttr(share.label)}"`)}
      ${shareActionButton("share-2", "Share", `data-share-link="/s/${escAttr(share.slug)}"`)}
      ${shareActionButton("sliders-horizontal", "Edit", `data-edit-share="${escAttr(share.slug)}"`)}
      ${share.mode === "gallery" ? shareActionButton("refresh-cw", ix?.active ? "Indexing…" : "Process now", `data-index-share="${escAttr(share.slug)}"${ix?.active ? " disabled" : ""}`) : ""}
      ${shareActionButton("user-round", share.requireAuth ? "Sign-in on" : "Sign-in off", `data-toggle-share-auth="${escAttr(share.slug)}" data-auth="${share.requireAuth ? "1" : "0"}"`)}
      ${shareActionButton(share.disabled ? "play" : "pause", share.disabled ? "Resume" : "Pause", `data-pause-share="${escAttr(share.slug)}" data-paused="${share.disabled ? "1" : "0"}"`)}
      ${shareActionButton(share.archived ? "rotate-ccw" : "inbox", share.archived ? "Unarchive" : "Archive", `data-archive-share="${escAttr(share.slug)}" data-archived="${share.archived ? "1" : "0"}"`)}
      ${shareActionButton("trash-2", "Delete", `data-del-share="${escAttr(share.slug)}" data-del-label="${escAttr(share.label)}"`, true)}
    </div>`;
}

function shareActionButton(name, label, attributes, danger = false) {
  return `<button class="link-action${danger ? " danger" : ""}" ${attributes} type="button">${icon(name)}<span>${esc(label)}</span></button>`;
}

function fmtAgo(ms) {
  const diff = Math.max(0, Date.now() - ms);
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

// "Process now" (spec §4): a full walk + thumbnail warm for one share.
export async function indexShareNow(slug) {
  const r = await fetch("/api/admin/share-index/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ slug, full: true }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) alert(d.error || "Could not start indexing.");
  refreshAll();
}

// "Clear orphans now" (spec §1.1): sweeps R2 media nobody references,
// page by page, until the bucket listing is exhausted.
export async function sweepMediaOrphans(button) {
  button.disabled = true;
  let cursor = null;
  let removed = 0;
  let scanned = 0;
  try {
    do {
      const r = await fetch("/api/admin/media/orphans", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cursor }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "sweep failed");
      removed += d.removed || 0;
      scanned += d.scanned || 0;
      cursor = d.cursor || null;
      button.querySelector("span").textContent = `Sweeping… ${scanned} checked`;
    } while (cursor);
    button.querySelector("span").textContent = `Removed ${removed} orphan${removed === 1 ? "" : "s"} of ${scanned}`;
  } catch (error) {
    button.querySelector("span").textContent = error.message;
  } finally {
    setTimeout(() => {
      button.disabled = false;
      button.querySelector("span").textContent = "Clear orphaned media";
    }, 6000);
  }
}

export async function toggleShareAuth(slug, isRequired) {
  await fetch(`/api/admin/shares/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ requireAuth: !isRequired }),
  });
  refreshAll();
}

export async function toggleSharePause(slug, isPaused) {
  await fetch(`/api/admin/shares/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disabled: !isPaused }),
  });
  refreshAll();
}

export async function toggleShareArchive(slug, archived) {
  await fetch(`/api/admin/shares/${encodeURIComponent(slug)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: !archived }) });
  refreshAll();
}
export async function deleteShare(slug, label) {
  if (!(await confirmAction({
    title: `Delete ${label}?`,
    message: "Drive files stay put. Public access is revoked and the share URL stops working.",
    confirmLabel: "Delete share link",
  }))) return;
  await fetch(`/api/admin/shares/${encodeURIComponent(slug)}`, { method: "DELETE" });
  refreshAll();
}

export async function createShare() {
  $("share-err").textContent = "";
  $("share-create").disabled = true;
  const body = {
    label: value("s-label"),
    slug: value("s-slug"),
    folders: shareSelectedFolders.size ? [...shareSelectedFolders.keys()] : value("s-folders"),
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
  shareSelectedFolders.clear();
  renderShareFolderSelection();
  refreshAll();
  showTab("shares");
  showQr(`${location.origin}/s/${d.slug}`, "Share link created - URL copied to clipboard");
}

export function openShareEditor(slug) {
  const share = overview?.shares?.find((item) => item.slug === slug);
  if (!share) return;
  shareEditSelectedFolders.clear();
  (share.folderIds || []).forEach((id, index) => shareEditSelectedFolders.set(id, {
    id,
    name: share.folderNames?.[index] || id,
    path: share.folderNames?.[index] || id,
  }));
  $("se-slug").value = share.slug;
  $("se-title").textContent = share.label;
  $("se-label").value = share.label;
  $("se-days").value = share.expiresAt ? Math.max(0, Math.ceil((share.expiresAt - Date.now()) / 86400_000)) : 0;
  $("se-mode").value = share.mode;
  $("se-pin").value = "";
  $("se-clear-pin").checked = false;
  $("se-zip").checked = share.allowZip !== false;
  $("se-auth").checked = share.requireAuth !== false;
  if ($("se-index-schedule")) $("se-index-schedule").value = share.indexSchedule || "";
  $("se-logo").value = share.theme?.logoUrl || "";
  $("se-bg").value = share.theme?.backgroundUrl || "";
  $("se-accent").value = share.theme?.accentColor || "#2f6bff";
  $("se-bgcolor").value = share.theme?.backgroundColor || "#eaf0f9";
  $("se-welcome").value = share.theme?.welcome || "";
  $("share-edit-err").textContent = "";
  syncShareEditMode();
  renderShareEditFolders();
  $("share-edit-dialog").showModal();
}

export function syncShareEditMode() {
  const redirect = $("se-mode").value === "redirect";
  $("se-pin").disabled = redirect || $("se-clear-pin").checked;
  $("se-clear-pin").disabled = redirect;
  $("se-zip").disabled = redirect;
  $("se-auth").disabled = redirect;
  $("se-mode-help").textContent = redirect
    ? "Visitors are sent to Google Drive; gallery PIN, sign-in and ZIP controls do not apply."
    : "Gallery links can use sign-in, a PIN and ZIP downloads.";
}

export function renderShareEditFolders() {
  const box = $("share-edit-folders");
  if (!box) return;
  const folders = [...shareEditSelectedFolders.values()];
  box.innerHTML = folders.length ? folders.map((folder) => `<span class="selected-folder-chip"><span><b>${esc(folder.name)}</b><small>${esc(folder.path)}</small></span><button type="button" data-remove-share-edit-folder="${escAttr(folder.id)}" aria-label="Remove ${escAttr(folder.name)}">×</button></span>`).join("") : '<span class="muted">Choose at least one Drive folder.</span>';
}

export async function saveShareEditor(event) {
  event.preventDefault();
  const slug = value("se-slug");
  if (!slug || !shareEditSelectedFolders.size) return ($("share-edit-err").textContent = "Choose at least one Drive folder.");
  const pin = value("se-pin");
  const body = {
    label: value("se-label"), folders: [...shareEditSelectedFolders.keys()], mode: value("se-mode"),
    expiresDays: Number(value("se-days")) || 0, allowZip: $("se-zip").checked, requireAuth: $("se-auth").checked,
    indexSchedule: value("se-index-schedule") || null,
    ...($("se-clear-pin").checked ? { pin: "" } : pin ? { pin } : {}),
    theme: { logoUrl: value("se-logo"), backgroundUrl: value("se-bg"), accentColor: value("se-accent"), backgroundColor: value("se-bgcolor"), welcome: value("se-welcome") },
  };
  const response = await fetch(`/api/admin/shares/${encodeURIComponent(slug)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return ($("share-edit-err").textContent = data.error || "Could not save settings.");
  $("share-edit-dialog").close();
  await refreshAll();
}
