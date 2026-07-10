(function installAdaptiveConcurrency(root) {
  function clampNumber(value, min, max) {
    return Math.max(min, Math.min(max, Number(value) || min));
  }

  root.createAdaptiveConcurrency = function createAdaptiveConcurrency(options = {}) {
    const min = clampNumber(options.min ?? 2, 1, 8);
    const max = clampNumber(options.max ?? 8, min, 8);
    const cooldownSamples = Math.max(2, Number(options.cooldownSamples) || 3);
    let limit = clampNumber(options.initial ?? 4, min, max);
    let healthySamples = 0;
    let weakSamples = 0;
    let smoothedBps = 0;

    return {
      get limit() { return limit; },
      seed(connection = {}) {
        const type = String(connection.effectiveType || "").toLowerCase();
        const downlink = Number(connection.downlink) || 0;
        if (type === "slow-2g" || type === "2g" || (downlink && downlink < 1)) limit = min;
        else if (type === "3g" || (downlink && downlink < 4)) limit = Math.min(max, Math.max(min, 3));
        else if (downlink >= 15) limit = Math.min(max, 5);
        return limit;
      },
      observe(sample = {}) {
        const bps = Math.max(0, Number(sample.bps) || 0);
        const errors = Math.max(0, Number(sample.errors) || 0);
        const previous = smoothedBps;
        smoothedBps = previous ? previous * 0.65 + bps * 0.35 : bps;
        if (errors) {
          limit = Math.max(min, Math.ceil(limit / 2));
          healthySamples = 0;
          weakSamples = 0;
          return limit;
        }
        if (!sample.saturated || !bps) {
          healthySamples = 0;
          weakSamples = 0;
          return limit;
        }
        if (!previous || smoothedBps >= previous * 0.96) {
          healthySamples++;
          weakSamples = 0;
          if (healthySamples >= cooldownSamples && limit < max) {
            limit++;
            healthySamples = 0;
          }
        } else if (smoothedBps < previous * 0.78) {
          weakSamples++;
          healthySamples = 0;
          if (weakSamples >= 2 && limit > min) {
            limit--;
            weakSamples = 0;
          }
        }
        return limit;
      },
    };
  };
})(globalThis);
