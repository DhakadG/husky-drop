import {
  $,
  ATTENTION_STATES,
  MAX_VISIBLE,
  attention,
  doneRecent,
  leaving,
  queue,
  st,
  totals,
  uploadingList,
} from "./drop-state.js";
import { pump } from "./drop-queue.js";
import { sendLive } from "./drop-live.js";
import { toast } from "./drop-utils.js";

// Rendering: file rows, summary, phase, human error copy.
export function schedulePaint() {
  if (st.paintScheduled) return;
  st.paintScheduled = true;
  requestAnimationFrame(flush);
}

export function flush() {
  st.paintScheduled = false;
  updateSpeed();
  renderVisible();
  renderSummary();
  sendLive(false);
}

export function updateSpeed() {
  const now = Date.now();
  if (!st.speedAt) {
    st.speedAt = now;
    st.speedSent = totals.sent;
    return;
  }
  const dt = (now - st.speedAt) / 1000;
  if (dt < 1) return;
  const inst = Math.max(0, (totals.sent - st.speedSent) / dt);
  st.speedBps = st.speedBps ? st.speedBps * 0.6 + inst * 0.4 : inst;
  if (st.adaptiveController) {
    const nextLimit = st.adaptiveController.observe({
      bps: st.speedBps,
      errors: st.adaptiveErrors,
      saturated: st.active > 0 && queue.some((item) => item.state === "queued"),
    });
    st.adaptiveErrors = 0;
    if (nextLimit !== st.concurrency) {
      st.concurrency = nextLimit;
      pump();
    }
  }
  st.speedAt = now;
  st.speedSent = totals.sent;
}

export function visibleItems() {
  const att = attention.length > 50 ? attention.slice(-50) : attention;
  const pinned = uploadingList.length + att.length + doneRecent.length;
  const room = Math.max(0, MAX_VISIBLE - pinned);
  const queued = [];
  if (st.showAllFiles) return queue;
  if (room > 0 && totals.queued > 0) {
    for (const it of queue) {
      if (it.state !== "queued") continue;
      queued.push(it);
      if (queued.length >= room) break;
    }
  }
  return [...uploadingList, ...leaving, ...att, ...queued, ...doneRecent.filter((it) => !leaving.includes(it))];
}

export function renderVisible() {
  const list = $("list");
  const vis = visibleItems();
  reconcile(list, vis, (item) => item, makeRow, updateRow);

  const hidden = totals.count - vis.length;
  if (st.tailNote) {
    st.tailNote.remove();
    st.tailNote = null;
  }
  const showButton = $("show-all-files");
  showButton.classList.toggle("hidden", hidden <= 0 && !st.showAllFiles);
  showButton.textContent = st.showAllFiles ? "Show active and recent only" : `Show all ${totals.count} files`;
}

export function makeRow(item) {
  const row = document.createElement("div");
  row.className = "file-row";
  row.innerHTML = `
    <div class="file-top">
      <div class="file-name"></div>
      <div class="file-stat"></div>
      <div class="file-actions">
        <button class="row-btn" data-act="retry" type="button">retry</button>
        <button class="row-btn danger" data-act="cancel" type="button">cancel</button>
      </div>
    </div>
    <div class="trail"><i></i></div>`;
  row.querySelector(".file-name").textContent = item.relativePath || item.file.name;
  row._item = item;
  row._bar = row.querySelector(".trail > i");
  row._stat = row.querySelector(".file-stat");
  row._retry = row.querySelector("[data-act='retry']");
  row._cancel = row.querySelector("[data-act='cancel']");
  return row;
}

export function updateRow(el, item) {
  const pct = item.file.size ? Math.min(100, (item.sent / item.file.size) * 100) : 100;
  el._bar.style.width = `${pct}%`;
  el._stat.textContent = rowStat(item);
  el._stat.className = `file-stat ${statClass(item.state)}`;
  el.className = `file-row ${item.state}${leaving.includes(item) ? " leaving" : ""}`;
  const canRetry = ATTENTION_STATES.has(item.state);
  const canCancel = item.state === "queued" || item.state === "uploading";
  el._retry.classList.toggle("hidden", !canRetry);
  el._cancel.classList.toggle("hidden", !canCancel);
  el.classList.toggle("has-actions", canRetry || canCancel);
}

export function rowStat(item) {
  if (item.stat) return item.stat;
  if (item.state === "uploading") return `${fmtBytes(item.sent)} / ${fmtBytes(item.file.size)}`;
  if (item.state === "done") return `${fmtBytes(item.file.size)} done`;
  if (item.state === "warning") return "Drive saved - log delayed";
  if (item.state === "canceled") return "canceled";
  return item.state;
}

export function statClass(state) {
  if (state === "done") return "ok";
  if (state === "error" || state === "canceled") return "err";
  if (state === "warning") return "warn";
  return "";
}

