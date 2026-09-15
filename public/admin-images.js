import { $, icon } from "./admin-state.js";
import { flash } from "./admin.js";

// Image archive tab. Left: three steps (folders, encoding, originals).
// Right: a sticky plan card with a live estimate, the dry-run digest and
// the start button. Below: job cards with progress and controls.

const PRESETS = [
  { key: "web", name: "Web archive", blurb: "8 MP, quality 82, same format. 24 MP JPEGs land around 2–3 MB.", icon: "images", maxMp: 8, quality: 82, format: "same", metadata: "keep" },
  { key: "keep", name: "Recompress only", blurb: "Keep every pixel, just a saner JPEG encoder. Smallest change.", icon: "gauge", maxMp: 0, quality: 80, format: "same", metadata: "keep" },
  { key: "print", name: "Print-safe", blurb: "12 MP at quality 88 still prints A3 cleanly.", icon: "file-check", maxMp: 12, quality: 88, format: "same", metadata: "keep" },
  { key: "tiny", name: "Smallest", blurb: "AVIF at 6 MP, GPS removed. For sharing, not for editing.", icon: "wand-sparkles", maxMp: 6, quality: 75, format: "avif", metadata: "strip-gps" },
];
const MP_STEPS = [0, 4, 6, 8, 12, 16, 24];
const TYPES = [["jpeg", "JPEG"], ["png", "PNG"], ["heic", "HEIC"], ["tiff", "TIFF"], ["webp", "WebP"], ["raw", "RAW"]];
const BPP = { jpeg: 0.3, webp: 0.22, avif: 0.15, png: 1.2 };
const MODES = [
  { key: "copy", icon: "files", name: "Copy", blurb: "Originals untouched. New files go to _compressed/… mirroring the folder tree. Use this to test." },
  { key: "archive", icon: "folder-check", name: "Archive", blurb: "Originals move to _archive/… (instant, no copy). New files take their place with the same names." },
  { key: "replace", icon: "triangle-alert", name: "Replace", blurb: "New bytes become a new revision of the same file - id, name, sharing kept. Drive keeps the old revision about 30 days; after that the original is gone.", danger: true },
];

const folders = new Map();
const cfg = { maxMp: 8, quality: 82, format: "same", metadata: "keep", mode: "copy", recursive: true, onlyIfSmaller: true, minMb: 1.5, exclude: "", types: new Set(TYPES.map(([k]) => k)) };
let plan = null;
let state = null;
let pollTimer = 0;
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const fmtEta = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const seg = (name, items, current) => `<div class="seg-control ia-seg" role="group" data-seg="${name}">${items.map(([v, label]) => `<button type="button" data-value="${escAttr(String(v))}" aria-pressed="${String(v) === String(current)}">${esc(label)}</button>`).join("")}</div>`;

export async function refreshImages() {
  const host = $("images-body");
  if (!host) return;
  if (!host.dataset.ready) {
    host.innerHTML = shell();
    host.dataset.ready = "1";
    wire();
    syncControls();
  }
  try {
    const r = await fetch("/api/admin/images/jobs");
    if (!r.ok) throw new Error(`jobs ${r.status}`);
    state = await r.json();
    renderJobs();
  } catch (error) {
    $("ia-jobs").innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  }
  clearTimeout(pollTimer);
  if (state?.active && ["running", "pausing"].includes(state.active.status) && !$("tab-images").classList.contains("hidden")) pollTimer = setTimeout(refreshImages, 20_000);
}
export function stopImagesPolling() {
  clearTimeout(pollTimer);
}

