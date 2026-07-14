export function createDragSelectionController(options) {
  const {
    holdMs = 420,
    slopPx = 12,
    edgePx = 72,
    maxScrollPx = 18,
    isSelected,
    setSelected,
    hitTest,
    scrollBy,
    viewportHeight,
    scheduleHold = (fn, ms) => setTimeout(fn, ms),
    cancelHold = clearTimeout,
    scheduleFrame = (fn) => requestAnimationFrame(fn),
    cancelFrame = (id) => cancelAnimationFrame(id),
    vibrate = () => {},
  } = options;

  let pointer = null;
  let holdTimer = 0;
  let frame = 0;
  let active = false;
  let paintSelected = true;
  let processed = new Set();

  const stopHold = () => {
    if (holdTimer) cancelHold(holdTimer);
    holdTimer = 0;
  };

  const stopFrame = () => {
    if (frame) cancelFrame(frame);
    frame = 0;
  };

  const apply = (fileId) => {
    if (!fileId || processed.has(fileId)) return;
    processed.add(fileId);
    setSelected(fileId, paintSelected);
  };

  const paintAtPointer = () => {
    if (pointer) apply(hitTest(pointer.x, pointer.y));
  };

  const scrollDelta = () => {
    if (!pointer) return 0;
    const height = viewportHeight();
    if (pointer.y < edgePx) {
      const intensity = Math.max(0, Math.min(1, 1 - pointer.y / edgePx));
      return -Math.ceil(maxScrollPx * intensity);
    }
    if (pointer.y > height - edgePx) {
      const intensity = Math.max(0, Math.min(1, 1 - (height - pointer.y) / edgePx));
      return Math.ceil(maxScrollPx * intensity);
    }
    return 0;
  };

  const runFrame = () => {
    frame = 0;
    if (!active) return;
    const delta = scrollDelta();
    if (!delta) return;
    scrollBy(delta);
    paintAtPointer();
    frame = scheduleFrame(runFrame);
  };

  const syncFrame = () => {
    if (!active || !scrollDelta()) {
      stopFrame();
      return;
    }
    if (!frame) frame = scheduleFrame(runFrame);
  };

  const finish = (releaseCapture = true) => {
    const wasActive = active;
    stopHold();
    stopFrame();
    if (releaseCapture && active) pointer?.release?.(pointer.pointerId);
    pointer = null;
    active = false;
    processed = new Set();
    return wasActive;
  };

  const activate = () => {
    holdTimer = 0;
    if (!pointer) return;
    active = true;
    paintSelected = !isSelected(pointer.fileId);
    pointer.capture?.(pointer.pointerId);
    apply(pointer.fileId);
    vibrate(12);
    syncFrame();
  };

  return {
    pointerDown(next) {
      finish();
      pointer = { ...next, startX: next.x, startY: next.y };
      processed = new Set();
      holdTimer = scheduleHold(activate, holdMs);
    },

    pointerMove(next) {
      if (!pointer || next.pointerId !== pointer.pointerId) return false;
      pointer.x = next.x;
      pointer.y = next.y;
      if (!active && Math.hypot(next.x - pointer.startX, next.y - pointer.startY) > slopPx) {
        finish(false);
        return false;
      }
      if (!active) return false;
      paintAtPointer();
      syncFrame();
      return true;
    },

    pointerUp(pointerId) {
      if (!pointer || pointer.pointerId !== pointerId) return false;
      return finish();
    },

    cancel() {
      return finish();
    },

    isActive() {
      return active;
    },
  };
}
