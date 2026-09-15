import { $, icon } from "./admin-state.js";
import { flash } from "./admin.js";

// Video previews tab: what the transcoder has done, what is left, per
// folder, run history, and "process now" controls.

let data = null;
let pollTimer = 0;
let selectedFolders = new Set();

const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};
const until = (ts) => {
  const s = Math.max(0, Math.round((ts - Date.now()) / 1000));
  return s < 3600 ? `in ${Math.max(1, Math.round(s / 60))} min` : `in ${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

export async function refreshPreviews({ fresh = false } = {}) {
  const host = $("previews-body");
  if (!host) return;
  host.setAttribute("aria-busy", "true");
  try {
    const r = await fetch(`/api/admin/previews/overview${fresh ? "?fresh=1" : ""}`);
    if (!r.ok) throw new Error(`overview ${r.status}`);
    data = await r.json();
    render();
  } catch (error) {
    host.innerHTML = `<div class="empty-state"><p>${icon("circle-alert")} Could not load preview status.</p><p class="muted">${esc(error.message)}</p></div>`;
  } finally {
    host.removeAttribute("aria-busy");
  }
  clearTimeout(pollTimer);
  // Poll while a run is active so the counters move without a manual refresh.
  if (data?.active && !$("tab-previews").classList.contains("hidden")) pollTimer = setTimeout(() => refreshPreviews({ fresh: true }), 20_000);
}

export function stopPreviewsPolling() {
  clearTimeout(pollTimer);
  pollTimer = 0;
}

function render() {
  const { totals: t, folders, failed, runs, active, nextRunAt, dispatchConfigured, queue } = data;
  const done = t.ready;
  const saved = t.bytes && t.previewBytes ? t.bytes - t.previewBytes : 0;
  const cards = [
    ["film", t.videos, "Videos in shares"],
    ["circle-check", `${done} · ${pct(done, t.videos)}%`, "Previews ready"],
    ["clock", t.pending, "Waiting"],
    ["triangle-alert", t.failed, "Failed (3 tries)"],
    ["hard-drive", fmtBytes(t.previewBytes), `Preview storage (originals ${fmtBytes(t.bytes)})`],
  ];
  const stateLine = active
    ? `<span class="status-pill" data-state="live">run in progress · started ${ago(active.startedAt)}</span> <a class="mini" href="${esc(active.url)}" target="_blank" rel="noopener">open on GitHub ${icon("external-link", "ico-sm")}</a>`
    : `<span class="status-pill" data-state="paused">idle · next scheduled run ${until(nextRunAt)} (03:00 IST)</span>`;
  const queueLine = queue && (queue.folderIds?.length || queue.fileIds?.length)
    ? `<p class="muted">Queued for the next run: ${queue.folderIds.length} folder(s), ${queue.fileIds.length} file(s).</p>`
    : "";
  const dispatchNote = dispatchConfigured
    ? ""
    : `<p class="muted">${icon("info", "ico-sm")} "Run now" needs a <code>GITHUB_TOKEN</code> secret on the worker (fine-grained PAT, Actions: read &amp; write). Until then, queued work runs on the nightly schedule.</p>`;

  $("previews-body").innerHTML = `
    <div class="stat-grid">${cards.map(([name, value, label]) => `<div class="stat-card v3"><span class="stat-ico">${icon(name)}</span><div><b>${esc(String(value))}</b><span class="stat-label">${esc(label)}</span></div></div>`).join("")}</div>
    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">transcoder</p><h2>${icon("zap")} Runs</h2></div>
        <div class="section-tools previews-tools">
          <label class="muted">limit <input id="previews-limit" class="previews-limit" type="number" min="1" max="300" value="40" aria-label="Videos per run"></label>
          <button class="btn" id="previews-run" type="button" ${active ? "disabled" : ""}>${icon("play", "ico-sm")} Run now</button>
          <button class="mini" id="previews-refresh" type="button">${icon("refresh-cw", "ico-sm")} Rescan</button>
        </div>
      </div>
      <div class="previews-state">${stateLine}</div>
      ${queueLine}${dispatchNote}
      <p class="muted">Saved ${fmtBytes(saved)} of streaming per full playthrough: viewers get a 720p copy on hover and first play, HD on demand.</p>
      ${runs.length ? `<div class="upload-table-wrap"><table class="uploads previews-runs"><thead><tr><th>Run</th><th>Started</th><th class="num">Done</th><th class="num">Skipped</th><th class="num">In → out</th><th>Status</th></tr></thead><tbody>${runs.map(runRow).join("")}</tbody></table></div>` : `<p class="muted">No runs recorded yet.</p>`}
    </section>
    <section class="panel">
      <div class="section-title"><div><p class="eyebrow">by folder</p><h2>${icon("folder")} Coverage</h2></div>
        <div class="section-tools"><button class="mini" id="previews-run-selected" type="button" disabled>${icon("play", "ico-sm")} Process selected</button></div>
      </div>
      ${folders.length ? `<div class="upload-table-wrap"><table class="uploads previews-folders"><thead><tr><th></th><th>Folder</th><th>Share</th><th class="num">Videos</th><th class="num">Ready</th><th class="num">Waiting</th><th class="num">Failed</th><th>Progress</th><th></th></tr></thead><tbody>${folders.map(folderRow).join("")}</tbody></table></div>` : `<p class="muted">No active shares with folders.</p>`}
    </section>
    ${failed.length ? `<section class="panel">
      <div class="section-title"><div><p class="eyebrow">needs attention</p><h2>${icon("triangle-alert")} Failed files</h2></div>
        <div class="section-tools"><button class="mini" id="previews-retry-all" type="button">${icon("refresh-cw", "ico-sm")} Retry all</button></div></div>
      <div class="upload-table-wrap"><table class="uploads"><thead><tr><th>File</th><th>Error</th><th class="num">Tries</th><th class="num">Last</th><th></th></tr></thead><tbody>
        ${failed.map((f) => `<tr><td>${esc(f.name)}</td><td class="muted">${esc(f.error)}</td><td class="num">${f.tries}</td><td class="num">${ago(f.at)}</td><td><button class="mini" data-retry="${escAttr(f.id)}" type="button">retry</button></td></tr>`).join("")}
      </tbody></table></div>
    </section>` : ""}
  `;
  wire();
}

function runRow(run) {
  const finished = !!run.finishedAt;
  const status = finished ? `${icon("circle-check", "ico-sm")} finished ${ago(run.finishedAt)}${run.pendingLeft ? ` · ${run.pendingLeft} left` : ""}` : `${icon("loader-circle", "ico-sm")} running`;
  const items = run.items || [];
  const detail = items.length ? `<details class="previews-run-items"><summary>${items.length} files</summary><ul>${items.slice().reverse().map((i) => `<li>${i.ok ? icon("check", "ico-sm") : icon("circle-x", "ico-sm")} ${esc(i.name)} ${i.ok ? `<span class="muted">${fmtBytes(i.size)} → ${fmtBytes(i.previewSize)} · ${fmtTime(i.ms / 1000)}</span>` : `<span class="muted">${esc(i.error)}</span>`}</li>`).join("")}</ul></details>` : "";
  return `<tr><td>${esc(run.trigger)} <span class="muted">#${esc(String(run.id).slice(-6))}</span>${detail}</td><td>${ago(run.startedAt)}</td><td class="num">${run.done}</td><td class="num">${run.skipped}</td><td class="num">${fmtBytes(run.bytes)} → ${fmtBytes(run.previewBytes)}</td><td>${status}</td></tr>`;
}

