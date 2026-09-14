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
import { ensureLinkFolderDirect, resolvePathFolderDirect, resolveUploaderFolderDirect } from "./drive.js";
import { bumpShareStats, bumpStats, mergeEventsKV, sendNotify } from "./store.js";

// ponytail: digest candidates live in DO memory; a DO restart mid-transfer drops that one email.
const DIGEST_SETTLE_MS = 8_000;
const DIGEST_IDLE_MS = 90_000;

export class LiveTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.adminSockets = new Set();
    this.folderLocks = new Map();
    this.started = new Set();
    this.digests = new Map(); // sessionId -> finished-session email candidate
    this.pending = new Map(); // slug -> pending completions
    this.pendingEvents = [];
    this.pendingOpens = new Map(); // slug -> count
    this.pendingShareStats = new Map(); // slug -> { opens, downloads, bytes }
    this.pendingDays = new Map(); // `${slug}|${day}` -> delta object
    this.rateBuckets = new Map(); // key -> { count, reset }
    this.recentDone = []; // finished-session summaries for the Live tab
    this.lastTelemetryPrune = 0;
    this.lastActivityPrune = 0;
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
      this.sql.exec(`CREATE TABLE IF NOT EXISTS telemetry_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        slug TEXT NOT NULL,
        session_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0,
        viewer TEXT NOT NULL DEFAULT '',
        events_json TEXT NOT NULL
      )`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS telemetry_at_idx ON telemetry_batches(at)");
      this.sql.exec("CREATE INDEX IF NOT EXISTS telemetry_slug_idx ON telemetry_batches(slug, at)");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS activity_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        day TEXT NOT NULL,
        slug TEXT NOT NULL DEFAULT '',
        record_json TEXT NOT NULL
      )`);
      this.sql.exec("CREATE INDEX IF NOT EXISTS activity_at_idx ON activity_events(at DESC)");
      this.sql.exec("CREATE INDEX IF NOT EXISTS activity_day_idx ON activity_events(day, at DESC)");
      this.sql.exec(`CREATE TABLE IF NOT EXISTS share_stats (
        slug TEXT PRIMARY KEY,
        opens INTEGER NOT NULL DEFAULT 0,
        downloads INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL DEFAULT 0,
        views INTEGER NOT NULL DEFAULT 0,
        viewers_json TEXT NOT NULL DEFAULT '{}'
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
      return new Response(JSON.stringify({ active: this.snapshot(), recent: this.recentDone }), {
        headers: JSON_HEADERS,
      });
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

    if (url.pathname === "/events") {
      const limit = clamp(Number(url.searchParams.get("limit")) || 60, 1, EVENT_CAP);
      if (!this.sqlReady) return new Response(JSON.stringify({ events: [] }), { headers: JSON_HEADERS });
      const rows = this.sql.exec("SELECT record_json FROM activity_events ORDER BY at DESC LIMIT ?", limit).toArray();
      const events = rows.map((row) => JSON.parse(row.record_json)).filter(Boolean);
      return new Response(JSON.stringify({ events }), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/events-days") {
      const beforeRaw = cleanText(url.searchParams.get("before") || "", 10);
      const before = /^\d{4}-\d{2}-\d{2}$/.test(beforeRaw) ? beforeRaw : dayKey(Date.now());
      const days = clamp(Number(url.searchParams.get("days")) || 3, 1, 14);
      const start = new Date(`${before}T00:00:00Z`).getTime();
      if (!Number.isFinite(start)) return new Response(JSON.stringify({ error: "bad before date" }), { status: 400, headers: JSON_HEADERS });
      const out = [];
      for (let index = 1; index <= days; index++) {
        const day = dayKey(start - index * 86400_000);
        const rows = this.sqlReady
          ? this.sql.exec("SELECT record_json FROM activity_events WHERE day = ? ORDER BY at DESC LIMIT ?", day, EVENT_CAP).toArray()
          : [];
        out.push({ day, events: rows.map((row) => JSON.parse(row.record_json)).filter(Boolean) });
      }
      return new Response(JSON.stringify({ days: out, oldest: out.length ? out.at(-1).day : before }), { headers: JSON_HEADERS });
    }

    if (url.pathname === "/share-stats") {
      const rows = this.sqlReady
        ? this.sql.exec("SELECT slug, opens, downloads, bytes, views, viewers_json FROM share_stats").toArray()
        : [];
      return new Response(JSON.stringify({ rows: rows.map((row) => ({
        slug: row.slug,
        opens: Number(row.opens) || 0,
        downloads: Number(row.downloads) || 0,
        bytes: Number(row.bytes) || 0,
        views: Number(row.views) || 0,
        viewers: JSON.parse(row.viewers_json || "{}"),
      })) }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/telemetry") {
      const body = await request.json().catch(() => ({}));
      const events = Array.isArray(body.events) ? body.events.slice(0, 40) : [];
      if (!this.sqlReady || !events.length) {
        return new Response(JSON.stringify({ ok: true, stored: false }), { headers: JSON_HEADERS });
      }
      const at = Number(body.at) || Date.now();
      this.sql.exec(
        `INSERT INTO telemetry_batches (kind, slug, session_id, at, started_at, viewer, events_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        cleanText(body.kind || "event", 20),
        cleanText(body.slug || "", 60),
        cleanText(body.sessionId || "", 80),
        at,
        Number(body.startedAt) || 0,
        cleanText(body.viewer || "", 100),
        JSON.stringify(events),
      );
      if (at - this.lastTelemetryPrune > 6 * 3600_000) {
        this.sql.exec("DELETE FROM telemetry_batches WHERE at < ?", at - 30 * 86400_000);
        this.lastTelemetryPrune = at;
      }
      return new Response(JSON.stringify({ ok: true, stored: true }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/event") {
      const body = await request.json().catch(() => ({}));
      if (body && body.record) this.accumulateEvent(body.record);
      if (!this.sqlReady) await this.armAlarm();
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
      let viewerPreviouslySeen = null;
      if (slug) {
        const stored = this.sqlReady
          ? this.sql.exec("SELECT opens, downloads, bytes, views, viewers_json FROM share_stats WHERE slug = ?", slug).toArray()[0]
          : null;
        const cur = stored
          ? { opens: Number(stored.opens) || 0, downloads: Number(stored.downloads) || 0, bytes: Number(stored.bytes) || 0, views: Number(stored.views) || 0, viewers: JSON.parse(stored.viewers_json || "{}") }
          : this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0, views: 0, viewers: {} };
        cur.opens += Number(body.opens) || 0;
        cur.downloads += Number(body.downloads) || 0;
        cur.bytes += Number(body.bytes) || 0;
        cur.views += Number(body.views) || 0;
        const viewerEmail = cleanText(body.viewer?.email || "", 80);
        if (viewerEmail) {
          viewerPreviouslySeen = Object.prototype.hasOwnProperty.call(cur.viewers, viewerEmail);
          cur.viewers[viewerEmail] = {
            n: cleanText(body.viewer.name || "", 80),
            at: Date.now(),
          };
        }
        if (this.sqlReady) {
          const viewerEntries = Object.entries(cur.viewers).sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0)).slice(0, 50);
          this.sql.exec(
            `INSERT INTO share_stats (slug, opens, downloads, bytes, views, viewers_json)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(slug) DO UPDATE SET opens = excluded.opens, downloads = excluded.downloads,
               bytes = excluded.bytes, views = excluded.views, viewers_json = excluded.viewers_json`,
            slug, cur.opens, cur.downloads, cur.bytes, cur.views, JSON.stringify(Object.fromEntries(viewerEntries)),
          );
        } else {
          this.pendingShareStats.set(slug, cur);
        }
        this.bumpDay(`share:${slug}`, {
          opens: Number(body.opens) || 0,
          downloads: Number(body.downloads) || 0,
          bytes: Number(body.bytes) || 0,
        });
        if (body.record) this.accumulateEvent(body.record);
        await this.armAlarm();
      }
      return new Response(JSON.stringify({ ok: true, viewerPreviouslySeen }), { headers: JSON_HEADERS });
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

    if (request.method === "POST" && url.pathname === "/pathfolder") {
      // Serialize nested folder creation for folder uploads so parallel files
      // from the same directory never race and create duplicate Drive folders.
      const body = await request.json().catch(() => ({}));
      const link = body.link || {};
      const uploader = cleanText(body.uploader || "anonymous", 60) || "anonymous";
      const segments = Array.isArray(body.segments)
        ? body.segments.map((s) => cleanText(s, 90)).filter(Boolean).slice(0, 12)
        : [];
      if (!link.slug || !link.folderId) {
        return new Response(JSON.stringify({ error: "link required" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      const key = `path:${link.slug}:${sanitizeFolderName(uploader).toLowerCase()}:${segments.join("/").toLowerCase()}`;
      if (!this.folderLocks.has(key)) {
        this.folderLocks.set(
          key,
          resolvePathFolderDirect(this.env, link, uploader, segments).finally(() =>
            this.folderLocks.delete(key)
          )
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
      this.noteDigest(session.id, { slug: session.slug, label: session.label, uploader: session.uploader, expected: session.count, done: session.state === "done" });
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
      this.safeSend(server, { type: "snapshot", active: this.snapshot(), recent: this.recentDone });
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
        this.noteDigest(session.id, { slug: session.slug, label: session.label, uploader: session.uploader, expected: session.count, done: session.state === "done" });
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
    const since = dayKey(Date.now() - days * 86400_000);
    const byDay = new Map();
    if (this.sqlReady) {
      try {
        const query = `SELECT day, SUM(opens) AS opens, SUM(sessions) AS sessions,
            SUM(files) AS files, SUM(bytes) AS bytes, SUM(downloads) AS downloads
          FROM day_stats WHERE day >= ?${slugFilter ? " AND slug = ?" : ""}
          GROUP BY day ORDER BY day`;
        const cursor = slugFilter
          ? this.sql.exec(query, since, slugFilter)
          : this.sql.exec(query, since);
        for (const row of cursor.toArray()) byDay.set(row.day, row);
      } catch (err) {
        console.error("timeseries failed", err.message);
      }
    }
    // Fold in deltas still waiting for the next alarm flush so the chart
    // reflects activity from the last few seconds too.
    for (const [key, d] of this.pendingDays) {
      const sep = key.lastIndexOf("|");
      const slug = key.slice(0, sep);
      const day = key.slice(sep + 1);
      if (day < since) continue;
      if (slugFilter && slug !== slugFilter) continue;
      const cur = byDay.get(day) || { day, opens: 0, sessions: 0, files: 0, bytes: 0, downloads: 0 };
      cur.opens = (Number(cur.opens) || 0) + (d.opens || 0);
      cur.sessions = (Number(cur.sessions) || 0) + (d.sessions || 0);
      cur.files = (Number(cur.files) || 0) + (d.files || 0);
      cur.bytes = (Number(cur.bytes) || 0) + (d.bytes || 0);
      cur.downloads = (Number(cur.downloads) || 0) + (d.downloads || 0);
      byDay.set(day, cur);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
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
    if (this.sqlReady) {
      const at = Number(record.at) || Date.now();
      try {
        this.sql.exec(
          "INSERT INTO activity_events (at, day, slug, record_json) VALUES (?, ?, ?, ?)",
          at,
          dayKey(at),
          cleanText(record.s || record.slug || "", 60),
          JSON.stringify(record),
        );
        if (at - this.lastActivityPrune > 6 * 3600_000) {
          this.sql.exec("DELETE FROM activity_events WHERE at < ?", at - 90 * 86400_000);
          this.lastActivityPrune = at;
        }
        return;
      } catch (error) {
        console.error("activity SQLite write failed", String(error?.message || error));
      }
    }
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
    session.startedAt = prev?.startedAt || Date.now();
    session.speedHist = prev?.speedHist || [];
    if (prev) {
      session.prevState = prev.state;
      if (session.lastSeen > prev.lastSeen && session.sent >= prev.sent) {
        const dt = (session.lastSeen - prev.lastSeen) / 1000;
        const inst = dt > 0 ? (session.sent - prev.sent) / dt : 0;
        session.speed = prev.speed ? prev.speed * 0.5 + inst * 0.5 : inst || session.speed;
      }
    }
    // Ring buffer of smoothed throughput samples (updates arrive ~1.2s apart,
    // so 50 samples covers roughly the last minute for the admin sparkline).
    session.speedHist = [...session.speedHist, { t: Date.now(), bps: Math.round(session.speed) }].slice(-50);
    const remaining = Math.max(0, session.total - session.sent);
    session.eta =
      session.state !== "done" && session.speed > 0 ? Math.round(remaining / session.speed) : 0;
    if (session.state === "done" && session.prevState !== "done") {
      this.noteFinished(session);
      this.accumulateEvent(
        normalizeEvent(
          {
            type: "sessionclose",
            slug: session.slug,
            label: session.label,
            uploader: session.uploader,
            bytes: session.sent,
            count: session.done,
            message: `${session.done} file${session.done === 1 ? "" : "s"} uploaded`,
            sessionId: session.id,
          },
          null,
        ),
      );
      this.armAlarm().catch(() => {});
    }

    this.sessions.set(session.id, session);
    return session;
  }

  // Compact summaries of recently completed sessions for the admin Live tab
  // ("Finished this hour"). In-memory only; lost on DO restart, which is fine.
  noteFinished(session) {
    this.recentDone.unshift({
      id: session.id,
      slug: session.slug,
      label: session.label,
      uploader: session.uploader,
      files: session.done,
      bytes: session.sent,
      duration: Math.max(1, Math.round((Date.now() - session.startedAt) / 1000)),
      endedAt: Date.now(),
    });
    const cutoff = Date.now() - 3600_000;
    this.recentDone = this.recentDone.filter((s) => s.endedAt >= cutoff).slice(0, 20);
  }

  // One digest email per finished session ("Priya uploaded 214 files, 18 GB").
  // The server decides when a session is finished from the Drive-verified
  // completions it received, never from the uploader's browser: a closed tab,
  // a dropped WebSocket or a failed /api/complete used to leave the session
  // "uploading" forever and the email never went out. Counts come from the
  // same completions, so the email matches what actually landed in Drive.
  noteDigest(sessionId, patch) {
    if (!sessionId) return;
    const cur = this.digests.get(sessionId) || { slug: "", label: "", uploader: "", seen: new Set(), files: 0, bytes: 0, expected: 0, done: false, lastAt: 0 };
    const { file, verifiedUploader, uploader, done, ...rest } = patch;
    Object.assign(cur, rest, { lastAt: Date.now() });
    // "done" is sticky, retried completions count once, and the
    // Drive-verified uploader name beats what the browser typed.
    cur.done = cur.done || !!done;
    cur.uploader = verifiedUploader || cur.uploader || uploader || "";
    if (file && !cur.seen.has(file.id)) {
      cur.seen.add(file.id);
      cur.files++;
      cur.bytes += file.bytes;
    }
    this.digests.set(sessionId, cur);
    this.armAlarm().catch(() => {});
  }

  digestReady(d, now) {
    if (!d.files) return false;
    const finished = d.done || (d.expected && d.files >= d.expected);
    // Short grace so completions racing the client's "done" still count;
    // long grace covers a tab closed mid-transfer with nothing else coming.
    return now - d.lastAt >= (finished ? DIGEST_SETTLE_MS : DIGEST_IDLE_MS);
  }

  async flushDigests() {
    const now = Date.now();
    for (const [id, d] of this.digests) {
      if (!this.digestReady(d, now)) continue;
      this.digests.delete(id);
      try {
        const link = await this.env.KV.get(`link:${d.slug}`, "json");
        if (!link) continue;
        const notify = normalizeNotify(link.notify);
        if (!notify.enabled || !notify.complete) continue;
        const files = `${d.files} file${d.files === 1 ? "" : "s"}`;
        await sendNotify(this.env, {
          subject: `${APP_NAME}: ${d.uploader} finished uploading`,
          html: `<p><b>${escapeHtml(d.uploader)}</b> finished uploading to <b>${escapeHtml(link.label)}</b>.</p><p>${files} - ${escapeHtml(fmtBytesServer(d.bytes))}</p>`,
          text: `${d.uploader} finished uploading ${files} (${fmtBytesServer(d.bytes)}) to ${link.label}.`,
          category: "upload-completed",
        });
      } catch (err) {
        console.error("digest failed", err.message);
      }
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
      pend = { recents: [], seen: new Set(), label, lastUploader: "", lastFile: "", lastSessionId: "" };
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
    pend.lastSessionId = meta.si || pend.lastSessionId;
    if (meta.si) this.noteDigest(meta.si, { slug, label, verifiedUploader: meta.u, file: { id, bytes: meta.s } });
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
        cur.lastSessionId = pend.lastSessionId || cur.lastSessionId;
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
        const cur = this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0, views: 0, viewers: {} };
        cur.opens += delta.opens;
        cur.downloads += delta.downloads;
        cur.bytes += delta.bytes;
        cur.views += delta.views || 0;
        Object.assign(cur.viewers, delta.viewers || {});
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

    // 6) finished-session digest emails
    await this.flushDigests();

    if (
      this.digests.size ||
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
    const newMetas = [];
    for (const m of pend.recents) {
      const id = m.f || `${m.n}:${m.at}`;
      if (existingIds.has(id)) continue;
      existingIds.add(id);
      newFiles++;
      newBytes += m.s;
      newMetas.push(m);
    }

    await this.env.KV.put(`recent:${slug}`, JSON.stringify(mergeRecent(existing, pend.recents)));
    if (newFiles === 0) return;

    const stats = normalizeStats(await this.env.KV.get(`stats:${slug}`, "json"));
    stats.files += newFiles;
    stats.bytes += newBytes;
    await this.env.KV.put(`stats:${slug}`, JSON.stringify(stats));

    this.bumpDay(slug, { files: newFiles, bytes: newBytes });
    const newBySession = new Map();
    for (const meta of newMetas) {
      const key = meta.si || "";
      if (!newBySession.has(key)) newBySession.set(key, []);
      newBySession.get(key).push(meta);
    }
    for (const [sessionId, metas] of newBySession) {
      const bytes = metas.reduce((total, meta) => total + meta.s, 0);
      const last = metas.at(-1);
      this.accumulateEvent(
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
          null
        )
      );
    }
  }

  snapshot() {
    this.prune();
    return [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  broadcast() {
    const payload = { type: "snapshot", active: this.snapshot(), recent: this.recentDone };
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
