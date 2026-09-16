import { $, icon } from "./admin-state.js";
import { showTab } from "./admin.js";
import { activityTypeLabel, eventTypeIcon } from "./admin-activity.js";

// People tab: one profile per visitor. Identity = Google account when the
// device ever signed in, else the device, else the typed uploader name.

let people = [];
let loaded = false;
let wired = false;
const ago = (ts) => {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  return s < 60 ? "just now" : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};
const kindOf = (t) => (/^share/.test(t) ? "share" : "drop");
const displayName = (p) => p.emails[0] || p.names[0] || (p.key.startsWith("device:") ? `Device ${p.key.slice(7, 13)}` : p.key.startsWith("session:") ? `Unknown visitor ${p.key.slice(8, 14)}` : p.key.replace(/^name:/, ""));
const initials = (name) => name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";

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
      const goto = e.target.closest("[data-goto-link]");
      if (goto) return showTab("links");
      const share = e.target.closest("[data-goto-share]");
      if (share) return showTab("shares");
      const unlink = e.target.closest("[data-unlink]");
      if (unlink) return merge(unlink.dataset.unlink, "");
      if (e.target.closest("#people-merge-go")) return merge($("people-merge-go").dataset.key, $("people-merge-into").value);
    });
  }
  if (loaded && !force) return renderList();
  host.innerHTML = skeleton(4);
  try {
    const r = await fetch("/api/admin/people?days=90");
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `people ${r.status}`);
    people = d.people || [];
    loaded = true;
    renderList();
  } catch (error) {
    host.innerHTML = `<p class="muted">${icon("circle-alert", "ico-sm")} ${esc(error.message)}</p>`;
  }
}

export function openPersonByKey(key) {
  showTab("people");
  refreshPeople().then(() => openPerson(key));
}

