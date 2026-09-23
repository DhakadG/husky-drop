import {
  $,
  currentDetailSlug,
  icon,
  setCreatedDropSlug,
  setCurrentDetailSlug,
  value,
} from "./admin-state.js";
import { showTab, refreshAll, setEmpty } from "./admin.js";
import { renderShareEditFolders } from "./admin-shares.js";
import { rememberFolder, renderRecentFolders } from "./admin-folders.js";

// Drop links: list cards, create flow, Drive folder picker.
// ---- Drop links table ----

export function renderLinks(links) {
  const active = links.filter((link) => !["expired", "archived"].includes(link.state));
  const expired = links.filter((link) => ["expired", "archived"].includes(link.state));
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
  const expires = link.expiresAt ? `expires ${fmtDateDMY(link.expiresAt)}` : "never expires";
  const access = link.hasPin ? "PIN" : "open";
  article.className = `link-card panel ${escAttr(link.state || "active")}`;
  article.innerHTML = `
    <div class="link-card-head">
      <div><button class="link-card-title" data-open-detail="${escAttr(link.slug)}" type="button">${esc(link.label)}</button><div class="link-meta"><code>/d/${esc(link.slug)}</code><span>·</span><span>${esc(expires)}</span><span>·</span><span>${link.settings.adaptiveConcurrency ? `auto 2–8× parallel` : `${link.settings.concurrency}× parallel`}</span><span>·</span><span>${link.settings.chunkMB} MB chunks</span><span>·</span><span>${link.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</span></div></div>
      <span class="link-status ${escAttr(link.state || "active")}">${esc(access)}${link.state === "expired" ? " · expired" : link.archived ? " · archived" : link.disabled ? " · paused" : ""}</span>
    </div>
    <div class="link-stat-grid">
      ${linkStat("Opens", link.stats.opens || 0)}
      ${linkStat("Sessions", link.stats.sessions || 0)}
      ${linkStat("Files", link.stats.files || 0)}
      <div class="link-stat budget ${budgetPct >= 85 ? "warn" : ""}"><span>Budget</span><b>${budgetLimit ? `${budgetPct}%` : "∞"}</b><small>${budgetLimit ? `${fmtBytes(link.stats.bytes)} of ${fmtBytes(budgetLimit)}` : `${fmtBytes(link.stats.bytes)} received`}</small>${budgetLimit ? `<div class="trail"><i style="width:${budgetPct}%"></i></div>` : ""}</div>
    </div>
    <div class="link-action-row" aria-label="Actions for ${escAttr(link.label)}">
      ${linkActionButton("copy", "Copy link", `data-copy-link="/d/${escAttr(link.slug)}"`)}
      ${linkActionButton("qr-code", "Show QR", `data-qr-link="/d/${escAttr(link.slug)}" data-qr-label="${escAttr(link.label)}"`)}
      ${linkActionButton("folder", "Open Drive folder", `data-open-folder="${escAttr(link.slug)}"`)}
      ${linkActionButton(link.disabled ? "play" : "pause", link.disabled ? "Resume" : "Pause", `data-pause-link="${escAttr(link.slug)}" data-paused="${link.disabled ? "1" : "0"}"`)}
      ${linkActionButton("chevron-right", "Details", `data-open-detail="${escAttr(link.slug)}"`)}
      ${linkActionButton(link.archived ? "rotate-ccw" : "inbox", link.archived ? "Unarchive" : "Archive", `data-archive-link="${escAttr(link.slug)}" data-archived="${link.archived ? "1" : "0"}"`)}
      ${linkActionButton("trash-2", "Delete", `data-del-link="${escAttr(link.slug)}" data-del-label="${escAttr(link.label)}"`, true)}
    </div>`;
}

function linkStat(label, value) {
  return `<div class="link-stat"><span>${esc(label)}</span><b>${esc(String(value))}</b></div>`;
}

export function linkActionButton(name, label, attributes, danger = false) {
  return `<button class="link-action${danger ? " danger" : ""}" ${attributes} type="button">${icon(name)}<span>${esc(label)}</span></button>`;
}