export function renderSummary() {
  const pct = totals.bytes ? Math.floor((totals.sent / totals.bytes) * 100) : 0;
  $("pct").textContent = pct;
  $("totalbar").style.width = `${pct}%`;
  $("progress-ring-value").style.strokeDashoffset = String(163.36 * (1 - pct / 100));
  $("detail").textContent = st.queuePaused ? `Paused · ${detailText()}` : detailText();
  // "warning" files are in Drive too (only the dashboard record lagged), so
  // the queue is finished once nothing is queued or uploading.
  const landed = totals.done + totals.warning;
  const inFlight = totals.queued + totals.uploading;
  $("queue-title").textContent = !inFlight && totals.count ? `Delivered ${landed} of ${totals.count} files` : st.queuePaused ? `Paused — ${landed} of ${totals.count} files delivered` : `Uploading — ${landed} of ${totals.count} files`;
  const completed = totals.count > 0 && totals.done === totals.count;
  document.body.dataset.phase = !totals.count ? "ready" : completed ? "done" : st.networkPaused ? "offline" : st.queuePaused ? "paused" : totals.error ? "attention" : "uploading";
  $("add-more-bar").classList.toggle("hidden", !totals.count || completed);
  // Nothing left to protect once everything landed: drop the "keep this page
  // open" banner and the pause button instead of nagging under a green tick.
  document.querySelector(".keep-open")?.classList.toggle("hidden", !inFlight);
  $("pause-all").classList.toggle("hidden", !inFlight);
  $("done-card").classList.toggle("hidden", !completed);
  if (completed) {
    $("done-title").textContent = totals.done === 1 ? "Your file is delivered" : `All ${totals.done} files delivered`;
    const videos = doneRecent.filter((it) => /^video\//.test(it.file.type || "")).length;
    $("done-recap").textContent = `${fmtBytes(totals.bytes)} saved to the collector’s Drive.${videos ? " Videos get a streaming copy overnight so they play instantly when shared." : ""}`;
  }

  const failed = totals.error + totals.warning + totals.canceled;
  const pending = totals.queued + totals.uploading;
  const retryBtn = $("retry-all");
  const cancelBtn = $("cancel-all");
  if (retryBtn) {
    retryBtn.classList.toggle("hidden", failed === 0);
    retryBtn.innerHTML = `${uiIcon("refresh-cw")}${failed ? `Retry ${failed} failed` : "Retry failed"}`;
  }
  if (cancelBtn) cancelBtn.classList.toggle("hidden", pending === 0);

  maybeQueueNotice();
}

// The row shows what the uploader can act on, never a stack-trace fragment;
// the raw message still goes to the admin via reportError().
export function humanError(err) {
  const status = Number(err?.status) || 0;
  const message = String(err?.message || "");
  if (!navigator.onLine || /network|offline|failed to fetch|probe/i.test(message)) return "Connection dropped - tap retry";
  if (status === 401) return "Sign-in expired - reload the page";
  if (status === 403) return "This link no longer accepts uploads";
  if (status === 410) return "This link has closed";
  if (status === 413) return "Upload budget reached";
  if (status === 507) return "The collector's Drive is full";
  if (status >= 500 || /is not defined|TypeError|internal error|KV/i.test(message)) return "Server hiccup - tap retry";
  if (/too large/i.test(message)) return "File too large for this link";
  return message && message.length < 60 && !/[{}<>]/.test(message) ? message : "Couldn't upload - tap retry";
}

export function detailText() {
  const { done, error, warning, canceled, count, sent, bytes } = totals;
  if (st.active > 0) {
    const remaining = Math.max(0, bytes - sent);
    const eta = st.speedBps > 0 ? ` - ~${fmtTime(remaining / st.speedBps)} left` : "";
    const rate = st.speedBps > 0 ? ` - ${fmtBytes(st.speedBps)}/s` : "";
    return `${done}/${count} files - ${fmtBytes(sent)} of ${fmtBytes(bytes)}${rate}${eta}`;
  }
  const need = error + warning + canceled;
  if (need) return `${done} done - ${need} need attention, tap retry`;
  if (count && done === count) return `all ${done} files are in Drive`;
  return "waiting";
}

export function maybeQueueNotice() {
  const stateKey = `${totals.done}:${totals.error}:${totals.warning}:${totals.canceled}:${totals.count}:${st.active}`;
  if (!totals.count || st.active !== 0 || stateKey === st.lastQueueNotice) return;
  st.lastQueueNotice = stateKey;
  if (totals.error || totals.canceled) {
    const need = totals.error + totals.canceled;
    toast(`${need} file${need === 1 ? "" : "s"} need attention`, "Tap a row's retry button to resend it.", "err");
  } else if (totals.warning) {
    toast("Upload needs verification", "Drive received the files; tap retry to finish the dashboard log.", "warn");
  } else if (totals.done === totals.count) {
    toast("Upload complete", `${totals.done} file${totals.done === 1 ? "" : "s"} saved to Drive.`, "ok");
  }
}
