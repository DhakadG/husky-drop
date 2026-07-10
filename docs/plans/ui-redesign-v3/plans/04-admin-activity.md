# Plan 04 — Admin Activity tab

**Files touched:** `public/admin.html`, `public/admin.js`, `public/style.css`.
**Depends on:** plan 00 (shared tokens/components), plan 03 (the one shared `/admin` shell), plan 09 changes 14–16 (older activity day buckets and `/api/admin/events`).
**New assets:** none. Every icon below is complete inline SVG returned by the existing `icon()` helper.

**Single-page constraint:** this plan changes only `#tab-activity` inside the existing `public/admin.html` and activity functions inside the existing `public/admin.js`. Do not create another HTML page, route, sidebar, or controller.

---

### Change 1: Replace the flat Activity pane with filters and grouped-day host
**File:** `public/admin.html`
**Why:** The mockup groups activity by day and upload/view session and provides type filters, search, and older-day pagination.
**Locate:**
```html
      <!-- ACTIVITY -->
      <section id="tab-activity" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">Activity</h1><span class="muted">opens, starts, files, locks and client errors - click a row for device details</span></div>
        <section class="panel">
          <div id="events" class="event-list tall"></div>
        </section>
      </section>
```
**Action:** REPLACE
**Old code:**
```html
      <!-- ACTIVITY -->
      <section id="tab-activity" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">Activity</h1><span class="muted">opens, starts, files, locks and client errors - click a row for device details</span></div>
        <section class="panel">
          <div id="events" class="event-list tall"></div>
        </section>
      </section>
```
**New code:**
```html
      <!-- ACTIVITY: one pane in the shared /admin shell -->
      <section id="tab-activity" class="tab-pane hidden">
        <div class="pane-head">
          <div>
            <p class="eyebrow">audit trail</p>
            <h1 class="pane-title grad-text">Activity</h1>
            <span class="muted">Every upload, open, view, download and error—grouped into human-readable sessions.</span>
          </div>
        </div>
        <section class="panel activity-panel">
          <div class="activity-toolbar" aria-label="Activity filters">
            <div class="activity-filters" id="activity-filters">
              <button class="chip-filter active" data-activity-filter="all" type="button">All</button>
              <button class="chip-filter" data-activity-filter="uploads" type="button">Uploads</button>
              <button class="chip-filter" data-activity-filter="opens" type="button">Opens</button>
              <button class="chip-filter" data-activity-filter="views" type="button">Views</button>
              <button class="chip-filter" data-activity-filter="downloads" type="button">Downloads</button>
              <button class="chip-filter danger" data-activity-filter="errors" type="button">Errors</button>
            </div>
            <label class="activity-search" for="activity-query">
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-3.5-3.5"></path></svg>
              <input id="activity-query" type="search" placeholder="Search person or link" autocomplete="off" />
            </label>
          </div>
          <div id="events" class="activity-days" aria-live="polite"></div>
          <button class="btn ghost activity-more" id="activity-more" type="button">Load earlier days</button>
          <div class="msg-err" id="activity-err"></div>
        </section>
      </section>
```
**Verify:** Activity remains a tab at `/admin`; it shows six filter chips, one search input, an empty grouped-day host, and a “Load earlier days” button. No second admin shell exists.

---

### Change 2: Add Activity view state
**File:** `public/admin.js`
**Why:** Filters, search text, expanded sessions, and pagination must survive a 15-second overview refresh.
**Locate:**
```js
let detailSearch = "";
let detailSort = "new";
const openSettings = new Set();

init();
```
**Action:** REPLACE
**Old code:**
```js
let detailSearch = "";
let detailSort = "new";
const openSettings = new Set();

init();
```
**New code:**
```js
let detailSearch = "";
let detailSort = "new";
const openSettings = new Set();
let activityFilter = "all";
let activityQuery = "";
let activityOlder = [];
let activityOldestDay = new Date().toISOString().slice(0, 10);
let activityLoading = false;
const openActivitySessions = new Set();

init();
```
**Verify:** Reloading `/admin` produces no `ReferenceError` in the console.

---

