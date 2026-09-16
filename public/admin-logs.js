import { $, icon } from "./admin-state.js";

// System log tab: reads the app log kept in the live tracker's SQLite.

let wired = false;
const prettyDetail = (d) => {
  try {
    const o = JSON.parse(d);
    return typeof o === "object" ? JSON.stringify(o, null, 2) : d;
  } catch {
    return d;
  }
};
let oldest = 0;
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ts).toLocaleString();
};

// Errors in the last 24 h, grouped by area, for the nav badge and the strip.
let alerts = [];
export async function refreshAlertsBadge() {
  try {
    const r = await fetch("/api/admin/logs?level=error&limit=100");
    const d = await r.json();
    const since = Date.now() - 86400e3;
    alerts = (d.rows || []).filter((row) => row.at >= since);
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
  if (!alerts.length) return (strip.innerHTML = `<div class="alert-ok">${icon("shield-check")} No errors in the last 24 hours.</div>`);
  const byArea = {};
  for (const a of alerts) byArea[a.area] = (byArea[a.area] || 0) + 1;
  strip.innerHTML = `<div class="alert-head">${icon("triangle-alert")} <b>${alerts.length} error${alerts.length === 1 ? "" : "s"} in the last 24 h</b>${Object.entries(byArea).map(([area, n]) => `<button class="mini" type="button" data-alert-area="${escAttr(area)}">${esc(area)} <b>${n}</b></button>`).join("")}</div>
    <ul class="alert-list">${alerts.slice(0, 5).map((a) => `<li><span class="log-area">${esc(a.area)}</span><span>${esc(a.message)}</span><time class="muted">${ago(a.at)}</time></li>`).join("")}</ul>`;
}

export async function refreshLogs({ more = false } = {}) {
  const body = $("logs-body");
  if (!body) return;
  if (!wired) {
    wired = true;
    $("logs-area").addEventListener("change", () => refreshLogs());
    $("logs-level").addEventListener("change", () => refreshLogs());
    $("logs-refresh").addEventListener("click", () => refreshLogs());
    body.addEventListener("click", (e) => {
      if (e.target.closest("#logs-more")) refreshLogs({ more: true });
    });
    $("alerts-strip").addEventListener("click", (e) => {
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
    body.innerHTML = `<p class="muted">${icon("loader-circle", "ico-sm")} Loading…</p>`;
  }
  const params = new URLSearchParams({ limit: "200", area: $("logs-area").value, level: $("logs-level").value, before: String(oldest || 0) });
  const r = await fetch(`/api/admin/logs?${params}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return (body.innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(d.error || "log unavailable")}</p>`);
  const rows = d.rows || [];
  if (rows.length) oldest = rows[rows.length - 1].id;
  const html = rows.map((row, i) => `<div class="log-row rise" style="--i:${Math.min(i, 10)}" data-level="${esc(row.level)}"><span class="log-when" title="${new Date(row.at).toLocaleString()}">${ago(row.at)}</span><span class="log-area">${esc(row.area)}</span><span class="log-msg">${esc(row.message)}${row.detail ? `<details><summary>detail</summary><pre>${esc(prettyDetail(row.detail))}</pre></details>` : ""}</span></div>`).join("");
  const moreBtn = rows.length === 200 ? `<button class="mini" id="logs-more" type="button">older…</button>` : "";
  if (more) {
    $("logs-more")?.remove();
    body.insertAdjacentHTML("beforeend", html + moreBtn);
  } else body.innerHTML = (html || `<p class="muted">Nothing logged yet.</p>`) + moreBtn;
}
