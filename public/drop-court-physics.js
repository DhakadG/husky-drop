// Pure math for the drop page's court: the basketball net as rope cloth, the
// shot's flight path, and the springs the dragged batch hangs on. No DOM, so
// scripts/drop-court-physics-test.mjs can run it under node.
//
// Net space is measured in rim radii: the rim is the unit circle at y = 0,
// x runs right, y runs down, z runs toward the viewer. drop-court.js projects
// it with the rim's ellipse, so the same net fits any board width.

export const NET_RINGS = 7;
export const NET_CORDS = 14;
// Ring radius per row: a real net tapers fast, then hangs almost straight.
const TAPER = [1, 0.91, 0.82, 0.74, 0.68, 0.645, 0.63];
export const RING_GAP = 0.197; // vertical distance between rows, in rim radii
export const NET_BOTTOM = RING_GAP * (NET_RINGS - 1);

const GRAVITY = 1.6; // rim radii / s^2; the cords are light, the shape memory does the rest
const DAMPING = 0.985;
const MEMORY = 0.015; // pull back toward the woven shape each step (stretch ~1.25x, springs back)
const SLACK = 1.15; // nylon: a cord gives 15 % before it pulls back
const FRICTION = 0.75; // share of the card's own motion a touching knot follows

export function makeNet() {
  const pts = [];
  for (let k = 0; k < NET_RINGS; k++) {
    for (let i = 0; i < NET_CORDS; i++) {
      const th = (2 * Math.PI * i) / NET_CORDS + ((k % 2) * Math.PI) / NET_CORDS;
      const x = TAPER[k] * Math.cos(th);
      const y = k * RING_GAP;
      const z = TAPER[k] * Math.sin(th);
      pts.push({ x, y, z, ox: x, oy: y, oz: z, rx: x, ry: y, rz: z, pin: k === 0 });
    }
  }
  // Diamond mesh: every knot ties to the two knots diagonally below it.
  const links = [];
  const at = (k, i) => k * NET_CORDS + ((i + NET_CORDS) % NET_CORDS);
  for (let k = 0; k < NET_RINGS - 1; k++) {
    for (let i = 0; i < NET_CORDS; i++) {
      const next = k % 2 === 0 ? [i, i - 1] : [i, i + 1];
      for (const j of next) {
        const a = at(k, i);
        const b = at(k + 1, j);
        links.push([a, b, dist(pts[a], pts[b])]);
      }
    }
  }
  return { pts, links };
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// One fixed step. Colliders are spheres {x, y, z, r, dy} in net space (the
// card falling through; dy is how far it moved down this step). Returns the
// largest movement, so callers can let the net sleep once it settles.
export function stepNet(net, dt, colliders = [], iterations = 8) {
  const g = GRAVITY * dt * dt;
  for (const p of net.pts) {
    if (p.pin) continue;
    const vx = (p.x - p.ox) * DAMPING;
    const vy = (p.y - p.oy) * DAMPING;
    const vz = (p.z - p.oz) * DAMPING;
    p.ox = p.x;
    p.oy = p.y;
    p.oz = p.z;
    p.x += vx + (p.rx - p.x) * MEMORY;
    p.y += vy + g + (p.ry - p.y) * MEMORY;
    p.z += vz + (p.rz - p.z) * MEMORY;
  }
  for (let n = 0; n < iterations; n++) {
    relaxCords(net);
    for (const c of colliders) collide(net, c, n === 0);
  }
  let moved = 0;
  for (const p of net.pts) moved = Math.max(moved, Math.abs(p.x - p.ox), Math.abs(p.y - p.oy), Math.abs(p.z - p.oz));
  return moved;
}

// Cords are rope: they resist stretching, never compression.
function relaxCords(net) {
  for (const [ia, ib, len] of net.links) {
    const a = net.pts[ia];
    const b = net.pts[ib];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz) || 1e-9;
    const max = len * SLACK;
    if (d <= max) continue;
    const f = (d - max) / d;
    const wa = a.pin ? 0 : b.pin ? 1 : 0.5;
    const wb = b.pin ? 0 : a.pin ? 1 : 0.5;
    a.x += dx * f * wa;
    a.y += dy * f * wa;
    a.z += dz * f * wa;
    b.x -= dx * f * wb;
    b.y -= dy * f * wb;
    b.z -= dz * f * wb;
  }
}

// Push knots out of the card. With `drag` (once per step) a touching knot
// also follows the card down: friction, not the push, stretches a real net.
function collide(net, c, drag) {
  for (const p of net.pts) {
    if (p.pin) continue;
    const dx = p.x - c.x;
    const dy = p.y - c.y;
    const dz = p.z - c.z;
    const d = Math.hypot(dx, dy, dz);
    if (d >= c.r || d === 0) continue;
    const f = (c.r - d) / d;
    p.x += dx * f;
    p.y += dy * f + (drag ? (c.dy || 0) * FRICTION : 0);
    p.z += dz * f;
  }
}

// Lowest point of the net right now (the stretch, in rim radii).
export function netDepth(net) {
  let y = 0;
  for (const p of net.pts) y = Math.max(y, p.y);
  return y;
}

// A thrown file: constant horizontal speed, gravity in y, so the arc is a
// parabola that peaks at `apexY` (screen space, y down). Returns position at
// u in [0, 1].
export function shotPath(from, to, apexY) {
  const top = Math.min(apexY, from.y - 1, to.y - 1);
  // y(u) = y0 + (y1 - y0) u - k u (1 - u); pick k so the minimum hits `top`.
  let lo = 0;
  let hi = 1e6;
  for (let n = 0; n < 60; n++) {
    const k = (lo + hi) / 2;
    if (minY(from.y, to.y, k) > top) lo = k;
    else hi = k;
  }
  const k = hi;
  return (u) => ({ x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u - k * u * (1 - u) });
}

function minY(y0, y1, k) {
  const u = Math.min(1, Math.max(0, 0.5 - (y1 - y0) / (2 * k)));
  return y0 + (y1 - y0) * u - k * u * (1 - u);
}

// Damped spring toward a target (the batch cards hang on these).
export function springStep(s, tx, ty, dt, { k = 420, c = 26 } = {}) {
  s.vx += (k * (tx - s.x) - c * s.vx) * dt;
  s.vy += (k * (ty - s.y) - c * s.vy) * dt;
  s.x += s.vx * dt;
  s.y += s.vy * dt;
  return s;
}