async function merge(key, email) {
  const r = await fetch("/api/admin/people/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, email }) });
  if (!r.ok) return alert((await r.json().catch(() => ({}))).error || "merge failed");
  await refreshPeople({ force: true });
  openPerson(email ? `email:${email}` : key);
}
const mergeBox = (p) => {
  if (p.emails.length) return p.aliases?.length ? `<p class="muted">also known as ${p.aliases.map((a) => `<code>${esc(a.replace(/^(device|name):/, ""))}</code> <button type="button" class="link-like" data-unlink="${escAttr(a)}">unlink</button>`).join(", ")}</p>` : "";
  const accounts = people.filter((x) => x.emails.length).map((x) => x.emails[0]);
  return accounts.length ? `<p class="people-merge">${icon("link", "ico-sm")} same person as <select id="people-merge-into" class="sort-select">${accounts.map((a) => `<option>${esc(a)}</option>`).join("")}</select> <button type="button" class="mini" id="people-merge-go" data-key="${escAttr(p.key)}">merge</button></p>` : "";
};
const skeleton = (n) => `<div class="skel-list">${Array.from({ length: n }, (_, i) => `<div class="skel-card" style="--i:${i}"><span class="skel-avatar"></span><span class="skel-lines"><i style="width:40%"></i><i style="width:65%"></i></span></div>`).join("")}</div>`;

function renderList() {
  const host = $("people-body");
  const q = $("people-search").value.trim().toLowerCase();
  const sort = $("people-sort").value;
  let rows = people.filter((p) => !q || [displayName(p), ...p.emails, ...p.names, ...p.places, ...p.links.map((l) => l.label), ...p.shares.map((s) => s.label)].some((v) => String(v).toLowerCase().includes(q)));
  rows = rows.sort((a, b) => (sort === "uploads" ? b.bytes - a.bytes : sort === "views" ? b.views + b.shareOpens - (a.views + a.shareOpens) : sort === "errors" ? b.errors - a.errors : b.last - a.last));
  const totals = { people: people.length, identified: people.filter((p) => p.emails.length).length, bytes: people.reduce((n, p) => n + p.bytes, 0) };
  host.innerHTML = `<div class="people-summary"><span><b>${totals.people}</b> visitors in 90 days</span><span><b>${totals.identified}</b> identified by Google account</span><span><b>${fmtBytes(totals.bytes)}</b> uploaded</span></div>
    <div class="people-grid">${rows.map((p, i) => card(p, i)).join("") || `<p class="muted">Nobody matches.</p>`}</div>`;
}

function card(p, i) {
  const name = displayName(p);
  const identified = p.emails.length > 0;
  return `<button type="button" class="person-card rise" style="--i:${Math.min(i, 12)}" data-person="${escAttr(p.key)}">
    <span class="avatar${identified ? " avatar-known" : ""}">${esc(initials(name))}</span>
    <span class="person-main"><b>${esc(name)}</b><small>${identified ? icon("google-g", "ico-sm") + " Google" : p.key.startsWith("device:") ? icon("smartphone", "ico-sm") + " device only" : p.key.startsWith("session:") ? icon("eye", "ico-sm") + " no sign-in, one visit" : icon("user-round", "ico-sm") + " typed name"}${p.names.length && identified ? ` · also “${esc(p.names.slice(0, 2).join("”, “"))}”` : ""}${p.devices.length ? ` · ${p.devices.length} device${p.devices.length === 1 ? "" : "s"} (${esc([...new Set(p.devices.map((d) => d.os))].join(", "))})` : ""}${p.places.length ? ` · ${esc(p.places.slice(0, 2).join(", "))}` : ""}</small></span>
    <span class="person-stats">${p.uploads ? `<em>${p.uploads} files · ${fmtBytes(p.bytes)}</em>` : ""}${p.shareOpens || p.views ? `<em>${p.shareOpens} opens · ${p.views} views · ${p.downloads} dl</em>` : ""}${p.errors ? `<em class="img-bad">${p.errors} errors</em>` : ""}<small class="muted">last seen ${ago(p.last)}</small></span>
    ${icon("chevron-right", "ico-sm")}
  </button>`;
}

async function openPerson(key) {
  const p = people.find((x) => x.key === key);
  const host = $("people-body");
  if (!p) return;
  const name = displayName(p);
  host.innerHTML = `<button class="mini" id="people-back" type="button">${icon("arrow-left", "ico-sm")} all people</button>
    <article class="person-profile rise">
      <header><span class="avatar avatar-lg${p.emails.length ? " avatar-known" : ""}">${esc(initials(name))}</span><div><h2>${esc(name)}</h2><p class="muted">${p.emails.map((e) => esc(e)).join(", ") || "not signed in with Google yet"}${p.names.length ? ` · typed as ${p.names.map((n) => `“${esc(n)}”`).join(", ")}` : ""}</p><p class="muted">first seen ${new Date(p.first).toLocaleString()} · last ${ago(p.last)} · ${p.events} events</p>${mergeBox(p)}</div></header>
      <div class="stat-grid">
        <div class="stat-card v3"><span class="stat-ico">${icon("upload")}</span><div><b>${p.uploads}</b><span class="stat-label">files uploaded · ${fmtBytes(p.bytes)}</span></div></div>
        <div class="stat-card v3"><span class="stat-ico">${icon("eye")}</span><div><b>${p.shareOpens}</b><span class="stat-label">share opens · ${p.views} views · ${p.downloads} downloads</span></div></div>
        <div class="stat-card v3"><span class="stat-ico">${icon("smartphone")}</span><div><b>${p.devices.length}</b><span class="stat-label">${esc([...new Set(p.devices.map((d) => d.os))].join(", ") || "devices")}${p.places.length ? ` · ${esc(p.places.join(", "))}` : ""}</span></div></div>
        <div class="stat-card v3"><span class="stat-ico">${icon("circle-alert")}</span><div><b>${p.errors}</b><span class="stat-label">client errors</span></div></div>
      </div>
      <div class="dashboard-grid">
        <section class="panel"><div class="section-title"><h2>${icon("download")} Drop links used</h2></div>${p.links.length ? `<ul class="person-links">${p.links.map((l) => `<li><button type="button" class="link-like" data-goto-link="${escAttr(l.slug)}">${esc(l.label)}</button><small class="muted">${l.files ? `${l.files} files · ${fmtBytes(l.bytes)} · ` : ""}${l.events} events · ${ago(l.last)}</small></li>`).join("")}</ul>` : `<p class="muted">none</p>`}</section>
        <section class="panel"><div class="section-title"><h2>${icon("share-2")} Shares viewed</h2></div>${p.shares.length ? `<ul class="person-links">${p.shares.map((s) => `<li><button type="button" class="link-like" data-goto-share="${escAttr(s.slug)}">${esc(s.label)}</button><small class="muted">${s.events} events · ${ago(s.last)}</small></li>`).join("")}</ul>` : `<p class="muted">none</p>`}</section>
      </div>
      <section class="panel"><div class="section-title"><h2>${icon("activity")} Timeline</h2></div><div id="person-timeline">${skeleton(3)}</div></section>
    </article>`;
  const r = await fetch(`/api/admin/people/${encodeURIComponent(key)}`);
  const d = await r.json().catch(() => ({}));
  const events = d.events || [];
  $("person-timeline").innerHTML = events.length
    ? `<div class="activity-timeline">${events.map((e) => `<div class="activity-timeline-row ${escAttr(e.t || "event")}"><span class="activity-type-icon">${icon(eventTypeIcon(e.t))}</span><span><b>${esc(e.f || (e.m !== "first open" && e.m) || activityTypeLabel(e.t))}</b><small><span class="kind-tag" data-kind="${kindOf(e.t)}">${kindOf(e.t)}</span> ${esc(activityTypeLabel(e.t))}${e.l ? ` · ${esc(e.l)}` : ""}${e.c?.o ? ` · ${esc(e.c.o)}` : ""}</small></span><time>${new Date(e.at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time></div>`).join("")}</div>`
    : `<p class="muted">no events</p>`;
}
