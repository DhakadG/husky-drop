// The scoreboard clock: many small files must be timed by completions, big
// files by bytes, and the shown value must not jump around.
import assert from "node:assert/strict";
import { sampleEta, smoothEta } from "../public/drop-eta.js";

// 2,000 screenshots of 180 KB at 4 files/s: bytes alone (with 12 lanes
// streaming fast) say minutes too few; completions say ~8 min.
{
  const win = [];
  let est = null;
  for (let t = 0; t <= 30; t++) {
    const files = t * 4;
    est = sampleEta(win, { t: t * 1000, sent: t * 2e6, files }, { bytes: (2000 - files) * 180e3, files: 2000 - files });
  }
  const byFiles = (2000 - 120) / 4;
  assert.ok(Math.abs(est - byFiles) < 1, `small files timed by completions: ${est}`);
}

// Three 2 GB videos, none finished yet: bytes only, no file rate.
{
  const win = [];
  let est = null;
  for (let t = 0; t <= 20; t++) est = sampleEta(win, { t: t * 1000, sent: t * 10e6, files: 0 }, { bytes: 6e9 - t * 10e6, files: 3 });
  assert.ok(Math.abs(est - (6e9 - 200e6) / 10e6) < 1, `big files timed by bytes: ${est}`);
}

// Too little history, or nothing moving: no guess.
assert.equal(sampleEta([], { t: 0, sent: 0, files: 0 }, { bytes: 1, files: 1 }), null);
{
  const win = [];
  for (let t = 0; t <= 5; t++) sampleEta(win, { t: t * 1000, sent: 0, files: 0 }, { bytes: 10, files: 1 });
  assert.equal(sampleEta(win, { t: 6000, sent: 0, files: 0 }, { bytes: 10, files: 1 }), null);
}

// The window forgets: an old fast stretch stops counting after 30 s.
{
  const win = [];
  for (let t = 0; t <= 60; t++) sampleEta(win, { t: t * 1000, sent: t < 20 ? t * 1e7 : 2e8 + (t - 20) * 1e6, files: 0 }, { bytes: 1e9, files: 1 });
  assert.ok(win[0].t >= 30000, "window keeps only the last 30 s");
}

// Smoothing: a noisy estimate stream moves the clock by far less than the noise,
// and with a steady estimate the clock counts down a second per second.
{
  let shown = null;
  let maxStep = 0;
  for (let i = 0; i < 60; i++) {
    const est = 300 - i + (i % 2 ? 200 : -150);
    const next = smoothEta(shown, est, 1);
    if (shown != null) maxStep = Math.max(maxStep, Math.abs(next - shown));
    shown = next;
  }
  assert.ok(maxStep < 60, `clock steps stay small under noise: ${maxStep}`);
  let s = 100;
  for (let i = 1; i <= 10; i++) s = smoothEta(s, 100 - i, 1);
  assert.ok(Math.abs(s - 90) < 0.01, `steady countdown: ${s}`);
  assert.equal(smoothEta(42, null, 1), null);
}

console.log("drop-eta ok");
