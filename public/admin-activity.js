import {
  $,
  activityFilter,
  activityLoading,
  activityOlder,
  activityOldestDay,
  activityQuery,
  icon,
  openActivitySessions,
  overview,
  setActivityLoading,
  setActivityOldestDay,
} from "./admin-state.js";
import { setEmpty } from "./admin.js";
import { initialsOf } from "./admin-live.js";

// Activity feed: grouping by day/session, filters, earlier-day paging.
export function renderEvents() {
  const fresh = overview?.events || [];
  const all = [...fresh, ...activityOlder].sort((a, b) => (b.at || 0) - (a.at || 0));
  const filtered = all.filter(activityMatches);
  const days = groupActivityDays(filtered);
  const box = $("events");
  if (box) {
    reconcile(box, days, (day) => day.key, makeActivityDay, updateActivityDay);
    setEmpty(box, days.length === 0, activityQuery || activityFilter !== "all" ? "No activity matches these filters." : "No activity yet.");
  }

  const mini = $("events-mini");
  if (mini) {
    const top = fresh.slice(0, 5);
    reconcile(mini, top, (event) => `mini:${eventKey(event)}`, makeCompactEventRow, updateCompactEventRow);
    setEmpty(mini, top.length === 0, "No activity yet.");
  }
}

function activityMatches(event) {
  const type = event.t || "";
  const groups = {
    uploads: ["open", "start", "file", "sessionclose", "autopause"],
    opens: ["open", "share-open"],
    views: ["share-view", "share-browse"],
    downloads: ["share-dl"],
    errors: ["clienterror", "autopause", "lock", "global-lock"],
  };
  if (activityFilter !== "all" && !(groups[activityFilter] || []).includes(type)) return false;
  const query = activityQuery.trim().toLowerCase();
  if (!query) return true;
  return [event.u, event.l, event.s, event.f, event.m, event.c?.o, event.c?.l].some((value) => String(value || "").toLowerCase().includes(query));
}

function groupActivityDays(events) {
  const days = new Map();
  for (const event of events) {
    const dayKey = new Date(event.at || Date.now()).toISOString().slice(0, 10);
    if (!days.has(dayKey)) days.set(dayKey, []);
    days.get(dayKey).push(event);
  }
  return [...days.entries()].map(([key, dayEvents]) => ({ key, sessions: groupActivitySessions(dayEvents, key) }));
}

function groupActivitySessions(events, day = "") {
  const sessions = new Map();
  for (const event of events) {
    // One card per person per day: a named or signed-in visitor keeps one
    // timeline across drop uploads and share browsing instead of a card per
    // ten-minute burst. Anonymous traffic still falls back to bursts.
    const person = String(event.u || "").trim().toLowerCase();
    const key = person ? `person:${person}` : event.si || `anon:${event.s || event.l || "system"}:${Math.floor((event.at || 0) / 600000)}`;

    if (!sessions.has(key)) sessions.set(key, { key: `${day}:${key}`, events: [] });
    sessions.get(key).events.push(event);
  }
  return [...sessions.values()]
    .map((session) => ({ ...session, events: session.events.sort((a, b) => (a.at || 0) - (b.at || 0)) }))
    .sort((a, b) => (b.events.at(-1)?.at || 0) - (a.events.at(-1)?.at || 0));
}

function makeActivityDay() {
  const section = document.createElement("section");
  section.className = "activity-day";
  section.innerHTML = `<div class="activity-day-head"><span></span><b></b></div><div class="activity-session-list"></div>`;
  section._label = section.querySelector(".activity-day-head span");
  section._count = section.querySelector(".activity-day-head b");
  section._list = section.querySelector(".activity-session-list");
  return section;
}

function updateActivityDay(section, day) {
  const date = new Date(`${day.key}T00:00:00`);
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
  const prefix = day.key === today ? "Today" : day.key === yesterday ? "Yesterday" : "Activity";
  section._label.textContent = `${prefix} · ${fmtDateDMY(date)}`;
  section._count.textContent = `${day.sessions.length} visitor${day.sessions.length === 1 ? "" : "s"}`;
  reconcile(section._list, day.sessions, (session) => session.key, makeActivitySession, updateActivitySession);
}

function makeActivitySession() {
  const article = document.createElement("article");
  article.className = "activity-session glass-tile";
  return article;
}

function updateActivitySession(article, session) {
  const events = session.events;
  const first = events[0] || {};
  const last = events.at(-1) || first;
  const actor = last.u || first.u || "anonymous";
  const place = last.l || last.s || first.l || first.s || "system";
  const context = last.c || first.c || {};
  const fileCount = activityFileCount(events);
  const hasError = events.some((event) => ["clienterror", "autopause", "lock", "global-lock"].includes(event.t));
  const expanded = openActivitySessions.has(session.key);
  const counts = activityCounts(events);
  article.className = `activity-session glass-tile${expanded ? " expanded" : ""}${hasError ? " has-error" : ""}`;
  article.innerHTML = `
    <button class="activity-session-summary" type="button" aria-expanded="${expanded}">
      <span class="avatar">${esc(initialsOf(actor))}</span>
      <span class="activity-person"><b>${esc(actor)} <i>·</i> ${esc(place)}</b><small>${esc(context.o || "Unknown device")}${context.l ? ` · ${esc(context.l)}` : ""} · ${activityTimeRange(first.at, last.at)}</small></span>
      <span class="activity-counts">${counts}${fileCount ? `<em>${fileCount} file${fileCount === 1 ? "" : "s"}</em>` : ""}</span>
      ${icon("chevron-down", "activity-chevron")}
    </button>
    <div class="activity-timeline">${events.map(activityTimelineRow).join("")}</div>`;
  article.querySelector(".activity-session-summary").onclick = () => {
    if (openActivitySessions.has(session.key)) openActivitySessions.delete(session.key);
    else openActivitySessions.add(session.key);
    updateActivitySession(article, session);
  };
}

