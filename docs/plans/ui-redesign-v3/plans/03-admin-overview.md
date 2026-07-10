# Plan 03 — Admin shell + Overview + Live transfers tabs

**Files touched:** `public/admin.html`, `public/admin.js`, `public/style.css`.
**Depends on:** plan 00. Plans 04–07 depend on THIS plan for the shared admin shell.
**New assets:** none.
**Mockup:** `Admin Overview.dc.html` (+ sidebar spec used by all admin mockups).

**Single-page admin rule:** `/admin` is one page; the mockups' five admin "pages" are tab panes switched by `showTab()` (`admin.js`). This plan performs the ONE-TIME shell change (background layer, sidebar with icons/gradient active state/live badge, restyled `.mini` pill buttons, mobile bottom tab bar). **Plans 04–07 must not add or repeat any shell markup or shell CSS — they only touch their own `#tab-*` pane and render functions**, referencing the shell by the selectors established here (`.admin-side`, `.tab[data-tab=…]`, `.pane-head`, `.pane-title`).

Data note: every number in the mockup (4 links, 42 opens, 68.1 GB, GC/Riya live rows, busiest day Jul 9…) is placeholder; the pane is already wired to real data (`GET /api/admin/overview`, `GET /api/admin/timeseries?days=30`, admin WebSocket) — this plan only restyles what those render.

---

### Change 1: canonical fonts link
**File:** `public/admin.html`
**Why:** Same font standardization as plan 01.
**Locate:**
```html
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet" />
<link rel="stylesheet" href="/style.css" />
</head>
<body class="admin-page">
<main class="admin-shell">
```
**Action:** REPLACE
**Old code:**
```html
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@500;600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet" />
```
**New code:**
```html
<link href="https://fonts.googleapis.com/css2?family=Unbounded:wght@600;700;800&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Spline+Sans+Mono:wght@400;500&display=swap" rel="stylesheet" />
```
**Verify:** Fonts load.

### Change 2: background FX layer
**File:** `public/admin.html`
**Why:** Dot grid + noise + violet blob behind the whole admin page (unlock screen included).
**Locate:**
```html
<link rel="stylesheet" href="/style.css" />
</head>
<body class="admin-page">
<main class="admin-shell">
  <section id="auth" class="panel center-panel">
    <p class="eyebrow">admin</p>
    <h1>Unlock dashboard</h1>
```
**Action:** REPLACE
**Old code:**
```html
<body class="admin-page">
<main class="admin-shell">
```
**New code:**
```html
<body class="admin-page">
<div class="bg-fx" aria-hidden="true"></div>
<main class="admin-shell">
```
**Verify:** Dot grid fading from the top + faint noise visible behind the admin UI.

### Change 3: sidebar markup (icons, badge, dashed create CTA, lock button)
**File:** `public/admin.html`
**Why:** The mockup sidebar — same `data-tab` buttons so `showTab()`/`init()` wiring is untouched. All ids preserved (`live-badge`, `live-state`, `logout`, `detail-tab`).
**Locate:**
```html

  <div id="panel" class="admin-layout hidden">
    <aside class="admin-side">
      <a class="brand" href="/"><i class="brand-mark"></i>losthusky<span>/</span>drop</a>
      <nav class="side-nav" aria-label="dashboard sections">
        <button class="tab active" data-tab="overview" type="button">Overview</button>
        <button class="tab" data-tab="live" type="button">Live transfers <span class="nav-badge hidden" id="live-badge">0</span></button>
```
**Action:** REPLACE
**Old code:**
```html
    <aside class="admin-side">
      <a class="brand" href="/"><i class="brand-mark"></i>losthusky<span>/</span>drop</a>
      <nav class="side-nav" aria-label="dashboard sections">
        <button class="tab active" data-tab="overview" type="button">Overview</button>
        <button class="tab" data-tab="live" type="button">Live transfers <span class="nav-badge hidden" id="live-badge">0</span></button>
        <button class="tab" data-tab="links" type="button">Drop links</button>
        <button class="tab" data-tab="shares" type="button">Share links</button>
        <button class="tab" data-tab="activity" type="button">Activity</button>
        <button class="tab" data-tab="create" type="button">+ New drop link</button>
        <button class="tab hidden" data-tab="detail" id="detail-tab" type="button">Link detail</button>
      </nav>
      <div class="side-foot">
        <div class="status-pill" id="live-state">offline</div>
        <button class="mini logout" id="logout" type="button">lock</button>
      </div>
    </aside>
```
**New code:**
```html
    <aside class="admin-side">
      <a class="brand side-brand" href="/"><i class="brand-mark"></i><span>losthusky <span class="brand-slash">/</span> drop</span></a>
      <nav class="side-nav" aria-label="dashboard sections">
        <button class="tab active" data-tab="overview" type="button">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="2.5"></rect><rect x="13" y="3" width="8" height="8" rx="2.5" opacity="0.55"></rect><rect x="3" y="13" width="8" height="8" rx="2.5" opacity="0.55"></rect><rect x="13" y="13" width="8" height="8" rx="2.5"></rect></svg>
          <span class="tab-label">Overview</span>
        </button>
        <button class="tab" data-tab="live" type="button">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="10" opacity="0.16"></circle><path d="M13 2L4.5 13.5H11l-1 8.5L18.5 10H12l1-8z"></path></svg>
          <span class="tab-label">Live transfers</span>
          <span class="nav-badge hidden" id="live-badge">0</span>
        </button>
        <button class="tab" data-tab="links" type="button">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M4 15a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-2a1 1 0 1 1 2 0v2a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-2a1 1 0 0 1 1-1z"></path><path d="M12 3a1 1 0 0 1 .7.3l4.5 4.5a1 1 0 0 1-1.4 1.4L13 6.4V15a1 1 0 1 1-2 0V6.4L8.2 9.2a1 1 0 0 1-1.4-1.4l4.5-4.5A1 1 0 0 1 12 3z" opacity="0.55" transform="rotate(180 12 9)"></path></svg>
          <span class="tab-label">Drop links</span>
        </button>
        <button class="tab" data-tab="shares" type="button">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="6" r="3" opacity="0.55"></circle><circle cx="18" cy="18" r="3" opacity="0.55"></circle><path d="M8.6 10.8l6.8-3.6M8.6 13.2l6.8 3.6" stroke="currentColor" stroke-width="1.8" fill="none"></path></svg>
          <span class="tab-label">Share links</span>
        </button>
        <button class="tab" data-tab="activity" type="button">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2.5-6 4 12 2.5-6h5"></path></svg>
          <span class="tab-label">Activity</span>
        </button>
        <div class="side-divider" role="presentation"></div>
        <button class="tab tab-create" data-tab="create" type="button">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><path d="M12 4a1 1 0 0 1 1 1v6h6a1 1 0 1 1 0 2h-6v6a1 1 0 1 1-2 0v-6H5a1 1 0 1 1 0-2h6V5a1 1 0 0 1 1-1z"></path></svg>
          <span class="tab-label">New drop link</span>
        </button>
        <button class="tab hidden" data-tab="detail" id="detail-tab" type="button">Link detail</button>
      </nav>
      <div class="side-foot">
        <div class="status-pill" id="live-state">offline</div>
        <button class="mini logout" id="logout" type="button">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="10" width="14" height="10" rx="2.5" opacity="0.3"></rect><path d="M7 10V8a5 5 0 0 1 10 0v2h-2V8a3 3 0 0 0-6 0v2H7zm-2 2h14v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z"></path></svg>
          lock
        </button>
      </div>
    </aside>
```
**Verify:** All tabs still switch panes; live badge appears with count during an upload; logout locks; the hidden detail tab still appears when opening a link detail.

