import { $, icon } from "./admin-state.js";
import { flash } from "./admin.js";

// Image archive tab: pick folders, choose how to re-encode, dry-run digest,
// start / pause / resume / cancel the job, watch progress, history.

const PRESETS = {
  web: { label: "Web archive", maxMp: 8, quality: 82, format: "same", metadata: "keep" },
  keep: { label: "Recompress only", maxMp: 0, quality: 80, format: "same", metadata: "keep" },
  print: { label: "Print-safe 12 MP", maxMp: 12, quality: 88, format: "same", metadata: "keep" },
  tiny: { label: "Smallest (AVIF 6 MP)", maxMp: 6, quality: 75, format: "avif", metadata: "strip-gps" },
};
const TYPE_LABELS = { jpeg: "JPEG", png: "PNG", heic: "HEIC/HEIF", tiff: "TIFF", webp: "WebP", raw: "RAW (ARW, CR3, NEF, DNG…)" };
const folders = new Map(); // id -> name
let plan = null;
let state = null;
let pollTimer = 0;
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const fmtEta = (s) => (s < 90 ? `${Math.round(s)}s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export async function refreshImages() {
  const host = $("images-body");
  if (!host) return;
  if (!host.dataset.ready) {
    host.innerHTML = shell();
    host.dataset.ready = "1";
    wire();
  }
  try {
    const r = await fetch("/api/admin/images/jobs");
    if (!r.ok) throw new Error(`jobs ${r.status}`);
    state = await r.json();
    renderJobs();
  } catch (error) {
    $("images-jobs").innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  }
  clearTimeout(pollTimer);
  if (state?.active && ["running", "pausing"].includes(state.active.status) && !$("tab-images").classList.contains("hidden")) pollTimer = setTimeout(refreshImages, 20_000);
}
export function stopImagesPolling() {
  clearTimeout(pollTimer);
}

function shell() {
  return `
  <section class="panel">
    <div class="section-title"><div><p class="eyebrow">1 · what</p><h2>${icon("folder-open")} Folders</h2></div>
      <div class="section-tools"><input id="img-folder-input" class="previews-limit img-wide" placeholder="Paste a Drive folder link or id" aria-label="Drive folder link or id"><button class="mini" id="img-folder-add" type="button">add</button><button class="mini" id="img-folder-browse" type="button">${icon("search", "ico-sm")} browse</button></div></div>
    <div id="img-folder-chips" class="img-chips"><span class="muted">No folders picked yet.</span></div>
    <div id="img-browser" class="img-browser hidden"></div>
    <label class="img-check"><input type="checkbox" id="img-recursive" checked> include sub-folders (skips _archive, _compressed, _previews)</label>
  </section>
  <section class="panel">
    <div class="section-title"><div><p class="eyebrow">2 · how</p><h2>${icon("sliders-horizontal")} Encoding</h2></div>
      <div class="section-tools">${Object.entries(PRESETS).map(([k, p]) => `<button class="mini" data-preset="${k}" type="button">${esc(p.label)}</button>`).join("")}</div></div>
    <div class="img-grid">
      <label>Resolution cap <select id="img-maxmp"><option value="0">keep original</option><option value="4">4 MP</option><option value="6">6 MP</option><option value="8" selected>8 MP (≈3464×2309)</option><option value="12">12 MP</option><option value="16">16 MP</option><option value="24">24 MP</option></select></label>
      <label>Quality <span class="muted" id="img-q-val">82</span> <input type="range" id="img-quality" min="50" max="95" value="82"></label>
      <label>Format <select id="img-format"><option value="same" selected>same as source (RAW/HEIC/TIFF → JPEG)</option><option value="jpeg">JPEG</option><option value="webp">WebP</option><option value="avif">AVIF</option></select></label>
      <label>Metadata <select id="img-metadata"><option value="keep" selected>keep EXIF, GPS, colour profile</option><option value="strip-gps">keep EXIF, remove GPS</option><option value="strip">strip all (colour profile kept)</option></select></label>
      <label>Skip files under <input type="number" id="img-minmb" min="0" step="0.5" value="1.5" class="previews-limit"> MB</label>
      <label>Exclude names matching <input id="img-exclude" class="previews-limit img-wide" placeholder="regex, e.g. _edited|\\.psd"></label>
    </div>
    <div class="img-types">${Object.entries(TYPE_LABELS).map(([k, l]) => `<label class="img-check"><input type="checkbox" data-type="${k}" checked> ${esc(l)}</label>`).join("")}</div>
    <label class="img-check"><input type="checkbox" id="img-smaller" checked> only write a result when it is actually smaller than the original</label>
  </section>
  <section class="panel">
    <div class="section-title"><div><p class="eyebrow">3 · originals</p><h2>${icon("shield")} What happens to the original</h2></div></div>
    <div class="img-modes">
      <label class="img-mode"><input type="radio" name="img-mode" value="copy" checked><b>Copy</b><span>Original untouched. New file goes to <code>_compressed/&lt;folder&gt;/</code>. Safe for testing.</span></label>
      <label class="img-mode"><input type="radio" name="img-mode" value="archive"><b>Archive</b><span>Original moved to <code>_archive/&lt;folder&gt;/</code> (no copy, instant). New file takes its place with the same name.</span></label>
      <label class="img-mode img-mode-danger"><input type="radio" name="img-mode" value="replace"><b>Replace</b><span>New bytes become a new revision of the same file (id, name, sharing kept). Drive keeps the old revision ~30 days; after that the original is gone.</span></label>
    </div>
    <div class="section-tools img-actions">
      <button class="btn" id="img-dryrun" type="button">${icon("search", "ico-sm")} Dry run</button>
      <span id="img-confirm-wrap" class="hidden"><input id="img-confirm" class="previews-limit" placeholder='type REPLACE' aria-label="type REPLACE to confirm"></span>
      <button class="btn" id="img-start" type="button" disabled>${icon("play", "ico-sm")} Start job</button>
    </div>
    <div id="img-digest"></div>
  </section>
  <section class="panel"><div class="section-title"><div><p class="eyebrow">jobs</p><h2>${icon("zap")} Progress &amp; history</h2></div><div class="section-tools"><button class="mini" id="img-refresh" type="button">${icon("refresh-cw", "ico-sm")} Refresh</button></div></div><div id="images-jobs"></div></section>`;
}

function options() {
  return {
    folderIds: [...folders.keys()],
    recursive: $("img-recursive").checked,
    maxMp: Number($("img-maxmp").value),
    quality: Number($("img-quality").value),
    format: $("img-format").value,
    metadata: $("img-metadata").value,
    minBytes: Math.round(Number($("img-minmb").value || 0) * 1024 * 1024),
    exclude: $("img-exclude").value.trim(),
    types: [...document.querySelectorAll("[data-type]:checked")].map((c) => c.dataset.type),
    onlyIfSmaller: $("img-smaller").checked,
    mode: document.querySelector('[name="img-mode"]:checked').value,
  };
}

function renderChips() {
  const box = $("img-folder-chips");
  box.innerHTML = folders.size ? [...folders].map(([id, name]) => `<span class="chip">${icon("folder", "chip-icon")}${esc(name)} <button type="button" class="img-chip-x" data-remove-folder="${escAttr(id)}" aria-label="remove ${escAttr(name)}">×</button></span>`).join("") : `<span class="muted">No folders picked yet.</span>`;
  plan = null;
  $("img-start").disabled = true;
}

async function browse(parent = "root") {
  const box = $("img-browser");
  box.classList.remove("hidden");
  box.innerHTML = `<p class="muted">Loading…</p>`;
  const r = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(parent)}`);
  const d = await r.json();
  box.innerHTML = `<div class="img-crumbs">${(d.breadcrumbs || []).map((c) => `<button class="mini" type="button" data-browse="${escAttr(c.id)}">${esc(c.name)}</button>`).join(" / ")}${parent !== "root" ? ` <button class="mini" type="button" data-pick-folder="${escAttr(parent)}" data-name="${escAttr(d.breadcrumbs?.at(-1)?.name || "Folder")}">${icon("folder-check", "ico-sm")} use this folder</button>` : ""}</div>
    <ul class="img-folder-list">${(d.folders || []).map((f) => `<li><button class="mini" type="button" data-browse="${escAttr(f.id)}">${icon("folder", "ico-sm")} ${esc(f.name)}</button><button class="mini" type="button" data-pick-folder="${escAttr(f.id)}" data-name="${escAttr(f.name)}">add</button></li>`).join("") || `<li class="muted">No sub-folders.</li>`}</ul>`;
}

