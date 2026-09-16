import { $, icon } from "./admin-state.js";
import { activityTypeLabel, eventTypeIcon } from "./admin-activity.js";
import { ago, displayName, initials, refreshPeople, renderList, skeleton } from "./admin-people.js";

// One person's profile: stats, links, devices (from the sessions table),
// merge/unlink into a Google account, block/unblock account or device.

export const peopleState = { people: [], bans: [], suggestions: [], loaded: false };
export const riskFlags = (m = {}) => [m.tor && "tor", m.vpn && "vpn", m.proxy && "proxy", m.datacenter && "datacenter", m.tampering && "tampering", m.antiDetect && "anti-detect", m.attackSource && "attack source", m.highActivity && "high activity", Number(m.suspect) >= 25 && `suspect ${m.suspect}`, Number(m.countries24h) > 1 && `${m.countries24h} countries/24h`].filter(Boolean);
const kindOf = (t) => (/^share/.test(t) ? "share" : "drop");
const isBanned = (kind, value) => peopleState.bans.some((b) => b.kind === kind && b.value === value);
const banBtn = (kind, value, label) => `<button type="button" class="mini${isBanned(kind, value) ? " is-on" : ""}" data-ban-kind="${kind}" data-ban-value="${escAttr(value)}" data-ban-on="${isBanned(kind, value) ? 0 : 1}">${icon("shield-alert", "ico-sm")} ${isBanned(kind, value) ? `unblock ${label}` : `block ${label}`}</button>`;

