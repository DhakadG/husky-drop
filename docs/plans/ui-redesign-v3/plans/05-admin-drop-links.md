# Plan 05 — Admin Drop links + New drop link tabs

**Files touched:** `public/admin.html`, `public/admin.js`, `public/style.css`.
**Depends on:** plan 00 (tokens/components), plan 03 (single shared `/admin` shell), plan 09 changes 17–18 (real Drive folder browser).
**New assets:** none; action icons are complete inline SVG strings in Change 4.

**Single-page constraint:** both Drop links and New drop link remain panes (`#tab-links` and `#tab-create`) in the same `public/admin.html`. Reuse `showTab()`, `handleAdminAction()`, `refreshAll()`, and the existing `/api/admin/*` routes. Do not create `links.html`, `create.html`, or another admin script.

---

### Change 1: Replace the Drop links table with active and expired card hosts
**File:** `public/admin.html`
**Why:** The mockup uses full-width link cards with stats, budget progress, icon actions, and a condensed expired group.
**Locate:**
```html
      <!-- DROP LINKS -->
      <section id="tab-links" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">Drop links</h1><span class="muted">inbound /d/ links your friends upload to</span></div>
        <section class="panel">
          <div class="section-title">
            <h2>All links</h2>
```
**Action:** REPLACE
**Old code:**
```html
      <!-- DROP LINKS -->
      <section id="tab-links" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">Drop links</h1><span class="muted">inbound /d/ links your friends upload to</span></div>
        <section class="panel">
          <div class="section-title">
            <h2>All links</h2>
            <button class="mini" id="refresh" type="button">refresh</button>
          </div>
          <div class="table-wrap">
            <table class="links">
              <thead><tr><th>Link</th><th>Settings</th><th>Activity</th><th></th></tr></thead>
              <tbody id="rows"></tbody>
            </table>
          </div>
        </section>
      </section>
```
**New code:**
```html
      <!-- DROP LINKS: one pane in the shared /admin shell -->
      <section id="tab-links" class="tab-pane hidden">
        <div class="pane-head">
          <div>
            <p class="eyebrow">inbound collections</p>
            <h1 class="pane-title grad-text">Drop links</h1>
            <span class="muted">Private /d/ links that send files directly into Drive.</span>
          </div>
          <div class="pane-actions">
            <button class="mini" id="refresh" type="button">Refresh</button>
            <button class="btn" data-goto-tab="create" type="button">+ New drop link</button>
          </div>
        </div>
        <div id="rows" class="link-card-list" aria-live="polite"></div>
        <section id="expired-links-section" class="expired-links hidden">
          <button id="expired-links-toggle" class="expired-links-head" type="button" aria-expanded="false">
            <span>Expired · <b id="expired-links-count">0</b></span>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="m6 9 6 6 6-6"></path></svg>
          </button>
          <div id="expired-rows" class="link-card-list"></div>
        </section>
      </section>
```
**Verify:** `/admin` still has one Drop links tab; it contains one active-card host and one initially collapsed expired group, not a table.

---

