// Shots are physics, not scripts, so the test plays them and checks what a
// person would notice: every verified file goes in, the shot book really has
// 15-20 kinds of shot and each one plays like its name (clean ones never
// touch iron, iron ones do, banks hit the glass, a roll-around circles the
// rim), bricks stay out, nothing tunnels through the iron, and a shot takes
// about a second and a half.
import assert from "node:assert/strict";
import { launch, stepBall, ballDone, planShot, SHOTS, BALL_R, RIM_TUBE } from "../public/drop-court-ball.js";

// Small deterministic PRNG so failures replay.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}
const rand = rng(42);
const dt = 1 / 120;

function play({ miss = false, name = "" } = {}) {
  const start = { x: (rand() - 0.5) * 6, y: 3 + rand() * 3, z: 3 };
  const plan = planShot(rand, { miss, name, from: start });
  const b = launch(start, plan.target, plan.apex, { miss, spin: plan.spin, swirl: plan.swirl });
  const out = { name: plan.name, rim: 0, board: 0, minRimGap: Infinity, turned: 0 };
  let lastA = null;
  while (!ballDone(b)) {
    const hit = stepBall(b, dt);
    if (hit.rim) out.rim++;
    if (hit.board) out.board++;
    const r = Math.hypot(b.x, b.z);
    out.minRimGap = Math.min(out.minRimGap, Math.hypot(r - 1, b.y) - (BALL_R + RIM_TUBE));
    if (b.y > -0.7 && b.y < 0.3 && r > 0.4) {
      const a = Math.atan2(b.z, b.x);
      if (lastA !== null) out.turned += Math.abs(((a - lastA + 3 * Math.PI) % (2 * Math.PI)) - Math.PI);
      lastA = a;
    }
    assert.ok(Number.isFinite(b.x + b.y + b.z), "ball state stays finite");
  }
  return { ...out, made: b.made, time: b.age };
}

assert.ok(SHOTS.length >= 15 && SHOTS.length <= 20, `the shot book has 15-20 shots (${SHOTS.length})`);
assert.equal(new Set(SHOTS.map((s) => s.name)).size, SHOTS.length, "every shot has its own name");

// The weighted mix the court actually throws.
const mix = Array.from({ length: 1000 }, () => play());
assert.equal(mix.filter((s) => s.made).length, 1000, "every verified file goes in");
assert.ok(mix.every((s) => s.minRimGap > -0.02), "no shot tunnels through the rim");
assert.ok(new Set(mix.map((s) => s.name)).size === SHOTS.length, "the mix uses every shot in the book");
const times = mix.map((s) => s.time).sort((a, b) => a - b);
assert.ok(times[500] > 0.8 && times[500] < 2.2, `a shot takes about a second and a half (median ${times[500].toFixed(2)} s)`);
assert.ok(times[999] < 6, `even rattles finish (${times[999].toFixed(2)} s)`);

// Each shot plays like its name.
const CLEAN = ["swish", "flat swish", "rainbow", "drop-in", "backspin swish", "line drive"];
const IRON = ["front rim roll-in", "back iron", "left rim kiss", "right rim kiss", "rattle", "roll around", "front rim pop-up"];
const GLASS = ["bank", "angle bank", "high glass", "glass and iron", "lay-up"];
assert.equal(CLEAN.length + IRON.length + GLASS.length, SHOTS.length, "every shot is classified below");
const rate = (list, f) => list.filter(f).length / list.length;
for (const name of [...CLEAN, ...IRON, ...GLASS]) {
  const runs = Array.from({ length: 150 }, () => play({ name }));
  assert.equal(rate(runs, (s) => s.made), 1, `${name}: every one goes in`);
  if (CLEAN.includes(name)) assert.ok(rate(runs, (s) => s.rim) <= 0.1, `${name}: stays off the iron`);
  if (IRON.includes(name)) assert.ok(rate(runs, (s) => s.rim) >= 0.9, `${name}: catches iron`);
  if (GLASS.includes(name)) assert.ok(rate(runs, (s) => s.board) >= 0.85, `${name}: comes off the glass`);
  if (name === "roll around") assert.ok(rate(runs, (s) => s.turned > Math.PI) >= 0.25, `${name}: really circles the rim`);
}

const bricks = Array.from({ length: 300 }, () => play({ miss: true }));
const bricksIn = bricks.filter((s) => s.made).length;
assert.ok(bricksIn < 30, `bricks mostly stay out (${bricksIn}/300 fell in)`);
assert.ok(rate(bricks, (s) => s.rim) > 0.9, "bricks actually hit the iron");

console.log(`drop court ball tests passed (${SHOTS.length} shots, median ${times[500].toFixed(2)} s)`);
