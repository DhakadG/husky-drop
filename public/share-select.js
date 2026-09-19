import { createDragSelectionController } from "./share-selection-engine.js";
import {
  $,
  allowZip,
  current,
  fx,
  meta,
  pin,
  selected,
  slug,
  visibleFiles,
} from "./share-state.js";
import { toast } from "./share-utils.js";
import { trackEvent } from "./share-beacon.js";
import { downloadFormat } from "./share-download.js";

// Selection (click, drag, touch) + zip download.
// ---- Selection + zip ----

const touchSelection = createDragSelectionController({
  isSelected: (fileId) => selected.has(fileId),
  setSelected: (fileId, on) => {
    const file = visibleFiles.get(fileId);
    if (!file?._el) return;
    document.body.classList.add("drag-selecting");
    setSelection(file, file._el, on);
  },
  hitTest: (x, y) => document.elementFromPoint(x, y)?.closest(".g-card")?._file?.id || "",
  scrollBy: (delta) => window.scrollBy(0, delta),
  viewportHeight: () => window.visualViewport?.height || window.innerHeight,
  vibrate: (duration) => {
    if (typeof navigator.vibrate === "function") navigator.vibrate(duration);
  },
});

export function cancelTouchSelection() {
  touchSelection.cancel();
  document.body.classList.remove("drag-selecting");
}

