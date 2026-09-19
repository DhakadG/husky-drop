import { createVideoWarmLease } from "./share-video-session.js";
import { canHoverPreview, fx, previewVideos, selected, videoWarmLeases } from "./share-state.js";
import { fmtDur } from "./share-utils.js";
import { ensureFreshDownload, tokenFresh } from "./share-download.js";
import { inlineUrl, previewUrl, scheduleLayout } from "./share.js";

// Hover preview: play by default, deliberate scrubbing, buffered bar.
// ---- Hover preview: play by default, deliberate scrubbing, buffered bar ----
//
// One state machine per card (idle -> playing -> scrubbing). Desktop scrub
// reads e.shiftKey live on every pointermove instead of tracking a global
// "is Shift down" flag - a global flag goes stale the moment a keyup is
// missed (losing focus, a browser shortcut, alt-tabbing while the key is
// down), which is exactly what caused scrubbing to get stuck on. Reading
// the key state directly off each event is self-correcting: the very next
// mouse move always reflects reality.

export function installHoverPreview(fig, file) {
  if (!/^video\//.test(file.mime)) return;
  let seekTarget = NaN;
  let startPromise = null;
  const state = { scrubbing: false, hovering: false };

  const requestPreview = () => {
    if (!startPromise) {
      startPromise = startHoverPreview(fig, file, { reset: true, isCurrent: () => state.hovering }).finally(() => {
        startPromise = null;
      });
    }
    return startPromise;
  };

  const beginScrub = () => {
    const video = previewVideos.get(file.id);
    if (!video || !Number.isFinite(video.duration) || video.duration <= 0 || !fig.classList.contains("previewing")) return false;
    state.scrubbing = true;
    video.pause();
    video.addEventListener("seeked", applySeek);
    fig.classList.add("scrubbing");
    fx.setScrubbing(true, fig);
    return true;
  };

  // One seek in flight at a time: the browser queues nothing, so firing a
  // seek per pointermove made every frame fight the previous decode. The
  // latest target waits here and goes out the moment `seeked` fires.
  const applySeek = () => {
    const video = previewVideos.get(file.id);
    if (!video || video.seeking || !Number.isFinite(seekTarget)) return;
    const t = seekTarget;
    seekTarget = NaN;
    if (Math.abs(video.currentTime - t) > 0.04) video.currentTime = t;
  };

  // Always sets --scrub-x (and the timestamp badge) in the same synchronous
  // step that turns scrubbing on, so the playhead/badge never has a frame
  // where it's showing at its CSS default (dead center) before JS catches up.
  const scrubTo = (clientX) => {
    const video = previewVideos.get(file.id);
    if (!video || !video.duration) return;
    const r = fig.getBoundingClientRect();
    const pct = Math.max(0, Math.min(0.999, (clientX - r.left) / r.width));
    const t = pct * video.duration;
    fig.style.setProperty("--scrub-x", `${pct * 100}%`);
    updateScrubBadge(fig, video, t);
    seekTarget = t;
    applySeek();
  };

  const endScrub = ({ resume = true, stopPreview = false } = {}) => {
    if (!state.scrubbing) return;
    seekTarget = NaN;
    previewVideos.get(file.id)?.removeEventListener("seeked", applySeek);
    state.scrubbing = false;
    fig.classList.remove("scrubbing");
    fig.style.removeProperty("--scrub-x");
    fx.setScrubbing(false, fig);
    const video = previewVideos.get(file.id);
    if (stopPreview) stopHoverPreview(fig, file, { removeBar: true });
    else if (resume && video && fig.classList.contains("previewing")) video.play().catch(() => {});
  };

  if (canHoverPreview) {
    fig.addEventListener("pointerenter", (e) => {
      if (selected.size || e.pointerType !== "mouse") return;
      state.hovering = true;
      void requestPreview();
    });

    // The single desktop mouse handler: Shift held -> scrub; Shift not held
    // while a scrub was in progress -> resume normal playback. No separate
    // "shift mode" flag to fall out of sync with the key.
    fig.addEventListener("pointermove", (e) => {
      if (selected.size || e.pointerType !== "mouse") return;
      if (e.shiftKey) {
        if (!fig.classList.contains("previewing")) return requestPreview();
        if (!state.scrubbing && !beginScrub()) return;
        scrubTo(e.clientX);
      } else if (state.scrubbing) {
        endScrub({ resume: true });
      }
    });

    fig.addEventListener("pointerleave", (e) => {
      if (e.pointerType !== "mouse") return;
      state.hovering = false;
      endScrub({ resume: false });
      stopHoverPreview(fig, file);
    });
  }

}

async function startHoverPreview(fig, file, opts = {}) {
  if (!fig.isConnected || selected.size) return;
  const lease = videoWarmLease(file);
  lease.claim("preview");
  try {
    const video = await getPreviewVideo(file);
    if (!fig.isConnected || selected.size || opts.isCurrent?.() === false) {
      lease.release("preview");
      return;
    }
    if (opts.reset) resetPreviewTime(video);
    const media = fig.querySelector(".g-media") || fig.querySelector(".file-ico");
    const hadThumb = !!file.thumb;
    video.className = "g-video-preview";
    video.controls = false;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    if (media && video.parentNode !== media) {
      // Keep the still thumbnail visible underneath until the video can
      // actually play, instead of a black frame while it buffers.
      fig.classList.add("buffering");
      video.style.opacity = "0";
      media.appendChild(video);
    }
    // Every hover, not just the one that parented the video: the bar tears
    // itself down on pointerleave, and the branch above only runs once, so the
    // second hover onwards had no progress bar at all.
    if (media) attachBufferBar(media, video, fig);
    revealPreviewWhenReady(fig, file, video, hadThumb);
    fig.classList.add("previewing");
    await video.play().catch(() => {});
  } catch {
    lease.release("preview");
    // Some browser/codec combinations refuse hover preview; click playback still works.
  }
}

export function stopHoverPreview(fig, file, opts = {}) {
  videoWarmLease(file).release("preview");
  fig.classList.remove("previewing", "buffering");
  const video = previewVideos.get(file.id);
  if (!video) return;
  video.pause();
  if (opts.removeBar) {
    fig.querySelector(".buffer-bar")?.remove();
    fig._scrubBadge = null;
  }
}

function resetPreviewTime(video) {
  const reset = () => {
    // A fresh warm element is already at 0; seeking there anyway forces a
    // round trip to the media proxy before the first frame.
    if (video.currentTime < 0.05) return;
    try {
      video.currentTime = 0;
    } catch {}
  };
  if (video.readyState >= 1) reset();
  else video.addEventListener("loadedmetadata", reset, { once: true });
}

function revealPreviewWhenReady(fig, file, video, hadThumb) {
  let revealed = false;
  const reveal = () => {
    if (revealed) return;
    revealed = true;
    if (!hadThumb) promoteVideoFrameAsThumb(file, fig, video);
    video.style.opacity = "";
    fig.classList.remove("buffering");
    updateScrubBadge(fig, video);
  };
  if (video.readyState >= 2) reveal();
  else {
    fig.classList.add("buffering");
    video.style.opacity = "0";
    video.addEventListener("loadeddata", reveal, { once: true });
    video.addEventListener("canplay", reveal, { once: true });
  }
}

// Captures a representative frame and keeps it as this file's thumbnail for
// the rest of the session, so a no-thumbnail tile doesn't go blank again the
// moment the pointer leaves it. Seeks a little into the clip first - frame 0
// is frequently black or still fading in right after a cut - and falls back
// to whatever frame is already showing if the seek doesn't settle quickly.
// Runs once per file (guarded by file.thumb / _sessionThumbFailed) and never
// blocks the live hover preview, which keeps playing throughout.
function promoteVideoFrameAsThumb(file, fig, video) {
  if (file.thumb || file._sessionThumbFailed || !video.videoWidth || !video.videoHeight) return;

  const capture = () => {
    try {
      const maxW = 720;
      const scale = Math.min(1, maxW / video.videoWidth);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      file.thumb = canvas.toDataURL("image/jpeg", 0.78);
      file.aspect = video.videoWidth / video.videoHeight;

      const img = document.createElement("img");
      img.loading = "eager";
      img.decoding = "async";
      img.alt = file.name;
      img.src = file.thumb;

      const host = video.parentElement;
      if (host?.classList.contains("file-ico")) {
        const mediaBox = document.createElement("div");
        mediaBox.className = "g-media session-thumb";
        mediaBox.appendChild(img);
        host.replaceWith(mediaBox);
        mediaBox.appendChild(video);
        attachBufferBar(mediaBox, video, fig);
      } else if (host?.classList.contains("g-media") && !host.querySelector("img")) {
        host.prepend(img);
      }
      fig.classList.remove("plain");
      fig.dataset.cursor = "video";
      scheduleLayout();
    } catch {
      file._sessionThumbFailed = true;
    }
  };

  const target = Math.min(1, (video.duration || 0) * 0.1);
  if (!target || video.currentTime >= target - 0.05) {
    capture();
    return;
  }
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    video.removeEventListener("seeked", finish);
    capture();
  };
  const timer = setTimeout(finish, 600);
  video.addEventListener("seeked", finish, { once: true });
  try {
    if (video.fastSeek) video.fastSeek(target);
    else video.currentTime = target;
  } catch {
    finish();
  }
}

