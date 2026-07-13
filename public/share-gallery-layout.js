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