### Change 2: Replace the New drop link pane with a two-step, single-submit flow
**File:** `public/admin.html`
**Why:** Label is the only required field, destination browsing belongs in step 1, optional protections/tuning in step 2, and the real created URL must appear in a success state.
**Locate:**
```html
      <!-- CREATE DROP LINK -->
      <section id="tab-create" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">New drop link</h1><span class="muted">a private upload page backed by its own Drive folder</span></div>
        <section class="panel">
          <div class="section-sub" style="margin-top:0">Basics</div>
```
**Action:** REPLACE
**Old code:**
```html
      <!-- CREATE DROP LINK -->
      <section id="tab-create" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">New drop link</h1><span class="muted">a private upload page backed by its own Drive folder</span></div>
        <section class="panel">
          <div class="section-sub" style="margin-top:0">Basics</div>
          <div class="grid-2">
            <div class="field"><label for="f-label">Label</label><input id="f-label" type="text" placeholder="Spiti Trip - June 2026" /></div>
            <div class="field"><label for="f-slug">Slug</label><input id="f-slug" type="text" placeholder="spiti-26" /></div>
            <div class="field"><label for="f-pin">Password / PIN</label><input id="f-pin" type="password" inputmode="numeric" autocomplete="new-password" /></div>
            <div class="field"><label for="f-days">Expires in days (0 = permanent)</label><input id="f-days" type="number" min="0" max="30" value="14" /></div>
            <div class="field wide"><label for="f-folder">Drive folder ID (blank auto-creates)</label><input id="f-folder" type="text" placeholder="1AbC..." /></div>
          </div>

          <div class="section-sub">Transfer settings</div>
          <div class="grid-3">
            <div class="field"><label for="f-conc">Parallel files</label><select id="f-conc"><option>1</option><option>2</option><option>3</option><option selected>4</option><option>6</option><option>8</option></select></div>
            <div class="field"><label for="f-chunk">Chunk size</label><select id="f-chunk"><option value="8">8 MB</option><option value="16">16 MB</option><option value="32" selected>32 MB</option><option value="64">64 MB</option></select></div>
            <label class="check"><input id="f-folders" type="checkbox" /> Create subfolders per uploader</label>
          </div>

          <div class="section-sub">Budgets (0 = unlimited; link auto-pauses when reached)</div>
          <div class="grid-3">
            <div class="field"><label for="f-budget-gb">Max total GB</label><input id="f-budget-gb" type="number" min="0" placeholder="0" /></div>
            <div class="field"><label for="f-budget-files">Max files</label><input id="f-budget-files" type="number" min="0" placeholder="0" /></div>
            <div class="field"><label for="f-budget-sessions">Max sessions</label><input id="f-budget-sessions" type="number" min="0" placeholder="0" /></div>
          </div>

          <div class="section-sub">Notifications</div>
          <div class="check-row">
            <label class="check"><input id="f-notify" type="checkbox" /> Email me</label>
            <label class="check"><input id="f-notify-start" type="checkbox" checked /> On upload start</label>
            <label class="check"><input id="f-notify-complete" type="checkbox" /> Session digest when done</label>
          </div>

          <div class="section-sub">Customization</div>
          <div class="grid-2">
            <div class="field"><label for="f-logo">Logo URL</label><input id="f-logo" type="url" placeholder="https://..." /></div>
            <div class="field"><label for="f-bg">Background image URL</label><input id="f-bg" type="url" placeholder="https://..." /></div>
            <div class="field"><label for="f-accent">Accent color</label><input id="f-accent" type="color" value="#2f6bff" /></div>
            <div class="field"><label for="f-bgcolor">Fallback background</label><input id="f-bgcolor" type="color" value="#eaf0f9" /></div>
            <div class="field wide"><label for="f-welcome">Welcome message</label><input id="f-welcome" type="text" placeholder="Upload original photos and videos from the trip." /></div>
            <div class="field"><label for="f-promo-title">Promo title</label><input id="f-promo-title" type="text" placeholder="Trip archive" /></div>
            <div class="field"><label for="f-promo-text">Promo text</label><input id="f-promo-text" type="text" placeholder="Drop everything here before Sunday." /></div>
            <div class="field"><label for="f-video">YouTube/Vimeo URL</label><input id="f-video" type="url" /></div>
            <div class="field"><label for="f-cta-label">CTA label</label><input id="f-cta-label" type="text" placeholder="Open album notes" /></div>
            <div class="field"><label for="f-cta-url">CTA URL</label><input id="f-cta-url" type="url" /></div>
          </div>
          <button class="btn" id="create">Create link</button>
          <div class="msg-err" id="create-err"></div>
        </section>
      </section>
```
**New code:**
```html
      <!-- CREATE DROP LINK: still a pane, not a separate page -->
      <section id="tab-create" class="tab-pane hidden">
        <div class="pane-head">
          <div><p class="eyebrow">new collection</p><h1 class="pane-title grad-text">New drop link</h1><span class="muted">Label it, choose a destination, then optionally add protection.</span></div>
        </div>
        <div class="create-flow">
          <div class="create-steps" aria-hidden="true"><span class="active" data-create-indicator="1">1 · Basics</span><i></i><span data-create-indicator="2">2 · Optional settings</span></div>
          <form id="drop-create-form" class="panel create-card">
            <section id="create-step-1" class="create-step">
              <div class="section-title"><div><p class="eyebrow">step 1</p><h2>Name and destination</h2></div><span class="tag">Label required</span></div>
              <div class="field"><label for="f-label">Link label</label><input id="f-label" type="text" placeholder="Spiti Trip — June 2026" maxlength="90" required autofocus /></div>
              <div class="folder-picker">
                <div class="field"><label for="f-folder">Destination Drive folder</label><input id="f-folder" type="text" placeholder="Blank creates a new folder automatically" /></div>
                <button class="mini" id="folder-browse" type="button">Browse Drive</button>
              </div>
              <div id="folder-picker-panel" class="folder-picker-panel hidden">
                <div class="folder-picker-head"><button class="mini" id="folder-up" type="button">← Parent</button><span id="folder-path">Drive root</span></div>
                <div id="folder-list" class="folder-list"></div>
                <div class="msg-err" id="folder-err"></div>
              </div>
              <div class="create-quick-actions">
                <button class="btn" id="create" type="submit">Create with defaults</button>
                <button class="btn ghost" id="create-next" type="button">Add optional settings →</button>
              </div>
              <p class="muted create-enter-note">Press Enter from the label field to create immediately with safe defaults.</p>
            </section>

            <section id="create-step-2" class="create-step hidden">
              <div class="section-title"><div><p class="eyebrow">step 2 · optional</p><h2>Protection and transfer</h2></div><button class="mini" id="create-back" type="button">← Basics</button></div>
              <div class="grid-2">
                <div class="field"><label for="f-slug">Custom slug</label><input id="f-slug" type="text" placeholder="spiti-26" /></div>
                <div class="field"><label for="f-pin">Password / PIN</label><input id="f-pin" type="password" inputmode="numeric" autocomplete="new-password" /></div>
                <div class="field"><label for="f-days">Expires in days (0 = permanent)</label><input id="f-days" type="number" min="0" max="30" value="14" /></div>
                <div class="field"><label for="f-budget-gb">Size budget in GB (0 = unlimited)</label><input id="f-budget-gb" type="number" min="0" value="0" /></div>
              </div>
              <fieldset class="preset-fieldset">
                <legend>Parallelism preset</legend>
                <label class="preset-card"><input type="radio" name="transfer-preset" value="simple" /><span><b>Simple</b><small>2 files · 16 MB chunks</small></span></label>
                <label class="preset-card"><input type="radio" name="transfer-preset" value="fast" checked /><span><b>Fast</b><small>4 files · 32 MB chunks</small></span></label>
                <label class="preset-card"><input type="radio" name="transfer-preset" value="aggressive" /><span><b>Aggressive</b><small>8 files · 64 MB chunks</small></span></label>
              </fieldset>
              <input id="f-conc" type="hidden" value="4" />
              <input id="f-chunk" type="hidden" value="32" />
              <details class="optional-advanced">
                <summary>More options</summary>
                <div class="grid-3">
                  <label class="check"><input id="f-folders" type="checkbox" /> Create subfolders per uploader</label>
                  <div class="field"><label for="f-budget-files">Max files</label><input id="f-budget-files" type="number" min="0" value="0" /></div>
                  <div class="field"><label for="f-budget-sessions">Max sessions</label><input id="f-budget-sessions" type="number" min="0" value="0" /></div>
                </div>
                <div class="check-row">
                  <label class="check"><input id="f-notify" type="checkbox" /> Email me</label>
                  <label class="check"><input id="f-notify-start" type="checkbox" checked /> On upload start</label>
                  <label class="check"><input id="f-notify-complete" type="checkbox" /> Digest when done</label>
                </div>
                <div class="grid-2">
                  <div class="field"><label for="f-logo">Logo URL</label><input id="f-logo" type="url" /></div>
                  <div class="field"><label for="f-bg">Background image URL</label><input id="f-bg" type="url" /></div>
                  <div class="field"><label for="f-accent">Accent color</label><input id="f-accent" type="color" value="#2f6bff" /></div>
                  <div class="field"><label for="f-bgcolor">Fallback background</label><input id="f-bgcolor" type="color" value="#eaf0f9" /></div>
                  <div class="field wide"><label for="f-welcome">Welcome message</label><input id="f-welcome" type="text" /></div>
                  <div class="field"><label for="f-promo-title">Promo title</label><input id="f-promo-title" type="text" /></div>
                  <div class="field"><label for="f-promo-text">Promo text</label><input id="f-promo-text" type="text" /></div>
                  <div class="field"><label for="f-video">YouTube/Vimeo URL</label><input id="f-video" type="url" /></div>
                  <div class="field"><label for="f-cta-label">CTA label</label><input id="f-cta-label" type="text" /></div>
                  <div class="field"><label for="f-cta-url">CTA URL</label><input id="f-cta-url" type="url" /></div>
                </div>
              </details>
              <button class="btn create-final" type="submit">Create drop link</button>
            </section>
            <div class="msg-err" id="create-err"></div>
          </form>

          <section id="create-success" class="grad-border create-success hidden" aria-live="polite">
            <div class="create-success-inner">
              <span class="success-check"><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg></span>
              <p class="eyebrow">ready to share</p><h2>Your drop link is live</h2>
              <code id="create-success-url"></code>
              <div><button class="btn" id="create-copy" type="button">Copy URL</button><button class="btn ghost" id="create-qr" type="button">Show QR</button><button class="mini" id="create-another" type="button">Create another</button></div>
            </div>
          </section>
        </div>
      </section>
```
**Verify:** Step 1 contains only label/destination and can submit immediately; Step 2 holds optional protections; all pre-existing field IDs consumed by `createLink()` still exist exactly once.