export let folderParentId = "root";
export let folderParentLabel = "My Drive";
export let folderBreadcrumbs = [{ id: "root", name: "My Drive" }];
let selectedFolderName = "";
let folderPickerMode = "drop";
// "images" mode hands picks to the Image archive tab and keeps the dialog open.
let imagePickHandler = null;
export function setImagePickHandler(fn) {
  imagePickHandler = fn;
}
let pickerSeq = 0;
export const shareSelectedFolders = new Map();
export const shareEditSelectedFolders = new Map();
export let dropEditFolder = null;
export function setDropEditFolder(v) { dropEditFolder = v; }

export function showCreateStep(step) {
  if (step === 2 && !value("f-label")) {
    $("f-label").reportValidity();
    return;
  }
  $("create-step-1").classList.toggle("hidden", step !== 1);
  $("create-step-2").classList.toggle("hidden", step !== 2);
  document.querySelectorAll("[data-create-indicator]").forEach((indicator) => indicator.classList.toggle("active", Number(indicator.dataset.createIndicator) === step));
}

export function applyTransferPreset(event) {
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

export async function confirmAction({ title, message, confirmLabel = "Confirm" }) {
  const dialog = $("confirm-dialog");
  if (!dialog?.showModal) return false;
  const previouslyFocused = document.activeElement;
  $("confirm-title").textContent = title;
  $("confirm-message").textContent = message;
  $("confirm-accept").textContent = confirmLabel;
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener("close", () => {
      previouslyFocused?.focus?.();
      resolve(dialog.returnValue === "confirm");
    }, { once: true });
    dialog.showModal();
    $("confirm-cancel").focus();
  });
}

export function toggleExpiredLinks() {
  const button = $("expired-links-toggle");
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  $("expired-rows").classList.toggle("expanded", !expanded);
}

const SKELETON = Array.from({ length: 5 }, (_, i) => `<div class="folder-option folder-skeleton" style="--i:${i}"><span class="folder-skel-ico"></span><span class="folder-skel-text" style="width:${45 + ((i * 17) % 40)}%"></span><span class="folder-skel-btn"></span></div>`).join("");

