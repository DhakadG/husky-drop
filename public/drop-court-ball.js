import { NET_BOTTOM, netRadiusAt } from "./drop-court-physics.js";

// A thrown file as a ball in 3D, in rim radii: the rim is the unit circle at
// y = 0 in the x-z plane, y runs down, z runs toward the viewer, the
// backboard is the plane z = BOARD_Z behind the rim. Nothing is scripted:
// a shot is an aim, a launch speed and gravity, and what happens at the rim
// (swish, rim-in, back iron, bank off the glass, a brick) comes out of the
// collisions. No DOM, so scripts/drop-court-ball-test.mjs runs it in node.

export const BALL_R = 0.45; // a real ball is ~0.53 of the rim's radius; a flat card reads smaller
export const RIM_TUBE = 0.035;
export const BOARD_Z = -1.6; // rim centre sits 1.6 radii off the glass
export const GRAVITY = 26; // rim radii / s^2: a little slower than real, so the eye can follow
const RIM_BOUNCE = 0.55;
const BOARD_BOUNCE = 0.42; // glass deadens the ball, so a bank drops in rather than skidding out
const NET_DRAG = 3.2; // the net takes the pace off a ball passing through
const GUIDE = 4.5; // verified files are steered into the cylinder; bricks are not

// Launch from `start` so the ball passes `target` (above the rim) on its
// way down, peaking `apex` radii above the rim.
export function launch(start, target, apex, { miss = false, spin = 0, swirl = 0 } = {}) {
  const top = Math.min(start.y, target.y) - Math.max(0.2, apex);
  const vy = -Math.sqrt(2 * GRAVITY * (start.y - top));
  const tUp = -vy / GRAVITY;
  const tDown = Math.sqrt((2 * Math.max(0.01, target.y - top)) / GRAVITY);
  const t = tUp + tDown;
  return {
    x: start.x,
    y: start.y,
    z: start.z,
    vx: (target.x - start.x) / t,
    vy,
    vz: (target.z - start.z) / t,
    rot: 0,
    spin,
    swirl,
    guide: !miss,
    made: false,
    inNet: false,
    touches: 0,
    risen: false,
    age: 0,
  };
}

// The shot book. Each entry is only an aim, an arc and a spin; how it plays
// at the rim is left to the collisions, so a "back iron" really bounces off
// the back of the rim and a "bank" really comes off the glass. Angles are
// around the rim: 0 right, PI/2 front (toward the viewer), -PI/2 back.
// `rand` is injectable so the test can replay the same mix.
const between = (rand, a, b) => a + rand() * (b - a);
const onRing = (rand, angle, spread, off) => {
  const a = angle + (rand() - 0.5) * spread;
  return { x: Math.cos(a) * off, z: Math.sin(a) * off };
};
const aboveRim = (rand) => -0.15 - rand() * 0.2;
const glass = (rand, x, y) => ({ x, y, z: BOARD_Z + BALL_R - 0.05 });
const anySide = (rand) => (rand() < 0.5 ? -1 : 1);

