# Plan 06 — Admin Link detail pane

**Files touched:** `public/admin.js`, `public/style.css`.
**Depends on:** plan 00 (tokens/components) and plan 03 (the one shared `/admin` shell and hidden `#tab-detail` pane).
**New assets:** none. Existing `icon()` SVG output and the complete chevrons below are inline.

**Single-page constraint:** Link detail remains the existing hidden `#tab-detail` pane rendered into `#detail-view` by `renderDetail()`. Do not create a detail HTML file, pathname, router, sidebar, or duplicate settings controller.

---

### Change 1: Track collapsed upload-history state
**File:** `public/admin.js`
**Why:** The mockup initially shows eight recent files with a real “show all N” toggle.
**Locate:**
```js
let seriesMetric = "bytes";
let seriesRows = [];
let detailData = null;
let detailSearch = "";
let detailSort = "new";
const openSettings = new Set();

```
**Action:** REPLACE
**Old code:**
```js
let detailData = null;
let detailSearch = "";
let detailSort = "new";
const openSettings = new Set();
```
**New code:**
```js
let detailData = null;
let detailSearch = "";
let detailSort = "new";
let detailShowAll = false;
const openSettings = new Set();
```
**Verify:** `/admin` loads without a console error and link-detail state remains local to `admin.js`.

---

### Change 2: Rebuild the detail summary as breadcrumb, actions, stats, uploaders, and Live now
**File:** `public/admin.js`
**Why:** Match `Admin Link Detail.dc.html` while retaining real link/live data and existing delegated action attributes.
**Locate:**
```js
    <section class="panel detail-summary">
      <div class="section-title">
        <div>
          <p class="eyebrow">link detail ${stateBadge(l.state)}</p>
          <h2>${esc(l.label)}</h2>
```
**Action:** REPLACE
**Old code:**
```js
    <section class="panel detail-summary">
      <div class="section-title">
        <div>
          <p class="eyebrow">link detail ${stateBadge(l.state)}</p>
          <h2>${esc(l.label)}</h2>
        </div>
        <div class="history-tools">
          <span class="muted">/d/${esc(l.slug)}</span>
          <button class="mini" data-copy-link="/d/${escAttr(l.slug)}" type="button">copy</button>
          <button class="mini" data-qr-link="/d/${escAttr(l.slug)}" data-qr-label="${escAttr(l.label)}" type="button">qr</button>
          <button class="mini" data-share-link="/d/${escAttr(l.slug)}" type="button">share</button>
          <button class="mini" data-open-folder="${escAttr(l.slug)}" type="button">${icon("folder")}folder</button>
          <button class="mini" data-pause-link="${escAttr(l.slug)}" data-paused="${l.disabled ? "1" : "0"}" type="button">${l.disabled ? "resume" : "pause"}</button>
        </div>
      </div>
      ${l.disabled && l.disabledReason ? `<div class="msg-err">Paused: ${esc(l.disabledReason)}</div>` : ""}
      <div class="stat-grid small">
        ${staticCard("Opens", l.stats.opens)}
        ${staticCard("Sessions", l.stats.sessions)}
        ${staticCard("Files", l.stats.files)}
        ${staticCard("Received", fmtBytes(l.stats.bytes))}
      </div>
      ${budgetBar(l)}
      ${leaders}
      <div class="section-subtitle">Live now</div>
      <div id="detail-live" class="live-list"></div>
    </section>
```
**New code:**
```js
    <section class="detail-summary">
      <button class="detail-breadcrumb" data-goto-tab="links" type="button">Drop links <span>/</span> ${esc(l.label)}</button>
      <div class="detail-title-row">
        <div><p class="eyebrow">link detail</p><h1 class="pane-title grad-text">${esc(l.label)}</h1><div class="detail-chips"><span class="link-status ${escAttr(l.state || "active")}">${l.disabled ? "paused" : l.hasPin ? "PIN protected" : "open"}</span><code>/d/${esc(l.slug)}</code></div></div>
        <div class="link-action-row detail-actions">
          ${linkActionButton("copy", "Copy", `data-copy-link="/d/${escAttr(l.slug)}"`)}
          ${linkActionButton("qr", "QR", `data-qr-link="/d/${escAttr(l.slug)}" data-qr-label="${escAttr(l.label)}"`)}
          ${linkActionButton("folder", "Drive", `data-open-folder="${escAttr(l.slug)}"`)}
          ${linkActionButton(l.disabled ? "play" : "pause", l.disabled ? "Resume" : "Pause", `data-pause-link="${escAttr(l.slug)}" data-paused="${l.disabled ? "1" : "0"}"`)}
        </div>
      </div>
      ${l.disabled && l.disabledReason ? `<div class="msg-err">Paused: ${esc(l.disabledReason)}</div>` : ""}
      <div class="stat-grid detail-stats">
        ${detailStatCard("Opens", l.stats.opens, "eye")}
        ${detailStatCard("Sessions", l.stats.sessions, "list")}
        ${detailStatCard("Files", l.stats.files, "file")}
        ${detailStatCard("Received", fmtBytes(l.stats.bytes), "download", true)}
      </div>
      ${budgetBar(l)}
      <div class="detail-two-up">
        <section class="panel detail-subpanel"><div class="section-title"><h2>Top uploaders</h2><span class="muted">recent history</span></div>${leaders || '<div class="empty">No uploads yet.</div>'}</section>
        <section class="panel detail-subpanel"><div class="section-title"><h2><span class="live-dot" aria-hidden="true"></span>Live now</h2></div><div id="detail-live" class="live-list"></div></section>
      </div>
    </section>
```
**Verify:** Clicking breadcrumb uses the shared tab switcher; actions still use delegated handlers; stats come from `d.link.stats`; the live panel uses `liveActive` via `renderDetailLive()`.

