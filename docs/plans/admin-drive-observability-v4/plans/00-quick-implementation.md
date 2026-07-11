# Quick Admin Reliability Implementation Plan

**Goal:** Ship folder creation, shared Drive browsing, multi-folder share selection, a separate New share tab, branded confirmations, correct activity totals, reliable terminal progress, and rotated logo assets.

**Architecture:** Keep one admin page and one Drive picker state machine. Add only one new admin API operation, and extend the existing compact activity event schema rather than creating parallel storage.

## 1. Drive folder creation API

**Locate:** `src/worker.js`, the authenticated `/api/admin/drive/folders` GET route.

**Action:** Add POST dispatch beside GET and import `driveCreateFolder` plus `sanitizeFolderName`.

**Old code:**

```js
if (m === "GET" && p === "/api/admin/drive/folders") {
  // browse handler
}
```

**New code:**

```js
if (m === "GET" && p === "/api/admin/drive/folders") {
  // existing browse handler remains unchanged
}
if (m === "POST" && p === "/api/admin/drive/folders") {
  return createAdminDriveFolder(request, env);
}

async function createAdminDriveFolder(request, env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Google Drive is not configured" }, 503);
  const body = await request.json().catch(() => ({}));
  const name = sanitizeFolderName(body.name || "");
  const parentId = cleanText(body.parentId || "root", 120) || "root";
  if (!name) return json({ error: "folder name is required" }, 400);
  try {
    return json({ folder: await driveCreateFolder(env, name, parentId) }, 201);
  } catch (error) {
    return json({ error: error.message }, 502);
  }
}
```

## 2. Shared Drive picker and share builder

**Locate:** `public/admin.html`, `#tab-shares` and `#tab-create`.

**Action:** Move the share form into a new `#tab-create-share`; add one sidebar tab. Extend the existing picker panel with a create-folder toolbar. Add a share picker host containing selected-folder chips and a second view of the same controls; do not duplicate navigation logic in JavaScript.

**Old code:**

```html
<section id="tab-shares" class="tab-pane hidden">
  <div id="share-rows"></div>
  <section class="panel share-create-panel">...</section>
</section>
```

**New code:**

```html
<section id="tab-shares" class="tab-pane hidden">
  <div class="pane-actions"><button data-goto-tab="create-share">+ New share link</button></div>
  <div id="share-rows"></div>
</section>
<section id="tab-create-share" class="tab-pane hidden">
  <section class="panel share-create-panel">
    <div id="share-folder-selection" class="selected-folder-list"></div>
    <button id="share-folder-browse" type="button">Browse Drive</button>
    <!-- existing share fields and controls -->
  </section>
</section>
```

**Locate:** `public/admin.js`, the `folderParentId` picker state and `openFolderPicker()`.

**Action:** Add `folderPickerMode`, `shareSelectedFolders`, a mode-aware selection function, folder creation, and removable share chips. `openFolderPicker(parentId, mode)` remains the only browse function.

**Old code:**

```js
let folderParentId = "root";
function selectDriveFolder(id, name) {
  $("f-folder").value = id || "root";
  // drop-only selection
}
```

**New code:**

```js
let folderPickerMode = "drop";
const shareSelectedFolders = new Map();

function selectDriveFolder(id, name) {
  if (folderPickerMode === "share") {
    shareSelectedFolders.set(id, { id, name, path: folderBreadcrumbs.map((x) => x.name).join(" / ") });
    renderShareFolderSelection();
    return;
  }
  // existing drop selection
}

async function createFolderHere() {
  const name = $("folder-new-name").value.trim();
  const response = await fetch("/api/admin/drive/folders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, parentId: folderParentId }),
  });
  // surface server error; refresh the current listing on success
}
```

**Action:** `createShare()` sends `folders: [...shareSelectedFolders.keys()]` when selections exist and retains the raw-input fallback for compatibility. Successful creation clears the map and returns to `shares`.

## 3. Branded confirmation dialog

**Locate:** `public/admin.html`, immediately before `</body>`.

**Action:** Insert one accessible `<dialog id="confirm-dialog">` with title, copy, Cancel, and Confirm buttons.

**Locate:** `public/admin.js`, `deleteLink()` and `deleteShare()`.

**Action:** Replace native confirmation with awaited `confirmAction()`.

**Old code:**

```js
if (!confirm(`Delete "${label}"? Drive files stay put.`)) return;
```

**New code:**

```js
if (!(await confirmAction({
  title: `Delete ${label}?`,
  message: "Drive files stay put. The public link stops working immediately.",
  confirmLabel: "Delete link",
}))) return;
```

## 4. Activity event count and session identity

**Locate:** `src/util.js`, `normalizeEvent()` and `normalizeUploadMeta()`.

**Action:** Add bounded numeric `n` and compact session ID `si`.

**Old code:**

```js
f: cleanText(event.file || "", 160),
b: Number(event.bytes) || 0,
m: cleanText(event.message || "", 160),
si: cleanText(event.sessionId || "", 40),
```

**New code:**

```js
f: cleanText(event.file || "", 160),
b: Number(event.bytes) || 0,
n: clamp(Number(event.count) || 0, 0, 1000000),
m: cleanText(event.message || "", 160),
si: cleanText(event.sessionId || "", 80),
```

**Action:** Preserve `si` in `normalizeUploadMeta()`.

**Locate:** `public/drop.js`, `finalizeComplete()`.

**Action:** Send `sessionId` with every completion and force `sendLive(true)` after a successful terminal state change.

**Locate:** `src/worker.js`, `recordSessionStart()` and `logComplete()`.

**Action:** Store `sessionId` on start events and upload metadata.

**Locate:** `src/live.js`, `flushCompletions()`.

**Action:** Group new completion metadata by `meta.si`, then emit one numeric `count`, byte total, and real `sessionId` per session. Only use `file` for a one-file group so concurrent uploaders never collapse into the same batch label.

**Locate:** `src/live.js`, `recordSession()` when state first becomes `done`.

**Action:** Write an automatic `sessionclose` event containing `session.id`, `session.done`, `session.sent`, uploader, label, and completion message; arm the existing alarm so the event persists even when the admin never clicks Dismiss.

**Locate:** `public/admin.js`, `updateActivitySession()`, `activityCounts()`, and `activityTimelineRow()`.

**Action:** Sum `event.n || 1` for file events, compare it with the terminal `sessionclose.n`, use the larger authoritative value, and display “N files uploaded” from numeric data.

## 5. Logo rotation

**Locate:** `public/style.css`, `.brand-mark`.

**Action:** Rotate the current `-6deg` mark clockwise by exactly 90 degrees.

**Old code:**

```css
transform: rotate(-6deg);
```

**New code:**

```css
transform: rotate(84deg);
```

**Locate:** `public/favicon.svg`.

**Action:** Wrap the artwork in `<g transform="rotate(90 60 60)">`; preserve paths and gradients. Render the updated SVG to `public/favicon.png` at 120×120.

## 6. Tests and verification

**Locate:** `scripts/smoke-test.mjs` and `scripts/ui-v3-test.mjs`.

**Action:** Add tests for POST folder creation, explicit event counts/session IDs, terminal live send wiring, separate share-create tab, picker multi-select state, dialog usage, and logo rotation. Run each test before production edits and confirm it fails for the missing behavior.

**Commands:**

```powershell
node scripts/smoke-test.mjs
node scripts/ui-v3-test.mjs
npm test
npx wrangler deploy --dry-run
git diff --check
```
