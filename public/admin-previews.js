import { $, icon } from "./admin-state.js";
import { flash } from "./admin.js";

// Video previews tab: transcoder telemetry, folder coverage, run history and
// the controls that start or stop a run.
//
// Two independent loads: the overview answers from the index in milliseconds,
// the folder coverage comes from its own endpoint because it may have to crawl
// Drive. Nothing here re-renders the whole tab once it is painted - panels are
// patched in place, so a poll or a telemetry tick cannot interrupt a click.

let data = null;
let liveState = null;
let coverageLoading = false;
let rendered = false;
let wired = false;
let pollTimer = 0;

// Coverage view state, kept across reloads so a refresh never loses a selection.
let selected = new Set();
let collapsed = new Set();
let filter = "all";
let query = "";
let lastPicked = -1;
let dragMode = null;

const FILTERS = [
  ["all", "All"],
  ["todo", "Waiting"],
  ["failed", "Failed"],
  ["done", "Done"],
];

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

// Totals that need the Drive crawl are null until coverage lands. Show a
// placeholder rather than a confident wrong number.
const num = (v) => (v == null ? "…" : String(v));
const readyLabel = (ready, videos) => (videos == null ? String(ready) : `${ready} · ${pct(ready, videos)}%`);

const folderState = (f) => (!f.videos ? "empty" : f.ready === f.videos ? "done" : f.failed && f.ready + f.failed === f.videos ? "failed" : "partial");
const selectable = (f) => f.videos > 0 && f.ready < f.videos;

// ---------- first paint ----------

export function renderSkeletons() {
  const host = $("previews-body");
  if (!host) return;
  host.innerHTML = `
    <div class="stat-grid" id="previews-stat-grid">${Array.from(
      { length: 5 },
      () => `<div class="stat-card v3 skel"><div class="stat-skel-ico skel-bone"></div><div><div class="stat-skel-val skel-bone"></div><div class="stat-skel-lbl skel-bone"></div></div></div>`
    ).join("")}</div>
    <div id="previews-live-wrap"></div>
    <section class="panel" id="previews-runs-section">
      <div class="section-title"><div><p class="eyebrow">transcoder</p><h2>${icon("zap")} Runs</h2></div></div>
      <div class="upload-table-wrap"><table class="uploads previews-runs"><tbody>${skelRows(2, 6)}</tbody></table></div>
    </section>
    <section class="panel" id="previews-coverage-section">
      <div class="section-title"><div><p class="eyebrow">by folder</p><h2>${icon("folder")} Coverage</h2></div></div>
      <div class="upload-table-wrap"><table class="uploads previews-folders"><tbody>${skelRows(4, 8)}</tbody></table></div>
    </section>
  `;
}

const skelRows = (rows, cells) =>
  Array.from({ length: rows }, () =>
    `<tr class="table-skel-row">${Array.from({ length: cells }, (_, i) => `<td><div class="table-skel-cell skel-bone" style="width:${40 + ((i * 37) % 90)}px"></div></td>`).join("")}</tr>`
  ).join("");

// ---------- loading ----------

