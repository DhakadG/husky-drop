import {
  TOKEN_REFRESH_MS,
  pin,
  slug,
} from "./share-state.js";
import { toast } from "./share-utils.js";
import { trackEvent } from "./share-beacon.js";

// Signed download tokens + accelerated parallel-range download.
// ---- Download tokens + accelerated parallel-range download ----

export function tokenFresh(file) {
  return file.dl && file.dlExpiresAt && file.dlExpiresAt - Date.now() > TOKEN_REFRESH_MS;
}

export async function ensureFreshDownload(file, force = false, signal) {
  if (!force && tokenFresh(file)) return file.dl;
  const r = await fetch("/api/share/refresh-dl", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ slug, pin, dl: file.dl }),
    signal,
  });
  if (!r.ok) throw new Error("download link expired");
  const d = await r.json();
  file.dl = d.dl;
  file.dlExpiresAt = d.dlExpiresAt;
  file.thumbs = d.thumbs || file.thumbs;
  file.thumbsExpireAt = d.thumbsExpireAt || file.thumbsExpireAt;
  file.thumb = file.thumbs?.base || file.thumb;
  if (file._el) {
    const a = file._el.querySelector(".g-dl");
    if (a) a.href = file.dl;
  }
  return file.dl;
}

// Always a plain anchor-click download: the browser's native progressive
// download straight to the Downloads folder, on every device, with no
// dialog of any kind - which is the universal fallback in the first place,
// so there's nothing else to fall back to. A previous version used the File
// System Access API's showSaveFilePicker() for large files to parallelize
// the transfer, but that pops a native OS "Save As" file-explorer dialog on
// every single download (Chrome/Edge only; unsupported elsewhere), which
// reads as broken compared to how downloads work on every other site.
export async function downloadFile(file) {
  trackEvent("download", file.name, { size: file.size, mime: file.mime, blocked: !!file.downloadBlocked });
  if (file.downloadBlocked) {
    toast("Download blocked", file.downloadBlockReason || "This public share blocks risky file types.", "warn");
    return;
  }
  try {
    const url = await ensureFreshDownload(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name || "";
    document.body.appendChild(a);
    a.click();
    a.remove();
    trackEvent("download_handoff", file.name, { size: file.size, mime: file.mime });
  } catch (err) {
    trackEvent("download_failed", file.name, { message: String(err.message || err).slice(0, 120) });
    toast("Download failed", String(err.message || err).slice(0, 80), "err");
  }
}
