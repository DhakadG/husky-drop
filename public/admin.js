import {
  $,
  activityQuery,
  adminMobileMore,
  adminMoreToggle,
  adminSecondaryTabs,
  currentDetailSlug,
  currentQrUrl,
  icon,
  liveActive,
  liveReconnectDelay,
  liveSocket,
  overview,
  setActivityFilter,
  setActivityQuery,
  setAdminMobileMore,
  setAdminMoreToggle,
  setCurrentQrUrl,
  setLiveActive,
  setLiveRecent,
  setLiveReconnectDelay,
  setLiveSocket,
  setOverview,
  setSeriesMetric,
  setSeriesRows,
} from "./admin-state.js";
import { renderChart } from "./admin-chart.js";
import { renderLive } from "./admin-live.js";
import { renderEvents, loadEarlierActivity } from "./admin-activity.js";
import {
  folderParentId,
  folderParentLabel,
  applyTransferPreset,
  copyCreatedLink,
  createFolderHere,
  createLink,
  deleteLink,
  handleFolderInput,
  openFolderPicker,
  openParentFolder,
  renderLinks,
  renderShareFolderSelection,
  resetCreateFlow,
  selectDriveFolder,
  shareEditSelectedFolders,
  shareSelectedFolders,
  showCreateStep,
  toggleExpiredLinks,
  toggleLinkPause,
  toggleLinkArchive,
  confirmAction,
} from "./admin-links.js";
import {
  createShare,
  deleteShare,
  openShareEditor,
  renderShareEditFolders,
  renderShares,
  saveShareEditor,
  syncShareEditMode,
  toggleShareArchive,
  toggleShareAuth,
  toggleSharePause,
} from "./admin-shares.js";
import { previewFile, refreshDetail, renderDetailLive } from "./admin-detail.js";
import { shareCreatedDrop } from "./admin-folders.js";
import { refreshPreviews, stopPreviewsPolling, updatePreviewsLive } from "./admin-previews.js";
import { refreshImages, stopImagesPolling } from "./admin-images.js";
import { refreshLogs, refreshAlertsBadge } from "./admin-logs.js";
import { refreshPeople, openPersonByKey } from "./admin-people.js";

// Admin dashboard: boot, auth gate, tabs/routing, live socket, overview
// stats, event delegation and QR. Feature areas live in admin-*.js.

init();

