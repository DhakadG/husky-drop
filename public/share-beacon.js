import {
  slug,
  viewer,
} from "./share-state.js";

// Browsing-session analytics: batched, sendBeacon on unload.
// ---- Browsing-session analytics beacon ----
// Batches folder navigation + media-view events and flushes them via
// sendBeacon (so a closed tab still delivers) rather than a KV write per
// click - lets the owner see who browsed what and where load is slow.

const trackQueue = [];
const trackSessionId =
  window.shareTrekker?.sessionId || window.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;

export function trackEvent(t, name, data = {}) {
  const mapped = t === "view" ? "media_view_start" : t;
  if (window.shareTrekker) {
    window.shareTrekker.track(mapped, name, data);
    window.clarity?.("event", mapped);
    return;
  }
  trackQueue.push({ t: mapped, name: String(name || "").slice(0, 160), data });
  if (trackQueue.length >= 20) flushTrack();
  window.clarity?.("event", t);
}

function flushTrack(useBeacon = false) {
  if (!trackQueue.length) return;
  const events = trackQueue.splice(0, trackQueue.length);
  const payload = JSON.stringify({ slug, sessionId: trackSessionId, events });
  if (useBeacon && navigator.sendBeacon) {
    navigator.sendBeacon("/api/share/track", new Blob([payload], { type: "application/json" }));
    return;
  }
  fetch("/api/share/track", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {});
}

export function installTracking() {
  setInterval(() => flushTrack(false), 15000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushTrack(true);
  });
  window.addEventListener("pagehide", () => flushTrack(true));
  window.clarity?.("identify", viewer?.email || `anon-${trackSessionId}`, trackSessionId, slug, viewer?.name);
  window.clarity?.("set", "slug", slug);
}