### Change 4: overview pane head + chart tools markup
**File:** `public/admin.html`
**Why:** Gradient page title; metric toggles become filter chips (`chip-filter` from plan 00) while keeping `data-metric` hooks; "Live now" gets the pulsing dot.
**Locate:**
```html
    <div class="admin-content">
      <!-- OVERVIEW: the at-a-glance page -->
      <section id="tab-overview" class="tab-pane">
        <div class="pane-head"><h1 class="pane-title">Overview</h1><span class="muted">totals, trends and what is happening right now</span></div>
        <div class="stat-grid" id="stats"></div>
        <section class="panel">
          <div class="section-title">
            <h2>Last 30 days</h2>
            <div class="section-tools">
              <button class="mini active" data-metric="bytes" type="button">bytes</button>
              <button class="mini" data-metric="files" type="button">files</button>
              <button class="mini" data-metric="opens" type="button">opens</button>
```
**Action:** REPLACE
**Old code:**
```html
      <section id="tab-overview" class="tab-pane">
        <div class="pane-head"><h1 class="pane-title">Overview</h1><span class="muted">totals, trends and what is happening right now</span></div>
        <div class="stat-grid" id="stats"></div>
        <section class="panel">
          <div class="section-title">
            <h2>Last 30 days</h2>
            <div class="section-tools">
              <button class="mini active" data-metric="bytes" type="button">bytes</button>
              <button class="mini" data-metric="files" type="button">files</button>
              <button class="mini" data-metric="opens" type="button">opens</button>
              <button class="mini" data-metric="sessions" type="button">sessions</button>
              <button class="mini" data-metric="downloads" type="button">downloads</button>
            </div>
          </div>
          <div id="chart" class="chart-host"></div>
        </section>
        <div class="dashboard-grid">
          <section class="panel">
            <div class="section-title">
              <h2>Live now</h2>
```
**New code:**
```html
      <section id="tab-overview" class="tab-pane">
        <div class="pane-head"><h1 class="pane-title grad-text">Overview</h1><span class="muted">totals, trends and what is happening right now</span></div>
        <div class="stat-grid" id="stats"></div>
        <section class="panel">
          <div class="section-title">
            <h2>Last 30 days</h2>
            <div class="section-tools">
              <button class="chip-filter active" data-metric="bytes" type="button">bytes</button>
              <button class="chip-filter" data-metric="files" type="button">files</button>
              <button class="chip-filter" data-metric="opens" type="button">opens</button>
              <button class="chip-filter" data-metric="sessions" type="button">sessions</button>
              <button class="chip-filter" data-metric="downloads" type="button">downloads</button>
            </div>
          </div>
          <div id="chart" class="chart-host"></div>
        </section>
        <div class="dashboard-grid">
          <section class="panel">
            <div class="section-title">
              <h2><span class="live-dot" aria-hidden="true"></span>Live now</h2>
```
**Verify:** Metric chips still switch the chart (the `data-metric` listener in `init()` targets `[data-metric]`, not the class); active chip renders as a gradient pill.