function folderRow(f) {
  const p = pct(f.ready, f.videos);
  const state = !f.videos ? "empty" : f.ready === f.videos ? "done" : f.failed && f.ready + f.failed === f.videos ? "failed" : "partial";
  return `<tr data-state="${state}"><td><input type="checkbox" data-folder="${escAttr(f.folderId)}" aria-label="select ${escAttr(f.name)}" ${f.videos && f.ready < f.videos ? "" : "disabled"}></td>
    <td>${"&nbsp;&nbsp;".repeat(f.depth)}${icon(f.depth ? "folder" : "folder-open", "ico-sm")} ${esc(f.name)}</td><td class="muted">${esc(f.label)}</td>
    <td class="num">${f.videos}</td><td class="num">${f.ready}</td><td class="num">${f.pending}</td><td class="num">${f.failed || ""}</td>
    <td><span class="previews-bar" aria-label="${p}% ready"><i style="width:${p}%"></i></span> <span class="muted">${p}%</span></td>
    <td>${f.videos && f.ready < f.videos ? `<button class="mini" data-run-folder="${escAttr(f.folderId)}" type="button">process</button>` : `<span class="muted">${f.videos ? "done" : "—"}</span>`}</td></tr>`;
}

function wire() {
  const host = $("previews-body");
  selectedFolders = new Set();
  host.querySelector("#previews-refresh")?.addEventListener("click", () => refreshPreviews({ fresh: true }));
  host.querySelector("#previews-run")?.addEventListener("click", (e) => run(e.currentTarget, { limit: Number($("previews-limit").value) || 40 }));
  host.querySelector("#previews-run-selected")?.addEventListener("click", (e) => run(e.currentTarget, { folderIds: [...selectedFolders], limit: Number($("previews-limit").value) || 40 }));
  host.querySelector("#previews-retry-all")?.addEventListener("click", (e) => retry(e.currentTarget, []));
  host.addEventListener("click", (e) => {
    const folder = e.target.closest("[data-run-folder]");
    if (folder) return run(folder, { folderIds: [folder.dataset.runFolder], limit: 300 });
    const one = e.target.closest("[data-retry]");
    if (one) return retry(one, [one.dataset.retry]);
  });
  host.addEventListener("change", (e) => {
    const box = e.target.closest("[data-folder]");
    if (!box) return;
    box.checked ? selectedFolders.add(box.dataset.folder) : selectedFolders.delete(box.dataset.folder);
    host.querySelector("#previews-run-selected").disabled = !selectedFolders.size;
  });
}

async function run(button, body) {
  button.disabled = true;
  try {
    const r = await post("/api/admin/previews/run", body);
    const d = await r.json().catch(() => ({}));
    flash(button, d.dispatched ? "run started" : d.reason || "queued for the nightly run");
    setTimeout(() => refreshPreviews({ fresh: true }), 2500);
  } catch (error) {
    flash(button, error.message);
    button.disabled = false;
  }
}

async function retry(button, fileIds) {
  button.disabled = true;
  const r = await post("/api/admin/previews/retry", { fileIds });
  flash(button, r.ok ? "cleared - picked up next run" : "retry failed");
  setTimeout(() => refreshPreviews(), 800);
}