export const SHOTS = [
  // Clean makes
  { name: "swish", weight: 4, plan: (r) => ({ target: { ...onRing(r, 0, 7, r() * 0.18), y: aboveRim(r) }, apex: between(r, 1.8, 2.6) }) },
  { name: "flat swish", weight: 1, plan: (r) => ({ target: { ...onRing(r, 0, 7, r() * 0.2), y: aboveRim(r) }, apex: between(r, 0.9, 1.2) }) },
  { name: "rainbow", weight: 1, plan: (r) => ({ target: { ...onRing(r, 0, 7, r() * 0.2), y: aboveRim(r) }, apex: between(r, 3.6, 4.6) }) },
  { name: "drop-in", weight: 1, plan: (r) => ({ target: { x: (r() - 0.5) * 0.15, y: -0.6, z: (r() - 0.5) * 0.15 }, apex: between(r, 3.4, 4.2) }) },
  { name: "backspin swish", weight: 1, plan: (r) => ({ target: { ...onRing(r, 0, 7, r() * 0.15), y: aboveRim(r) }, apex: between(r, 2, 2.6), spin: -anySide(r) * between(r, 800, 1100) }) },
  { name: "line drive", weight: 1, plan: (r) => ({ target: { ...onRing(r, 0, 7, r() * 0.2), y: -0.3 }, apex: between(r, 0.55, 0.75) }) },
  // Off the iron
  { name: "front rim roll-in", weight: 2, plan: (r) => ({ target: { ...onRing(r, Math.PI / 2, 0.6, between(r, 0.55, 0.7)), y: aboveRim(r) }, apex: between(r, 1.6, 2.4) }) },
  { name: "back iron", weight: 2, plan: (r) => ({ target: { ...onRing(r, -Math.PI / 2, 0.6, between(r, 0.55, 0.72)), y: aboveRim(r) }, apex: between(r, 2, 2.8) }) },
  { name: "left rim kiss", weight: 1, plan: (r) => ({ target: { ...onRing(r, Math.PI, 0.6, between(r, 0.55, 0.7)), y: aboveRim(r) }, apex: between(r, 1.6, 2.6) }) },
  { name: "right rim kiss", weight: 1, plan: (r) => ({ target: { ...onRing(r, 0, 0.6, between(r, 0.55, 0.7)), y: aboveRim(r) }, apex: between(r, 1.6, 2.6) }) },
  { name: "rattle", weight: 1, plan: (r) => ({ target: { ...onRing(r, 0, 7, between(r, 0.62, 0.75)), y: aboveRim(r) }, apex: between(r, 1, 1.4) }) },
  // Lands on top of the iron, soft, with sideways roll, and circles before dropping.
  { name: "roll around", weight: 1, plan: (r) => ({ target: { ...onRing(r, 0, 7, between(r, 0.92, 0.98)), y: -0.5 }, apex: between(r, 0.7, 1), swirl: anySide(r) * between(r, 2.4, 3.2) }) },
  { name: "front rim pop-up", weight: 1, plan: (r) => ({ target: { ...onRing(r, Math.PI / 2, 0.4, between(r, 0.72, 0.8)), y: aboveRim(r) }, apex: between(r, 2.6, 3.2) }) },
  // Off the glass
  { name: "bank", weight: 2, plan: (r) => ({ target: glass(r, (r() - 0.5) * 0.4, between(r, -1, -0.6)), apex: between(r, 1.6, 2.6) }) },
  // Off the near side of the square: the glass only reverses depth, so it
  // glances back toward the middle instead of carrying on past the rim.
  { name: "angle bank", weight: 1, plan: (r, from) => ({ target: glass(r, (Math.sign(from.x) || anySide(r)) * between(r, 0.5, 0.8), between(r, -0.9, -0.6)), apex: between(r, 1.6, 2.4) }) },
  { name: "high glass", weight: 1, plan: (r) => ({ target: glass(r, (r() - 0.5) * 0.5, between(r, -1.7, -1.3)), apex: between(r, 2.6, 3.4) }) },
  { name: "glass and iron", weight: 1, plan: (r) => ({ target: glass(r, (r() - 0.5) * 0.4, between(r, -0.58, -0.48)), apex: between(r, 1.8, 2.6) }) },
  { name: "lay-up", weight: 1, plan: (r) => ({ target: glass(r, anySide(r) * between(r, 0.2, 0.4), between(r, -0.85, -0.7)), apex: between(r, 0.9, 1.3) }) },
];
const BRICK = { name: "brick", plan: (r) => ({ target: { ...onRing(r, 0, 7, between(r, 1.22, 1.44)), y: aboveRim(r) }, apex: between(r, 1.5, 3.3) }) };
const TOTAL_WEIGHT = SHOTS.reduce((n, s) => n + s.weight, 0);

// `from` is where the shot starts (net space); only angle banks care.
export function planShot(rand = Math.random, { miss = false, name = "", from = { x: 0 } } = {}) {
  let shot = miss ? BRICK : SHOTS.find((s) => s.name === name);
  if (!shot) {
    let pick = rand() * TOTAL_WEIGHT;
    shot = SHOTS.find((s) => (pick -= s.weight) < 0) || SHOTS[0];
  }
  const p = shot.plan(rand, from);
  return { name: shot.name, target: p.target, apex: p.apex, spin: p.spin ?? anySide(rand) * between(rand, 120, 540), swirl: p.swirl || 0 };
}

// Advance one fixed step. Returns impact speeds so the caller can shake the
// rim and the board in proportion: { rim, board }.
export function stepBall(b, dt) {
  const hit = { rim: 0, board: 0 };
  b.age += dt;
  b.vy += GRAVITY * dt;
  const radial = Math.hypot(b.x, b.z);
  // Riding the iron (roll-around): the rim supplies the pull to the middle
  // that keeps the ball circling, and rolling friction bleeds the speed off.
  if (b.ride > 0 && radial > 0.2) {
    b.ride -= dt;
    const vt = (b.vx * -b.z + b.vz * b.x) / radial;
    const pull = (vt * vt) / radial;
    b.vx -= (b.x / radial) * pull * dt;
    b.vz -= (b.z / radial) * pull * dt;
    b.vx *= 1 - 0.7 * dt;
    b.vz *= 1 - 0.7 * dt;
    // The iron is under it: it can drift in, not roll off the outside.
    if (radial > 0.98) {
      b.x *= 0.98 / radial;
      b.z *= 0.98 / radial;
    }
  }
  // Guidance: once a verified file is coming down over the rim, a light pull
  // toward the middle. It shapes rattles into makes; it cannot fake a swish.
  if (b.guide && b.vy > 0 && b.y > -0.55 && b.y < 0.1 && radial > 0.15 && radial < 2.4) {
    b.vx -= (b.x / radial) * GUIDE * dt;
    b.vz -= (b.z / radial) * GUIDE * dt;
  }
  b.x += b.vx * dt;
  b.y += b.vy * dt;
  b.z += b.vz * dt;
  b.rot += b.spin * dt;
  if (b.y < 0) b.risen = true;
  hit.rim = collideRim(b);
  hit.board = collideBoard(b);
  throughNet(b, dt);
  return hit;
}

