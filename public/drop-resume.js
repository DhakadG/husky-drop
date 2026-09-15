import {
  $,
  RESUME_DB,
  RESUME_MAX_AGE,
  RESUME_STORE,
  resumeRecords,
  slug,
  st,
} from "./drop-state.js";

// Resume records (IndexedDB): remember Drive session URIs across visits.
export function resumeKey(file) {
  return `${slug}:${file.name}:${file.size}:${file.lastModified || 0}`;
}

export function openResumeDb() {
  return new Promise((resolve, reject) => {
    if (!("indexedDB" in window)) return reject(new Error("no idb"));
    const req = indexedDB.open(RESUME_DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(RESUME_STORE)) {
        req.result.createObjectStore(RESUME_STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadResumeRecords() {
  try {
    st.resumeDb = await openResumeDb();
  } catch {
    return;
  }
  const tx = st.resumeDb.transaction(RESUME_STORE, "readwrite");
  const store = tx.objectStore(RESUME_STORE);
  const req = store.getAll();
  req.onsuccess = () => {
    const now = Date.now();
    for (const rec of req.result || []) {
      if (!rec.key.startsWith(`${slug}:`)) continue;
      if (now - (rec.at || 0) > RESUME_MAX_AGE || rec.completed) {
        store.delete(rec.key);
        continue;
      }
      resumeRecords.set(rec.key, rec);
    }
    if (resumeRecords.size) maybeShowResumeBanner();
  };
}

export function saveResumeRecord(item) {
  if (!st.resumeDb || !item.uri) return;
  try {
    const tx = st.resumeDb.transaction(RESUME_STORE, "readwrite");
    tx.objectStore(RESUME_STORE).put({
      key: resumeKey(item.file),
      uri: item.uri,
      fileId: item.fileId || "",
      at: Date.now(),
    });
  } catch {}
}

export function deleteResumeRecord(item) {
  resumeRecords.delete(resumeKey(item.file));
  if (!st.resumeDb) return;
  try {
    const tx = st.resumeDb.transaction(RESUME_STORE, "readwrite");
    tx.objectStore(RESUME_STORE).delete(resumeKey(item.file));
  } catch {}
}

export function maybeShowResumeBanner() {
  const banner = $("resume-banner");
  if (!banner || !resumeRecords.size || !st.link || $("main").classList.contains("hidden")) return;
  banner.classList.remove("hidden");
  banner.querySelector("b").textContent = `You have ${resumeRecords.size} unfinished upload${resumeRecords.size === 1 ? "" : "s"} from a previous visit.`;
}

export function hideResumeBanner() {
  $("resume-banner")?.classList.add("hidden");
}
