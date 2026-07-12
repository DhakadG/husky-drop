# Plan 02 — Persistent EXIF drawer and photographer metadata

**Files touched:** `public/share.js`, `public/style.css`, `src/share.js`, `scripts/share-viewer-test.mjs`.
**Depends on:** plan 00 icon catalog.
**New assets:** Lucide Timer, Aperture, Gauge, Pin, and PinOff from plan 00.

---

### Change 1: Separate transient open state from the pin toggle

**File:** `public/share.js`

**Why:** Toolbar activation currently acts like implicit pinning, while `closeViewerPanels()` clears it on every slide/action. Pinning must be an explicit, durable choice.

**Locate:**

```js
function closeViewerPanels(except = "") {
  if (except !== "guide") {
    viewerGuidePanel?.remove();
```

**Action:** REPLACE.

**Old code:**

```js
function closeViewerPanels(except = "") {
  if (except !== "guide") {
    viewerGuidePanel?.remove();
    viewerGuidePanel = null;
  }
  if (except !== "filmstrip") {
    stripSettingsPanel?.remove();
    stripSettingsPanel = null;
  }
  if (except !== "file-info") {
    fileInfoPinned = false;
    setFileInfoOpen(false);
  }
  syncViewerPanelState();
}
```

**New code:**

```js
function closeViewerPanels(options = {}) {
  const { except = "", forceInfo = false } = typeof options === "string" ? { except: options } : options;
  if (except !== "guide") {
    viewerGuidePanel?.remove();
    viewerGuidePanel = null;
  }
  if (except !== "filmstrip") {
    stripSettingsPanel?.remove();
    stripSettingsPanel = null;
  }
  if (except !== "motion") closeViewerMotionPanel();
  if (except !== "file-info" && (forceInfo || !fileInfoPinned)) setFileInfoOpen(false);
  if (forceInfo) setFileInfoPinned(false);
  syncViewerPanelState();
}
```

**Verify:** Generic interactions close transient File info but do not clear a deliberate pin; `forceInfo:true` closes and unpins.

---

### Change 2: Add a dedicated accessible pin control inside the drawer

**File:** `public/share.js`

**Why:** Users need to distinguish “show now” from “keep open.”

**Locate:**

```js
    fileInfoPanel.className = "pswp-file-info";
    fileInfoPanel.setAttribute("aria-label", "File info and EXIF");
    fileInfoPanel.innerHTML = `<header><div><span>File info</span><b>EXIF & attributes</b></div><button type="button" aria-label="Close file info">×</button></header><div class="pswp-file-info-body"></div>`;
```

**Action:** REPLACE.

**Old code:**

```js
    fileInfoPanel.className = "pswp-file-info";
    fileInfoPanel.setAttribute("aria-label", "File info and EXIF");
    fileInfoPanel.innerHTML = `<header><div><span>File info</span><b>EXIF & attributes</b></div><button type="button" aria-label="Close file info">×</button></header><div class="pswp-file-info-body"></div>`;
```

**New code:**

```js
    fileInfoPanel.className = "pswp-file-info";
    fileInfoPanel.setAttribute("aria-label", "File info and EXIF");
    fileInfoPanel.innerHTML = `<header><div><span>File info</span><b>EXIF & attributes</b></div><div class="pswp-file-info-actions"><button class="pswp-info-pin" type="button" aria-label="Keep info open" aria-pressed="false" title="Keep info open">${uiIcon("pin")}</button><button class="pswp-info-close" type="button" aria-label="Close file info">×</button></div></header><div class="pswp-file-info-body"></div>`;
    fileInfoPanel.querySelector(".pswp-info-pin").addEventListener("click", (event) => {
      event.stopPropagation();
      toggleFileInfoPin();
    });
```

Add these state helpers:

```js
function setFileInfoPinned(pinned) {
  fileInfoPinned = Boolean(pinned);
  const button = fileInfoPanel?.querySelector(".pswp-info-pin");
  if (button) {
    button.setAttribute("aria-pressed", String(fileInfoPinned));
    button.setAttribute("aria-label", fileInfoPinned ? "Let info auto-close" : "Keep info open");
    button.title = fileInfoPinned ? "Let info auto-close" : "Keep info open";
    button.innerHTML = uiIcon(fileInfoPinned ? "pin-off" : "pin");
  }
  pswp?.element?.classList.toggle("pswp-info-pinned", fileInfoPinned);
}

function toggleFileInfoPin() {
  if (!fileInfoPanel?.classList.contains("open")) toggleFileInfo(false, true);
  setFileInfoPinned(!fileInfoPinned);
  clearFileInfoClose();
}
```

Change toolbar activation from `toggleFileInfo(true)` to `toggleFileInfo(false)` and make the close button call `closeViewerPanels({ forceInfo:true })`.

**Verify:** The pin button changes icon, tooltip, `aria-pressed`, and drawer class; toolbar and `I` remain transient.

---

### Change 3: Preserve pinned File info across slide changes

**File:** `public/share.js`

**Why:** A photographer comparing several frames expects pinned metadata to update rather than disappear.

**Locate:**

```js
  pswp.on("change", () => {
    closeViewerPanels();
    const current = lightboxItems[pswp.currIndex];
```

