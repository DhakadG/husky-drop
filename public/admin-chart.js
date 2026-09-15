import { $, seriesMetric, seriesRows } from "./admin-state.js";

// 30-day activity chart (inline SVG, no dependencies).
// ---- 30-day activity chart (inline SVG, no dependencies) ----

export function renderChart() {
  const host = $("chart");
  if (!host) return;
  // Zero-fill every one of the last 30 days: quiet days render as empty
  // slots instead of the chart silently collapsing to active days only.
  const byDay = new Map(seriesRows.map((r) => [r.day, r]));
  const points = [];
  for (let i = 29; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
    const row = byDay.get(day) || {};
    points.push({ day, v: Number(row[seriesMetric]) || 0 });
  }
  const total = points.reduce((t, p) => t + p.v, 0);
  const w = 900;
  const h = 150;
  const pad = 2;
  const max = Math.max(...points.map((p) => p.v), 1);
  const step = (w - pad * 2) / points.length;
  const bw = Math.max(4, step - 3);
  let bars = "";
  const maxV = Math.max(...points.map((p) => p.v));
  points.forEach((p, i) => {
    const x = pad + i * step;
    const bh = Math.max(p.v > 0 ? 3 : 1.5, ((h - 6) * p.v) / max);
    const label = seriesMetric === "bytes" ? fmtBytes(p.v) : p.v;
    const cls = !p.v ? "zero" : p.v === maxV ? "peak" : "";
    bars += `<rect class="${cls}" x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="2"><title>${esc(p.day)}: ${esc(String(label))}</title></rect>`;
  });
  const totalLabel = seriesMetric === "bytes" ? fmtBytes(total) : total;
  const peak = points.reduce((a, b) => (b.v > a.v ? b : a), points[0]);
  const peakLabel = seriesMetric === "bytes" ? fmtBytes(peak.v) : peak.v;
  const busiest = total && peak.v ? ` · busiest day ${peak.day.slice(5)} (${peakLabel})` : "";
  const note = total ? `${totalLabel} ${seriesMetric} in the last 30 days${busiest}` : `No ${seriesMetric} in the last 30 days yet - the chart fills in as activity happens.`;
  const labels = [points[0], points[10], points[20], points[29]].map((p) => `<span>${esc(p.day.slice(5))}</span>`).join("");
  host.innerHTML = `
    <div class="chart-note muted">${esc(note)}</div>
    <svg class="chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-label="30 day ${escAttr(seriesMetric)}">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7aa4ff"/><stop offset="1" stop-color="#2f6bff"/></linearGradient>
        <linearGradient id="barGradPeak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f6bff"/><stop offset="1" stop-color="#15c0c9"/></linearGradient>
      </defs>${bars}</svg>
    <div class="chart-labels">${labels}</div>`;
}
