import { $, icon } from "./admin-state.js";
import { showTab } from "./admin.js";
import { openPerson, peopleState, mergePerson, setBan } from "./admin-people-profile.js";

// People tab: one profile per visitor. Identity = Google account when the
// device/fingerprint ever signed in, else the device, else the typed name,
// else a single visit. Visits without sign-in fold under one section.

let wired = false;
export const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
};
export const displayName = (p) => p.emails[0] || p.names[0] || (p.key.startsWith("device:") || p.key.startsWith("fp:") ? `Device ${p.key.split(":")[1].slice(0, 6)}` : p.key.startsWith("session:") ? `Visit ${p.key.slice(8, 14)}` : p.key.replace(/^name:/, ""));
export const initials = (name) => name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
export const skeleton = (n) => `<div class="skel-list">${Array.from({ length: n }, (_, i) => `<div class="skel-card" style="--i:${i}"><span class="skel-avatar"></span><span class="skel-lines"><i style="width:40%"></i><i style="width:65%"></i></span></div>`).join("")}</div>`;
const kindLabel = (p) => (p.emails.length ? [icon("google-g", "ico-sm"), "Google"] : p.key.startsWith("device:") || p.key.startsWith("fp:") ? [icon("smartphone", "ico-sm"), "device, no sign-in"] : p.key.startsWith("session:") ? [icon("eye", "ico-sm"), "one visit"] : [icon("user-round", "ico-sm"), "typed name"]);

export async function refreshPeople({ force = false } = {}) {
  const host = $("people-body");
  if (!host) return;
  if (!wired) {
    wired = true;
    $("people-search").addEventListener("input", renderList);
    $("people-sort").addEventListener("change", renderList);
    $("people-refresh").addEventListener("click", () => refreshPeople({ force: true }));
    host.addEventListener("click", (e) => {
      const card = e.target.closest("[data-person]");
      if (card) return openPerson(card.dataset.person);
      if (e.target.closest("#people-back")) return renderList();
      const unlink = e.target.closest("[data-unlink]");
      if (unlink) return mergePerson(unlink.dataset.unlink, "");
      if (e.target.closest("#people-merge-go")) return mergePerson($("people-merge-go").dataset.key, $("people-merge-into").value);
      const sug = e.target.closest("[data-suggest]");
      if (sug) return decideSuggestion(sug.dataset.suggest, sug.dataset.email, sug.dataset.accept === "1");
      if (e.target.closest("#people-stitch")) return runStitch();
      const ban = e.target.closest("[data-ban-kind]");
      if (ban) return setBan(ban.dataset.banKind, ban.dataset.banValue, ban.dataset.banOn === "1");
    });
  }
  if (peopleState.loaded && !force) return renderList();
  host.innerHTML = skeleton(4);
  try {
    const [pr, br, sr] = await Promise.all([fetch("/api/admin/people?days=90"), fetch("/api/admin/bans"), fetch("/api/admin/people/suggestions")]);
    const d = await pr.json();
    if (!pr.ok) throw new Error(d.error || `people ${pr.status}`);
    peopleState.people = d.people || [];
    peopleState.bans = (await br.json().catch(() => ({}))).bans || [];
    peopleState.suggestions = (await sr.json().catch(() => ({}))).suggestions || [];
    peopleState.loaded = true;
    renderList();
  } catch (error) {
    host.innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  }
}

export function openPersonByKey(key) {
  showTab("people");
  refreshPeople().then(() => openPerson(key));
}

export function renderList() {
  const host = $("people-body");
  const { people, bans } = peopleState;
  const q = $("people-search").value.trim().toLowerCase();
  const sort = $("people-sort").value;
  let rows = people.filter((p) => !q || [displayName(p), ...p.emails, ...p.names, ...p.places, ...p.links.map((l) => l.label), ...p.shares.map((s) => s.label)].some((v) => String(v).toLowerCase().includes(q)));
  rows = rows.sort((a, b) => (sort === "uploads" ? b.bytes - a.bytes : sort === "views" ? b.views + b.shareOpens - (a.views + a.shareOpens) : sort === "errors" ? b.errors - a.errors : b.last - a.last));
  const unknown = rows.filter((p) => p.key.startsWith("session:"));
  rows = rows.filter((p) => !p.key.startsWith("session:"));
  const identified = people.filter((p) => p.emails.length).length;
  host.innerHTML = `<div class="people-summary"><span><b>${rows.length}</b> people</span><span><b>${identified}</b> Google accounts</span><span><b>${fmtBytes(people.reduce((n, p) => n + p.bytes, 0))}</b> uploaded</span><span><b>${unknown.length}</b> unsigned visits</span>${bans.length ? `<span class="img-bad"><b>${bans.length}</b> blocked</span>` : ""}</div>
    ${suggestionsBox()}
    <div class="people-grid">${rows.map((p, i) => card(p, i)).join("") || `<p class="muted">Nobody matches.</p>`}</div>
    ${unknown.length ? `<details class="people-unknown"><summary>${icon("eye", "ico-sm")} ${unknown.length} visits without sign-in · ${unknown.reduce((n, p) => n + p.events, 0)} events</summary><div class="people-grid">${unknown.map((p, i) => card(p, i)).join("")}</div></details>` : ""}
    ${bans.length ? `<details class="people-unknown"><summary>${icon("shield-alert", "ico-sm")} ${bans.length} blocked</summary><ul class="person-links">${bans.map((b) => `<li><span><code>${esc(b.kind)}</code> ${esc(b.value)}${b.reason ? ` <span class="muted">· ${esc(b.reason)}</span>` : ""}</span><button type="button" class="link-like" data-ban-kind="${escAttr(b.kind)}" data-ban-value="${escAttr(b.value)}" data-ban-on="0">unblock</button></li>`).join("")}</ul></details>` : ""}`;
}

