import { $, icon } from "./admin-state.js";

// System log tab: reads the app log kept in the live tracker's SQLite.

let wired = false;
let oldest = 0;
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : new Date(ts).toLocaleString();
};

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
  const html = rows.map((row) => `<div class="log-row" data-level="${esc(row.level)}"><span class="log-when" title="${new Date(row.at).toLocaleString()}">${ago(row.at)}</span><span class="log-area">${esc(row.area)}</span><span class="log-msg">${esc(row.message)}${row.detail ? `<details><summary>detail</summary><pre>${esc(row.detail)}</pre></details>` : ""}</span></div>`).join("");
  const moreBtn = rows.length === 200 ? `<button class="mini" id="logs-more" type="button">older…</button>` : "";
  if (more) {
    $("logs-more")?.remove();
    body.insertAdjacentHTML("beforeend", html + moreBtn);
  } else body.innerHTML = (html || `<p class="muted">Nothing logged yet.</p>`) + moreBtn;
}
