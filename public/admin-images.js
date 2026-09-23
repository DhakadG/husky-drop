import { $, icon } from "./admin-state.js";
import { flash } from "./admin.js";
import { TYPE_LABELS, summarize, trialCandidates, trialEncode } from "./admin-images-plan.js";
import { openFolderPicker, setImagePickHandler } from "./admin-links.js";
import { initRules, loadRules, ruleAction, saveRule } from "./admin-images-rules.js";

// Image archive tab. Flow: pick sources → scan once → tune the recipe with
// instant estimates over the scanned rows → start (the worker re-plans and
// stores the job) → watch job cards. Nothing is downloaded until start,
// except the optional one-photo trial.

const PRESETS = [
  { key: "web", name: "Web archive", blurb: "8 MP, quality 82. Big camera JPEGs land around 1–3 MB.", icon: "images", maxMp: 8, quality: 82, format: "same", metadata: "keep", targetMb: 0 },
  { key: "sized", name: "About 2.5 MB each", blurb: "8 MP with a per-photo size target; quality follows the photo.", icon: "gauge", maxMp: 8, quality: 82, format: "same", metadata: "keep", targetMb: 2.5 },
  { key: "keep", name: "Recompress only", blurb: "Every pixel kept, just a saner encoder. Smallest change.", icon: "file-check", maxMp: 0, quality: 80, format: "same", metadata: "keep", targetMb: 0 },
  { key: "print", name: "Print-safe", blurb: "12 MP at quality 88 still prints A3 cleanly.", icon: "aperture", maxMp: 12, quality: 88, format: "same", metadata: "keep", targetMb: 0 },
  { key: "tiny", name: "Smallest", blurb: "AVIF at 6 MP, GPS removed. For sharing, not editing.", icon: "wand-sparkles", maxMp: 6, quality: 75, format: "avif", metadata: "strip-gps", targetMb: 0 },
];
const MP_STEPS = [0, 2, 4, 6, 8, 12, 16, 24];
const MP_CARDS = MP_STEPS.map((v) => ({ v, name: v ? `${v} MP` : "Keep", sub: v ? `${Math.round(Math.sqrt(v * 1e6 * 1.5))}×${Math.round(Math.sqrt((v * 1e6) / 1.5))}` : "no downscale", hint: { 0: "original pixels", 2: "phone screens", 4: "4K TV", 6: "small prints", 8: "A4 print", 12: "A3 print", 16: "large print", 24: "full-frame" }[v] }));
const FORMAT_CARDS = [
  { v: "same", name: "Same as source", sub: "JPEG stays JPEG, PNG stays PNG", hint: "RAW · HEIC · TIFF → JPEG" },
  { v: "jpeg", name: "JPEG", sub: "opens everywhere", hint: "best for photos" },
  { v: "webp", name: "WebP", sub: "~25% smaller than JPEG", hint: "screenshots, web" },
  { v: "avif", name: "AVIF", sub: "~50% smaller than JPEG", hint: "slow encode, newer apps" },
];
const META_CARDS = [
  { v: "keep", name: "Keep everything", sub: "camera, lens, date, GPS", hint: "for your own archive" },
  { v: "strip-gps", name: "Remove GPS", sub: "camera & date kept", hint: "for sharing" },
  { v: "strip", name: "Strip", sub: "colour profile only", hint: "for publishing" },
];
const optCards = (name, cards, current) => `<div class="ia-opts" data-seg="${name}">${cards.map((c) => `<button type="button" data-value="${escAttr(String(c.v))}" aria-pressed="${String(c.v) === String(current)}"><b>${esc(c.name)}</b><span>${esc(c.sub)}</span><small>${esc(c.hint)}</small></button>`).join("")}</div>`;
const MODES = [
  { key: "copy", icon: "files", name: "Copy", blurb: "Originals untouched. New files go to _compressed/… mirroring the folder tree. Undo removes the copies." },
  { key: "archive", icon: "folder-check", name: "Archive", blurb: "Originals move to _archive/… (instant, no copy). New files take their place. Undo moves them back." },
  { key: "replace", icon: "triangle-alert", name: "Replace", blurb: "New bytes become a new revision of the same file - id, name, sharing kept. Drive keeps the old revision ~30 days; no undo here.", danger: true },
];
const SPEED = ["gentle · 1 at a time", "2 in parallel", "3 in parallel", "balanced · 4 (all cores)", "5 in parallel", "6 in parallel", "7 in parallel", "max · 8 (network-bound)"];

const roots = new Map(); // id -> name
const excluded = new Set(); // folder ids unticked in the tree
const cfg = { maxMp: 8, quality: 82, format: "same", metadata: "keep", mode: "copy", recursive: true, onlyIfSmaller: true, minMb: 1.5, targetMb: 0, exclude: "", excludeRe: "", skipRecentDays: 0, skipSidecar: true, largestFirst: false, parallel: 4, notify: true, types: new Set(Object.keys(TYPE_LABELS)) };
let every = "daily";
let known = { shares: [], links: [] };
const RECENT_KEY = "lhdb_ia_recent";
const recentFolders = () => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
  } catch {
    return [];
  }
};
const rememberRecent = (id, name) => {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ id, name }, ...recentFolders().filter((f) => f.id !== id)].slice(0, 8)));
  } catch {}
};
let scan = null;
let state = null;
let pollTimer = 0;
let trial = null;
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
const fmtEta = (s) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const toggle = (key, label, on, hint = "") => `<label class="ia-toggle"><input type="checkbox" data-toggle="${key}" ${on ? "checked" : ""}><span class="ia-switch" aria-hidden="true"></span><span>${esc(label)}${hint ? `<small>${esc(hint)}</small>` : ""}</span></label>`;

