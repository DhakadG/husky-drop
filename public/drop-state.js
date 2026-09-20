// Drop page shared state. Collections and constants are exported directly
// (mutated in place); scalars that get reassigned live on `st` so every
// module sees the same value.

export const $ = (id) => document.getElementById(id);
export const slug = location.pathname.split("/").filter(Boolean).pop();
// Kept in sessionStorage so the Google sign-in round trip (a full reload)
// continues the same visit instead of starting a second one.
export const sessionId = (() => {
  const k = `hd_sid:${slug}`;
  let v = "";
  try {
    v = sessionStorage.getItem(k) || "";
  } catch {}
  if (!v) {
    v = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    try {
      sessionStorage.setItem(k, v);
    } catch {}
  }
  return v;
})();


export const queue = [];
export const MAX_RETRIES = 8;
export const IS_MOBILE = /android|iphone|ipad|ipod/i.test(navigator.userAgent);
export const MAX_ACTIVE = IS_MOBILE ? 8 : 12; // hard cap on parallel files
// Bytes allowed in flight at once - a memory cap, not a speed knob. Phones
// cannot hold twelve 128 MB chunks; desktops on gigabit can.
export const MEM_WINDOW = IS_MOBILE ? 256 * 1024 * 1024 : 2 * 1024 ** 3;
export const MAX_CHUNK = (IS_MOBILE ? 64 : 256) * 1024 * 1024; // adaptive chunk ceiling
export const MIN_CHUNK = 8 * 1024 * 1024;
export const STALL_MS = 20000; // abort a chunk when no progress for this long (upload spec §1.3: 15-20 s)
export const FAST_CHUNK_MS = 8000; // chunk finished quicker than this -> grow chunk (32 MB in 8 s = 4 MB/s, anything faster deserves bigger PUTs)
export const ATTENTION_STATES = new Set(["error", "warning", "canceled", "skipped"]);

export const totals = {
  count: 0,
  bytes: 0,
  sent: 0,
  queued: 0,
  checking: 0,
  skipped: 0,
  uploading: 0,
  done: 0,
  error: 0,
  warning: 0,
  canceled: 0,
};

export const ATTENTION_CAP = 200;
export const DONE_TAIL = 40;
export const MAX_VISIBLE = 60;
export const uploadingList = [];
export const attention = [];
export const doneRecent = [];
export const leaving = []; // just-finished rows that fade in place before dropping to the done tail


export const RESUME_DB = "husky-drop";
export const RESUME_STORE = "pending";
export const RESUME_MAX_AGE = 6 * 86400 * 1000;
export let resumeRecords = new Map(); // matchKey -> record



export const st = {
  link: null,
  pin: sessionStorage.getItem(`lhdb_pin_${slug}`) || "",
  concurrency: 4,
  chunkSize: 32 * 1024 * 1024,
  adaptiveController: null,
  adaptiveErrors: 0,
  active: 0,
  wakeLock: null,
  liveSocket: null,
  lastLiveSend: 0,
  lastQueueNotice: "",
  liveReconnectDelay: 1000,
  liveConnectedOnce: false,
  lastClientError: "",
  errorReports: 0,
  queuePaused: false,
  showAllFiles: false,
  tailNote: null,
  paintScheduled: false,
  speedBps: 0,
  speedAt: 0,
  speedSent: 0,
  resumeDb: null,
  networkPaused: false,
};
