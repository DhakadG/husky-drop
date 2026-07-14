const HIDE_DELTA = 8;
const SHOW_DELTA = 4;

export function createSmartHeaderState() {
  let hidden = false;
  let active = false;
  let lastY = 0;
  let direction = 0;
  let travel = 0;

  const visible = (y) => {
    hidden = false;
    active = false;
    lastY = y;
    direction = 0;
    travel = 0;
    return hidden;
  };

  return {
    update({ y, stuck, enabled, locked }) {
      const nextY = Math.max(0, Number(y) || 0);
      if (!enabled || !stuck || locked) return visible(nextY);

      if (!active) {
        active = true;
        lastY = nextY;
        return hidden;
      }

      const delta = nextY - lastY;
      const nextDirection = Math.sign(delta);
      lastY = nextY;

      if (nextDirection) {
        travel = nextDirection === direction ? travel + Math.abs(delta) : Math.abs(delta);
        direction = nextDirection;
      }

      if (!hidden && direction > 0 && travel >= HIDE_DELTA) hidden = true;
      if (hidden && direction < 0 && travel >= SHOW_DELTA) hidden = false;
      return hidden;
    },

    reset(y = 0) {
      return visible(Math.max(0, Number(y) || 0));
    }
  };
}