export async function refreshPreviews({ fresh = false } = {}) {
  const host = $("previews-body");
  if (!host) return;
  if (!data && !host.querySelector(".stat-card")) renderSkeletons();

  try {
    const r = await fetch(`/api/admin/previews/overview${fresh ? "?fresh=1" : ""}`);
    if (!r.ok) throw new Error(`overview ${r.status}`);
    const next = await r.json();
    // Coverage lives behind its own endpoint. A refresh must never throw away
    // folders we already have, or the table collapses back to a skeleton and
    // kicks off another 3k-file Drive crawl on every poll.
    if (data?.folders && !next.folders) {
      next.folders = data.folders;
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
  // Gentle fallback poll while a run is going, in case the WebSocket is down.
  if ((data?.active || liveState?.active) && !$("tab-previews")?.classList.contains("hidden")) {
    pollTimer = setTimeout(() => refreshPreviews(), 20_000);
  }
}

// In-place refresh of everything except the coverage table. A full re-render on
// every poll or telemetry tick made the tab flicker and dropped folder
// checkboxes and scroll position mid-click.
function patch() {
  if (!data) return;
  updateStatCards(data.totals);
  swap("previews-live-wrap", () => (liveState?.active ? renderLivePanel(liveState) : ""), true);
  // Redrawing the toolbar under a caret loses what is being typed, and the
  // fallback poll fires every 20s while a run is going.
  if (!$("previews-runs-section")?.contains(document.activeElement)) swap("previews-runs-section", renderRunsPanel);
  swap("previews-failed-wrap", () => renderFailedSection(data.failed || []), true);
}

function swap(id, html, inner) {
  const el = $(id);
  if (!el) return;
  if (inner) el.innerHTML = html();
  else el.outerHTML = html();
}

export function stopPreviewsPolling() {
  clearTimeout(pollTimer);
  pollTimer = 0;
}

export async function loadCoverage({ fresh = false } = {}) {
  if (coverageLoading) return; // one Drive crawl at a time, `fresh` included
  coverageLoading = true;
  $("previews-coverage-section")?.classList.add("is-scanning");

  try {
    // A cold Drive crawl can hang until Cloudflare gives up with a 524. Bound it
    // here too, or `coverageLoading` stays true and blocks every later scan.
    const r = await fetch(`/api/admin/previews/coverage${fresh ? "?fresh=1" : ""}`, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`coverage ${r.status}`);
    const cov = await r.json();
    if (!data) data = {};
    data.folders = indexTree(cov.folders || []);
    data.totals = cov.totals || data.totals;
    data.failed = cov.failed || data.failed;
    data.foldersLoading = false;

    // Keep a selection that still points at folders that exist.
    const live = new Set(data.folders.map((f) => f.folderId));
    for (const id of [...selected]) if (!live.has(id)) selected.delete(id);

    updateStatCards(data.totals);
    redrawCoverage();
    swap("previews-failed-wrap", () => renderFailedSection(data.failed || []), true);
  } catch (error) {
    const section = $("previews-coverage-section");
    if (section) {
      section.innerHTML = `
        ${coverageHead(`<button class="mini" id="previews-retry-coverage" type="button">${icon("refresh-cw", "ico-sm")} Retry scan</button>`)}
        <div class="coverage-error-strip">
          <p class="img-bad">${icon("circle-alert", "ico-sm")} Could not scan Drive folders: ${esc(error.message)}</p>
          <span class="muted">Stats, runs and retries above still work.</span>
        </div>`;
    }
  } finally {
    coverageLoading = false;
    $("previews-coverage-section")?.classList.remove("is-scanning");
  }
}

// The scan walks sibling folders in parallel, so its list is flat and in no
// particular order. Rebuild depth-first order from the parent ids, which is
// what makes indentation and "collapse this subtree" mean anything.
function indexTree(folders) {
  const kids = new Map();
  for (const f of folders) {
    const key = f.parentId || "";
    if (!kids.has(key)) kids.set(key, []);
    kids.get(key).push(f);
  }
  const known = new Set(folders.map((f) => f.folderId));
  const out = [];
  const walk = (parentKey, depth) => {
    for (const f of (kids.get(parentKey) || []).sort((a, b) => a.name.localeCompare(b.name))) {
      const children = kids.get(f.folderId) || [];
      out.push({ ...f, depth, parent: f.parentId || null, hasKids: children.length > 0 });
      walk(f.folderId, depth + 1);
    }
  };
  walk("", 0);
  // Anything whose parent was dropped (a share revoked mid-scan) still shows.
  for (const f of folders) {
    if (f.parentId && !known.has(f.parentId)) out.push({ ...f, depth: 0, parent: null, hasKids: false });
  }
  return out;
}

// ---------- live telemetry ----------

export function updatePreviewsLive(live) {
  if (!live) return;
  const wasActive = liveState?.active;
  liveState = live;

  // Only the live panel changes on a telemetry tick - never re-render the tab.
  if ($("tab-previews") && !$("tab-previews").classList.contains("hidden")) {
    const wrap = $("previews-live-wrap");
    if (wrap) wrap.innerHTML = live.active ? renderLivePanel(live) : "";
    if (live.active) updateTopCountersLive(live);
    else if (wasActive) swap("previews-runs-section", renderRunsPanel);
  }

  // When a run ends, pick up the final numbers once.
  if (wasActive && !live.active) {
    setTimeout(() => {
      refreshPreviews();
      loadCoverage();
    }, 1500);
  }
}

function updateTopCountersLive(live) {
  if (!data?.totals || live.done == null) return;
  const ready = data.totals.ready + (live.done || 0);
  const readyEl = $("stat-previews-ready");
  const waitEl = $("stat-previews-waiting");
  if (readyEl) readyEl.textContent = readyLabel(ready, data.totals.videos);
  if (waitEl && data.totals.pending != null) waitEl.textContent = String(Math.max(0, data.totals.pending - (live.done || 0)));
}

function updateStatCards(t) {
  if (!t) return;
  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  set("stat-previews-total", num(t.videos));
  set("stat-previews-ready", readyLabel(t.ready, t.videos));
  set("stat-previews-waiting", num(t.pending));
  set("stat-previews-failed", num(t.failed));
  set("stat-previews-storage", `${fmtBytes(t.previewBytes)}${t.bytes ? ` (originals ${fmtBytes(t.bytes)})` : ""}`);
}

// ---------- render ----------

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
    <div class="stat-grid" id="previews-stat-grid">${cards
      .map(([name, value, label, id]) => `<div class="stat-card v3"><span class="stat-ico">${icon(name)}</span><div><b id="${id}">${esc(String(value))}</b><span class="stat-label">${esc(label)}</span></div></div>`)
      .join("")}</div>
    <div id="previews-live-wrap">${liveState?.active ? renderLivePanel(liveState) : ""}</div>
    ${renderRunsPanel()}
    ${folders ? renderCoveragePanel() : renderCoverageLoading()}
    <div id="previews-failed-wrap">${renderFailedSection(failed)}</div>
  `;
  rendered = true;
  wire();
}

// ---------- runs panel ----------

function renderRunsPanel() {
  const { totals: t, runs = [], active, nextRunAt, dispatchConfigured, queue } = data;
  const saved = t.bytes && t.previewBytes ? t.bytes - t.previewBytes : 0;
  const busy = !!(active || liveState?.active);
  const limit = $("previews-limit")?.value || "300";
  const shards = $("previews-shards")?.value || "4";
  const ghLink = active ? ` <a class="mini" href="${esc(active.url)}" target="_blank" rel="noopener">open on GitHub ${icon("external-link", "ico-sm")}</a>` : "";

  const stateLine = liveState?.active
    ? `<span class="status-pill" data-state="live"><i class="status-dot-pulse"></i> transcoding · ${Object.keys(liveState.runners || {}).length || 1} of ${liveState.shards || 1} runners · ${liveState.parallel || 1} workers</span>${ghLink}`
    : active
    ? `<span class="status-pill" data-state="live">run in progress · started ${ago(active.startedAt)}</span>${ghLink}`
    : `<span class="status-pill" data-state="paused">idle · next scheduled run ${until(nextRunAt)} (03:00 IST)</span>`;

  const queueLine = queue && (queue.folderIds?.length || queue.fileIds?.length)
    ? `<p class="muted">Queued for the next run: ${queue.folderIds.length} folder(s), ${queue.fileIds.length} file(s).</p>`
    : "";
  const dispatchNote = dispatchConfigured
    ? ""
    : `<p class="muted">${icon("info", "ico-sm")} "Run now" needs a <code>GITHUB_TOKEN</code> secret on the worker (fine-grained PAT, Actions: read &amp; write). Until then, queued work runs on the nightly schedule.</p>`;

  return `
    <section class="panel" id="previews-runs-section">
      <div class="section-title">
        <div><p class="eyebrow">transcoder</p><h2>${icon("zap")} Runs</h2></div>
        <div class="section-tools previews-tools">
          <label class="field-mini" title="Videos to transcode across the whole run">
            <span>videos</span>
            <input id="previews-limit" type="number" min="1" max="5000" step="50" value="${escAttr(limit)}" aria-label="Videos per run">
          </label>
          <label class="field-mini" title="GitHub runs up to 20 machines at once on a public repo">
            <span>runners</span>
            <input id="previews-shards" type="number" min="1" max="20" value="${escAttr(shards)}" aria-label="Runners to spread the work over">
          </label>
          ${busy
            ? `<button class="btn danger" id="previews-stop" type="button">${icon("circle-x", "ico-sm")} Stop run</button>`
            : `<button class="btn" id="previews-run" type="button">${icon("play", "ico-sm")} Run now</button>`}
          <button class="mini" id="previews-refresh" type="button">${icon("refresh-cw", "ico-sm")} Rescan</button>
        </div>
      </div>
      <div class="previews-state">${stateLine}</div>
      ${queueLine}${dispatchNote}
      <p class="muted">Saved ${fmtBytes(saved)} of streaming per full playthrough: viewers get a 720p copy on hover and first play, HD on demand.</p>
      ${runs.length
        ? `<div class="upload-table-wrap"><table class="uploads previews-runs">
            <thead><tr><th>Run</th><th>Started</th><th class="num">Done</th><th class="num">Skipped</th><th class="num">In → out</th><th>Status</th></tr></thead>
            <tbody>${runs.map((run) => runRow(run, active)).join("")}</tbody></table></div>`
        : `<p class="muted">No runs recorded yet.</p>`}
    </section>`;
}

function runRow(run, active) {
  const finished = !!run.finishedAt;
  // A cancelled run never reports finishedAt; without this it reads "running"
  // forever and keeps the fallback poll alive.
  const running = !finished && String(active?.id || "") === String(run.id);
  const status = finished
    ? `${icon("circle-check", "ico-sm")} finished ${ago(run.finishedAt)}${run.pendingLeft ? ` · ${run.pendingLeft} left` : ""}`
    : running
    ? `${icon("loader-circle", "ico-sm")} running`
    : `${icon("circle-x", "ico-sm")} stopped ${ago(run.startedAt)}`;
  const items = run.items || [];
  const failedItems = items.filter((i) => !i.ok);
  const detail = items.length
    ? `<details class="previews-run-items"><summary>${items.length} files${failedItems.length ? ` · ${failedItems.length} failed` : ""}</summary>
        ${failedItems.length ? `<button class="mini" data-retry-run="${escAttr(String(run.id))}" type="button">${icon("refresh-cw", "ico-sm")} Retry this run's failures</button>` : ""}
        <ul>${items
          .slice()
          .reverse()
          .map((i) => `<li>${i.ok ? icon("check", "ico-sm") : icon("circle-x", "ico-sm")} ${esc(i.name)} ${i.ok ? `<span class="muted">${fmtBytes(i.size)} → ${fmtBytes(i.previewSize)} · ${fmtTime(i.ms / 1000)}</span>` : `<span class="muted">${esc(i.error)}</span>`}</li>`)
          .join("")}</ul></details>`
    : "";
  return `<tr data-run-state="${finished ? "done" : running ? "running" : "stopped"}"><td>${esc(run.trigger)} <span class="muted">#${esc(String(run.id).slice(-6))}</span>${detail}</td><td>${ago(run.startedAt)}</td><td class="num">${run.done}</td><td class="num">${run.skipped}</td><td class="num">${fmtBytes(run.bytes)} → ${fmtBytes(run.previewBytes)}</td><td>${status}</td></tr>`;
}

// ---------- coverage panel ----------

const coverageHead = (tools) => `
  <div class="section-title">
    <div><p class="eyebrow">by folder</p><h2>${icon("folder")} Coverage</h2></div>
    <div class="section-tools">${tools}</div>
  </div>`;

function renderCoverageLoading() {
  return `
    <section class="panel" id="previews-coverage-section">
      ${coverageHead(`<span class="coverage-loading-badge"><svg class="ico ico-sm spin" aria-hidden="true"><use href="/icons.svg#loader-circle"></use></svg> Scanning Drive folders…</span>`)}
      <p class="muted">${icon("info", "ico-sm")} Reading the share folders in the background. Everything above is ready.</p>
      <div class="upload-table-wrap"><table class="uploads previews-folders"><tbody>${skelRows(5, 8)}</tbody></table></div>
    </section>`;
}

// The rows the current search, filter and collapse state let through.
function visibleFolders() {
  const q = query.trim().toLowerCase();
  const hidden = new Set();
  return (data.folders || []).filter((f) => {
    if (f.parent && (collapsed.has(f.parent) || hidden.has(f.parent))) {
      hidden.add(f.folderId);
      return false;
    }
    if (q && !`${f.name} ${f.label}`.toLowerCase().includes(q)) return false;
    const state = folderState(f);
    if (filter === "todo") return state === "partial" || state === "failed";
    if (filter === "failed") return f.failed > 0;
    if (filter === "done") return state === "done";
    return true;
  });
}

const pickedVideoCount = () => (data.folders || []).filter((f) => selected.has(f.folderId)).reduce((n, f) => n + f.pending + (f.failed || 0), 0);
const selectionLabel = () => {
  const n = selected.size;
  const v = pickedVideoCount();
  return n ? `${n} folder${n > 1 ? "s" : ""} · ${v} video${v === 1 ? "" : "s"}` : "none selected";
};

function renderCoveragePanel() {
  const rows = visibleFolders();
  const pickable = rows.filter(selectable);
  const allPicked = pickable.length > 0 && pickable.every((f) => selected.has(f.folderId));
  const any = selected.size > 0;

  return `
    <section class="panel" id="previews-coverage-section">
      ${coverageHead(`
        <span class="coverage-count muted">${rows.length} of ${(data.folders || []).length} folders</span>
        <button class="mini" id="previews-rescan-coverage" type="button" title="Re-read the share folders from Drive">${icon("refresh-cw", "ico-sm")} Rescan</button>`)}

      <div class="coverage-toolbar">
        <label class="coverage-search">
          ${icon("search", "ico-sm")}
          <input id="coverage-search" type="search" placeholder="Search folders or shares" value="${escAttr(query)}" aria-label="Search folders">
        </label>
        <div class="seg" role="group" aria-label="Filter folders">
          ${FILTERS.map(([key, label]) => `<button class="seg-btn${filter === key ? " on" : ""}" data-filter="${key}" type="button">${label}</button>`).join("")}
        </div>
        <div class="coverage-bulk">
          <label class="pick-label"><input class="pick" type="checkbox" id="coverage-all" ${allPicked ? "checked" : ""} aria-label="Select every listed folder"><span>Select all</span></label>
          <span class="coverage-selection${any ? " on" : ""}" aria-live="polite">${selectionLabel()}</span>
          <button class="mini" id="coverage-clear" type="button" ${any ? "" : "disabled"}>Clear</button>
          <button class="btn" id="previews-run-selected" type="button" ${any ? "" : "disabled"}>${icon("play", "ico-sm")} Process selected</button>
        </div>
      </div>

      ${rows.length
        ? `<div class="upload-table-wrap coverage-wrap"><table class="uploads previews-folders">
            <thead><tr><th class="pick-col"></th><th>Folder</th><th>Share</th><th class="num">Videos</th><th class="num">Ready</th><th class="num">Waiting</th><th class="num">Failed</th><th>Progress</th><th></th></tr></thead>
            <tbody>${rows.map(folderRow).join("")}</tbody></table></div>`
        : `<div class="empty-state"><p class="muted">${query || filter !== "all" ? "No folder matches this filter." : "No active shares with folders."}</p></div>`}
    </section>`;
}

function folderRow(f) {
  const p = pct(f.ready, f.videos);
  const state = folderState(f);
  const pick = selectable(f);
  const shut = collapsed.has(f.folderId);
  const caret = f.hasKids
    ? `<button class="tree-caret${shut ? " closed" : ""}" data-collapse="${escAttr(f.folderId)}" type="button" aria-label="${shut ? "Expand" : "Collapse"} ${escAttr(f.name)}">${icon("chevron-down", "ico-sm")}</button>`
    : `<span class="tree-caret ghost"></span>`;
  return `<tr class="${selected.has(f.folderId) ? "picked" : ""}" data-state="${state}" data-folder-row="${escAttr(f.folderId)}">
    <td class="pick-col">${pick ? `<input class="pick" type="checkbox" data-folder="${escAttr(f.folderId)}" ${selected.has(f.folderId) ? "checked" : ""} aria-label="Select ${escAttr(f.name)}">` : `<span class="pick-done" title="${state === "done" ? "every video has a preview" : "no videos here"}">${state === "done" ? icon("check", "ico-sm") : ""}</span>`}</td>
    <td class="tree-cell" style="--depth:${f.depth}">${caret}${icon(f.hasKids ? "folder-open" : "folder", "ico-sm")}<span class="tree-name" title="${escAttr(f.name)}">${esc(f.name)}</span></td>
    <td class="muted">${esc(f.label)}</td>
    <td class="num">${f.videos}</td>
    <td class="num">${f.ready}</td>
    <td class="num">${f.pending || ""}</td>
    <td class="num">${f.failed || ""}</td>
    <td class="bar-cell"><span class="previews-bar" aria-label="${p}% ready"><i style="width:${p}%"></i></span><span class="muted bar-pct">${p}%</span></td>
    <td>${pick ? `<button class="mini" data-run-folder="${escAttr(f.folderId)}" type="button">process</button>` : `<span class="muted">${f.videos ? "done" : "—"}</span>`}</td>
  </tr>`;
}

// ---------- failed files ----------

function renderFailedSection(failed) {
  if (!failed || !failed.length) return "";
  return `
    <section class="panel" id="previews-failed-section">
      <div class="section-title"><div><p class="eyebrow">needs attention</p><h2>${icon("triangle-alert")} Failed files</h2></div>
        <div class="section-tools"><button class="mini" id="previews-retry-all" type="button">${icon("refresh-cw", "ico-sm")} Retry all</button></div></div>
      <div class="upload-table-wrap"><table class="uploads"><thead><tr><th>File</th><th>Error</th><th class="num">Tries</th><th class="num">Last</th><th></th></tr></thead><tbody>
        ${failed.map((f) => `<tr><td>${esc(f.name)}</td><td class="muted">${esc(f.error)}</td><td class="num">${f.tries}</td><td class="num">${ago(f.at)}</td><td><button class="mini" data-retry="${escAttr(f.id)}" type="button">retry</button></td></tr>`).join("")}
      </tbody></table></div>
    </section>`;
}

// ---------- live monitor ----------

function renderLivePanel(live) {
  if (!live || !live.active) return "";
  const workers = live.workers || {};
  const runners = Object.keys(live.runners || {}).length;
  const busy = Object.entries(workers).filter(([, w]) => w?.fileId);
  const idle = Math.max(0, (live.parallel || 0) - busy.length);
  const total = live.total || 0;
  const progress = total ? pct(live.done, total) : 0;
  const saved = live.bytesIn && live.bytesOut ? pct(live.bytesIn - live.bytesOut, live.bytesIn) : 0;
  const recent = (live.recent || []).slice(0, 8);

  return `
    <section class="panel previews-live-monitor">
      <div class="section-title">
        <div><p class="eyebrow">realtime</p><h2>${icon("zap")} Transcoding now</h2></div>
        <span class="status-pill live-pill" data-state="live"><span class="pulse-indicator"></span> ${runners || 1} runner${runners === 1 ? "" : "s"} · ${live.parallel || 1} workers</span>
      </div>

      <div class="previews-live-stats">
        <div class="previews-live-stat"><span class="muted">Run</span><b>${esc(live.trigger || "manual")} #${esc(String(live.runId || "").slice(-6))}</b></div>
        <div class="previews-live-stat"><span class="muted">Completed</span><b>${live.done || 0}${total ? ` / ${total}` : ""} (${progress}%)</b></div>
        <div class="previews-live-stat"><span class="muted">Processed</span><b>${fmtBytes(live.bytesIn || 0)} → ${fmtBytes(live.bytesOut || 0)}</b>${saved ? ` <small class="chip ok">−${saved}%</small>` : ""}</div>
        <div class="previews-live-stat"><span class="muted">Failures</span><b class="${live.skipped ? "img-bad" : ""}">${live.skipped || 0}</b></div>
      </div>

      <div class="previews-bar big" aria-label="${progress}% completed"><i style="width:${progress}%"></i></div>

      <div class="transcoder-slots-grid">
        ${busy.map(([key, w]) => renderWorkerSlot(key, w, (live.shards || 1) > 1)).join("")}
        ${idle ? `<div class="transcoder-slot-card idle"><div class="slot-head"><span class="slot-num">idle</span><span class="slot-badge idle">${idle}</span></div><p class="slot-empty muted">${idle} worker${idle > 1 ? "s" : ""} waiting for the next video</p></div>` : ""}
      </div>

      ${recent.length
        ? `<div class="previews-live-recent"><p class="eyebrow">just finished</p><ul class="previews-recent-list">${recent
            .map(
              (r) => `<li>${r.ok ? icon("circle-check", "ico-sm") : icon("circle-x", "ico-sm")}<span class="recent-name" title="${escAttr(r.name)}">${esc(r.name)}</span>${
                r.ok
                  ? `<span class="muted">${fmtBytes(r.size)} → ${fmtBytes(r.previewSize)}</span><span class="chip mini">${esc(r.via || "ffmpeg")}</span><span class="muted">${fmtTime(r.ms / 1000)}</span>`
                  : `<span class="muted img-bad">${esc(r.error)}</span>`
              }</li>`
            )
            .join("")}</ul></div>`
        : ""}
    </section>`;
}

function renderWorkerSlot(key, w, showRunner) {
  const [shard, slot] = String(key).split(":");
  const stage = w.stage || "transcoding";
  const stageClass = stage === "downloading" ? "info" : stage === "uploading" ? "cyan" : "ok";
  const meta = [fmtBytes(w.size), w.speed && esc(w.speed), w.fps && `${w.fps} fps`, w.etaSec && `~${fmtTime(w.etaSec)} left`].filter(Boolean).join(" · ");
  return `
    <div class="transcoder-slot-card active">
      <div class="slot-head">
        <span class="slot-num">${showRunner ? `R${Number(shard) + 1}·` : ""}W${Number(slot) + 1}</span>
        <span class="slot-badge ${stageClass}">${esc(stage)}</span>
      </div>
      <div class="slot-title" title="${escAttr(w.name)}">${icon("film", "ico-sm")} <span>${esc(w.name)}</span></div>
      <div class="slot-meta muted">${meta}</div>
      <div class="previews-bar" aria-label="${w.percent || 0}%"><i style="width:${w.percent || 0}%"></i></div>
    </div>`;
}

// ---------- events ----------

// One delegated listener set on the tab body, attached once. Panels are swapped
// in and out as the run progresses, so per-element listeners either vanish or
// stack up duplicates.
function wire() {
  const host = $("previews-body");
  if (!host || wired) return;
  wired = true;

  const limit = () => Number($("previews-limit")?.value) || 300;
  const shards = () => Number($("previews-shards")?.value) || 4;

  host.addEventListener("click", (e) => {
    const hit = (sel) => e.target.closest(sel);

    if (hit("#previews-refresh")) {
      refreshPreviews();
      return loadCoverage({ fresh: true });
    }
    if (hit("#previews-rescan-coverage") || hit("#previews-retry-coverage")) return loadCoverage({ fresh: true });

    const runBtn = hit("#previews-run");
    if (runBtn) return run(runBtn, { limit: limit(), shards: shards() });
    const stopBtn = hit("#previews-stop");
    if (stopBtn) return stopRun(stopBtn);
    const runSelected = hit("#previews-run-selected");
    if (runSelected) return run(runSelected, { folderIds: [...selected], limit: limit(), shards: shards() });
    const folder = hit("[data-run-folder]");
    if (folder) return run(folder, { folderIds: [folder.dataset.runFolder], limit: limit(), shards: shards() });

    const all = hit("#previews-retry-all");
    if (all) return retry(all, []);
    const perRun = hit("[data-retry-run]");
    if (perRun) return retry(perRun, runFailureIds(perRun.dataset.retryRun));
    const one = hit("[data-retry]");
    if (one) return retry(one, [one.dataset.retry]);

    const caret = hit("[data-collapse]");
    if (caret) {
      const id = caret.dataset.collapse;
      collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
      return redrawCoverage();
    }
    const seg = hit("[data-filter]");
    if (seg) {
      filter = seg.dataset.filter;
      return redrawCoverage();
    }
    if (hit("#coverage-clear")) {
      selected.clear();
      return redrawCoverage();
    }
  });

  host.addEventListener("change", (e) => {
    if (e.target.id === "coverage-all") {
      const on = e.target.checked;
      for (const f of visibleFolders().filter(selectable)) (on ? selected.add(f.folderId) : selected.delete(f.folderId));
      return redrawCoverage();
    }
    const box = e.target.closest(".pick[data-folder]");
    if (box) setPicked(box.dataset.folder, box.checked);
  });

  // Shift-click takes a range; press and drag paints a run of rows.
  host.addEventListener("pointerdown", (e) => {
    const box = e.target.closest(".pick[data-folder]");
    if (!box) return;
    const rows = visibleFolders().filter(selectable);
    const i = rows.findIndex((f) => f.folderId === box.dataset.folder);
    if (e.shiftKey && lastPicked >= 0 && i >= 0) {
      e.preventDefault();
      const on = !selected.has(box.dataset.folder);
      for (let n = Math.min(i, lastPicked); n <= Math.max(i, lastPicked); n += 1) setPicked(rows[n].folderId, on, true);
      lastPicked = i;
      return redrawCoverage();
    }
    lastPicked = i;
    dragMode = !selected.has(box.dataset.folder);
  });

  host.addEventListener("pointerover", (e) => {
    if (dragMode === null || !e.buttons) return;
    const box = e.target.closest("tr")?.querySelector(".pick[data-folder]");
    if (box && box.checked !== dragMode) {
      box.checked = dragMode;
      setPicked(box.dataset.folder, dragMode);
    }
  });

  host.addEventListener("input", (e) => {
    if (e.target.id !== "coverage-search") return;
    query = e.target.value;
    redrawCoverage();
    const box = $("coverage-search");
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
    }
  });

  addEventListener("pointerup", () => {
    dragMode = null;
  });
}