---

### Change 3: Wire two-step controls, presets, expired group, and Drive picker once
**File:** `public/admin.js`
**Why:** All behavior stays in the existing admin controller and uses the real folder endpoint from plan 09.
**Locate:**
```js
  $("refresh").addEventListener("click", refreshAll);
  $("live-refresh")?.addEventListener("click", refreshAll);
  $("create").addEventListener("click", createLink);
  $("share-create")?.addEventListener("click", createShare);
  $("logout")?.addEventListener("click", logout);
```
**Action:** REPLACE
**Old code:**
```js
  $("refresh").addEventListener("click", refreshAll);
  $("live-refresh")?.addEventListener("click", refreshAll);
  $("create").addEventListener("click", createLink);
  $("share-create")?.addEventListener("click", createShare);
  $("logout")?.addEventListener("click", logout);
```
**New code:**
```js
  $("refresh").addEventListener("click", refreshAll);
  $("live-refresh")?.addEventListener("click", refreshAll);
  $("drop-create-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    createLink();
  });
  $("create-next")?.addEventListener("click", () => showCreateStep(2));
  $("create-back")?.addEventListener("click", () => showCreateStep(1));
  $("folder-browse")?.addEventListener("click", () => openFolderPicker("root", "Drive root"));
  $("folder-up")?.addEventListener("click", () => openFolderPicker("root", "Drive root"));
  $("expired-links-toggle")?.addEventListener("click", toggleExpiredLinks);
  document.querySelectorAll('[name="transfer-preset"]').forEach((radio) => radio.addEventListener("change", applyTransferPreset));
  $("create-copy")?.addEventListener("click", () => copyCreatedLink());
  $("create-qr")?.addEventListener("click", () => showQr($("create-success-url").textContent, "New drop link"));
  $("create-another")?.addEventListener("click", resetCreateFlow);
  $("share-create")?.addEventListener("click", createShare);
  $("logout")?.addEventListener("click", logout);
```
**Verify:** One listener is attached to each control at startup; Enter in `#f-label` submits the form; switching tabs does not add listeners.