async function init() {
  handleAdminSigninError();
  $("admin-google")?.addEventListener("click", () => {
    location.href = "/api/admin/auth/login";
  });
  $("tok-go").addEventListener("click", tryToken);
  $("tok").addEventListener("keydown", (e) => e.key === "Enter" && tryToken());
  document.addEventListener("admin:open-person", (e) => openPersonByKey(e.detail));
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });
  setAdminMobileMore($("admin-mobile-more"));
  setAdminMoreToggle($("admin-more-toggle"));
  adminMoreToggle?.addEventListener("click", () => setAdminMobileMoreOpen(adminMobileMore.hidden));
  $("admin-mobile-more-close")?.addEventListener("click", () => setAdminMobileMoreOpen(false));
  $("admin-mobile-more-backdrop")?.addEventListener("click", () => setAdminMobileMoreOpen(false));
  adminMobileMore?.addEventListener("click", (event) => {
    const destination = event.target.closest?.("[data-mobile-tab]")?.dataset.mobileTab;
    if (!destination) return;
    setAdminMobileMoreOpen(false, false);
    document.querySelector(`.admin-side .tab[data-tab="${CSS.escape(destination)}"]`)?.click();
  });
  $("admin-mobile-lock")?.addEventListener("click", () => {
    setAdminMobileMoreOpen(false, false);
    logout();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && adminMobileMore && !adminMobileMore.hidden) setAdminMobileMoreOpen(false);
  });
  const tokenEye = $("tok-eye");
  tokenEye?.addEventListener("click", () => {
    const tok = $("tok");
    const visible = tok.type === "password";
    tok.type = visible ? "text" : "password";
    const action = visible ? "hide token" : "show token";
    tokenEye.title = action;
    tokenEye.setAttribute("aria-label", action);
    tokenEye.setAttribute("aria-pressed", String(visible));
    tokenEye.innerHTML = icon(visible ? "eye-off" : "eye");
  });
  $("refresh").addEventListener("click", refreshAll);
  $("live-refresh")?.addEventListener("click", () => {
    // Re-arm the live socket too; a dead socket looked like a stale snapshot.
    try { liveSocket?.close(); } catch {}
    setLiveSocket(null);
    connectLive();
    refreshAll();
  });
  $("drop-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    createLink();
  });
  $("create-next")?.addEventListener("click", () => showCreateStep(2));
  $("create-back")?.addEventListener("click", () => showCreateStep(1));
  $("folder-browse")?.addEventListener("click", () => openFolderPicker(folderParentId || "root", "drop"));
  $("share-folder-browse")?.addEventListener("click", () => openFolderPicker("root", "share"));
  $("share-edit-browse")?.addEventListener("click", () => openFolderPicker("root", "share-edit"));
  $("share-edit-close")?.addEventListener("click", () => $("share-edit-dialog").close());
  $("share-edit-cancel")?.addEventListener("click", () => $("share-edit-dialog").close());
  $("share-edit-form")?.addEventListener("submit", saveShareEditor);
  $("se-mode")?.addEventListener("change", syncShareEditMode);
  $("se-clear-pin")?.addEventListener("change", () => {
    $("se-pin").disabled = $("se-clear-pin").checked || $("se-mode").value === "redirect";
    if ($("se-clear-pin").checked) $("se-pin").value = "";
  });
  $("folder-up")?.addEventListener("click", openParentFolder);
  $("folder-select-current")?.addEventListener("click", () => selectDriveFolder(folderParentId, folderParentLabel));
  $("folder-close")?.addEventListener("click", () => $("drive-picker-dialog").close());
  $("folder-create")?.addEventListener("click", createFolderHere);
  $("folder-new-name")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      createFolderHere();
    }
  });
  $("f-folder")?.addEventListener("input", handleFolderInput);
  $("expired-links-toggle")?.addEventListener("click", toggleExpiredLinks);
  document.querySelectorAll('[name="transfer-preset"]').forEach((radio) => radio.addEventListener("change", applyTransferPreset));
  $("create-copy")?.addEventListener("click", () => copyCreatedLink());
  $("create-qr")?.addEventListener("click", () => showQr($("create-success-url").textContent, "New drop link"));
  $("create-share-of-drop")?.addEventListener("click", shareCreatedDrop);
  $("qr-close")?.addEventListener("click", () => $("qr-modal").close());
  $("qr-copy")?.addEventListener("click", async (event) => {
    await navigator.clipboard?.writeText(currentQrUrl);
    flash(event.currentTarget, "Copied");
  });
  $("qr-open")?.addEventListener("click", () => currentQrUrl && window.open(currentQrUrl, "_blank", "noopener"));
  $("qr-share")?.addEventListener("click", async (event) => {
    if (!currentQrUrl) return;
    if (navigator.share) await navigator.share({ title: $("qr-title").textContent, url: currentQrUrl }).catch(() => {});
    else {
      await navigator.clipboard?.writeText(currentQrUrl);
      flash(event.currentTarget, "Copied");
    }
  });
  $("qr-download")?.addEventListener("click", downloadCurrentQr);
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
      setSeriesMetric(b.dataset.metric);
      document.querySelectorAll("[data-metric]").forEach((x) => x.classList.toggle("active", x === b));
      renderChart();
    });
  });
  // A previous session cookie may still be valid.
  document.querySelectorAll("[data-activity-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      setActivityFilter(button.dataset.activityFilter || "all");
      document.querySelectorAll("[data-activity-filter]").forEach((item) => item.classList.toggle("active", item === button));
      renderEvents();
    });
  });
  $("activity-query")?.addEventListener("input", (event) => {
    setActivityQuery(event.target.value);
    renderEvents();
  });
  $("activity-more")?.addEventListener("click", loadEarlierActivity);
  window.addEventListener("popstate", routeFromUrl);
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
    // Cookie check only - the overview walks every link in KV and made the
    // sign-in screen linger for seconds on an already signed-in admin.
    const r = await fetch("/api/admin/me");
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
  routeFromUrl();
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

