// The court's physics must hold their shape: a resting net stays woven, a
// card falling through stretches it and it springs back, the shot actually
// peaks where it was told to, and the drag springs settle on the pointer.
import assert from "node:assert/strict";
import { makeNet, settleNet, stepNet, netDepth, shotPath, springStep, NET_BOTTOM, NET_RINGS, NET_CORDS } from "../public/drop-court-physics.js";

const dt = 1 / 120;

// A net left alone keeps its woven shape (no collapse, no drift).
const net = makeNet();
assert.equal(net.pts.length, NET_RINGS * NET_CORDS);
assert.equal(net.links.length, (NET_RINGS - 1) * NET_CORDS * 2);
let moved = 1;
for (let i = 0; i < 240; i++) moved = stepNet(net, dt);
for (const p of net.pts) assert.ok(Math.hypot(p.x - p.rx, p.y - p.ry, p.z - p.rz) < 0.05, "resting net keeps its shape");
assert.ok(moved < 1e-3, "resting net goes to sleep");

// A card dropped through the middle stretches the net downward, passes out of
// the bottom (it never snags), and the net springs back afterwards.
let deepest = 0;
const card = { x: 0, y: -0.4, z: 0, r: 0.7, dy: 2.4 * dt };
for (let i = 0; i < 120; i++) {
  card.y += 2.4 * dt;
  stepNet(net, dt, [card]);
  deepest = Math.max(deepest, netDepth(net));
}
assert.ok(deepest > NET_BOTTOM * 1.18, `the falling card stretches the net (deepest ${deepest.toFixed(3)})`);
assert.ok(card.y > NET_BOTTOM + card.r, "the card leaves through the bottom");
for (let i = 0; i < 600; i++) stepNet(net, dt);
assert.ok(Math.abs(netDepth(net) - NET_BOTTOM) < 0.05, "the net springs back to its rest length");

// The shot starts and ends where asked and peaks at the requested apex.
const from = { x: 100, y: 900 };
const to = { x: 540, y: 600 };
const path = shotPath(from, to, 400);
assert.deepEqual(path(0), from);
assert.ok(Math.abs(path(1).x - to.x) < 1e-6 && Math.abs(path(1).y - to.y) < 1e-6);
let top = Infinity;
for (let u = 0; u <= 1; u += 0.001) top = Math.min(top, path(u).y);
assert.ok(Math.abs(top - 400) < 1, `apex lands on target (${top.toFixed(2)})`);
assert.ok(path(0.999).y > path(0.99).y, "the shot is falling as it reaches the rim");

// The drag spring settles on its target without blowing up.
// A settled net is already hanging at rest: with nothing touching it, it
// does not move (the court only animates the net when something touches it).
const hung = settleNet(makeNet());
let idle = 0;
for (let i = 0; i < 240; i++) idle = Math.max(idle, stepNet(hung, dt));
assert.ok(idle < 1e-4, `a settled net left alone stays still (moved ${idle})`);
assert.ok(Math.abs(netDepth(hung) - NET_BOTTOM) < 0.02, "settling only lets the net hang, it does not stretch it");
const s = { x: 0, y: 0, vx: 0, vy: 0 };
for (let i = 0; i < 240; i++) springStep(s, 200, -80, dt);
assert.ok(Math.abs(s.x - 200) < 0.5 && Math.abs(s.y + 80) < 0.5, "drag spring settles on the pointer");

console.log("drop court physics tests passed");