---

### Change 3: Add detail stat-card helper
**File:** `public/admin.js`
**Why:** Link detail needs icon tiles and one accented Received card without duplicating Overview’s reconciliation code.
**Locate:**
```js
}

function staticCard(label, value) {
  return `<div class="stat-card"><span>${esc(label)}</span><b>${esc(value)}</b></div>`;
}

function icon(name) {
```
**Action:** INSERT BEFORE
**New code:**
```js
function detailStatCard(label, value, iconName, accent = false) {
  return `<div class="stat-card v3${accent ? " accent" : ""}"><span class="stat-ico">${icon(iconName)}</span><div><b>${esc(String(value))}</b><span>${esc(label)}</span></div></div>`;
}

```
**Verify:** Four detail stat cards render; Received uses `.accent`; no mockup number is hard-coded.

---

### Change 4: Add show-all control to the upload-history card
**File:** `public/admin.js`
**Why:** The mockup shows a compact recent-file grid with a “show all N” affordance.
**Locate:**
```js
      <div class="upload-table-wrap">
        <table class="uploads">
          <thead><tr><th>File</th><th>Uploader</th><th class="num">Size</th><th class="num">Uploaded</th><th></th></tr></thead>
          <tbody id="upload-rows"></tbody>
        </table>
      </div>
    </section>
```
**Action:** REPLACE
**Old code:**
```js
      <div class="upload-table-wrap">
        <table class="uploads">
          <thead><tr><th>File</th><th>Uploader</th><th class="num">Size</th><th class="num">Uploaded</th><th></th></tr></thead>
          <tbody id="upload-rows"></tbody>
        </table>
      </div>
    </section>
```
**New code:**
```js
      <div class="upload-table-wrap">
        <table class="uploads">
          <thead><tr><th>File</th><th>Uploader</th><th class="num">Size</th><th class="num">Uploaded</th><th>Open</th></tr></thead>
          <tbody id="upload-rows"></tbody>
        </table>
      </div>
      <button class="mini upload-show-all hidden" id="up-show-all" type="button"></button>
    </section>
```
**Verify:** The history panel contains a hidden show-all button below the real table.

---

