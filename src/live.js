// LiveTracker Durable Object: live upload sessions over WebSockets, batched
// KV flushes (completions, opens, events, share stats), per-day rollups in
// its own SQLite storage, in-memory rate limiting, folder-creation locks and
// the per-session digest email.

import {
  APP_NAME,
  COMPLETION_FLUSH_MS,
  EVENT_CAP,
  JSON_HEADERS,
  RECENT_CAP,
  clamp,
  cleanText,
  dayKey,
  escapeHtml,
  fmtBytesServer,
  mergeRecent,
  normalizeEvent,
  normalizeLiveSession,
  normalizeNotify,
  normalizeStats,
  normalizeUploadMeta,
  sanitizeFolderName,
} from "./util.js";
import { ensureLinkFolderDirect, resolveUploaderFolderDirect } from "./drive.js";
import { bumpShareStats, bumpStats, mergeEventsKV, sendNotify } from "./store.js";

export class LiveTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.adminSockets = new Set();
    this.folderLocks = new Map();
    this.started = new Set();
    this.pending = new Map(); // slug -> pending completions
    this.pendingEvents = [];
    this.pendingOpens = new Map(); // slug -> count
    this.pendingShareStats = new Map(); // slug -> { opens, downloads, bytes }
    this.pendingDays = new Map(); // `${slug}|${day}` -> delta object
    this.rateBuckets = new Map(); // key -> { count, reset }
    this.sqlReady = false;
    try {
      this.sql = state.storage.sql;
      state.blockConcurrencyWhile(async () => this.initSql());
    } catch {
      this.sql = null;
    }
  }

  initSql() {
    if (!this.sql) return;
    try {
      this.sql.exec(`CREATE TABLE IF NOT EXISTS day_stats (
        slug TEXT NOT NULL,
        day TEXT NOT NULL,
        opens INTEGER NOT NULL DEFAULT 0,
        sessions INTEGER NOT NULL DEFAULT 0,
        files INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        downloads INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (slug, day)
      )`);
      this.sqlReady = true;
    } catch (err) {
      console.error("day_stats init failed", err.message);
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot") {
      this.prune();
      return new Response(JSON.stringify({ active: this.snapshot() }), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/timeseries") {
      const days = clamp(Number(url.searchParams.get("days")) || 30, 1, 120);
      const slug = cleanText(url.searchParams.get("slug") || "", 66);
      return new Response(JSON.stringify({ rows: this.timeseries(days, slug) }), {
        headers: JSON_HEADERS,
      });
    }

    if (request.method === "POST" && url.pathname === "/ratelimit") {
      const body = await request.json().catch(() => ({}));
      const key = cleanText(body.key || "", 120);
      const max = clamp(Number(body.max) || 5, 1, 1000);
      const windowSec = clamp(Number(body.windowSec) || 60, 1, 86400);
      return new Response(JSON.stringify(this.rateLimit(key, max, windowSec)), {
        headers: JSON_HEADERS,
      });
    }

    if (request.method === "POST" && url.pathname === "/event") {
      const body = await request.json().catch(() => ({}));
      if (body && body.record) this.accumulateEvent(body.record);
      await this.armAlarm();
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/open") {
      const body = await request.json().catch(() => ({}));
      const slug = cleanText(body.slug || "", 60);
      if (slug) {
        this.pendingOpens.set(slug, (this.pendingOpens.get(slug) || 0) + 1);
        this.bumpDay(slug, { opens: 1 });
        if (body.record) this.accumulateEvent(body.record);
        await this.armAlarm();
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/share-stat") {
      const body = await request.json().catch(() => ({}));
      const slug = cleanText(body.slug || "", 60);
      if (slug) {
        const cur = this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0 };
        cur.opens += Number(body.opens) || 0;
        cur.downloads += Number(body.downloads) || 0;
        cur.bytes += Number(body.bytes) || 0;
        this.pendingShareStats.set(slug, cur);
        this.bumpDay(`share:${slug}`, {
          opens: Number(body.opens) || 0,
          downloads: Number(body.downloads) || 0,
          bytes: Number(body.bytes) || 0,
        });
        if (body.record) this.accumulateEvent(body.record);
        await this.armAlarm();
      }
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/close") {
      const body = await request.json().catch(() => ({}));
      const id = cleanText(body.id || "", 100);
      const slug = cleanText(body.slug || "", 60);
      let closed = 0;
      if (id && this.sessions.delete(id)) closed++;
      if (!id && slug) {
        for (const [sessionId, session] of this.sessions) {
          if (session.slug === slug) {
            this.sessions.delete(sessionId);
            closed++;
          }
        }
      }
      if (closed) this.broadcast();
      return new Response(JSON.stringify({ ok: true, closed }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/folder") {
      const body = await request.json().catch(() => ({}));
      const link = body.link || {};
      const uploader = cleanText(body.uploader || "anonymous", 60) || "anonymous";
      if (!link.slug || !link.folderId) {
        return new Response(JSON.stringify({ error: "link required" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      const key = `${link.slug}:${sanitizeFolderName(uploader).toLowerCase()}`;
      if (!this.folderLocks.has(key)) {
        this.folderLocks.set(
          key,
          resolveUploaderFolderDirect(this.env, link, uploader).finally(() =>
            this.folderLocks.delete(key)
          )
        );
      }
      const folderId = await this.folderLocks.get(key);
      return new Response(JSON.stringify({ folderId }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/linkfolder") {
      // Serialize lazy Drive folder creation for links created "instantly".
      const body = await request.json().catch(() => ({}));
      const slug = cleanText(body.slug || "", 60);
      if (!slug) {
        return new Response(JSON.stringify({ error: "slug required" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      const key = `__link__:${slug}`;
      if (!this.folderLocks.has(key)) {
        this.folderLocks.set(
          key,
          ensureLinkFolderDirect(this.env, slug).finally(() => this.folderLocks.delete(key))
        );
      }
      try {
        const folderId = await this.folderLocks.get(key);
        return new Response(JSON.stringify({ folderId }), { headers: JSON_HEADERS });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502,
          headers: JSON_HEADERS,
        });
      }
    }

    if (request.method === "POST" && url.pathname === "/session-start") {
      const body = await request.json().catch(() => ({}));
      const link = body.link || {};
      const id = cleanText(body.sessionId || "", 80);
      if (!link.slug || !id) {
        return new Response(JSON.stringify({ first: false }), { headers: JSON_HEADERS });
      }
      const key = `${link.slug}:${id}`;
      if (this.started.has(key)) {
        return new Response(JSON.stringify({ first: false }), { headers: JSON_HEADERS });
      }
      this.started.add(key);
      this.bumpDay(link.slug, { sessions: 1 });
      await this.armAlarm();
      this.env.KV.put(`started:${key}`, "1", { expirationTtl: 24 * 3600 }).catch(() => {});
      return new Response(JSON.stringify({ first: true }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/progress") {
      const body = await request.json().catch(() => ({}));
      const session = this.recordSession(body);
      this.maybeSendDigest(session).catch(() => {});
      this.broadcast();
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/complete") {
      const body = await request.json().catch(() => ({}));
      const slug = cleanText(body.slug || "", 60);
      if (!slug || !body.meta) {
        return new Response(JSON.stringify({ ok: false }), { headers: JSON_HEADERS });
      }
      await this.accumulateCompletion(slug, cleanText(body.label || "", 100), body.meta);
      return new Response(JSON.stringify({ ok: true, queued: true }), { headers: JSON_HEADERS });
    }

    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const role = url.searchParams.get("role");
    const slug = url.searchParams.get("slug") || "";

    server.accept();
    if (role === "admin") {
      this.adminSockets.add(server);
      this.safeSend(server, { type: "snapshot", active: this.snapshot() });
      server.addEventListener("close", () => this.adminSockets.delete(server));
      server.addEventListener("error", () => this.adminSockets.delete(server));
    } else {
      server.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type !== "progress") return;
        const session = this.recordSession({ ...msg, slug });
        server.sessionId = session.id;
        this.maybeSendDigest(session).catch(() => {});
        this.broadcast();
      });
      server.addEventListener("close", () => {
        if (server.sessionId) {
          const existing = this.sessions.get(server.sessionId);
          if (existing) {
            existing.state = existing.state === "done" ? "done" : "stale";
            existing.lastSeen = Date.now();
            this.sessions.set(server.sessionId, existing);
            this.broadcast();
          }
        }
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  rateLimit(key, max, windowSec) {
    const now = Date.now();
    if (this.rateBuckets.size > 5000) this.rateBuckets.clear(); // memory guard
    let bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowSec * 1000 };
      this.rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) {
      return { allowed: false, retryAfter: Math.ceil((bucket.reset - now) / 1000) };
    }
    return { allowed: true, retryAfter: 0 };
  }

  timeseries(days, slugFilter) {
    if (!this.sqlReady) return [];
    const since = dayKey(Date.now() - days * 86400_000);
    try {
      const query = `SELECT day, SUM(opens) AS opens, SUM(sessions) AS sessions,
          SUM(files) AS files, SUM(bytes) AS bytes, SUM(downloads) AS downloads
        FROM day_stats WHERE day >= ?${slugFilter ? " AND slug = ?" : ""}
        GROUP BY day ORDER BY day`;
      const cursor = slugFilter ? this.sql.exec(query, since, slugFilter) : this.sql.exec(query, since);
      return cursor.toArray();
    } catch (err) {
      console.error("timeseries failed", err.message);
      return [];
    }
  }

  bumpDay(slug, delta) {
    const key = `${slug}|${dayKey(Date.now())}`;
    const cur = this.pendingDays.get(key) || { opens: 0, sessions: 0, files: 0, bytes: 0, downloads: 0 };
    for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + Number(v || 0);
    this.pendingDays.set(key, cur);
  }

  flushDays() {
    if (!this.sqlReady || this.pendingDays.size === 0) return;
    const pending = this.pendingDays;
    this.pendingDays = new Map();
    try {
      for (const [key, d] of pending) {
        const sep = key.lastIndexOf("|");
        const slug = key.slice(0, sep);
        const day = key.slice(sep + 1);
        this.sql.exec(
          `INSERT INTO day_stats (slug, day, opens, sessions, files, bytes, downloads)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug, day) DO UPDATE SET
             opens = opens + excluded.opens,
             sessions = sessions + excluded.sessions,
             files = files + excluded.files,
             bytes = bytes + excluded.bytes,
             downloads = downloads + excluded.downloads`,
          slug, day, d.opens, d.sessions, d.files, d.bytes, d.downloads
        );
      }
    } catch (err) {
      console.error("day flush failed", err.message);
    }
  }

  accumulateEvent(record) {
    if (!record || !record.t) return;
    this.pendingEvents.push(record);
    if (this.pendingEvents.length > EVENT_CAP + 50) this.pendingEvents.shift();
  }

  async armAlarm() {
    const existing = await this.state.storage.getAlarm();
    if (!existing) await this.state.storage.setAlarm(Date.now() + COMPLETION_FLUSH_MS);
  }

  prune() {
    const cutoff = Date.now() - 2 * 60_000;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen < cutoff) this.sessions.delete(id);
    }
  }

  // Normalize a live update and derive a smoothed throughput + ETA from the
  // delta against the previous snapshot. Works for both the WebSocket path and
  // the /api/progress fallback, and needs no KV writes.
  recordSession(input) {
    const session = normalizeLiveSession(input);
    const prev = this.sessions.get(session.id);
    if (prev) {
      session.digestSent = prev.digestSent || false;
      session.prevState = prev.state;
      if (session.lastSeen > prev.lastSeen && session.sent >= prev.sent) {
        const dt = (session.lastSeen - prev.lastSeen) / 1000;
        const inst = dt > 0 ? (session.sent - prev.sent) / dt : 0;
        session.speed = prev.speed ? prev.speed * 0.5 + inst * 0.5 : inst || session.speed;
      }
    }
    const remaining = Math.max(0, session.total - session.sent);
    session.eta =
      session.state !== "done" && session.speed > 0 ? Math.round(remaining / session.speed) : 0;
    this.sessions.set(session.id, session);
    return session;
  }

  // One digest email per finished session ("Priya uploaded 214 files, 18 GB")
  // instead of one email per completed file. Uses the link's notify.complete
  // toggle. Sent at most once per session id.
  async maybeSendDigest(session) {
    if (!session || session.state !== "done" || session.digestSent) return;
    if (session.prevState === "done") return;
    if (!session.slug || !session.done) return;
    session.digestSent = true;
    this.sessions.set(session.id, session);
    try {
      const link = await this.env.KV.get(`link:${session.slug}`, "json");
      if (!link) return;
      const notify = normalizeNotify(link.notify);
      if (!notify.enabled || !notify.complete) return;
      await sendNotify(this.env, {
        subject: `${APP_NAME}: ${session.uploader} finished uploading`,
        html: `<p><b>${escapeHtml(session.uploader)}</b> finished uploading to <b>${escapeHtml(
          link.label
        )}</b>.</p><p>${session.done} file${session.done === 1 ? "" : "s"} - ${escapeHtml(
          fmtBytesServer(session.sent)
        )}</p>`,
      });
    } catch (err) {
      console.error("digest failed", err.message);
    }
  }

  // Buffer completed-file metadata in memory and schedule a single batched KV
  // flush, instead of writing stats/recent/event KV keys per file. Completions
  // are de-duped by file id within the batch so a retried completion never
  // gets queued twice.
  async accumulateCompletion(slug, label, rawMeta) {
    const meta = normalizeUploadMeta(rawMeta);
    let pend = this.pending.get(slug);
    if (!pend) {
      pend = { recents: [], seen: new Set(), label, lastUploader: "", lastFile: "" };
      this.pending.set(slug, pend);
    }
    const id = meta.f || `${meta.n}:${meta.at}`;
    if (!pend.seen.has(id)) {
      pend.seen.add(id);
      pend.recents.push(meta);
      if (pend.recents.length > RECENT_CAP + 50) pend.recents.shift();
    }
    pend.label = label || pend.label;
    pend.lastUploader = meta.u || pend.lastUploader;
    pend.lastFile = meta.n || pend.lastFile;
    await this.armAlarm();
  }

  async alarm() {
    // 1) completions -> recent:/stats: keys + day rollups
    const pending = this.pending;
    this.pending = new Map();
    const failed = [];
    for (const [slug, pend] of pending) {
      try {
        await this.flushCompletions(slug, pend);
      } catch (err) {
        console.error("completion flush failed", err.message);
        failed.push([slug, pend]);
      }
    }
    for (const [slug, pend] of failed) {
      const cur = this.pending.get(slug);
      if (cur) {
        for (const m of pend.recents) {
          const id = m.f || `${m.n}:${m.at}`;
          if (cur.seen.has(id)) continue;
          cur.seen.add(id);
          cur.recents.push(m);
        }
        cur.label = pend.label || cur.label;
        cur.lastUploader = pend.lastUploader || cur.lastUploader;
        cur.lastFile = pend.lastFile || cur.lastFile;
      } else {
        this.pending.set(slug, pend);
      }
    }

    // 2) opens -> stats: keys
    const opens = this.pendingOpens;
    this.pendingOpens = new Map();
    for (const [slug, count] of opens) {
      try {
        await bumpStats(this.env, slug, { opens: count });
      } catch (err) {
        console.error("opens flush failed", err.message);
        this.pendingOpens.set(slug, (this.pendingOpens.get(slug) || 0) + count);
      }
    }

    // 3) share stats -> sstats: keys
    const shareStats = this.pendingShareStats;
    this.pendingShareStats = new Map();
    for (const [slug, delta] of shareStats) {
      try {
        await bumpShareStats(this.env, slug, delta);
      } catch (err) {
        console.error("share stats flush failed", err.message);
        const cur = this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0 };
        cur.opens += delta.opens;
        cur.downloads += delta.downloads;
        cur.bytes += delta.bytes;
        this.pendingShareStats.set(slug, cur);
      }
    }

    // 4) events -> single rolling events:recent key
    if (this.pendingEvents.length) {
      const batch = this.pendingEvents;
      this.pendingEvents = [];
      try {
        await mergeEventsKV(this.env, batch);
      } catch (err) {
        console.error("event flush failed", err.message);
        this.pendingEvents = batch.concat(this.pendingEvents).slice(-EVENT_CAP);
      }
    }

    // 5) day rollups -> DO SQLite (cheap, not KV)
    this.flushDays();

    if (
      this.pending.size ||
      this.pendingOpens.size ||
      this.pendingShareStats.size ||
      this.pendingEvents.length ||
      this.pendingDays.size
    ) {
      await this.state.storage.setAlarm(Date.now() + COMPLETION_FLUSH_MS);
    }
  }

  async flushCompletions(slug, pend) {
    const existing = (await this.env.KV.get(`recent:${slug}`, "json")) || [];
    const existingIds = new Set(existing.map((m) => m.f || `${m.n}:${m.at}`));

    // Stats counters only ever move for files we have never recorded, so a
    // retried/re-synced completion refreshes the history without inflating
    // the totals. Drive remains the source of truth for the full archive.
    let newFiles = 0;
    let newBytes = 0;
    for (const m of pend.recents) {
      const id = m.f || `${m.n}:${m.at}`;
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      newFiles++;
      newBytes += m.s;
    }

    await this.env.KV.put(`recent:${slug}`, JSON.stringify(mergeRecent(existing, pend.recents)));
    if (newFiles === 0) return;

    const stats = normalizeStats(await this.env.KV.get(`stats:${slug}`, "json"));
    stats.files += newFiles;
    stats.bytes += newBytes;
    await this.env.KV.put(`stats:${slug}`, JSON.stringify(stats));

    this.bumpDay(slug, { files: newFiles, bytes: newBytes });
    this.accumulateEvent(
      normalizeEvent(
        {
          type: "file",
          slug,
          label: pend.label,
          uploader: pend.lastUploader,
          file: newFiles === 1 ? pend.lastFile : `${newFiles} files`,
          bytes: newBytes,
          message: newFiles === 1 ? "" : `${newFiles} files saved`,
        },
        null
      )
    );
  }

  snapshot() {
    this.prune();
    return [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  broadcast() {
    const payload = { type: "snapshot", active: this.snapshot() };
    for (const socket of [...this.adminSockets]) this.safeSend(socket, payload);
  }

  safeSend(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      this.adminSockets.delete(socket);
    }
  }
}
