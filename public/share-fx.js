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
    hasMotion: hasGsap && !reduced,
    canHoverPreview: canHover,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installCursor);
  } else {
    installCursor();
  }
})();
