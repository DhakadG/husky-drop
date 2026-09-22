// One skeleton vocabulary for every "waiting for data" state. The shapes are
// deliberately the same size as the real thing, so nothing jumps when the
// data lands. `.skel-bone` (shimmer) already existed; this is the grammar
// around it.

const bone = (style = "") => `<i class="skel-bone"${style ? ` style="${style}"` : ""}></i>`;

// n text lines, widths varied so it reads as prose rather than a barcode.
export const skelLines = (n = 3, widths = [72, 54, 88, 63, 80]) =>
  `<span class="skel-lines">${Array.from({ length: n }, (_, i) => bone(`width:${widths[i % widths.length]}%`)).join("")}</span>`;

// n table/list rows.
export const skelRows = (n = 4, height = 38) =>
  `<div class="skel-stack">${Array.from({ length: n }, (_, i) => `<div class="skel-row" style="--i:${i};height:${height}px"></div>`).join("")}</div>`;

// n panel cards with a title line and a few body lines.
export const skelCards = (n = 3, lines = 3) =>
  `<div class="skel-cards">${Array.from({ length: n }, (_, i) => `<div class="skel-panel" style="--i:${i}">${bone("width:38%;height:14px")}${skelLines(lines)}</div>`).join("")}</div>`;

// A justified photo grid: rows of tiles with plausible, uneven widths.
export const skelTiles = (n = 12) => {
  const w = [26, 19, 22, 31, 17, 24, 20, 28, 23, 18, 27, 21];
  return `<div class="skel-tiles">${Array.from({ length: n }, (_, i) => `<div class="skel-tile" style="--i:${i};flex-grow:${w[i % w.length]};width:${w[i % w.length] * 8}px"></div>`).join("")}</div>`;
};

// Folder cards, same footprint as the real .folder-card.rich tile.
export const skelFolders = (n = 4) =>
  `<div class="skel-folders">${Array.from({ length: n }, (_, i) => `<div class="skel-folder" style="--i:${i}">${bone("height:100%;border-radius:12px 12px 0 0")}<span>${bone("width:70%;height:12px")}${bone("width:45%;height:10px")}</span></div>`).join("")}</div>`;

// Key/value rows, the shape of the viewer's file-info panel.
export const skelPairs = (n = 6) =>
  `<div class="skel-pairs">${Array.from({ length: n }, (_, i) => `<div style="--i:${i}"><i class="skel-bone" style="width:${38 + ((i * 13) % 26)}%"></i><i class="skel-bone" style="width:${50 + ((i * 17) % 34)}%"></i></div>`).join("")}</div>`;

// Swap a host's contents for a skeleton and hand back a restore function that
// only fires if nothing else has painted in the meantime.
export function showSkeleton(host, html) {
  if (!host) return () => {};
  const token = `${Date.now()}-${Math.random()}`;
  host.dataset.skeleton = token;
  host.setAttribute("aria-busy", "true");
  host.innerHTML = html;
  return () => {
    if (host.dataset.skeleton !== token) return;
    delete host.dataset.skeleton;
    host.removeAttribute("aria-busy");
  };
}

// The same swap, but only if the wait is long enough to notice. Anything that
// answers quickly (a cached listing, a warm API) paints its real content
// without a skeleton flashing first. Returns a function to call when the data
// lands - it cancels a skeleton that has not appeared yet.
export function delayedSkeleton(host, html, delayMs = 180) {
  let restore = () => {};
  const timer = setTimeout(() => {
    restore = showSkeleton(host, html);
  }, delayMs);
  return () => {
    clearTimeout(timer);
    restore();
  };
}