function shell() {
  return `<div class="ia-layout">
  <div class="ia-main">
    <section class="panel ia-step">
      <header class="ia-step-head"><span class="ia-step-n">1</span><div><h2>Folders</h2><p class="muted">Which Drive folders to go through. Sub-folders included; _archive, _compressed and _previews are always skipped.</p></div></header>
      <div class="ia-folder-row"><input id="ia-folder-input" class="ia-input" placeholder="Paste a Drive folder link or id" aria-label="Drive folder link or id"><button class="mini" id="ia-folder-add" type="button">${icon("plus", "ico-sm")} add</button><button class="mini" id="ia-folder-browse" type="button">${icon("folder-open", "ico-sm")} browse Drive</button></div>
      <div id="ia-chips" class="ia-chips"></div>
      <div id="ia-browser" class="ia-browser hidden"></div>
      <div class="ia-toggles">${toggle("recursive", "Include sub-folders", cfg.recursive)}</div>
    </section>
    <section class="panel ia-step">
      <header class="ia-step-head"><span class="ia-step-n">2</span><div><h2>Encoding</h2><p class="muted">Start from a preset, then tune. The card on the right shows what a 24 MP photo becomes.</p></div></header>
      <div class="ia-presets">${PRESETS.map((p) => `<button type="button" class="ia-preset" data-preset="${p.key}"><span class="ia-preset-ico">${icon(p.icon)}</span><b>${esc(p.name)}</b><small>${esc(p.blurb)}</small></button>`).join("")}</div>
      <div class="ia-field"><label>Resolution cap</label>${seg("maxMp", MP_STEPS.map((v) => [v, v ? `${v} MP` : "keep"]), cfg.maxMp)}<small class="muted" id="ia-mp-note"></small></div>
      <div class="ia-field"><label>Quality <output id="ia-q-out">${cfg.quality}</output></label><input type="range" id="ia-quality" class="ia-range" min="50" max="95" value="${cfg.quality}" aria-label="Quality"><small class="muted">50 visibly soft · 75–85 sweet spot · 90+ near-lossless, twice the bytes</small></div>
      <div class="ia-two">
        <div class="ia-field"><label>Format</label>${seg("format", [["same", "same as source"], ["jpeg", "JPEG"], ["webp", "WebP"], ["avif", "AVIF"]], cfg.format)}<small class="muted">RAW, HEIC and TIFF always become JPEG under "same".</small></div>
        <div class="ia-field"><label>Metadata</label>${seg("metadata", [["keep", "keep all"], ["strip-gps", "remove GPS"], ["strip", "strip"]], cfg.metadata)}<small class="muted">Colour profile is always kept; "strip" drops EXIF, XMP, IPTC.</small></div>
      </div>
      <div class="ia-field"><label>File types</label><div class="ia-chipset" id="ia-types">${TYPES.map(([k, l]) => `<button type="button" class="ia-chip" data-type="${k}" aria-pressed="true">${esc(l)}</button>`).join("")}</div></div>
      <details class="ia-adv"><summary>Advanced</summary>
        <div class="ia-two">
          <div class="ia-field"><label>Skip files under</label><div class="ia-inline"><input type="number" id="ia-minmb" class="ia-input ia-num" min="0" step="0.5" value="${cfg.minMb}"><span class="muted">MB</span></div></div>
          <div class="ia-field"><label>Exclude names matching</label><input id="ia-exclude" class="ia-input" placeholder="regex, e.g. _edited|\\.psd$"></div>
        </div>
        <div class="ia-toggles">${toggle("onlyIfSmaller", "Only keep a result that is smaller than the original", cfg.onlyIfSmaller)}</div>
      </details>
    </section>
    <section class="panel ia-step">
      <header class="ia-step-head"><span class="ia-step-n">3</span><div><h2>Originals</h2><p class="muted">What happens to each original after its smaller copy is stored and verified.</p></div></header>
      <div class="ia-modes">${MODES.map((m) => `<button type="button" class="ia-mode${m.danger ? " ia-mode-danger" : ""}" data-mode="${m.key}" aria-pressed="${cfg.mode === m.key}"><span class="ia-mode-ico">${icon(m.icon)}</span><b>${esc(m.name)}</b><small>${esc(m.blurb)}</small></button>`).join("")}</div>
      <div id="ia-confirm" class="ia-confirm hidden"><label for="ia-confirm-input">Type <code>REPLACE</code> to allow overwriting originals</label><input id="ia-confirm-input" class="ia-input ia-num" autocomplete="off"></div>
    </section>
  </div>
  <aside class="ia-side">
    <div class="panel ia-plan">
      <p class="eyebrow">plan</p>
      <div class="ia-sample" id="ia-sample"></div>
      <div class="ia-plan-actions"><button class="btn" id="ia-dryrun" type="button">${icon("search", "ico-sm")} Dry run</button><button class="btn ia-start" id="ia-start" type="button" disabled>${icon("play", "ico-sm")} Start</button></div>
      <div id="ia-digest" class="ia-digest"><p class="muted">Pick folders and run a dry run. Nothing is downloaded or written until you start.</p></div>
    </div>
  </aside>
  </div>
  <section class="panel">
    <div class="section-title"><div><p class="eyebrow">jobs</p><h2>${icon("zap")} Progress &amp; history</h2></div><div class="section-tools"><button class="mini" id="ia-refresh" type="button">${icon("refresh-cw", "ico-sm")} Refresh</button></div></div>
    <div id="ia-jobs"></div>
  </section>`;
}
const toggle = (key, label, on) => `<label class="ia-toggle"><input type="checkbox" data-toggle="${key}" ${on ? "checked" : ""}><span class="ia-switch" aria-hidden="true"></span><span>${esc(label)}</span></label>`;