### Change 5: Replace one giant settings fold with five focused accordions
**File:** `public/admin.js`
**Why:** The mockup keeps Access expanded and summarizes Transfer, Budgets, Notifications, and Branding & promo as collapsed sections.
**Locate:**
```js
    <details class="panel settings-fold" ${settingsOpen ? "open" : ""}>
      <summary>
        <div>
          <p class="eyebrow">configuration</p>
          <h2>${icon("sliders")}Edit settings</h2>
```
**Action:** REPLACE
**Old code:**
```js
    <details class="panel settings-fold" ${settingsOpen ? "open" : ""}>
      <summary>
        <div>
          <p class="eyebrow">configuration</p>
          <h2>${icon("sliders")}Edit settings</h2>
        </div>
        <span class="muted">label, access, upload tuning, budgets, notifications, branding, promo</span>
      </summary>
      <div class="settings-grid">
        <div class="settings-card">
          <h3>Access</h3>
          <div class="grid-3">
            <div class="field"><label>Label</label><input id="d-label" type="text" value="${escAttr(l.label)}" /></div>
            <div class="field"><label>New password (blank keeps current)</label><input id="d-pin" type="password" autocomplete="new-password" /></div>
            <div class="field"><label>Expires in days from now (0 = permanent)</label><input id="d-days" type="number" min="0" max="30" value="${expiryDays}" /></div>
          </div>
          <span class="muted">${l.hasPin ? "This link currently requires a password." : "This link is currently open (no password)."}${l.expiresAt ? ` Expires ${new Date(l.expiresAt).toLocaleDateString()}.` : " Never expires."}</span>
        </div>
        <div class="settings-card">
          <h3>Transfer</h3>
          <div class="grid-3">
            <div class="field"><label>Parallel files</label><select id="d-conc">${opts([1, 2, 3, 4, 6, 8], l.settings.concurrency)}</select></div>
            <div class="field"><label>Chunk size</label><select id="d-chunk">${opts([8, 16, 32, 64], l.settings.chunkMB, " MB")}</select></div>
            <div class="field"><label>Max single file GB (blank = 5 TB)</label><input id="d-maxgb" type="number" min="0" value="${escAttr(maxTransferGb)}" /></div>
          </div>
          <label class="check"><input id="d-folders" type="checkbox" ${l.settings.perUploaderFolders ? "checked" : ""} /> Create subfolders per uploader</label>
        </div>
        <div class="settings-card">
          <h3>Budgets (0 = unlimited, auto-pauses when reached)</h3>
          <div class="grid-3">
            <div class="field"><label>Max total GB</label><input id="d-budget-gb" type="number" min="0" value="${escAttr(budgetGb)}" /></div>
            <div class="field"><label>Max files</label><input id="d-budget-files" type="number" min="0" value="${l.settings.maxTotalFiles || ""}" /></div>
            <div class="field"><label>Max sessions</label><input id="d-budget-sessions" type="number" min="0" value="${l.settings.maxSessions || ""}" /></div>
          </div>
        </div>
        <div class="settings-card">
          <h3>Notifications</h3>
          <div class="check-row">
            <label class="check"><input id="d-notify" type="checkbox" ${l.notify.enabled ? "checked" : ""} /> Email enabled</label>
            <label class="check"><input id="d-notify-start" type="checkbox" ${l.notify.start ? "checked" : ""} /> On upload start</label>
            <label class="check"><input id="d-notify-complete" type="checkbox" ${l.notify.complete ? "checked" : ""} /> Session digest when done</label>
          </div>
        </div>
        <div class="settings-card">
          <h3>Branding</h3>
          <div class="grid-2">
            <div class="field"><label>Logo URL</label><input id="d-logo" type="url" value="${escAttr(l.theme.logoUrl)}" /></div>
            <div class="field"><label>Background image URL</label><input id="d-bg" type="url" value="${escAttr(l.theme.backgroundUrl)}" /></div>
            <div class="field"><label>Accent</label><input id="d-accent" type="color" value="${escAttr(l.theme.accentColor)}" /></div>
            <div class="field"><label>Background</label><input id="d-bgcolor" type="color" value="${escAttr(l.theme.backgroundColor)}" /></div>
            <div class="field wide"><label>Welcome message</label><input id="d-welcome" type="text" value="${escAttr(l.theme.welcome)}" /></div>
          </div>
        </div>
        <div class="settings-card">
          <h3>Promo panel (shown beside the dropzone)</h3>
          <div class="grid-2">
            <div class="field"><label>Promo title</label><input id="d-promo-title" type="text" value="${escAttr(l.theme.promoTitle)}" /></div>
            <div class="field"><label>Promo text</label><input id="d-promo-text" type="text" value="${escAttr(l.theme.promoText)}" /></div>
            <div class="field"><label>YouTube/Vimeo URL</label><input id="d-video" type="url" value="${escAttr(l.theme.videoUrl)}" /></div>
            <div class="field"><label>CTA label</label><input id="d-cta-label" type="text" value="${escAttr(l.theme.ctaLabel)}" /></div>
            <div class="field"><label>CTA URL</label><input id="d-cta-url" type="url" value="${escAttr(l.theme.ctaUrl)}" /></div>
          </div>
        </div>
      </div>
      <div class="settings-actions">
        <button class="btn" id="save-detail" type="button">${icon("save")}Save settings</button>
        <button class="btn ghost" id="clear-pin" type="button">${icon("lock")}Clear password</button>
        <button class="btn ghost danger" id="detail-delete" type="button">Delete link</button>
      </div>
      <div class="msg-err" id="detail-msg"></div>
    </details>`;