export async function mergePerson(key, email) {
  const r = await fetch("/api/admin/people/merge", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key, email }) });
  if (!r.ok) return alert((await r.json().catch(() => ({}))).error || "merge failed");
  await refreshPeople({ force: true });
  openPerson(email ? `email:${email}` : key);
}
export async function setBan(kind, value, on) {
  const reason = on ? prompt(`Block ${kind} ${value}?\nReason (optional):`) : "";
  if (on && reason === null) return;
  const r = await fetch("/api/admin/bans", { method: on ? "POST" : "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind, value, reason }) });
  if (!r.ok) return alert("ban update failed");
  const current = $("people-back") ? document.querySelector(".person-profile")?.dataset.key : "";
  await refreshPeople({ force: true });
  if (current) openPerson(current);
  else renderList();
}

const mergeBox = (p) => {
  if (p.emails.length) return p.aliases?.length ? `<p class="muted">also known as ${p.aliases.map((a) => `<code>${esc(a.replace(/^(device|fp|name|session):/, "$1 ").slice(0, 28))}</code> <button type="button" class="link-like" data-unlink="${escAttr(a)}">unlink</button>`).join(", ")}</p>` : "";
  const accounts = peopleState.people.filter((x) => x.emails.length).map((x) => x.emails[0]);
  return accounts.length ? `<p class="people-merge">${icon("link", "ico-sm")} same person as <select id="people-merge-into" class="sort-select">${accounts.map((a) => `<option>${esc(a)}</option>`).join("")}</select> <button type="button" class="mini" id="people-merge-go" data-key="${escAttr(p.key)}">merge</button></p>` : "";
};

const deviceRow = (s) => {
  const m = s.meta || {};
  const bits = [m.browserName && m.browserName !== "Chromium-Based Browser" ? m.browserName : m.browser, m.osVersion && `${s.os} ${m.osVersion}`, m.device && m.device !== "Other" && m.device, m.screen, m.tz, m.lang, m.conn && `${m.conn} net`, m.touch > 0 && "touch", m.standalone && "installed app", m.asn, m.fpConfidence != null && `id confidence ${Math.round(m.fpConfidence * 100)}%`].filter(Boolean);
  const flags = riskFlags(m);
  return `<li class="device-row"><span class="avatar">${icon(/android|ios/i.test(s.os) ? "smartphone" : "monitor")}</span>
    <span class="device-main"><b>${esc(s.os || "device")}${s.loc || m.city ? ` · ${esc(m.city || s.loc)}` : ""}${flags.map((f) => ` <span class="kind-tag risk">${esc(f)}</span>`).join("")}</b><small>${esc(bits.join(" · ") || s.ua || "")}</small><small class="muted">${s.visits} visit${s.visits === 1 ? "" : "s"} · first ${ago(s.first)} ago · last ${ago(s.last)} ago${s.slug ? ` · ${esc(s.slug)}` : ""}${s.did ? ` · cookie ${esc(s.did.slice(0, 6))}` : ""}${s.fp ? ` · fp ${esc(s.fp.slice(0, 6))}` : ""}</small></span>
    <span class="device-actions">${s.did ? banBtn("device", s.did, "cookie") : ""}${s.fp ? banBtn("fp", s.fp, "fingerprint") : ""}${!s.did && !s.fp ? "" : ""}</span></li>`;
};

export async function openPerson(key) {
  const p = peopleState.people.find((x) => x.key === key);
  const host = $("people-body");
  if (!p) return;
  const name = displayName(p);
  host.innerHTML = `<button class="mini" id="people-back" type="button">${icon("arrow-left", "ico-sm")} all people</button>
    <article class="person-profile rise" data-key="${escAttr(key)}">
      <header><span class="avatar avatar-lg${p.emails.length ? " avatar-known" : ""}">${esc(initials(name))}</span><div class="person-head"><h2>${esc(name)}</h2><p class="muted">${p.emails.map((e) => esc(e)).join(", ") || "not signed in with Google"}${p.names.length ? ` · typed as ${p.names.map((n) => `“${esc(n)}”`).join(", ")}` : ""}</p><p class="muted">first seen ${new Date(p.first).toLocaleDateString()} · last ${ago(p.last)} ago · ${p.events} events</p>${mergeBox(p)}</div><div class="person-actions">${p.emails[0] ? banBtn("email", p.emails[0], "account") : ""}</div></header>
      <div class="stat-grid">
        <div class="stat-card v3"><span class="stat-ico">${icon("upload")}</span><div><b>${p.uploads}</b><span class="stat-label">files uploaded · ${fmtBytes(p.bytes)}</span></div></div>
        <div class="stat-card v3"><span class="stat-ico">${icon("eye")}</span><div><b>${p.shareOpens}</b><span class="stat-label">share opens · ${p.views} views · ${p.downloads} downloads</span></div></div>
        <div class="stat-card v3"><span class="stat-ico">${icon("smartphone")}</span><div><b id="person-device-count">${p.devices.length}</b><span class="stat-label">devices${p.places.length ? ` · ${esc(p.places.join(", "))}` : ""}</span></div></div>
        <div class="stat-card v3"><span class="stat-ico">${icon("circle-alert")}</span><div><b>${p.errors}</b><span class="stat-label">client errors</span></div></div>
      </div>
      <section class="panel"><div class="section-title"><h2>${icon("smartphone")} Devices</h2></div><div id="person-devices">${skeleton(2)}</div></section>
      <div class="dashboard-grid">
        <section class="panel"><div class="section-title"><h2>${icon("download")} Drop links used</h2></div>${p.links.length ? `<ul class="person-links">${p.links.map((l) => `<li><button type="button" class="link-like" data-goto-link="${escAttr(l.slug)}">${esc(l.label)}</button><small class="muted">${l.files ? `${l.files} files · ${fmtBytes(l.bytes)} · ` : ""}${l.events} events · ${ago(l.last)} ago</small></li>`).join("")}</ul>` : `<p class="muted">none</p>`}</section>
        <section class="panel"><div class="section-title"><h2>${icon("share-2")} Shares viewed</h2></div>${p.shares.length ? `<ul class="person-links">${p.shares.map((s) => `<li><button type="button" class="link-like" data-goto-share="${escAttr(s.slug)}">${esc(s.label)}</button><small class="muted">${s.events} events · ${ago(s.last)} ago</small></li>`).join("")}</ul>` : `<p class="muted">none</p>`}</section>
      </div>
      <section class="panel"><div class="section-title"><h2>${icon("activity")} Timeline</h2></div><div id="person-timeline">${skeleton(3)}</div></section>
    </article>`;
  const r = await fetch(`/api/admin/people/${encodeURIComponent(key)}`);
  const d = await r.json().catch(() => ({}));
  const sessions = d.sessions || [];
  $("person-devices").innerHTML = sessions.length ? `<ul class="device-list">${sessions.map(deviceRow).join("")}</ul>` : `<p class="muted">No device details yet - recorded from the next visit on.</p>`;
  if (sessions.length) $("person-device-count").textContent = sessions.length;
  const events = d.events || [];
  $("person-timeline").innerHTML = events.length
    ? `<div class="activity-timeline">${events.map((e) => `<div class="activity-timeline-row ${escAttr(e.t || "event")}"><span class="activity-type-icon">${icon(eventTypeIcon(e.t))}</span><span><b>${esc(e.f || (e.m !== "first open" && e.m) || activityTypeLabel(e.t))}</b><small><span class="kind-tag" data-kind="${kindOf(e.t)}">${kindOf(e.t)}</span> ${esc(activityTypeLabel(e.t))}${e.l ? ` · ${esc(e.l)}` : ""}${e.c?.o ? ` · ${esc(e.c.o)}` : ""}</small></span><time>${new Date(e.at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time></div>`).join("")}</div>`
    : `<p class="muted">no events</p>`;
}
