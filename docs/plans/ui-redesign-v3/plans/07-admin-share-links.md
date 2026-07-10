# Plan 07 — Admin Share links tab

**Files touched:** `public/admin.html`, `public/admin.js`, `public/style.css`.
**Depends on:** plan 00, plan 03 (single shared `/admin` shell), plan 04 (Activity search state), and plan 09 changes 6–13 (real view counts and viewer identities).
**New assets:** none. All icons are complete inline SVG returned by Change 3’s helper.

**Single-page constraint:** Share links remains `#tab-shares` in the existing admin document. Do not build a separate admin share page or duplicate the common sidebar/controller.

---

### Change 1: Replace the share table with cards and redesign the existing create form
**File:** `public/admin.html`
**Why:** The mockup uses analytics-rich share cards plus a clear Gallery/Redirect choice and compact toggle controls.
**Locate:**
```html
      <!-- SHARE LINKS -->
      <section id="tab-shares" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">Share links</h1><span class="muted">outbound /s/ links that give friends read access to Drive folders</span></div>
        <section class="panel">
          <div class="section-title"><h2>All shares</h2></div>
```
**Action:** REPLACE
**Old code:**
```html
      <!-- SHARE LINKS -->
      <section id="tab-shares" class="tab-pane hidden">
        <div class="pane-head"><h1 class="pane-title">Share links</h1><span class="muted">outbound /s/ links that give friends read access to Drive folders</span></div>
        <section class="panel">
          <div class="section-title"><h2>All shares</h2></div>
          <div class="table-wrap">
            <table class="links">
              <thead><tr><th>Share</th><th>Mode / folders</th><th>Activity</th><th></th></tr></thead>
              <tbody id="share-rows"></tbody>
            </table>
          </div>
        </section>
        <section class="panel">
          <div class="section-title"><h2>Create share link</h2></div>
          <div class="grid-2">
            <div class="field"><label for="s-label">Label</label><input id="s-label" type="text" placeholder="Kareri Lake - final album" /></div>
            <div class="field"><label for="s-slug">Slug (optional)</label><input id="s-slug" type="text" placeholder="kareri-album" /></div>
            <div class="field wide"><label for="s-folders">Drive folder IDs or URLs (comma separated)</label><input id="s-folders" type="text" placeholder="https://drive.google.com/drive/folders/1AbC..." /></div>
            <div class="field"><label for="s-mode">Mode</label><select id="s-mode"><option value="gallery" selected>Gallery (private, PIN + analytics)</option><option value="redirect">Redirect (public Drive link)</option></select></div>
            <div class="field"><label for="s-pin">Password / PIN (optional)</label><input id="s-pin" type="password" autocomplete="new-password" /></div>
            <div class="field"><label for="s-days">Expires in days (0 = permanent)</label><input id="s-days" type="number" min="0" max="30" value="14" /></div>
            <label class="check"><input id="s-zip" type="checkbox" checked /> Allow "download all as zip"</label>
            <label class="check"><input id="s-auth" type="checkbox" checked /> Require Google sign-in before PIN</label>
          </div>
          <button class="btn" id="share-create">Create share link</button>
          <div class="msg-err" id="share-err"></div>
        </section>
      </section>
```
**New code:**
```html
      <!-- SHARE LINKS: one pane in the shared /admin shell -->
      <section id="tab-shares" class="tab-pane hidden">
        <div class="pane-head"><div><p class="eyebrow">outbound galleries</p><h1 class="pane-title grad-text">Share links</h1><span class="muted">Private /s/ links that give selected people read access to Drive folders.</span></div></div>
        <div id="share-rows" class="share-card-list" aria-live="polite"></div>
        <section class="panel share-create-panel">
          <div class="section-title"><div><p class="eyebrow">new share</p><h2>Create share link</h2></div></div>
          <div class="grid-2">
            <div class="field"><label for="s-label">Label</label><input id="s-label" type="text" placeholder="Kareri Lake — final album" /></div>
            <div class="field"><label for="s-slug">Slug (optional)</label><input id="s-slug" type="text" placeholder="kareri-album" /></div>
            <div class="field wide"><label for="s-folders">Drive folder IDs or URLs (comma separated)</label><input id="s-folders" type="text" placeholder="https://drive.google.com/drive/folders/1AbCDefGhijkLmN" /></div>
          </div>
          <fieldset class="share-mode-fieldset">
            <legend>Visitor experience</legend>
            <label class="share-mode-card"><input type="radio" name="share-mode-choice" value="gallery" checked /><span class="share-mode-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="8" height="7" rx="1"></rect><rect x="13" y="4" width="8" height="7" rx="1"></rect><rect x="3" y="13" width="8" height="7" rx="1"></rect><rect x="13" y="13" width="8" height="7" rx="1"></rect></svg></span><span><b>Gallery</b><small>Private gallery with PIN, identity and file analytics.</small></span></label>
            <label class="share-mode-card"><input type="radio" name="share-mode-choice" value="redirect" /><span class="share-mode-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"></path><path d="M18 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h6"></path></svg></span><span><b>Redirect</b><small>Send visitors directly to a public Drive folder.</small></span></label>
          </fieldset>
          <input id="s-mode" type="hidden" value="gallery" />
          <div class="grid-2">
            <div class="field"><label for="s-pin">Password / PIN (optional)</label><input id="s-pin" type="password" autocomplete="new-password" /></div>
            <div class="field"><label for="s-days">Expires in days (0 = permanent)</label><input id="s-days" type="number" min="0" max="30" value="14" /></div>
          </div>
          <div class="share-toggle-row"><label class="toggle-chip"><input id="s-zip" type="checkbox" checked /><span>Download all as ZIP</span></label><label class="toggle-chip"><input id="s-auth" type="checkbox" checked /><span>Require Google sign-in</span></label></div>
          <button class="btn" id="share-create" type="button">Create share link</button>
          <div class="msg-err" id="share-err"></div>
        </section>
      </section>
```
**Verify:** The same `#tab-shares` contains a card list and form; every ID used by `createShare()` exists exactly once; Gallery is selected by default.