function setAdminMobileMoreOpen(open, restoreFocus = true) {
  if (!adminMobileMore || !adminMoreToggle) return;
  const wasOpen = !adminMobileMore.hidden;
  adminMobileMore.hidden = !open;
  $("admin-mobile-more-backdrop").hidden = !open;
  adminMoreToggle.setAttribute("aria-expanded", String(open));
  document.body.classList.toggle("admin-more-open", open);
  if (open) adminMobileMore.querySelector("[data-mobile-tab]")?.focus();
  else if (wasOpen && restoreFocus) adminMoreToggle.focus({ preventScroll: true });
}

// Every tab is a real URL (/admin/links, /admin/links/<slug> for detail) so
// refresh and back/forward land where the admin was instead of on Overview.
export function showTab(name, { push = true } = {}) {
  if (!$(`tab-${name}`)) name = "overview";
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
  $(`tab-${name}`).classList.remove("hidden");
  if (name === "previews") refreshPreviews();
  else stopPreviewsPolling();
  if (name === "images") refreshImages();
  else stopImagesPolling();
  if (name === "logs") refreshLogs();
  if (name === "people") refreshPeople();
  // Panes slide in; the class is removed so the next switch animates again.
  const pane = $(`tab-${name}`);
  pane.classList.remove("pane-enter");
  void pane.offsetWidth;
  pane.classList.add("pane-enter");
  adminMoreToggle?.classList.toggle("active", adminSecondaryTabs.has(name));
  setAdminMobileMoreOpen(false, false);
  const path = name === "detail" && currentDetailSlug ? `/admin/links/${encodeURIComponent(currentDetailSlug)}` : name === "overview" ? "/admin" : `/admin/${name}`;
  if (push && location.pathname !== path) history.pushState({ tab: name }, "", path);
}

function routeFromUrl() {
  const [, , tab = "overview", slug = ""] = location.pathname.split("/");
  if (tab === "links" && slug) {
    try {
      return refreshDetail(decodeURIComponent(slug), true, false, { push: false });
    } catch {} // malformed %-escape: fall through to the links list
  }
  showTab(tab, { push: false });
}

export async function refreshAll() {
  refreshAlertsBadge();
  try {
    const r = await fetch("/api/admin/overview");
    if (r.status === 401) {
      $("panel").classList.add("hidden");
      $("auth").classList.remove("hidden");
      return;
    }
    if (!r.ok) return;
    setOverview(await r.json());
    setLiveActive(overview.active || []);
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
    setSeriesRows(d.rows || []);
    renderChart();
  } catch {}
}

export function connectLive() {
  if (liveSocket && liveSocket.readyState <= 1) return;
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    // Auth rides on the HttpOnly session cookie - no token in the URL.
    const socket = new WebSocket(`${protocol}//${location.host}/api/admin/live`);
    setLiveSocket(socket);
    socket.onopen = () => {
      setLiveReconnectDelay(1000);
      $("live-state").textContent = "live updates on";
    };
    socket.onclose = () => {
      if (liveSocket !== socket) return; // replaced by a manual refresh
      $("live-state").textContent = "live updates off";
      setTimeout(connectLive, liveReconnectDelay);
      setLiveReconnectDelay(Math.min(15000, liveReconnectDelay * 2));
    };
    socket.onerror = () => {
      try {
        socket.close();
      } catch {}
    };
    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "snapshot") {
        setLiveActive(msg.active || []);
        setLiveRecent(msg.recent || []);
        if (msg.previewsLive) updatePreviewsLive(msg.previewsLive);
      } else if (msg.type === "patch") {
        // Deltas keyed by session id; the server only resends what changed.
        const byId = new Map(liveActive.map((s) => [s.id, s]));
        for (const s of msg.updated || []) byId.set(s.id, s);
        for (const id of msg.removed || []) byId.delete(id);
        setLiveActive([...byId.values()].sort((a, b) => b.lastSeen - a.lastSeen));
        if (msg.recent) setLiveRecent(msg.recent);
      } else if (msg.type === "previews:live") {
        updatePreviewsLive(msg.live);
        return;
      } else {
        return;
      }
      renderLive();
      if (currentDetailSlug) renderDetailLive(currentDetailSlug);
    };
  } catch {
    $("live-state").textContent = "live updates off";
  }
}