function activityCounts(events) {
  const labels = [];
  const uploads = activityFileCount(events);
  const opens = events.filter((event) => event.t === "open" || event.t === "share-open").length;
  const views = events.filter((event) => event.t === "share-view" || event.t === "share-browse").length;
  const downloads = events.filter((event) => event.t === "share-dl").length;
  if (uploads) labels.push(`<em>${uploads} upload${uploads === 1 ? "" : "s"}</em>`);
  if (opens) labels.push(`<em>${opens} open${opens === 1 ? "" : "s"}</em>`);
  if (views) labels.push(`<em>${views} view${views === 1 ? "" : "s"}</em>`);
  if (downloads) labels.push(`<em>${downloads} download${downloads === 1 ? "" : "s"}</em>`);
  return labels.join("");
}

function activityFileCount(events) {
  const completedFiles = events.filter((event) => event.t === "file").reduce((total, event) => total + (Number(event.n) || 1), 0);
  const terminalCount = Math.max(0, ...events.filter((event) => event.t === "sessionclose").map((event) => Number(event.n) || 0));
  return Math.max(completedFiles, terminalCount);
}

function activityTimelineRow(event) {
  const count = Number(event.n) || 0;
  const label = event.t === "file" && count > 1 ? `${count} files uploaded` : event.f || (event.m !== "first open" && event.m) || activityTypeLabel(event.t);
  const meta = [activityTypeLabel(event.t), event.l || (event.s ? `link ${event.s}` : ""), event.m === "first open" ? "first time on this share" : ""].filter(Boolean).join(" · ");
  return `<div class="activity-timeline-row ${escAttr(event.t || "event")}"><span class="activity-type-icon">${icon(eventTypeIcon(event.t))}</span><span><b>${esc(label)}</b><small>${esc(meta)}</small></span><time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>`;
}

export function activityTypeLabel(type) {
  const labels = {
    open: "Opened drop link", start: "Started upload", file: "Uploaded file", sessionclose: "Session finished",
    "share-open": "Opened share", "share-view": "Viewed file", "share-browse": "Browsed gallery", "share-dl": "Downloaded file",
    "share-clicks": "Interacted with share", "share-file-info": "Opened file information", "share-media_view_end": "Finished viewing media",
    "share-layout": "Changed gallery layout", "share-performance": "Share performance sample",
    "drop-clicks": "Interacted with drop page", "drop-upload_start": "Started a file", "drop-upload_session_created": "Prepared upload session",
    "drop-upload_resumed": "Resumed a file", "drop-upload_retry": "Retried an upload", "drop-upload_progress": "Upload progress",
    "drop-upload_bytes_complete": "Sent file bytes", "drop-upload_complete": "Upload verified complete", "drop-upload_error": "Upload error",
    "drop-network_offline": "Uploader went offline", "drop-network_online": "Uploader came online",
    "drop-session_end": "Left the drop page", "drop-client_error": "Uploader hit an error", "drop-upload_paused": "Paused uploads",
    clienterror: "Client error", autopause: "Link auto-paused", lock: "Link locked", "global-lock": "Uploads locked",
  };
  return labels[type] || String(type || "Activity").replace(/^(drop|share)-/, "").replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
}

function activityTimeRange(firstAt, lastAt) {
  const first = new Date(firstAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const last = new Date(lastAt || firstAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return first === last ? first : `${first}–${last}`;
}

export function makeCompactEventRow() {
  const row = document.createElement("div");
  row.className = "event-mini-row";
  return row;
}

export function updateCompactEventRow(row, event) {
  const actor = event.u || "anonymous";
  row.innerHTML = `<span class="activity-type-icon">${icon(eventTypeIcon(event.t))}</span><span><b>${esc(activityTypeLabel(event.t))}</b><small>${esc(actor)}${event.l || event.s ? ` · ${esc(event.l || event.s)}` : ""}</small></span><time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>`;
}

function eventKey(event) {
  return `${event.at}:${event.t}:${event.s}:${event.u}:${event.f}`;
}

export function eventTypeIcon(type) {
  if (type === "start") return "play";
  if (type === "file" || type === "share-view" || type === "share-browse" || type === "share-file-info" || type === "share-media_view_end") return "image";
  if (type === "open" || type === "share-open") return "eye";
  if (type === "share-dl") return "download";
  if (type?.startsWith("drop-upload")) return type.includes("error") ? "circle-alert" : "play";
  if (type === "lock" || type === "global-lock" || type === "autopause") return "lock";
  if (type === "sessionclose" || type === "clienterror") return "circle-alert";
  return "list";
}
export async function loadEarlierActivity() {
  if (activityLoading) return;
  setActivityLoading(true);
  $("activity-more").disabled = true;
  $("activity-more").textContent = "Loading…";
  $("activity-err").textContent = "";
  try {
    const response = await fetch(`/api/admin/events?before=${encodeURIComponent(activityOldestDay)}&days=3`);
    const data = await response.json().catch(() => ({ days: [] }));
    if (!response.ok) throw new Error(data.error || "Could not load earlier activity.");
    const incoming = (data.days || []).flatMap((day) => day.events || []);
    const known = new Set(activityOlder.map(eventKey));
    for (const event of incoming) if (!known.has(eventKey(event))) activityOlder.push(event);
    setActivityOldestDay(data.oldest || activityOldestDay);
    renderEvents();
  } catch (error) {
    $("activity-err").textContent = error.message;
  } finally {
    setActivityLoading(false);
    $("activity-more").disabled = false;
    $("activity-more").textContent = "Load earlier days";
  }
}