---

### Change 2: Wire radio-card mode choice
**File:** `public/admin.js`
**Why:** Preserve `createShare()`’s existing `#s-mode` read while replacing the select with accessible radio cards.
**Locate:**
```js
  $("live-refresh")?.addEventListener("click", refreshAll);
  $("create").addEventListener("click", createLink);
  $("share-create")?.addEventListener("click", createShare);
  $("logout")?.addEventListener("click", logout);
  document.addEventListener("click", handleAdminAction);
  document.querySelectorAll("[data-metric]").forEach((b) => {
    b.addEventListener("click", () => {
```
**Action:** INSERT AFTER
**New code:**
```js
  document.querySelectorAll('[name="share-mode-choice"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      $("s-mode").value = radio.value;
      const gallery = radio.value === "gallery";
      $("s-pin").disabled = !gallery;
      $("s-auth").disabled = !gallery;
      $("s-zip").disabled = !gallery;
    });
  });
```
**Verify:** Choosing Redirect writes `redirect` to `#s-mode` and disables gallery-only controls; choosing Gallery restores them.

---

### Change 3: Replace share table rows with real analytics cards
**File:** `public/admin.js`
**Why:** Cards must show mode/access, four server-derived metrics, recent real viewers, and the existing actions.
**Locate:**
```js
function renderShares(shares) {
  const box = $("share-rows");
  if (!box) return;
  reconcile(box, shares, (s) => s.slug, makeLinkRow, updateShareRow);
}
```
**Action:** REPLACE
**Old code:**
```js
function renderShares(shares) {
  const box = $("share-rows");
  if (!box) return;
  reconcile(box, shares, (s) => s.slug, makeLinkRow, updateShareRow);
}

function updateShareRow(tr, s) {
  tr.innerHTML = `
    <td><b>${esc(s.label)}</b> ${stateBadge(s.state)}<br><code>/s/${esc(s.slug)}</code></td>
    <td>${esc(s.mode)}${s.hasPin ? " - password" : ""}${s.requireAuth ? ` - <span class="tag">google sign-in</span>` : ""}<br><span class="muted">${s.folderNames.map(esc).join(", ") || "-"}</span></td>
    <td>${s.stats.opens} opens - ${s.stats.downloads} downloads<br><span class="muted">${fmtBytes(s.stats.bytes)}</span></td>
    <td class="actions">
      <button class="mini" data-copy-link="/s/${escAttr(s.slug)}" type="button">copy</button>
      <button class="mini" data-qr-link="/s/${escAttr(s.slug)}" data-qr-label="${escAttr(s.label)}" type="button">qr</button>
      <button class="mini" data-share-link="/s/${escAttr(s.slug)}" type="button">share</button>
      <button class="mini" data-toggle-share-auth="${escAttr(s.slug)}" data-auth="${s.requireAuth ? "1" : "0"}" type="button">${s.requireAuth ? "require sign-in: on" : "require sign-in: off"}</button>
      <button class="mini" data-pause-share="${escAttr(s.slug)}" data-paused="${s.disabled ? "1" : "0"}" type="button">${s.disabled ? "resume" : "pause"}</button>
      <button class="mini danger" data-del-share="${escAttr(s.slug)}" data-del-label="${escAttr(s.label)}" type="button">delete</button>
    </td>`;
}
```
**New code:**
```js
function renderShares(shares) {
  const box = $("share-rows");
  if (!box) return;
  reconcile(box, shares, (share) => share.slug, makeShareCard, updateShareCard);
  setEmpty(box, shares.length === 0, "No share links yet.");
}

function makeShareCard() {
  const article = document.createElement("article");
  article.className = "share-card panel";
  return article;
}

function updateShareCard(article, share) {
  const closes = share.expiresAt ? `closes ${new Date(share.expiresAt).toLocaleDateString()}` : "never closes";
  const access = [share.mode, share.hasPin ? "PIN" : "no PIN", share.requireAuth ? "Google sign-in" : "link access"].join(" · ");
  const viewers = (share.recentViewers || []).map((viewer) => `<span class="viewer-chip" title="${escAttr(viewer.email)}"><i>${esc(initialsOf(viewer.name || viewer.email))}</i><span>${esc(viewer.name || viewer.email)}</span></span>`).join("");
  article.className = `share-card panel ${escAttr(share.state || "active")}`;
  article.innerHTML = `
    <div class="share-card-head"><div><h2>${esc(share.label)}</h2><div class="share-mode-line"><span class="share-mode-pill">${esc(access)}</span><code>/s/${esc(share.slug)}</code></div><p>${esc((share.folderNames || []).join(" · ") || `${share.folderIds.length} Drive folder${share.folderIds.length === 1 ? "" : "s"}`)} · ${esc(closes)}</p></div><span class="link-status ${escAttr(share.state || "active")}">${esc(share.state || "active")}</span></div>
    <div class="link-action-row">
      ${shareActionButton("copy", "Copy", `data-copy-link="/s/${escAttr(share.slug)}"`)}
      ${shareActionButton("qr", "QR", `data-qr-link="/s/${escAttr(share.slug)}" data-qr-label="${escAttr(share.label)}"`)}
      ${shareActionButton("share", "Share", `data-share-link="/s/${escAttr(share.slug)}"`)}
      ${shareActionButton("user", share.requireAuth ? "Sign-in on" : "Sign-in off", `data-toggle-share-auth="${escAttr(share.slug)}" data-auth="${share.requireAuth ? "1" : "0"}"`)}
      ${shareActionButton(share.disabled ? "play" : "pause", share.disabled ? "Resume" : "Pause", `data-pause-share="${escAttr(share.slug)}" data-paused="${share.disabled ? "1" : "0"}"`)}
      ${shareActionButton("trash", "Delete", `data-del-share="${escAttr(share.slug)}" data-del-label="${escAttr(share.label)}"`, true)}
    </div>
    <div class="share-stat-grid"><div><span>Opens</span><b>${share.stats.opens || 0}</b></div><div><span>Unique viewers</span><b>${share.viewerCount || 0}</b></div><div><span>File views</span><b>${share.stats.views || 0}</b></div><div><span>Downloaded</span><b>${fmtBytes(share.stats.bytes || 0)}</b></div></div>
    <div class="recent-viewers"><div><span class="muted">Recent viewers</span><div class="viewer-chips">${viewers || '<span class="muted">No identified viewers yet.</span>'}</div></div><button class="mini" data-view-share-activity="${escAttr(share.slug)}" type="button">View activity →</button></div>`;
}

function shareActionButton(name, label, attributes, danger = false) {
  const icons = {
    copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>',
    qr: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect><path d="M14 14h3v3h-3zM18 18h3v3h-3zM18 14h3M14 18v3"></path></svg>',
    share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"></path></svg>',
    user: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"></circle><path d="M4 21a8 8 0 0 1 16 0"></path></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 4 13 8-13 8Z"></path></svg>',
    trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"></path></svg>',
  };
  return `<button class="link-action${danger ? " danger" : ""}" ${attributes} type="button">${icons[name]}<span>${esc(label)}</span></button>`;
}
```
**Verify:** Cards use `viewerCount`, `recentViewers`, and `stats.views` from plan 09; unidentified visitors do not get invented names; existing copy/QR/share/pause/delete behaviors retain their data attributes.

