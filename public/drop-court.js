import { makeNet, stepNet, shotPath, NET_BOTTOM } from "./drop-court-physics.js";
import { FAMILY, REDUCED_MOTION } from "./drop-utils.js";

// The court: one fixed, click-through canvas that draws the rim and the net
// under the glass board, and flies each verified file from its bench seat into
// the hoop and down into the Drive tray. Geometry is read from the board's box
// every frame, so scroll, resize and the phone layout need no special cases.
// Proportions come from the Figma design (board 560 wide, rim 264, card 110).

const STEP = 1 / 120;
const MAX_IN_AIR = 4; // more than this at once and the extras just count
let canvas;
let ctx;
let board;
let tray;
let slot;
let onLand = () => {};
let W = 0;
let H = 0;
let dpr = 1;
const net = makeNet();
let netAwake = false;
let rimDy = 0;
let rimV = 0;
const shots = [];
const pops = [];
let raf = 0;
let last = 0;
let acc = 0;

export function installCourt(opts) {
  if (canvas) return;
  ({ board, tray, slot } = opts);
  onLand = opts.onLand || onLand;
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
  addEventListener("scroll", kick, { passive: true });
  new ResizeObserver(kick).observe(board);
  document.fonts?.ready.then(kick);
  kick();
}

// Files already verified but still in the air: the scoreboard holds them back
// so MADE ticks when the card lands, not before it is thrown.
export const pendingShots = () => shots.length;

// `from` is the seat card's box (viewport coordinates) at the moment it verified.
export function shoot(from, { ext = "", family = "file" } = {}) {
  const g = geom();
  const onScreen = g.cy > -g.rx * 2 && g.cy - g.rx * 4 < H;
  if (!canvas || REDUCED_MOTION.matches || !onScreen || shots.length >= MAX_IN_AIR || !from?.width) {
    onLand();
    return;
  }
  shots.push({
    phase: "lift",
    t: 0,
    fx: from.left + from.width / 2,
    fy: from.top + from.height / 2,
    seatScale: from.width / (g.rx * 0.83),
    ext: (ext || "file").toUpperCase().slice(0, 4),
    fam: FAMILY[family] || FAMILY.file,
    // Off-centre shots kiss the rim before dropping, like the original design.
    kiss: Math.random() < 0.45,
    side: Math.random() < 0.5 ? -1 : 1,
    x: 0,
    y: 0,
    rot: 0,
    scale: 1,
  });
  kick();
}

function resize() {
  dpr = Math.min(2, devicePixelRatio || 1);
  W = innerWidth;
  H = innerHeight;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
}

function geom() {
  const r = board.getBoundingClientRect();
  const rx = r.width * 0.236;
  return { cx: r.left + r.width / 2, cy: r.bottom + r.width * 0.0393 + rimDy, rx, ry: rx * 0.167, boardBottom: r.bottom, s: r.width / 560 };
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
  for (let n = 0; acc >= STEP && n < 8; n++) {
    tick(g, STEP);
    acc -= STEP;
  }
  draw(geom());
  if (shots.length || pops.length || netAwake || Math.abs(rimDy) > 0.05 || Math.abs(rimV) > 0.5) raf = requestAnimationFrame(frame);
  else {
    last = 0;
    acc = 0;
  }
}

const lerp = (a, b, t) => a + (b - a) * t;
const easeOut = (t) => 1 - (1 - t) ** 3;
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function tick(g, dt) {
  rimV += (-900 * rimDy - 18 * rimV) * dt;
  rimDy += rimV * dt;
  const colliders = [];
  for (const s of [...shots]) {
    advance(s, g, dt);
    if (s.phase === "net") colliders.push(s.col);
  }
  if (netAwake) netAwake = stepNet(net, dt, colliders) > 1e-4 || colliders.length > 0;
  for (const p of [...pops]) {
    p.t += dt;
    if (p.t > 1) pops.splice(pops.indexOf(p), 1);
  }
}

function advance(s, g, dt) {
  s.t += dt;
  const cardH = g.rx * 0.56;
  if (s.phase === "lift") {
    const e = easeOut(Math.min(1, s.t / 0.16));
    s.x = s.fx;
    s.y = s.fy - 24 * e;
    s.scale = s.seatScale * (1 + 0.05 * e);
    s.rot = -6 * e;
    if (s.t < 0.16) return;
    s.phase = "air";
    s.t = 0;
    s.ax = s.x;
    s.ay = s.y;
    s.tx = g.cx + (s.kiss ? s.side * g.rx * 0.62 : 0);
    s.ty = g.cy - g.ry - cardH * 0.35;
    s.path = shotPath({ x: s.ax, y: s.ay }, { x: s.tx, y: s.ty }, Math.min(s.ay, s.ty) - Math.max(120, g.rx * 1.5));
    s.dur = 0.62 + Math.min(0.3, Math.hypot(s.tx - s.ax, s.ty - s.ay) / 2400);
  } else if (s.phase === "air") {
    const u = Math.min(1, s.t / s.dur);
    const p = s.path(u);
    s.x = p.x;
    s.y = p.y;
    s.rot = -6 - 194 * u;
    s.scale = lerp(s.seatScale * 1.05, 0.72, u);
    if (u < 1) return;
    if (s.kiss) {
      s.phase = "kiss";
      s.t = 0;
      s.kx = s.x;
      s.ky = s.y;
      jolt(g);
    } else enterNet(s, g);
  } else if (s.phase === "kiss") {
    // Off the far iron: up a little, then over into the middle.
    const k = Math.min(1, s.t / 0.2);
    s.x = lerp(s.kx, g.cx, easeInOut(k));
    s.y = s.ky - 30 * g.s * Math.sin(Math.PI * k);
    s.rot -= 90 * dt;
    if (k >= 1) enterNet(s, g);
  } else if (s.phase === "net") {
    s.vy = Math.min(s.vy + 9 * dt, 3.2);
    if (s.uy > 0.1 && s.uy < NET_BOTTOM + 0.3) s.vy *= 0.985; // the cords take some speed off
    const dy = s.vy * dt;
    s.uy += dy;
    s.ux *= 0.95;
    Object.assign(s.col, { x: s.ux, y: s.uy, dy });
    s.x = g.cx + s.ux * g.rx;
    s.y = g.cy + s.uy * g.rx;
    s.rot += (-180 - s.rot) * 0.08;
    s.scale += (0.58 - s.scale) * 0.06;
    if (s.uy > NET_BOTTOM + 0.75) {
      s.phase = "fall";
      s.vpx = s.vy * g.rx;
    }
  } else if (s.phase === "fall") {
    s.vpx += 2400 * g.s * dt;
    s.y += s.vpx * dt;
    s.x = g.cx;
    s.scale += (0.3 - s.scale) * 0.08;
    if (s.y - (cardH * s.scale) / 2 > tray.getBoundingClientRect().top) land(s);
  }
}