### Change 5: stat cards with icon tiles + accent "received" card
**File:** `public/admin.js`
**Why:** The mockup's stat cards carry a tinted duotone icon, Unbounded number, mono uppercase label; the bytes card is the gradient-accented one.
**Locate:**
```js
function renderStats() {
  const t = overview?.totals || {};
  const q = overview?.quota;
  const cards = [
    ["Links", t.links || 0],
    ["Opens", t.opens || 0],
    ["Sessions", t.sessions || 0],
    ["Files", t.files || 0],
    ["Received", fmtBytes(t.bytes || 0)],
  ];
  if (q && q.free != null) cards.push(["Drive free", fmtBytes(q.free)]);
  upsertCards($("stats"), cards, "stat-card");
}
```
**Action:** REPLACE
**Old code:**
```js
function renderStats() {
  const t = overview?.totals || {};
  const q = overview?.quota;
  const cards = [
    ["Links", t.links || 0],
    ["Opens", t.opens || 0],
    ["Sessions", t.sessions || 0],
    ["Files", t.files || 0],
    ["Received", fmtBytes(t.bytes || 0)],
  ];
  if (q && q.free != null) cards.push(["Drive free", fmtBytes(q.free)]);
  upsertCards($("stats"), cards, "stat-card");
}
```
**New code:**
```js
const STAT_ICONS = {
  links: ['rgba(47,107,255,0.12)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#2f6bff"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l2.8-2.8a3 3 0 0 1 4.2 4.2l-2 2a1 1 0 1 1-1.4-1.4l2-2a1 1 0 0 0-1.4-1.4l-2.8 2.8a1 1 0 0 1-1.4 0z"></path><path d="M13.4 10.6a1 1 0 0 1 0 1.4l-2.8 2.8a3 3 0 0 1-4.2-4.2l2-2a1 1 0 0 1 1.4 1.4l-2 2a1 1 0 1 0 1.4 1.4l2.8-2.8a1 1 0 0 1 1.4 0z" opacity="0.55"></path></svg>'],
  opens: ['rgba(21,192,201,0.14)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#0e9aa7"><path d="M12 5c5 0 8.6 3.6 10 7-1.4 3.4-5 7-10 7S3.4 15.4 2 12c1.4-3.4 5-7 10-7z" opacity="0.2"></path><path d="M12 7c3.9 0 6.8 2.6 8 5-1.2 2.4-4.1 5-8 5s-6.8-2.6-8-5c1.2-2.4 4.1-5 8-5zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"></path></svg>'],
  sessions: ['rgba(123,107,255,0.14)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#7b6bff"><circle cx="9" cy="8" r="3.4"></circle><path d="M9 13c3.6 0 6.5 1.9 6.5 4.2V19H2.5v-1.8C2.5 14.9 5.4 13 9 13z" opacity="0.55"></path><circle cx="17" cy="9" r="2.6" opacity="0.55"></circle><path d="M17 13.2c2.6 0 4.5 1.4 4.5 3.1V18h-4"></path></svg>'],
  files: ['rgba(47,107,255,0.12)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#2f6bff"><path d="M6 3h8l5 5v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z" opacity="0.2"></path><path d="M6.5 4h7l4.5 4.5V20h-11.5V4zM13 5.5V9h3.5L13 5.5z"></path></svg>'],
  received: ['', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#ffffff"><path d="M12 3a1 1 0 0 1 1 1v9.6l2.8-2.8a1 1 0 0 1 1.4 1.4l-4.5 4.5a1 1 0 0 1-1.4 0L6.8 12.2a1 1 0 1 1 1.4-1.4L11 13.6V4a1 1 0 0 1 1-1z"></path><path d="M4 17a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1a1 1 0 0 1 1-1z" opacity="0.7"></path></svg>'],
  "drive free": ['rgba(31,178,122,0.14)', '<svg width="16" height="16" viewBox="0 0 24 24" fill="#1fb27a"><ellipse cx="12" cy="6" rx="8" ry="3" opacity="0.55"></ellipse><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6c0 1.7-3.6 3-8 3S4 7.7 4 6zm16 6c0 1.7-3.6 3-8 3s-8-1.3-8-3"></path></svg>'],
};

function renderStats() {
  const t = overview?.totals || {};
  const q = overview?.quota;
  const cards = [
    ["links", t.links || 0],
    ["opens", t.opens || 0],
    ["sessions", t.sessions || 0],
    ["files", (t.files || 0).toLocaleString()],
    ["received", fmtBytes(t.bytes || 0)],
  ];
  if (q && q.free != null) cards.push(["drive free", fmtBytes(q.free)]);
  reconcile(
    $("stats"),
    cards,
    ([label]) => label,
    ([label]) => {
      const el = document.createElement("div");
      el.className = `stat-card v3${label === "received" ? " accent" : ""}`;
      const [tint, svg] = STAT_ICONS[label] || STAT_ICONS.links;
      el.innerHTML = `<span class="stat-ico"${tint ? ` style="background:${tint}"` : ""}>${svg}</span><div><b></b><span></span></div>`;
      el._value = el.querySelector("b");
      el._label = el.querySelector("div > span");
      return el;
    },
    (el, [label, value]) => {
      if (el._label.textContent !== label) el._label.textContent = label;
      const text = String(value);
      if (el._value.textContent !== text) el._value.textContent = text;
    },
  );
}
```
**Verify:** Overview shows 5–6 icon stat cards; the "received" card is gradient-tinted with a gradient number; values update on refresh.

### Change 6: chart — gradient bars + busiest-day note
**File:** `public/admin.js`
**Why:** Mockup bars use a vertical blue gradient with the peak bar in full gradient + tooltip; the subtitle names the busiest day.
**Locate:**
```js
  const totalLabel = seriesMetric === "bytes" ? fmtBytes(total) : total;
  const note = total ? `${totalLabel} ${seriesMetric} in the last 30 days` : `No ${seriesMetric} in the last 30 days yet - the chart fills in as activity happens.`;
  const labels = [points[0], points[10], points[20], points[29]].map((p) => `<span>${esc(p.day.slice(5))}</span>`).join("");
  host.innerHTML = `
    <div class="chart-note muted">${esc(note)}</div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="30 day ${escAttr(seriesMetric)}">${bars}</svg>
    <div class="chart-labels">${labels}</div>`;
```
**Action:** REPLACE
**Old code:**
```js
  const totalLabel = seriesMetric === "bytes" ? fmtBytes(total) : total;
  const note = total ? `${totalLabel} ${seriesMetric} in the last 30 days` : `No ${seriesMetric} in the last 30 days yet - the chart fills in as activity happens.`;
  const labels = [points[0], points[10], points[20], points[29]].map((p) => `<span>${esc(p.day.slice(5))}</span>`).join("");
  host.innerHTML = `
    <div class="chart-note muted">${esc(note)}</div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="30 day ${escAttr(seriesMetric)}">${bars}</svg>
    <div class="chart-labels">${labels}</div>`;
```
**New code:**
```js
  const totalLabel = seriesMetric === "bytes" ? fmtBytes(total) : total;
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a), points[0]);
  const peakLabel = seriesMetric === "bytes" ? fmtBytes(peak.v) : peak.v;
  const busiest = total && peak.v ? ` · busiest day ${peak.day.slice(5)} (${peakLabel})` : "";
  const note = total ? `${totalLabel} ${seriesMetric} in the last 30 days${busiest}` : `No ${seriesMetric} in the last 30 days yet - the chart fills in as activity happens.`;
  const labels = [points[0], points[10], points[20], points[29]].map((p) => `<span>${esc(p.day.slice(5))}</span>`).join("");
  host.innerHTML = `
    <div class="chart-note muted">${esc(note)}</div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="30 day ${escAttr(seriesMetric)}">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7aa4ff"/><stop offset="1" stop-color="#2f6bff"/></linearGradient>
        <linearGradient id="barGradPeak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6bff"/><stop offset="1" stop-color="#15c0c9"/></linearGradient>
      </defs>${bars}</svg>
    <div class="chart-labels">${labels}</div>`;
```
Additionally, in the same function, the bar-emitting loop must mark the peak. **Locate:**
```js
  points.forEach((p, i) => {
    const x = pad + i * step;
    const bh = Math.max(p.v > 0 ? 3 : 1.5, ((h - 6) * p.v) / max);
    const label = seriesMetric === "bytes" ? fmtBytes(p.v) : p.v;
    bars += `<rect class="${p.v ? "" : "zero"}" x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${esc(p.day)}: ${esc(String(label))}</title></rect>`;
  });
```
**Action:** REPLACE
**New code:**
```js
  const maxV = Math.max(...points.map((p) => p.v));
  points.forEach((p, i) => {
    const x = pad + i * step;
    const bh = Math.max(p.v > 0 ? 3 : 1.5, ((h - 6) * p.v) / max);
    const label = seriesMetric === "bytes" ? fmtBytes(p.v) : p.v;
    const cls = !p.v ? "zero" : p.v === maxV ? "peak" : "";
    bars += `<rect class="${cls}" x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${esc(p.day)}: ${esc(String(label))}</title></rect>`;
  });
```
**Verify:** Chart bars render blue-gradient; the tallest bar is full blue→teal; the note reads like "54.3 GB bytes in the last 30 days · busiest day 07-09 (54.1 GB)".