---

### Change 4: Make “View activity” focus the shared Activity tab
**File:** `public/admin.js`
**Why:** The share card should open the existing Activity pane already filtered to that share slug.
**Locate:**
```js
  const sauth = e.target.closest("[data-toggle-share-auth]");
  if (sauth) return toggleShareAuth(sauth.dataset.toggleShareAuth, sauth.dataset.auth === "1");
  const sdel = e.target.closest("[data-del-share]");
  if (sdel) return deleteShare(sdel.dataset.delShare, sdel.dataset.delLabel);
  const refresh = e.target.closest("[data-refresh-detail]");
  if (refresh) return refreshDetail(refresh.dataset.refreshDetail, false);
  const sync = e.target.closest("[data-sync-detail]");
```
**Action:** INSERT AFTER
**New code:**
```js
  const shareActivity = e.target.closest("[data-view-share-activity]");
  if (shareActivity) {
    activityFilter = "all";
    activityQuery = shareActivity.dataset.viewShareActivity;
    if ($("activity-query")) $("activity-query").value = activityQuery;
    document.querySelectorAll("[data-activity-filter]").forEach((button) => button.classList.toggle("active", button.dataset.activityFilter === "all"));
    renderEvents();
    return showTab("activity");
  }
```
**Verify:** View activity switches panes using `showTab("activity")`, fills the shared search input with the slug, and displays only matching real events.