export async function refreshImages() {
  const host = $("images-body");
  if (!host) return;
  if (!host.dataset.ready) {
    host.innerHTML = shell();
    host.dataset.ready = "1";
    wire();
    sync();
    loadSources();
  }
  try {
    const r = await fetch("/api/admin/images/jobs");
    if (!r.ok) throw new Error(`jobs ${r.status}`);
    state = await r.json();
    renderJobs();
    sync();
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
      <header class="ia-step-head"><span class="ia-step-n">1</span><div><h2>Sources</h2><p class="muted">Folders this app already knows are one click away; anything else by link or by browsing Drive.</p></div></header>
      <div class="ia-folder-row"><select id="ia-known" class="ia-input ia-select" aria-label="Known folders"><option value="">Choose a share or drop-link folder…</option></select><input id="ia-folder-input" class="ia-input" placeholder="…or paste a Drive folder link" aria-label="Drive folder link or id"><button class="mini" id="ia-folder-add" type="button">${icon("plus", "ico-sm")} add</button><button class="mini" id="ia-folder-browse" type="button">${icon("folder-open", "ico-sm")} browse Drive</button></div>
      <div id="ia-recent" class="ia-quick"></div>
      <div class="ia-roots-row"><div id="ia-chips" class="ia-chips"></div><button class="btn" id="ia-scan" type="button" disabled>${icon("search", "ico-sm")} Scan</button></div>
      <div id="ia-tree"></div>
    </section>
    <section class="panel ia-step">
      <header class="ia-step-head"><span class="ia-step-n">2</span><div><h2>Recipe</h2><p class="muted">Presets show what they would do to the scanned photos. Every control updates the impact card instantly.</p></div></header>
      <div class="ia-presets" id="ia-presets"></div>
      <div class="ia-field"><label>Resolution cap</label>${optCards("maxMp", MP_CARDS, cfg.maxMp)}<small class="muted" id="ia-mp-note"></small></div>
      <div class="ia-field"><label>Quality <output id="ia-q-out">${cfg.quality}</output></label><input type="range" id="ia-quality" class="ia-range" min="50" max="95" value="${cfg.quality}" aria-label="Quality"><small class="muted">50 visibly soft · 75–85 sweet spot · 90+ near-lossless, twice the bytes. Ignored per photo when a size target is set.</small></div>
      <div class="ia-two">
        <div class="ia-field"><label>Format</label>${optCards("format", FORMAT_CARDS, cfg.format)}</div>
        <div class="ia-field"><label>Size target per photo</label><div class="ia-inline"><input type="number" id="ia-target" class="ia-input ia-num" min="0" step="0.5" value="0"><span class="muted">MB · 0 = off. Quality is tuned per photo (≤4 passes) until it lands within ±30%.</span></div></div>
      </div>
      <div class="ia-two">
        <div class="ia-field"><label>Metadata</label>${optCards("metadata", META_CARDS, cfg.metadata)}</div>
        <div class="ia-field"><label>File types</label><div class="ia-chipset" id="ia-types"></div></div>
      </div>
      <div class="ia-field"><label>Processing speed <output id="ia-speed-out">${SPEED[cfg.parallel - 1]}</output></label><input type="range" id="ia-parallel" class="ia-range" min="1" max="8" value="${cfg.parallel}" aria-label="Files processed in parallel"><small class="muted">Files encoded at once on the runner (4 cores). Higher is faster until the Drive link saturates; RAW develops are CPU-bound, JPEGs are network-bound.</small></div>
      <details class="ia-adv"><summary>Protections &amp; order</summary>
        <div class="ia-toggles ia-toggles-col">
          ${toggle("onlyIfSmaller", "Only keep a result that is smaller than the original", cfg.onlyIfSmaller)}
          ${toggle("skipSidecar", "Skip RAW files that have an .xmp sidecar", cfg.skipSidecar, "an .xmp next to a RAW means it was edited in Lightroom / darktable; the archive would not carry those edits")}
          ${toggle("largestFirst", "Largest files first", cfg.largestFirst, "biggest savings land early; a paused job has already done the most useful part")}
        </div>
        <div class="ia-two">
          <div class="ia-field"><label>Skip files under</label><div class="ia-inline"><input type="number" id="ia-minmb" class="ia-input ia-num" min="0" step="0.5" value="${cfg.minMb}"><span class="muted">MB</span></div></div>
          <div class="ia-field"><label>Skip files modified in the last</label><div class="ia-inline"><input type="number" id="ia-recent" class="ia-input ia-num" min="0" step="1" value="0"><span class="muted">days · 0 = off. Leaves photos someone may still be working on alone.</span></div></div>
          <div class="ia-field"><label>Exclude names matching</label><input id="ia-exclude" class="ia-input" placeholder="regex, e.g. _edited|\\\\.psd$|^IMG_E"><small class="muted" id="ia-exclude-note"></small></div>
        </div>
      </details>
    </section>
    <section class="panel ia-step">
      <header class="ia-step-head"><span class="ia-step-n">3</span><div><h2>Originals</h2><p class="muted">What happens to each original after its smaller copy is stored and verified.</p></div></header>
      <div class="ia-modes">${MODES.map((m) => `<button type="button" class="ia-mode${m.danger ? " ia-mode-danger" : ""}" data-mode="${m.key}" aria-pressed="${cfg.mode === m.key}"><span class="ia-mode-ico">${icon(m.icon)}</span><b>${esc(m.name)}</b><small>${esc(m.blurb)}</small></button>`).join("")}</div>
      <div class="ia-toggles">${toggle("notify", "Email me a digest when the job finishes", true)}</div>
      <div id="ia-confirm" class="ia-confirm hidden"><label for="ia-confirm-input">Type <code>REPLACE</code> to allow overwriting originals</label><input id="ia-confirm-input" class="ia-input ia-num" autocomplete="off"><small class="muted">Before replacing anything, run the same recipe once in Copy mode on a small folder and check the results in Drive.</small></div>
      <div class="ia-trial">
        <div class="ia-trial-head"><div><b>Try it on one photo</b><small class="muted">Encodes one scanned JPEG/PNG/WebP right here in the browser - nothing is written anywhere.</small></div><div class="section-tools"><button class="mini" id="ia-trial-largest" type="button" disabled>${icon("image", "ico-sm")} largest photo</button><button class="mini" id="ia-trial-random" type="button" disabled>${icon("refresh-cw", "ico-sm")} random photo</button></div></div>
        <div id="ia-trial-out"></div>
      </div>
    </section>
  </div>
  <aside class="ia-side"><div class="panel ia-plan" id="ia-impact"></div></aside>
  </div>
  <section class="panel ia-step">
    <header class="ia-step-head"><span class="ia-step-n">${icon("clock", "ico-sm")}</span><div><h2>Recurring rules</h2><p class="muted">Save the current sources + recipe as a rule. The worker runs due rules nightly at 04:15 IST; new photos in those folders get archived without you touching anything.</p></div></header>
    <div class="ia-rule-form"><input id="ia-rule-name" class="ia-input" placeholder="Rule name, e.g. Nightly: Pushkar drop-link" aria-label="Rule name"><div class="seg-control ia-seg" data-every><button type="button" data-value="daily" aria-pressed="true">daily</button><button type="button" data-value="weekly" aria-pressed="false">weekly</button><button type="button" data-value="monthly" aria-pressed="false">monthly</button></div><button class="mini" id="ia-rule-save" type="button" disabled>${icon("save", "ico-sm")} Save as rule</button></div>
    <div id="ia-rules"></div>
  </section>
  <section class="panel"><div class="section-title"><div><p class="eyebrow">jobs</p><h2>${icon("zap")} Progress &amp; history</h2></div><div class="section-tools"><button class="mini" id="ia-refresh" type="button">${icon("refresh-cw", "ico-sm")} Refresh</button></div></div><div id="ia-jobs"></div></section>`;
}

function options() {
  return { folderIds: [...roots.keys()], excludeFolderIds: [...excluded], recursive: cfg.recursive, maxMp: cfg.maxMp, quality: cfg.quality, format: cfg.format, metadata: cfg.metadata, minBytes: Math.round(cfg.minMb * 1024 * 1024), targetBytes: Math.round(cfg.targetMb * 1024 * 1024), exclude: cfg.excludeRe, types: [...cfg.types], onlyIfSmaller: cfg.onlyIfSmaller, mode: cfg.mode, skipRecentDays: cfg.skipRecentDays, skipSidecar: cfg.skipSidecar, largestFirst: cfg.largestFirst, parallel: cfg.parallel };
}
const cfgFrom = (p) => ({ maxMp: p.maxMp, quality: p.quality, format: p.format, metadata: p.metadata, targetMb: p.targetMb });

// ---- render: everything that depends on cfg / scan ----
function sync() {
  $("ia-q-out").textContent = String(cfg.quality);
  $("ia-speed-out").textContent = SPEED[cfg.parallel - 1];
  for (const s of document.querySelectorAll("[data-seg]")) for (const b of s.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.value === String(cfg[s.dataset.seg])));
  for (const b of document.querySelectorAll("[data-mode]")) b.setAttribute("aria-pressed", String(b.dataset.mode === cfg.mode));
  $("ia-confirm").classList.toggle("hidden", cfg.mode !== "replace");
  $("ia-mp-note").textContent = cfg.maxMp ? `≈ ${Math.round(Math.sqrt(cfg.maxMp * 1e6 * 1.5))}×${Math.round(Math.sqrt(cfg.maxMp * 1e6 / 1.5))} for a 3:2 photo` : "keeps the original pixel count";
  $("ia-exclude-note").textContent = cfg.exclude && !cfg.excludeRe ? "invalid regex - ignored" : "";
  $("ia-scan").disabled = !roots.size;
  $("ia-rule-save").disabled = !roots.size;
  for (const b of document.querySelectorAll("[data-every] button")) b.setAttribute("aria-pressed", String(b.dataset.value === every));
  const sum = scan ? summarize(scan, cfg, excluded) : null;
  $("ia-types").innerHTML = Object.entries(TYPE_LABELS).map(([k, l]) => `<button type="button" class="ia-chip" data-type="${k}" aria-pressed="${cfg.types.has(k)}">${esc(l)}${sum?.byType[k] ? ` <b>${sum.byType[k].count}</b>` : ""}</button>`).join("");
  $("ia-presets").innerHTML = PRESETS.map((p) => {
    const on = ["maxMp", "quality", "format", "metadata", "targetMb"].every((k) => p[k] === cfg[k]);
    const est = scan ? summarize(scan, { ...cfg, ...cfgFrom(p) }, excluded) : null;
    return `<button type="button" class="ia-preset" data-preset="${p.key}" aria-pressed="${on}"><span class="ia-preset-ico">${icon(p.icon)}</span><b>${esc(p.name)}</b><small>${esc(p.blurb)}</small>${est ? `<em>${est.files} files → ~${fmtBytes(est.est)}</em>` : ""}</button>`;
  }).join("");
  renderTree(sum);
  renderImpact(sum);
  const trials = scan ? trialCandidates(scan, cfg, excluded) : [];
  $("ia-trial-largest").disabled = $("ia-trial-random").disabled = !trials.length;
}

function renderTree(sum) {
  const box = $("ia-tree");
  if (!scan) return (box.innerHTML = "");
  const rows = scan.folders.map((f, i) => {
    const p = sum.perFolder[i];
    const on = !excluded.has(f.id);
    const types = Object.entries(p.types).sort((a, b) => b[1] - a[1]).map(([t, n]) => `<span class="ia-tag">${esc(TYPE_LABELS[t] || t)} ${n}</span>`).join("");
    return `<tr class="${on ? "" : "ia-off"}"><td><label class="ia-check"><input type="checkbox" data-folder-toggle="${escAttr(f.id)}" ${on ? "checked" : ""} aria-label="include ${escAttr(f.name)}"></label></td>
      <td><span class="ia-indent" style="--d:${f.depth}">${icon(f.depth ? "folder" : "folder-open", "ico-sm")} ${esc(f.name)}</span></td>
      <td class="num">${p.images}</td><td class="num">${fmtBytes(p.bytes)}</td><td>${types}</td>
      <td class="num">${p.done ? `<span class="muted">${p.done} done</span>` : ""}</td>
      <td class="num"><b>${p.picked}</b> <span class="muted">→ ~${fmtBytes(p.est)}</span></td></tr>`;
  });
  box.innerHTML = `<div class="ia-tree-head"><span>${scan.rows.length.toLocaleString()} images in ${scan.folders.length} folders · ${fmtBytes(sum.scannedBytes)}${scan.capped ? " · capped at 5000 files" : ""}</span><span class="muted">untick a folder to leave it out</span></div>
    <div class="upload-table-wrap"><table class="uploads ia-tree-table"><thead><tr><th></th><th>Folder</th><th class="num">Images</th><th class="num">Size</th><th>Types</th><th class="num">Already</th><th class="num">Will process</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function renderImpact(sum) {
  const box = $("ia-impact");
  const busy = state?.active && ["running", "pausing"].includes(state.active.status);
  const startLabel = busy ? "Queue after running job" : "Start";
  if (!sum) {
    box.innerHTML = `<p class="eyebrow">impact</p><div class="ia-empty">${icon("search")}<p>Pick sources and scan. The scan reads Drive metadata only; this card then answers instantly for any recipe.</p></div><button class="btn ia-start" id="ia-start" type="button" disabled>${icon("play", "ico-sm")} ${startLabel}</button>`;
    return;
  }
  const saving = Math.max(0, sum.bytes - sum.est);
  const skipped = Object.entries(sum.skipped).sort((a, b) => b[1] - a[1]);
  const modeNote = { copy: "Originals stay where they are.", archive: `${sum.files} originals move to _archive/.`, replace: `${sum.files} originals are overwritten (old revision kept ~30 days).` }[cfg.mode];
  box.innerHTML = `<p class="eyebrow">impact</p>
    <div class="ia-digest-hero"><b>${sum.files.toLocaleString()}</b><span>files to process<br><small class="muted">of ${sum.scanned.toLocaleString()} scanned</small></span></div>
    <div class="ia-bar" aria-label="size before and after"><i style="width:${pct(sum.est, sum.bytes)}%"></i></div>
    <div class="ia-bar-legend"><span>${fmtBytes(sum.bytes)} now</span><span>→ ~${fmtBytes(sum.est)}</span></div>
    <ul class="ia-facts">
      <li>${icon("circle-check", "ico-sm")} saves ~${fmtBytes(saving)} <span class="muted">(${pct(saving, sum.bytes)}%)</span></li>
      <li>${icon("timer", "ico-sm")} about ${fmtEta(sum.eta / cfg.parallel)} <span class="muted">at ${cfg.parallel} in parallel</span></li>
      <li>${icon(cfg.mode === "replace" ? "triangle-alert" : "shield", "ico-sm")} ${esc(modeNote)}</li>
    </ul>
    <div class="ia-mini"><p class="eyebrow">by type</p><ul class="img-kv">${Object.entries(sum.byType).map(([t, b]) => `<li><span>${esc(TYPE_LABELS[t] || t)} <small class="muted">${b.picked}/${b.count}</small></span><b>${fmtBytes(b.bytes)} → ~${fmtBytes(b.est)}</b></li>`).join("")}</ul></div>
    ${skipped.length ? `<div class="ia-mini"><p class="eyebrow">left alone</p><ul class="img-kv">${skipped.map(([why, n]) => `<li><span>${esc(why)}</span><b>${n}</b></li>`).join("")}</ul></div>` : ""}
    <div class="ia-mini"><p class="eyebrow">largest</p><ul class="img-kv">${sum.largest.map((r) => `<li><span title="${escAttr(r.n)}">${esc(r.n)}</span><b>${fmtBytes(r.s)}</b></li>`).join("") || "<li class='muted'>—</li>"}</ul></div>
    <button class="btn ia-start" id="ia-start" type="button" ${sum.files ? "" : "disabled"}>${icon("play", "ico-sm")} ${startLabel}</button>
    ${!state?.dispatchConfigured ? `<small class="muted">${icon("info", "ico-sm")} No GITHUB_TOKEN on the worker: start only records the job; run the script locally.</small>` : ""}`;
}

// ---- sources ----
async function loadSources() {
  renderRecent();
  try {
    known = await fetch("/api/admin/images/sources").then((r) => r.json());
    const opt = (id, name, label) => `<option value="${escAttr(id)}" data-name="${escAttr(name)}">${esc(name)}${label && label !== name ? ` — ${esc(label)}` : ""}</option>`;
    const shares = (known.shares || []).flatMap((s) => s.folders.map((f) => opt(f.id, f.name, s.label)));
    const links = (known.links || []).map((l) => opt(l.folder.id, l.folder.name, l.label));
    $("ia-known").innerHTML = `<option value="">Choose a share or drop-link folder…</option>${shares.length ? `<optgroup label="Share folders">${shares.join("")}</optgroup>` : ""}${links.length ? `<optgroup label="Drop-link folders">${links.join("")}</optgroup>` : ""}`;
  } catch {}
  initRules({ roots, cfg, options, excluded, known: () => known, getEvery: () => every, setEvery: (v) => (every = v), renderRoots, refresh: refreshImages });
  loadRules();
}
function renderRecent() {
  const recent = recentFolders();
  $("ia-recent").innerHTML = recent.length ? `<span class="muted ia-recent-label">recent</span>${recent.map((f) => `<button type="button" class="ia-quick-chip" data-pick-folder="${escAttr(f.id)}" data-name="${escAttr(f.name)}">${icon("folder", "ico-sm")} ${esc(f.name)}</button>`).join("")}` : "";
}
function addRoot(id, name) {
  roots.set(id, name);
  rememberRecent(id, name);
  renderRecent();
  renderRoots();
}

function renderRoots() {
  $("ia-chips").innerHTML = roots.size ? [...roots].map(([id, name]) => `<span class="chip ia-folder-chip">${icon("folder", "chip-icon")}${esc(name)}<button type="button" class="ia-chip-x" data-remove-folder="${escAttr(id)}" aria-label="remove ${escAttr(name)}">${icon("x", "ico-sm")}</button></span>`).join("") : `<span class="muted">No folders picked yet.</span>`;
  scan = null;
  excluded.clear();
  sync();
}
async function addFolderFromInput() {
  const raw = $("ia-folder-input").value.trim();
  const id = raw.match(/folders\/([A-Za-z0-9_-]{10,})/)?.[1] || raw.match(/^[A-Za-z0-9_-]{10,}$/)?.[0];
  if (!id) return flash($("ia-folder-add"), "not a Drive folder link");
  const r = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(id)}`).catch(() => null);
  const d = r ? await r.json().catch(() => ({})) : { error: "can't reach the server" };
  if (!r?.ok) return flash($("ia-folder-add"), d.error || "folder not found");
  $("ia-folder-input").value = "";
  addRoot(id, d.breadcrumbs?.at(-1)?.name || id);
}
async function doScan(button) {
  button.disabled = true;
  $("ia-tree").innerHTML = `<div class="ia-skel-rows">${Array.from({ length: 4 }, (_, i) => `<div class="ia-skel-row" style="--i:${i}"></div>`).join("")}</div>`;
  try {
    const r = await post("/api/admin/images/scan", { folderIds: [...roots.keys()], recursive: true });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `scan ${r.status}`);
    scan = { ...d, doneSet: new Set(d.doneBefore) };
    // Keep exclusions that still name a scanned folder (a loaded rule's, or a re-scan's).
    const scanned = new Set(d.folders.map((f) => f.id));
    for (const id of [...excluded]) if (!scanned.has(id)) excluded.delete(id);
  } catch (error) {
    $("ia-tree").innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  } finally {
    button.disabled = false;
    sync();
  }
}

// ---- trial ----
async function runTrial(pickRandom) {
  const box = $("ia-trial-out");
  const cands = trialCandidates(scan, cfg, excluded);
  const row = pickRandom ? cands[Math.floor(Math.random() * cands.length)] : cands[0];
  if (!row) return;
  box.innerHTML = `<p class="muted">${icon("loader-circle", "ico-sm")} <span id="ia-trial-stage">downloading</span> ${esc(row.n)} (${fmtBytes(row.s)})…</p>`;
  try {
    trial?.urls?.forEach((u) => URL.revokeObjectURL(u));
    const t = await trialEncode(row, cfg, (stage) => ($("ia-trial-stage").textContent = stage));
    const urls = [URL.createObjectURL(t.before.blob), URL.createObjectURL(t.after.blob)];
    trial = { urls };
    box.innerHTML = `<div class="ia-compare" id="ia-compare" style="--split:50%"><img src="${urls[0]}" alt="original"><img src="${urls[1]}" alt="re-encoded" class="ia-compare-after"><input type="range" min="0" max="100" value="50" aria-label="compare slider"><span class="ia-compare-tag ia-compare-tag-l">original · ${fmtBytes(row.s)} · ${t.before.w}×${t.before.h} (resampled, not recompressed)</span><span class="ia-compare-tag ia-compare-tag-r">after · ~${fmtBytes(t.after.blob.size)} · ${t.after.w}×${t.after.h}</span></div>
      <div class="ia-trial-foot"><span><b>${pct(row.s - t.after.blob.size, row.s)}% smaller</b> at this recipe</span><label class="ia-toggle"><input type="checkbox" id="ia-compare-zoom"><span class="ia-switch" aria-hidden="true"></span><span>1:1 pixels</span></label><small class="muted">${esc(t.note)}</small></div>`;
  } catch (error) {
    box.innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  }
}

// ---- jobs ----
function renderJobs() {
  const cards = state.jobs.map((j) => {
    const total = j.fileCount || 0;
    const p = j.progress;
    const done = p.done + p.failed + p.skipped;
    const elapsed = j.startedAt ? ((j.finishedAt || Date.now()) - j.startedAt) / 1000 : 0;
    const rate = elapsed > 30 && done ? done / (elapsed / 60) : 0;
    const eta = rate && j.status === "running" ? fmtEta(((total - done) / rate) * 60) : "";
    const ctl = [];
    if (j.status === "running") ctl.push(`<button class="mini" data-job-action="pause" data-job="${j.id}" type="button">${icon("pause", "ico-sm")} pause</button>`);
    if (["paused", "pausing"].includes(j.status)) ctl.push(`<button class="mini" data-job-action="resume" data-job="${j.id}" type="button">${icon("play", "ico-sm")} resume</button>`);
    if (["running", "pausing", "paused", "planned", "queued"].includes(j.status)) ctl.push(`<button class="mini danger" data-job-action="cancel" data-job="${j.id}" type="button">cancel</button>`);
    if (["done", "paused", "cancelled"].includes(j.status) && j.options.mode !== "replace" && p.done) ctl.push(`<button class="mini danger" data-job-undo="${j.id}" type="button">${icon("rotate-ccw", "ico-sm")} undo</button>`);
    if (["done", "paused", "cancelled"].includes(j.status) && j.options.mode !== "replace" && p.done) ctl.push(`<button class="mini" data-job-convert="${j.options.mode === "copy" ? "archive" : "copy"}" data-job="${j.id}" type="button">${icon("rotate-cw", "ico-sm")} switch to ${j.options.mode === "copy" ? "archive" : "copy"}</button>`);
    for (const id of (j.outputs || []).slice(0, 3)) ctl.push(`<a class="mini" href="https://drive.google.com/drive/folders/${escAttr(id)}" target="_blank" rel="noopener">${icon("external-link", "ico-sm")} output folder</a>`);
    for (const rid of (j.runIds || []).slice(-2)) ctl.push(`<a class="mini" href="https://github.com/DhakadG/husky-drop/actions/runs/${escAttr(rid)}" target="_blank" rel="noopener">${icon("terminal", "ico-sm")} runner log</a>`);
    ctl.push(`<button class="mini" data-job-items="${j.id}" type="button">${icon("list", "ico-sm")} files</button>`);
    const note = { running: eta ? `${rate.toFixed(1)} files/min · ~${eta} left` : "starting…", pausing: "stops after the current files", paused: "resume to continue where it left off", queued: "starts when the running job finishes", planned: "waiting for start", done: `finished ${j.finishedAt ? new Date(j.finishedAt).toLocaleString() : ""}`, cancelled: "cancelled - files already written stay", undone: "undone - outputs removed" }[j.status] || "";
    return `<article class="ia-job" data-status="${j.status}">
      <div class="ia-job-head"><div><b>${(j.roots || []).map((r) => esc(r.name)).join(", ") || esc(j.id)}${j.rule ? ` <span class="ia-tag">rule</span>` : ""}${j.converting ? ` <span class="ia-tag">converting → ${esc(j.converting)}</span>` : ""}</b><small class="muted">${esc(j.id)} · ${j.options.mode} · ${j.options.maxMp ? `${j.options.maxMp} MP` : "full res"} · ${j.options.targetBytes ? `~${fmtBytes(j.options.targetBytes)} target` : `q${j.options.quality}`} · ${j.options.format}${j.options.parallel ? ` · ×${j.options.parallel}` : ""}</small></div><span class="chip ia-status" data-status="${j.status}">${esc(j.status)}</span></div>
      <div class="ia-bar ia-bar-progress"><i style="width:${pct(done, total)}%"></i></div>
      <div class="ia-job-stats"><span><b>${done}</b>/${total} files</span><span><b>${fmtBytes(p.bytesIn)}</b> → <b>${fmtBytes(p.bytesOut)}</b>${p.bytesIn ? ` <em>−${pct(p.bytesIn - p.bytesOut, p.bytesIn)}%</em>` : ""}</span>${p.failed ? `<span class="img-bad">${p.failed} failed</span>` : ""}${p.skipped ? `<span class="muted">${p.skipped} skipped</span>` : ""}<span class="muted">${esc(note)}</span></div>
      <div class="ia-job-ctl">${ctl.join("")}</div>
      <div class="ia-job-items" id="ia-items-${escAttr(j.id)}"></div>
    </article>`;
  });
  $("ia-jobs").innerHTML = cards.join("") || `<p class="muted">No jobs yet.</p>`;
}
async function showItems(id, filter = "all") {
  const box = $(`ia-items-${id}`);
  if (box.innerHTML && !filter) return (box.innerHTML = "");
  const d = await fetch(`/api/admin/images/jobs/${encodeURIComponent(id)}/items`).then((r) => r.json());
  const items = d.items.filter((i) => (filter === "failed" ? !i.ok || i.undoError : true));
  box.innerHTML = `<div class="ia-items-head"><span class="muted">${items.length} shown</span><span class="section-tools"><button class="mini" data-items-filter="all" data-job="${id}" type="button">all</button><button class="mini" data-items-filter="failed" data-job="${id}" type="button">failed only</button><button class="mini" data-items-close="${id}" type="button">close</button></span></div>
    <ul class="ia-items">${items.map((i) => `<li>${i.ok ? icon("check", "ico-sm") : icon(i.soft ? "info" : "circle-x", "ico-sm")} <span class="ia-item-name" title="${escAttr(i.path)}/${escAttr(i.name)}">${esc(i.name)}</span>${i.via && i.via !== "direct" ? `<span class="ia-tag">${esc(i.via)}</span>` : ""}${i.q ? `<span class="ia-tag">q${i.q}</span>` : ""}<span class="muted">${i.ok ? `${fmtBytes(i.sizeIn)} → ${fmtBytes(i.size)} · ${fmtTime(i.ms / 1000)}` : esc(i.error)}${i.undone ? " · undone" : ""}${i.undoError ? ` · could not undo: ${esc(i.undoError)}` : ""}</span></li>`).join("") || "<li class='muted'>nothing here</li>"}</ul>`;
}
async function jobAction(button, id, action) {
  if (action === "cancel" && !confirm("Cancel this job? Files already written stay as they are.")) return;
  button.disabled = true;
  const r = await post(`/api/admin/images/jobs/${encodeURIComponent(id)}/${action}`, {});
  const d = await r.json().catch(() => ({}));
  flash(button, r.ok ? (d.dispatched === false ? d.reason : `${action} ok`) : d.error || `${action} failed`);
  if (!r.ok) button.disabled = false;
  setTimeout(refreshImages, 1500);
}
async function startJob(button) {
  if (!scan) return;
  if (cfg.mode === "replace" && $("ia-confirm-input").value.trim() !== "REPLACE") return flash(button, "type REPLACE first");
  button.disabled = true;
  try {
    const r = await post("/api/admin/images/plan", options());
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `plan ${r.status}`);
    const s = await post(`/api/admin/images/jobs/${d.job.id}/start`, { confirm: $("ia-confirm-input").value.trim(), notify: cfg.notify });
    const sd = await s.json();
    if (!s.ok) throw new Error(sd.error || `start ${s.status}`);
    flash(button, sd.job.status === "queued" ? "queued" : sd.dispatched ? "started" : sd.reason || "recorded");
    setTimeout(refreshImages, 1500);
  } catch (error) {
    flash(button, error.message);
    button.disabled = false;
  }
}
async function convertJob(button, id, to) {
  if (!confirm(to === "archive" ? "Move originals to _archive/ and put the copies in their place?" : "Move originals back and put the copies in _compressed/?")) return;
  button.disabled = true;
  for (let i = 0; i < 200; i++) {
    const r = await post(`/api/admin/images/jobs/${encodeURIComponent(id)}/convert`, { to });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return flash(button, d.error || "convert failed");
    flash(button, `${d.remaining} left…`);
    if (!d.remaining) break;
  }
  flash(button, `now ${to}`);
  setTimeout(refreshImages, 1000);
}
async function undoJob(button, id) {
  if (!confirm("Undo this job? Copies go to Drive's trash; archived originals move back.")) return;
  button.disabled = true;
  let failed = 0;
  for (let i = 0; i < 100; i++) {
    const r = await post(`/api/admin/images/jobs/${encodeURIComponent(id)}/undo`);
    const d = await r.json().catch(() => ({}));
    if (!r.ok) return flash(button, d.error || "undo failed");
    flash(button, `${d.remaining} left…`);
    failed = d.failed || 0;
    if (!d.remaining) break;
  }
  flash(button, failed ? `undone, ${failed} could not be restored` : "undone");
  setTimeout(refreshImages, 1000);
}

function wire() {
  const host = $("images-body");
  const num = (id, key) => $(id).addEventListener("change", (e) => ((cfg[key] = Math.max(0, Number(e.target.value) || 0)), sync()));
  $("ia-quality").addEventListener("input", (e) => ((cfg.quality = Number(e.target.value)), sync()));
  $("ia-parallel").addEventListener("input", (e) => ((cfg.parallel = Number(e.target.value)), sync()));
  num("ia-minmb", "minMb");
  num("ia-target", "targetMb");
  num("ia-recent", "skipRecentDays");
  $("ia-exclude").addEventListener("input", (e) => {
    cfg.exclude = e.target.value.trim();
    try {
      cfg.excludeRe = cfg.exclude && new RegExp(cfg.exclude, "i") ? cfg.exclude : "";
    } catch {
      cfg.excludeRe = "";
    }
    sync();
  });
  $("ia-folder-add").addEventListener("click", addFolderFromInput);
  $("ia-folder-input").addEventListener("keydown", (e) => e.key === "Enter" && addFolderFromInput());
  $("ia-known").addEventListener("change", (e) => {
    const o = e.target.selectedOptions[0];
    if (o?.value) addRoot(o.value, o.dataset.name);
    e.target.value = "";
  });
  setImagePickHandler(Object.assign((id, name) => addRoot(id, name), { has: (id) => roots.has(id) }));
  $("ia-folder-browse").addEventListener("click", () => openFolderPicker("root", "images"));
  $("ia-rule-save").addEventListener("click", (e) => saveRule(e.currentTarget));
  $("ia-scan").addEventListener("click", (e) => doScan(e.currentTarget));
  $("ia-refresh").addEventListener("click", () => refreshImages());
  $("ia-trial-largest").addEventListener("click", () => runTrial(false));
  $("ia-trial-random").addEventListener("click", () => runTrial(true));
  host.addEventListener("input", (e) => {
    if (e.target.closest("#ia-compare input")) $("ia-compare").style.setProperty("--split", `${e.target.value}%`);
  });
  host.addEventListener("change", (e) => {
    const t = e.target.closest("[data-toggle]");
    if (t) {
      cfg[t.dataset.toggle] = t.checked;
      return sync();
    }
    const f = e.target.closest("[data-folder-toggle]");
    if (f) {
      f.checked ? excluded.delete(f.dataset.folderToggle) : excluded.add(f.dataset.folderToggle);
      return sync();
    }
    if (e.target.id === "ia-compare-zoom") $("ia-compare").classList.toggle("ia-compare-1x", e.target.checked);
  });
  host.addEventListener("click", (e) => {
    const t = e.target.closest("button");
    if (!t) return;
    const s = t.closest("[data-seg]");
    if (s) {
      cfg[s.dataset.seg] = s.dataset.seg === "maxMp" ? Number(t.dataset.value) : t.dataset.value;
      return sync();
    }
    if (t.dataset.preset) {
      Object.assign(cfg, cfgFrom(PRESETS.find((p) => p.key === t.dataset.preset)));
      $("ia-quality").value = String(cfg.quality);
      $("ia-target").value = String(cfg.targetMb);
      return sync();
    }
    if (t.dataset.mode) return ((cfg.mode = t.dataset.mode), sync());
    if (t.dataset.type) return (cfg.types.has(t.dataset.type) ? cfg.types.delete(t.dataset.type) : cfg.types.add(t.dataset.type), sync());
    const ev = t.closest("[data-every]");
    if (ev) return ((every = t.dataset.value), sync());
    if (t.id === "ia-start") return startJob(t);
    if (t.dataset.pickFolder) return addRoot(t.dataset.pickFolder, t.dataset.name);
    if (t.dataset.ruleRun) return ruleAction(t, t.dataset.ruleRun, "run");
    if (t.dataset.ruleToggle) return ruleAction(t, t.dataset.ruleToggle, "toggle");
    if (t.dataset.ruleLoad) return ruleAction(t, t.dataset.ruleLoad, "load");
    if (t.dataset.ruleDelete) return ruleAction(t, t.dataset.ruleDelete, "delete");
    if (t.dataset.jobConvert) return convertJob(t, t.dataset.job, t.dataset.jobConvert);
    if (t.dataset.removeFolder) return (roots.delete(t.dataset.removeFolder), renderRoots());
    if (t.dataset.jobAction) return jobAction(t, t.dataset.job, t.dataset.jobAction);
    if (t.dataset.jobUndo) return undoJob(t, t.dataset.jobUndo);
    if (t.dataset.jobItems) return showItems(t.dataset.jobItems, "");
    if (t.dataset.itemsFilter) return showItems(t.dataset.job, t.dataset.itemsFilter);
    if (t.dataset.itemsClose) return ($(`ia-items-${t.dataset.itemsClose}`).innerHTML = "");
  });
  renderRoots();
}
