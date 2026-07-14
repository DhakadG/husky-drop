export function createSmartHeaderState({ hideDelta = 8, showDelta = 4 } = {}) {
  let hidden = false;
  let active = false;
  let lastY = 0;
  let direction = 0;
  let travel = 0;

  const visible = (y) => {
    const changed = hidden;
    hidden = false;
    active = false;
    lastY = y;
    direction = 0;
    travel = 0;
    return { hidden, changed };
  };

  return {
    update({ y, stuck, enabled, locked }) {
      const nextY = Math.max(0, Number(y) || 0);
      if (!enabled || !stuck || locked) return visible(nextY);

      if (!active) {
        active = true;
        lastY = nextY;
        return { hidden, changed: false };
      }

      const delta = nextY - lastY;
      const nextDirection = Math.sign(delta);
      lastY = nextY;

      if (nextDirection) {
        travel = nextDirection === direction ? travel + Math.abs(delta) : Math.abs(delta);
        direction = nextDirection;
      }

      const wasHidden = hidden;
      if (!hidden && direction > 0 && travel >= hideDelta) hidden = true;
      if (hidden && direction < 0 && travel >= showDelta) hidden = false;
      return { hidden, changed: hidden !== wasHidden };
    },

    reset(y = 0) {
      return visible(Math.max(0, Number(y) || 0));
    }
  };
}