// Update one row without redrawing the table: painting a drag selection has to
// stay smooth, and a re-render would drop the pointer stream anyway.
function setPicked(id, on, quiet) {
  on ? selected.add(id) : selected.delete(id);
  $("previews-coverage-section")?.querySelector(`[data-folder-row="${CSS.escape(id)}"]`)?.classList.toggle("picked", on);
  if (!quiet) refreshSelectionBar();
}

function refreshSelectionBar() {
  const section = $("previews-coverage-section");
  if (!section) return;
  const label = section.querySelector(".coverage-selection");
  if (label) {
    label.textContent = selectionLabel();
    label.classList.toggle("on", selected.size > 0);
  }
  for (const id of ["previews-run-selected", "coverage-clear"]) {
    const btn = section.querySelector(`#${id}`);
    if (btn) btn.disabled = !selected.size;
  }
  const pickable = visibleFolders().filter(selectable);
  const master = section.querySelector("#coverage-all");
  if (master) {
    master.checked = pickable.length > 0 && pickable.every((f) => selected.has(f.folderId));
    master.indeterminate = !master.checked && pickable.some((f) => selected.has(f.folderId));
  }
}

function redrawCoverage() {
  swap("previews-coverage-section", renderCoveragePanel);
  refreshSelectionBar();
}