// reconcile() lives in public.js (shared with drop.js/share.js).

export function setEmpty(container, isEmpty, text) {
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

export function upsertCards(container, pairs, cls) {
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
      if (el._value.textContent !== text) {
        el._value.textContent = text;
        el._value.classList.remove("tick");
        void el._value.offsetWidth;
        el._value.classList.add("tick");
      }
    },
  );
}

// [tile tint, glyph colour, catalog icon]; the accent card inherits white.
const STAT_ICONS = {
  links: ["rgba(47,107,255,0.12)", "#2f6bff", "link"],
  opens: ["rgba(21,192,201,0.14)", "#0e9aa7", "eye"],
  sessions: ["rgba(123,107,255,0.14)", "#7b6bff", "users-round"],
  files: ["rgba(47,107,255,0.12)", "#2f6bff", "files"],
  received: ["", "", "download"],
  "drive free": ["rgba(31,178,122,0.14)", "#1fb27a", "hard-drive"],
};

export function renderStats() {
  const t = overview?.totals || {};
  const q = overview?.quota;
  const cards = [
    ["links", t.links || 0, "Drop links"],
    ["opens", t.opens || 0, "Link opens"],
    ["sessions", t.sessions || 0, "Upload visits"],
    ["files", (t.files || 0).toLocaleString(), "Files received"],
    ["received", fmtBytes(t.bytes || 0), "Data received"],
  ];
  if (q && q.free != null) cards.push(["drive free", fmtBytes(q.free), "Drive space left"]);
  reconcile(
    $("stats"),
    cards,
    ([label]) => label,
    ([label]) => {
      const el = document.createElement("div");
      el.className = "stat-card v3";
      const [tint, color, name] = STAT_ICONS[label] || STAT_ICONS.links;
      el.innerHTML = `<span class="stat-ico"${tint ? ` style="background:${tint};color:${color}"` : ""}>${icon(name)}</span><div><b></b><span class="stat-label"></span></div>`;
      el._value = el.querySelector("b");
      el._label = el.querySelector(".stat-label");
      return el;
    },
    (el, [, value, title]) => {
      if (el._label.textContent !== title) el._label.textContent = title;
      const text = String(value);
      if (el._value.textContent !== text) {
        el._value.textContent = text;
        el._value.classList.remove("tick");
        void el._value.offsetWidth;
        el._value.classList.add("tick");
      }
    },
  );
}


export function handleAdminAction(e) {
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
  const op = e.target.closest("[data-open-person]");
  if (op && op.dataset.openPerson) return document.dispatchEvent(new CustomEvent("admin:open-person", { detail: op.dataset.openPerson }));
  const pause = e.target.closest("[data-pause-link]");
  if (pause) return toggleLinkPause(pause.dataset.pauseLink, pause.dataset.paused === "1");
  const del = e.target.closest("[data-del-link]");
  if (del) return deleteLink(del.dataset.delLink, del.dataset.delLabel);
  const arc = e.target.closest("[data-archive-link]");
  if (arc) return toggleLinkArchive(arc.dataset.archiveLink, arc.dataset.archived === "1");
  const sarc = e.target.closest("[data-archive-share]");
  if (sarc) return toggleShareArchive(sarc.dataset.archiveShare, sarc.dataset.archived === "1");
  const spause = e.target.closest("[data-pause-share]");
  if (spause) return toggleSharePause(spause.dataset.pauseShare, spause.dataset.paused === "1");
  const sauth = e.target.closest("[data-toggle-share-auth]");
  if (sauth) return toggleShareAuth(sauth.dataset.toggleShareAuth, sauth.dataset.auth === "1");
  const sedit = e.target.closest("[data-edit-share]");
  if (sedit) return openShareEditor(sedit.dataset.editShare);
  const sdel = e.target.closest("[data-del-share]");
  if (sdel) return deleteShare(sdel.dataset.delShare, sdel.dataset.delLabel);
  const refresh = e.target.closest("[data-refresh-detail]");
  if (refresh) return refreshDetail(refresh.dataset.refreshDetail, false);
  const sync = e.target.closest("[data-sync-detail]");
  const shareActivity = e.target.closest("[data-view-share-activity]");
  if (shareActivity) {
    setActivityFilter("all");
    setActivityQuery(shareActivity.dataset.viewShareActivity);
    if ($("activity-query")) $("activity-query").value = activityQuery;
    document.querySelectorAll("[data-activity-filter]").forEach((button) => button.classList.toggle("active", button.dataset.activityFilter === "all"));
    renderEvents();
    return showTab("activity");
  }
  if (sync) return refreshDetail(sync.dataset.syncDetail, false, true);
  const goto = e.target.closest("[data-goto-tab]");
  if (goto) return showTab(goto.dataset.gotoTab);
  const removeShareFolder = e.target.closest("[data-remove-share-folder]");
  if (removeShareFolder) {
    shareSelectedFolders.delete(removeShareFolder.dataset.removeShareFolder);
    return renderShareFolderSelection();
  }
  const removeShareEditFolder = e.target.closest("[data-remove-share-edit-folder]");
  if (removeShareEditFolder) {
    shareEditSelectedFolders.delete(removeShareEditFolder.dataset.removeShareEditFolder);
    return renderShareEditFolders();
  }
  const trash = e.target.closest("[data-trash-upload]");
  if (trash) {
    trashUploadFromDetail(trash);
    return;
  }
  const prev = e.target.closest("[data-preview]");
  if (prev) return previewFile(prev.dataset.preview, prev);
  if (e.target.id === "qr-modal") $("qr-modal").close();
}