// Live "what a 24 MP photo becomes" - same arithmetic as the worker's dry run.
function sampleEstimate() {
  const srcPx = 24e6;
  const outPx = cfg.maxMp ? Math.min(srcPx, cfg.maxMp * 1e6) : srcPx;
  const format = cfg.format === "same" ? "jpeg" : cfg.format;
  const bytes = outPx * (BPP[format] || 0.3) * (cfg.quality / 82);
  const side = Math.round(Math.sqrt(outPx * 1.5));
  return { bytes, w: side, h: Math.round(side / 1.5), format };
}
function syncControls() {
  $("ia-q-out").textContent = String(cfg.quality);
  $("ia-quality").value = String(cfg.quality);
  for (const s of document.querySelectorAll("[data-seg]")) for (const b of s.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.value === String(cfg[s.dataset.seg])));
  for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === cfg.mode));
  for (const b of document.querySelectorAll("[data-type]")) b.setAttribute("aria-pressed", String(cfg.types.has(b.dataset.type)));
  for (const p of document.querySelectorAll("[data-preset]")) {
    const preset = PRESETS.find((x) => x.key === p.dataset.preset);
    p.setAttribute("aria-pressed", String(preset.maxMp === cfg.maxMp && preset.quality === cfg.quality && preset.format === cfg.format && preset.metadata === cfg.metadata));
  }
  $("ia-confirm").classList.toggle("hidden", cfg.mode !== "replace");
  $("ia-mp-note").textContent = cfg.maxMp ? `≈ ${Math.round(Math.sqrt(cfg.maxMp * 1e6 * 1.5))}×${Math.round(Math.sqrt(cfg.maxMp * 1e6 / 1.5))} for a 3:2 photo` : "keeps the original pixel count";
  const s = sampleEstimate();
  $("ia-sample").innerHTML = `<div class="ia-sample-row"><span class="ia-sample-box"><b>24 MP</b><small>6000×4000 · ~14 MB</small></span><span class="ia-sample-arrow">${icon("chevron-right")}</span><span class="ia-sample-box ia-sample-out"><b>~${fmtBytes(s.bytes)}</b><small>${s.w}×${s.h} · ${s.format.toUpperCase()} q${cfg.quality}</small></span></div><small class="muted">per photo, ±30% depending on detail</small>`;
  plan = null;
  $("ia-start").disabled = true;
}
function options() {
  return { folderIds: [...folders.keys()], recursive: cfg.recursive, maxMp: cfg.maxMp, quality: cfg.quality, format: cfg.format, metadata: cfg.metadata, minBytes: Math.round(cfg.minMb * 1024 * 1024), exclude: cfg.exclude, types: [...cfg.types], onlyIfSmaller: cfg.onlyIfSmaller, mode: cfg.mode };
}

