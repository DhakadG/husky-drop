import { $, MAX_ACTIVE, uploadingList } from "./drop-state.js";
import { FAMILY, REDUCED_MOTION, fileExt, fileFamily, h, icon, midTrunc } from "./drop-utils.js";
import { shoot } from "./drop-court.js";

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
// its seat as a shot.
export function benchOnState(item, prev, next) {
  if (prev !== "uploading" || next !== "done") return;
  const i = seatOf.get(item);
  const meta = { ext: fileExt(item.file.name), family: fileFamily(item.file.name, item.file.type) };
  if (i == null) return shoot(null, meta);
  const s = seats[i];
  shoot(s.fmt.getBoundingClientRect(), meta);
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

// Dealt from the board: x eases out while y eases in, which bends the path
// into a thrown arc, then the card lands with a small squash.
function dealIn(s, n) {
  s.el.classList.remove("launched");
  if (REDUCED_MOTION.matches || !s.fmt.animate) return;
  const from = document.querySelector(".board .shooter")?.getBoundingClientRect();
  const to = s.fmt.getBoundingClientRect();
  if (!from || !to.width) return;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  const delay = n * 70;
  s.fly.animate([{ transform: `translateX(${dx}px)` }, { transform: "none" }], { duration: 560, delay, easing: "cubic-bezier(.2,.8,.3,1)", fill: "backwards" });
  s.fmt.animate(
    [
      { transform: `translateY(${dy}px) scale(.3)`, opacity: 0, easing: "cubic-bezier(.55,0,.9,.55)" },
      { opacity: 1, offset: 0.1 },
      { transform: "translateY(0) scale(1.06, .92)", offset: 0.82, easing: "cubic-bezier(.3,1.4,.5,1)" },
      { transform: "none" },
    ],
    { duration: 680, delay, fill: "backwards" },
  );
}