### Change 7: compact avatar rows for the overview "Live now" card
**File:** `public/admin.js`
**Why:** The overview mini list shows avatar + "Name — uploading to Label" + mono meta + % + slim bar (the big `live-row` cards stay for the Live tab).
**Locate:**
```js
  const mini = $("live-mini");
  if (mini) {
    const top = liveActive.slice(0, 3);
    reconcile(mini, top, (s) => `m:${s.id}`, makeLiveRow, updateLiveRow);
    setEmpty(mini, top.length === 0, "No active uploads right now.");
    if (mini._more) mini._more.remove();
    if (liveActive.length > top.length) {
```
**Action:** REPLACE
**Old code:**
```js
  const mini = $("live-mini");
  if (mini) {
    const top = liveActive.slice(0, 3);
    reconcile(mini, top, (s) => `m:${s.id}`, makeLiveRow, updateLiveRow);
```
**New code:**
```js
  const mini = $("live-mini");
  if (mini) {
    const top = liveActive.slice(0, 3);
    reconcile(mini, top, (s) => `m:${s.id}`, makeMiniLiveRow, updateMiniLiveRow);
```
And add the two new functions. **Locate:**
```js
function makeLiveRow() {
  const el = document.createElement("article");
  el.className = "live-row";
  return el;
}
```
**Action:** INSERT BEFORE
**New code:**
```js
function initialsOf(name) {
  const parts = String(name || "?").trim().split(/\s+/);
  return ((parts[0]?.[0] || "?") + (parts[1]?.[0] || "")).toUpperCase();
}

function makeMiniLiveRow() {
  const el = document.createElement("div");
  el.className = "live-mini-row glass-tile";
  return el;
}

function updateMiniLiveRow(el, s) {
  el.classList.toggle("hot", s.state === "uploading");
  el.innerHTML = `
    <div class="live-mini-head">
      <span class="avatar">${esc(initialsOf(s.uploader))}</span>
      <div class="live-mini-copy">
        <div class="live-mini-title">${esc(s.uploader || "anonymous")} — uploading to <a href="#" data-open-detail="${escAttr(s.slug)}">${esc(s.label || s.slug)}</a></div>
        <div class="live-mini-meta">${s.done || 0} of ${s.count || 0} files${s.speed ? ` · ${fmtBytes(s.speed)}/s` : ""}${s.eta ? ` · ~${fmtTime(s.eta)} left` : ""}${s.paused ? " · paused" : ""}</div>
      </div>
      <span class="live-mini-pct">${s.pct || 0}%</span>
    </div>
    <div class="bar slim"><i style="width:${s.pct || 0}%"></i></div>`;
}
```
**Verify:** During an upload the overview "Live now" card shows compact avatar rows with a working link to the link detail; the Live transfers tab still shows the full cards.