function enterNet(s, g) {
  s.phase = "net";
  s.ux = (s.x - g.cx) / g.rx;
  s.uy = (s.y - g.cy) / g.rx;
  s.vy = 2.6;
  s.col = { x: s.ux, y: s.uy, z: 0, r: 0.7, dy: 0 };
  netAwake = true;
  pops.push({ t: 0 });
  jolt(g);
}

function jolt(g) {
  rimV += 140 * g.s;
}

function land(s) {
  shots.splice(shots.indexOf(s), 1);
  for (const el of [slot, tray]) {
    el.classList.remove("landed");
    void el.offsetWidth;
    el.classList.add("landed");
  }
  onLand();
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
    for (const s of shots) if (s.phase === "net") drawCard(s, g);
    drawNet(g, true);
    drawRim(g, 0, Math.PI);
    const top = tray.getBoundingClientRect().top;
    for (const s of shots) {
      if (s.phase !== "fall") continue;
      // The file drops behind the tray, into its slot.
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, W, top);
      ctx.clip();
      drawCard(s, g);
      ctx.restore();
    }
  }
  for (const s of shots) if (s.phase === "lift" || s.phase === "air" || s.phase === "kiss") drawCard(s, g);
  for (const p of pops) drawPop(p, g);
}

// Safari before 16 has no roundRect; a square corner beats a thrown error.
const roundRect = (x, y, w, h, r) => (ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h));

const project = (p, g) => [g.cx + p.x * g.rx, g.cy + p.y * g.rx + p.z * g.ry];

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
    // Loose ends under the bottom ring.
    const n = net.pts.length;
    for (let i = n - 14; i < n; i++) {
      const p = net.pts[i];
      if (p.z < -0.2) continue;
      const [x, y] = project(p, g);
      ctx.moveTo(x, y);
      ctx.quadraticCurveTo(x + 3 * g.s, y + 9 * g.s, x - g.s, y + 17 * g.s);
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

function drawCard(s, g) {
  const w = g.rx * 0.83 * s.scale;
  const h = g.rx * 0.56 * s.scale;
  const r = Math.max(4, h * 0.19);
  ctx.save();
  ctx.translate(s.x, s.y);
  ctx.rotate((s.rot * Math.PI) / 180);
  ctx.shadowColor = "rgba(12,26,43,0.28)";
  ctx.shadowBlur = 18 * s.scale * g.s;
  ctx.shadowOffsetY = 10 * s.scale * g.s;
  const grad = ctx.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
  grad.addColorStop(0, s.fam.from);
  grad.addColorStop(1, s.fam.to);
  ctx.beginPath();
  roundRect(-w / 2, -h / 2, w, h, r);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.save();
  ctx.clip();
  ctx.fillStyle = "rgba(255,255,255,0.18)";
  ctx.fillRect(-w / 2, -h / 2, w, h * 0.45);
  ctx.restore();
  ctx.lineWidth = Math.max(1.5, 3 * s.scale * g.s);
  ctx.strokeStyle = "#fff";
  ctx.stroke();
  ctx.fillStyle = "#fff";
  ctx.font = `700 ${Math.round(h * 0.3)}px Unbounded, system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(s.ext, -w / 2 + w * 0.11, h * 0.3);
  ctx.restore();
}

function drawPop(p, g) {
  const t = p.t;
  const alpha = t < 0.12 ? t / 0.12 : t > 0.7 ? Math.max(0, 1 - (t - 0.7) / 0.3) : 1;
  const k = Math.min(1, t / 0.18);
  const scale = t < 0.18 ? 0.6 + 0.52 * easeOut(k) : 1.12 - 0.12 * Math.min(1, (t - 0.18) / 0.2);
  const x = g.cx + g.rx * 1.18;
  const y = g.cy - g.ry * 2 - 46 * g.s * easeOut(t);
  const size = Math.round(g.rx * 0.34 * scale);
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.font = `700 ${size}px Unbounded, system-ui, sans-serif`;
  const grad = ctx.createLinearGradient(0, y - size, 0, y);
  grad.addColorStop(0, "#ffb547");
  grad.addColorStop(1, "#ff6b2c");
  ctx.fillStyle = grad;
  ctx.shadowColor = "rgba(255,158,51,0.5)";
  ctx.shadowBlur = 18;
  ctx.fillText("+1", x, y);
  ctx.restore();
}