async function addFolderFromInput() {
  const raw = $("img-folder-input").value.trim();
  const id = raw.match(/folders\/([A-Za-z0-9_-]{10,})/)?.[1] || raw.match(/^[A-Za-z0-9_-]{10,}$/)?.[0];
  if (!id) return flash($("img-folder-add"), "not a Drive folder link");
  const r = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(id)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return flash($("img-folder-add"), d.error || "folder not found");
  folders.set(id, d.breadcrumbs?.at(-1)?.name || id);
  $("img-folder-input").value = "";
  renderChips();
}

async function dryRun(button) {
  const o = options();
  if (!o.folderIds.length) return flash(button, "pick a folder first");
  button.disabled = true;
  $("img-digest").innerHTML = `<p class="muted">${icon("loader-circle", "ico-sm")} Scanning Drive (metadata only, nothing is downloaded)…</p>`;
  try {
    const r = await post("/api/admin/images/plan", o);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `plan ${r.status}`);
    plan = d.job;
    renderDigest(plan);
    $("img-start").disabled = !plan.digest.files;
    refreshImages();
  } catch (error) {
    $("img-digest").innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

function renderDigest(job) {
  const g = job.digest;
  const saving = g.bytes - g.estBytes;
  const modeNote = { copy: "Originals stay where they are.", archive: `${g.files} originals move to _archive/.`, replace: `${g.files} originals are overwritten (old revision kept ~30 days).` }[job.options.mode];
  $("img-digest").innerHTML = `
    <div class="stat-grid">
      <div class="stat-card v3"><span class="stat-ico">${icon("images")}</span><div><b>${g.files.toLocaleString()}</b><span class="stat-label">to process (of ${g.scanned.toLocaleString()} images scanned)</span></div></div>
      <div class="stat-card v3"><span class="stat-ico">${icon("hard-drive")}</span><div><b>${fmtBytes(g.bytes)} → ~${fmtBytes(g.estBytes)}</b><span class="stat-label">size now → expected</span></div></div>
      <div class="stat-card v3"><span class="stat-ico">${icon("circle-check")}</span><div><b>~${fmtBytes(Math.max(0, saving))} · ${pct(saving, g.bytes)}%</b><span class="stat-label">expected saving</span></div></div>
      <div class="stat-card v3"><span class="stat-ico">${icon("timer")}</span><div><b>~${fmtEta(g.etaSec)}</b><span class="stat-label">estimated run time</span></div></div>
    </div>
    <p class="muted">${esc(modeNote)} ${g.capped ? "Plan capped at 5000 files - run again afterwards for the rest." : ""} Estimates use ${job.options.maxMp ? `${job.options.maxMp} MP cap, ` : ""}quality ${job.options.quality}, ${job.options.format === "same" ? "same format" : job.options.format.toUpperCase()}; real sizes vary ±30%.</p>
    <div class="img-digest-cols">
      <div><p class="eyebrow">by type</p><ul class="img-kv">${Object.entries(g.byType).map(([t, n]) => `<li><span>${esc(TYPE_LABELS[t] || t)}</span><b>${n}</b></li>`).join("") || "<li class='muted'>none</li>"}</ul></div>
      <div><p class="eyebrow">skipped</p><ul class="img-kv">${Object.entries(g.skipped).map(([why, n]) => `<li><span>${esc(why)}</span><b>${n}</b></li>`).join("") || "<li class='muted'>nothing skipped</li>"}</ul></div>
      <div><p class="eyebrow">largest</p><ul class="img-kv">${g.largest.map((f) => `<li><span title="${escAttr(f.name)}">${esc(f.name)} <small class="muted">${f.w && f.h ? `${f.w}×${f.h}` : f.type}</small></span><b>${fmtBytes(f.size)} → ~${fmtBytes(f.est)}</b></li>`).join("") || "<li class='muted'>—</li>"}</ul></div>
    </div>`;
}

function renderJobs() {
  const { jobs, active } = state;
  const rows = jobs.map((j) => {
    const total = j.fileCount || 0;
    const done = j.progress.done + j.progress.failed + j.progress.skipped;
    const controls = ["running", "pausing", "paused", "planned"].includes(j.status)
      ? `<span class="section-tools">${j.status === "running" ? `<button class="mini" data-job-action="pause" data-job="${j.id}" type="button">pause</button>` : ""}${["paused", "pausing"].includes(j.status) ? `<button class="mini" data-job-action="resume" data-job="${j.id}" type="button">resume</button>` : ""}<button class="mini danger" data-job-action="cancel" data-job="${j.id}" type="button">cancel</button></span>`
      : "";
    return `<tr data-state="${j.status}"><td><b>${esc(j.id)}</b><br><small class="muted">${(j.roots || []).map((r) => esc(r.name)).join(", ")} · ${j.options.mode} · ${j.options.maxMp ? `${j.options.maxMp} MP` : "full res"} q${j.options.quality}</small></td>
      <td><span class="chip img-status" data-status="${j.status}">${esc(j.status)}</span></td>
      <td><span class="previews-bar"><i style="width:${pct(done, total)}%"></i></span> ${done}/${total}${j.progress.failed ? ` · <span class="img-bad">${j.progress.failed} failed</span>` : ""}${j.progress.skipped ? ` · ${j.progress.skipped} skipped` : ""}</td>
      <td class="num">${fmtBytes(j.progress.bytesIn)} → ${fmtBytes(j.progress.bytesOut)}${j.progress.bytesIn ? ` <small class="muted">(−${pct(j.progress.bytesIn - j.progress.bytesOut, j.progress.bytesIn)}%)</small>` : ""}</td>
      <td>${controls} <button class="mini" data-job-items="${j.id}" type="button">files</button></td></tr>`;
  });
  $("images-jobs").innerHTML = `${active ? `<p class="muted">${icon("zap", "ico-sm")} ${esc(active.id)} is ${esc(active.status)} - ${active.status === "running" ? "the runner reports every 8 files; this view refreshes every 20 s." : active.status === "pausing" ? "the runner stops after the current file." : "resume to continue where it left off."}</p>` : ""}
    ${!state.dispatchConfigured ? `<p class="muted">${icon("info", "ico-sm")} No <code>GITHUB_TOKEN</code> on the worker: start/resume only mark the job; run <code>JOB_ID=… node scripts/transcode-images.mjs</code> locally.</p>` : ""}
    ${rows.length ? `<div class="upload-table-wrap"><table class="uploads"><thead><tr><th>Job</th><th>Status</th><th>Progress</th><th class="num">In → out</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table></div><div id="img-items"></div>` : `<p class="muted">No jobs yet - run a dry run above.</p>`}`;
}

async function showItems(id) {
  const r = await fetch(`/api/admin/images/jobs/${encodeURIComponent(id)}/items`);
  const d = await r.json();
  $("img-items").innerHTML = `<details open class="previews-run-items"><summary>${esc(id)} · ${d.items.length} processed</summary><ul>${d.items.map((i) => `<li>${i.ok ? icon("check", "ico-sm") : icon(i.soft ? "info" : "circle-x", "ico-sm")} ${esc(i.path)}/${esc(i.name)} <span class="muted">${i.ok ? `${fmtBytes(i.size)} · ${fmtTime(i.ms / 1000)}` : esc(i.error)}</span></li>`).join("") || "<li class='muted'>nothing yet</li>"}</ul></details>`;
}

async function jobAction(button, id, action) {
  const body = {};
  if (action === "start") {
    if (!plan) return;
    if (plan.options.mode === "replace") body.confirm = $("img-confirm").value.trim();
  }
  if (action === "cancel" && !confirm("Cancel this job? Files already written stay as they are.")) return;
  button.disabled = true;
  const r = await post(`/api/admin/images/jobs/${encodeURIComponent(id)}/${action}`, body);
  const d = await r.json().catch(() => ({}));
  flash(button, r.ok ? (d.dispatched === false ? d.reason : `${action} ok`) : d.error || `${action} failed`);
  if (!r.ok) button.disabled = false;
  setTimeout(refreshImages, 1500);
}

function wire() {
  const host = $("images-body");
  host.querySelector("#img-quality").addEventListener("input", (e) => ($("img-q-val").textContent = e.target.value));
  host.querySelector("#img-folder-add").addEventListener("click", addFolderFromInput);
  host.querySelector("#img-folder-input").addEventListener("keydown", (e) => e.key === "Enter" && addFolderFromInput());
  host.querySelector("#img-folder-browse").addEventListener("click", () => browse("root"));
  host.querySelector("#img-dryrun").addEventListener("click", (e) => dryRun(e.currentTarget));
  host.querySelector("#img-start").addEventListener("click", (e) => jobAction(e.currentTarget, plan.id, "start"));
  host.querySelector("#img-refresh").addEventListener("click", () => refreshImages());
  host.addEventListener("change", (e) => {
    if (e.target.name === "img-mode") $("img-confirm-wrap").classList.toggle("hidden", e.target.value !== "replace");
    if (e.target.closest("#img-recursive, #img-maxmp, #img-format, #img-metadata, #img-minmb, #img-smaller, [data-type], [name=img-mode]")) {
      plan = null;
      $("img-start").disabled = true;
    }
  });
  host.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    if (t.dataset.preset) {
      const p = PRESETS[t.dataset.preset];
      $("img-maxmp").value = String(p.maxMp);
      $("img-quality").value = String(p.quality);
      $("img-q-val").textContent = String(p.quality);
      $("img-format").value = p.format;
      $("img-metadata").value = p.metadata;
      plan = null;
      $("img-start").disabled = true;
    } else if (t.dataset.browse) browse(t.dataset.browse);
    else if (t.dataset.pickFolder) {
      folders.set(t.dataset.pickFolder, t.dataset.name);
      renderChips();
    } else if (t.dataset.removeFolder) {
      folders.delete(t.dataset.removeFolder);
      renderChips();
    } else if (t.dataset.jobAction) jobAction(t, t.dataset.job, t.dataset.jobAction);
    else if (t.dataset.jobItems) showItems(t.dataset.jobItems);
  });
}