### Change 3: Wire filter, search, and pagination controls once in `init()`
**File:** `public/admin.js`
**Why:** Activity controls belong to the existing single admin controller and must not receive duplicate listeners on refresh.
**Locate:**
```js
  document.querySelectorAll("[data-metric]").forEach((b) => {
    b.addEventListener("click", () => {
      seriesMetric = b.dataset.metric;
      document.querySelectorAll("[data-metric]").forEach((x) => x.classList.toggle("active", x === b));
      renderChart();
    });
  });
  // A previous session cookie may still be valid.
```
**Action:** INSERT AFTER
**New code:**
```js
  document.querySelectorAll("[data-activity-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      activityFilter = button.dataset.activityFilter || "all";
      document.querySelectorAll("[data-activity-filter]").forEach((item) => item.classList.toggle("active", item === button));
      renderEvents();
    });
  });
  $("activity-query")?.addEventListener("input", (event) => {
    activityQuery = event.target.value;
    renderEvents();
  });
  $("activity-more")?.addEventListener("click", loadEarlierActivity);
```
**Verify:** Clicking a chip updates its active state; typing in search rerenders without a network request; the Load button calls only one handler per click.

---

### Change 4: Replace flat event rendering with day/session rendering and compact Overview rows
**File:** `public/admin.js`
**Why:** The Activity mockup needs expandable, person-first session cards while Overview must retain a compact recent-activity list.
**Locate:**
```js
function renderEvents() {
  const events = groupEventsForRender(overview?.events || []);
  const box = $("events");
  if (box) {
    reconcile(box, events, eventKey, makeEventRow, updateEventRow);
    setEmpty(box, events.length === 0, "No activity yet.");
  }
```
**Action:** REPLACE
**Old code:**
```js
function renderEvents() {
  const events = groupEventsForRender(overview?.events || []);
  const box = $("events");
  if (box) {
    reconcile(box, events, eventKey, makeEventRow, updateEventRow);
    setEmpty(box, events.length === 0, "No activity yet.");
  }
  const mini = $("events-mini");
  if (mini) {
    const top = events.slice(0, 8);
    reconcile(mini, top, (e) => `m:${eventKey(e)}`, makeEventRow, updateEventRow);
    setEmpty(mini, top.length === 0, "No activity yet.");
  }
}

function groupEventsForRender(events) {
  const groups = new Map();
  const rows = [];
  for (const e of events) {
    if (!e?.si) {
      rows.push(e);
      continue;
    }
    let group = groups.get(e.si);
    if (!group) {
      group = {
        ...e,
        t: "session",
        _session: true,
        _events: [],
        _firstAt: e.at,
        _lastAt: e.at,
      };
      groups.set(e.si, group);
      rows.push(group);
    }
    group._events.push(e);
    group._firstAt = Math.min(group._firstAt, e.at || group._firstAt);
    group._lastAt = Math.max(group._lastAt, e.at || group._lastAt);
  }
  return rows;
}

function eventKey(e) {
  if (e._session) return `session:${e.si}`;
  return `${e.at}:${e.t}:${e.s}:${e.u}:${e.f}`;
}

function makeEventRow() {
  const el = document.createElement("div");
  el.className = "event-row";
  return el;
}

function updateEventRow(el, e) {
  if (e._session) return updateSessionEventRow(el, e);
  el.classList.remove("session-row");
  const c = e.c || {};
  const hasDetails = c.o || c.l || e.m;

  if (hasDetails) {
    el.classList.add("expandable");
    el.onclick = () => el.classList.toggle("expanded");
  } else {
    el.classList.remove("expandable", "expanded");
    el.onclick = null;
  }

  const typeIcon = eventTypeIcon(e.t);

  el.innerHTML = `
    <code class="${escAttr(e.t)}">${icon(typeIcon)}${esc(e.t)}</code>
    <span>${esc(e.l || e.s || "")}${e.u ? " - " + esc(e.u) : ""}${e.f ? " - " + esc(e.f) : ""}</span>
    <time>${new Date(e.at).toLocaleString()}</time>
    ${
      hasDetails
        ? `
      <div class="event-row-details">
        ${e.m ? `<div class="detail-item">${icon("list")}${esc(e.m)}</div>` : ""}
        ${c.o ? `<div class="detail-item">${icon(c.i || "laptop")}${esc(c.o)}</div>` : ""}
        ${c.l ? `<div class="detail-item">${icon("globe")}${esc(c.l)}</div>` : ""}
      </div>
    `
        : ""
    }
  `;
}

function updateSessionEventRow(el, e) {
  const expanded = el.classList.contains("expanded");
  el.className = `event-row session-row expandable${expanded ? " expanded" : ""}`;
  el.onclick = () => el.classList.toggle("expanded");
  const items = e._events || [];
  const newest = items[0] || e;
  const oldest = items[items.length - 1] || e;
  const actor = newest.u || "anonymous";
  const place = newest.l || newest.s || "share";
  const files = new Set(items.map((item) => item.f).filter(Boolean)).size;
  const range =
    items.length > 1
      ? `${new Date(oldest.at).toLocaleTimeString()} - ${new Date(newest.at).toLocaleTimeString()}`
      : new Date(newest.at).toLocaleTimeString();
  const details = items
    .map((item) => {
      const label = [item.m, item.f].filter(Boolean).join(" - ") || item.t;
      return `<div class="detail-item">${icon(eventTypeIcon(item.t))}<span><b>${esc(item.t)}</b> ${esc(label)}</span><time>${new Date(item.at).toLocaleTimeString()}</time></div>`;
    })
    .join("");
  el.innerHTML = `
    <code class="session">${icon("list")}session</code>
    <span>${esc(items.length)} activity item${items.length === 1 ? "" : "s"} - ${esc(actor)}, ${esc(place)}${files ? ` - ${files} file${files === 1 ? "" : "s"}` : ""}</span>
    <time>${esc(range)}</time>
    <div class="event-row-details">${details}</div>
  `;
}

function eventTypeIcon(type) {
  if (type === "start") return "play";
  if (type === "file") return "file";
  if (type === "open" || type === "share-open" || type === "share-view" || type === "share-browse") return "eye";
  if (type === "share-dl") return "download";
  if (type === "lock" || type === "global-lock" || type === "autopause") return "lock";
  if (type === "sessionclose" || type === "clienterror") return "shield-alert";
  return "list";
}
```
**New code:**
```js
function renderEvents() {
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
  return [...days.entries()].map(([key, dayEvents]) => ({ key, sessions: groupActivitySessions(dayEvents) }));
}

function groupActivitySessions(events) {
  const sessions = new Map();
  for (const event of events) {
    const tenMinuteWindow = Math.floor((event.at || 0) / 600000);
    const key = event.si || `${event.u || "anonymous"}:${event.s || event.l || "system"}:${tenMinuteWindow}`;
    if (!sessions.has(key)) sessions.set(key, { key, events: [] });
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
  const prefix = day.key === today ? "Today" : day.key === yesterday ? "Yesterday" : date.toLocaleDateString(undefined, { weekday: "long" });
  section._label.textContent = `${prefix} · ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  section._count.textContent = `${day.sessions.length} session${day.sessions.length === 1 ? "" : "s"}`;
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
  const fileCount = new Set(events.map((event) => event.f).filter(Boolean)).size;
  const hasError = events.some((event) => ["clienterror", "autopause", "lock", "global-lock"].includes(event.t));
  const expanded = openActivitySessions.has(session.key);
  const counts = activityCounts(events);
  article.className = `activity-session glass-tile${expanded ? " expanded" : ""}${hasError ? " has-error" : ""}`;
  article.innerHTML = `
    <button class="activity-session-summary" type="button" aria-expanded="${expanded}">
      <span class="avatar">${esc(initialsOf(actor))}</span>
      <span class="activity-person"><b>${esc(actor)} <i>·</i> ${esc(place)}</b><small>${esc(context.o || "Unknown device")}${context.l ? ` · ${esc(context.l)}` : ""} · ${activityTimeRange(first.at, last.at)}</small></span>
      <span class="activity-counts">${counts}${fileCount ? `<em>${fileCount} file${fileCount === 1 ? "" : "s"}</em>` : ""}</span>
      <svg class="activity-chevron" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
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
  const uploads = events.filter((event) => event.t === "file").length;
  const opens = events.filter((event) => event.t === "open" || event.t === "share-open").length;
  const views = events.filter((event) => event.t === "share-view" || event.t === "share-browse").length;
  const downloads = events.filter((event) => event.t === "share-dl").length;
  if (uploads) labels.push(`<em>${uploads} upload${uploads === 1 ? "" : "s"}</em>`);
  if (opens) labels.push(`<em>${opens} open${opens === 1 ? "" : "s"}</em>`);
  if (views) labels.push(`<em>${views} view${views === 1 ? "" : "s"}</em>`);
  if (downloads) labels.push(`<em>${downloads} download${downloads === 1 ? "" : "s"}</em>`);
  return labels.join("");
}

function activityTimelineRow(event) {
  const label = event.f || event.m || activityTypeLabel(event.t);
  const meta = [event.t, event.s ? `/d/${event.s}` : "", event.m === "first open" ? "first open of this share" : ""].filter(Boolean).join(" · ");
  return `<div class="activity-timeline-row ${escAttr(event.t || "event")}"><span class="activity-type-icon">${icon(eventTypeIcon(event.t))}</span><span><b>${esc(label)}</b><small>${esc(meta)}</small></span><time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>`;
}

function activityTypeLabel(type) {
  const labels = { open: "Opened drop link", start: "Started upload", file: "Uploaded file", sessionclose: "Session finished", "share-open": "Opened share", "share-view": "Viewed file", "share-browse": "Browsed gallery", "share-dl": "Downloaded file", clienterror: "Client error", autopause: "Link auto-paused", lock: "Link locked", "global-lock": "Uploads locked" };
  return labels[type] || "Activity";
}

function activityTimeRange(firstAt, lastAt) {
  const first = new Date(firstAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const last = new Date(lastAt || firstAt || Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return first === last ? first : `${first}–${last}`;
}

function makeCompactEventRow() {
  const row = document.createElement("div");
  row.className = "event-mini-row";
  return row;
}

function updateCompactEventRow(row, event) {
  const actor = event.u || "anonymous";
  row.innerHTML = `<span class="activity-type-icon">${icon(eventTypeIcon(event.t))}</span><span><b>${esc(actor)}</b><small>${esc(activityTypeLabel(event.t))}${event.l || event.s ? ` · ${esc(event.l || event.s)}` : ""}</small></span><time>${new Date(event.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>`;
}

function eventKey(event) {
  return `${event.at}:${event.t}:${event.s}:${event.u}:${event.f}`;
}

function eventTypeIcon(type) {
  if (type === "start") return "play";
  if (type === "file") return "file";
  if (type === "open" || type === "share-open" || type === "share-view" || type === "share-browse") return "eye";
  if (type === "share-dl") return "download";
  if (type === "lock" || type === "global-lock" || type === "autopause") return "lock";
  if (type === "sessionclose" || type === "clienterror") return "shield-alert";
  return "list";
}
```
**Verify:** Activity shows day dividers and expandable session cards; the Overview recent-activity card remains compact and does not inherit the full session-card layout.

---

### Change 5: Add the older-days fetch handler
**File:** `public/admin.js`
**Why:** “Load earlier days” must consume plan 09’s real endpoint instead of inventing older rows client-side.
**Locate:**
```js
function eventTypeIcon(type) {
  if (type === "start") return "play";
  if (type === "file") return "file";
  if (type === "open" || type === "share-open" || type === "share-view" || type === "share-browse") return "eye";
  if (type === "share-dl") return "download";
  if (type === "lock" || type === "global-lock" || type === "autopause") return "lock";
  if (type === "sessionclose" || type === "clienterror") return "shield-alert";
  return "list";
}
```
**Action:** INSERT AFTER
**New code:**
```js
async function loadEarlierActivity() {
  if (activityLoading) return;
  activityLoading = true;
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
    activityOldestDay = data.oldest || activityOldestDay;
    renderEvents();
  } catch (error) {
    $("activity-err").textContent = error.message;
  } finally {
    activityLoading = false;
    $("activity-more").disabled = false;
    $("activity-more").textContent = "Load earlier days";
  }
}
```
**Verify:** Clicking Load earlier sends `GET /api/admin/events?before=<YYYY-MM-DD>&days=3`, appends returned events, advances `before` using `oldest`, and shows a real error message on failure.

---

### Change 6: Add Activity mockup styling and mobile stacked cards
**File:** `public/style.css`
**Why:** Implement the day pills, glass session cards, gradient timeline spine, type chips, error treatment, and mobile layout shown by `Admin Activity.dc.html`.
**Locate:**
```css
.live-mini-pct {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--accent);
}
.bar.slim {
  height: 7px;
}
```
**Action:** INSERT AFTER
**New code:**
```css

/* ---------- Admin Activity v3 ---------- */
.activity-panel {
  padding: 22px;
}
.activity-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 22px;
}
.activity-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
}
.chip-filter.danger {
  color: var(--red);
  border-color: rgba(240, 85, 107, 0.22);
}
.chip-filter.danger.active {
  color: #fff;
  border-color: transparent;
  background: linear-gradient(120deg, #f0556b, #d98a14);
}
.activity-search {
  min-width: 245px;
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid rgba(12, 26, 43, 0.1);
  border-radius: 999px;
  padding: 8px 13px;
  color: var(--muted);
  background: rgba(255, 255, 255, 0.72);
}
.activity-search:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px rgba(47, 107, 255, 0.12);
}
.activity-search input {
  width: 100%;
  border: 0;
  outline: 0;
  padding: 0;
  background: transparent;
}
.activity-days,
.activity-session-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.activity-day + .activity-day {
  margin-top: 14px;
}
.activity-day-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.activity-day-head::after {
  content: "";
  height: 1px;
  flex: 1;
  background: linear-gradient(90deg, rgba(47, 107, 255, 0.2), transparent);
}
.activity-day-head span,
.activity-day-head b {
  border-radius: 999px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
}
.activity-day-head span {
  color: var(--accent);
  padding: 6px 10px;
  background: rgba(47, 107, 255, 0.08);
}
.activity-day-head b {
  color: var(--muted);
  font-weight: 500;
}
.activity-session {
  overflow: hidden;
  border-radius: 18px;
  transition: border-color 0.16s ease, box-shadow 0.16s ease;
}
.activity-session:hover,
.activity-session.expanded {
  border-color: rgba(47, 107, 255, 0.25);
  box-shadow: 0 20px 44px -32px rgba(47, 107, 255, 0.6);
}
.activity-session.has-error {
  border-color: rgba(240, 85, 107, 0.3);
}
.activity-session-summary {
  width: 100%;
  display: grid;
  grid-template-columns: auto minmax(180px, 1fr) auto auto;
  align-items: center;
  gap: 12px;
  border: 0;
  padding: 15px 16px;
  color: var(--ink);
  text-align: left;
  background: transparent;
  cursor: pointer;
}
.activity-person {
  min-width: 0;
}
.activity-person b,
.activity-person small,
.activity-timeline-row b,
.activity-timeline-row small,
.event-mini-row b,
.event-mini-row small {
  display: block;
}
.activity-person b {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
}
.activity-person i {
  color: var(--accent);
  font-style: normal;
}
.activity-person small,
.activity-timeline-row small,
.event-mini-row small {
  margin-top: 3px;
  color: var(--muted);
  font: 11px var(--font-mono);
}
.activity-counts {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 5px;
}
.activity-counts em {
  border-radius: 999px;
  padding: 4px 7px;
  color: var(--ink-soft);
  font: normal 10px var(--font-mono);
  background: rgba(12, 26, 43, 0.055);
}
.activity-chevron {
  color: var(--muted);
  transition: transform 0.18s ease;
}
.activity-session.expanded .activity-chevron {
  transform: rotate(180deg);
}
.activity-timeline {
  display: none;
  position: relative;
  margin: 0 16px 16px 36px;
  padding: 2px 0 2px 26px;
}
.activity-session.expanded .activity-timeline {
  display: block;
}
.activity-timeline::before {
  content: "";
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 9px;
  width: 2px;
  border-radius: 2px;
  background: var(--grad);
}
.activity-timeline-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 42px;
}
.activity-type-icon {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 9px;
  color: var(--accent);
  background: rgba(47, 107, 255, 0.1);
}
.activity-timeline-row.clienterror .activity-type-icon,
.activity-timeline-row.autopause .activity-type-icon {
  color: var(--red);
  background: rgba(240, 85, 107, 0.1);
}
.activity-timeline-row time,
.event-mini-row time {
  color: var(--muted);
  font: 10.5px var(--font-mono);
}
.event-mini-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 9px 0;
  border-bottom: 1px solid rgba(12, 26, 43, 0.06);
}
.event-mini-row:last-child {
  border-bottom: 0;
}
.activity-more {
  display: flex;
  margin: 22px auto 0;
}

@media (max-width: 760px) {
  .activity-toolbar {
    align-items: stretch;
    flex-direction: column;
  }
  .activity-search {
    min-width: 0;
  }
  .activity-session-summary {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .activity-counts {
    grid-column: 2 / -1;
    justify-content: flex-start;
  }
  .activity-timeline {
    margin-left: 18px;
    padding-left: 20px;
  }
  .activity-timeline-row {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .activity-timeline-row time {
    grid-column: 2;
  }
}
```
**Verify:** Desktop matches the mockup’s day-grouped glass timeline; error sessions have a red edge; at ≤760px every session is a stacked card and no content overflows horizontally.

---

## Placeholder data
Mockup names, counts, files, device strings, and locations are examples only. This plan renders real `overview.events` fields and older `GET /api/admin/events` results. Session grouping uses the real `si` field when present; older events without `si` are grouped by uploader + link + ten-minute window. The “first open” label is real only after plan 09 change 11 emits `m: "first open"`.

## Responsive
Change 6 owns only Activity-specific stacking. Plan 03 owns the one shared sidebar-to-bottom-tab-bar conversion and must not be repeated here.