---

### Change 4: Replace table-row rendering with complete link-card rendering
**File:** `public/admin.js`
**Why:** Each link needs a status/meta header, six icon actions, four real stat tiles, and a real budget bar.
**Locate:**
```js
function renderLinks(links) {
  reconcile($("rows"), links, (l) => l.slug, makeLinkRow, updateLinkRow);
}

function makeLinkRow() {
  return document.createElement("tr");
}
```
**Action:** REPLACE
**Old code:**
```js
function renderLinks(links) {
  reconcile($("rows"), links, (l) => l.slug, makeLinkRow, updateLinkRow);
}

function makeLinkRow() {
  return document.createElement("tr");
}

function stateBadge(state) {
  if (state === "paused") return `<span class="tag err">paused</span>`;
  if (state === "expired") return `<span class="tag warn">expired</span>`;
  return "";
}

function updateLinkRow(tr, l) {
  const budget = l.settings.maxTotalBytes ? `<br><span class="muted">budget ${fmtBytes(l.stats.bytes)} / ${fmtBytes(l.settings.maxTotalBytes)}</span>` : "";
  tr.innerHTML = `
    <td><b>${esc(l.label)}</b> ${stateBadge(l.state)}<br><code>/d/${esc(l.slug)}</code></td>
    <td>${l.hasPin ? "password" : "open"} - ${l.settings.concurrency}x - ${l.settings.chunkMB} MB<br>
      <span class="muted">${l.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</span></td>
    <td>${l.stats.opens} opens - ${l.stats.files} files<br><span class="muted">${fmtBytes(l.stats.bytes)}</span>${budget}</td>
    <td class="actions">
      <button class="mini" data-open-detail="${escAttr(l.slug)}" type="button">detail</button>
      <button class="mini" data-copy-link="/d/${escAttr(l.slug)}" type="button">copy</button>
      <button class="mini" data-qr-link="/d/${escAttr(l.slug)}" data-qr-label="${escAttr(l.label)}" type="button">qr</button>
      <button class="mini" data-open-folder="${escAttr(l.slug)}" type="button">folder</button>
      <button class="mini" data-pause-link="${escAttr(l.slug)}" data-paused="${l.disabled ? "1" : "0"}" type="button">${l.disabled ? "resume" : "pause"}</button>
      <button class="mini danger" data-del-link="${escAttr(l.slug)}" data-del-label="${escAttr(l.label)}" type="button">delete</button>
    </td>`;
}
```
**New code:**
```js
function renderLinks(links) {
  const active = links.filter((link) => link.state !== "expired");
  const expired = links.filter((link) => link.state === "expired");
  reconcile($("rows"), active, (link) => link.slug, makeLinkCard, updateLinkCard);
  reconcile($("expired-rows"), expired, (link) => link.slug, makeLinkCard, updateLinkCard);
  setEmpty($("rows"), active.length === 0, "No active drop links yet.");
  $("expired-links-section").classList.toggle("hidden", expired.length === 0);
  $("expired-links-count").textContent = expired.length;
}

function makeLinkCard() {
  const article = document.createElement("article");
  article.className = "link-card panel";
  return article;
}

function updateLinkCard(article, link) {
  const budgetLimit = link.settings.maxTotalBytes || 0;
  const budgetPct = budgetLimit ? Math.min(100, Math.round((link.stats.bytes / budgetLimit) * 100)) : 0;
  const expires = link.expiresAt ? `expires ${new Date(link.expiresAt).toLocaleDateString()}` : "never expires";
  const access = link.hasPin ? "PIN" : "open";
  article.className = `link-card panel ${escAttr(link.state || "active")}`;
  article.innerHTML = `
    <div class="link-card-head">
      <div><button class="link-card-title" data-open-detail="${escAttr(link.slug)}" type="button">${esc(link.label)}</button><div class="link-meta"><code>/d/${esc(link.slug)}</code><span>·</span><span>${esc(expires)}</span><span>·</span><span>${link.settings.concurrency}× parallel</span><span>·</span><span>${link.settings.chunkMB} MB chunks</span><span>·</span><span>${link.settings.perUploaderFolders ? "per-uploader folders" : "single folder"}</span></div></div>
      <span class="link-status ${escAttr(link.state || "active")}">${esc(access)}${link.state === "expired" ? " · expired" : link.disabled ? " · paused" : ""}</span>
    </div>
    <div class="link-action-row" aria-label="Actions for ${escAttr(link.label)}">
      ${linkActionButton("copy", "Copy link", `data-copy-link="/d/${escAttr(link.slug)}"`)}
      ${linkActionButton("qr", "Show QR", `data-qr-link="/d/${escAttr(link.slug)}" data-qr-label="${escAttr(link.label)}"`)}
      ${linkActionButton("folder", "Open Drive folder", `data-open-folder="${escAttr(link.slug)}"`)}
      ${linkActionButton(link.disabled ? "play" : "pause", link.disabled ? "Resume" : "Pause", `data-pause-link="${escAttr(link.slug)}" data-paused="${link.disabled ? "1" : "0"}"`)}
      ${linkActionButton("detail", "Details", `data-open-detail="${escAttr(link.slug)}"`)}
      ${linkActionButton("trash", "Delete", `data-del-link="${escAttr(link.slug)}" data-del-label="${escAttr(link.label)}"`, true)}
    </div>
    <div class="link-stat-grid">
      ${linkStat("Opens", link.stats.opens || 0)}
      ${linkStat("Sessions", link.stats.sessions || 0)}
      ${linkStat("Files", link.stats.files || 0)}
      <div class="link-stat budget ${budgetPct >= 85 ? "warn" : ""}"><span>Budget</span><b>${budgetLimit ? `${budgetPct}%` : "∞"}</b><small>${budgetLimit ? `${fmtBytes(link.stats.bytes)} of ${fmtBytes(budgetLimit)}` : `${fmtBytes(link.stats.bytes)} received`}</small>${budgetLimit ? `<div class="trail"><i style="width:${budgetPct}%"></i></div>` : ""}</div>
    </div>`;
}

function linkStat(label, value) {
  return `<div class="link-stat"><span>${esc(label)}</span><b>${esc(String(value))}</b></div>`;
}

function linkActionButton(name, label, attributes, danger = false) {
  const icons = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>',
    qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h3M14 18v3"></path></svg>',
    folder: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 4 13 8-13 8Z"></path></svg>',
    detail: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7h.01"></path></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg>',
  };
  return `<button class="link-action${danger ? " danger" : ""}" ${attributes} type="button">${icons[name]}<span>${esc(label)}</span></button>`;
}
```
**Verify:** Active links render as cards; mockup numbers are not hard-coded; expired links render only inside the collapsed group; all action attributes remain compatible with the existing delegated `handleAdminAction()`.

---

### Change 5: Add create-flow and Drive-folder helper functions
**File:** `public/admin.js`
**Why:** Implement the two-step UI, presets, success reset, expired toggle, and real Drive browsing without new pages or fake folder data.
**Locate:**
```js
async function toggleLinkPause(slug, isPaused) {
  await fetch(`/api/admin/links/${encodeURIComponent(slug)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ disabled: !isPaused }),
  });
