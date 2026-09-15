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
