import {
  $,
  ATTENTION_CAP,
  ATTENTION_STATES,
  DONE_TAIL,
  FAST_CHUNK_MS,
  MAX_ACTIVE,
  MAX_CHUNK,
  MAX_RETRIES,
  MEM_WINDOW,
  MIN_CHUNK,
  STALL_MS,
  attention,
  doneRecent,
  leaving,
  queue,
  sessionId,
  slug,
  st,
  totals,
  uploadingList,
} from "./drop-state.js";
import { setConnection } from "./drop.js";
import { saveResumeRecord, deleteResumeRecord } from "./drop-resume.js";
import { crumb, reportError } from "./drop-report.js";
import { schedulePaint, humanError } from "./drop-render.js";
import { sendLive, acquireWakeLock, releaseWakeLock } from "./drop-live.js";
import { toast, sleep } from "./drop-utils.js";

// Upload engine: queue, concurrency, chunked resumable PUTs, retries,
// cancel/pause, session minting and completion.
export function toggleQueuePause() {
  st.queuePaused = !st.queuePaused;
  $("pause-all").innerHTML = `${uiIcon(st.queuePaused ? "play" : "pause")}${st.queuePaused ? "Resume" : "Pause"}`;
  crumb(st.queuePaused ? "queue paused" : "queue resumed");
  $("pause-all").classList.toggle("active", st.queuePaused);
  sendLive(true);
  schedulePaint();
  if (!st.queuePaused) pump();
}

// Step 1 shows a tick once there is a name, so the page reads as progress.
export function syncNameStep() {
  document.querySelector(".dv4-name")?.classList.toggle("done", !!$("who").value.trim());
}

// Going offline pauses the queue without touching the user's own pause; back
// online re-queues what failed meanwhile and resumes.
export function setNetworkPaused(offline) {
  if (st.networkPaused === offline) return;
  st.networkPaused = offline;
  crumb(offline ? "network offline" : "network back");
  $("offline-notice").classList.toggle("hidden", !offline);
  if (offline) {
    setConnection("offline");
    toast("You're offline", "Uploads pause here and resume on their own.", "warn");
  } else {
    setConnection(st.liveSocket && st.liveSocket.readyState === 1 ? "live" : "secure");
    toast("Back online", "Resuming where you left off.", "ok");
    retryAll();
    pump();
  }
  sendLive(true);
  schedulePaint();
}

export function setState(item, next) {
  if (item.state === next) return;
  totals[item.state]--;
  if (item.state === "uploading") removeFrom(uploadingList, item);
  if (ATTENTION_STATES.has(item.state)) removeFrom(attention, item);

  item.state = next;
  totals[next]++;
  if (next === "uploading") {
    if (!item.stat) item.stat = "starting";
    uploadingList.push(item);
  } else if (ATTENTION_STATES.has(next)) {
    attention.push(item);
    if (attention.length > ATTENTION_CAP) attention.shift();
  } else if (next === "done") {
    item.stat = "";
    doneRecent.push(item);
    if (doneRecent.length > DONE_TAIL) doneRecent.shift();
    leaving.push(item);
    setTimeout(() => {
      removeFrom(leaving, item);
      schedulePaint();
    }, 1400);
  }
  schedulePaint();
}

export function removeFrom(list, item) {
  const i = list.indexOf(item);
  if (i !== -1) list.splice(i, 1);
}

export function setSent(item, value) {
  totals.sent += value - item.sent;
  item.sent = value;
}

function itemWeight(item) {
  return Math.min(item.file.size - item.sent, item.chunk || st.chunkSize);
}

function activeWeight() {
  let w = 0;
  for (const it of uploadingList) w += itemWeight(it);
  return w;
}

