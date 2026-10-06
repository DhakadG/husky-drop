// Time left on the scoreboard clock. Bytes over byte rate is right for a few
// big videos; a pile of small screenshots is bound by the round trip each
// file costs, whatever its size, so there files over completion rate is the
// honest number. Both rates come from the last 30 s, and the slower view wins.

const WINDOW_MS = 30000;
// ponytail: a file rate is only trusted once this many files finished in the
// window; big uploads finish in bursts and a rate from two files lies.
const MIN_FILES = 20;

// win: the caller's sample list. s: { t (ms), sent (bytes), files (finished) }.
// left: { bytes, files } still to go. Returns seconds, or null while unsure.
export function sampleEta(win, s, left) {
  win.push(s);
  while (win.length > 2 && s.t - win[0].t > WINDOW_MS) win.shift();
  const a = win[0];
  const secs = (s.t - a.t) / 1000;
  if (secs < 3) return null;
  const bps = (s.sent - a.sent) / secs;
  const done = s.files - a.files;
  const byBytes = left.bytes <= 0 ? 0 : bps > 0 ? left.bytes / bps : Infinity;
  const byFiles = done >= MIN_FILES ? left.files / (done / secs) : 0;
  const eta = Math.max(byBytes, byFiles);
  return Number.isFinite(eta) ? eta : null;
}

// The clock counts down in real time and drifts toward each new estimate over
// about 8 s instead of jumping to it.
export function smoothEta(shown, est, dt) {
  if (est == null) return null;
  if (shown == null) return est;
  const ticked = Math.max(0, shown - dt);
  return ticked + (est - ticked) * Math.min(1, dt / 8);
}