const runFailureIds = (runId) => ((data.runs || []).find((r) => String(r.id) === String(runId))?.items || []).filter((i) => !i.ok).map((i) => i.id);

// ---------- actions ----------

async function run(button, body) {
  button.disabled = true;
  try {
    const r = await post("/api/admin/previews/run", body);
    const d = await r.json().catch(() => ({}));
    flash(button, d.dispatched ? `started on ${d.shards} runner${d.shards > 1 ? "s" : ""}` : d.reason || "queued for the nightly run");
    setTimeout(() => {
      refreshPreviews();
      loadCoverage();
    }, 2500);
  } catch (error) {
    flash(button, error.message);
    button.disabled = false;
  }
}

async function stopRun(button) {
  button.disabled = true;
  const r = await post("/api/admin/previews/cancel", {});
  const d = await r.json().catch(() => ({}));
  flash(button, d.cancelled ? "stopping…" : d.reason || "could not stop");
  setTimeout(() => refreshPreviews(), 4000);
}

async function retry(button, fileIds) {
  button.disabled = true;
  const r = await post("/api/admin/previews/retry", { fileIds });
  flash(button, r.ok ? "cleared - picked up next run" : "retry failed");
  setTimeout(() => {
    refreshPreviews();
    loadCoverage();
  }, 800);
}