// The rim is a torus: find the nearest point on its centre circle and push
// the ball out along that normal, reflecting the inbound speed.
function collideRim(b) {
  const r = Math.hypot(b.x, b.z) || 1e-6;
  const qx = b.x / r;
  const qz = b.z / r;
  const dx = b.x - qx;
  const dy = b.y;
  const dz = b.z - qz;
  const d = Math.hypot(dx, dy, dz);
  const reach = BALL_R + RIM_TUBE;
  if (d >= reach || d === 0) return 0;
  const nx = dx / d;
  const ny = dy / d;
  const nz = dz / d;
  b.x += nx * (reach - d);
  b.y += ny * (reach - d);
  b.z += nz * (reach - d);
  const vn = b.vx * nx + b.vy * ny + b.vz * nz;
  if (vn >= 0) return 0;
  b.vx -= (1 + RIM_BOUNCE) * vn * nx;
  b.vy -= (1 + RIM_BOUNCE) * vn * ny;
  b.vz -= (1 + RIM_BOUNCE) * vn * nz;
  // Iron grabs: some sideways speed is lost and turned into spin.
  b.vx *= 0.88;
  b.vz *= 0.88;
  b.spin += vn * 140 * (Math.random() < 0.5 ? 1 : -1);
  b.touches++;
  // A soft, friendly rim for verified files: outward speed off the iron is
  // mostly turned back in, so a rattle rolls in instead of out.
  if (b.guide) {
    const vr = (b.vx * b.x + b.vz * b.z) / r;
    if (vr > 0) {
      b.vx -= (b.x / r) * vr * 1.6;
      b.vz -= (b.z / r) * vr * 1.6;
    }
    // A steep drop onto the iron should not skid across and out the far side.
    const hs = Math.hypot(b.vx, b.vz);
    if (hs > 2) {
      b.vx *= 2 / hs;
      b.vz *= 2 / hs;
    }
    // Caught on the outer lip: pop up and over, the way a soft rim lets a
    // ball with inward roll climb in rather than slide off the outside.
    if (r > 1 && b.y < 0.2) {
      b.vy = Math.min(b.vy, -2.4);
      b.vx -= (b.x / r) * 1.4;
      b.vz -= (b.z / r) * 1.4;
    }
  }
  // Roll-around: the first touch sends it circling the iron (after the cap,
  // so the soft rim does not cancel it).
  if (b.swirl) {
    b.vx += -qz * b.swirl;
    b.vz += qx * b.swirl;
    b.swirl = 0;
    b.ride = 0.55 + Math.random() * 0.4;
  }
  return -vn;
}

function collideBoard(b) {
  if (b.z - BALL_R > BOARD_Z || b.vz >= 0) return 0;
  if (Math.abs(b.x) > 2.6 || b.y < -5 || b.y > 0.8) return 0;
  const speed = -b.vz;
  b.z = BOARD_Z + BALL_R;
  b.vz = speed * BOARD_BOUNCE;
  b.spin *= -0.6;
  b.touches++;
  return speed;
}

// Inside the net the cords funnel the ball toward the middle and slow it.
function throughNet(b, dt) {
  const r = Math.hypot(b.x, b.z);
  b.inNet = b.y > 0 && b.y < NET_BOTTOM + 0.3 && r < 1.05;
  if (!b.inNet) return;
  if (b.y > NET_BOTTOM * 0.35) b.made = true;
  const drag = Math.max(0, 1 - NET_DRAG * dt);
  b.vx *= drag;
  b.vz *= drag;
  b.vy = Math.min(b.vy, 6) * Math.max(0, 1 - NET_DRAG * 0.35 * dt);
  const room = Math.max(0.04, netRadiusAt(b.y) - BALL_R * 0.55);
  if (r > room) {
    b.x *= room / r;
    b.z *= room / r;
  }
}

// Has the ball been up over the rim and left the hoop for good: out of the
// bottom of the net, or away and falling after a brick?
export function ballDone(b) {
  if (b.age > 8) return true;
  return b.risen && b.vy > 0 && (b.inNet ? false : b.y > NET_BOTTOM + 0.4 || (b.y > 1 && Math.hypot(b.x, b.z) > 1.1));
}