// Small buffered/played bar pinned to the bottom of a hovering video tile -
// there are no native controls in hover mode, so this is the only feedback
// for "how much of this video has loaded" while scrubbing.
function attachBufferBar(host, video, fig) {
  const existing = host.querySelector(".buffer-bar");
  if (existing) {
    fig._scrubBadge = existing.querySelector(".scrub-time");
    return;
  }
  const bar = document.createElement("div");
  bar.className = "buffer-bar";
  bar.innerHTML = `<i class="buffered"></i><i class="played"></i><em class="scrub-time"></em>`;
  host.appendChild(bar);
  const buffered = bar.querySelector(".buffered");
  const played = bar.querySelector(".played");
  fig._scrubBadge = bar.querySelector(".scrub-time");
  const paint = () => {
    const d = video.duration || 0;
    let buf = 0;
    for (let i = 0; i < video.buffered.length; i++) buf = Math.max(buf, video.buffered.end(i));
    buffered.style.width = d ? `${Math.min(100, (buf / d) * 100)}%` : "0%";
    played.style.width = d ? `${Math.min(100, (video.currentTime / d) * 100)}%` : "0%";
    updateScrubBadge(fig, video);
  };
  for (const ev of ["progress", "loadedmetadata", "seeking", "seeked", "pause"]) video.addEventListener(ev, paint);
  // timeupdate only fires ~4x/s; drive the played bar from rAF while playing.
  let raf = 0;
  const tick = () => {
    paint();
    raf = video.paused || !bar.isConnected ? 0 : requestAnimationFrame(tick);
  };
  const start = () => { if (!raf) raf = requestAnimationFrame(tick); };
  video.addEventListener("play", start);
  if (!video.paused) start();
  fig?.addEventListener("pointerleave", () => {
    bar.remove();
    cancelAnimationFrame(raf);
    raf = 0;
    video.removeEventListener("play", start);
    for (const ev of ["progress", "loadedmetadata", "seeking", "seeked", "pause"]) video.removeEventListener(ev, paint);
  }, { once: true });
}

