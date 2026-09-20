import { $, icon } from "./admin-state.js";
import { showTab } from "./admin.js";

// Pipelines tab: everything running in the background, on one page, polled
// while the tab is open. Data comes from /api/admin/pipelines; actions reuse
// the endpoints the other tabs already have.

let pollTimer = 0;
let state = null;

const ago = (ms) => {
  if (!ms) return "never";
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
};
const dur = (ms) => (ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)} min` : `${(ms / 3_600_000).toFixed(1)} h`);
const runLabel = (run) => (run.status === "completed" ? run.conclusion || "completed" : run.status.replace("_", " "));
const runClass = (run) => (["queued", "in_progress", "waiting", "pending"].includes(run.status) ? "busy" : run.conclusion === "success" ? "ok" : run.conclusion ? "err" : "");

export async function refreshPipelines() {
  const host = $("pipelines-body");
  if (!host) return;
  try {
    const r = await fetch("/api/admin/pipelines");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    state = await r.json();
    render();
  } catch (error) {
    host.innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  }
  clearTimeout(pollTimer);
  if (!$("tab-pipelines").classList.contains("hidden")) pollTimer = setTimeout(refreshPipelines, anythingActive() ? 10_000 : 30_000);
}
export function stopPipelinesPolling() {
  clearTimeout(pollTimer);
}

function anythingActive() {
  if (!state) return false;
  return state.shareIndex.shares.some((s) => s.active) || state.github.runs.some((r) => ["queued", "in_progress", "waiting", "pending"].includes(r.status)) || !!state.images.active;
}

function ghRuns(kind) {
  return (state.github.runs || []).filter((r) => r.kind === kind);
}

function ghCard(kind, title) {
  const runs = ghRuns(kind);
  if (!state.github.configured) return `<p class="muted">GITHUB_TOKEN not set - runs cannot be seen from here.</p>`;
  if (!runs.length) return `<p class="muted">No recent ${esc(title)} runs.</p>`;
  return `<ul class="pl-runs">${runs.slice(0, 4).map((run) => {
    const jobs = run.jobs.filter((j) => j.name !== "plan");
    const done = jobs.filter((j) => j.status === "completed").length;
    return `<li class="pl-run ${runClass(run)}"><span class="pl-dot"></span><a href="${escAttr(run.url)}" target="_blank" rel="noreferrer">#${esc(String(run.id))}</a><b>${esc(runLabel(run))}</b><span>${esc(run.event)}</span><span>${esc(ago(run.startedAt))}${run.status === "completed" ? ` · took ${esc(dur(run.updatedAt - run.startedAt))}` : ""}</span>${jobs.length ? `<span class="pl-jobs">${done}/${jobs.length} runners done · ${jobs.map((j) => `<i class="${j.status === "completed" ? (j.conclusion === "success" ? "ok" : "err") : j.status === "in_progress" ? "busy" : ""}" title="${escAttr(j.name)} · ${escAttr(j.status)}"></i>`).join("")}</span>` : ""}${["queued", "in_progress", "waiting", "pending"].includes(run.status) ? `<button class="mini danger" data-cancel-run="${escAttr(String(run.id))}" type="button">Cancel</button>` : ""}</li>`;
  }).join("")}</ul>`;
}

function render() {
  const s = state;
  const active = [];
  for (const sh of s.shareIndex.shares) if (sh.active) active.push(`${sh.label}: indexing (${sh.active.phase}, chunk ${sh.active.chunks})`);
  for (const run of s.github.runs) if (["queued", "in_progress", "waiting", "pending"].includes(run.status)) active.push(`${run.kind}: GitHub run ${runLabel(run)}`);
  if (s.images.active) active.push(`image archive: ${s.images.active.status} (${s.images.active.progress?.done || 0}/${s.images.active.fileCount || 0})`);
  $("pipelines-body").innerHTML = `
    <div class="pl-now ${active.length ? "busy" : ""}">${active.length ? `${icon("loader-circle")}<b>Running now</b><span>${active.map(esc).join(" · ")}</span>` : `${icon("check")}<b>Nothing running</b><span>next scheduled work: share-index + video previews nightly, RAW previews and WebP thumbnails 03:45 IST</span>`}<span class="muted pl-updated">updated ${esc(ago(s.now))}</span></div>
    <div class="pl-grid">
      <section class="panel pl-card">
        <div class="section-title"><h2>${icon("database")} Share index</h2><span class="muted">folder stats + file rows in R2 · chunk ${esc(String(s.shareIndex.chunk))} subrequests / ${esc(String(Math.round(s.shareIndex.chunkMs / 1000)))} s</span></div>
        <table class="pl-table"><thead><tr><th>Share</th><th>Files</th><th>Indexed</th><th>State</th><th></th></tr></thead><tbody>${s.shareIndex.shares.map((sh) => `<tr class="${sh.active ? "busy" : ""}"><td><b>${esc(sh.label)}</b><br><code>${esc(sh.slug)}</code>${sh.state !== "active" ? ` <span class="muted">${esc(sh.state)}</span>` : ""}</td><td>${sh.files ? esc(sh.files.toLocaleString()) : "—"}</td><td>${esc(ago(sh.indexedAt))}${sh.indexedAt && !sh.complete ? " (partial)" : ""}${sh.needsReindex ? `<br><span class="warn">changes pending</span>` : ""}</td><td>${sh.active ? `<span class="pl-state busy">${icon("loader-circle")}${esc(sh.active.full ? "full walk" : "targeted")} · ${esc(sh.active.phase || "…")} · chunk ${esc(String(sh.active.chunks))}</span><br><small>${sh.active.progress ? `${esc(String(sh.active.progress.folders))} folders · ${esc(String(sh.active.progress.files))} files${sh.active.phase === "warm" ? ` · warm ${esc(String(sh.active.warmAt))}/${esc(String(sh.active.progress.files))}` : ""}` : ""}${sh.active.queue ? ` · ${esc(String(sh.active.queue))} folders queued` : ""}${sh.active.changed ? ` · ${esc(String(sh.active.changed))} changes waiting` : ""} · moved ${esc(ago(sh.active.updatedAt))}</small>` : sh.last ? `<span class="pl-state ${sh.last.status === "done" ? "ok" : "err"}">${esc(sh.last.status)}</span> <small>${esc(sh.last.trigger)} · ${esc(ago(sh.last.finishedAt))}${sh.last.error ? ` · ${esc(sh.last.error)}` : ""}</small>` : `<span class="muted">never run</span>`}</td><td><button class="mini" data-index-share="${escAttr(sh.slug)}" type="button" ${sh.active ? "disabled" : ""}>${sh.active ? "Indexing…" : "Process now"}</button></td></tr>`).join("")}</tbody></table>
        <details class="pl-history"><summary>Recent jobs (${s.shareIndex.jobs.length})</summary><ul>${s.shareIndex.jobs.map((j) => `<li><code>${esc(j.id)}</code> ${esc(j.slug)} · ${esc(j.trigger)} · <b>${esc(j.status)}</b> · ${esc(ago(j.finishedAt || j.startedAt))}${j.progress ? ` · ${esc(String(j.progress.folders))} folders / ${esc(String(j.progress.files))} files in ${esc(String(j.chunks || 0))} chunks` : ""}${j.error ? ` · <span class="err">${esc(j.error)}</span>` : ""}</li>`).join("")}</ul></details>
      </section>

      <section class="panel pl-card">
        <div class="section-title"><h2>${icon("image")} RAW / HEIC previews</h2><span class="muted">WebP stand-ins in R2, made by GitHub runners</span></div>
        <div class="pl-stats"><div><span>Made</span><b>${esc(s.sharePreviews.indexed.toLocaleString())}</b></div><div><span>Pending</span><b>${esc(s.sharePreviews.pending.toLocaleString())}</b></div><div><span>Kept as original</span><b>${esc(String(s.sharePreviews.keptOriginal))}</b><small>HDR gain-map / undecodable</small></div></div>
        ${ghCard("share-previews", "preview runner")}
        <details class="pl-history"><summary>Reported runs (${s.sharePreviews.runs.length})</summary><ul>${s.sharePreviews.runs.map((r) => `<li><code>${esc(r.id)}</code> ${esc(ago(r.startedAt))} · <b>${esc(String(r.done))}</b> made · ${esc(String(r.kept || 0))} kept · ${esc(String(r.skipped))} failed${r.finishedAt ? ` · ${esc(String(r.pendingLeft || 0))} left` : " · running"}${r.bytes ? ` · ${esc((r.bytes / 1e6).toFixed(0))} MB` : ""}</li>`).join("")}</ul></details>
        <div class="pl-actions"><button class="btn ghost" data-run-share-previews type="button"><span>Run now</span></button></div>
      </section>

      <section class="panel pl-card">
        <div class="section-title"><h2>${icon("images")} WebP thumbnails</h2><span class="muted">Drive JPEG → WebP, same R2 key · ${esc(s.shareThumbs.files.toLocaleString())} indexed files</span></div>
        ${s.shareThumbs.runs.length ? `<ul class="pl-runs">${s.shareThumbs.runs.slice(0, 5).map((r) => {
          const total = Object.values(r.shards).reduce((t, x) => t + (x.total || 0), 0);
          const done = r.made + r.had + r.failed;
          return `<li class="pl-run ${r.finishedAt ? "ok" : "busy"}"><span class="pl-dot"></span><code>${esc(r.id)}</code><b>${r.finishedAt ? "finished" : "running"}</b><span>${esc(ago(r.startedAt))}</span><span>${esc(String(r.made))} made · ${esc(String(r.had))} already WebP · ${esc(String(r.failed))} failed${total ? ` · ${esc(String(Math.min(100, Math.round((done / total) * 100))))}%` : ""}</span>${r.bytesIn ? `<span>${esc((r.bytesIn / 1e6).toFixed(0))} MB → ${esc((r.bytesOut / 1e6).toFixed(0))} MB</span>` : ""}</li>`;
        }).join("")}</ul>` : `<p class="muted">No thumbnail runs reported yet (runs before this tab existed did not report).</p>`}
        <p class="muted">${esc(s.shareThumbs.note)}</p>
      </section>

      <section class="panel pl-card">
        <div class="section-title"><h2>${icon("film")} Video previews</h2><span class="muted">720p transcodes in Drive</span></div>
        <div class="pl-stats"><div><span>Ready</span><b>${esc(s.videoPreviews.indexed.toLocaleString())}</b></div><div><span>Failed</span><b>${esc(String(s.videoPreviews.failed))}</b></div><div><span>Queued request</span><b>${s.videoPreviews.queue ? "yes" : "—"}</b></div></div>
        ${ghCard("video-previews", "video runner")}
        <div class="pl-actions"><button class="mini" data-goto-tab="previews" type="button">Open Video previews</button></div>
      </section>

      <section class="panel pl-card">
        <div class="section-title"><h2>${icon("images")} Image archive</h2><span class="muted">re-encode jobs against Drive</span></div>
        ${s.images.active ? `<p><span class="pl-state busy">${icon("loader-circle")}${esc(s.images.active.status)}</span> job <code>${esc(s.images.active.id)}</code> · ${esc(String(s.images.active.progress?.done || 0))}/${esc(String(s.images.active.fileCount || 0))} files · ${esc(s.images.active.options?.mode || "")}</p>` : s.images.last ? `<p><span class="pl-state ${s.images.last.status === "done" ? "ok" : ""}">${esc(s.images.last.status)}</span> last job <code>${esc(s.images.last.id)}</code> · ${esc(ago(s.images.last.finishedAt))} · ${esc(String(s.images.last.progress?.done || 0))} files</p>` : `<p class="muted">No image-archive jobs yet.</p>`}
        ${ghCard("image-archive", "image runner")}
        <div class="pl-actions"><button class="mini" data-goto-tab="images" type="button">Open Image archive</button></div>
      </section>

      <section class="panel pl-card">
        <div class="section-title"><h2>${icon("refresh-cw")} Drive change feed</h2><span class="muted">one changes.list per ${esc(String(Math.round(s.changes.windowSec / 60)))} min, fanned out to every share</span></div>
        <p>${s.changes.anchored ? `Last check <b>${esc(ago(s.changes.checkedAt))}</b>${s.changes.reanchoredAt ? ` · re-anchored ${esc(ago(s.changes.reanchoredAt))}` : ""}` : `<span class="warn">Not anchored yet</span> - the first share visit anchors it.`}</p>
        <div class="pl-actions"><button class="mini" data-check-changes type="button">Check now</button></div>
      </section>

      <section class="panel pl-card">
        <div class="section-title"><h2>${icon("trash-2")} R2 orphan sweep</h2><span class="muted">media nobody references (30-day lifecycle rule otherwise)</span></div>
        <p>${s.orphans ? `Last sweep <b>${esc(ago(s.orphans.at))}</b> · ${esc(String(s.orphans.scanned || 0))} objects checked · <b>${esc(String(s.orphans.removed || 0))}</b> removed · ${esc(String(s.orphans.referenced || 0))} referenced` : `<span class="muted">Never swept.</span>`}</p>
        <div class="pl-actions"><button class="btn ghost" data-sweep-orphans type="button"><span>Clear orphaned media</span></button></div>
      </section>
    </div>`;
}

export async function cancelPipelineRun(button) {
  button.disabled = true;
  const r = await fetch("/api/admin/pipelines/cancel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ runId: button.dataset.cancelRun }) });
  if (!r.ok) alert("Could not cancel that run.");
  refreshPipelines();
}

export async function checkChangesNow(button) {
  button.disabled = true;
  const r = await fetch("/api/admin/share-index/check-changes", { method: "POST" });
  const d = await r.json().catch(() => ({}));
  button.textContent = d.skipped ? `Skipped: ${d.skipped}` : d.anchored ? "Anchored" : d.reanchored ? "Re-anchored" : `${d.changes || 0} changes, ${d.shares || 0} shares`;
  setTimeout(() => {
    button.disabled = false;
    button.textContent = "Check now";
    refreshPipelines();
  }, 4000);
}

export function openPipelines() {
  showTab("pipelines");
}
