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

function chip(text, cls = "") {
  const el = document.createElement("span");
  el.className = `chip ${cls}`;
  el.textContent = text;
  return el;
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
