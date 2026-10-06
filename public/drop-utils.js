import { $ } from "./drop-state.js";

// Toast + small helpers.
export function toast(title, message = "", tone = "") {
  const stack = $("toasts");
  if (!stack) return;
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.innerHTML = `<b></b>${message ? `<span></span>` : ""}`;
  item.querySelector("b").textContent = title;
  if (message) item.querySelector("span").textContent = message;
  stack.appendChild(item);
  requestAnimationFrame(() => item.classList.add("show"));
  setTimeout(() => {
    item.classList.remove("show");
    setTimeout(() => item.remove(), 260);
  }, 4200);
}

// fmtBytes/fmtTime/escAttr live in public.js (shared with admin.js/share.js).

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)");

// Format cards: a file reads as photo, RAW, video or other by its extension
// first (Windows hands HEIC and RAW over with an empty MIME type).
const FAMILY_EXT = {
  video: /^(mp4|mov|m4v|mkv|avi|webm|3gp|mts|m2ts|hevc|wmv|mpg|mpeg)$/,
  raw: /^(dng|cr2|cr3|nef|nrw|arw|srf|sr2|raf|orf|rw2|pef|srw|x3f|3fr|iiq|erf|kdc)$/,
  photo: /^(jpe?g|png|heic|heif|webp|avif|gif|tiff?|bmp|jxl)$/,
};
export const FAMILY = {
  photo: { icon: "image", from: "#15c0c9", to: "#0b7f8a" },
  raw: { icon: "aperture", from: "#7b6bff", to: "#4b3bc4" },
  video: { icon: "film", from: "#2f6bff", to: "#1d3fa8" },
  file: { icon: "file", from: "#64748b", to: "#334155" },
};

export function fileExt(name) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(name || "");
  return m ? m[1].toLowerCase() : "";
}

export function fileFamily(name, mime = "") {
  const ext = fileExt(name);
  for (const fam of ["video", "raw", "photo"]) if (FAMILY_EXT[fam].test(ext)) return fam;
  if (/^video\//.test(mime)) return "video";
  if (/^image\//.test(mime)) return "photo";
  return "file";
}

// "GX010294.MP4" stays whole; "IMG_20260914_183022.HEIC" keeps both ends.
export function midTrunc(name, max = 16) {
  const s = String(name || "");
  if (s.length <= max) return s;
  const keep = max - 1;
  return `${s.slice(0, Math.ceil(keep / 2))}…${s.slice(-Math.floor(keep / 2))}`;
}