export function pump() {
  if (st.queuePaused || st.networkPaused) {
    sendLive(true);
    schedulePaint();
    return;
  }
  // Parallelism is a file count (the adaptive controller tunes it). The old
  // byte window was concurrency x chunk, so once chunks grew to 128 MB only
  // two files could run at once and a gigabit link sat half idle.
  while (st.active < Math.min(st.concurrency, MAX_ACTIVE)) {
    const next = queue.find((q) => q.state === "queued");
    if (!next) break;
    const w = Math.min(next.file.size, next.chunk || st.chunkSize);
    if (st.active > 0 && activeWeight() + w > MEM_WINDOW) break;
    st.active++;
    uploadFile(next).finally(() => {
      st.active--;
      if (st.active === 0 && !queue.some((q) => q.state === "queued")) releaseWakeLock();
      pump();
      schedulePaint();
    });
  }
  if (st.active > 0) acquireWakeLock();
}

async function uploadFile(item) {
  item.canceled = false;
  item.stat = "";
  setState(item, "uploading");
  window.dropTrekker?.track("upload_start", item.file.name, { size: item.file.size, mime: item.file.type || "", resumed: !!item.resumedUri, uploadSessionId: sessionId });
  schedulePaint();
  try {
    await ensureSession(item);
    if (item.canceled) return;
    prefetchNextSessions();

    let offset = item.sent;
    if (item.resumedUri) {
      item.stat = "checking previous upload";
      schedulePaint();
      try {
        offset = await probeOffset(item);
        setSent(item, offset);
        if (offset > 0) {
          toast("Resuming upload", `${item.file.name} continues from ${fmtBytes(offset)}.`, "ok");
          window.dropTrekker?.track("upload_resumed", item.file.name, { offset, size: item.file.size, uploadSessionId: sessionId });
        }
      } catch {
        item.uri = null;
        setSent(item, 0);
        offset = 0;
        await ensureSession(item);
      }
      item.resumedUri = false;
    }

    while (offset < item.file.size) {
      if (item.canceled) return;
      const chunkStarted = Date.now();
      try {
        offset = await putChunk(item, offset);
        const milestone = Math.min(100, Math.floor((offset / Math.max(1, item.file.size)) * 4) * 25);
        if (milestone > (item._telemetryMilestone || 0)) {
          item._telemetryMilestone = milestone;
          window.dropTrekker?.track("upload_progress", item.file.name, { percent: milestone, sent: offset, size: item.file.size, chunk: item.chunk, uploadSessionId: sessionId });
        }
        item.retries = 0;
        const took = Date.now() - chunkStarted;
        if (took < FAST_CHUNK_MS && item.chunk < MAX_CHUNK) {
          // Grow, but never let all active chunks together outrun the memory window.
          item.chunk = Math.min(MAX_CHUNK, item.chunk * 2, Math.max(MIN_CHUNK, Math.floor(MEM_WINDOW / Math.max(1, st.active))));
        }
      } catch (err) {
        if (item.canceled) return;
        st.adaptiveErrors++;
        if (err.dead) {
          item.uri = null;
          setSent(item, 0);
          offset = 0;
          await ensureSession(item);
          continue;
        }
        if (item.chunk > MIN_CHUNK) item.chunk = Math.max(MIN_CHUNK, item.chunk / 2);
        if (++item.retries > MAX_RETRIES) throw err;
        window.dropTrekker?.track("upload_retry", item.file.name, { retry: item.retries, status: err.status || 0, chunk: item.chunk, uploadSessionId: sessionId });
        const wait = Math.min(30000, 1000 * 2 ** item.retries);
        item.stat = `${humanError(err).replace(/ - tap retry$/, "")} · retrying in ${Math.round(wait / 1000)}s`;
        schedulePaint();
        await sleep(wait);
        if (item.canceled) return;
        offset = await probeOffset(item).catch(() => offset);
        setSent(item, offset);
      }
    }

    setSent(item, item.file.size);
    setState(item, "done");
    finalizeComplete(item);
    window.dropTrekker?.track("upload_bytes_complete", item.file.name, { size: item.file.size, retries: item.retries || 0, uploadSessionId: sessionId });
  } catch (err) {
    if (item.canceled) return;
    if (err.status === 413) {
      st.queuePaused = true;
      $("pause-all").innerHTML = `${uiIcon("play")}Resume`;
      $("budget-notice").classList.remove("hidden");
    }
    item.stat = humanError(err);
    setState(item, "error");
    crumb(`upload failed: ${item.file.name} - ${err?.message || err}`);
    reportError("upload", err, item.file.name);
    window.dropTrekker?.track("upload_error", item.file.name, { size: item.file.size, status: err.status || 0, message: String(err.message || err).slice(0, 120), retries: item.retries || 0, uploadSessionId: sessionId });
    toast("Couldn't upload a file", `${item.file.name}: ${humanError(err)}`, "err");
  }
}