export function showQr(url, label) {
  const modal = $("qr-modal");
  const absoluteUrl = new URL(url, location.origin).href;
  if (!modal || typeof qrcode === "undefined") {
    navigator.clipboard?.writeText(absoluteUrl).catch(() => {});
    return;
  }
  try {
    const q = qrcode(0, "M");
    q.addData(absoluteUrl);
    q.make();
    $("qr-box").innerHTML = q.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
    setCurrentQrUrl(absoluteUrl);
    const isShare = new URL(absoluteUrl).pathname.startsWith("/s/");
    $("qr-kind").textContent = isShare ? "SHARE LINK" : "DROP LINK";
    $("qr-title").textContent = label || (isShare ? "Share gallery" : "Upload collection");
    $("qr-share").classList.toggle("hidden", !isShare);
    $("qr-caption").textContent = absoluteUrl;
    modal.showModal();
  } catch {
    navigator.clipboard?.writeText(absoluteUrl).catch(() => {});
  }
}

export function downloadCurrentQr() {
  const svg = $("qr-box")?.querySelector("svg");
  if (!svg || !currentQrUrl) return;
  const data = new XMLSerializer().serializeToString(svg);
  const blobUrl = URL.createObjectURL(new Blob([data], { type: "image/svg+xml;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = `${new URL(currentQrUrl).pathname.split("/").filter(Boolean).join("-") || "link"}-qr.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
}

export function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

export function openDriveFolder(slug) {
  const link = overview?.links?.find((l) => l.slug === slug);
  if (link?.folderId) {
    window.open(`https://drive.google.com/drive/folders/${encodeURIComponent(link.folderId)}`, "_blank");
  } else {
    refreshDetail(slug, true);
  }
}

export async function closeLiveSession(id, slug) {
  if (!id && !slug) return;
  await fetch("/api/admin/live/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, slug }),
  });
  setLiveActive(liveActive.filter((s) => s.id !== id));
  renderLive();
  if (currentDetailSlug) renderDetailLive(currentDetailSlug);
  refreshAll();
}

async function trashUploadFromDetail(button) {
  const ok = await confirmAction({
    title: "Move to Drive trash?",
    message: `"${button.dataset.trashName}" leaves this link's history and goes to Drive's trash, where it stays recoverable for 30 days.`,
    confirmLabel: "Move to trash",
  });
  if (!ok) return;
  button.disabled = true;
  try {
    const r = await fetch(`/api/admin/uploads/${encodeURIComponent(currentDetailSlug)}/${encodeURIComponent(button.dataset.trashUpload)}`, { method: "DELETE" });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "remove failed");
    refreshDetail(currentDetailSlug, false);
  } catch (err) {
    button.disabled = false;
    flash(button, err.message);
  }
}
