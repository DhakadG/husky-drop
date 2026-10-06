import { launch, stepBall, ballDone, planShot, BALL_R, GRAVITY } from "./drop-court-ball.js";
import { FAMILY } from "./drop-utils.js";

// The shot clock. Verified files queue here and leave as shots with human
// spacing; when a burst outruns the court (a thousand small screenshots
// finishing together) the queue merges into bundles, and a backlog too long
// to ever show is counted without a flight. A made shot drops out of the net
// onto the floor under the hoop; once the Drive box opens it swallows the
// pile and catches everything after. No canvas here: drop-court.js owns the
// loop and the drawing and hands in screen geometry (g) each step.

const MAX_AIR = 4; // shots in flight at once
const BUNDLE_AT = 5; // queue length at which shots start to merge
const BUNDLE_MAX = 40; // files one bundle can carry
const INSTANT_OVER = 300; // past this many waiting, the rest just count
const Z0 = 3; // the bench sits this far in front of the rim, in rim radii
const DEPTH = 0.167; // ry / rx: how much depth moves a point down the screen
const PILE_MAX = 9; // cards drawn on the floor; older ones fold into a count
const BUNDLE_SHOTS = ["swish", "drop-in", "back iron", "bank", "front rim roll-in", "rainbow"];

const queue = [];
export const shots = [];
export const pile = [];
export const pops = [];
let pileExtra = 0;
let nextAt = 0;
let driveOpen = false;
let hooks = { made() {}, ingest() {}, rim() {}, board() {}, net() {} };

export function setShotHooks(h) {
  hooks = { ...hooks, ...h };
}

// A verified file (or a failed one: miss) waiting for its turn.
export function enqueue(rect, meta, miss = false) {
  queue.push({ rect, metas: [meta], miss });
}

// Files the scoreboard should not count yet: queued, or in the air unmade.
export function pendingShots() {
  let n = 0;
  for (const q of queue) if (!q.miss) n += q.metas.length;
  for (const s of shots) if (!s.miss && !s.counted) n += s.k;
  return n;
}

export const pileCount = () => pile.reduce((n, p) => n + p.k, 0) + pileExtra;
export const pileExtraCount = () => pileExtra;
export const busy = () => queue.length > 0 || shots.length > 0 || pops.length > 0;

export function openDrive() {
  if (driveOpen) return;
  driveOpen = true;
  // The pile hops into the box, one after another.
  pile.forEach((p, i) => shots.push({ ...p, phase: "hop", t: -i * 0.07, fromX: p.x, fromY: p.y }));
  if (pileExtra) hooks.ingest([], pileExtra);
  pile.length = 0;
  pileExtra = 0;
}

// Everything at once, no flight: reduced motion, the hoop off screen, or a
// backlog no one could watch. The counts and the Drive list stay honest.
export function flushInstant(limit = Infinity) {
  let made = 0;
  const metas = [];
  while (queue.length > limit) {
    const q = queue.shift();
    if (q.miss) continue;
    made += q.metas.length;
    metas.push(...q.metas);
  }
  if (made) {
    hooks.made(made);
    hooks.ingest(metas.slice(-6), made - Math.min(6, metas.length));
  }
}

export function tickShots(g, dt, now, colliders) {
  if (queue.length > INSTANT_OVER) flushInstant(INSTANT_OVER / 2);
  const inAir = shots.filter((s) => s.phase === "lift" || s.phase === "fly").length;
  if (queue.length && inAir < MAX_AIR && now >= nextAt) {
    const k = queue.length >= BUNDLE_AT && !queue[0].miss ? Math.min(queue.length - 2, BUNDLE_MAX) : 1;
    const items = queue.splice(0, k);
    lift(items, g);
    nextAt = now + (k > 1 ? 0.28 : 0.11) + Math.random() * 0.22;
  }
  for (const s of [...shots]) PHASES[s.phase](s, g, dt, colliders);
  for (const p of [...pops]) {
    p.t += dt;
    p.bump = Math.min(1, p.bump + dt * 6);
    if (p.t > 1.1) pops.splice(pops.indexOf(p), 1);
  }
}

function lift(items, g) {
  const metas = items.flatMap((q) => q.metas);
  const lead = metas[0] || {};
  const r = items[0].rect;
  const fx = r?.width ? r.left + r.width / 2 : g.cx + (Math.random() - 0.5) * g.rx * 3;
  const fy = r?.width ? r.top + r.height / 2 : g.H + 40;
  shots.push({
    phase: "lift",
    t: 0,
    k: metas.length,
    metas,
    miss: items[0].miss,
    fam: FAMILY[lead.family] || FAMILY.file,
    ext: (lead.ext || "file").toUpperCase().slice(0, 4),
    fx,
    fy,
    x: fx,
    y: fy,
    rot: 0,
    scale: r?.width ? r.width / (g.rx * 0.83) : 1.2,
    squash: 1,
    alpha: 1,
  });
}

const easeOut = (t) => 1 - (1 - t) ** 3;