### Change 8: shell + overview v3 styles
**File:** `public/style.css`
**Why:** Sidebar restyle (gradient active tab, badge, dashed create), gradient page titles, v3 stat cards, chart chip/gradient styling, mini live rows, pill `.mini` buttons, and the **mobile bottom tab bar** used by every admin tab.
**Locate:**
```css
.auth-back {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted);
  text-decoration: none;
}
.auth-back:hover {
  color: var(--accent);
}
```
**Action:** INSERT AFTER
**New code:**
```css

/* ---------- Admin shell v3 ---------- */
.admin-side {
  border-radius: 24px;
  border: 1px solid var(--glass-border);
  background: var(--glass);
  backdrop-filter: blur(14px);
  box-shadow: var(--shadow-card);
  padding: 20px 16px;
}
.side-brand {
  font-size: 14.5px;
  padding: 2px 4px;
}
.side-brand .brand-mark {
  width: 34px;
  height: 34px;
  border-radius: 12px;
}
.side-brand .brand-mark::after {
  width: 13px;
  height: 13px;
}
.side-nav {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.admin-side .tab {
  display: flex;
  align-items: center;
  gap: 11px;
  border: 0;
  border-radius: 13px;
  padding: 11px 13px;
  font: 600 14px var(--font-body);
  color: var(--ink-soft);
  background: transparent;
  cursor: pointer;
  text-align: left;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}
.admin-side .tab:hover {
  background: rgba(47, 107, 255, 0.08);
  color: var(--accent);
}
.admin-side .tab.active {
  font-weight: 700;
  color: #fff;
  background: var(--grad);
  box-shadow: 0 12px 26px -12px rgba(47, 107, 255, 0.7);
}
.admin-side .tab svg {
  flex: 0 0 auto;
}
.nav-badge {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: #fff;
  background: var(--grad);
  border-radius: 99px;
  padding: 2px 8px;
}
.admin-side .tab.active .nav-badge {
  background: rgba(255, 255, 255, 0.25);
}
.side-divider {
  height: 1px;
  background: rgba(12, 26, 43, 0.08);
  margin: 8px 4px;
}
.admin-side .tab.tab-create {
  justify-content: center;
  font: 700 13.5px var(--font-body);
  color: var(--accent);
  border: 1.5px dashed rgba(47, 107, 255, 0.45);
  background: rgba(47, 107, 255, 0.05);
  padding: 12px 13px;
}
.admin-side .tab.tab-create:hover {
  background: rgba(47, 107, 255, 0.12);
}
.admin-side .tab.tab-create.active {
  color: #fff;
  border-style: solid;
  border-color: transparent;
  background: var(--grad);
}
.logout {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.logout:hover {
  border-color: var(--red);
  color: var(--red);
}
.pane-title.grad-text {
  background: var(--grad-text);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}
.live-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 99px;
  background: var(--green);
  margin-right: 9px;
  animation: pulseDot 1.8s ease-in-out infinite;
}

/* pill mono buttons (open live view / see all / refresh / row actions) */
.mini {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
  border: 1px solid rgba(47, 107, 255, 0.3);
  border-radius: 999px;
  padding: 7px 12px;
  background: rgba(47, 107, 255, 0.06);
  cursor: pointer;
}
.mini:hover {
  background: rgba(47, 107, 255, 0.14);
}
.mini.danger {
  color: var(--red);
  border-color: rgba(240, 85, 107, 0.3);
  background: rgba(240, 85, 107, 0.05);
}
.mini.danger:hover {
  background: rgba(240, 85, 107, 0.12);
}

/* ---------- Stat cards v3 ---------- */
.stat-card.v3 {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 20px;
}
.stat-card.v3 .stat-ico {
  width: 34px;
  height: 34px;
  border-radius: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.stat-card.v3 b {
  display: block;
  font-family: var(--font-display);
  font-size: 26px;
  font-weight: 800;
  letter-spacing: -0.03em;
}
.stat-card.v3 div > span {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.stat-card.v3.accent {
  border-color: rgba(47, 107, 255, 0.28);
  background: linear-gradient(135deg, rgba(47, 107, 255, 0.12), rgba(21, 192, 201, 0.12));
  box-shadow: 0 16px 40px -24px rgba(47, 107, 255, 0.55);
}
.stat-card.v3.accent .stat-ico {
  background: var(--grad);
  box-shadow: 0 8px 18px -8px rgba(47, 107, 255, 0.7);
}
.stat-card.v3.accent b {
  background: linear-gradient(120deg, var(--accent), #0e9aa7);
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
}

/* ---------- Chart v3 ---------- */
.chart-svg rect {
  fill: url(#barGrad);
  opacity: 0.45;
}
.chart-svg rect.peak {
  fill: url(#barGradPeak);
  opacity: 1;
}
.chart-svg rect.zero {
  fill: rgba(12, 26, 43, 0.12);
  opacity: 0.4;
}

/* ---------- Overview mini live rows ---------- */
.live-mini-row {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-radius: 16px;
}
.live-mini-row.hot {
  border-color: rgba(47, 107, 255, 0.22);
  background: rgba(255, 255, 255, 0.72);
}
.live-mini-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.live-mini-row .avatar {
  width: 32px;
  height: 32px;
  border-radius: 99px;
  font-size: 12.5px;
}
.live-mini-copy {
  flex: 1;
  min-width: 0;
}
.live-mini-title {
  font-size: 14px;
  font-weight: 700;
}
.live-mini-title a {
  color: var(--accent);
  text-decoration: none;
}
.live-mini-title a:hover {
  color: #0e9aa7;
}
.live-mini-meta {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted);
}
.live-mini-pct {
  font-family: var(--font-display);
  font-size: 15px;
  font-weight: 700;
  color: var(--accent);
}
.bar.slim {
  height: 7px;
}

/* ---------- Mobile: sidebar -> bottom tab bar (all admin tabs) ---------- */
@media (max-width: 900px) {
  .admin-layout {
    display: block;
    padding-bottom: 78px;
  }
  .admin-side {
    position: fixed;
    left: 10px;
    right: 10px;
    bottom: 10px;
    z-index: 50;
    min-height: 0;
    padding: 8px;
    border-radius: 20px;
    flex-direction: row;
  }
  .admin-side .side-brand,
  .admin-side .side-foot,
  .admin-side .side-divider,
  .admin-side .tab .tab-label {
    display: none;
  }
  .side-nav {
    flex-direction: row;
    width: 100%;
    justify-content: space-around;
    gap: 2px;
  }
  .admin-side .tab {
    flex-direction: column;
    gap: 4px;
    padding: 9px 10px;
    border-radius: 12px;
  }
  .admin-side .tab.tab-create {
    border-width: 1px;
  }
  .nav-badge {
    position: absolute;
    transform: translate(12px, -6px);
    margin: 0;
  }
  .admin-side .tab {
    position: relative;
  }
  .stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
  }
  .dashboard-grid {
    grid-template-columns: 1fr;
  }
}
```
**Verify:** Desktop: sticky glass sidebar with gradient active item, dashed "New drop link", lock button. ≤900px: sidebar becomes a fixed bottom icon bar (Overview/Live/Links/Shares/Activity/+); stat grids drop to 2 columns; two-up panels stack.

---

### Change 9: Rebuild the existing Live transfers pane
**File:** `public/admin.html`
**Why:** PLAN.md requires a sticky live summary, full active-session cards, a descriptive empty state, and finished-this-hour history inside the same `/admin` tab shell.
**Locate:**
```html
      <!-- LIVE: every active transfer, full width -->
      <section id="tab-live" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">Live transfers</h1><span class="muted">Durable Object stream - every active uploader and file</span></div>
        <div id="live-metrics" class="live-metrics"></div>
        <section class="panel">
```
**Action:** REPLACE
**Old code:**
```html
      <!-- LIVE: every active transfer, full width -->
      <section id="tab-live" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">Live transfers</h1><span class="muted">Durable Object stream - every active uploader and file</span></div>
        <div id="live-metrics" class="live-metrics"></div>
        <section class="panel">
          <div class="section-title">
            <h2>Sessions</h2>
            <div class="section-tools">
              <button class="mini" id="live-refresh" type="button">refresh</button>
            </div>
          </div>
          <div id="live-list" class="live-list tall"></div>
        </section>
      </section>
```
**New code:**
```html
      <!-- LIVE: still one pane in the shared /admin document -->
      <section id="tab-live" class="tab-pane hidden">
        <div class="pane-head"><div><p class="eyebrow">real-time relay</p><h1 class="pane-title grad-text">Live transfers</h1><span class="muted">Every active uploader and file, streamed from the Durable Object.</span></div><button class="mini" id="live-refresh" type="button">Refresh snapshot</button></div>
        <div id="live-metrics" class="live-metrics live-summary-strip"></div>
        <div id="live-list" class="live-list tall"></div>
        <section id="live-empty" class="panel live-empty hidden"><span class="live-empty-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 16c2-2 4-3 8-3s6 1 8 3" fill="none" stroke="currentColor" stroke-width="2"></path><circle cx="12" cy="8" r="3" fill="currentColor" opacity=".18"></circle><path d="M8 20h8" fill="none" stroke="currentColor" stroke-width="2"></path></svg></span><h2>No transfers right now</h2><p class="muted">This view updates automatically when somebody starts an upload.</p><div id="live-last-completed"></div></section>
        <section id="live-finished-section" class="panel live-finished hidden"><div class="section-title"><h2>Finished this hour</h2><span class="muted">Most recent 20 sessions</span></div><div id="live-finished-list"></div></section>
      </section>
```
**Verify:** Live remains a `data-tab="live"` pane at `/admin`; no new admin document/script exists; active, empty, and finished hosts are distinct.

