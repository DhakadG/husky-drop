import { $, activityOlder, icon, overview, setActivityFilter, setActivityQuery } from "./admin-state.js";
import { refreshAll } from "./admin.js";
import { activityTypeLabel, eventKind, eventTypeIcon, loadEarlierActivity, personKeyOf, renderEvents } from "./admin-activity.js";

// Activity tab toolbar and the two extra views (table, people). The session
// view stays in admin-activity.js. All filters are client-side over the
// events already loaded; the range select pulls earlier days on demand.

export const tools = { kind: "any", person: "", link: "", days: 3, sort: "newest", view: "sessions" };
let wired = false;
const TYPE_GROUPS = {
  uploads: ["open", "start", "file", "sessionclose", "autopause"],
  opens: ["open", "share-open"],
  views: ["share-view", "share-browse", "share-media_view_end"],
  downloads: ["share-dl"],
  errors: ["clienterror", "autopause", "lock", "global-lock", "drop-upload_error"],
};

export function eventKey(event) {
  return `${event.at}:${event.t}:${event.s}:${event.u}:${event.f}`;
}

// Loaded days now include today, which overlaps the overview's newest events.
export function allEvents() {
  const seen = new Set();
  return [...(overview?.events || []), ...activityOlder]
    .filter((e) => !seen.has(eventKey(e)) && seen.add(eventKey(e)))
    .sort((a, b) => (b.at || 0) - (a.at || 0));
}
export function eventPasses(e, ids, filter, query) {
  const t = e.t || "";
  if (filter !== "all" && !(TYPE_GROUPS[filter] || []).includes(t)) return false;
  if (tools.kind !== "any" && eventKind(t) !== tools.kind) return false;
  if (tools.person && personKeyOf(e, ids) !== tools.person) return false;
  if (tools.link && (e.s || "") !== tools.link) return false;
  if (e.at && e.at < Date.now() - tools.days * 86400e3) return false;
  const q = query.trim().toLowerCase();
  return !q || [e.u, e.e, e.l, e.s, e.f, e.m, e.c?.o, e.c?.l].some((v) => String(v || "").toLowerCase().includes(q));
}

export function wireActivityTools() {
  if (wired) return;
  wired = true;
  const on = (id, ev, fn) => $(id)?.addEventListener(ev, fn);
  on("activity-kind", "change", (e) => ((tools.kind = e.target.value), renderEvents()));
  on("activity-person", "change", (e) => ((tools.person = e.target.value), renderEvents()));
  on("activity-link", "change", (e) => ((tools.link = e.target.value), renderEvents()));
  on("activity-sort", "change", (e) => ((tools.sort = e.target.value), renderEvents()));
  on("activity-days", "change", async (e) => {
    tools.days = Number(e.target.value) || 3;
    renderEvents();
    // Pull earlier days until the loaded window covers the range (max 14).
    const target = new Date(Date.now() - tools.days * 86400e3).toISOString().slice(0, 10);
    for (let i = 0; i < 5 && (await import("./admin-state.js")).activityOldestDay > target; i++) await loadEarlierActivity();
  });
  on("activity-refresh", "click", async () => {
    const b = $("activity-refresh");
    b.disabled = true;
    await refreshAll();
    renderEvents();
    b.disabled = false;
  });
  on("activity-export", "click", exportCsv);
  on("activity-clear", "click", () => {
    Object.assign(tools, { kind: "any", person: "", link: "", days: 3, sort: "newest" });
    setActivityFilter("all");
    setActivityQuery("");
    for (const id of ["activity-kind", "activity-person", "activity-link", "activity-sort", "activity-days"]) if ($(id)) $(id).value = String(tools[id.replace("activity-", "")] ?? "");
    if ($("activity-query")) $("activity-query").value = "";
    document.querySelectorAll("[data-activity-filter]").forEach((b) => b.classList.toggle("active", b.dataset.activityFilter === "all"));
    renderEvents();
  });
  $("activity-views")?.addEventListener("click", (e) => {
    const b = e.target.closest("[data-activity-view]");
    if (!b) return;
    tools.view = b.dataset.activityView;
    document.querySelectorAll("[data-activity-view]").forEach((x) => x.classList.toggle("active", x === b));
    renderEvents();
  });
}

// Stats strip + select options, from the filtered set.
export function renderActivitySummary(filtered, all, ids, labelOf) {
  const sessions = new Set(filtered.map((e) => personKeyOf(e, ids) || e.si)).size;
  const files = filtered.filter((e) => e.t === "file");
  const stat = (v, l) => `<div class="act-stat"><b>${v}</b><small>${l}</small></div>`;
  const strip = $("activity-stats");
  if (strip) strip.innerHTML = [stat(sessions, "people"), stat(filtered.filter((e) => e.t === "open" || e.t === "share-open").length, "opens"), stat(`${files.reduce((n, e) => n + (Number(e.n) || 1), 0)} · ${fmtBytes(files.reduce((n, e) => n + (Number(e.b) || 0), 0))}`, "uploaded"), stat(filtered.filter((e) => /^share-(view|browse)/.test(e.t)).length, "views"), stat(filtered.filter((e) => e.t === "share-dl").length, "downloads"), stat(filtered.filter((e) => TYPE_GROUPS.errors.includes(e.t)).length, "errors")].join("");
  const fill = (id, entries, current) => {
    const sel = $(id);
    if (!sel) return;
    const head = sel.options[0]?.outerHTML || "";
    sel.innerHTML = head + entries.map(([v, l]) => `<option value="${escAttr(v)}"${v === current ? " selected" : ""}>${esc(l)}</option>`).join("");
  };
  const people = new Map();
  const links = new Map();
  for (const e of all) {
    const k = personKeyOf(e, ids);
    if (k) people.set(k, labelOf(k));
    if (e.s) links.set(e.s, e.l || e.s);
  }
  fill("activity-person", [...people].sort((a, b) => a[1].localeCompare(b[1])), tools.person);
  fill("activity-link", [...links].sort((a, b) => a[1].localeCompare(b[1])), tools.link);
}