function renderChips() {
  $("ia-chips").innerHTML = folders.size ? [...folders].map(([id, name]) => `<span class="chip ia-folder-chip">${icon("folder", "chip-icon")}${esc(name)}<button type="button" class="ia-chip-x" data-remove-folder="${escAttr(id)}" aria-label="remove ${escAttr(name)}">${icon("x", "ico-sm")}</button></span>`).join("") : `<span class="muted">No folders picked yet.</span>`;
  plan = null;
  $("ia-start").disabled = true;
}
async function browse(parent = "root") {
  const box = $("ia-browser");
  box.classList.remove("hidden");
  box.innerHTML = `<p class="muted">Loading…</p>`;
  const r = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(parent)}`);
  const d = await r.json();
  const here = d.breadcrumbs?.at(-1);
  box.innerHTML = `<div class="ia-crumbs">${(d.breadcrumbs || []).map((c) => `<button class="mini" type="button" data-browse="${escAttr(c.id)}">${esc(c.name)}</button>`).join(`<span class="muted">/</span>`)}${parent !== "root" ? `<button class="mini ia-use" type="button" data-pick-folder="${escAttr(parent)}" data-name="${escAttr(here?.name || "Folder")}">${icon("check", "ico-sm")} use "${esc(here?.name || "folder")}"</button>` : ""}<button class="mini" type="button" id="ia-browser-close" aria-label="close browser">${icon("x", "ico-sm")}</button></div>
    <ul class="ia-folder-list">${(d.folders || []).map((f) => `<li><button type="button" class="ia-folder-open" data-browse="${escAttr(f.id)}">${icon("folder", "ico-sm")} ${esc(f.name)}</button><button class="mini" type="button" data-pick-folder="${escAttr(f.id)}" data-name="${escAttr(f.name)}">add</button></li>`).join("") || `<li class="muted">No sub-folders here.</li>`}</ul>`;
}
async function addFolderFromInput() {
  const raw = $("ia-folder-input").value.trim();
  const id = raw.match(/folders\/([A-Za-z0-9_-]{10,})/)?.[1] || raw.match(/^[A-Za-z0-9_-]{10,}$/)?.[0];
  if (!id) return flash($("ia-folder-add"), "not a Drive folder link");
  const r = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(id)}`);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return flash($("ia-folder-add"), d.error || "folder not found");
  folders.set(id, d.breadcrumbs?.at(-1)?.name || id);
  $("ia-folder-input").value = "";
  renderChips();
}

async function dryRun(button) {
  const o = options();
  if (!o.folderIds.length) return flash(button, "pick a folder first");
  button.disabled = true;
  $("ia-digest").innerHTML = `<p class="muted">${icon("loader-circle", "ico-sm")} Scanning Drive metadata…</p>`;
  try {
    const r = await post("/api/admin/images/plan", o);
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `plan ${r.status}`);
    plan = d.job;
    renderDigest(plan);
    $("ia-start").disabled = !plan.digest.files;
    refreshImages();
  } catch (error) {
    $("ia-digest").innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}