---

### Change 5: Reset the visual mode choice after successful share creation
**File:** `public/admin.js`
**Why:** The form should return to its documented Gallery default after creation.
**Locate:**
```js
  if (!r.ok) return ($("share-err").textContent = d.error || "failed");
  navigator.clipboard?.writeText(`${location.origin}/s/${d.slug}`).catch(() => {});
  ["s-label", "s-slug", "s-folders", "s-pin"].forEach((id) => {
    if ($(id)) $(id).value = "";
  });
  refreshAll();
  showQr(`${location.origin}/s/${d.slug}`, "Share link created - URL copied to clipboard");
```
**Action:** REPLACE
**Old code:**
```js
  ["s-label", "s-slug", "s-folders", "s-pin"].forEach((id) => {
    if ($(id)) $(id).value = "";
  });
  refreshAll();
```
**New code:**
```js
  ["s-label", "s-slug", "s-folders", "s-pin"].forEach((id) => {
    if ($(id)) $(id).value = "";
  });
  $("s-mode").value = "gallery";
  document.querySelectorAll('[name="share-mode-choice"]').forEach((radio) => (radio.checked = radio.value === "gallery"));
  $("s-pin").disabled = false;
  $("s-auth").disabled = false;
  $("s-zip").disabled = false;
  refreshAll();
```
**Verify:** After creation, Gallery is visibly selected and gallery-only controls are enabled.

---

