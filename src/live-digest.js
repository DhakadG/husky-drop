// One digest email per finished upload session ("Priya uploaded 214 files,
// 18 GB"). The server decides when a session is finished from the
// Drive-verified completions it received, never from the uploader's browser:
// a closed tab, a dropped WebSocket or a failed /api/complete used to leave
// the session "uploading" forever and the email never went out. Counts come
// from the same completions, so the email matches what landed in Drive.
//
// ponytail: candidates live in DO memory. The alarm re-arms every few seconds
// while any are pending, which keeps the DO awake; a hard restart
// mid-transfer still drops that one email.

import { escapeHtml, fmtBytesServer, normalizeNotify } from "./util.js";
import { notifyEmail, sendNotify } from "./store.js";

const SETTLE_MS = 8_000; // completions racing the client's "done" still count
const IDLE_MS = 90_000; // a tab closed mid-transfer with nothing else coming
const MAX_TRIES = 3;

export class DigestQueue {
  constructor(env, onChange) {
    this.env = env;
    this.onChange = onChange;
    this.map = new Map(); // sessionId -> candidate
  }

  get size() {
    return this.map.size;
  }

  get(id) {
    return this.map.get(id);
  }

  note(sessionId, patch) {
    if (!sessionId) return;
    const cur = this.map.get(sessionId) || { slug: "", label: "", uploader: "", seen: new Set(), names: [], files: 0, bytes: 0, expected: 0, done: false, startedAt: Date.now(), lastAt: 0 };
    const { file, verifiedUploader, uploader, done, ...rest } = patch;
    Object.assign(cur, rest, { lastAt: Date.now() });
    // "done" is sticky, retried completions count once, and the
    // Drive-verified uploader name beats what the browser typed.
    cur.done = cur.done || !!done;
    cur.uploader = verifiedUploader || cur.uploader || uploader || "";
    if (file && !cur.seen.has(file.id)) {
      cur.seen.add(file.id);
      cur.files++;
      if (cur.names.length < 10) cur.names.push({ n: file.name || "", s: file.bytes });
      cur.bytes += file.bytes;
    }
    this.map.set(sessionId, cur);
    this.onChange();
  }

  ready(d, now) {
    const finished = d.done || (d.expected && d.files >= d.expected);
    return now - d.lastAt >= (finished ? SETTLE_MS : IDLE_MS);
  }

  async flush() {
    const now = Date.now();
    for (const [id, d] of this.map) {
      if (!this.ready(d, now)) continue;
      // Nothing landed in Drive (all canceled/failed): forget it, no email.
      if (!d.files) {
        this.map.delete(id);
        continue;
      }
      try {
        await this.send(id, d);
        this.map.delete(id);
      } catch (err) {
        // Keep the candidate for the next alarm; give up after a few tries so
        // a dead link or dead Resend cannot pin it in memory forever.
        d.tries = (d.tries || 0) + 1;
        d.lastAt = now;
        console.error("digest failed", err.message, `try ${d.tries}`);
        if (d.tries >= MAX_TRIES) this.map.delete(id);
      }
    }
  }

  async send(id, d) {
    const link = await this.env.KV.get(`link:${d.slug}`, "json");
    const notify = normalizeNotify(link?.notify);
    if (!link || !notify.enabled || !notify.complete) return;
    const files = `${d.files} file${d.files === 1 ? "" : "s"}`;
    // Freeze the end time so a retried send renders byte-identical.
    d.endedAt ||= d.lastAt;
    const mins = Math.max(1, Math.round((d.endedAt - d.startedAt) / 60000));
    const sent = await sendNotify(this.env, {
      ...notifyEmail({
        subject: `${d.uploader} sent ${files} (${fmtBytesServer(d.bytes)}) to ${link.label}`,
        headline: `<b>${escapeHtml(d.uploader)}</b> finished uploading to <b>${escapeHtml(link.label)}</b>.`,
        facts: [
          ["Received", `${files}, ${fmtBytesServer(d.bytes)}`],
          ["Took", `about ${mins} minute${mins === 1 ? "" : "s"}`],
          ["Device", [d.client?.o, d.client?.l].filter(Boolean).join(" · ")],
          ["Saved to", link.folderName ? `Drive folder "${link.folderName}"` : ""],
        ],
        files: d.names,
        total: d.files,
        cta: d.origin ? { href: `${d.origin}/admin/links/${encodeURIComponent(d.slug)}`, label: "Open in dashboard" } : null,
      }),
      category: "upload-completed",
      idempotencyKey: `upload-completed/${id}`,
    });
    if (sent === null) throw new Error("Resend rejected digest");
  }
}