// Nightly Claude pass proposes which unsigned visits belong to which account.
const suggestionsBox = () => {
  const list = peopleState.suggestions || [];
  const byKey = new Map(peopleState.people.map((p) => [p.key, p]));
  return `<div class="people-suggest"><div class="section-title"><h2>${icon("wand-sparkles", "ico-sm")} Suggested merges</h2><button type="button" class="mini" id="people-stitch">${icon("refresh-cw", "ico-sm")} run now</button></div>
    ${list.length ? `<ul class="person-links">${list.map((s) => `<li><span><b>${esc(byKey.has(s.key) ? displayName(byKey.get(s.key)) : s.key)}</b> → ${esc(s.email)} <span class="kind-tag" data-kind="${s.confidence >= 0.8 ? "drop" : "admin"}">${Math.round(s.confidence * 100)}%</span><small class="muted"> ${esc(s.reason)}</small></span><span class="device-actions"><button type="button" class="mini" data-suggest="${escAttr(s.key)}" data-email="${escAttr(s.email)}" data-accept="1">merge</button><button type="button" class="link-like" data-suggest="${escAttr(s.key)}" data-email="" data-accept="0">dismiss</button></span></li>`).join("")}</ul>` : `<p class="muted">Nothing pending. Runs nightly; needs the GEMINI_API_KEY (free) or ANTHROPIC_API_KEY secret.</p>`}</div>`;
};
async function decideSuggestion(key, email, accept) {
  if (accept) await fetch("/api/admin/people/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, email }) });
  await fetch("/api/admin/people/suggestions", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ key }) });
  refreshPeople({ force: true });
}
async function runStitch() {
  $("people-stitch").disabled = true;
  const d = await fetch("/api/admin/people/suggestions", { method: "POST" }).then((r) => r.json()).catch(() => ({}));
  if (d.skipped) alert("Set the GEMINI_API_KEY (or ANTHROPIC_API_KEY) worker secret first.");
  refreshPeople({ force: true });
}
const stat = (value, label) => `<span class="pstat"><b>${value}</b><small>${label}</small></span>`;
function card(p, i) {
  const name = displayName(p);
  const [ico, kind] = kindLabel(p);
  const banned = peopleState.bans.some((b) => (b.kind === "email" && p.emails.includes(b.value)) || p.devices.some((d) => d.id === b.value));
  const where = [...new Set(p.devices.map((d) => d.os))].slice(0, 2).join(", ");
  return `<button type="button" class="person-card rise${banned ? " is-banned" : ""}" style="--i:${Math.min(i, 12)}" data-person="${escAttr(p.key)}">
    <span class="avatar${p.emails.length ? " avatar-known" : ""}">${esc(initials(name))}</span>
    <span class="person-main"><b>${esc(name)}${banned ? ` <span class="kind-tag" data-kind="admin">blocked</span>` : ""}</b><small>${ico} ${kind}${p.devices.length ? ` · ${p.devices.length} device${p.devices.length === 1 ? "" : "s"}${where ? ` (${esc(where)})` : ""}` : ""}${p.places.length ? ` · ${esc(p.places[0])}` : ""}</small></span>
    ${stat(p.uploads || "–", p.uploads ? fmtBytes(p.bytes) : "uploads")}
    ${stat(p.views + p.shareOpens || "–", p.downloads ? `${p.downloads} downloads` : "views")}
    ${stat(ago(p.last), "last seen")}
    ${icon("chevron-right", "ico-sm")}
  </button>`;
}
