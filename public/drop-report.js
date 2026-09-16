import { $, slug, st, totals } from "./drop-state.js";
import { toast } from "./drop-utils.js";

// Client error reporting to the admin. Reports carry a short trail of what
// the page was doing (breadcrumbs) and a state snapshot so the admin can
// reproduce a crash from the System log without asking the uploader.
const crumbs = [];
export function crumb(text) {
  crumbs.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
  if (crumbs.length > 30) crumbs.shift();
}
function snapshot() {
  const c = navigator.connection || {};
  return { phase: document.body.dataset.phase || "", queued: totals.queued, uploading: totals.uploading, done: totals.done, errors: totals.error, online: navigator.onLine, paused: !!st.queuePaused, network: !!st.networkPaused, effectiveType: c.effectiveType || "", viewport: `${innerWidth}x${innerHeight}`, link: !!st.link };
}
export function installErrorReporting() {
  window.addEventListener("error", (e) => {
    st.lastClientError = `${e.message} @ ${e.filename}:${e.lineno}`;
    autoReport("window.onerror", e.message, { where: `${e.filename}:${e.lineno}:${e.colno}`, stack: e.error?.stack });
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason?.message || String(e.reason || "unhandled rejection");
    st.lastClientError = msg;
    autoReport("unhandledrejection", msg, { stack: e.reason?.stack });
  });
}

export function autoReport(name, message, extra = {}) {
  if (st.errorReports >= 3) return;
  st.errorReports++;
  sendErrorReport(name, message, extra);
}

export function reportError(name, err, context = "") {
  st.lastClientError = `${context ? context + ": " : ""}${err?.message || err}`;
  autoReport(name, st.lastClientError);
}

export function reportProblem() {
  sendErrorReport(
    "manual-report",
    st.lastClientError || `no captured error - ${totals.done}/${totals.count} done, ${totals.error} errors`
  );
  toast("Report sent", "Thanks - the admin can now see what went wrong.", "ok");
}

export function sendErrorReport(name, message, extra = {}) {
  fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      linkId: slug,
      uploader: $("who")?.value?.trim() || "",
      name,
      message: String(message || "").slice(0, 300),
      stack: String(extra.stack || "").slice(0, 1200),
      where: String(extra.where || "").slice(0, 200),
      url: location.pathname + location.hash,
      state: snapshot(),
      crumbs,
    }),
  }).catch(() => {});
}
