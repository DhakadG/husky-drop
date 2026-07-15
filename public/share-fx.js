// GSAP animation pass + custom cursor follower for the share gallery.
// Loaded as a classic script (uses the `gsap` global from /vendor/gsap.min.js)
// before share.js, and exposes window.shareFx for share.js to call into.
// Every effect is skipped under prefers-reduced-motion or when GSAP failed
// to load, so the page still works with plain CSS/instant state changes.
(() => {
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const hasGsap = typeof window.gsap !== "undefined";
  const canHover = matchMedia("(hover: hover) and (pointer: fine)").matches;

  function reveal(els) {
    if (!els || !els.length) return;
    if (!hasGsap || reduced) {
      for (const el of els) el.style.opacity = "1";
      return;
    }
    gsap.fromTo(
      els,
      { autoAlpha: 0, y: 14, scale: 0.985 },
      {
        autoAlpha: 1,
        y: 0,
        scale: 1,
        duration: 0.45,
        ease: "power2.out",
        stagger: { each: 0.018, from: "start" },
        clearProps: "transform,opacity,visibility",
      }
    );
  }

  function crumbSwap(box) {
    if (!box || !hasGsap || reduced) return;
    gsap.fromTo(
      box.children,
      { autoAlpha: 0, x: -8 },
      { autoAlpha: 1, x: 0, duration: 0.3, stagger: 0.035, ease: "power2.out", clearProps: "transform,opacity" }
    );
  }

  function toolbar(el) {
    if (!el || !hasGsap || reduced) return;
    gsap.from(el, { y: -14, autoAlpha: 0, duration: 0.5, ease: "power3.out" });
  }

  function pop(el) {
    if (!el) return;
    if (!hasGsap || reduced) return;
    gsap.fromTo(el, { scale: 0.8 }, { scale: 1, duration: 0.35, ease: "back.out(2.4)" });
  }

  function fadeIn(el, opts = {}) {
    if (!el) return;
    if (!hasGsap || reduced) {
      el.style.opacity = "1";
      return;
    }
    gsap.fromTo(el, { autoAlpha: 0, y: opts.y ?? 8 }, { autoAlpha: 1, y: 0, duration: opts.duration ?? 0.4, ease: "power2.out" });
  }

  function shake(el) {
    if (!el || !hasGsap || reduced) return;
    gsap.fromTo(el, { x: -6 }, { x: 0, duration: 0.4, ease: "elastic.out(1, 0.35)" });
  }

  // ---- Custom cursor follower (fine pointers only) ----
  let cursorInstalled = false;
  let dot = null;
  let ring = null;
  let qx = null;
  let qy = null;
  let ringLabel = null;
  const STATES = {
    default: { scale: 1, label: "" },
    photo: { scale: 1.04, label: "view" },
    video: { scale: 1.04, label: "play" },
    folder: { scale: 1.02, label: "open" },
    link: { scale: 0.92, label: "" },
    scrub: { scale: 1.08, label: "scrub" },
    zoom: { scale: 1.08, label: "" },
  };
  let lastPointer = { x: 0, y: 0 };

  function installCursor() {
    if (cursorInstalled || !canHover || reduced) return;
    cursorInstalled = true;
    document.body.classList.add("has-fx-cursor");

    dot = document.createElement("div");
    dot.className = "fx-cur-dot";
    ring = document.createElement("div");
    ring.className = "fx-cur-ring";
    ringLabel = document.createElement("span");
    ring.appendChild(ringLabel);
    document.body.append(dot, ring);

    if (hasGsap) {
      qx = gsap.quickTo(ring, "x", { duration: 0.35, ease: "power3" });
      qy = gsap.quickTo(ring, "y", { duration: 0.35, ease: "power3" });
    }

    let lastMove = 0;
    window.addEventListener(
      "pointermove",
      (e) => {
        lastMove = performance.now();
        lastPointer = { x: e.clientX, y: e.clientY };
        dot.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        if (qx) {
          qx(e.clientX);
          qy(e.clientY);
        } else {
          ring.style.transform = `translate(${e.clientX}px, ${e.clientY}px)`;
        }
        ring.classList.remove("cur-hidden");
        dot.classList.remove("cur-hidden");
      },
      { passive: true }
    );
    window.addEventListener("pointerleave", () => {
      ring.classList.add("cur-hidden");
      dot.classList.add("cur-hidden");
    });
    document.addEventListener(
      "pointerdown",
      () => {
        if (hasGsap) gsap.to(ring, { scale: (currentScale() * 0.85), duration: 0.15 });
      },
      { passive: true }
    );
    document.addEventListener(
      "pointerup",
      () => {
        if (hasGsap) gsap.to(ring, { scale: currentScale(), duration: 0.25, ease: "back.out(2)" });
      },
      { passive: true }
    );

    document.addEventListener(
      "pointerover",
      (e) => {
        setCursorState(cursorStateForTarget(e.target));
      },
      { passive: true }
    );

    // Idle fade so the ring doesn't sit obtrusively over static content.
    setInterval(() => {
      if (performance.now() - lastMove > 2200) ring.classList.add("cur-idle");
      else ring.classList.remove("cur-idle");
    }, 400);
  }

  let curState = "default";
  function currentScale() {
    return STATES[curState]?.scale || 1;
  }
  function setCursorState(name) {
    const s = STATES[name] || STATES.default;
    curState = STATES[name] ? name : "default";
    if (!ring) return;
    ring.dataset.state = curState;
    ringLabel.textContent = s.label;
    if (hasGsap) gsap.to(ring, { scale: s.scale, duration: 0.28, ease: "power2.out" });
    else ring.style.transform += ` scale(${s.scale})`;
  }

  function cursorStateForTarget(target) {
    const node = target || document.elementFromPoint(lastPointer.x, lastPointer.y);
    if (node?.closest?.(".g-dl, .g-check, button, a, select, input, textarea")) {
      return node.closest("[data-cursor]")?.dataset?.cursor || "link";
    }
    const card = node?.closest?.(".g-card");
    if (card?.classList?.contains("video-card")) return "video";
    if (card && !card.classList.contains("plain")) return "photo";
    const el = node?.closest?.("[data-cursor]");
    return el?.dataset?.cursor || "default";
  }

  function setScrubbing(on, target) {
    setCursorState(on ? "scrub" : cursorStateForTarget(target));
  }

  function animateViewerLed(element, state) {
    if (!element || reduced || !hasGsap) return;
    gsap.killTweensOf(element);
    if (/fetching|intent/.test(state)) {
      gsap.fromTo(element, { scale: 0.72, opacity: 0.45 }, { scale: 1, opacity: 1, duration: 0.24, ease: "back.out(2)" });
    } else {
      gsap.fromTo(element, { scale: 0.82 }, { scale: 1, duration: 0.14, ease: "power2.out" });
    }
  }

  function animateViewerTransition(element, mode, speed) {
    if (!element || reduced || !hasGsap || mode === "immediate") return;
    const duration = Math.max(0.08, Math.min(0.7, Number(speed) / 1000));
    const presets = {
      fade: [{ opacity: 0 }, { opacity: 1 }],
      "soft-zoom": [{ opacity: 0, scale: 0.97 }, { opacity: 1, scale: 1 }],
      "zoom-in": [{ opacity: 0, scale: 0.9 }, { opacity: 1, scale: 1 }],
      "zoom-out": [{ opacity: 0, scale: 1.08 }, { opacity: 1, scale: 1 }],
      "scale-up": [{ opacity: 0, scale: 0.78 }, { opacity: 1, scale: 1 }],
      "slide-horizontal": [{ opacity: 0, x: 28 }, { opacity: 1, x: 0 }],
      "slide-vertical": [{ opacity: 0, y: 22 }, { opacity: 1, y: 0 }],
      "slide-up": [{ opacity: 0, y: 38 }, { opacity: 1, y: 0 }],
      "slide-down": [{ opacity: 0, y: -38 }, { opacity: 1, y: 0 }],
      "slide-left": [{ opacity: 0, x: 48 }, { opacity: 1, x: 0 }],
      "slide-right": [{ opacity: 0, x: -48 }, { opacity: 1, x: 0 }],
      skew: [{ opacity: 0, skewX: 4, x: 16 }, { opacity: 1, skewX: 0, x: 0 }],
      rotate: [{ opacity: 0, rotate: -2, scale: 0.96 }, { opacity: 1, rotate: 0, scale: 1 }],
      "rotate-left": [{ opacity: 0, rotate: -7, scale: 0.94 }, { opacity: 1, rotate: 0, scale: 1 }],
      "rotate-right": [{ opacity: 0, rotate: 7, scale: 0.94 }, { opacity: 1, rotate: 0, scale: 1 }],
      "flip-x": [{ opacity: 0, rotateY: 36, transformPerspective: 900 }, { opacity: 1, rotateY: 0, transformPerspective: 900 }],
      "flip-y": [{ opacity: 0, rotateX: 30, transformPerspective: 900 }, { opacity: 1, rotateX: 0, transformPerspective: 900 }],
      blur: [{ opacity: 0.3, filter: "blur(18px)" }, { opacity: 1, filter: "blur(0px)" }],
      brightness: [{ opacity: 0.65, filter: "brightness(1.8)" }, { opacity: 1, filter: "brightness(1)" }],
      "film-cut": [
        { opacity: 0, filter: "brightness(1.45) contrast(0.9)" },
        { opacity: 1, filter: "brightness(1) contrast(1)" },
      ],
      bounce: [{ opacity: 0, scale: 0.9, y: 16 }, { opacity: 1, scale: 1, y: 0, ease: "back.out(1.5)" }],
      swing: [{ opacity: 0, rotateZ: -3, transformOrigin: "50% 0%" }, { opacity: 1, rotateZ: 0, transformOrigin: "50% 0%" }],
    };
    const preset = presets[mode] || presets.fade;
    const phaseDuration = mode === "blur" ? duration / 2 : duration;
    gsap.killTweensOf(element);
    gsap.fromTo(element, preset[0], {
      ...preset[1],
      duration: phaseDuration,
      ease: preset[1].ease || "power2.out",
      clearProps: "transform,opacity,filter",
    });
  }

  function animateViewerExit(element, speed) {
    if (!element || reduced || !hasGsap) return Promise.resolve(false);
    const duration = Math.max(0.08, Math.min(0.7, Number(speed) / 1000)) / 2;
    gsap.killTweensOf(element);
    return new Promise((resolve) => {
      gsap.to(element, {
        opacity: 0.3,
        filter: "blur(18px)",
        duration,
        ease: "power2.in",
        onComplete: () => resolve(true),
        onInterrupt: () => resolve(false),
      });
    });
  }

  function cancelViewerTransition(element) {
    if (!element || !hasGsap) return;
    gsap.killTweensOf(element);
    gsap.set(element, { clearProps: "transform,opacity,filter" });
  }

  // Tile hover lift/depth is pure CSS now (see .g-card:hover in style.css) -
  // a per-pointermove GSAP 3D tilt used to run here at the same time as the
  // CSS hover transform, fighting over the same `transform` property every
  // frame. That's what made the hover feel slow and heavy. Kept as a no-op
  // so any remaining fx.tileDepth(el) call sites stay harmless.
  function tileDepth() {}

  window.shareFx = {
    reveal,
    crumbSwap,
    toolbar,
    pop,
    fadeIn,
    shake,
    installCursor,
    setCursorState,
    setScrubbing,
    tileDepth,
    animateViewerLed,
    animateViewerExit,
    animateViewerTransition,
    cancelViewerTransition,
    hasMotion: hasGsap && !reduced,
    canHoverPreview: canHover,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installCursor);
  } else {
    installCursor();
  }
})();
