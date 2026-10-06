import { makeNet, stepNet, NET_BOTTOM } from "./drop-court-physics.js";
import { REDUCED_MOTION } from "./drop-utils.js";
import { tickShots, setShotHooks, enqueue, flushInstant, openDrive, busy, shots, pile, pops, pileExtraCount, pendingShots } from "./drop-court-shots.js";

export { pendingShots };

// The court: one fixed, click-through canvas that draws the rim and the net
// under the glass board, the shots in flight (drop-court-shots.js) and the
// files lying on the floor under the hoop. Geometry is read from the board's
// and the Drive box's boxes every frame, so scroll, resize and the phone
// layout need no special cases. Proportions follow the Figma design (board
// 560 wide, rim 264, card 110).

const STEP = 1 / 120;
let canvas;
let ctx;
let board;
let tray;
let W = 0;
let H = 0;
let dpr = 1;
const net = makeNet();
let netAwake = false;
let rimDy = 0;
let rimV = 0;
let drive = false;
let lastBoardShake = 0;
let raf = 0;
let last = 0;
let acc = 0;
let clock = 0;

export function installCourt(opts) {
  if (canvas) return;
  ({ board, tray } = opts);
  setShotHooks(courtHooks(opts));
  canvas = document.createElement("canvas");
  canvas.className = "court-canvas";
  canvas.setAttribute("aria-hidden", "true");
  document.body.appendChild(canvas);
  ctx = canvas.getContext("2d");
  resize();
  addEventListener("resize", () => {
    resize();
    kick();
  });
  addEventListener("scroll", moved, { passive: true });
  // Anything above the court changing height (a banner, the header folding,
  // web fonts arriving) moves the board without resizing it; the body's size
  // changes when that happens.
  const ro = new ResizeObserver(moved);
  ro.observe(board);
  ro.observe(document.body);
  // The header folding, or the Drive box rising, moves things without a
  // resize: read geometry every frame for a moment after either.
  const settle = new MutationObserver((changes) => {
    const opened = (m) => m.target !== tray || /open/.test(m.oldValue || "") !== tray.classList.contains("open");
    if (!changes.some((m) => m.target !== tray ? m.oldValue !== document.body.dataset.phase : opened(m))) return;
    settleUntil = performance.now() + 900;
    moved();
  });
  settle.observe(document.body, { attributes: true, attributeFilter: ["data-phase"], attributeOldValue: true });
  settle.observe(tray, { attributes: true, attributeFilter: ["class"], attributeOldValue: true });
  document.fonts?.ready.then(moved).catch(() => {});
  kick();
}

// What the court does when a shot makes, lands in the box, or hits iron or glass.
function courtHooks(opts) {
  return {
    made: (k) => opts.onMade?.(k),
    ingest: (metas, extra) => {
      tray.classList.remove("landed");
      void tray.offsetWidth;
      tray.classList.add("landed");
      opts.onIngest?.(metas, extra);
    },
    // The rim takes the hit: it dips on its spring and the net shudders.
    rim: (speed, k) => {
      rimV += Math.min(260, speed * 28 * (k > 1 ? 1.4 : 1)) * geom().s;
      shake(0.004 * speed);
    },
    // The glass shakes on a hard bank.
    board: (speed) => {
      if (speed < 2.5 || clock - lastBoardShake < 0.15 || REDUCED_MOTION.matches) return;
      lastBoardShake = clock;
      const d = Math.min(3, speed * 0.4);
      board.animate([{ transform: "none" }, { transform: `translateY(${-d}px)` }, { transform: `translateY(${d * 0.4}px)` }, { transform: "none" }], { duration: 260, easing: "ease-out" });
    },
  };
}

// A verified file (`miss`: a failed one, thrown as a brick) leaves its seat.
// `from` is the seat card's box at that moment.
export function enqueueShot(from, meta, miss = false) {
  enqueue(from, meta, miss);
  kick();
}