const PHASES = {
  // A beat of anticipation on the seat: squash, then up.
  lift(s, g, dt) {
    s.t += dt;
    const k = Math.min(1, s.t / 0.16);
    s.squash = k < 0.45 ? 1 - 0.12 * (k / 0.45) : 0.88 + 0.12 * easeOut((k - 0.45) / 0.55);
    s.y = s.fy - 22 * easeOut(Math.max(0, (k - 0.45) / 0.55));
    if (k < 1) return;
    const start = { x: (s.x - g.cx) / g.rx, y: (s.y - g.cy) / g.rx - Z0 * DEPTH, z: Z0 };
    const name = s.k > 1 ? BUNDLE_SHOTS[Math.floor(Math.random() * BUNDLE_SHOTS.length)] : "";
    const plan = planShot(Math.random, { miss: s.miss, name, from: start });
    s.b = launch(start, plan.target, plan.apex, { miss: s.miss, spin: plan.spin, swirl: plan.swirl });
    s.phase = "fly";
    s.squash = 1;
  },
  // Real flight: gravity, rim, glass and net (drop-court-ball.js).
  fly(s, g, dt, colliders) {
    const b = s.b;
    const hit = stepBall(b, dt);
    if (hit.rim) hooks.rim(hit.rim, s.k);
    if (hit.board) hooks.board(hit.board, s.k);
    const radial = Math.hypot(b.x, b.z);
    // Close enough to push cords (a ball skimming the outside still moves them)...
    if (b.y > -0.35 && b.y < 1.6 && radial < 1.25) colliders.push({ x: b.x, y: b.y, z: b.z, r: BALL_R + (s.k > 1 ? 0.25 : 0.15), dy: b.vy * dt });
    // ...but drawn behind the front cords only when it is really inside the
    // net. A ball rising past the front of the hoop is in front of it.
    s.hoop = b.y > -0.3 && b.y < 1.6 && radial < 0.98 && b.risen;
    if (b.made && !s.counted) {
      s.counted = true;
      hooks.made(s.k);
      pop(s.k);
    }
    s.x = g.cx + b.x * g.rx;
    s.y = g.cy + b.y * g.rx + b.z * g.ry;
    s.scale = Math.max(0.45, Math.min(1.6, 0.76 + 0.16 * b.z)) * (s.k > 1 ? 1.1 : 1);
    s.rot = b.rot;
    if (!ballDone(b)) return;
    s.phase = "drop";
    s.hoop = false;
    s.vx = b.vx * g.rx * 0.8;
    s.vy = (b.vy + b.vz * DEPTH) * g.rx;
    s.spin = b.spin * 0.6;
  },
  // Out of the net: a real fall with sideways drift, onto the floor or into the box.
  drop(s, g, dt) {
    s.vy += GRAVITY * g.rx * dt;
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.rot += s.spin * dt;
    s.scale += (0.62 - s.scale) * Math.min(1, dt * 3);
    if (s.x < g.left || s.x > g.right) {
      s.x = Math.max(g.left, Math.min(g.right, s.x));
      s.vx = -s.vx * 0.5;
    }
    const half = g.rx * 0.56 * s.scale * 0.5;
    if (s.y + half < g.floorY) return;
    if (driveOpen && !s.miss && Math.abs(s.x - g.slotX) < g.slotHalf) {
      // Over the mouth of the box: it drops in (drawn clipped at the rim of the box).
      if (s.y - half > g.floorY + 6) ingest(s);
      return;
    }
    s.y = g.floorY - half;
    if (Math.abs(s.vy) > 70) {
      s.vy = -s.vy * 0.32;
      s.vx *= 0.7;
      s.spin *= 0.55;
      if (driveOpen && !s.miss) s.vx += Math.sign(g.slotX - s.x) * 140; // it skids toward the mouth
      return;
    }
    s.vy = 0;
    s.vx *= 0.8;
    if (Math.abs(s.vx) > 25) return;
    if (s.miss) return void (s.phase = "fade");
    rest(s);
  },
  // From the floor into the box when it opens.
  hop(s, g, dt) {
    s.t += dt;
    if (s.t < 0) return;
    const k = Math.min(1, s.t / 0.38);
    s.x = s.fromX + (g.slotX - s.fromX) * easeOut(k);
    s.y = s.fromY - Math.sin(Math.PI * k) * 40 * g.s + k * k * 30 * g.s;
    s.rot += 260 * dt;
    if (k >= 1) ingest(s);
  },
  // A brick that ended on the floor fades out.
  fade(s, g, dt) {
    s.alpha -= dt / 0.6;
    if (s.alpha <= 0) shots.splice(shots.indexOf(s), 1);
  },
};

function rest(s) {
  shots.splice(shots.indexOf(s), 1);
  const flat = Math.round(s.rot / 180) * 180;
  pile.push({ x: s.x, y: s.y, rot: flat + (Math.random() - 0.5) * 16, k: s.k, metas: s.metas, fam: s.fam, ext: s.ext, scale: s.scale, alpha: 1 });
  while (pile.length > PILE_MAX) pileExtra += pile.shift().k;
}

function ingest(s) {
  shots.splice(shots.indexOf(s), 1);
  hooks.ingest(s.metas.slice(-6), Math.max(0, s.k - 6));
}

// One "+N" label at a time: makes that land while it is up add to it and
// give it a small bump, so a run of makes reads as a count going up, not a
// cloud of labels.
function pop(k) {
  const live = pops.find((p) => p.t < 0.8);
  if (live) {
    live.k += k;
    live.t = Math.min(live.t, 0.18);
    live.bump = 0;
    return;
  }
  pops.length = 0;
  pops.push({ t: 0, k, bump: 1, side: Math.random() < 0.5 ? -1 : 1 });
}