function renderDigest(job) {
  const g = job.digest;
  const saving = Math.max(0, g.bytes - g.estBytes);
  const after = pct(g.estBytes, g.bytes);
  const modeNote = { copy: "Originals stay where they are.", archive: `${g.files} originals move to _archive/.`, replace: `${g.files} originals are overwritten.` }[job.options.mode];
  const kv = (obj, empty) => Object.entries(obj).map(([k, n]) => `<li><span>${esc(TYPES.find(([t]) => t === k)?.[1] || k)}</span><b>${n}</b></li>`).join("") || `<li class="muted">${empty}</li>`;
  $("ia-digest").innerHTML = `
    <div class="ia-digest-hero"><b>${g.files.toLocaleString()}</b><span>files to process<br><small class="muted">of ${g.scanned.toLocaleString()} images scanned</small></span></div>
    <div class="ia-bar" aria-label="size before and after"><i style="width:${after}%"></i></div>
    <div class="ia-bar-legend"><span>${fmtBytes(g.bytes)} now</span><span>→ ~${fmtBytes(g.estBytes)}</span></div>
    <ul class="ia-facts">
      <li>${icon("circle-check", "ico-sm")} saves ~${fmtBytes(saving)} <span class="muted">(${pct(saving, g.bytes)}%)</span></li>
      <li>${icon("timer", "ico-sm")} about ${fmtEta(g.etaSec)} on the runner</li>
      <li>${icon(job.options.mode === "replace" ? "triangle-alert" : "shield", "ico-sm")} ${esc(modeNote)}</li>
      ${g.capped ? `<li>${icon("info", "ico-sm")} capped at 5000 files - run again for the rest</li>` : ""}
    </ul>
    <details class="ia-digest-more"><summary>Breakdown</summary>
      <p class="eyebrow">by type</p><ul class="img-kv">${kv(g.byType, "none")}</ul>
      <p class="eyebrow">skipped</p><ul class="img-kv">${kv(g.skipped, "nothing skipped")}</ul>
      <p class="eyebrow">largest</p><ul class="img-kv">${g.largest.map((f) => `<li><span title="${escAttr(f.name)}">${esc(f.name)}</span><b>${fmtBytes(f.size)} → ~${fmtBytes(f.est)}</b></li>`).join("")}</ul>
    </details>`;
}

