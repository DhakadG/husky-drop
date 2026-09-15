import { $, slug, st, totals } from "./drop-state.js";
import { toast } from "./drop-utils.js";

// Client error reporting to the admin activity feed.
export function installErrorReporting() {
  window.addEventListener("error", (e) => {
    st.lastClientError = `${e.message} @ ${e.filename}:${e.lineno}`;
    autoReport("window.onerror", e.message);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const msg = e.reason?.message || String(e.reason || "unhandled rejection");
    st.lastClientError = msg;
    autoReport("unhandledrejection", msg);
  });
}

export function autoReport(name, message) {
  if (st.errorReports >= 3) return;
  st.errorReports++;
  sendErrorReport(name, message);
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

export function sendErrorReport(name, message) {
  fetch("/api/client-error", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      linkId: slug,
      uploader: $("who")?.value?.trim() || "",
      name,
      message: String(message || "").slice(0, 300),
    }),
  }).catch(() => {});
}