export function installTouchSelection(fig, file) {
  let suppressClickUntil = 0;

  fig.addEventListener(
    "pointerdown",
    (event) => {
      if (event.pointerType !== "touch" || event.target.closest("button, a")) return;
      touchSelection.pointerDown({
        pointerId: event.pointerId,
        fileId: file.id,
        x: event.clientX,
        y: event.clientY,
        capture: (pointerId) => {
          try {
            fig.setPointerCapture(pointerId);
          } catch {}
        },
        release: (pointerId) => {
          try {
            if (fig.hasPointerCapture(pointerId)) fig.releasePointerCapture(pointerId);
          } catch {}
        },
      });
    },
    { passive: true },
  );

  fig.addEventListener(
    "pointermove",
    (event) => {
      if (event.pointerType !== "touch") return;
      const active = touchSelection.pointerMove({ pointerId: event.pointerId, x: event.clientX, y: event.clientY });
      if (active) event.preventDefault();
    },
    { passive: false },
  );

  fig.addEventListener(
    "touchmove",
    (event) => {
      if (touchSelection.isActive()) event.preventDefault();
    },
    { passive: false },
  );

  fig.addEventListener("contextmenu", (event) => {
    const fromTouch = event.pointerType === "touch" || event.sourceCapabilities?.firesTouchEvents;
    if (!fromTouch || event.target.closest("button, a")) return;
    event.preventDefault();
  });

  fig.addEventListener(
    "pointerup",
    (event) => {
      if (event.pointerType !== "touch") return;
      const wasActive = touchSelection.pointerUp(event.pointerId);
      document.body.classList.remove("drag-selecting");
      if (!wasActive) return;
      suppressClickUntil = performance.now() + 500;
      event.preventDefault();
      event.stopPropagation();
    },
    { passive: false },
  );

  const cancelPointer = () => cancelTouchSelection();
  fig.addEventListener("pointercancel", cancelPointer);
  fig.addEventListener("lostpointercapture", cancelPointer);
  fig.addEventListener(
    "click",
    (event) => {
      if (performance.now() >= suppressClickUntil) return;
      suppressClickUntil = 0;
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    true,
  );
}

function setSelection(file, fig, on) {
  const changed = selected.has(file.id) !== on;
  if (on) selected.set(file.id, file);
  else selected.delete(file.id);
  fig.classList.toggle("selected", on);
  if (changed && on) fx.pop(fig.querySelector(".g-check"));
  document.body.classList.toggle("selecting", selected.size > 0);
  updateSelInfo();
}

export function toggleSelect(file, fig) {
  setSelection(file, fig, !selected.has(file.id));
}

export function selectAll(on) {
  cancelTouchSelection();
  selected.clear();
  if (on) {
    for (const f of current?.folders || []) for (const file of f.files) selected.set(file.id, file);
  }
  document.querySelectorAll(".g-card").forEach((el) => el.classList.remove("selected"));
  if (on) document.querySelectorAll(".g-card").forEach((el) => el.classList.add("selected"));
  document.body.classList.toggle("selecting", selected.size > 0);
  updateSelInfo();
}

export function updateSelInfo() {
  const files = [...selected.values()];
  const bytes = files.reduce((t, f) => t + f.size, 0);
  $("sel-info").textContent = files.length ? `${files.length} selected - ${fmtBytes(bytes)}` : "";
  $("mobile-sel-info").textContent = files.length ? `${files.length} selected - ${fmtBytes(bytes)}` : "";
  $("select-none").classList.toggle("hidden", files.length === 0);
  $("mobile-select-bar").classList.toggle("hidden", files.length === 0);
  const btn = $("zip-btn");
  const mobileZip = $("mobile-zip");
  if (!allowZip) {
    btn.classList.add("hidden");
    mobileZip.classList.add("hidden");
    return;
  }
  btn.classList.toggle("hidden", files.length === 0);
  mobileZip.classList.toggle("hidden", files.length === 0);
  btn.textContent = files.length ? `Download ${files.length} as zip (${fmtBytes(bytes)})` : "Download zip";
  mobileZip.textContent = files.length ? `Zip ${files.length}` : "Download zip";
}

export async function downloadZip() {
  trackEvent("zip_requested", meta?.label || slug, { selected: selected.size });
  let files = [...selected.values()];
  if (!files.length) return;
  const locallyBlocked = files.filter((f) => f.downloadBlocked);
  files = files.filter((f) => !f.downloadBlocked);
  if (!files.length) {
    toast("Zip blocked", "Every selected file is blocked by the public-download safety policy.", "warn");
    return;
  }
  if (locallyBlocked.length) {
    toast("Skipped blocked files", `${locallyBlocked.length} risky file${locallyBlocked.length === 1 ? "" : "s"} excluded.`, "warn");
  }
  const bytes = files.reduce((t, f) => t + f.size, 0);

  const btn = $("zip-btn");
  btn.disabled = true;
  $("mobile-zip").disabled = true;
  const zipName = `${meta.label.replace(/[^\w-]+/g, "_") || "share"}.zip`;
  try {
    btn.textContent = "Preparing zip...";
    $("mobile-zip").textContent = "Preparing...";
    const ticket = await createServerZipTicket(files);
    if (ticket.blocked?.length) {
      toast("Skipped blocked files", `${ticket.blocked.length} risky file${ticket.blocked.length === 1 ? "" : "s"} excluded.`, "warn");
    }
    const a = document.createElement("a");
    a.href = ticket.url;
    a.download = zipName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    trackEvent("zip_started", zipName, { count: ticket.count || files.length, bytes });
    toast("Zip download started", `${ticket.count || files.length} files - ${fmtBytes(bytes)}`, "ok");
  } catch (err) {
    trackEvent("zip_failed", meta?.label || slug, { message: String(err.message || err).slice(0, 120) });
    toast(err.downloadBlocked ? "Zip blocked" : "Zip failed", String(err.message || err).slice(0, 100), "err");
  } finally {
    btn.disabled = false;
    $("mobile-zip").disabled = false;
    updateSelInfo();
  }
}

async function createServerZipTicket(files) {
  const r = await fetch("/api/share/zip-ticket", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      slug,
      pin,
      files: files.map((f) => ({ dl: f.dl, name: f.name, size: f.size, mime: f.mime })),
      format: downloadFormat(),
    }),
  });
  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const err = new Error(d.error || "server zip failed");
    err.status = r.status;
    err.downloadBlocked = r.status === 451;
    err.blocked = d.blocked || [];
    throw err;
  }
  return r.json();
}