---

### Change 10: Store recent completed sessions from the existing WebSocket
**File:** `public/admin.js`
**Why:** Plan 09 adds `snapshot.recent`; the frontend must retain and render it.
**Locate:**
```js
const $ = (id) => document.getElementById(id);

let overview = null;
let liveActive = [];
let liveSocket = null;
let liveReconnectDelay = 1000;
let currentDetailSlug = "";
```
**Action:** REPLACE
**Old code:**
```js
let overview = null;
let liveActive = [];
let liveSocket = null;
```
**New code:**
```js
let overview = null;
let liveActive = [];
let liveRecent = [];
let liveSocket = null;
```
**Verify:** No console error during initialization.

**Locate:**
```js
      if (msg.type === "snapshot") {
        liveActive = msg.active || [];
        renderLive();
        if (currentDetailSlug) renderDetailLive(currentDetailSlug);
      }
```
**Action:** REPLACE
**Old code:**
```js
      if (msg.type === "snapshot") {
        liveActive = msg.active || [];
        renderLive();
        if (currentDetailSlug) renderDetailLive(currentDetailSlug);
      }
```
**New code:**
```js
      if (msg.type === "snapshot") {
        liveActive = msg.active || [];
        liveRecent = msg.recent || [];
        renderLive();
        if (currentDetailSlug) renderDetailLive(currentDetailSlug);
      }
```
**Verify:** A snapshot with `recent` updates the Finished list on the same render pass.

---