// The Drive box opens once enough has gone through the hoop; from then on it
// catches everything, starting with the pile on the floor.
export function setDrive(open) {
  if (!open || drive) return;
  drive = true;
  openDrive();
  kick();
}

// Where files come out of the bottom of the net (the bench is dealt from here).
export function netMouth() {
  if (!canvas) return null;
  const g = geom();
  const y = g.cy + NET_BOTTOM * g.rx + g.ry * 0.6;
  return y > -40 && y < H + 40 ? { x: g.cx, y } : null;
}

// A file falling out of the net onto the bench tugs the cords down.
export function kickNet() {
  shake(0.05, 4);
}

function shake(amount, fromRing = 1) {
  for (let i = fromRing * 14; i < net.pts.length; i++) {
    const p = net.pts[i];
    p.oy = p.y - amount * (0.6 + Math.random() * 0.8);
    p.ox = p.x - amount * (Math.random() - 0.5);
  }
  netAwake = true;
  kick();
}

function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth;
  H = innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
}

// Reading the board's box forces layout, and the scoreboard and seats write
// to the DOM every frame, so the boxes are cached and re-read only when
// something can have moved them (plus a slow refresh as a safety net).
let boxes = null;
let boxesAt = 0;
let settleUntil = 0;

function moved() {
  boxes = null;
  kick();
}

function geom() {
  const now = performance.now();
  if (!boxes || now < settleUntil || now - boxesAt > 100) {
    boxes = { r: board.getBoundingClientRect(), t: tray.getBoundingClientRect() };
    boxesAt = now;
  }
  const { r, t } = boxes;
  const rx = r.width * 0.236;
  return {
    cx: r.left + r.width / 2,
    cy: r.bottom + r.width * 0.0393 + rimDy,
    rim: rimDy,
    rx,
    ry: rx * 0.167,
    s: r.width / 560,
    boardBottom: r.bottom,
    left: r.left + 10,
    right: r.right - 10,
    floorY: t.top,
    slotX: t.left + t.width / 2,
    slotHalf: t.width * 0.26,
    H,
  };
}

function kick() {
  if (!raf && canvas) raf = requestAnimationFrame(frame);
}

function frame(now) {
  raf = 0;
  const dt = last ? Math.min(0.05, (now - last) / 1000) : STEP;
  last = now;
  acc += dt;
  const g = geom();
  // No one can see the hoop (reduced motion, or scrolled away): count, don't fly.
  const onScreen = g.cy > -g.rx * 2 && g.cy - g.rx * 2 < H;
  if (REDUCED_MOTION.matches || !onScreen) flushInstant(0);
  for (let n = 0; acc >= STEP && n < 8; n++) {
    clock += STEP;
    tick(g, STEP);
    acc -= STEP;
  }
  draw({ ...g, cy: g.cy + rimDy - g.rim });
  if (busy() || netAwake || Math.abs(rimDy) > 0.05 || Math.abs(rimV) > 0.5) raf = requestAnimationFrame(frame);
  else {
    last = 0;
    acc = 0;
  }
}

function tick(g, dt) {
  rimV += (-900 * rimDy - 16 * rimV) * dt;
  rimDy += rimV * dt;
  const colliders = [];
  tickShots(g, dt, clock, colliders);
  if (colliders.length) netAwake = true;
  if (netAwake) netAwake = stepNet(net, dt, colliders) > 1e-4 || colliders.length > 0;
}

// ---- drawing ----

function draw(g) {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const hoopVisible = g.cy + (NET_BOTTOM + 0.6) * g.rx > 0 && g.cy - g.rx < H;
  if (hoopVisible) {
    drawBracket(g);
    drawRim(g, Math.PI, 2 * Math.PI);
    drawNet(g, false);
    for (const s of shots) if (s.phase === "fly" && s.hoop) drawCard(s, g); // between the strands
    drawNet(g, true);
    drawRim(g, 0, Math.PI);
  }
  drawFloor(g);
  for (const s of shots) if (s.phase === "lift" || (s.phase === "fly" && !s.hoop)) drawCard(s, g);
  for (const p of pops) drawPop(p, g);
}

