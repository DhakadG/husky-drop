import { $ } from "./share-state.js";

// Small helpers shared by the share page modules.

// chip/fmtBytes/esc/escAttr live in public.js (shared with admin.js/drop.js).

export function toast(title, message = "", tone = "", sticky = false) {
  const stack = $("toasts");
  if (!stack) return null;
  const item = document.createElement("div");
  item.className = `toast ${tone}`;
  item.innerHTML = `<b></b><span></span>`;
  item.querySelector("b").textContent = title;
  item.querySelector("span").textContent = message;
  stack.appendChild(item);
  requestAnimationFrame(() => item.classList.add("show"));
  if (!sticky) {
    setTimeout(() => {
      item.classList.remove("show");
      setTimeout(() => item.remove(), 260);
    }, 4200);
  }
  return item;
}

export function fmtDur(ms) {
  const s = Math.round(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}:${String(m % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}
