// High-resolution, privacy-bounded share-session telemetry. Event bodies never
// include form values, PINs or image bytes; all timestamps are client + monotonic.
(function () {
  "use strict";
  const slug = location.pathname.split("/").filter(Boolean).pop() || "";
  const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();
  const startedMono = performance.now();
  const queue = [];
  const scrollMarks = new Set();
  let activeMedia = null;
  let flushTimer = 0;

  const network = () => {
    const c = navigator.connection || {};
    return { effectiveType: c.effectiveType || "", downlink: Number(c.downlink) || 0, rtt: Number(c.rtt) || 0, saveData: !!c.saveData };
  };
  const targetName = (el) => {
    if (!el) return "unknown";
    const tracked = el.closest?.("[data-track]");
    if (tracked?.dataset.track) return tracked.dataset.track.slice(0, 100);
    const role = el.getAttribute?.("role") || "";
    const label = el.getAttribute?.("aria-label") || el.getAttribute?.("title") || (/^(BUTTON|A)$/.test(el.tagName) ? el.textContent : "") || "";
    return `${el.tagName?.toLowerCase() || "node"}${role ? `[${role}]` : ""}${label ? `:${label.trim().replace(/\s+/g, " ").slice(0, 80)}` : ""}`;
  };
  const flush = (beacon = false) => {
    clearTimeout(flushTimer);
    flushTimer = 0;
    if (!queue.length) return;
    const events = queue.splice(0, 40);
    const body = JSON.stringify({ slug, sessionId, startedAt, events });
    if (beacon && navigator.sendBeacon) navigator.sendBeacon("/api/share/track", new Blob([body], { type: "application/json" }));
    else fetch("/api/share/track", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  };
  const track = (t, name = "", data = {}) => {
    const at = Date.now();
    const mono = Math.round((performance.now() - startedMono) * 10) / 10;
    if (t === "media_view_start") {
      if (activeMedia) track("media_view_end", activeMedia.name, { durationMs: at - activeMedia.at, reason: "switch" });
      activeMedia = { name: String(name).slice(0, 160), at };
    } else if (t === "media_view_end") {
      if (activeMedia && !data.durationMs) data = { ...data, durationMs: at - activeMedia.at };
      activeMedia = null;
    }
    queue.push({ t: String(t).slice(0, 40), name: String(name).slice(0, 160), at, mono, data });
    if (queue.length >= 30) flush();
    else if (!flushTimer) flushTimer = setTimeout(flush, 10000);
  };

  document.addEventListener("click", (event) => {
    const el = event.target?.closest?.("button,a,[role=button],[data-track]") || event.target;
    track("click", targetName(el), { x: Math.round(event.clientX), y: Math.round(event.clientY), button: event.button, trusted: event.isTrusted });
  }, true);
  document.addEventListener("visibilitychange", () => track("visibility", document.visibilityState, { elapsedMs: Date.now() - startedAt }));
  window.addEventListener("focus", () => track("focus", "window"));
  window.addEventListener("blur", () => track("blur", "window"));
  window.addEventListener("resize", () => track("viewport", `${innerWidth}x${innerHeight}`, { dpr: devicePixelRatio }), { passive: true });
  window.addEventListener("scroll", () => {
    const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const depth = Math.min(100, Math.round((scrollY / max) * 100));
    for (const mark of [25, 50, 75, 100]) if (depth >= mark && !scrollMarks.has(mark)) { scrollMarks.add(mark); track("scroll_depth", String(mark)); }
  }, { passive: true });
  window.addEventListener("error", (event) => track("client_error", event.message || "resource error", { file: String(event.filename || "").split("/").pop(), line: event.lineno || 0 }));
  window.addEventListener("unhandledrejection", (event) => track("promise_rejection", String(event.reason?.message || event.reason || "rejected").slice(0, 160)));
  navigator.connection?.addEventListener?.("change", () => track("network_change", network().effectiveType, network()));
  window.addEventListener("load", () => {
    const nav = performance.getEntriesByType("navigation")[0];
    track("performance", "page_load", nav ? { ttfbMs: Math.round(nav.responseStart), domMs: Math.round(nav.domContentLoadedEventEnd), loadMs: Math.round(nav.loadEventEnd), transferBytes: nav.transferSize || 0 } : {});
  }, { once: true });
  window.addEventListener("pagehide", () => {
    if (activeMedia) track("media_view_end", activeMedia.name, { durationMs: Date.now() - activeMedia.at, reason: "pagehide" });
    track("session_end", "share", { elapsedMs: Date.now() - startedAt, scrollDepths: [...scrollMarks] });
    flush(true);
  });
  setInterval(() => flush(false), 15000);
  window.shareTrekker = { sessionId, track, flush };
  track("session_start", "share", { viewport: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, network: network(), language: navigator.language });
})();