### Change 6: Add share-card, radio-card, viewer-chip, and mobile styles
**File:** `public/style.css`
**Why:** Match `Admin Share Links.dc.html` and retain the shared glass/gradient system.
**Locate:**
```css
.settings-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 9px;
  margin-top: 16px;
}
```
**Action:** INSERT AFTER
**New code:**
```css

/* ---------- Admin Share links v3 ---------- */
.share-card-list {
  display: flex;
  flex-direction: column;
  gap: 13px;
}
.share-card {
  padding: 19px 20px;
}
.share-card.disabled,
.share-card.expired {
  opacity: 0.68;
}
.share-card-head {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}
.share-card-head h2 {
  margin: 0;
  font: 700 17px var(--font-display);
}
.share-card-head p {
  margin: 7px 0 0;
  color: var(--muted);
  font: 10.5px var(--font-mono);
}
.share-mode-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 7px;
  margin-top: 7px;
}
.share-mode-pill {
  border-radius: 999px;
  padding: 5px 8px;
  color: var(--violet);
  font: 10px var(--font-mono);
  background: rgba(123, 107, 255, 0.1);
}
.share-stat-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
}
.share-stat-grid > div {
  border-radius: 13px;
  padding: 11px 12px;
  background: rgba(12, 26, 43, 0.035);
}
.share-stat-grid span,
.share-stat-grid b {
  display: block;
}
.share-stat-grid span {
  color: var(--muted);
  font: 9.5px var(--font-mono);
  text-transform: uppercase;
}
.share-stat-grid b {
  margin-top: 4px;
  overflow-wrap: anywhere;
  font: 700 17px var(--font-display);
}
.recent-viewers {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-top: 14px;
  border-top: 1px solid rgba(12, 26, 43, 0.06);
  padding-top: 12px;
}
.viewer-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 7px;
}
.viewer-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 999px;
  padding: 4px 8px 4px 4px;
  color: var(--ink-soft);
  font-size: 11px;
  background: rgba(255, 255, 255, 0.65);
}
.viewer-chip i {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  font: normal 9px var(--font-mono);
  background: var(--grad);
}
.share-create-panel {
  margin-top: 18px;
}
.share-mode-fieldset {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  border: 0;
  margin: 18px 0;
  padding: 0;
}
.share-mode-fieldset legend {
  margin-bottom: 8px;
  font: 11px var(--font-mono);
}
.share-mode-card {
  display: grid;
  grid-template-columns: auto auto minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  border: 1px solid rgba(12, 26, 43, 0.09);
  border-radius: 16px;
  padding: 14px;
  cursor: pointer;
}
.share-mode-card:has(input:checked) {
  border-color: var(--accent);
  background: rgba(47, 107, 255, 0.06);
}
.share-mode-card input {
  accent-color: var(--accent);
}
.share-mode-icon {
  width: 36px;
  height: 36px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 11px;
  color: var(--accent);
  background: rgba(47, 107, 255, 0.1);
}
.share-mode-icon svg {
  width: 19px;
  height: 19px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
}
.share-mode-card b,
.share-mode-card small {
  display: block;
}
.share-mode-card small {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
}
.share-toggle-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 14px 0;
}
.toggle-chip {
  border: 1px solid rgba(12, 26, 43, 0.09);
  border-radius: 999px;
  padding: 8px 11px;
  color: var(--ink-soft);
  font-size: 12px;
  background: rgba(255, 255, 255, 0.56);
}
.toggle-chip:has(input:checked) {
  color: var(--accent);
  border-color: rgba(47, 107, 255, 0.28);
  background: rgba(47, 107, 255, 0.07);
}
.toggle-chip input {
  accent-color: var(--accent);
}

@media (max-width: 760px) {
  .share-card-head,
  .recent-viewers {
    align-items: flex-start;
    flex-direction: column;
  }
  .share-stat-grid,
  .share-mode-fieldset {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .share-mode-card {
    grid-template-columns: auto minmax(0, 1fr);
  }
  .share-mode-card > input {
    position: absolute;
    opacity: 0;
  }
}
@media (max-width: 480px) {
  .share-mode-fieldset {
    grid-template-columns: 1fr;
  }
}
```
**Verify:** Desktop shows share cards with four stat tiles and viewer chips; the create form has two radio cards; at ≤760px stats remain two columns and no table exists.

---

## Placeholder data
The mockup’s viewer names and analytics are placeholders and are not copied. Plan 09 extends the real share DTO with `viewerCount`, `recentViewers[]`, and `stats.views`; old shares safely render 0 and an empty viewer message. Share creation still posts the existing real payload to `POST /api/admin/shares`.

## Responsive
Change 6 owns Share-specific cards/form stacking. Plan 03 remains the only source of the common mobile bottom tab bar.
