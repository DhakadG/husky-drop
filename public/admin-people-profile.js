import { $, icon } from "./admin-state.js";
import { activityTypeLabel, eventTypeIcon } from "./admin-activity.js";
import { ago, displayName, initials, refreshPeople, renderList, skeleton } from "./admin-people.js";

// One person's profile: identity chips, stats, devices (from the sessions
// table with Fingerprint verdicts), merge/unlink, block/unblock.

export const peopleState = { people: [], bans: [], suggestions: [], loaded: false };
export const riskFlags = (m = {}) => [m.rule === "block" && "rule: block", m.tor && "tor", m.vpn && "vpn", m.proxy && "proxy", m.datacenter && "datacenter", m.tampering && "tampering", m.antiDetect && "anti-detect", m.attackSource && "attack source", m.highActivity && "high activity", Number(m.suspect) >= 25 && `suspect ${m.suspect}`, Number(m.countries24h) > 1 && `${m.countries24h} countries/24h`].filter(Boolean);
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
  const current = document.querySelector(".person-profile")?.dataset.key || "";
  await refreshPeople({ force: true });
  if (current) openPerson(current);
  else renderList();
}

// Identity chips: typed names, then linked device/fingerprint/session keys.
const aliasChip = (a) => {
  const [kind, value] = a.split(/:(.*)/);
  const ico = { name: "user-round", device: "smartphone", fp: "aperture", session: "eye" }[kind] || "link";
  return `<span class="id-chip" title="${escAttr(a)}">${icon(ico, "ico-sm")}<span>${esc(kind === "name" ? value : `${kind} ${value.slice(0, 8)}`)}</span><button type="button" class="id-chip-x" data-unlink="${escAttr(a)}" aria-label="unlink">${icon("x", "ico-sm")}</button></span>`;
};
const identityBlock = (p) => {
  if (p.emails.length) {
    const chips = [...p.names.map((n) => `<span class="id-chip is-name">${icon("user-round", "ico-sm")}<span>${esc(n)}</span></span>`), ...(p.aliases || []).map(aliasChip)];
    return chips.length ? `<div class="id-chips"><small class="muted">also known as</small>${chips.join("")}</div>` : "";
  }
  const accounts = peopleState.people.filter((x) => x.emails.length).map((x) => x.emails[0]);
  return accounts.length ? `<p class="people-merge">${icon("link", "ico-sm")} same person as <select id="people-merge-into" class="sort-select">${accounts.map((a) => `<option>${esc(a)}</option>`).join("")}</select> <button type="button" class="mini" id="people-merge-go" data-key="${escAttr(p.key)}">merge</button></p>` : "";
};

const cell = (label, value) => (value ? `<span class="dev-cell"><small>${label}</small><b>${esc(String(value))}</b></span>` : "");
const deviceCard = (s) => {
  const m = s.meta || {};
  const flags = riskFlags(m);
  const os = [s.os, m.osVersion].filter(Boolean).join(" ");
  const browser = m.browserName && m.browserName !== "Chromium-Based Browser" ? m.browserName : m.browser;
  return `<li class="device-card${flags.length ? " is-risky" : ""}">
    <div class="dev-head"><span class="avatar">${icon(/android|ios/i.test(s.os) ? "smartphone" : /mac|win|linux/i.test(s.os) ? "laptop" : "monitor")}</span>
      <div class="dev-title"><b>${esc(os || "device")}${m.device && m.device !== "Other" ? ` · ${esc(m.device)}` : ""}</b><small>${esc(browser || s.ua?.slice(0, 60) || "")}</small></div>
      <div class="dev-flags">${flags.map((f) => `<span class="kind-tag risk">${esc(f)}</span>`).join("") || `<span class="kind-tag" data-kind="drop">clean</span>`}</div></div>
    <div class="dev-grid">
      ${cell("where", m.city || s.loc)}${cell("network", [m.asn, m.conn].filter(Boolean).join(" · "))}${cell("screen", m.screen)}${cell("timezone", m.tz)}${cell("language", m.lang)}${cell("hardware", [m.cores && `${m.cores} cores`, m.mem && `${m.mem} GB`, m.touch > 0 && "touch"].filter(Boolean).join(" · "))}
      ${cell("visits", `${s.visits} · first ${ago(s.first)} ago · last ${ago(s.last)} ago`)}${cell("last page", s.slug)}${cell("rule", m.rule ? `${m.rule}${m.ruleWhy ? ` · ${m.ruleWhy}` : ""}` : "")}${cell("id confidence", m.fpConfidence != null ? `${Math.round(m.fpConfidence * 100)}%` : "")}${cell("ids", [s.did && `cookie ${s.did.slice(0, 6)}`, s.fp && `fp ${s.fp.slice(0, 6)}`].filter(Boolean).join(" · "))}
    </div>
    <div class="dev-actions">${s.did ? banBtn("device", s.did, "cookie") : ""}${s.fp ? banBtn("fp", s.fp, "fingerprint") : ""}</div>
  </li>`;
};

