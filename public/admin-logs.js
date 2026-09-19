import { $, icon } from "./admin-state.js";

// System log tab: reads the app log kept in the live tracker's SQLite.
// Rows are selectable (click, shift-click range, click-drag) for copying;
// errors can be marked read, which clears them from the badge and strip.
// ponytail: "read" lives in this browser's localStorage, not the DO.

let wired = false;
let oldest = 0;
let rows = [];
const selected = new Set();
let anchor = null;
let dragging = false;
const READ_KEY = "hd_log_read";
const readIds = () => {
  try {
    return new Set(JSON.parse(localStorage.getItem(READ_KEY) || "[]"));
  } catch {
    return new Set();
  }
};
const markRead = (ids) => {
  const set = readIds();
  for (const id of ids) set.add(Number(id));
  localStorage.setItem(READ_KEY, JSON.stringify([...set].slice(-800)));
};
const prettyDetail = (d) => {
  try {
    const o = JSON.parse(d);
    return typeof o === "object" ? JSON.stringify(o, null, 2) : d;
  } catch {
    return d;
  }
};
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ts).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
};
const lineOf = (r) => `${new Date(r.at).toISOString()}  ${r.level.toUpperCase().padEnd(5)}  ${r.area.padEnd(8)}  ${r.message}${r.detail ? `\n    ${prettyDetail(r.detail).replace(/\n/g, "\n    ")}` : ""}`;

// Errors in the last 24 h (unread), grouped by area, for the nav badge and strip.
let alerts = [];
export async function refreshAlertsBadge() {
  try {
    const r = await fetch("/api/admin/logs?level=error&limit=100");
    const d = await r.json();
    const since = Date.now() - 86400e3;
    const read = readIds();
    alerts = (d.rows || []).filter((row) => row.at >= since && !read.has(row.id));
  } catch {
    alerts = [];
  }
  const badge = $("alerts-badge");
  if (badge) {
    badge.textContent = String(alerts.length);
    badge.classList.toggle("hidden", !alerts.length);
  }
  renderAlertsStrip();
}
function renderAlertsStrip() {
  const strip = $("alerts-strip");
  if (!strip) return;
  if (!alerts.length) return (strip.innerHTML = `<div class="alert-ok">${icon("shield-check")} No unread errors in the last 24 hours.</div>`);
  const byArea = {};
  for (const a of alerts) byArea[a.area] = (byArea[a.area] || 0) + 1;
  strip.innerHTML = `<div class="alert-head">${icon("triangle-alert")} <b>${alerts.length} unread error${alerts.length === 1 ? "" : "s"} in the last 24 h</b>${Object.entries(byArea).map(([area, n]) => `<button class="mini" type="button" data-alert-area="${escAttr(area)}">${esc(area)} <b>${n}</b></button>`).join("")}<button class="mini" type="button" id="alerts-read-all" style="margin-left:auto">${icon("check", "ico-sm")} mark all read</button></div>
    <ul class="alert-list">${alerts.slice(0, 5).map((a) => `<li><span class="log-area">${esc(a.area)}</span><span>${esc(a.message)}</span><time class="muted">${ago(a.at)}</time></li>`).join("")}</ul>`;
}

const toolbar = () => {
  const n = selected.size;
  const errs = [...selected].filter((id) => rows.find((r) => r.id === id)?.level === "error").length;
  return `<div class="log-toolbar${n ? "" : " is-idle"}"><span>${n ? `<b>${n}</b> selected` : "click rows to select · shift-click for a range · drag to sweep"}</span>${n ? `<button class="mini" type="button" id="logs-copy">${icon("copy", "ico-sm")} copy</button>${errs ? `<button class="mini" type="button" id="logs-read">${icon("check", "ico-sm")} mark ${errs} read</button>` : ""}<button class="link-like" type="button" id="logs-clear">clear</button>` : `<button class="mini" type="button" id="logs-select-all">select all</button>`}</div>`;
};
const rowHtml = (row, i, read) => `<div class="log-row rise${selected.has(row.id) ? " is-selected" : ""}${read.has(row.id) ? " is-read" : ""}" style="--i:${Math.min(i, 10)}" data-level="${esc(row.level)}" data-id="${row.id}"><span class="log-check">${icon("check", "ico-sm")}</span><span class="log-when" title="${new Date(row.at).toLocaleString()}">${ago(row.at)}</span><span class="log-area">${esc(row.area)}</span><span class="log-msg">${esc(row.message)}${row.detail ? `<details><summary>detail</summary><pre>${esc(prettyDetail(row.detail))}</pre></details>` : ""}</span></div>`;
function paintSelection() {
  for (const el of $("logs-body").querySelectorAll(".log-row")) el.classList.toggle("is-selected", selected.has(Number(el.dataset.id)));
  $("logs-tools").innerHTML = toolbar();
}
function select(id, { range = false, toggle = true, on } = {}) {
  const ids = rows.map((r) => r.id);
  if (range && anchor != null) {
    const [a, b] = [ids.indexOf(anchor), ids.indexOf(id)].sort((x, y) => x - y);
    for (const x of ids.slice(a, b + 1)) selected.add(x);
  } else if (on != null) on ? selected.add(id) : selected.delete(id);
  else if (toggle && selected.has(id)) selected.delete(id);
  else selected.add(id);
  if (!range) anchor = id;
  paintSelection();
}