### Change 11: Render active-only cards, empty state, and finished sessions
**File:** `public/admin.js`
**Why:** Completed sessions are no longer mixed into the active list, and empty state must show the last completed real session.
**Locate:**
```js
}

function renderLive() {
  const uploading = liveActive.filter((s) => s.state === "uploading");
  renderMetrics(uploading);
  const badge = $("live-badge");
  if (badge) {
```
**Action:** REPLACE
**Old code:**
```js
function renderLive() {
  const uploading = liveActive.filter((s) => s.state === "uploading");
  renderMetrics(uploading);
  const badge = $("live-badge");
  if (badge) {
    badge.textContent = uploading.length;
    badge.classList.toggle("hidden", uploading.length === 0);
  }
  const box = $("live-list");
  if (box) {
    reconcile(box, liveActive, (s) => s.id, makeLiveRow, updateLiveRow);
    setEmpty(box, liveActive.length === 0, "No active uploads right now.");
  }
  const mini = $("live-mini");
  if (mini) {
    const top = liveActive.slice(0, 3);
    reconcile(mini, top, (s) => `m:${s.id}`, makeLiveRow, updateLiveRow);
    setEmpty(mini, top.length === 0, "No active uploads right now.");
    if (mini._more) mini._more.remove();
    if (liveActive.length > top.length) {
      mini._more = document.createElement("div");
      mini._more.className = "list-note";
      mini._more.textContent = `+${liveActive.length - top.length} more session${liveActive.length - top.length === 1 ? "" : "s"} in the Live transfers tab`;
      mini.appendChild(mini._more);
    }
  }
}
```
**New code:**
```js
function renderLive() {
  const uploading = liveActive.filter((session) => session.state === "uploading");
  renderMetrics(uploading);
  const badge = $("live-badge");
  if (badge) {
    badge.textContent = uploading.length;
    badge.classList.toggle("hidden", uploading.length === 0);
  }
  const box = $("live-list");
  if (box) reconcile(box, uploading, (session) => session.id, makeLiveRow, updateLiveRow);
  $("live-empty")?.classList.toggle("hidden", uploading.length !== 0);
  const last = liveRecent[0];
  if ($("live-last-completed")) $("live-last-completed").innerHTML = last ? `<span class="muted">Last completed: <b>${esc(last.uploader || "anonymous")}</b> → ${esc(last.label || last.slug)} · ${last.files || 0} files · ${fmtBytes(last.bytes || 0)} · ${new Date(last.endedAt).toLocaleTimeString()}</span>` : "";
  const finished = $("live-finished-list");
  if (finished) reconcile(finished, liveRecent, (session) => session.id, makeFinishedLiveRow, updateFinishedLiveRow);
  $("live-finished-section")?.classList.toggle("hidden", liveRecent.length === 0);

  const mini = $("live-mini");
  if (mini) {
    const top = uploading.slice(0, 3);
    reconcile(mini, top, (session) => `m:${session.id}`, makeMiniLiveRow, updateMiniLiveRow);
    setEmpty(mini, top.length === 0, "No active uploads right now.");
  }
}

function makeFinishedLiveRow() {
  const row = document.createElement("div");
  row.className = "finished-live-row";
  return row;
}

function updateFinishedLiveRow(row, session) {
  row.innerHTML = `<span class="avatar">${esc(initialsOf(session.uploader || "anonymous"))}</span><span><b>${esc(session.uploader || "anonymous")} → ${esc(session.label || session.slug)}</b><small>${session.files || 0} files · ${fmtBytes(session.bytes || 0)} · ${fmtTime(session.duration || 0)}</small></span><time>${new Date(session.endedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>`;
}
```
**Verify:** Active list contains only uploading sessions; zero active sessions shows the dashed state; finished rows use only WebSocket `recent` data.

---

### Change 12: Render the three-item sticky summary strip
**File:** `public/admin.js`
**Why:** PLAN.md explicitly names active sessions, combined throughput, and Drive write rate.
**Locate:**
```js
}

function renderMetrics(sessions) {
  const el = $("live-metrics");
  if (!el) return;
  const remaining = sessions.reduce((t, s) => t + Math.max(0, (s.total || 0) - (s.sent || 0)), 0);
  const speed = sessions.reduce((t, s) => t + (s.speed || 0), 0);
```
**Action:** REPLACE
**Old code:**
```js
function renderMetrics(sessions) {
  const el = $("live-metrics");
  if (!el) return;
  const remaining = sessions.reduce((t, s) => t + Math.max(0, (s.total || 0) - (s.sent || 0)), 0);
  const speed = sessions.reduce((t, s) => t + (s.speed || 0), 0);
  const files = sessions.reduce((t, s) => t + Math.max(0, (s.count || 0) - (s.done || 0)), 0);
  const eta = speed > 0 ? remaining / speed : 0;
  upsertCards(
    el,
    [
      ["Active uploaders", sessions.length],
      ["Files in flight", files],
      ["Throughput", speed ? `${fmtBytes(speed)}/s` : "-"],
      ["ETA - all done", speed ? fmtTime(eta) : "-"],
    ],
    "live-metric",
  );
  const hot = sessions.length > 0;
  for (const [, card] of el._rows) card.classList.toggle("hot", hot);
}
```
**New code:**
```js
function renderMetrics(sessions) {
  const element = $("live-metrics");
  if (!element) return;
  const throughput = sessions.reduce((sum, session) => sum + (session.speed || 0), 0);
  upsertCards(element, [["Active sessions", sessions.length], ["Combined throughput", throughput ? `${fmtBytes(throughput)}/s` : "—"], ["Drive write rate", throughput ? `${fmtBytes(throughput)}/s` : "—"]], "live-metric");
  for (const [, card] of element._rows) card.classList.toggle("hot", sessions.length > 0);
}
```
**Verify:** Drive write rate is explicitly the same aggregate live byte rate, as documented in INVENTORY B7; no independent fake metric is generated.

---

### Change 13: Add ring, uploader/link headline, pause state, and real speed sparkline to active cards
**File:** `public/admin.js`
**Why:** Each card must match PLAN.md using `speedHist` from plan 09, not a decorative fake graph.
**Locate:**
```js
}

function liveRowInner(s) {
  // Show every in-flight file the uploader reported (up to the 20-file wire
  // sample); the list scrolls via CSS instead of hiding files behind "+N".
  const inFlight = s.files || [];
  const files = inFlight
```
**Action:** REPLACE
**Old code:**
```js
function liveRowInner(s) {
  // Show every in-flight file the uploader reported (up to the 20-file wire
  // sample); the list scrolls via CSS instead of hiding files behind "+N".
  const inFlight = s.files || [];
  const files = inFlight
    .map((f) => {
      const state = liveFileState(f);
      const pct = f.size ? Math.min(100, Math.round((Number(f.sent || 0) / Number(f.size || 0)) * 100)) : 0;
      return `
        <div class="file-row ${escAttr(state)}">
          <div class="file-top">
            <div class="file-name">${esc(f.name || "file")}</div>
            <div class="file-stat ${escAttr(liveFileStatClass(state))}">${fmtBytes(f.sent || 0)} / ${fmtBytes(f.size || 0)}</div>
          </div>
          <div class="trail"><i style="width:${pct}%"></i></div>
        </div>`;
    })
    .join("");
  const more = s.count > s.done + inFlight.length ? `<div class="list-note">${s.count - s.done - inFlight.length} more queued</div>` : "";
  const age = Math.max(0, Math.round((Date.now() - Number(s.lastSeen || Date.now())) / 1000));
  const state = s.state === "stale" ? "abandoned" : s.state === "done" ? "complete" : "uploading";
  const tags = [];
  if (s.count) tags.push(`<span class="tag">${s.done || 0}/${s.count} files</span>`);
  if (s.state === "uploading" && s.speed) tags.push(`<span class="tag rate">${fmtBytes(s.speed)}/s</span>`);
  if (s.state === "uploading" && s.eta) tags.push(`<span class="tag eta">~${fmtTime(s.eta)} left</span>`);
  if (s.error) tags.push(`<span class="tag err">${s.error} need attention</span>`);
  const meta = tags.length ? `<div class="live-meta">${tags.join("")}</div>` : "";
  const headline = `${s.pct || 0}% complete`;
  const detail = `${s.done || 0}/${s.count || 0} files - ${fmtBytes(s.sent || 0)} of ${fmtBytes(s.total || 0)}${
    s.speed ? ` - ${fmtBytes(s.speed)}/s` : ""
  }${s.eta ? ` - ~${fmtTime(s.eta)} left` : ""}`;
  return `
    <div class="transfer-head live-transfer-head">
      <div>
        <p class="eyebrow">${esc(s.slug)} - ${esc(state)}</p>
        <h2><span>${esc(headline)}</span></h2>
        <div class="muted">${esc(s.uploader || "anonymous")} - updated ${age}s ago</div>
      </div>
      <div class="transfer-side">
        <span class="muted">${esc(detail)}</span>
        <span class="state-pill">${esc(state)}</span>
      </div>
    </div>
    <div class="trail total"><i style="width:${s.pct || 0}%"></i></div>
    ${meta}
    <div class="filelist live-queue">${files}${more}</div>
    <div class="row-actions">
      <button class="mini" data-open-detail="${escAttr(s.slug)}" type="button">${icon("list")}detail</button>
      <button class="mini" data-open-folder="${escAttr(s.slug)}" type="button">${icon("folder")}open</button>
      <button class="mini danger" data-close-session="${escAttr(s.id)}" data-close-slug="${escAttr(s.slug)}" type="button">dismiss</button>
    </div>`;
}
```
**New code:**
```js
function liveRowInner(session) {
  const inFlight = session.files || [];
  const files = inFlight.map((file) => {
    const state = liveFileState(file);
    const pct = file.size ? Math.min(100, Math.round((Number(file.sent || 0) / Number(file.size || 0)) * 100)) : 0;
    return `<div class="file-row ${escAttr(state)}"><div class="file-top"><div class="file-name">${esc(file.name || "file")}</div><div class="file-stat ${escAttr(liveFileStatClass(state))}">${fmtBytes(file.sent || 0)} / ${fmtBytes(file.size || 0)}</div></div><div class="trail"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
  const more = session.count > session.done + inFlight.length ? `<div class="list-note">${session.count - session.done - inFlight.length} more queued</div>` : "";
  return `<div class="live-card-head"><div class="live-ring"><svg viewBox="0 0 44 44" aria-hidden="true"><circle cx="22" cy="22" r="18" fill="none" stroke="rgba(12,26,43,.08)" stroke-width="4"></circle><circle cx="22" cy="22" r="18" fill="none" stroke="#2f6bff" stroke-width="4" stroke-linecap="round" stroke-dasharray="113.1" stroke-dashoffset="${113.1 * (1 - (session.pct || 0) / 100)}"></circle></svg><b>${session.pct || 0}%</b></div><span class="avatar">${esc(initialsOf(session.uploader || "anonymous"))}</span><div class="live-card-copy"><h2>${esc(session.uploader || "anonymous")} → <button data-open-detail="${escAttr(session.slug)}" type="button">${esc(session.label || session.slug)}</button></h2><p>${session.done || 0} of ${session.count || 0} files · ${fmtBytes(session.sent || 0)} of ${fmtBytes(session.total || 0)}${session.speed ? ` · ${fmtBytes(session.speed)}/s` : ""}${session.eta ? ` · ~${fmtTime(session.eta)} left` : ""}${session.paused ? " · paused" : ""}</p></div><span class="state-pill">${session.paused ? "paused" : "uploading"}</span></div><div class="live-spark"><span>Last 60 seconds</span>${speedSparkline(session.speedHist || [])}</div><div class="filelist live-queue">${files}${more}</div><div class="row-actions"><button class="mini" data-open-detail="${escAttr(session.slug)}" type="button">${icon("list")}detail</button><button class="mini" data-open-folder="${escAttr(session.slug)}" type="button">${icon("folder")}Drive folder</button><button class="mini danger" data-close-session="${escAttr(session.id)}" data-close-slug="${escAttr(session.slug)}" type="button">dismiss</button></div>`;
}

function speedSparkline(samples) {
  if (!samples.length) return '<div class="spark-empty">Waiting for speed samples…</div>';
  const width = 320;
  const height = 54;
  const max = Math.max(...samples.map((sample) => Number(sample.bps) || 0), 1);
  const points = samples.map((sample, index) => `${(index / Math.max(1, samples.length - 1)) * width},${height - ((Number(sample.bps) || 0) / max) * (height - 4)}`).join(" ");
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-label="Transfer speed over the last 60 seconds"><defs><linearGradient id="sparkStroke" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#2f6bff"></stop><stop offset="1" stop-color="#15c0c9"></stop></linearGradient></defs><polyline points="${points}" fill="none" stroke="url(#sparkStroke)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></polyline></svg>`;
}
```
**Verify:** Sparkline is empty until real samples arrive; then every plotted point comes from `session.speedHist`; paused sessions visibly say paused.

---

### Change 14: Add Live-tab-specific styles
**File:** `public/style.css`
**Why:** Implement sticky summary, large session cards, rings, sparkline, empty state, and finished rows.
**Locate:**
```css
/* ---------- Stat cards v3 ---------- */
.stat-card.v3 {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px 18px;
  border-radius: 20px;
```
**Action:** INSERT BEFORE
**New code:**
```css
/* ---------- Admin Live transfers v3 ---------- */
.live-summary-strip {
  position: sticky;
  top: 12px;
  z-index: 4;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid var(--glass-border);
  border-radius: 18px;
  padding: 9px;
  background: rgba(255, 255, 255, 0.76);
  backdrop-filter: blur(14px);
  box-shadow: var(--shadow-card);
}
.live-summary-strip .live-metric {
  border: 0;
  box-shadow: none;
  background: transparent;
}
#tab-live > .live-list {
  margin-top: 14px;
}
#tab-live .live-row {
  border: 1px solid var(--glass-border);
  border-radius: 20px;
  padding: 18px;
  background: var(--glass);
  backdrop-filter: blur(12px);
  box-shadow: var(--shadow-card);
}
.live-card-head {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 11px;
}
.live-ring {
  position: relative;
  width: 44px;
  height: 44px;
}
.live-ring svg {
  transform: rotate(-90deg);
}
.live-ring b {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font: 700 8.5px var(--font-display);
}
.live-card-copy h2 {
  margin: 0;
  font-size: 15px;
}
.live-card-copy h2 button {
  border: 0;
  padding: 0;
  color: var(--accent);
  font: inherit;
  background: transparent;
  cursor: pointer;
}
.live-card-copy p {
  margin: 4px 0 0;
  color: var(--muted);
  font: 10.5px var(--font-mono);
}
.live-spark {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin: 14px 0;
  color: var(--muted);
  font: 10px var(--font-mono);
}
.live-spark svg,
.spark-empty {
  width: 100%;
  height: 54px;
}
.spark-empty {
  display: flex;
  align-items: center;
  border-bottom: 1px dashed rgba(12, 26, 43, 0.14);
}
.live-empty {
  margin-top: 14px;
  border-style: dashed;
  padding: 38px;
  text-align: center;
}
.live-empty-icon {
  width: 54px;
  height: 54px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 18px;
  color: var(--accent);
  background: rgba(47, 107, 255, 0.08);
}
.live-empty-icon svg {
  width: 28px;
  height: 28px;
}
.live-finished {
  margin-top: 14px;
}
.finished-live-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
  padding: 10px 0;
  border-bottom: 1px solid rgba(12, 26, 43, 0.06);
}
.finished-live-row:last-child {
  border-bottom: 0;
}
.finished-live-row b,
.finished-live-row small {
  display: block;
}
.finished-live-row small,
.finished-live-row time {
  color: var(--muted);
  font: 10.5px var(--font-mono);
}
@media (max-width: 760px) {
  .live-summary-strip {
    position: static;
    grid-template-columns: 1fr;
  }
  .live-card-head {
    grid-template-columns: auto minmax(0, 1fr) auto;
  }
  .live-card-head > .avatar {
    display: none;
  }
  .live-card-head .state-pill {
    grid-column: 2;
  }
  .live-spark {
    grid-template-columns: 1fr;
  }
}
```
**Verify:** Desktop summary sticks while cards scroll; mobile summary becomes non-sticky/stacked; active cards contain per-file rows and real sparkline; finished list is compact.

---

## Placeholder data
All mockup values are placeholders wired to real sources already in the code: totals + quota → `GET /api/admin/overview`; chart + busiest day → `GET /api/admin/timeseries?days=30`; live rows/speed history/finished sessions → admin WebSocket snapshot after plan 09; recent activity rows → `overview.events` (their person-first row styling arrives in plan 04, which owns the shared event-row renderer used by both `#events` and `#events-mini`).

## Responsive
Covered by the `@media (max-width: 900px)` block in Change 8 plus Live-specific rules in Change 14 — Change 8 is THE shared admin responsive treatment; plans 04–07 add only pane-specific responsive rules.