export function sessionBody(item) {
  return JSON.stringify({
    linkId: slug,
    pin: st.pin,
    filename: item.file.name,
    size: item.file.size,
    mimeType: item.file.type || "application/octet-stream",
    uploaderName: $("who").value.trim(),
    sessionId,
    relativePath: st.link.settings?.perUploaderFolders ? "" : item.relativePath || "",
    queueCount: totals.count,
    queueBytes: totals.bytes,
    // The Drive resumable session is CORS-bound to this page's origin; the
    // Worker cannot always see it (wrangler dev rewrites Host and Origin to
    // the configured route), so the browser states it explicitly.
    pageOrigin: location.origin,
  });
}

export async function ensureSession(item) {
  if (item.uri) return;
  const r = await fetch("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: sessionBody(item),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 429) throw new Error(`locked for ${d.retryAfter || 60}s`);
  if (!r.ok) {
    const error = new Error(d.error || `session HTTP ${r.status}`);
    error.status = r.status;
    throw error;
  }
  item.uri = d.sessionUri;
  window.dropTrekker?.track("upload_session_created", item.file.name, { size: item.file.size, mime: item.file.type || "", uploadSessionId: sessionId });
  saveResumeRecord(item);
}

export function prefetchNextSessions() {
  let spare = 0;
  for (const q of queue) {
    if (q.state === "queued" && q.uri) spare++;
  }
  // Keep a Drive session ready for every slot that could open next, so a
  // small file never sits in an active slot waiting on the Worker round-trip.
  let want = MAX_ACTIVE - spare;
  if (want <= 0) return;
  for (const next of queue) {
    if (want <= 0) break;
    if (next.state !== "queued" || next.uri || next._prefetching) continue;
    want--;
    next._prefetching = true;
    fetch("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: sessionBody(next),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.sessionUri) {
          next.uri = d.sessionUri;
          saveResumeRecord(next);
        }
      })
      .catch(() => {})
      .finally(() => {
        next._prefetching = false;
      });
  }
}

// The bytes are already in Drive by now; this only files the record. Retry
// transient failures so one flaky moment does not park the file in "warning"
// and leave the whole queue reading "Uploading" forever.
async function finalizeComplete(item, attempt = 0) {
  const r = await fetch("/api/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      linkId: slug,
      filename: item.file.name,
      size: item.file.size,
      mimeType: item.file.type,
      uploader: $("who").value.trim(),
      fileId: item.fileId || "",
      sessionId,
    }),
  }).catch(() => null);
  if (r?.ok) {
    window.dropTrekker?.track("upload_complete", item.file.name, { size: item.file.size, mime: item.file.type || "", fileId: item.fileId || "", uploadSessionId: sessionId });
    item.stat = "";
    if (item.state !== "done") {
      setState(item, "done");
      sendLive(true);
    } else schedulePaint();
    deleteResumeRecord(item);
    return;
  }
  // 4xx means the record itself is wrong (size mismatch, wrong link); only
  // network failures and 5xx are worth another go.
  if ((!r || r.status >= 500) && attempt < 4) {
    await sleep(1000 * 2 ** attempt);
    return finalizeComplete(item, attempt + 1);
  }
  item.stat = "Drive saved - log delayed";
  setState(item, "warning");
}