export async function openPerson(key) {
  const p = peopleState.people.find((x) => x.key === key);
  const host = $("people-body");
  if (!p) return;
  const name = displayName(p);
  host.innerHTML = `<button class="mini" id="people-back" type="button">${icon("arrow-left", "ico-sm")} all people</button>
    <article class="person-profile rise" data-key="${escAttr(key)}">
      <header class="person-header">
        <span class="avatar avatar-lg${p.emails.length ? " avatar-known" : ""}">${esc(initials(name))}</span>
        <div class="person-head">
          <h2>${esc(p.emails.length ? p.emails[0].replace(/@.*/, "").replace(/[._]/g, " ") : name)}</h2>
          <p class="person-sub">${p.emails.length ? `${icon("google-g", "ico-sm")} ${esc(p.emails[0])}` : `${icon("user-round", "ico-sm")} not signed in with Google`}</p>
          <dl class="person-meta"><div><dt>first seen</dt><dd>${new Date(p.first).toLocaleDateString([], { day: "2-digit", month: "short", year: "numeric" })}</dd></div><div><dt>last seen</dt><dd>${ago(p.last)} ago</dd></div><div><dt>events</dt><dd>${p.events}</dd></div>${p.places.length ? `<div><dt>places</dt><dd>${esc(p.places.join(", "))}</dd></div>` : ""}</dl>
          ${identityBlock(p)}
        </div>
        <div class="person-actions">${p.emails[0] ? banBtn("email", p.emails[0], "account") : ""}</div>
      </header>
      <div class="stat-grid">
        <div class="stat-card v3"><span class="stat-ico">${icon("upload")}</span><div><b>${p.uploads}</b><span class="stat-label">files uploaded · ${fmtBytes(p.bytes)}</span></div></div>
        <div class="stat-card v3"><span class="stat-ico">${icon("eye")}</span><div><b>${p.shareOpens}</b><span class="stat-label">share opens · ${p.views} views · ${p.downloads} downloads</span></div></div>
        <div class="stat-card v3"><span class="stat-ico">${icon("smartphone")}</span><div><b id="person-device-count">${p.devices.length}</b><span class="stat-label">devices</span></div></div>
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
  $("person-devices").innerHTML = sessions.length ? `<ul class="device-list">${sessions.map(deviceCard).join("")}</ul>` : `<p class="muted">No device details yet - recorded from the next visit on.</p>`;
  if (sessions.length) $("person-device-count").textContent = sessions.length;
  const events = d.events || [];
  $("person-timeline").innerHTML = events.length
    ? `<div class="activity-timeline">${events.map((e) => `<div class="activity-timeline-row ${escAttr(e.t || "event")}"><span class="activity-type-icon">${icon(eventTypeIcon(e.t))}</span><span><b>${esc(e.f || (e.m !== "first open" && e.m) || activityTypeLabel(e.t))}</b><small><span class="kind-tag" data-kind="${kindOf(e.t)}">${kindOf(e.t)}</span> ${esc(activityTypeLabel(e.t))}${e.l ? ` · ${esc(e.l)}` : ""}${e.c?.o ? ` · ${esc(e.c.o)}` : ""}</small></span><time>${new Date(e.at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</time></div>`).join("")}</div>`
    : `<p class="muted">no events</p>`;
}