**Action:** REPLACE the first line and retain the current refresh.

**Old code:**

```js
    closeViewerPanels();
```

**New code:**

```js
    closeViewerPanels({ except: fileInfoPinned ? "file-info" : "" });
```

**Verify:** Pinned drawer stays open and `refreshFileInfo(current)` replaces its content for the new slide; an unpinned drawer closes.

---

### Change 4: Add semantic exposure icons and truthful dates

**File:** `public/share.js`

**Why:** Camera settings need fast visual anchors, and EXIF capture time must remain distinct from Drive creation/modification timestamps.

**Locate:**

```js
  const general = [
    ["File name", file.name],
    ["Position", pswp ? `${pswp.currIndex + 1} / ${lightboxItems.length}` : ""],
```

**Action:** REPLACE the date rows and the `exposureSummary()` function.

**Old code:**

```js
    ["Date taken", exif.time ? formatLongDate(exif.time) : ""],
    ["Modified", file.modifiedAt ? formatLongDate(file.modifiedAt) : ""],
```

**New code:**

```js
    ["Taken (camera metadata)", exif.time ? formatLongDate(exif.time) : ""],
    ["Created in Drive", file.createdAt ? formatLongDate(file.createdAt) : ""],
    ["Modified in Drive", file.modifiedAt ? formatLongDate(file.modifiedAt) : ""],
```

**Old code:**

```js
function exposureSummary(exif) {
  const shutter = formatShutterSpeed(exif.exposureTime).split(" (")[0];
  const values = [
    ["Shutter", shutter],
    ["Aperture", exif.aperture ? `f/${exif.aperture}` : ""],
    ["Sensitivity", exif.isoSpeed ? `ISO ${exif.isoSpeed}` : ""],
  ].filter(([, value]) => value);
  if (!values.length) return "";
  return `<section class="pswp-exposure-summary" aria-label="Exposure triangle">${values.map(([label, value]) => `<div><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</section>`;
}
```

**New code:**

```js
function exposureSummary(exif) {
  const values = [
    ["timer", "Shutter", formatShutterSpeed(exif.exposureTime).split(" (")[0]],
    ["aperture", "Aperture", exif.aperture ? `f/${exif.aperture}` : ""],
    ["gauge", "ISO", exif.isoSpeed ? `ISO ${exif.isoSpeed}` : ""],
  ].filter(([, , value]) => value);
  if (!values.length) return "";
  return `<section class="pswp-exposure-summary" aria-label="Exposure triangle">${values.map(([icon, label, value]) => `<div><i>${uiIcon(icon)}</i><span>${esc(label)}</span><b>${esc(value)}</b></div>`).join("")}</section>`;
}
```

**Verify:** “Taken” is shown only from `exif.time`; Created/Modified never masquerade as capture time; exposure cards use exact Lucide icons.

---

### Change 5: Style the pin cluster and exposure cards

**File:** `public/style.css`

**Why:** Pinning needs an obvious active state and exposure cards need balanced icon/value hierarchy.

**Locate:**

```css
.pswp .pswp-file-info > header button {
  width: 34px;
```

**Action:** REPLACE the generic selector with action-cluster styles and INSERT exposure icon styles.

**New code:**

```css
.pswp .pswp-file-info-actions { display: flex; align-items: center; gap: 7px; }
.pswp .pswp-file-info-actions button {
  width: 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(132, 181, 255, 0.2);
  border-radius: 11px;
  color: #eaf2ff;
  background: rgba(255, 255, 255, 0.055);
  cursor: pointer;
}
.pswp .pswp-file-info-actions button:hover,
.pswp .pswp-info-pin[aria-pressed="true"] {
  color: #8ff6ef;
  border-color: rgba(75, 220, 214, 0.38);
  background: rgba(39, 188, 197, 0.15);
}
.pswp .pswp-info-pin .ico { width: 18px; height: 18px; }
.pswp .pswp-exposure-summary > div { grid-template-columns: 34px 1fr; grid-template-rows: auto auto; }
.pswp .pswp-exposure-summary i {
  grid-row: 1 / 3;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #87d9ff;
  background: rgba(48, 111, 255, 0.12);
}
.pswp .pswp-exposure-summary i .ico { width: 18px; height: 18px; }
```

**Verify:** Pinned state is teal and persistent; all exposure cards are equal-height and readable at 320 px drawer width.

## Backend note

`src/drive.js` already requests `imageMediaMetadata.time`, and `src/share.js` already returns it as `exif.time`; do not add a duplicate EXIF endpoint. Preserve `createdAt` and `modifiedAt` in `shareFileInfo()`.

## Tests

- Assert transient toolbar opening does not set `fileInfoPinned`.
- Assert pin survives slide change and generic `closeViewerPanels()`.
- Assert explicit close/Escape clears pin.
- Assert Date taken never falls back to Drive dates.
- Assert Timer/Aperture/Gauge definitions are used.

## Responsive and accessibility

- Drawer header actions remain at least 36 px and have visible focus rings.
- On narrow screens, pinned popovers do not cover the pin/close controls.
- `aria-pressed`, label, title, and icon update together.

## Placeholder data

Missing EXIF fields remain omitted. Do not fabricate capture dates, camera settings, or GPS data from file modification time.
