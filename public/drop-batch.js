import { $ } from "./drop-state.js";
import { FAMILY, REDUCED_MOTION, fileExt, fileFamily, h, icon } from "./drop-utils.js";
import { springStep } from "./drop-court-physics.js";
import { filesFromDrop } from "./drop-walk.js";

// The batch: the whole page is the court, so files dropped anywhere count.
// While files are dragged in, a small stack hangs off the pointer on springs -
// each card lags the one in front, leans against the drag and swings past
// upright when the hand stops. Browsers only reveal the count and MIME types
// mid-drag, so the stack shows type colours then; on drop it "catches" with
// the real lead name, the extension tally and previews of its first three
// files (the only previews the page ever makes), and is pulled into the glass.

const CARDS = 3;
const FAN = [
  { x: 0, y: 0, r: -8 },
  { x: 7, y: 6, r: -4 },
  { x: 14, y: 12, r: 9 },
];
let el;
let cards = [];
let badge;
let chip;
let board;
let boardTitle;
let pointer = { x: 0, y: 0 };
let springs = [];
let visible = false;
let pull = null; // { x, y, t } while the stack is drawn into the board
let raf = 0;
let last = 0;
let onFiles = () => {};

export function installBatch({ boardEl, onFilesDropped }) {
  board = boardEl;
  boardTitle = $("board-title");
  onFiles = onFilesDropped;
  cards = Array.from({ length: CARDS }, () => h("div", { class: "ball-card" }, h("span", { class: "ball-ext" })));
  badge = h("span", { class: "ball-badge" });
  chip = h("div", { class: "ball-chip" }, h("b"), h("span", { class: "ball-tally" }));
  el = h("div", { class: "ball", "aria-hidden": "true" }, ...cards, badge, chip);
  document.body.appendChild(el);
  springs = [...cards, chip].map(() => ({ x: 0, y: 0, vx: 0, vy: 0, rot: 0 }));

  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
  addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (!visible) show(e);
  });
  addEventListener("dragover", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    pointer = { x: e.clientX, y: e.clientY };
    if (!visible) show(e);
    setHover(overBoard());
  });
  addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight)) hide();
  });
  addEventListener("drop", async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    setHover(false);
    pointer = { x: e.clientX, y: e.clientY };
    // filesFromDrop reads the DataTransfer before yielding and falls back to
    // the flat list if walking the folders fails.
    const collected = await filesFromDrop(e.dataTransfer);
    if (!collected.length || !onFiles(collected)) hide();
  });
}

// Called once files are accepted (drop or picker): catch, then pull in.
export function throwBatch(files) {
  if (!el || REDUCED_MOTION.matches || !files.length) return hide();
  if (!visible) {
    // Picker path: the stack comes up from under the board.
    const r = board.getBoundingClientRect();
    pointer = { x: r.left + r.width / 2, y: r.bottom + 40 };
    springs.forEach((s, i) => Object.assign(s, { x: pointer.x, y: pointer.y + 160, vx: 0, vy: -900 - i * 60 }));
    paintTypes(files.map((f) => ({ type: f.type, name: f.name })), files.length);
    show();
  }
  const lead = files[0].name;
  chip.querySelector("b").textContent = files.length > 1 ? `${lead} + ${files.length - 1} more` : lead;
  chip.querySelector(".ball-tally").textContent = tally(files);
  el.classList.add("caught");
  files.slice(0, CARDS).forEach((f, i) => paintCard(cards[i], fileFamily(f.name, f.type), fileExt(f.name)));
  files.slice(0, CARDS).forEach((f, i) => preview(f).then((canvas) => canvas && visible && cards[i].replaceChildren(canvas)));
  setTimeout(() => {
    const r = board.querySelector(".shooter").getBoundingClientRect();
    pull = { x: r.left + r.width / 2, y: r.top + r.height / 2, t: 0 };
    board.classList.add("accept");
    setTimeout(() => board.classList.remove("accept"), 700);
  }, 520);
}

function show(e) {
  visible = true;
  pull = null;
  el.classList.remove("caught");
  el.style.opacity = "";
  if (e) {
    const items = [...(e.dataTransfer?.items || [])].filter((it) => it.kind === "file");
    paintTypes(items, items.length);
    pointer = { x: e.clientX, y: e.clientY };
    springs.forEach((s) => Object.assign(s, { x: pointer.x, y: pointer.y, vx: 0, vy: 0 }));
  }
  el.classList.add("on");
  if (!REDUCED_MOTION.matches && !raf) raf = requestAnimationFrame(frame);
}

function hide() {
  visible = false;
  pull = null;
  setHover(false);
  el?.classList.remove("on", "caught");
}

function setHover(on) {
  board.classList.toggle("hover", on);
  const n = Number(badge.textContent) || 0;
  boardTitle.textContent = on ? (n ? `Release to add ${n} file${n === 1 ? "" : "s"}` : "Release to add them") : "Drop anywhere";
}

function overBoard() {
  const r = board.getBoundingClientRect();
  return pointer.x >= r.left && pointer.x <= r.right && pointer.y >= r.top && pointer.y <= r.bottom;
}

