import { $, MAX_ACTIVE, uploadingList } from "./drop-state.js";
import { FAMILY, REDUCED_MOTION, fileExt, fileFamily, h, icon, midTrunc } from "./drop-utils.js";
import { enqueueShot, kickNet, netMouth } from "./drop-court.js";

// The bench: one seat per parallel upload lane (MAX_ACTIVE: 12 on desktop, 8
// on phones). An uploading file sits in a seat as a format card - type,
// extension, name, progress. No image previews here: decoding a dozen
// originals at once costs the uploader more than it is worth. When Drive
// confirms a file it is shot from its own seat into the hoop, and the next
// file is dealt into the seat it left.

const seats = [];
const seatOf = new Map(); // item -> seat index

export function buildBench() {
  const host = $("seats");
  if (!host || seats.length) return;
  for (let i = 0; i < MAX_ACTIVE; i++) {
    const fmt = h("div", { class: "fmt" }, h("span", { class: "fmt-glyph" }), h("span", { class: "fmt-ext" }), h("i", { class: "fmt-bar" }, h("b")), h("button", { class: "seat-x", type: "button", "data-act": "cancel", "aria-label": "Cancel this upload" }, icon("x")));
    const el = h("div", { class: "seat vacant" }, h("div", { class: "seat-fly" }, fmt), h("div", { class: "seat-name" }), h("div", { class: "seat-stat" }));
    host.appendChild(el);
    seats.push({
      el,
      fly: el.querySelector(".seat-fly"),
      fmt: el.querySelector(".fmt"),
      glyph: el.querySelector(".fmt-glyph"),
      ext: el.querySelector(".fmt-ext"),
      bar: el.querySelector(".fmt-bar b"),
      name: el.querySelector(".seat-name"),
      stat: el.querySelector(".seat-stat"),
      item: null,
      shown: null,
    });
  }
}

// For click delegation: which upload does this element belong to?
export function seatItem(target) {
  return seats.find((s) => s.el.contains(target))?.item || null;
}

// st.onState hook (drop-queue.setState): a file Drive just confirmed leaves
// its seat as a shot; one that failed for good is thrown as a brick and
// bounces off the rim (its row in the log says why).
export function benchOnState(item, prev, next) {
  if (prev !== "uploading" || !["done", "warning", "error"].includes(next)) return;
  const i = seatOf.get(item);
  const meta = { name: item.file.name, ext: fileExt(item.file.name), family: fileFamily(item.file.name, item.file.type) };
  const s = i == null ? null : seats[i];
  enqueueShot(s ? seatBox(s) : null, meta, next === "error");
  if (!s) return;
  s.el.classList.add("launched");
  setTimeout(() => s.el.classList.remove("launched"), 900);
  seatOf.delete(item);
  s.item = null;
}

export function renderBench(lanes) {
  const live = new Set(uploadingList);
  for (const [item, i] of seatOf) {
    if (live.has(item)) continue;
    seatOf.delete(item);
    seats[i].item = null;
  }
  let dealt = 0;
  for (const item of uploadingList) {
    if (seatOf.has(item)) continue;
    const s = seats.find((x) => !x.item);
    if (!s) break;
    s.item = item;
    seatOf.set(item, seats.indexOf(s));
    paintSeat(s, true);
    dealIn(s, dealt++);
  }
  seats.forEach((s, i) => paintSeat(s, i < lanes));
}

function paintSeat(s, open) {
  const it = s.item;
  s.el.classList.toggle("vacant", !it);
  if (!it) {
    if (s.shown) {
      s.shown = null;
      s.name.textContent = "";
      s.name.title = "";
      s.stat.textContent = "";
      s.el.classList.remove("verifying");
    }
    s.el.classList.toggle("idle", !open);
    s.fmt.dataset.label = open ? "open lane" : "idle lane";
    return;
  }
  s.el.classList.remove("idle");
  if (s.shown !== it) {
    s.shown = it;
    const name = it.file.name;
    const fam = FAMILY[fileFamily(name, it.file.type)];
    s.fmt.style.setProperty("--from", fam.from);
    s.fmt.style.setProperty("--to", fam.to);
    s.glyph.replaceChildren(icon(fam.icon));
    s.ext.textContent = (fileExt(name) || "file").toUpperCase().slice(0, 4);
    s.name.textContent = midTrunc(name);
    s.name.title = it.relativePath || name;
  }
  const pct = it.file.size ? Math.min(100, (it.sent / it.file.size) * 100) : 100;
  s.bar.style.width = `${pct}%`;
  const verifying = it.stat === "verifying";
  s.el.classList.toggle("verifying", verifying);
  s.stat.textContent = verifying ? "verifying in Drive" : it.stat || `${fmtBytes(it.sent)} / ${fmtBytes(it.file.size)} · ${Math.floor(pct)}%`;
}

// Dealt out of the net: a file drops from the bottom of the net and falls
// onto its seat (x drifts out while y accelerates, so the path is a real
// fall), tumbling a little and landing with a squash. A stream of tiny files
// can fill seats faster than a fall takes, so past a few at once the rest
// just settle in place.
let dealing = 0;
let lastKick = 0;
const MAX_DEALS = 6;

function dealIn(s, n) {
  s.el.classList.remove("launched");
  if (REDUCED_MOTION.matches || !s.fmt.animate) return;
  if (dealing >= MAX_DEALS) {
    s.fmt.animate([{ transform: "scale(.82)", opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 180, easing: "ease-out" });
    return;
  }
  const to = seatBox(s);
  if (!to.width) return;
  const mouth = netMouth() || centre(document.querySelector(".board .shooter")?.getBoundingClientRect());
  if (!mouth) return;
  const dx = mouth.x + (Math.random() - 0.5) * 30 - (to.left + to.width / 2);
  const dy = mouth.y - (to.top + to.height / 2);
  const delay = n * (70 + Math.random() * 50);
  const duration = 560 + Math.random() * 200 + Math.min(240, Math.abs(dy) * 0.15);
  const spin = (Math.random() - 0.5) * 70;
  dealing++;
  setTimeout(() => {
    if (Date.now() - lastKick > 120) {
      lastKick = Date.now();
      kickNet();
    }
  }, delay);
  s.fly.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration, delay, easing: "cubic-bezier(.15,.75,.35,1)", fill: "backwards" });
  const fall = s.fmt.animate(
    [
      { transform: `translateY(${dy}px) rotate(${spin}deg) scale(.42)`, opacity: 0, easing: "cubic-bezier(.5,0,.92,.55)" },
      { opacity: 1, offset: 0.08 },
      { transform: `translateY(0) rotate(${spin * -0.08}deg) scale(1.07, .9)`, offset: 0.84, easing: "cubic-bezier(.3,1.5,.5,1)" },
      { transform: "none" },
    ],
    { duration: duration + 120, delay, fill: "backwards" },
  );
  fall.finished.catch(() => {}).finally(() => dealing--);
}

// A seat's box without forcing layout on every completion: seats do not move
// within the page, so their box is kept in page coordinates and re-read at
// most twice a second (the bench can reflow when the header folds).
function seatBox(s) {
  const now = performance.now();
  if (!s.box || now - s.boxAt > 500) {
    const r = s.fmt.getBoundingClientRect();
    s.box = { left: r.left + scrollX, top: r.top + scrollY, width: r.width, height: r.height };
    s.boxAt = now;
  }
  return { left: s.box.left - scrollX, top: s.box.top - scrollY, width: s.box.width, height: s.box.height };
}

const centre = (r) => (r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null);