export async function refreshLogs({ more = false } = {}) {
  const body = $("logs-body");
  if (!body) return;
  if (!wired) {
    wired = true;
    $("logs-area").addEventListener("change", () => refreshLogs());
    $("logs-level").addEventListener("change", () => refreshLogs());
    $("logs-refresh").addEventListener("click", () => refreshLogs());
    body.addEventListener("mousedown", (e) => {
      const row = e.target.closest(".log-row");
      if (!row || e.target.closest("details, a, button")) return;
      e.preventDefault();
      dragging = true;
      select(Number(row.dataset.id), { range: e.shiftKey });
    });
    body.addEventListener("mouseover", (e) => {
      const row = dragging && e.target.closest(".log-row");
      if (row) select(Number(row.dataset.id), { on: true, toggle: false });
    });
    addEventListener("mouseup", () => (dragging = false));
    body.addEventListener("click", (e) => {
      if (e.target.closest("#logs-more")) refreshLogs({ more: true });
    });
    $("logs-tools").addEventListener("click", async (e) => {
      if (e.target.closest("#logs-select-all")) {
        rows.forEach((r) => selected.add(r.id));
        return paintSelection();
      }
      if (e.target.closest("#logs-clear")) {
        selected.clear();
        return paintSelection();
      }
      if (e.target.closest("#logs-copy")) {
        await navigator.clipboard.writeText(rows.filter((r) => selected.has(r.id)).map(lineOf).join("\n"));
        const b = $("logs-copy");
        b.textContent = "copied";
        return setTimeout(paintSelection, 1200);
      }
      if (e.target.closest("#logs-read")) {
        markRead([...selected]);
        selected.clear();
        await refreshAlertsBadge();
        return refreshLogs();
      }
    });
    $("alerts-strip").addEventListener("click", async (e) => {
      if (e.target.closest("#alerts-read-all")) {
        markRead(alerts.map((a) => a.id));
        await refreshAlertsBadge();
        return refreshLogs();
      }
      const b = e.target.closest("[data-alert-area]");
      if (!b) return;
      $("logs-area").value = b.dataset.alertArea;
      $("logs-level").value = "error";
      refreshLogs();
    });
    refreshAlertsBadge();
  }
  if (!more) {
    oldest = 0;
    rows = [];
    selected.clear();
    body.innerHTML = `<p class="muted">${icon("loader-circle", "ico-sm")} Loading…</p>`;
  }
  const params = new URLSearchParams({ limit: "200", area: $("logs-area").value, level: $("logs-level").value, before: String(oldest || 0) });
  const r = await fetch(`/api/admin/logs?${params}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return (body.innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(d.error || "log unavailable")}</p>`);
  const page = d.rows || [];
  if (page.length) oldest = page[page.length - 1].id;
  rows = more ? rows.concat(page) : page;
  const read = readIds();
  const html = page.map((row, i) => rowHtml(row, i, read)).join("");
  const moreBtn = page.length === 200 ? `<button class="mini" id="logs-more" type="button">older…</button>` : "";
  if (more) {
    $("logs-more")?.remove();
    body.insertAdjacentHTML("beforeend", html + moreBtn);
  } else body.innerHTML = (html || `<p class="muted">Nothing logged yet.</p>`) + moreBtn;
  $("logs-tools").innerHTML = toolbar();
}