function renderJobs() {
  const { jobs, active } = state;
  const cards = jobs.map((j) => {
    const total = j.fileCount || 0;
    const done = j.progress.done + j.progress.failed + j.progress.skipped;
    const p = j.progress;
    const saved = p.bytesIn - p.bytesOut;
    const ctl = [];
    if (j.status === "running") ctl.push(`<button class="mini" data-job-action="pause" data-job="${j.id}" type="button">${icon("pause", "ico-sm")} pause</button>`);
    if (["paused", "pausing"].includes(j.status)) ctl.push(`<button class="mini" data-job-action="resume" data-job="${j.id}" type="button">${icon("play", "ico-sm")} resume</button>`);
    if (["running", "pausing", "paused", "planned"].includes(j.status)) ctl.push(`<button class="mini danger" data-job-action="cancel" data-job="${j.id}" type="button">cancel</button>`);
    ctl.push(`<button class="mini" data-job-items="${j.id}" type="button">${icon("list", "ico-sm")} files</button>`);
    const note = { running: "runner reports every 8 files · auto-refresh 20 s", pausing: "stops after the current file", paused: "resume to continue where it left off", planned: "waiting for start", done: `finished ${j.finishedAt ? new Date(j.finishedAt).toLocaleString() : ""}`, cancelled: "cancelled - files already written stay" }[j.status] || "";
    return `<article class="ia-job" data-status="${j.status}">
      <div class="ia-job-head"><div><b>${(j.roots || []).map((r) => esc(r.name)).join(", ") || esc(j.id)}</b><small class="muted">${esc(j.id)} · ${j.options.mode} · ${j.options.maxMp ? `${j.options.maxMp} MP` : "full res"} · q${j.options.quality} · ${j.options.format}</small></div><span class="chip ia-status" data-status="${j.status}">${esc(j.status)}</span></div>
      <div class="ia-bar ia-bar-progress"><i style="width:${pct(done, total)}%"></i></div>
      <div class="ia-job-stats"><span><b>${done}</b>/${total} files</span><span><b>${fmtBytes(p.bytesIn)}</b> → <b>${fmtBytes(p.bytesOut)}</b>${p.bytesIn ? ` <em>−${pct(saved, p.bytesIn)}%</em>` : ""}</span>${p.failed ? `<span class="img-bad">${p.failed} failed</span>` : ""}${p.skipped ? `<span class="muted">${p.skipped} skipped</span>` : ""}<span class="muted">${esc(note)}</span></div>
      <div class="ia-job-ctl">${ctl.join("")}</div>
      <div class="ia-job-items" id="ia-items-${escAttr(j.id)}"></div>
    </article>`;
  });
  $("ia-jobs").innerHTML = `${!state.dispatchConfigured ? `<p class="muted">${icon("info", "ico-sm")} No <code>GITHUB_TOKEN</code> on the worker: start/resume only mark the job; run <code>JOB_ID=… node scripts/transcode-images.mjs</code> locally.</p>` : ""}${cards.join("") || `<p class="muted">No jobs yet - run a dry run above.</p>`}`;
  void active;
}
async function showItems(id) {
  const box = $(`ia-items-${id}`);
  if (box.innerHTML) return (box.innerHTML = "");
  const r = await fetch(`/api/admin/images/jobs/${encodeURIComponent(id)}/items`);
  const d = await r.json();
  box.innerHTML = `<ul class="ia-items">${d.items.map((i) => `<li>${i.ok ? icon("check", "ico-sm") : icon(i.soft ? "info" : "circle-x", "ico-sm")} <span class="ia-item-name" title="${escAttr(i.path)}/${escAttr(i.name)}">${esc(i.name)}</span><span class="muted">${i.ok ? `${fmtBytes(i.size)} · ${fmtTime(i.ms / 1000)}` : esc(i.error)}</span></li>`).join("") || "<li class='muted'>nothing processed yet</li>"}</ul>`;
}
async function jobAction(button, id, action) {
  const body = {};
  if (action === "start" && cfg.mode === "replace") body.confirm = $("ia-confirm-input").value.trim();
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
  $("ia-quality").addEventListener("input", (e) => {
    cfg.quality = Number(e.target.value);
    syncControls();
  });
  $("ia-minmb").addEventListener("change", (e) => (cfg.minMb = Math.max(0, Number(e.target.value) || 0), syncControls()));
  $("ia-exclude").addEventListener("change", (e) => (cfg.exclude = e.target.value.trim(), syncControls()));
  $("ia-folder-add").addEventListener("click", addFolderFromInput);
  $("ia-folder-input").addEventListener("keydown", (e) => e.key === "Enter" && addFolderFromInput());
  $("ia-folder-browse").addEventListener("click", () => browse("root"));
  $("ia-dryrun").addEventListener("click", (e) => dryRun(e.currentTarget));
  $("ia-start").addEventListener("click", (e) => plan && jobAction(e.currentTarget, plan.id, "start"));
  $("ia-refresh").addEventListener("click", () => refreshImages());
  host.addEventListener("change", (e) => {
    const t = e.target.closest("[data-toggle]");
    if (!t) return;
    cfg[t.dataset.toggle] = t.checked;
    syncControls();
  });
  host.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const s = t.closest("[data-seg]");
    if (s) {
      const v = t.dataset.value;
      cfg[s.dataset.seg] = s.dataset.seg === "maxMp" ? Number(v) : v;
      return syncControls();
    }
    if (t.dataset.preset) {
      Object.assign(cfg, (({ maxMp, quality, format, metadata }) => ({ maxMp, quality, format, metadata }))(PRESETS.find((p) => p.key === t.dataset.preset)));
      return syncControls();
    }
    if (t.dataset.mode) {
      cfg.mode = t.dataset.mode;
      return syncControls();
    }
    if (t.dataset.type) {
      cfg.types.has(t.dataset.type) ? cfg.types.delete(t.dataset.type) : cfg.types.add(t.dataset.type);
      return syncControls();
    }
    if (t.id === "ia-browser-close") return $("ia-browser").classList.add("hidden");
    if (t.dataset.browse) return browse(t.dataset.browse);
    if (t.dataset.pickFolder) {
      folders.set(t.dataset.pickFolder, t.dataset.name);
      return renderChips();
    }
    if (t.dataset.removeFolder) {
      folders.delete(t.dataset.removeFolder);
      return renderChips();
    }
    if (t.dataset.jobAction) return jobAction(t, t.dataset.job, t.dataset.jobAction);
    if (t.dataset.jobItems) return showItems(t.dataset.jobItems);
  });
  renderChips();
}