function paintTypes(items, count) {
  badge.textContent = count ? String(count) : "";
  badge.hidden = !count;
  cards.forEach((c, i) => {
    const it = items[i];
    c.hidden = !it && i > 0;
    paintCard(c, it ? fileFamily(it.name || "", it.type || "") : "file", it?.name ? fileExt(it.name) : "");
  });
  chip.querySelector("b").textContent = "";
  chip.querySelector(".ball-tally").textContent = "";
}

function paintCard(card, family, ext) {
  const fam = FAMILY[family] || FAMILY.file;
  card.style.setProperty("--from", fam.from);
  card.style.setProperty("--to", fam.to);
  if (!card.querySelector("canvas")) card.replaceChildren(h("span", { class: "ball-ext" }), icon(fam.icon, "ball-glyph"));
  const label = card.querySelector(".ball-ext");
  if (label) label.textContent = (ext || "").toUpperCase().slice(0, 4);
}

function tally(files) {
  const by = new Map();
  for (const f of files) {
    const ext = (fileExt(f.name) || "file").toUpperCase();
    by.set(ext, (by.get(ext) || 0) + 1);
  }
  const top = [...by].sort((a, b) => b[1] - a[1]);
  const shown = top.slice(0, 3).map(([ext, n]) => `${ext} ×${n}`);
  if (top.length > 3) shown.push(`+${top.length - 3} more`);
  return shown.join("  ·  ");
}

function frame(now) {
  raf = 0;
  const dt = last ? Math.min(0.033, (now - last) / 1000) : 1 / 60;
  last = now;
  // Spring chain: pointer -> card 1 -> card 2 -> card 3 -> name chip.
  let lead = pull ? { x: pull.x, y: pull.y } : { x: pointer.x - 74, y: pointer.y - 18 };
  springs.forEach((s, i) => {
    lead = follow(s, i, lead, dt);
  });
  let scale = 1;
  if (pull) {
    pull.t += dt;
    scale = Math.max(0.22, 1 - pull.t / 0.26);
    el.style.opacity = String(Math.max(0, 1 - pull.t / 0.3));
    if (pull.t > 0.3) hide();
  }
  paint(scale);
  if (visible) raf = requestAnimationFrame(frame);
  else last = 0;
}

// One link of the chain: the lead card is stiff, the rest lag. Each card
// leans against the drag (capped) and settles back to its fan angle.
function follow(s, i, lead, dt) {
  const card = i < CARDS;
  const fan = FAN[i] || { x: -4, y: 132, r: 0 };
  const tx = card ? lead.x + fan.x : springs[0].x;
  const ty = card ? lead.y + fan.y : springs[0].y + fan.y;
  const opts = i === 0 ? { k: 900, c: 55 } : { k: 420, c: 26 };
  for (let n = 0; n < 2; n++) springStep(s, tx, ty, dt / 2, opts);
  const lean = Math.max(-16, Math.min(16, -s.vx * 0.035));
  s.rot += (fan.r + lean - s.rot) * Math.min(1, dt * 14);
  return card ? { x: s.x - fan.x, y: s.y - fan.y } : lead;
}

function paint(scale) {
  springs.forEach((s, i) => {
    const node = i < CARDS ? cards[i] : chip;
    const rot = i < CARDS ? s.rot : s.rot * 0.4;
    node.style.transform = `translate3d(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px, 0) rotate(${rot.toFixed(2)}deg) scale(${scale})`;
  });
  badge.style.transform = `translate3d(${(springs[0].x + 126).toFixed(1)}px, ${(springs[0].y - 20).toFixed(1)}px, 0) scale(${scale})`;
}

// A 300 px preview of one file, or null. Images decode off the main thread
// via createImageBitmap; a video gives up a frame at 1 s. Anything slow or
// undecodable (HEIC outside Safari, RAW) keeps its format card.
async function preview(file) {
  const out = document.createElement("canvas");
  out.width = 300;
  out.height = 224;
  const ctx = out.getContext("2d");
  const cover = (src, w, h) => {
    const s = Math.max(out.width / w, out.height / h);
    ctx.drawImage(src, (out.width - w * s) / 2, (out.height - h * s) / 2, w * s, h * s);
  };
  const fam = fileFamily(file.name, file.type);
  try {
    if (fam === "photo") {
      const bmp = await withTimeout(createImageBitmap(file, { resizeWidth: 300, resizeQuality: "medium" }), 1500);
      cover(bmp, bmp.width, bmp.height);
      bmp.close?.();
      return out;
    }
    if (fam === "video") {
      const url = URL.createObjectURL(file);
      try {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.preload = "metadata";
        v.src = url;
        await withTimeout(new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = no; }), 1500);
        v.currentTime = Math.min(1, (v.duration || 2) / 2);
        await withTimeout(new Promise((ok, no) => { v.onseeked = ok; v.onerror = no; }), 1500);
        cover(v, v.videoWidth, v.videoHeight);
        return out;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch {
    // Keep the format card.
  }
  return null;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error("timeout")), ms))]);