export async function openFolderPicker(parentId, mode = folderPickerMode, opener = null) {
  folderPickerMode = ["share", "share-edit", "drop-edit", "images"].includes(mode) ? mode : "drop";
  const shareMode = folderPickerMode.startsWith("share");
  const multi = shareMode || folderPickerMode === "images";
  folderParentId = parentId || "root";
  $("folder-picker-title").textContent = folderPickerMode === "images" ? "Pick folders to archive" : shareMode ? "Add Drive folders" : "Choose a destination";
  $("folder-select-current").textContent = multi ? "Add this folder" : "Select this folder";
  $("folder-create-row")?.classList.toggle("hidden", folderPickerMode === "images");
  const dialog = $("drive-picker-dialog");
  if (!dialog.open) dialog.showModal();
  const seq = ++pickerSeq;
  const list = $("folder-list");
  // The previous listing fades while the new one loads; the row that was
  // clicked shows a busy state so the click is acknowledged instantly.
  opener?.classList.add("is-busy");
  list.classList.add("is-loading");
  $("folder-err").textContent = "";
  const skeletonTimer = setTimeout(() => {
    if (seq === pickerSeq) list.innerHTML = SKELETON;
  }, 180);
  try {
    const response = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(folderParentId)}`);
    const data = await response.json().catch(() => ({ folders: [] }));
    if (!response.ok) throw new Error(data.error || "Drive folder list failed.");
    if (seq !== pickerSeq) return;
    clearTimeout(skeletonTimer);
    folderBreadcrumbs = data.breadcrumbs?.length ? data.breadcrumbs : [{ id: "root", name: "My Drive" }];
    const current = folderBreadcrumbs.at(-1);
    folderParentId = current?.id || folderParentId;
    folderParentLabel = current?.name || "My Drive";
    renderFolderBreadcrumbs();
    renderRecentFolders();
    $("folder-up").disabled = folderBreadcrumbs.length <= 1;
    $("folder-select-current").disabled = multi && folderParentId === "root";
    const selectedMap = folderPickerMode === "share-edit" ? shareEditSelectedFolders : shareSelectedFolders;
    list.innerHTML = (data.folders || []).length
      ? data.folders.map((folder, i) => {
        const added = (shareMode && selectedMap.has(folder.id)) || (folderPickerMode === "images" && imagePickHandler?.has?.(folder.id));
        return `<div class="folder-option folder-enter" style="--i:${Math.min(i, 12)}"><button class="folder-open" type="button" data-open-folder-picker="${escAttr(folder.id)}">${icon("folder")}<span>${esc(folder.name)}</span><span class="folder-open-cue">${icon("chevron-right", "ico-sm")}</span></button><button class="mini folder-pick" type="button" data-pick-folder="${escAttr(folder.id)}" data-folder-name="${escAttr(folder.name)}" ${added ? "disabled" : ""}>${added ? `${icon("check", "ico-sm")} Added` : multi ? "Add" : "Select"}</button></div>`;
      }).join("")
      : `<div class="empty folder-hint folder-enter">${icon("folder-open")} No sub-folders here${multi ? " - use “Add this folder” above." : "."}</div>`;
    list.querySelectorAll("[data-pick-folder]").forEach((button) => button.addEventListener("click", () => {
      button.classList.add("is-busy");
      selectDriveFolder(button.dataset.pickFolder, button.dataset.folderName);
    }));
    list.querySelectorAll("[data-open-folder-picker]").forEach((button) => button.addEventListener("click", () => openFolderPicker(button.dataset.openFolderPicker, folderPickerMode, button)));
  } catch (error) {
    if (seq !== pickerSeq) return;
    clearTimeout(skeletonTimer);
    list.innerHTML = `<div class="empty folder-hint folder-enter">${icon("circle-alert")} ${esc(error.message)} <button class="mini" type="button" data-open-folder-picker="${escAttr(folderParentId)}">retry</button></div>`;
    list.querySelector("[data-open-folder-picker]")?.addEventListener("click", () => openFolderPicker(folderParentId, folderPickerMode));
  } finally {
    if (seq === pickerSeq) list.classList.remove("is-loading");
  }
}

function renderFolderBreadcrumbs() {
  $("folder-breadcrumbs").innerHTML = folderBreadcrumbs.map((crumb, index) => {
    const current = index === folderBreadcrumbs.length - 1;
    return `${index ? '<span aria-hidden="true">/</span>' : ""}<button type="button" data-folder-crumb="${escAttr(crumb.id)}" ${current ? 'aria-current="page" disabled' : ""}>${esc(crumb.name)}</button>`;
  }).join("");
  $("folder-breadcrumbs").querySelectorAll("[data-folder-crumb]:not([disabled])").forEach((button) => button.addEventListener("click", () => openFolderPicker(button.dataset.folderCrumb)));
}

export function openParentFolder() {
  if (folderBreadcrumbs.length <= 1) return;
  openFolderPicker(folderBreadcrumbs.at(-2).id);
}

export function selectDriveFolder(id, name) {
  rememberFolder(id, name);
  if (folderPickerMode === "images") {
    imagePickHandler?.(id, name, folderBreadcrumbs.map((c) => c.name).concat(folderBreadcrumbs.at(-1)?.id === id ? [] : [name]).join(" / "));
    openFolderPicker(folderParentId, folderPickerMode);
    return;
  }
  if (folderPickerMode.startsWith("share")) {
    const pathParts = folderBreadcrumbs.map((crumb) => crumb.name);
    if (folderBreadcrumbs.at(-1)?.id !== id) pathParts.push(name || "Folder");
    const selectedMap = folderPickerMode === "share-edit" ? shareEditSelectedFolders : shareSelectedFolders;
    selectedMap.set(id || "root", { id: id || "root", name: name || "My Drive", path: pathParts.join(" / ") });
    if (folderPickerMode === "share-edit") renderShareEditFolders();
    else renderShareFolderSelection();
    openFolderPicker(folderParentId, folderPickerMode);
    return;
  }
  if (folderPickerMode === "drop-edit") {
    dropEditFolder = { id: id || "root", name: name || "My Drive" };
    if ($("d-folder")) $("d-folder").value = dropEditFolder.id;
    if ($("d-folder-name")) $("d-folder-name").textContent = dropEditFolder.name;
    $("drive-picker-dialog").close();
    return;
  }
  $("f-folder").value = id || "root";
  selectedFolderName = name || "My Drive";
  if (folderBreadcrumbs.at(-1)?.id !== (id || "root")) {
    folderBreadcrumbs = [...folderBreadcrumbs, { id: id || "root", name: selectedFolderName }];
  }
  folderParentId = id || "root";
  folderParentLabel = selectedFolderName;
  $("folder-selection").textContent = `Selected destination: ${selectedFolderName}`;
  $("folder-selection").classList.add("selected");
  $("drive-picker-dialog").close();
  updateCreateButtonLabel();
}

export function renderShareFolderSelection() {
  const box = $("share-folder-selection");
  if (!box) return;
  const folders = [...shareSelectedFolders.values()];
  box.innerHTML = folders.length
    ? folders.map((folder) => `<span class="selected-folder-chip"><span><b>${esc(folder.name)}</b><small>${esc(folder.path)}</small></span><button type="button" data-remove-share-folder="${escAttr(folder.id)}" aria-label="Remove ${escAttr(folder.name)}">×</button></span>`).join("")
    : '<span class="muted">No folders selected yet.</span>';
}

export async function createFolderHere() {
  const input = $("folder-new-name");
  const name = input.value.trim();
  if (!name) {
    input.focus();
    return;
  }
  const button = $("folder-create");
  button.disabled = true;
  $("folder-err").textContent = "";
  try {
    const response = await fetch("/api/admin/drive/folders", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, parentId: folderParentId }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not create the folder.");
    input.value = "";
    await openFolderPicker(folderParentId, folderPickerMode);
    const created = $("folder-list").querySelector(`[data-pick-folder="${CSS.escape(data.folder.id)}"]`);
    created?.focus();
  } catch (error) {
    $("folder-err").textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

export function handleFolderInput() {
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

export function copyCreatedLink() {
  const url = $("create-success-url").textContent;
  navigator.clipboard?.writeText(url).catch(() => {});
}

export function resetCreateFlow() {
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
export async function toggleLinkArchive(slug, archived) {
  await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: !archived }) });
  refreshAll();
}
export async function toggleLinkPause(slug, isPaused) {
  await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disabled: !isPaused }),
  });
  refreshAll();
}

export async function deleteLink(slug, label) {
  if (!(await confirmAction({
    title: `Delete ${label}?`,
    message: "Drive files stay put. The public drop link stops working immediately.",
    confirmLabel: "Delete drop link",
  }))) return;
  const r = await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, { method: "DELETE" }).catch(() => null);
  if (!r?.ok) {
    await confirmAction({ title: "Could not delete", message: r ? `The server answered ${r.status}; the link is unchanged.` : "Can't reach the server - check your connection and try again.", confirmLabel: "OK" });
    return;
  }
  if (currentDetailSlug === slug) {
    setCurrentDetailSlug("");
    $("detail-tab").classList.add("hidden");
    showTab("links");
  }
  refreshAll();
}

export async function createLink() {
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
    requireAuth: $("f-auth")?.checked === true,
    expiresDays: Number(value("f-days")) || 0,
    folderId: value("f-folder"),
    createShare: $("f-share")?.checked === true,
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
    const shareSlot = $("create-success-share");
    if (shareSlot) {
      shareSlot.classList.toggle("hidden", !data.share && !data.shareError);
      shareSlot.textContent = data.share ? `Share link: ${location.origin}${data.share.url}` : data.shareError ? `Share link not created: ${data.shareError}` : "";
    }
    setCreatedDropSlug(data.slug);
    $("drop-create-form").classList.add("hidden");
    $("create-success").classList.remove("hidden");
    navigator.clipboard?.writeText(url).catch(() => {});
    refreshAll();
  } catch (error) {
    // Creation failed, so the form is still on screen: use its error slot.
    // (This used to reference an undefined `button` and threw instead.)
    const slot = $("create-err");
    if (slot) slot.textContent = error.message;
  } finally {
    document.querySelectorAll('#drop-create-form button[type="submit"]').forEach((button) => (button.disabled = false));
  }
}