export function renderActivityTable(events, ids, labelOf) {
  const box = $("activity-table");
  if (!box) return;
  const rows = tools.sort === "oldest" ? [...events].reverse() : events;
  box.innerHTML = rows.length
    ? `<div class="table-scroll"><table class="act-table"><thead><tr><th>when</th><th>who</th><th>what</th><th>where</th><th>detail</th><th>device</th></tr></thead><tbody>${rows.slice(0, 500).map((e) => `<tr class="${escAttr(e.t)}"><td class="mono">${new Date(e.at).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td><td><button type="button" class="link-like" data-open-person="${escAttr(personKeyOf(e, ids))}">${esc(labelOf(personKeyOf(e, ids)) || "anonymous")}</button></td><td><span class="kind-tag" data-kind="${eventKind(e.t)}">${eventKind(e.t)}</span> ${icon(eventTypeIcon(e.t), "ico-sm")} ${esc(activityTypeLabel(e.t))}</td><td>${esc(e.l || e.s || "")}</td><td class="act-detail">${esc(e.f || e.m || (e.b ? fmtBytes(e.b) : ""))}</td><td class="muted">${esc([e.c?.o, e.c?.l].filter(Boolean).join(" · "))}</td></tr>`).join("")}</tbody></table></div>${rows.length > 500 ? `<p class="muted">Showing 500 of ${rows.length}. Narrow the filters or export CSV.</p>` : ""}`
    : `<p class="muted">Nothing matches.</p>`;
}

export function renderActivityPeople(events, ids, labelOf) {
  const box = $("activity-people");
  if (!box) return;
  const by = new Map();
  for (const e of events) {
    const k = personKeyOf(e, ids) || "anonymous";
    const p = by.get(k) || { key: k, events: 0, opens: 0, files: 0, bytes: 0, views: 0, dl: 0, errors: 0, links: new Set(), last: 0, os: new Set() };
    p.events++;
    if (e.t === "open" || e.t === "share-open") p.opens++;
    if (e.t === "file") (p.files += Number(e.n) || 1), (p.bytes += Number(e.b) || 0);
    if (/^share-(view|browse)/.test(e.t)) p.views++;
    if (e.t === "share-dl") p.dl++;
    if (TYPE_GROUPS.errors.includes(e.t)) p.errors++;
    if (e.s) p.links.add(e.l || e.s);
    if (e.c?.o) p.os.add(e.c.o);
    p.last = Math.max(p.last, e.at || 0);
    by.set(k, p);
  }
  const rows = [...by.values()].sort((a, b) => (tools.sort === "events" ? b.events - a.events : b.last - a.last));
  box.innerHTML = rows.length
    ? `<div class="table-scroll"><table class="act-table"><thead><tr><th>person</th><th>events</th><th>opens</th><th>uploaded</th><th>views</th><th>downloads</th><th>errors</th><th>links</th><th>devices</th><th>last</th></tr></thead><tbody>${rows.map((p) => `<tr><td><button type="button" class="link-like" data-open-person="${escAttr(p.key)}">${esc(labelOf(p.key) || p.key)}</button></td><td class="mono">${p.events}</td><td class="mono">${p.opens}</td><td class="mono">${p.files ? `${p.files} · ${fmtBytes(p.bytes)}` : "–"}</td><td class="mono">${p.views}</td><td class="mono">${p.dl}</td><td class="mono${p.errors ? " img-bad" : ""}">${p.errors}</td><td class="act-detail">${esc([...p.links].slice(0, 3).join(", "))}${p.links.size > 3 ? ` +${p.links.size - 3}` : ""}</td><td class="muted">${esc([...p.os].join(", "))}</td><td class="mono">${new Date(p.last).toLocaleString([], { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="muted">Nothing matches.</p>`;
}

function exportCsv() {
  const rows = $("activity-table")?._rows || [];
  const cols = ["at", "person", "kind", "type", "link", "file", "message", "bytes", "count", "os", "place"];
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => `"${String(r[c] ?? "").replace(/"/g, '""')}"`).join(","))].join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = `activity-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
export function stashForExport(events, ids, labelOf) {
  const box = $("activity-table");
  if (box) box._rows = events.map((e) => ({ at: new Date(e.at).toISOString(), person: labelOf(personKeyOf(e, ids)), kind: eventKind(e.t), type: e.t, link: e.l || e.s, file: e.f, message: e.m, bytes: e.b, count: e.n, os: e.c?.o, place: e.c?.l }));
}
