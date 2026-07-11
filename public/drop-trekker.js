// Upload-side telemetry: operational milestones, resumability, network state
// and precise interactions. File contents and form-field values are excluded.
(function () {
  "use strict";
  const slug = location.pathname.split("/").filter(Boolean).pop() || "";
  const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const startedAt = Date.now();
  const zero = performance.now();
  const queue = [];
  let timer = 0;
  const connection = () => { const c = navigator.connection || {}; return { effectiveType: c.effectiveType || "", downlink: Number(c.downlink) || 0, rtt: Number(c.rtt) || 0, saveData: !!c.saveData }; };
  const label = (el) => {
    const marked = el?.closest?.("[data-track]");
    if (marked?.dataset.track) return marked.dataset.track.slice(0, 100);
    const node = el?.closest?.("button,a,[role=button],input") || el;
    return `${node?.tagName?.toLowerCase() || "node"}:${String(node?.getAttribute?.("aria-label") || node?.getAttribute?.("title") || (node?.tagName === "BUTTON" ? node.textContent : "") || "").trim().replace(/\s+/g, " ").slice(0, 80)}`;
  };
  const flush = (beacon = false) => {
    clearTimeout(timer); timer = 0;
    if (!queue.length) return;
    const events = queue.splice(0, 40);
    const body = JSON.stringify({ slug, sessionId, startedAt, events });
    if (beacon && navigator.sendBeacon) navigator.sendBeacon("/api/drop/track", new Blob([body], { type: "application/json" }));
    else fetch("/api/drop/track", { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).catch(() => {});
  };
  const track = (t, name = "", data = {}) => {
    queue.push({ t: String(t).slice(0, 40), name: String(name).slice(0, 160), at: Date.now(), mono: Math.round((performance.now() - zero) * 10) / 10, data });
    if (queue.length >= 30) flush(); else if (!timer) timer = setTimeout(flush, 10000);
  };
  document.addEventListener("click", (event) => track("click", label(event.target), { x: Math.round(event.clientX), y: Math.round(event.clientY), trusted: event.isTrusted }), true);
  document.addEventListener("visibilitychange", () => track("visibility", document.visibilityState, { elapsedMs: Date.now() - startedAt }));
  window.addEventListener("online", () => track("network_online", "online", connection()));
  window.addEventListener("offline", () => track("network_offline", "offline", connection()));
  navigator.connection?.addEventListener?.("change", () => track("network_change", connection().effectiveType, connection()));
  window.addEventListener("error", (event) => track("client_error", event.message || "resource error", { line: event.lineno || 0 }));
  window.addEventListener("unhandledrejection", (event) => track("promise_rejection", String(event.reason?.message || event.reason || "rejected").slice(0, 160)));
  window.addEventListener("load", () => { const nav = performance.getEntriesByType("navigation")[0]; track("performance", "page_load", nav ? { ttfbMs: Math.round(nav.responseStart), domMs: Math.round(nav.domContentLoadedEventEnd), loadMs: Math.round(nav.loadEventEnd) } : {}); }, { once: true });
  window.addEventListener("pagehide", () => { track("session_end", "drop", { elapsedMs: Date.now() - startedAt }); flush(true); });
  setInterval(() => flush(false), 15000);
  window.dropTrekker = { sessionId, track, flush };
  track("session_start", "drop", { viewport: `${innerWidth}x${innerHeight}`, dpr: devicePixelRatio, network: connection(), language: navigator.language });
})();
