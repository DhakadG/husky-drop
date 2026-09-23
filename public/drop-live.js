import {
  $,
  attention,
  sessionId,
  slug,
  st,
  totals,
  uploadingList,
} from "./drop-state.js";
import { setConnection } from "./drop.js";
import { toast } from "./drop-utils.js";

// Live progress socket, wake lock, lockout countdown.
export function connectLive() {
  if (st.liveSocket && st.liveSocket.readyState <= 1) return;
  try {
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    st.liveSocket = new WebSocket(`${protocol}//${location.host}/api/live/upload/${encodeURIComponent(slug)}`);
    st.liveSocket.onopen = () => {
      st.liveReconnectDelay = 1000;
      if (!st.networkPaused) setConnection("live");
      if (!st.liveConnectedOnce) {
        st.liveConnectedOnce = true;
        toast("Live progress connected", "The admin dashboard can see this transfer.", "ok");
      }
      sendLive(true);
    };
    st.liveSocket.onclose = () => {
      if (!st.networkPaused) setConnection("secure");
      if (totals.uploading > 0 || totals.queued > 0) {
        setTimeout(connectLive, st.liveReconnectDelay);
        st.liveReconnectDelay = Math.min(15000, st.liveReconnectDelay * 2);
      }
    };
  } catch {
    if (!st.networkPaused) setConnection("secure");
  }
}

export function sendLive(force) {
  if (!st.liveSocket || st.liveSocket.readyState !== WebSocket.OPEN) return;
  const now = Date.now();
  if (!force && now - st.lastLiveSend < 1200) return;
  st.lastLiveSend = now;
  const sample = [...uploadingList, ...attention].slice(0, 20).map((q) => ({
    name: q.file.name,
    sent: q.sent,
    size: q.file.size,
    state: q.state,
  }));
  st.liveSocket.send(
    JSON.stringify({
      type: "progress",
      sessionId,
      slug,
      label: st.link.label,
      uploader: $("who").value.trim() || "anonymous",
      sent: totals.sent,
      total: totals.bytes,
      count: totals.count,
      done: totals.done + totals.warning,
      error: totals.error + totals.canceled,
      speed: Math.round(st.speedBps),
      paused: st.queuePaused,
      // Same rule as the page's own summary: finished once nothing is queued,
      // checking or uploading. Requiring every file to succeed meant a session
      // with a skipped or canceled file never reached "Finished this hour".
      state: totals.count && !(totals.queued + totals.checking + totals.uploading) ? "done" : "uploading",
      files: sample,
    })
  );
}

export async function acquireWakeLock() {
  try {
    if ("wakeLock" in navigator && (!st.wakeLock || st.wakeLock.released)) {
      st.wakeLock = await navigator.wakeLock.request("screen");
    }
  } catch {}
}

export function releaseWakeLock() {
  try {
    st.wakeLock?.release();
  } catch {}
  st.wakeLock = null;
}

export function startCountdown(el, seconds) {
  let left = Math.max(1, seconds);
  el.textContent = `Too many attempts. Try again in ${left}s.`;
  const timer = setInterval(() => {
    left--;
    el.textContent = left > 0 ? `Too many attempts. Try again in ${left}s.` : "Try again now.";
    if (left <= 0) clearInterval(timer);
  }, 1000);
}