// Files on the floor under the hoop, and files dropping into the Drive box
// (clipped at its mouth, so they go in rather than over it).
function drawFloor(g) {
  if (!drive && pile.length) {
    ctx.save();
    ctx.fillStyle = "rgba(12,26,43,0.08)";
    ctx.filter = "blur(6px)";
    ctx.beginPath();
    ctx.ellipse(g.slotX, g.floorY + 4, g.rx * 1.3, 7 * g.s, 0, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }
  for (const p of pile) drawCard(p, g);
  const extra = pileExtraCount();
  if (extra && pile.length) drawBadge(g.slotX + g.rx * 0.9, g.floorY - g.rx * 0.5, `+${extra}`, g.s);
  ctx.save();
  if (drive) {
    ctx.beginPath();
    ctx.rect(0, 0, W, g.floorY);
    ctx.clip();
  }
  for (const s of shots) if (s.phase === "drop" || s.phase === "hop" || s.phase === "fade") drawCard(s, g);
  ctx.restore();
}

// Safari before 16 has no roundRect; a square corner beats a thrown error.
const roundRect = (x, y, w, h, r) => (ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h));
const project = (p, g) => [g.cx + p.x * g.rx, g.cy + p.y * g.rx + p.z * g.ry];
const easeOut = (t) => 1 - (1 - t) ** 3;

function drawNet(g, front) {
  const w = Math.max(1.2, g.rx * 0.018);
  ctx.beginPath();
  for (const [ia, ib] of net.links) {
    const a = net.pts[ia];
    const b = net.pts[ib];
    if (a.z + b.z >= 0 !== front) continue;
    const [ax, ay] = project(a, g);
    const [bx, by] = project(b, g);
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo((ax + bx) / 2, (ay + by) / 2 + 2 * g.s, bx, by);
  }
  if (front) {
    // Loose ends under the bottom ring swing with it.
    const n = net.pts.length;
    for (let i = n - 14; i < n; i++) {
      const p = net.pts[i];
      if (p.z < -0.2) continue;
      const [x, y] = project(p, g);
      const sway = (p.x - p.ox) * g.rx * 6;
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 3 * g.s + sway, y + 9 * g.s, x - g.s + sway * 1.6, y + 17 * g.s);
    }
  }
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  if (front) {
    ctx.strokeStyle = "rgba(111,129,155,0.45)";
    ctx.lineWidth = w * 2;
    ctx.stroke();
    ctx.strokeStyle = "#f8fafd";
    ctx.lineWidth = w;
    ctx.stroke();
  } else {
    ctx.strokeStyle = "rgba(179,191,208,0.9)";
    ctx.lineWidth = w * 0.75;
    ctx.stroke();
  }
}

function drawRim(g, a0, a1) {
  const front = a0 === 0;
  const grad = ctx.createLinearGradient(0, g.cy - g.ry, 0, g.cy + g.ry);
  grad.addColorStop(0, "#ffa262");
  grad.addColorStop(0.5, "#ff6b2c");
  grad.addColorStop(1, "#a83a0c");
  ctx.beginPath();
  ctx.ellipse(g.cx, g.cy, g.rx, g.ry, 0, a0, a1);
  ctx.strokeStyle = grad;
  ctx.lineWidth = g.rx * (front ? 0.076 : 0.068);
  ctx.lineCap = "round";
  ctx.stroke();
  if (!front) return;
  ctx.beginPath();
  ctx.ellipse(g.cx, g.cy - g.rx * 0.022, g.rx * 0.985, g.ry * 0.9, 0, 0.2, Math.PI - 0.2);
  ctx.strokeStyle = "rgba(255,214,176,0.85)";
  ctx.lineWidth = Math.max(1, g.rx * 0.015);
  ctx.stroke();
  // Hooks where the cords tie on.
  ctx.strokeStyle = "#c6d0dd";
  ctx.lineWidth = Math.max(1, g.rx * 0.012);
  for (let i = 0; i < 14; i++) {
    const p = net.pts[i];
    if (p.z < 0.05) continue;
    const [x, y] = project(p, g);
    ctx.beginPath();
    ctx.ellipse(x, y + g.rx * 0.045, g.rx * 0.023, g.rx * 0.038, 0, 0, 2 * Math.PI);
    ctx.stroke();
  }
}