export function retryItem(item) {
  if (!ATTENTION_STATES.has(item.state)) return;
  item.canceled = false;
  item.retries = 0;
  if (item.fileId) {
    item.stat = "verifying";
    setState(item, "uploading");
    finalizeComplete(item);
  } else {
    item.stat = "";
    setState(item, "queued");
    pump();
  }
}

export function cancelItem(item) {
  if (item.state === "done" || item.state === "canceled") return;
  item.canceled = true;
  try {
    item.xhr?.abort();
  } catch {}
  item.xhr = null;
  item.stat = "canceled";
  setState(item, "canceled");
}

export function retryAll() {
  let n = 0;
  for (const it of queue) {
    if (ATTENTION_STATES.has(it.state)) {
      retryItem(it);
      n++;
    }
  }
  if (n) toast("Retrying", `${n} file${n === 1 ? "" : "s"} re-queued.`, "ok");
}

export function cancelAll() {
  let n = 0;
  for (const it of queue) {
    if (it.state === "queued" || it.state === "uploading") {
      cancelItem(it);
      n++;
    }
  }
  if (n) toast("Canceled", `${n} file${n === 1 ? "" : "s"} stopped.`, "warn");
}

export function putChunk(item, offset) {
  return new Promise((resolve, reject) => {
    const size = item.chunk || st.chunkSize;
    const end = Math.min(offset + size, item.file.size);
    const xhr = new XMLHttpRequest();
    item.xhr = xhr;
    xhr.open("PUT", item.uri);
    xhr.setRequestHeader("Content-Range", `bytes ${offset}-${end - 1}/${item.file.size}`);
    const clear = () => {
      if (item.xhr === xhr) item.xhr = null;
      clearTimeout(stallTimer);
    };
    let stallTimer = setTimeout(() => xhr.abort(), STALL_MS);
    xhr.upload.onprogress = (e) => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => xhr.abort(), STALL_MS);
      item.stat = "";
      setSent(item, offset + e.loaded);
      schedulePaint();
    };
    xhr.onload = () => {
      clear();
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range");
        const next = range ? parseInt(range.split("-").pop(), 10) + 1 : end;
        setSent(item, next);
        resolve(next);
      } else if (xhr.status === 200 || xhr.status === 201) {
        try {
          item.fileId = JSON.parse(xhr.responseText).id;
          saveResumeRecord(item);
        } catch {}
        setSent(item, item.file.size);
        resolve(item.file.size);
      } else {
        const err = new Error(`upload HTTP ${xhr.status}`);
        if (xhr.status === 400 || xhr.status === 404 || xhr.status === 410) err.dead = true;
        reject(err);
      }
    };
    xhr.onerror = () => {
      clear();
      reject(new Error("network drop"));
    };
    xhr.ontimeout = () => {
      clear();
      reject(new Error("timeout"));
    };
    xhr.onabort = () => {
      clear();
      reject(item.canceled ? new Error("canceled") : new Error("stalled"));
    };
    xhr.send(item.file.slice(offset, end));
  });
}

export function probeOffset(item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", item.uri);
    xhr.setRequestHeader("Content-Range", `bytes */${item.file.size}`);
    xhr.onload = () => {
      if (xhr.status === 308) {
        const range = xhr.getResponseHeader("Range");
        resolve(range ? parseInt(range.split("-").pop(), 10) + 1 : 0);
      } else if (xhr.status === 200 || xhr.status === 201) {
        try {
          item.fileId = item.fileId || JSON.parse(xhr.responseText).id;
        } catch {}
        resolve(item.file.size);
      } else reject(new Error(`probe HTTP ${xhr.status}`));
    };
    xhr.onerror = () => reject(new Error("probe network"));
    xhr.send();
  });
}