```
**New code:**
```js
    <section class="panel settings-fold">
      <div class="section-title"><div><p class="eyebrow">configuration</p><h2>${icon("sliders")} Settings</h2></div><span class="muted">Changes apply to this link only.</span></div>
      <div class="settings-accordion">
        <details open><summary><span><b>Access</b><small>${l.hasPin ? "PIN protected" : "Open"} · ${l.expiresAt ? `expires ${new Date(l.expiresAt).toLocaleDateString()}` : "never expires"}</small></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></summary><div class="settings-body grid-3"><div class="field"><label>Label</label><input id="d-label" type="text" value="${escAttr(l.label)}" /></div><div class="field"><label>New password (blank keeps current)</label><input id="d-pin" type="password" autocomplete="new-password" /></div><div class="field"><label>Expires in days from now</label><input id="d-days" type="number" min="0" max="30" value="${expiryDays}" /></div></div></details>
        <details><summary><span><b>Transfer</b><small>${l.settings.concurrency}× parallel · ${l.settings.chunkMB} MB chunks · ${l.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</small></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></summary><div class="settings-body"><div class="grid-3"><div class="field"><label>Parallel files</label><select id="d-conc">${opts([1, 2, 3, 4, 6, 8], l.settings.concurrency)}</select></div><div class="field"><label>Chunk size</label><select id="d-chunk">${opts([8, 16, 32, 64], l.settings.chunkMB, " MB")}</select></div><div class="field"><label>Max single file GB</label><input id="d-maxgb" type="number" min="0" value="${escAttr(maxTransferGb)}" /></div></div><label class="check"><input id="d-folders" type="checkbox" ${l.settings.perUploaderFolders ? "checked" : ""} /> Create subfolders per uploader</label></div></details>
        <details><summary><span><b>Budgets</b><small>${l.settings.maxTotalBytes ? `${fmtBytes(l.stats.bytes)} of ${fmtBytes(l.settings.maxTotalBytes)}` : "Unlimited"} · auto-pause at limit</small></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></summary><div class="settings-body grid-3"><div class="field"><label>Max total GB</label><input id="d-budget-gb" type="number" min="0" value="${escAttr(budgetGb)}" /></div><div class="field"><label>Max files</label><input id="d-budget-files" type="number" min="0" value="${l.settings.maxTotalFiles || ""}" /></div><div class="field"><label>Max sessions</label><input id="d-budget-sessions" type="number" min="0" value="${l.settings.maxSessions || ""}" /></div></div></details>
        <details><summary><span><b>Notifications</b><small>${l.notify.enabled ? "Email enabled" : "Email disabled"} · ${l.notify.start ? "start alerts" : "no start alerts"} · ${l.notify.complete ? "completion digest" : "no completion digest"}</small></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></summary><div class="settings-body check-row"><label class="check"><input id="d-notify" type="checkbox" ${l.notify.enabled ? "checked" : ""} /> Email enabled</label><label class="check"><input id="d-notify-start" type="checkbox" ${l.notify.start ? "checked" : ""} /> On upload start</label><label class="check"><input id="d-notify-complete" type="checkbox" ${l.notify.complete ? "checked" : ""} /> Session digest when done</label></div></details>
        <details><summary><span><b>Branding & promo</b><small>${l.theme.logoUrl || l.theme.backgroundUrl || l.theme.promoTitle ? "Custom theme configured" : "Default losthusky/drop theme"}</small></span><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg></summary><div class="settings-body grid-2"><div class="field"><label>Logo URL</label><input id="d-logo" type="url" value="${escAttr(l.theme.logoUrl)}" /></div><div class="field"><label>Background image URL</label><input id="d-bg" type="url" value="${escAttr(l.theme.backgroundUrl)}" /></div><div class="field"><label>Accent</label><input id="d-accent" type="color" value="${escAttr(l.theme.accentColor)}" /></div><div class="field"><label>Background</label><input id="d-bgcolor" type="color" value="${escAttr(l.theme.backgroundColor)}" /></div><div class="field wide"><label>Welcome message</label><input id="d-welcome" type="text" value="${escAttr(l.theme.welcome)}" /></div><div class="field"><label>Promo title</label><input id="d-promo-title" type="text" value="${escAttr(l.theme.promoTitle)}" /></div><div class="field"><label>Promo text</label><input id="d-promo-text" type="text" value="${escAttr(l.theme.promoText)}" /></div><div class="field"><label>YouTube/Vimeo URL</label><input id="d-video" type="url" value="${escAttr(l.theme.videoUrl)}" /></div><div class="field"><label>CTA label</label><input id="d-cta-label" type="text" value="${escAttr(l.theme.ctaLabel)}" /></div><div class="field"><label>CTA URL</label><input id="d-cta-url" type="url" value="${escAttr(l.theme.ctaUrl)}" /></div></div></details>
      </div>
      <div class="settings-actions"><button class="btn" id="save-detail" type="button">${icon("save")}Save settings</button><button class="btn ghost" id="clear-pin" type="button">${icon("lock")}Clear password</button><button class="btn ghost danger" id="detail-delete" type="button">Delete link</button></div>
      <div class="msg-err" id="detail-msg"></div>
    </section>`;
```
**Verify:** All IDs read by `saveDetail()` still exist once; Access starts open; each remaining section shows a data-derived summary while collapsed; buttons remain at the bottom.

---

### Change 6: Replace obsolete settings toggle listener with upload show-all listener
**File:** `public/admin.js`
**Why:** The new nested settings accordions need no JavaScript, while upload-history needs a toggle.
**Locate:**
```js
  document.querySelector(".settings-fold")?.addEventListener("toggle", (event) => {
    if (event.currentTarget.open) openSettings.add(l.slug);
    else openSettings.delete(l.slug);
  });
  renderUploadRows();
```
**Action:** REPLACE
**Old code:**
```js
  document.querySelector(".settings-fold")?.addEventListener("toggle", (event) => {
    if (event.currentTarget.open) openSettings.add(l.slug);
    else openSettings.delete(l.slug);
  });
  renderUploadRows();
```
**New code:**
```js
  $("up-show-all")?.addEventListener("click", () => {
    detailShowAll = !detailShowAll;
    renderUploadRows();
  });
  renderUploadRows();
```
**Verify:** Settings accordions open natively; clicking show-all toggles without rerendering the entire detail pane.

---

### Change 7: Limit upload rows until Show all is chosen
**File:** `public/admin.js`
**Why:** Keep the mockup’s concise initial history without discarding or faking data.
**Locate:**
```js
  ups = [...ups].sort(cmp);
  tbody.innerHTML = ups.length
    ? ups.map(uploadRow).join("")
    : `<tr><td colspan="5" class="empty-cell">${all.length ? "No files match the filter." : 'No files yet. Use "sync from Drive" to pull any files saved with a delayed log.'}</td></tr>`;
  const shown = ups.length === all.length ? `${all.length}` : `${ups.length} of ${all.length}`;
  $("up-count").textContent = `${shown} files - ${fmtBytes(detailData.totalBytes)}`;
```
**Action:** REPLACE
**Old code:**
```js
  ups = [...ups].sort(cmp);
  tbody.innerHTML = ups.length
    ? ups.map(uploadRow).join("")
    : `<tr><td colspan="5" class="empty-cell">${all.length ? "No files match the filter." : 'No files yet. Use "sync from Drive" to pull any files saved with a delayed log.'}</td></tr>`;
  const shown = ups.length === all.length ? `${all.length}` : `${ups.length} of ${all.length}`;
  $("up-count").textContent = `${shown} files - ${fmtBytes(detailData.totalBytes)}`;
```
**New code:**
```js
  ups = [...ups].sort(cmp);
  const visible = detailShowAll || q ? ups : ups.slice(0, 8);
  tbody.innerHTML = visible.length
    ? visible.map(uploadRow).join("")
    : `<tr><td colspan="5" class="empty-cell">${all.length ? "No files match the filter." : 'No files yet. Use "sync from Drive" to pull any files saved with a delayed log.'}</td></tr>`;
  const shown = visible.length === all.length ? `${all.length}` : `${visible.length} of ${all.length}`;
  $("up-count").textContent = `${shown} files · ${fmtBytes(detailData.totalBytes)}`;
  const toggle = $("up-show-all");
  if (toggle) {
    toggle.classList.toggle("hidden", !q && all.length <= 8);
    toggle.textContent = detailShowAll ? "Show recent 8" : `Show all ${all.length}`;
  }
```
**Verify:** More than eight uploads show eight initially; search shows all matches; the toggle label uses the real upload count.

---

### Change 8: Upgrade uploader leaderboard to proportional bars
**File:** `public/admin.js`
**Why:** The mockup visualizes each uploader’s byte share, not just a text total.
**Locate:**
```js
  const rows = [...byUploader.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 6)
    .map(([name, v]) => `<div class="leader-row"><b>${esc(name)}</b><span>${v.files} files - ${fmtBytes(v.bytes)}</span></div>`)
    .join("");
  return `<div class="section-subtitle">Top uploaders (recent history)</div><div class="leaderboard">${rows}</div>`;
```
**Action:** REPLACE
**Old code:**
```js
  const rows = [...byUploader.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 6)
    .map(([name, v]) => `<div class="leader-row"><b>${esc(name)}</b><span>${v.files} files - ${fmtBytes(v.bytes)}</span></div>`)
    .join("");
  return `<div class="section-subtitle">Top uploaders (recent history)</div><div class="leaderboard">${rows}</div>`;
```
**New code:**
```js
  const sorted = [...byUploader.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 6);
  const total = sorted.reduce((sum, [, value]) => sum + value.bytes, 0) || 1;
  const rows = sorted.map(([name, value]) => {
    const pct = Math.round((value.bytes / total) * 100);
    return `<div class="leader-row"><div><span class="avatar">${esc(initialsOf(name))}</span><span><b>${esc(name || "anonymous")}</b><small>${value.files} files · ${fmtBytes(value.bytes)}</small></span><em>${pct}%</em></div><div class="trail"><i style="width:${pct}%"></i></div></div>`;
  }).join("");
  return `<div class="leaderboard">${rows}</div>`;
```
**Verify:** Uploader percentages total approximately 100% and are calculated only from real recent upload history.

---

### Change 9: Add Link detail layout, accordion, table-card, and mobile styles
**File:** `public/style.css`
**Why:** Match the hi-fi detail mockup while preserving the shared admin shell.
**Locate:**
```css
.create-success code {
  display: block;
  overflow-wrap: anywhere;
  margin: 18px 0;
  border-radius: 14px;
  padding: 14px;
  color: var(--accent);
  background: rgba(47, 107, 255, 0.07);
```
**Action:** INSERT BEFORE
**New code:**
```css
/* ---------- Admin Link detail v3 ---------- */
.detail-breadcrumb {
  border: 0;
  padding: 0;
  color: var(--muted);
  font: 11px var(--font-mono);
  background: transparent;
  cursor: pointer;
}
.detail-breadcrumb:hover,
.detail-breadcrumb span {
  color: var(--accent);
}
.detail-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 18px;
  margin: 12px 0 18px;
}
.detail-chips {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 7px;
}
.detail-chips code {
  color: var(--muted);
}
.detail-actions {
  justify-content: flex-end;
  margin: 0;
}
.detail-stats {
  margin: 0 0 14px;
}
.detail-two-up {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin: 14px 0;
}
.detail-subpanel {
  min-width: 0;
}
.leaderboard {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.leader-row > div:first-child {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 9px;
}
.leader-row b,
.leader-row small {
  display: block;
}
.leader-row small,
.leader-row em {
  color: var(--muted);
  font: normal 10px var(--font-mono);
}
.leader-row .trail {
  height: 5px;
  margin: 7px 0 0 41px;
}
.detail-history {
  margin-top: 14px;
}
.upload-show-all {
  display: flex;
  margin: 14px auto 0;
}
.settings-fold {
  margin-top: 14px;
}
.settings-accordion {
  overflow: hidden;
  border: 1px solid rgba(12, 26, 43, 0.08);
  border-radius: 16px;
}
.settings-accordion details + details {
  border-top: 1px solid rgba(12, 26, 43, 0.07);
}
.settings-accordion summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  list-style: none;
  cursor: pointer;
}
.settings-accordion summary::-webkit-details-marker {
  display: none;
}
.settings-accordion summary b,
.settings-accordion summary small {
  display: block;
}
.settings-accordion summary small {
  margin-top: 3px;
  color: var(--muted);
  font: 10.5px var(--font-mono);
}
.settings-accordion summary svg {
  width: 18px;
  height: 18px;
  fill: none;
  stroke: var(--muted);
  stroke-width: 2;
  transition: transform 0.18s ease;
}
.settings-accordion details[open] summary svg {
  transform: rotate(180deg);
}
.settings-body {
  border-top: 1px solid rgba(12, 26, 43, 0.06);
  padding: 16px;
  background: rgba(255, 255, 255, 0.34);
}
.settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 16px;
}

@media (max-width: 760px) {
  .detail-title-row,
  .detail-two-up {
    display: flex;
    flex-direction: column;
  }
  .detail-actions {
    justify-content: flex-start;
  }
  .detail-subpanel {
    width: 100%;
  }
  .upload-table-wrap table,
  .upload-table-wrap thead,
  .upload-table-wrap tbody,
  .upload-table-wrap tr,
  .upload-table-wrap th,
  .upload-table-wrap td {
    display: block;
  }
  .upload-table-wrap thead {
    display: none;
  }
  .upload-table-wrap tr {
    margin-bottom: 9px;
    border: 1px solid rgba(12, 26, 43, 0.08);
    border-radius: 13px;
    padding: 11px;
    background: rgba(255, 255, 255, 0.52);
  }
  .upload-table-wrap td {
    border: 0;
    padding: 3px 0;
    text-align: left !important;
  }
  .settings-actions .btn {
    width: 100%;
    justify-content: center;
  }
}

```
**Verify:** Desktop shows breadcrumb/title, four stats, two-up subpanels, history, and five accordions; at ≤760px the upload table becomes stacked file cards and settings buttons are full width.

---

## Placeholder data
Mockup stats, uploader names, percentages, files, and live state are examples only. This plan uses `GET /api/admin/link/:slug`, its `uploads`, `totalBytes`, and the shared admin WebSocket snapshot. Top uploader percentages are explicitly “recent history” because the backend caps recent upload metadata.

## Responsive
Change 9 owns Link-detail-specific stacking and table-to-card conversion. Plan 03 owns the common admin sidebar/bottom navigation.