function drawBracket(g) {
  const w = g.rx * 0.27;
  const top = g.boardBottom - 12 * g.s;
  const h = g.cy - g.ry * 0.2 - top;
  const grad = ctx.createLinearGradient(0, top, 0, top + h);
  grad.addColorStop(0, "#d4581a");
  grad.addColorStop(1, "#8f330a");
  ctx.fillStyle = grad;
  ctx.beginPath();
  roundRect(g.cx - w / 2, top, w, h, 4 * g.s);
  ctx.fill();
}

// Cards and badges are painted once into offscreen sprites (gradient, rim
// light, label and drop shadow baked in) and stamped with one drawImage per
// frame. Painting each card from scratch every frame was ~40 % of the frame
// under a burst of a thousand small files.
const sprites = new Map();
const SPRITE_SCALE = 1.6; // largest a card is ever drawn; sprites are made at this size

function cardSprite(fam, ext, g) {
  const w = g.rx * 0.83 * SPRITE_SCALE;
  const h = g.rx * 0.56 * SPRITE_SCALE;
  const key = `${fam.from}|${ext}|${Math.round(w)}|${dpr}`;
  let c = sprites.get(key);
  if (c) return c;
  const pad = Math.ceil(30 * SPRITE_SCALE * g.s);
  c = document.createElement("canvas");
  c.width = Math.ceil((w + pad * 2) * dpr);
  c.height = Math.ceil((h + pad * 2) * dpr);
  c.cssW = w + pad * 2;
  c.cssH = h + pad * 2;
  const x = c.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.translate(c.cssW / 2, c.cssH / 2);
  const r = Math.max(4, h * 0.19);
  const path = () => {
    x.beginPath();
    if (x.roundRect) x.roundRect(-w / 2, -h / 2, w, h, r);
    else x.rect(-w / 2, -h / 2, w, h);
  };
  x.shadowColor = "rgba(12,26,43,0.28)";
  x.shadowBlur = 18 * SPRITE_SCALE * g.s;
  x.shadowOffsetY = 10 * SPRITE_SCALE * g.s;
  const grad = x.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
  grad.addColorStop(0, fam.from);
  grad.addColorStop(1, fam.to);
  path();
  x.fillStyle = grad;
  x.fill();
  x.shadowColor = "transparent";
  x.save();
  path();
  x.clip();
  x.fillStyle = "rgba(255,255,255,0.18)";
  x.fillRect(-w / 2, -h / 2, w, h * 0.45);
  x.restore();
  path();
  x.lineWidth = Math.max(2, 3 * SPRITE_SCALE * g.s);
  x.strokeStyle = "#fff";
  x.stroke();
  if (ext) {
    x.fillStyle = "#fff";
    x.font = `700 ${Math.round(h * 0.3)}px Unbounded, system-ui, sans-serif`;
    x.fillText(ext, -w / 2 + w * 0.11, h * 0.3);
  }
  if (sprites.size > 120) sprites.delete(sprites.keys().next().value);
  sprites.set(key, c);
  return c;
}