```
**Action:** INSERT BEFORE
**New code:**
```js
let folderParentId = "root";
let folderParentLabel = "Drive root";

function showCreateStep(step) {
  if (step === 2 && !value("f-label")) {
    $("f-label").reportValidity();
    return;
  }
  $("create-step-1").classList.toggle("hidden", step !== 1);
  $("create-step-2").classList.toggle("hidden", step !== 2);
  document.querySelectorAll("[data-create-indicator]").forEach((indicator) => indicator.classList.toggle("active", Number(indicator.dataset.createIndicator) === step));
}

function applyTransferPreset(event) {
  const values = { simple: [2, 16], fast: [4, 32], aggressive: [8, 64] };
  const [concurrency, chunkMB] = values[event.target.value] || values.fast;
  $("f-conc").value = concurrency;
  $("f-chunk").value = chunkMB;
}

function toggleExpiredLinks() {
  const button = $("expired-links-toggle");
  const expanded = button.getAttribute("aria-expanded") === "true";
  button.setAttribute("aria-expanded", String(!expanded));
  $("expired-rows").classList.toggle("expanded", !expanded);
}

async function openFolderPicker(parentId, label) {
  folderParentId = parentId || "root";
  folderParentLabel = label || "Drive root";
  $("folder-picker-panel").classList.remove("hidden");
  $("folder-path").textContent = folderParentLabel;
  $("folder-list").innerHTML = '<div class="empty">Loading Drive folders…</div>';
  $("folder-err").textContent = "";
  try {
    const response = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(folderParentId)}`);
    const data = await response.json().catch(() => ({ folders: [] }));
    if (!response.ok) throw new Error(data.error || "Drive folder list failed.");
    $("folder-list").innerHTML = (data.folders || []).length
      ? data.folders.map((folder) => `<div class="folder-option"><button type="button" data-pick-folder="${escAttr(folder.id)}" data-folder-name="${escAttr(folder.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"></path></svg><span>${esc(folder.name)}</span></button><button class="mini" type="button" data-open-folder-picker="${escAttr(folder.id)}" data-folder-name="${escAttr(folder.name)}">Open</button></div>`).join("")
      : '<div class="empty">No child folders here.</div>';
    $("folder-list").querySelectorAll("[data-pick-folder]").forEach((button) => button.addEventListener("click", () => {
      $("f-folder").value = button.dataset.pickFolder;
      $("folder-path").textContent = `Selected: ${button.dataset.folderName}`;
      $("folder-picker-panel").classList.add("hidden");
    }));
    $("folder-list").querySelectorAll("[data-open-folder-picker]").forEach((button) => button.addEventListener("click", () => openFolderPicker(button.dataset.openFolderPicker, button.dataset.folderName)));
  } catch (error) {
    $("folder-list").innerHTML = "";
    $("folder-err").textContent = error.message;
  }
}

function copyCreatedLink() {
  const url = $("create-success-url").textContent;
  navigator.clipboard?.writeText(url).catch(() => {});
}

function resetCreateFlow() {
  $("drop-create-form").reset();
  $("f-conc").value = "4";
  $("f-chunk").value = "32";
  $("f-accent").value = "#2f6bff";
  $("f-bgcolor").value = "#eaf0f9";
  $("create-success").classList.add("hidden");
  $("drop-create-form").classList.remove("hidden");
  showCreateStep(1);
  $("f-label").focus();
}
```
**Verify:** Browse Drive uses only returned folder records; choosing a folder writes its real ID; presets set hidden values consumed by `createLink()`; expired group toggles without navigation.

---

### Change 6: Make `createLink()` display the inline success state
**File:** `public/admin.js`
**Why:** The mockup requires a visible real URL with Copy and QR instead of immediately switching back to the links tab.
**Locate:**
```js
async function createLink() {
  $("create-err").textContent = "";
  $("create").disabled = true;
  const gb = Number(value("f-budget-gb")) || 0;
  const body = {
```
**Action:** REPLACE
**Old code:**
```js
async function createLink() {
  $("create-err").textContent = "";
  $("create").disabled = true;
  const gb = Number(value("f-budget-gb")) || 0;
  const body = {
    label: value("f-label"),
    slug: value("f-slug"),
    pin: value("f-pin"),
    expiresDays: Number(value("f-days")) || 0,
    folderId: value("f-folder"),
    settings: {
      concurrency: Number(value("f-conc")) || 4,
      chunkMB: Number(value("f-chunk")) || 32,
      perUploaderFolders: $("f-folders").checked,
      maxTotalBytes: gb > 0 ? Math.round(gb * 1024 ** 3) : 0,
      maxTotalFiles: Number(value("f-budget-files")) || 0,
      maxSessions: Number(value("f-budget-sessions")) || 0,
    },
    notify: {
      enabled: $("f-notify").checked,
      start: $("f-notify-start").checked,
      complete: $("f-notify-complete").checked,
    },
    theme: {
      logoUrl: value("f-logo"),
      backgroundUrl: value("f-bg"),
      accentColor: value("f-accent"),
      backgroundColor: value("f-bgcolor"),
      welcome: value("f-welcome"),
      promoTitle: value("f-promo-title"),
      promoText: value("f-promo-text"),
      videoUrl: value("f-video"),
      ctaLabel: value("f-cta-label"),
      ctaUrl: value("f-cta-url"),
    },
  };
  const r = await fetch("/api/admin/links", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  $("create").disabled = false;
  const d = await r.json().catch(() => ({}));
  if (!r.ok) return ($("create-err").textContent = d.error || "failed");
  navigator.clipboard?.writeText(`${location.origin}/d/${d.slug}`).catch(() => {});
  [
    "f-label",
    "f-slug",
    "f-pin",
    "f-folder",
    "f-budget-gb",
    "f-budget-files",
    "f-budget-sessions",
    "f-logo",
    "f-bg",
    "f-welcome",
    "f-promo-title",
    "f-promo-text",
    "f-video",
    "f-cta-label",
    "f-cta-url",
  ].forEach((id) => {
    if ($(id)) $(id).value = "";
  });
  showTab("links");
  refreshAll();
  showQr(`${location.origin}/d/${d.slug}`, "Link created - URL copied to clipboard");
}
```
**New code:**
```js
async function createLink() {
  $("create-err").textContent = "";
  if (!value("f-label")) {
    $("f-label").reportValidity();
    return;
  }
  document.querySelectorAll('#drop-create-form button[type="submit"]').forEach((button) => (button.disabled = true));
  const gb = Number(value("f-budget-gb")) || 0;
  const body = {
    label: value("f-label"),
    slug: value("f-slug"),
    pin: value("f-pin"),
    expiresDays: Number(value("f-days")) || 0,
    folderId: value("f-folder"),
    settings: {
      concurrency: Number(value("f-conc")) || 4,
      chunkMB: Number(value("f-chunk")) || 32,
      perUploaderFolders: $("f-folders").checked,
      maxTotalBytes: gb > 0 ? Math.round(gb * 1024 ** 3) : 0,
      maxTotalFiles: Number(value("f-budget-files")) || 0,
      maxSessions: Number(value("f-budget-sessions")) || 0,
    },
    notify: { enabled: $("f-notify").checked, start: $("f-notify-start").checked, complete: $("f-notify-complete").checked },
    theme: {
      logoUrl: value("f-logo"), backgroundUrl: value("f-bg"), accentColor: value("f-accent"), backgroundColor: value("f-bgcolor"), welcome: value("f-welcome"), promoTitle: value("f-promo-title"), promoText: value("f-promo-text"), videoUrl: value("f-video"), ctaLabel: value("f-cta-label"), ctaUrl: value("f-cta-url"),
    },
  };
  try {
    const response = await fetch("/api/admin/links", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Could not create link.");
    const url = `${location.origin}/d/${data.slug}`;
    $("create-success-url").textContent = url;
    $("drop-create-form").classList.add("hidden");
    $("create-success").classList.remove("hidden");
    navigator.clipboard?.writeText(url).catch(() => {});
    refreshAll();
  } catch (error) {
    $("create-err").textContent = error.message;
  } finally {
    document.querySelectorAll('#drop-create-form button[type="submit"]').forEach((button) => (button.disabled = false));
  }
}
```
**Verify:** A successful response shows exactly the server-returned `/d/<slug>` URL in the success card and refreshes the real link list; failure stays in the form with the server error.

---

### Change 7: Add link-card, two-step, folder-picker, and mobile styles
**File:** `public/style.css`
**Why:** Translate `Admin Drop Links.dc.html` and PLAN.md’s new-link flow into the existing design system.
**Locate:**
```css
.event-mini-row:last-child {
  border-bottom: 0;
}
.activity-more {
  display: flex;
  margin: 22px auto 0;
}
```
**Action:** INSERT AFTER
**New code:**
```css

/* ---------- Admin Drop links + create flow v3 ---------- */
.pane-actions,
.create-quick-actions,
.create-success-inner > div:last-child {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 9px;
}
.link-card-list {
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.link-card {
  padding: 18px 20px;
}
.link-card.expired {
  opacity: 0.68;
  filter: saturate(0.75);
}
.link-card-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.link-card-title {
  border: 0;
  padding: 0;
  color: var(--ink);
  font: 700 17px var(--font-display);
  text-align: left;
  background: transparent;
  cursor: pointer;
}
.link-card-title:hover {
  color: var(--accent);
}
.link-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 6px;
  color: var(--muted);
  font: 10.5px var(--font-mono);
}
.link-status {
  align-self: flex-start;
  border-radius: 999px;
  padding: 5px 9px;
  color: var(--green);
  font: 10.5px var(--font-mono);
  background: rgba(31, 178, 122, 0.1);
}
.link-status.paused,
.link-status.expired {
  color: var(--amber);
  background: rgba(217, 138, 20, 0.1);
}
.link-action-row {
  display: flex;
  flex-wrap: wrap;
  gap: 7px;
  margin: 15px 0;
}
.link-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid rgba(12, 26, 43, 0.09);
  border-radius: 10px;
  padding: 7px 9px;
  color: var(--ink-soft);
  font: 10.5px var(--font-mono);
  background: rgba(255, 255, 255, 0.55);
  cursor: pointer;
}
.link-action:hover {
  color: var(--accent);
  border-color: rgba(47, 107, 255, 0.25);
}
.link-action.danger:hover {
  color: var(--red);
  border-color: rgba(240, 85, 107, 0.28);
}
.link-action svg,
.folder-option svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
}
.link-stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.link-stat {
  min-width: 0;
  border-radius: 13px;
  padding: 10px 12px;
  background: rgba(12, 26, 43, 0.035);
}
.link-stat span,
.link-stat small {
  display: block;
  color: var(--muted);
  font: 9.5px var(--font-mono);
  text-transform: uppercase;
}
.link-stat b {
  display: block;
  margin: 3px 0;
  font: 700 17px var(--font-display);
}
.link-stat.budget {
  background: rgba(47, 107, 255, 0.06);
}
.link-stat.budget.warn {
  color: var(--amber);
  background: rgba(217, 138, 20, 0.09);
}
.link-stat .trail {
  height: 4px;
  margin-top: 6px;
}
.expired-links {
  margin-top: 18px;
}
.expired-links-head {
  width: 100%;
  display: flex;
  justify-content: space-between;
  border: 0;
  padding: 12px 4px;
  color: var(--muted);
  font: 600 12px var(--font-mono);
  background: transparent;
  cursor: pointer;
}
.expired-links-head svg {
  transition: transform 0.18s ease;
}
.expired-links-head[aria-expanded="true"] svg {
  transform: rotate(180deg);
}
#expired-rows {
  display: none;
}
#expired-rows.expanded {
  display: flex;
}
.create-flow {
  max-width: 820px;
  margin: 0 auto;
}
.create-steps {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
  color: var(--muted);
  font: 11px var(--font-mono);
}
.create-steps i {
  height: 2px;
  background: rgba(12, 26, 43, 0.08);
}
.create-steps span.active {
  color: var(--accent);
}
.create-card {
  padding: 24px;
}
.folder-picker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 10px;
}
.folder-picker-panel {
  margin: 10px 0 16px;
  border: 1px solid rgba(47, 107, 255, 0.16);
  border-radius: 15px;
  padding: 12px;
  background: rgba(255, 255, 255, 0.58);
}
.folder-picker-head,
.folder-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.folder-picker-head {
  margin-bottom: 8px;
  color: var(--muted);
  font: 11px var(--font-mono);
}
.folder-option {
  border-top: 1px solid rgba(12, 26, 43, 0.06);
  padding: 7px 0;
}
.folder-option > button:first-child {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 0;
  color: var(--ink);
  background: transparent;
  cursor: pointer;
}
.create-enter-note {
  margin-bottom: 0;
  font: 10.5px var(--font-mono);
}
.preset-fieldset {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 9px;
  border: 0;
  margin: 18px 0;
  padding: 0;
}
.preset-fieldset legend {
  grid-column: 1 / -1;
  margin-bottom: 8px;
  font: 11px var(--font-mono);
}
.preset-card {
  border: 1px solid rgba(12, 26, 43, 0.09);
  border-radius: 14px;
  padding: 12px;
  cursor: pointer;
}
.preset-card:has(input:checked) {
  border-color: var(--accent);
  background: rgba(47, 107, 255, 0.07);
}
.preset-card input {
  accent-color: var(--accent);
}
.preset-card b,
.preset-card small {
  display: block;
  margin-left: 22px;
}
.preset-card small {
  color: var(--muted);
  font: 10px var(--font-mono);
}
.optional-advanced {
  border-top: 1px solid rgba(12, 26, 43, 0.08);
  margin-top: 18px;
  padding-top: 14px;
}
.optional-advanced summary {
  color: var(--accent);
  font-weight: 700;
  cursor: pointer;
}
.create-final {
  margin-top: 18px;
}
.create-success-inner {
  padding: 34px;
  border-radius: 22px;
  text-align: center;
  background: rgba(255, 255, 255, 0.78);
}
.create-success-inner > div:last-child {
  justify-content: center;
}
.success-check {
  width: 52px;
  height: 52px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  background: var(--grad);
}
.create-success code {
  display: block;
  overflow-wrap: anywhere;
  margin: 18px 0;
  border-radius: 14px;
  padding: 14px;
  color: var(--accent);
  background: rgba(47, 107, 255, 0.07);
}

@media (max-width: 760px) {
  .pane-actions {
    width: 100%;
  }
  .link-card-head,
  .folder-picker {
    align-items: stretch;
    grid-template-columns: 1fr;
    flex-direction: column;
  }
  .link-stat-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .link-action span {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
  }
  .preset-fieldset {
    grid-template-columns: 1fr;
  }
}
```
**Verify:** Cards match the mockup hierarchy; budget tiles become amber at 85%; create flow is centered; at ≤760px stats are two columns and cards/actions do not overflow.

---

## Placeholder data
No sample mockup link names, dates, counts, or budgets are copied. Link cards render `overview.links`; folder choices come only from `GET /api/admin/drive/folders`; success uses the slug returned by `POST /api/admin/links`. Blank folder means the existing backend auto-creates a Drive folder.

## Responsive
Change 7 owns Drop-links and create-flow stacking only. Plan 03 owns the shared bottom tab bar for all admin panes.
