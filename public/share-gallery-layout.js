export function computeJustifiedRows(items, options) {
  const { containerWidth, gap, targetHeight, maxItems = Infinity, wideThreshold = Infinity } = options;
  const source = items.map((item) => ({
    ...item,
    aspect: Math.min(2.8, Math.max(0.45, item.aspect || 1)),
  }));
  const grouped = [];
  let current = [];

  const pushCurrent = () => {
    if (current.length) grouped.push(current);
    current = [];
  };

  for (const item of source) {
    if (item.aspect >= wideThreshold) {
      pushCurrent();
      grouped.push([item]);
      continue;
    }
    current.push(item);
    const sum = current.reduce((total, entry) => total + entry.aspect, 0);
    if (current.length >= maxItems || sum * targetHeight + gap * (current.length - 1) >= containerWidth) pushCurrent();
  }
  pushCurrent();

  return grouped.map((row, index) => {
    const gaps = gap * (row.length - 1);
    const sum = row.reduce((total, item) => total + item.aspect, 0);
    const isLast = index === grouped.length - 1;
    const height = Math.max(1, Math.min((containerWidth - gaps) / sum, isLast ? targetHeight : targetHeight * 1.35));
    const sized = row.map((item) => ({
      id: item.id,
      height: Math.round(height),
      width: Math.floor(item.aspect * height),
    }));
    const used = sized.reduce((total, item) => total + item.width, 0) + gaps;
    if (!isLast && sized.length) sized.at(-1).width += containerWidth - used;
    return { height: Math.round(height), items: sized };
  });
}

// The hover scale grows from the tile's centre, which pushes tiles on the
// edge of the grid past the viewport (the left half of a first-column tile
// vanished off-screen). Measured before the transition starts: whichever
// edge would clip becomes the transform origin, so the tile grows inward.
// Floating card next to an anchor (folder hover card): prefer the right of
// the anchor, flip left when that overflows; prefer top-aligned, flip up to
// sit above the bottom edge, and fall back to below when flipping would go
// off the top. Then clamp. (Loose-ends spec §3.3.)
export function positionPreview(size, anchorRect, vw, vh, margin = 8) {
  const { width: pw, height: ph } = size;
  let left = anchorRect.right + margin;
  if (left + pw > vw - margin) left = anchorRect.left - pw - margin;
  left = Math.min(Math.max(left, margin), vw - pw - margin);
  let top = anchorRect.top;
  if (top + ph > vh - margin) top = anchorRect.bottom - ph;
  if (top < margin) top = anchorRect.top;
  top = Math.min(Math.max(top, margin), vh - ph - margin);
  return { left, top };
}

// `bounds` is the box the grown tile must stay inside: the viewport minus
// whatever covers it (the sticky toolbar at the top, a bottom bar on phones).
// When a tile cannot fit either way the side with more room wins, and a
// tile larger than the box just grows from its centre (nothing better exists).
export function hoverZoomOrigin(rect, zoom, vw, vh, margin = 8, bounds = {}) {
  if (!(zoom > 1)) return "";
  const box = { left: margin, top: margin, right: vw - margin, bottom: vh - margin, ...bounds };
  const gx = (rect.width * (zoom - 1)) / 2;
  const gy = (rect.height * (zoom - 1)) / 2;
  const pick = (start, end, grow, lo, hi, first, last) => {
    const room = end - start;
    if (start - grow >= lo && end + grow <= hi) return "center";
    if (grow * 2 + room > hi - lo) return "center";
    if (start - grow < lo && end + grow > hi) return start - lo >= hi - end ? last : first;
    return start - grow < lo ? first : last;
  };
  return `${pick(rect.left, rect.right, gx, box.left, box.right, "left", "right")} ${pick(rect.top, rect.bottom, gy, box.top, box.bottom, "top", "bottom")}`;
}

