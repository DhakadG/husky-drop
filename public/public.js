// Shared helpers loaded (plain <script>, no bundler) before admin.js,
// drop.js, and share.js - keeps formatting/escaping/DOM-diffing in one place
// instead of three copy-pasted versions.

function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

function escAttr(s) {
  return esc(s).replace(/`/g, "&#96;");
}

function fmtBytes(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

function fmtTime(seconds) {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtDateDMY(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return [String(date.getDate()).padStart(2, "0"), String(date.getMonth() + 1).padStart(2, "0"), date.getFullYear()].join(" ");
}

function chip(text, cls = "", iconName = "") {
  const el = document.createElement("span");
  el.className = `chip ${cls}`;
  if (iconName) {
    el.innerHTML = uiIcon(iconName, "chip-icon");
    el.append(document.createTextNode(text));
  } else {
    el.textContent = text;
  }
  return el;
}

// Exact SVG geometry from the approved UI redesign mockups. Dynamic views use
// this catalog so an icon cannot quietly drift to a substitute library glyph.
const UI_ICONS = {
  list: { mode: "stroke", body: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"></path>' },
  lock: { mode: "fill", body: '<rect x="5" y="10" width="14" height="10" rx="2.5" opacity="0.3"></rect><path d="M7 10V8a5 5 0 0 1 10 0v2h-2V8a3 3 0 0 0-6 0v2H7zm-2 2h14v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6z"></path>' },
  "lock-small": { mode: "fill", body: '<rect x="5" y="10" width="14" height="10" rx="2.5" opacity="0.4"></rect><path d="M7 10V8a5 5 0 0 1 10 0v2h-2V8a3 3 0 0 0-6 0v2H7z"></path>' },
  save: { mode: "fill", body: '<path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1zm2 2v4h8V6H7zm5 7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"></path>' },
  sliders: { mode: "stroke", body: '<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M2 14h4M10 8h4M18 16h4"></path>' },
  folder: { mode: "fill", body: '<path d="M5 7a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7z" opacity="0.4"></path><path d="M14 5h5v5h-2V8.4l-4.3 4.3-1.4-1.4L15.6 7H14V5z"></path>' },
  "folder-add": { mode: "fill", body: '<path d="M5 7a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7z" opacity="0.4"></path><path d="M12 9a1 1 0 0 1 1 1v2h2a1 1 0 1 1 0 2h-2v2a1 1 0 1 1-2 0v-2H9a1 1 0 1 1 0-2h2v-2a1 1 0 0 1 1-1z"></path>' },
  refresh: { mode: "fill", body: '<path d="M12 5a7 7 0 1 1-6.3 4h2.3A5 5 0 1 0 12 7v2.5L7.5 6 12 2.5V5z"></path>' },
  search: { mode: "fill", body: '<circle cx="10.5" cy="10.5" r="6.5" opacity="0.25"></circle><path d="M10.5 5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm0 2a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm5.8 8l4 4-1.3 1.3-4-4 1.3-1.3z"></path>' },
  chevron: { mode: "fill", body: '<path d="M12 15.5l-6-6 1.4-1.4 4.6 4.6 4.6-4.6L18 9.5l-6 6z"></path>' },
  image: { mode: "fill", body: '<rect x="3" y="4" width="18" height="16" rx="3" opacity="0.2"></rect><path d="M6 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2.5 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM6 17h12l-4.5-6-3.2 4.2-1.8-2.2L6 17z"></path>' },
  file: { mode: "fill", body: '<rect x="3" y="4" width="18" height="16" rx="3" opacity="0.2"></rect><path d="M6 5h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zm2.5 4.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM6 17h12l-4.5-6-3.2 4.2-1.8-2.2L6 17z"></path>' },
  alert: { mode: "fill", body: '<circle cx="12" cy="12" r="10" opacity="0.16"></circle><path d="M12 7a1 1 0 0 1 1 1v4.5a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm0 9.5a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4z"></path>' },
  "shield-alert": { mode: "fill", body: '<circle cx="12" cy="12" r="10" opacity="0.16"></circle><path d="M12 7a1 1 0 0 1 1 1v4.5a1 1 0 1 1-2 0V8a1 1 0 0 1 1-1zm0 9.5a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4z"></path>' },
  copy: { mode: "fill", body: '<rect x="8" y="8" width="12" height="12" rx="2.5" opacity="0.4"></rect><path d="M6 4h9a2 2 0 0 1 2 2v1h-2V6H6v9h1v2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zm4 5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 18 20h-8a1.5 1.5 0 0 1-1.5-1.5v-8A1.5 1.5 0 0 1 10 9z"></path>' },
  "copy-compact": { mode: "fill", body: '<rect x="8" y="8" width="12" height="12" rx="2.5" opacity="0.4"></rect><path d="M6 4h9a2 2 0 0 1 2 2v1h-2V6H6v9h1v2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"></path>' },
  qr: { mode: "fill", body: '<rect x="3" y="3" width="8" height="8" rx="1.5"></rect><rect x="13" y="3" width="8" height="8" rx="1.5" opacity="0.5"></rect><rect x="3" y="13" width="8" height="8" rx="1.5" opacity="0.5"></rect><rect x="13" y="13" width="3.5" height="3.5" rx="1"></rect><rect x="17.5" y="17.5" width="3.5" height="3.5" rx="1"></rect>' },
  pause: { mode: "fill", body: '<rect x="6" y="5" width="4.5" height="14" rx="1.5"></rect><rect x="13.5" y="5" width="4.5" height="14" rx="1.5" opacity="0.55"></rect>' },
  play: { mode: "fill", body: '<path d="m7 4 13 8-13 8Z"></path>' },
  detail: { mode: "fill", body: '<path d="M9 5l7 7-7 7-1.4-1.4L13.2 12 7.6 6.4 9 5z"></path>' },
  trash: { mode: "fill", body: '<path d="M9 4h6l1 2h4v2H4V6h4l1-2z"></path><path d="M6 9h12l-1 11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L6 9z" opacity="0.5"></path>' },
  share: { mode: "fill", body: '<circle cx="6" cy="12" r="2.6"></circle><circle cx="17.5" cy="6" r="2.6" opacity="0.55"></circle><circle cx="17.5" cy="18" r="2.6" opacity="0.55"></circle><path d="M8.3 10.9l6.8-3.5M8.3 13.1l6.8 3.5" stroke="currentColor" stroke-width="1.7" fill="none"></path>' },
  user: { mode: "fill", body: '<circle cx="12" cy="8" r="4" opacity="0.16"></circle><path d="M12 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6zm0 8c3.9 0 7 2 7 4.5V19H5v-1.5C5 15 8.1 13 12 13z"></path>' },
  eye: { mode: "fill", body: '<path d="M12 5c5 0 8.6 3.6 10 7-1.4 3.4-5 7-10 7S3.4 15.4 2 12c1.4-3.4 5-7 10-7z" opacity="0.2"></path><path d="M12 7c3.9 0 6.8 2.6 8 5-1.2 2.4-4.1 5-8 5s-6.8-2.6-8-5c1.2-2.4 4.1-5 8-5zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"></path>' },
  download: { mode: "stroke", body: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"></path>' },
  gallery: { mode: "fill", body: '<circle cx="12" cy="12" r="10" opacity="0.14"></circle><path d="M12 6.5a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11zm0 2.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"></path>' },
  redirect: { mode: "fill", body: '<circle cx="12" cy="12" r="10" opacity="0.12"></circle><path d="M13 6h5v5h-2V9.4l-5.3 5.3-1.4-1.4L14.6 8H13V6zM6 8h4v2H8v6h6v-2h2v4H6V8z"></path>' },
  budget: { mode: "fill", body: '<circle cx="12" cy="12" r="9" opacity="0.14"></circle><path d="M12 4a8 8 0 1 1-8 8h2a6 6 0 1 0 6-6V4z"></path>' },
  bell: { mode: "fill", body: '<path d="M12 3a6 6 0 0 1 6 6v3.5l1.7 3a1 1 0 0 1-.9 1.5H5.2a1 1 0 0 1-.9-1.5l1.7-3V9a6 6 0 0 1 6-6z" opacity="0.2"></path><path d="M12 4.5A4.5 4.5 0 0 1 16.5 9v4l1.3 2.5H6.2L7.5 13V9A4.5 4.5 0 0 1 12 4.5zM10 19h4a2 2 0 1 1-4 0z"></path>' },
  palette: { mode: "fill", body: '<circle cx="12" cy="12" r="9" opacity="0.14"></circle><path d="M12 4a8 8 0 0 1 8 8c0 1.7-1.3 3-3 3h-1.5c-.8 0-1.5.7-1.5 1.5 0 .4.1.7.4 1 .2.3.4.6.4 1 0 .8-.7 1.5-1.6 1.5A8 8 0 0 1 12 4zm-4.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM10 8.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm5 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"></path>' },
  clock: { mode: "fill", body: '<circle cx="12" cy="12" r="10" opacity="0.18"></circle><path d="M12 6a1 1 0 0 1 1 1v4.6l3 1.8a1 1 0 1 1-1 1.7l-3.5-2.1A1 1 0 0 1 11 12V7a1 1 0 0 1 1-1z"></path>' },
  smartphone: { mode: "stroke", body: '<rect x="5" y="2" width="14" height="20" rx="2" ry="2"></rect><path d="M12 18h.01"></path>' },
  laptop: { mode: "stroke", body: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><path d="M2 20h20"></path>' },
  monitor: { mode: "stroke", body: '<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><path d="M8 21h8M12 17v4"></path>' },
  terminal: { mode: "stroke", body: '<path d="m4 17 6-6-6-6M12 19h8"></path>' },
  globe: { mode: "stroke", body: '<circle cx="12" cy="12" r="10"></circle><path d="M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>' },
};

function uiIcon(name, className = "ico") {
  const definition = UI_ICONS[name];
  if (!definition) throw new Error(`Unknown icon: ${name}`);
  const modeClass = definition.mode === "fill" ? " ico-fill" : "";
  const classes = className === "ico" ? "ico" : `ico ${className}`;
  return `<svg class="${classes}${modeClass}" viewBox="0 0 24 24" aria-hidden="true">${definition.body}</svg>`;
}

// Keyed-list DOM reconciliation: creates/updates/reorders elements in
// `container` to match `items`, removing stragglers. Reuses one element per
// key across renders instead of rebuilding the DOM every time.
function reconcile(container, items, keyOf, createEl, updateEl) {
  const map = container._rows || (container._rows = new Map());
  const seen = new Set();
  let prev = null;
  for (const item of items) {
    const key = keyOf(item);
    seen.add(key);
    let el = map.get(key);
    if (!el) {
      el = createEl(item);
      map.set(key, el);
    }
    updateEl(el, item);
    if (prev) {
      if (prev.nextSibling !== el) prev.after(el);
    } else if (container.firstChild !== el) {
      container.prepend(el);
    }
    prev = el;
  }
  for (const [key, el] of map) {
    if (!seen.has(key)) {
      el.remove();
      map.delete(key);
    }
  }
}