function updateScrubBadge(fig, video, time = video.currentTime) {
  const badge = fig?._scrubBadge;
  if (!badge || !video.duration) return;
  badge.textContent = `${fmtDur(time)} / ${fmtDur(video.duration)}`;
}

export async function probeVideoMetadata(file) {
  if (!/^video\//.test(file.mime) || file.aspect) return;
  try {
    const video = await getPreviewVideo(file);
    if (video.videoWidth && video.videoHeight) {
      file.aspect = video.videoWidth / video.videoHeight;
      scheduleLayout();
    }
  } catch {
    // Keep the stable placeholder ratio.
  } finally {
    videoWarmLease(file).scheduleRelease();
  }
}

// Videos that Drive gave no thumbnail for used to sit as a blank file chip
// until the pointer landed on them, because grabbing a frame only happened
// inside the hover preview. Tiles on screen now pull their own poster.
// Three at a time: each one downloads the 720p preview to decode a frame.
const posterQueue = [];
let posterBusy = 0;
const POSTER_PARALLEL = 3;

export function ensureVideoPoster(file, fig) {
  if (!/^video\//.test(file.mime) || file.thumb || file._sessionThumbFailed || file._posterBusy) return;
  file._posterBusy = true;
  posterQueue.push([file, fig]);
  pumpPosters();
}

function pumpPosters() {
  while (posterBusy < POSTER_PARALLEL && posterQueue.length) {
    const [file, fig] = posterQueue.shift();
    posterBusy += 1;
    capturePoster(file, fig).finally(() => {
      // Never latch: an attempt that produced nothing must leave hovering
      // free to try again, or a tile that failed once stays blank forever.
      file._posterBusy = false;
      posterBusy -= 1;
      pumpPosters();
    });
  }
}

const once = (video, event, ms) =>
  new Promise((resolve) => {
    const done = () => resolve();
    video.addEventListener(event, done, { once: true });
    video.addEventListener("error", done, { once: true });
    setTimeout(done, ms);
  });

async function capturePoster(file, fig) {
  if (!fig.isConnected || file.thumb) return;
  const lease = videoWarmLease(file);
  lease.claim("poster");
  try {
    const video = await getPreviewVideo(file);
    if (!fig.isConnected || file.thumb) return;
    // getPreviewVideo asks for metadata only, which stops at readyState 1 and
    // leaves no frame to draw. Ask for data before waiting for it.
    if (video.preload !== "auto") video.preload = "auto";
    if (video.readyState < 1) await once(video, "loadedmetadata", 12_000);
    if (!video.videoWidth || !fig.isConnected || file.thumb) return;
    if (!file.aspect) {
      file.aspect = video.videoWidth / video.videoHeight;
      scheduleLayout();
    }
    if (video.readyState < 2) {
      video.load?.();
      await once(video, "loadeddata", 12_000);
    }
    if (video.readyState < 2) return;
    // Seeks to a representative frame and swaps the blank chip for a real
    // tile; shared with the hover path.
    promoteVideoFrameAsThumb(file, fig, video);
  } catch {
    // Leave _sessionThumbFailed alone: hovering gets another go.
  } finally {
    lease.release("poster");
    lease.scheduleRelease();
  }
}

async function getPreviewVideo(file) {
  let video = previewVideos.get(file.id);
  const lease = videoWarmLease(file);
  const low = previewUrl(file);
  let source = lease.sourceFor((candidate) => (low ? candidate === low : tokenFresh(file) && candidate === inlineUrl(file)));
  if (!source && low) source = lease.remember(low);
  if (!source) {
    await ensureFreshDownload(file);
    source = lease.remember(inlineUrl(file));
  }
  if (!video) {
    video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.addEventListener("loadedmetadata", () => {
      if (!file.aspect && video.videoWidth && video.videoHeight) {
        file.aspect = video.videoWidth / video.videoHeight;
        scheduleLayout();
      }
      // Drive never described some originals (no duration in the listing);
      // the moment the browser knows, the tile badge does too.
      if (!file.dur && Number.isFinite(video.duration) && video.duration > 0) {
        file.dur = Math.round(video.duration * 1000);
        const badge = file._el?.querySelector(".g-dur");
        if (badge) badge.textContent = fmtDur(file.dur);
      }
    });
    previewVideos.set(file.id, video);
  }
  if (video.getAttribute("src") !== source) {
    video.src = source;
    video.load();
  }
  return video;
}

export function videoWarmLease(file) {
  let lease = videoWarmLeases.get(file.id);
  if (lease) return lease;
  lease = createVideoWarmLease({
    onRelease: (source) => {
      const video = previewVideos.get(file.id);
      if (!video || video.getAttribute("src") !== source) return;
      video.removeAttribute("src");
      video.load();
      video.preload = "metadata";
    },
  });
  videoWarmLeases.set(file.id, lease);
  return lease;
}

// The viewer takes over the tile's <video> so a clip that already buffered
// under the pointer plays immediately instead of downloading a second time.
// Ownership moves with it: the tile gets a fresh element on its next hover.
export function adoptPreviewVideo(file) {
  const video = previewVideos.get(file.id);
  if (!video || !video.getAttribute("src")) return null;
  previewVideos.delete(file.id);
  video.pause();
  video.loop = false;
  video.muted = false;
  video.removeAttribute("style");
  try {
    video.currentTime = 0;
  } catch {}
  return video;
}

// Tiles near the viewport keep a metadata-only <video> warm (moov atom,
// first frame) so hover playback starts without a cold fetch. Capped so a
// long gallery never holds dozens of decoders open.
const warmTiles = new Set();
const WARM_LIMIT = 12;
export function warmVideoTile(file, visible) {
  if (!canHoverPreview || !/^video\//.test(file.mime)) return;
  const lease = videoWarmLease(file);
  if (!visible) {
    warmTiles.delete(file.id);
    lease.release("visible");
    return;
  }
  if (warmTiles.has(file.id) || warmTiles.size >= WARM_LIMIT) return;
  warmTiles.add(file.id);
  lease.claim("visible");
  getPreviewVideo(file).catch(() => {});
}

// Tiles actually on screen go one step further and buffer their opening
// seconds (preload=auto), so hover playback of a big original starts from
// local data instead of waiting on a Drive round trip. Tight cap: a 4K clip
// buffers tens of MB. Off under Save-Data.
const hotTiles = new Set();
const HOT_LIMIT = 4;
export function heatVideoTile(file, hot) {
  if (!canHoverPreview || navigator.connection?.saveData || !/^video\//.test(file.mime)) return;
  const lease = videoWarmLease(file);
  if (!hot) {
    hotTiles.delete(file.id);
    lease.release("hot");
    const video = previewVideos.get(file.id);
    if (video && !video.closest("figure.previewing")) video.preload = "metadata";
    return;
  }
  if (hotTiles.has(file.id) || hotTiles.size >= HOT_LIMIT) return;
  hotTiles.add(file.id);
  lease.claim("hot");
  getPreviewVideo(file)
    .then((video) => {
      if (hotTiles.has(file.id)) video.preload = "auto";
    })
    .catch(() => {});
}