function badgeSprite(text, s) {
  const key = `badge|${text}|${Math.round(s * 100)}|${dpr}`;
  let c = sprites.get(key);
  if (c) return c;
  const size = Math.round(13 * s);
  c = document.createElement("canvas");
  const m = c.getContext("2d");
  m.font = `700 ${size}px Unbounded, system-ui, sans-serif`;
  const w = m.measureText(text).width + size * 1.1;
  const hgt = size * 1.9;
  c.cssW = w + 4;
  c.cssH = hgt + 4;
  c.width = Math.ceil(c.cssW * dpr);
  c.height = Math.ceil(c.cssH * dpr);
  const x = c.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.translate(c.cssW / 2, c.cssH / 2);
  const grad = x.createLinearGradient(-w / 2, 0, w / 2, 0);
  grad.addColorStop(0, "#2f6bff");
  grad.addColorStop(1, "#15c0c9");
  x.beginPath();
  if (x.roundRect) x.roundRect(-w / 2, -hgt / 2, w, hgt, hgt / 2);
  else x.rect(-w / 2, -hgt / 2, w, hgt);
  x.fillStyle = grad;
  x.fill();
  x.lineWidth = 2;
  x.strokeStyle = "#fff";
  x.stroke();
  x.fillStyle = "#fff";
  x.font = `700 ${size}px Unbounded, system-ui, sans-serif`;
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.fillText(text, 0, 1);
  if (sprites.size > 120) sprites.delete(sprites.keys().next().value);
  sprites.set(key, c);
  return c;
}

const stamp = (c, k) => ctx.drawImage(c, (-c.cssW * k) / 2, (-c.cssH * k) / 2, c.cssW * k, c.cssH * k);

// A file card; a bundle is a small fanned stack with its count.
function drawCard(s, g) {
  const k = s.scale / SPRITE_SCALE;
  const face = cardSprite(s.fam, s.ext, g);
  ctx.save();
  ctx.globalAlpha = s.alpha ?? 1;
  ctx.translate(s.x, s.y);
  ctx.rotate((s.rot * Math.PI) / 180);
  ctx.scale(1 + (1 - (s.squash ?? 1)) * 0.6, s.squash ?? 1);
  if (s.k > 1) {
    const back = cardSprite(s.fam, "", g);
    const w = g.rx * 0.83 * s.scale;
    const h = g.rx * 0.56 * s.scale;
    for (const [dx, dy, a] of [[w * 0.12, h * 0.16, 0.14], [w * 0.06, h * 0.08, -0.08]]) {
      ctx.save();
      ctx.translate(dx, dy);
      ctx.rotate(a);
      stamp(back, k);
      ctx.restore();
    }
  }
  stamp(face, k);
  ctx.restore();
  if (s.k > 1) drawBadge(s.x + g.rx * 0.83 * s.scale * 0.45, s.y - g.rx * 0.56 * s.scale * 0.5, `×${s.k}`, g.s * Math.min(1.2, s.scale + 0.3));
}

function drawBadge(x, y, text, s) {
  const c = badgeSprite(text, Math.round(s * 10) / 10);
  ctx.save();
  ctx.translate(x, y);
  stamp(c, 1);
  ctx.restore();
}

// "+1" (or "+12" for a bundle) rising off the rim; alternate sides so a run
// of makes does not stack labels on one spot.
function drawPop(p, g) {
  const t = p.t;
  const alpha = t < 0.12 ? t / 0.12 : t > 0.75 ? Math.max(0, 1 - (t - 0.75) / 0.35) : 1;
  const k = Math.min(1, t / 0.18);
  const scale = (t < 0.18 ? 0.6 + 0.52 * easeOut(k) : 1.12 - 0.12 * Math.min(1, (t - 0.18) / 0.2)) * (1 + 0.18 * (1 - (p.bump ?? 1)));
  const x = g.cx + p.side * g.rx * 1.25;
  const y = g.cy - g.ry * 2 - 46 * g.s * easeOut(Math.min(1, t));
  const size = Math.round(g.rx * 0.3 * scale);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 ${size}px Unbounded, system-ui, sans-serif`;
  ctx.textAlign = "center";
  const grad = ctx.createLinearGradient(0, y - size, 0, y);
  grad.addColorStop(0, "#ffb547");
  grad.addColorStop(1, "#ff6b2c");
  ctx.fillStyle = grad;
  ctx.shadowColor = "rgba(255,158,51,0.5)";
  ctx.shadowBlur = 18;
  ctx.fillText(`+${p.k}`, x, y);
  ctx.restore();
}
