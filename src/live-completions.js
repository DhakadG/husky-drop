// Completed-file metadata is buffered in DO memory and flushed to KV in one
// batch per link per alarm (recent:/stats: keys + an activity event per
// session), instead of writing KV keys per file. Completions are de-duped by
// file id within the batch so a retried completion never gets queued twice.

import { RECENT_CAP, mergeRecent, normalizeEvent, normalizeStats, normalizeUploadMeta } from "./util.js";

const fileKey = (m) => m.f || `${m.n}:${m.at}`;

export class CompletionQueue {
  constructor(env, analytics) {
    this.env = env;
    this.analytics = analytics;
    this.pending = new Map(); // slug -> { recents, seen, label, lastUploader, lastFile, lastSessionId }
  }

  get size() {
    return this.pending.size;
  }

  // Returns the normalized meta and its dedupe id so the caller can feed the
  // digest with the same identity.
  add(slug, label, rawMeta) {
    const meta = normalizeUploadMeta(rawMeta);
    let pend = this.pending.get(slug);
    if (!pend) {
      pend = { recents: [], seen: new Set(), label, lastUploader: "", lastFile: "", lastSessionId: "" };
      this.pending.set(slug, pend);
    }
    const id = fileKey(meta);
    if (!pend.seen.has(id)) {
      pend.seen.add(id);
      pend.recents.push(meta);
      if (pend.recents.length > RECENT_CAP + 50) pend.recents = pend.recents.slice(-RECENT_CAP);
    }
    pend.label = label || pend.label;
    pend.lastUploader = meta.u || pend.lastUploader;
    pend.lastFile = meta.n || pend.lastFile;
    pend.lastSessionId = meta.si || pend.lastSessionId;
    return { id, meta };
  }

  async flush() {
    const pending = this.pending;
    this.pending = new Map();
    for (const [slug, pend] of pending) {
      try {
        await this.flushOne(slug, pend);
      } catch (err) {
        console.error("completion flush failed", err.message);
        this.requeue(slug, pend);
      }
    }
  }

  // Merge a failed batch back into whatever arrived while it was flushing.
  requeue(slug, pend) {
    const cur = this.pending.get(slug);
    if (!cur) {
      this.pending.set(slug, pend);
      return;
    }
    for (const m of pend.recents) {
      const id = fileKey(m);
      if (cur.seen.has(id)) continue;
      cur.seen.add(id);
      cur.recents.push(m);
    }
    cur.label = pend.label || cur.label;
    cur.lastUploader = pend.lastUploader || cur.lastUploader;
    cur.lastFile = pend.lastFile || cur.lastFile;
    cur.lastSessionId = pend.lastSessionId || cur.lastSessionId;
  }

  async flushOne(slug, pend) {
    const existing = (await this.env.KV.get(`recent:${slug}`, "json")) || [];
    const existingIds = new Set(existing.map(fileKey));

    // Stats counters only ever move for files we have never recorded, so a
    // retried/re-synced completion refreshes the history without inflating
    // the totals. "Recorded" is the DO's completed_files index (every file,
    // not just the capped recent list) plus the recent rows from before it.
    let newFiles = 0;
    let newBytes = 0;
    const newMetas = [];
    for (const m of pend.recents) {
      const id = fileKey(m);
      if (existingIds.has(id) || this.analytics.hasCompleted(slug, id)) continue;
      existingIds.add(id);
      newFiles++;
      newBytes += m.s;
      newMetas.push(m);
    }

    // Counters, day rollup and events first; only then are the files marked
    // recorded and the recent list written. A failed stats write leaves the
    // batch "new" for the retry, and a failed recent write can no longer
    // make the retry skip the counters.
    if (newFiles === 0) return this.markRecorded(slug, pend, existing);
    const stats = normalizeStats(await this.env.KV.get(`stats:${slug}`, "json"));
    stats.files += newFiles;
    stats.bytes += newBytes;
    await this.env.KV.put(`stats:${slug}`, JSON.stringify(stats));

    this.analytics.bumpDay(slug, { files: newFiles, bytes: newBytes });
    // One activity event per upload session, so concurrent uploaders keep
    // separate counts in the feed.
    const newBySession = new Map();
    for (const meta of newMetas) {
      const key = meta.si || "";
      if (!newBySession.has(key)) newBySession.set(key, []);
      newBySession.get(key).push(meta);
    }
    for (const [sessionId, metas] of newBySession) {
      const bytes = metas.reduce((total, meta) => total + meta.s, 0);
      const last = metas.at(-1);
      this.analytics.recordEvent(
        normalizeEvent(
          {
            type: "file",
            slug,
            label: pend.label,
            uploader: last?.u || pend.lastUploader,
            file: metas.length === 1 ? last?.n : "",
            bytes,
            count: metas.length,
            message: metas.length === 1 ? "" : `${metas.length} files saved`,
            sessionId,
          },
          null,
        ),
      );
    }
    await this.markRecorded(slug, pend, existing);
  }

  async markRecorded(slug, pend, existing) {
    this.analytics.recordCompleted(slug, pend.recents);
    await this.env.KV.put(`recent:${slug}`, JSON.stringify(mergeRecent(existing, pend.recents)));
  }
}
