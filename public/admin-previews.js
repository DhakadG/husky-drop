import { $, icon } from "./admin-state.js";
import { flash } from "./admin.js";

// Video previews tab: real-time transcoder status, coverage, run history,
// and process/retry controls. Powered by live WebSocket updates from the runner.
// Progressive decoupled architecture: fast overview (<50ms) renders metrics & runs
// immediately, while Drive folder crawling runs independently with skeleton states.

let data = null;
let liveState = null;
let coverageLoading = false;
let rendered = false;
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

export function renderSkeletons() {
  const host = $("previews-body");
  if (!host) return;
  host.innerHTML = `
    <div class="stat-grid" id="previews-stat-grid">
      <div class="stat-card v3 skel"><div class="stat-skel-ico skel-bone"></div><div><div class="stat-skel-val skel-bone"></div><div class="stat-skel-lbl skel-bone"></div></div></div>
      <div class="stat-card v3 skel"><div class="stat-skel-ico skel-bone"></div><div><div class="stat-skel-val skel-bone"></div><div class="stat-skel-lbl skel-bone"></div></div></div>
      <div class="stat-card v3 skel"><div class="stat-skel-ico skel-bone"></div><div><div class="stat-skel-val skel-bone"></div><div class="stat-skel-lbl skel-bone"></div></div></div>
      <div class="stat-card v3 skel"><div class="stat-skel-ico skel-bone"></div><div><div class="stat-skel-val skel-bone"></div><div class="stat-skel-lbl skel-bone"></div></div></div>
      <div class="stat-card v3 skel"><div class="stat-skel-ico skel-bone"></div><div><div class="stat-skel-val skel-bone"></div><div class="stat-skel-lbl skel-bone"></div></div></div>
    </div>
    <div id="previews-live-wrap"></div>
    <section class="panel" id="previews-runs-section">
      <div class="section-title"><div><p class="eyebrow">transcoder</p><h2>${icon("zap")} Runs</h2></div>
        <div class="section-tools previews-tools">
          <label class="muted">limit <input id="previews-limit" class="previews-limit" type="number" min="1" max="1000" value="300" aria-label="Videos per run" disabled></label>
          <button class="btn" id="previews-run" type="button" disabled>${icon("play", "ico-sm")} Run now</button>
          <button class="mini" id="previews-refresh" type="button" disabled><svg class="ico ico-sm spin" aria-hidden="true"><use href="/icons.svg#refresh-cw"></use></svg> Loading…</button>
        </div>
      </div>
      <div class="upload-table-wrap">
        <table class="uploads previews-runs">
          <thead><tr><th>Run</th><th>Started</th><th class="num">Done</th><th class="num">Skipped</th><th class="num">In → out</th><th>Status</th></tr></thead>
          <tbody>
            <tr class="table-skel-row"><td><div class="table-skel-cell skel-bone" style="width:120px"></div></td><td><div class="table-skel-cell skel-bone" style="width:60px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:30px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:90px"></div></td><td><div class="table-skel-cell skel-bone" style="width:80px"></div></td></tr>
            <tr class="table-skel-row"><td><div class="table-skel-cell skel-bone" style="width:100px"></div></td><td><div class="table-skel-cell skel-bone" style="width:55px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:35px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:30px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:85px"></div></td><td><div class="table-skel-cell skel-bone" style="width:75px"></div></td></tr>
          </tbody>
        </table>
      </div>
    </section>
    <section class="panel" id="previews-coverage-section">
      <div class="section-title"><div><p class="eyebrow">by folder</p><h2>${icon("folder")} Coverage</h2></div>
        <div class="section-tools"><span class="coverage-loading-badge"><svg class="ico ico-sm spin" aria-hidden="true"><use href="/icons.svg#loader-circle"></use></svg> Scanning folders…</span></div>
      </div>
      <div class="upload-table-wrap">
        <table class="uploads previews-folders">
          <thead><tr><th></th><th>Folder</th><th>Share</th><th class="num">Videos</th><th class="num">Ready</th><th class="num">Waiting</th><th class="num">Failed</th><th>Progress</th><th></th></tr></thead>
          <tbody>
            <tr class="table-skel-row"><td></td><td><div class="table-skel-cell skel-bone" style="width:140px"></div></td><td><div class="table-skel-cell skel-bone" style="width:80px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:30px"></div></td><td><div class="table-skel-cell skel-bone" style="width:110px"></div></td><td></td></tr>
            <tr class="table-skel-row"><td></td><td><div class="table-skel-cell skel-bone" style="width:180px"></div></td><td><div class="table-skel-cell skel-bone" style="width:80px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:30px"></div></td><td><div class="table-skel-cell skel-bone" style="width:90px"></div></td><td></td></tr>
            <tr class="table-skel-row"><td></td><td><div class="table-skel-cell skel-bone" style="width:120px"></div></td><td><div class="table-skel-cell skel-bone" style="width:80px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:30px"></div></td><td><div class="table-skel-cell skel-bone" style="width:130px"></div></td><td></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
}

export async function refreshPreviews({ fresh = false } = {}) {
  const host = $("previews-body");
  if (!host) return;

  // If data isn't loaded yet and host doesn't have stat cards, render skeletons
  if (!data && !host.querySelector(".stat-card")) {
    renderSkeletons();
  }

  try {
    const r = await fetch(`/api/admin/previews/overview${fresh ? "?fresh=1" : ""}`);
    if (!r.ok) throw new Error(`overview ${r.status}`);
    const next = await r.json();
    // Coverage lives behind its own endpoint. A refresh must never throw away
    // folders we already have, or the table collapses back to a skeleton and
    // kicks off another 3k-file Drive crawl on every poll.
    if (data?.folders && !next.folders) {
      next.folders = data.folders;
      // Keep the crawl's video count, take the index's fresh ready/failed.
      next.totals = {
        ...data.totals,
        ready: next.totals.ready,
        failed: next.totals.failed,
        previewBytes: next.totals.previewBytes,
        pending: Math.max(0, data.totals.videos - next.totals.ready - next.totals.failed),
      };
      next.foldersLoading = false;
    }
    data = next;
    if (data.live) liveState = data.live;
    if (rendered) patch();
    else render();

    if (!data.folders && !coverageLoading) loadCoverage();
  } catch (error) {
    if (!data) {
      rendered = false;
      host.innerHTML = `<div class="empty-state"><p>${icon("circle-alert")} Could not load preview status.</p><p class="muted">${esc(error.message)}</p></div>`;
    }
  }

  clearTimeout(pollTimer);
  // Gentle fallback poll only if an active GitHub action run is reported and WebSocket is inactive
  if ((data?.active || liveState?.active) && !$("tab-previews")?.classList.contains("hidden")) {
    pollTimer = setTimeout(() => refreshPreviews(), 20_000);
  }
}

// In-place refresh of everything except the coverage table. A full re-render on
// every poll/WebSocket tick is what made the tab flicker and dropped folder
// checkboxes and scroll position mid-click.
function patch() {
  if (!data) return;
  updateStatCards(data.totals);
  const liveWrap = $("previews-live-wrap");
  if (liveWrap) liveWrap.innerHTML = liveState?.active ? renderLivePanel(liveState) : "";
  const runs = $("previews-runs-section");
  if (runs) runs.outerHTML = renderRunsPanel();
  const failedWrap = $("previews-failed-wrap");
  if (failedWrap) failedWrap.innerHTML = renderFailedSection(data.failed || []);
}

export function stopPreviewsPolling() {
  clearTimeout(pollTimer);
  pollTimer = 0;
}

// Background decoupled folder coverage loader
export async function loadCoverage({ fresh = false } = {}) {
  if (coverageLoading) return; // one Drive crawl at a time, `fresh` included
  coverageLoading = true;

  // Keep any table we already have on screen while re-scanning; only the very
  // first load gets the skeleton.
  const coverageSection = $("previews-coverage-section");
  if (coverageSection && !data?.folders) coverageSection.outerHTML = renderCoverageLoading();

  try {
    // A cold Drive crawl can hang until Cloudflare gives up with a 524. Bound it
    // here too, or `coverageLoading` stays true and blocks every later scan.
    const r = await fetch(`/api/admin/previews/coverage${fresh ? "?fresh=1" : ""}`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`coverage ${r.status}`);
    const cov = await r.json();
    if (!data) data = {};
    data.folders = cov.folders || [];
    data.totals = cov.totals || data.totals;
    data.failed = cov.failed || data.failed;
    data.foldersLoading = false;

    // Update stat card counters in place
    updateStatCards(data.totals);

    // Swap in the real table. Selection belongs to the rows being replaced.
    selectedFolders = new Set();
    const curSection = $("previews-coverage-section");
    if (curSection) curSection.outerHTML = renderCoveragePanel(data.folders);

    // Update failed files section if new failures detected
    if (data.failed && data.failed.length) {
      const failedWrap = $("previews-failed-wrap");
      if (failedWrap) failedWrap.innerHTML = renderFailedSection(data.failed);
    }
  } catch (error) {
    const section = $("previews-coverage-section");
    if (section) {
      section.innerHTML = `
        <div class="section-title"><div><p class="eyebrow">by folder</p><h2>${icon("folder")} Coverage</h2></div>
          <div class="section-tools"><button class="mini" id="previews-retry-coverage" type="button">${icon("refresh-cw", "ico-sm")} Retry scan</button></div>
        </div>
        <div class="coverage-error-strip">
          <p class="img-bad">${icon("circle-alert", "ico-sm")} Could not scan Drive folders: ${esc(error.message)}</p>
          <span class="muted">Stats and runs above remain functional</span>
        </div>
      `;
    }
  } finally {
    coverageLoading = false;
  }
}

// Real-time update dispatched directly from the WebSocket connection
export function updatePreviewsLive(live) {
  if (!live) return;
  const wasActive = liveState?.active;
  liveState = live;

  // Only the live panel changes on a telemetry tick - never re-render the tab.
  if ($("tab-previews") && !$("tab-previews").classList.contains("hidden")) {
    const liveWrap = $("previews-live-wrap");
    if (liveWrap) liveWrap.innerHTML = live.active ? renderLivePanel(live) : "";
    if (live.active) updateTopCountersLive(live);
  }

  // When a run ends, pick up the final numbers once.
  if (wasActive && !live.active) setTimeout(() => { refreshPreviews(); loadCoverage(); }, 1500);
}

function updateTopCountersLive(live) {
  if (!data?.totals || live.done == null) return;
  const readyEl = $("stat-previews-ready");
  const waitEl = $("stat-previews-waiting");
  const effectiveReady = data.totals.ready + (live.done || 0);
  if (readyEl) readyEl.textContent = readyLabel(effectiveReady, data.totals.videos);
  if (waitEl && data.totals.pending != null) {
    waitEl.textContent = String(Math.max(0, data.totals.pending - (live.done || 0)));
  }
}

// Totals that depend on the Drive crawl are null until coverage lands. Show a
// placeholder rather than a confident wrong number (the old code reported
// "420 · 100%" while 3,200 videos had no preview at all).
const num = (v) => (v == null ? "…" : String(v));
const readyLabel = (ready, videos) => (videos == null ? String(ready) : `${ready} · ${pct(ready, videos)}%`);

function updateStatCards(t) {
  if (!t) return;
  const vTotal = $("stat-previews-total");
  const vReady = $("stat-previews-ready");
  const vWait = $("stat-previews-waiting");
  const vFail = $("stat-previews-failed");
  const vStore = $("stat-previews-storage");

  if (vTotal) vTotal.textContent = num(t.videos);
  if (vReady) vReady.textContent = readyLabel(t.ready, t.videos);
  if (vWait) vWait.textContent = num(t.pending);
  if (vFail) vFail.textContent = num(t.failed);
  if (vStore) vStore.textContent = `${fmtBytes(t.previewBytes)}${t.bytes ? ` (originals ${fmtBytes(t.bytes)})` : ""}`;
}

function render() {
  const host = $("previews-body");
  if (!host || !data) return;

  const { totals: t, folders, failed = [] } = data;

  const cards = [
    ["film", num(t.videos), "Videos in shares", "stat-previews-total"],
    ["circle-check", readyLabel(t.ready, t.videos), "Previews ready", "stat-previews-ready"],
    ["clock", num(t.pending), "Waiting", "stat-previews-waiting"],
    ["triangle-alert", num(t.failed), "Failed (3 tries)", "stat-previews-failed"],
    ["hard-drive", fmtBytes(t.previewBytes), t.bytes ? `Preview storage (originals ${fmtBytes(t.bytes)})` : "Preview storage", "stat-previews-storage"],
  ];

  host.innerHTML = `
    <div class="stat-grid" id="previews-stat-grid">${cards.map(([name, value, label, id]) => `<div class="stat-card v3"><span class="stat-ico">${icon(name)}</span><div><b id="${id}">${esc(String(value))}</b><span class="stat-label">${esc(label)}</span></div></div>`).join("")}</div>

    <div id="previews-live-wrap">${liveState?.active ? renderLivePanel(liveState) : ""}</div>

    ${renderRunsPanel()}

    ${folders && Array.isArray(folders) ? renderCoveragePanel(folders) : renderCoverageLoading()}

    <div id="previews-failed-wrap">
      ${failed && failed.length ? renderFailedSection(failed) : ""}
    </div>
  `;
  rendered = true;
  wire();
}

function renderRunsPanel() {
  const { totals: t, runs = [], active, nextRunAt, dispatchConfigured, queue } = data;
  const saved = t.bytes && t.previewBytes ? t.bytes - t.previewBytes : 0;
  const isTranscoderActive = liveState?.active;
  const limit = $("previews-limit")?.value || "300";

  const stateLine = isTranscoderActive
    ? `<span class="status-pill" data-state="live"><i class="status-dot-pulse"></i> real-time transcoder active · ${liveState.parallel || 1} workers</span>`
    : active
    ? `<span class="status-pill" data-state="live">run in progress · started ${ago(active.startedAt)}</span> <a class="mini" href="${esc(active.url)}" target="_blank" rel="noopener">open on GitHub ${icon("external-link", "ico-sm")}</a>`
    : `<span class="status-pill" data-state="paused">idle · next scheduled run ${until(nextRunAt)} (03:00 IST)</span>`;

  const queueLine = queue && (queue.folderIds?.length || queue.fileIds?.length)
    ? `<p class="muted">Queued for the next run: ${queue.folderIds.length} folder(s), ${queue.fileIds.length} file(s).</p>`
    : "";
  const dispatchNote = dispatchConfigured
    ? ""
    : `<p class="muted">${icon("info", "ico-sm")} "Run now" needs a <code>GITHUB_TOKEN</code> secret on the worker (fine-grained PAT, Actions: read &amp; write). Until then, queued work runs on the nightly schedule.</p>`;

  return `
    <section class="panel" id="previews-runs-section">
      <div class="section-title"><div><p class="eyebrow">transcoder</p><h2>${icon("zap")} Runs</h2></div>
        <div class="section-tools previews-tools">
          <label class="muted">limit <input id="previews-limit" class="previews-limit" type="number" min="1" max="1000" value="${escAttr(limit)}" aria-label="Videos per run"></label>
          <button class="btn" id="previews-run" type="button" ${active || isTranscoderActive ? "disabled" : ""}>${icon("play", "ico-sm")} Run now</button>
          <button class="mini" id="previews-refresh" type="button">${icon("refresh-cw", "ico-sm")} Rescan</button>
        </div>
      </div>
      <div class="previews-state">${stateLine}</div>
      ${queueLine}${dispatchNote}
      <p class="muted">Saved ${fmtBytes(saved)} of streaming per full playthrough: viewers get a 720p copy on hover and first play, HD on demand.</p>
      ${runs.length ? `<div class="upload-table-wrap"><table class="uploads previews-runs"><thead><tr><th>Run</th><th>Started</th><th class="num">Done</th><th class="num">Skipped</th><th class="num">In → out</th><th>Status</th></tr></thead><tbody>${runs.map((run) => runRow(run, active)).join("")}</tbody></table></div>` : `<p class="muted">No runs recorded yet.</p>`}
    </section>
  `;
}

function renderCoverageLoading() {
  return `
    <section class="panel" id="previews-coverage-section">
      <div class="section-title"><div><p class="eyebrow">by folder</p><h2>${icon("folder")} Coverage</h2></div>
        <div class="section-tools"><span class="coverage-loading-badge"><svg class="ico ico-sm spin" aria-hidden="true"><use href="/icons.svg#loader-circle"></use></svg> Scanning Drive folders…</span></div>
      </div>
      <div class="coverage-loading-bar">
        <span class="muted">${icon("info", "ico-sm")} Scanning Google Drive for video files in background. Transcoder and runs are ready above.</span>
      </div>
      <div class="upload-table-wrap">
        <table class="uploads previews-folders">
          <thead><tr><th></th><th>Folder</th><th>Share</th><th class="num">Videos</th><th class="num">Ready</th><th class="num">Waiting</th><th class="num">Failed</th><th>Progress</th><th></th></tr></thead>
          <tbody>
            <tr class="table-skel-row"><td></td><td><div class="table-skel-cell skel-bone" style="width:140px"></div></td><td><div class="table-skel-cell skel-bone" style="width:80px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:30px"></div></td><td><div class="table-skel-cell skel-bone" style="width:110px"></div></td><td></td></tr>
            <tr class="table-skel-row"><td></td><td><div class="table-skel-cell skel-bone" style="width:180px"></div></td><td><div class="table-skel-cell skel-bone" style="width:80px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:30px"></div></td><td><div class="table-skel-cell skel-bone" style="width:90px"></div></td><td></td></tr>
            <tr class="table-skel-row"><td></td><td><div class="table-skel-cell skel-bone" style="width:120px"></div></td><td><div class="table-skel-cell skel-bone" style="width:80px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:40px"></div></td><td class="num"><div class="table-skel-cell skel-bone" style="width:30px"></div></td><td><div class="table-skel-cell skel-bone" style="width:130px"></div></td><td></td></tr>
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderCoveragePanel(folders) {
  return `
    <section class="panel" id="previews-coverage-section">
      <div class="section-title"><div><p class="eyebrow">by folder</p><h2>${icon("folder")} Coverage</h2></div>
        <div class="section-tools">
          <button class="mini" id="previews-run-selected" type="button" disabled>${icon("play", "ico-sm")} Process selected</button>
          <button class="mini" id="previews-rescan-coverage" type="button" title="Rescan Drive folders">${icon("refresh-cw", "ico-sm")} Rescan</button>
        </div>
      </div>
      ${folders.length ? `<div class="upload-table-wrap"><table class="uploads previews-folders"><thead><tr><th></th><th>Folder</th><th>Share</th><th class="num">Videos</th><th class="num">Ready</th><th class="num">Waiting</th><th class="num">Failed</th><th>Progress</th><th></th></tr></thead><tbody>${folders.map(folderRow).join("")}</tbody></table></div>` : `<p class="muted">No active shares with folders.</p>`}
    </section>
  `;
}

function renderFailedSection(failed) {
  if (!failed || !failed.length) return "";
  return `
    <section class="panel" id="previews-failed-section">
      <div class="section-title"><div><p class="eyebrow">needs attention</p><h2>${icon("triangle-alert")} Failed files</h2></div>
        <div class="section-tools"><button class="mini" id="previews-retry-all" type="button">${icon("refresh-cw", "ico-sm")} Retry all</button></div></div>
      <div class="upload-table-wrap"><table class="uploads"><thead><tr><th>File</th><th>Error</th><th class="num">Tries</th><th class="num">Last</th><th></th></tr></thead><tbody>
        ${failed.map((f) => `<tr><td>${esc(f.name)}</td><td class="muted">${esc(f.error)}</td><td class="num">${f.tries}</td><td class="num">${ago(f.at)}</td><td><button class="mini" data-retry="${escAttr(f.id)}" type="button">retry</button></td></tr>`).join("")}
      </tbody></table></div>
    </section>
  `;
}

function renderLivePanel(live) {
  if (!live || !live.active) return "";
  const workers = live.workers || {};
  const slots = Array.from({ length: live.parallel || Object.keys(workers).length || 1 }, (_, i) => String(i));
  const recent = (live.recent || []).slice(0, 8);
  const total = live.total || 0;
  const progressPct = total ? pct(live.done, total) : 0;
  const ratioSaved = live.bytesIn && live.bytesOut ? pct(live.bytesIn - live.bytesOut, live.bytesIn) : 0;

  return `
    <section class="panel previews-live-monitor">
      <div class="section-title">
        <div>
          <p class="eyebrow">realtime streaming</p>
          <h2>${icon("zap")} Active Transcoder Monitor</h2>
        </div>
        <span class="status-pill live-pill" data-state="live">
          <span class="pulse-indicator"></span> ${live.parallel || 1} Workers Connected
        </span>
      </div>

      <div class="previews-live-stats">
        <div class="previews-live-stat">
          <span class="muted">Run</span>
          <b>${esc(live.trigger || "manual")} #${esc(String(live.runId || "").slice(-6))}</b>
        </div>
        <div class="previews-live-stat">
          <span class="muted">Completed</span>
          <b>${live.done || 0}${total ? ` / ${total}` : ""} (${progressPct}%)</b>
        </div>
        <div class="previews-live-stat">
          <span class="muted">Processed</span>
          <b>${fmtBytes(live.bytesIn || 0)} → ${fmtBytes(live.bytesOut || 0)}</b>
          ${ratioSaved ? `<small class="chip ok">−${ratioSaved}%</small>` : ""}
        </div>
        <div class="previews-live-stat">
          <span class="muted">Failures</span>
          <b class="${live.skipped ? "img-bad" : ""}">${live.skipped || 0}</b>
        </div>
      </div>

      <div class="previews-overall-progress">
        <div class="previews-bar big" aria-label="${progressPct}% completed">
          <i style="width:${progressPct}%"></i>
        </div>
      </div>

      <div class="transcoder-slots-grid">
        ${slots.map((s) => renderWorkerSlot(s, workers[s])).join("")}
      </div>

      ${recent.length ? `
        <div class="previews-live-recent">
          <p class="eyebrow">recently completed files</p>
          <ul class="previews-recent-list">
            ${recent.map((r) => `
              <li>
                ${r.ok ? icon("circle-check", "ico-sm") : icon("circle-x", "ico-sm")}
                <span class="recent-name" title="${escAttr(r.name)}">${esc(r.name)}</span>
                ${r.ok ? `
                  <span class="muted">${fmtBytes(r.size)} → ${fmtBytes(r.previewSize)}</span>
                  <span class="chip mini">${r.via || "ffmpeg"}</span>
                  <span class="muted">${fmtTime(r.ms / 1000)}</span>
                ` : `
                  <span class="muted img-bad">${esc(r.error)}</span>
                `}
              </li>
            `).join("")}
          </ul>
        </div>
      ` : ""}
    </section>
  `;
}

function renderWorkerSlot(slotIndex, w) {
  if (!w || !w.fileId) {
    return `
      <div class="transcoder-slot-card idle">
        <div class="slot-head">
          <span class="slot-num">Worker #${Number(slotIndex) + 1}</span>
          <span class="slot-badge idle">idle</span>
        </div>
        <p class="slot-empty muted">Waiting for next video...</p>
      </div>
    `;
  }

  const stage = w.stage || "transcoding";
  const stageClass = stage === "downloading" ? "info" : stage === "uploading" ? "cyan" : "ok";
  const speedStr = w.speed ? ` · ${esc(w.speed)}` : "";
  const fpsStr = w.fps ? ` (${w.fps} fps)` : "";
  const etaStr = w.etaSec ? ` · ~${fmtTime(w.etaSec)} left` : "";

  return `
    <div class="transcoder-slot-card active">
      <div class="slot-head">
        <span class="slot-num">Worker #${Number(slotIndex) + 1}</span>
        <span class="slot-badge ${stageClass}">${esc(stage)}</span>
      </div>
      <div class="slot-title" title="${escAttr(w.name)}">
        ${icon("film", "ico-sm")} <span>${esc(w.name)}</span>
      </div>
      <div class="slot-meta muted">
        ${fmtBytes(w.size)}${speedStr}${fpsStr}${etaStr}
      </div>
      <div class="previews-bar" aria-label="${w.percent || 0}%">
        <i style="width:${w.percent || 0}%"></i>
      </div>
      <div class="slot-foot">
        <small class="muted">${w.percent || 0}%</small>
      </div>
    </div>
  `;
}

function runRow(run, active) {
  const finished = !!run.finishedAt;
  // A run that was cancelled never reports finishedAt. Without this it showed
  // "running" forever, which is also what kept the fallback poll alive.
  const stopped = !finished && String(active?.id || "") !== String(run.id);
  const status = finished
    ? `${icon("circle-check", "ico-sm")} finished ${ago(run.finishedAt)}${run.pendingLeft ? ` · ${run.pendingLeft} left` : ""}`
    : stopped
    ? `${icon("circle-x", "ico-sm")} stopped ${ago(run.startedAt)}`
    : `${icon("loader-circle", "ico-sm")} running`;
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

// One delegated listener set on the tab body, attached once. Panels are swapped
// in and out as the run progresses, so per-element listeners either vanish or
// stack up duplicates.
let wired = false;
function wire() {
  const host = $("previews-body");
  if (!host || wired) return;
  wired = true;

  const limit = () => Number($("previews-limit")?.value) || 300;

  host.addEventListener("click", (e) => {
    const hit = (sel) => e.target.closest(sel);
    if (hit("#previews-refresh")) {
      refreshPreviews();
      return loadCoverage({ fresh: true });
    }
    if (hit("#previews-rescan-coverage")) return loadCoverage({ fresh: true });
    if (hit("#previews-retry-coverage")) return loadCoverage({ fresh: true });
    const runBtn = hit("#previews-run");
    if (runBtn) return run(runBtn, { limit: limit() });
    const runSelected = hit("#previews-run-selected");
    if (runSelected) return run(runSelected, { folderIds: [...selectedFolders], limit: limit() });
    const folder = hit("[data-run-folder]");
    if (folder) return run(folder, { folderIds: [folder.dataset.runFolder], limit: 500 });
    const all = hit("#previews-retry-all");
    if (all) return retry(all, []);
    const one = hit("[data-retry]");
    if (one) return retry(one, [one.dataset.retry]);
  });

  host.addEventListener("change", (e) => {
    const box = e.target.closest("[data-folder]");
    if (!box) return;
    box.checked ? selectedFolders.add(box.dataset.folder) : selectedFolders.delete(box.dataset.folder);
    const runSelectedBtn = $("previews-run-selected");
    if (runSelectedBtn) runSelectedBtn.disabled = !selectedFolders.size;
  });
}

async function run(button, body) {
  button.disabled = true;
  try {
    const r = await post("/api/admin/previews/run", body);
    const d = await r.json().catch(() => ({}));
    flash(button, d.dispatched ? "run started" : d.reason || "queued for the nightly run");
    setTimeout(() => { refreshPreviews(); loadCoverage(); }, 2500);
  } catch (error) {
    flash(button, error.message);
    button.disabled = false;
  }
}

async function retry(button, fileIds) {
  button.disabled = true;
  const r = await post("/api/admin/previews/retry", { fileIds });
  flash(button, r.ok ? "cleared - picked up next run" : "retry failed");
  setTimeout(() => { refreshPreviews(); loadCoverage(); }, 800);
}
