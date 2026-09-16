import { $, icon } from "./admin-state.js";
import { flash } from "./admin.js";

// Recurring image-archive rules panel (part of the Image archive tab).
// initRules() receives the tab's live state so a rule can be saved from the
// current recipe and loaded back into it.

let deps = null;
let rules = [];
const post = (path, body) => fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });

export function initRules(d) {
  deps = d;
}

export async function loadRules() {
  try {
    rules = (await fetch("/api/admin/images/rules").then((r) => r.json())).rules || [];
  } catch {
    rules = [];
  }
  renderRules();
}

function renderRules() {
  $("ia-rules").innerHTML = rules.length
    ? rules.map((r) => `<div class="ia-rule" data-enabled="${r.enabled}"><div><b>${esc(r.name)}</b><small class="muted">${esc(r.every)} · ${r.options.mode} · ${r.options.maxMp ? `${r.options.maxMp} MP` : "full res"} · ${r.options.folderIds.length} folder(s)${r.lastRunAt ? ` · last run ${new Date(r.lastRunAt).toLocaleString()}: ${esc(r.lastResult || "")}` : " · never run"}</small></div><span class="section-tools"><button class="mini" data-rule-run="${escAttr(r.id)}" type="button">${icon("play", "ico-sm")} run now</button><button class="mini" data-rule-toggle="${escAttr(r.id)}" type="button">${r.enabled ? "pause" : "enable"}</button><button class="mini" data-rule-load="${escAttr(r.id)}" type="button">load recipe</button><button class="mini danger" data-rule-delete="${escAttr(r.id)}" type="button">delete</button></span></div>`).join("")
    : `<p class="muted">No rules yet.</p>`;
}

export async function saveRule(button) {
  const { roots, cfg, options, getEvery } = deps;
  const name = $("ia-rule-name").value.trim() || `${[...roots.values()].join(", ")} · ${getEvery()}`;
  button.disabled = true;
  const r = await post("/api/admin/images/rules", { name, every: getEvery(), options: options(), notify: cfg.notify, confirm: cfg.mode === "replace" ? $("ia-confirm-input").value.trim() : "" });
  const d = await r.json().catch(() => ({}));
  flash(button, r.ok ? "saved" : d.error || "save failed");
  button.disabled = false;
  loadRules();
}

export async function ruleAction(button, id, action) {
  const rule = rules.find((r) => r.id === id);
  if (!rule) return;
  const { roots, cfg, known, setEvery, renderRoots, refresh } = deps;
  button.disabled = true;
  let r;
  if (action === "run") r = await post(`/api/admin/images/rules/${encodeURIComponent(id)}/run`);
  else if (action === "toggle") r = await post("/api/admin/images/rules", { ...rule, enabled: !rule.enabled, confirm: "REPLACE" });
  else if (action === "delete") {
    if (!confirm(`Delete rule "${rule.name}"?`)) return (button.disabled = false);
    r = await fetch(`/api/admin/images/rules/${encodeURIComponent(id)}`, { method: "DELETE" });
  } else if (action === "load") {
    const o = rule.options;
    const k = known();
    const all = (k.shares || []).flatMap((s) => s.folders).concat((k.links || []).map((l) => l.folder));
    roots.clear();
    for (const fid of o.folderIds) roots.set(fid, all.find((f) => f.id === fid)?.name || fid);
    Object.assign(cfg, { maxMp: o.maxMp, quality: o.quality, format: o.format, metadata: o.metadata, mode: o.mode, onlyIfSmaller: o.onlyIfSmaller, minMb: o.minBytes / 1024 / 1024, targetMb: o.targetBytes / 1024 / 1024, skipRecentDays: o.skipRecentDays, skipSidecar: o.skipSidecar, largestFirst: o.largestFirst, parallel: o.parallel || 4, types: new Set(o.types) });
    setEvery(rule.every);
    $("ia-rule-name").value = rule.name;
    renderRoots();
    button.disabled = false;
    return flash(button, "loaded - scan to see it");
  }
  const d = await r.json().catch(() => ({}));
  flash(button, r.ok ? (d.jobId ? `job ${d.jobId} ${d.status}` : d.reason || "ok") : d.error || "failed");
  button.disabled = false;
  loadRules();
  if (action === "run") setTimeout(refresh, 1500);
}
