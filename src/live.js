// LiveTracker Durable Object: live upload sessions over hibernatable
// WebSockets, coalesced admin deltas, batched KV flushes for completions and
// opens, in-memory rate limiting and folder-creation locks. Analytics storage
// lives in live-analytics.js and the finished-session email in live-digest.js.

import {
  COMPLETION_FLUSH_MS,
  EVENT_CAP,
  JSON_HEADERS,
  clamp,
  cleanText,
  dayKey,
  normalizeEvent,
  normalizeLiveSession,
  sanitizeFolderName,
} from "./util.js";
import { ensureLinkFolderDirect, resolvePathFolderDirect, resolveUploaderFolderDirect } from "./drive.js";
import { bumpStats } from "./store.js";
import { Analytics } from "./live-analytics.js";
import { DigestQueue } from "./live-digest.js";
import { CompletionQueue } from "./live-completions.js";
import { LOG_SCHEMA } from "./applog.js";
import { IDENTITY_SCHEMA, identityMap, rememberIdentity } from "./people.js";
import { SESSION_SCHEMA } from "./identity.js";
import { SUGGESTION_SCHEMA } from "./stitch.js";
import { diagnosticsRoute } from "./live-diagnostics.js";

// Progress ticks from N uploaders inside this window become one admin patch.
const BROADCAST_COALESCE_MS = 200;
const FOLDER_ID_TTL_MS = 6 * 3600_000;
const SESSION_STALE_MS = 2 * 60_000;
const RECENT_DONE_KEY = "recentDone";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export class LiveTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.sortedSessions = null; // snapshot() cache, dropped on any session mutation
    this.dirtySessions = new Set(); // ids changed since the last admin patch
    this.recentDirty = false;
    this.broadcastTimer = null;
    this.recentDone = []; // finished-session summaries for the Live tab
    this.folderLocks = new Map(); // key -> in-flight resolve promise
    this.folderIds = new Map(); // key -> { id, at } resolved Drive folder id (KV is eventually consistent; this is not)
    this.started = new Set();
    this.pendingOpens = new Map(); // slug -> count
    this.rateBuckets = new Map(); // key -> { count, reset }
    this.digests = new DigestQueue(env, () => this.armAlarm().catch(() => {}));
    let sql = null;
    try {
      sql = state.storage.sql;
    } catch {}
    this.analytics = new Analytics(sql);
    this.completions = new CompletionQueue(env, this.analytics);
    state.blockConcurrencyWhile(() => this.wake());
  }

  // Runs on every cold start, including a wake from WebSocket hibernation.
  // Live sessions are rebuilt from the next progress frame; the "finished
  // this hour" list is the one thing worth keeping across the gap. Admin
  // sockets survive hibernation holding a stale list, so they get a fresh
  // (possibly empty) snapshot right away.
  async wake() {
    this.analytics.init();
    try {
      this.state.storage.sql?.exec(LOG_SCHEMA);
      this.state.storage.sql?.exec(IDENTITY_SCHEMA);
      this.state.storage.sql?.exec(SESSION_SCHEMA);
      this.state.storage.sql?.exec(SUGGESTION_SCHEMA);
    } catch {}
    try {
      this.recentDone = (await this.state.storage.get(RECENT_DONE_KEY)) || [];
    } catch {}
    for (const socket of this.adminSockets()) {
      this.safeSend(socket, { type: "snapshot", active: this.snapshot(), recent: this.recentDone });
    }
  }

  // Events that predate a device's Google sign-in get its e-mail on read.
  withIdentity(events) {
    let ids;
    try {
      ids = identityMap(this.state.storage.sql);
    } catch {
      return events;
    }
    return events.map((e) => (e && !e.e && e.d && ids.get(e.d) ? { ...e, e: ids.get(e.d).email, ei: 1 } : e));
  }

  adminSockets() {
    return this.state.getWebSockets?.("admin") || [];
  }

  get sqlReady() {
    return this.analytics.ready;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const isPost = request.method === "POST";
    const body = isPost ? await request.json().catch(() => ({})) : {};

    if (path === "/snapshot") return reply({ active: this.snapshot(), recent: this.recentDone });

    if (path === "/timeseries") {
      const days = clamp(Number(url.searchParams.get("days")) || 30, 1, 120);
      const slug = cleanText(url.searchParams.get("slug") || "", 66);
      return reply({ rows: this.analytics.timeseries(days, slug) });
    }

    if (path === "/events") {
      const limit = clamp(Number(url.searchParams.get("limit")) || 60, 1, EVENT_CAP);
      return reply({ events: this.withIdentity(this.analytics.recentEvents(limit)) });
    }

    if (path === "/events-days") {
      const beforeRaw = cleanText(url.searchParams.get("before") || "", 10);
      const before = /^\d{4}-\d{2}-\d{2}$/.test(beforeRaw) ? beforeRaw : dayKey(Date.now());
      const days = clamp(Number(url.searchParams.get("days")) || 3, 1, 14);
      const out = this.analytics.eventDays(before, days);
      if (out?.days) for (const day of out.days) day.events = this.withIdentity(day.events || []);
      return out ? reply(out) : reply({ error: "bad before date" }, 400);
    }

    if (path === "/share-stats") return reply({ rows: this.analytics.shareStatRows() });

    const diag = diagnosticsRoute(this.state, path, url, body, isPost, request.method);
    if (diag) return diag;

    if (isPost && path === "/ratelimit") {
      const key = cleanText(body.key || "", 120);
      const max = clamp(Number(body.max) || 5, 1, 1000);
      const windowSec = clamp(Number(body.windowSec) || 60, 1, 86400);
      return reply(this.rateLimit(key, max, windowSec));
    }

    if (isPost && path === "/telemetry") return reply({ ok: true, stored: this.analytics.storeTelemetry(body) });

    if (isPost && path === "/event") {
      if (body.record) {
        this.analytics.recordEvent(body.record);
        try {
          rememberIdentity(this.state.storage.sql, body.record);
        } catch {}
      }
      if (!this.sqlReady) await this.armAlarm();
      return reply({ ok: true });
    }

    if (isPost && path === "/open") {
      const slug = cleanText(body.slug || "", 60);
      if (slug) {
        this.pendingOpens.set(slug, (this.pendingOpens.get(slug) || 0) + 1);
        this.analytics.bumpDay(slug, { opens: 1 });
        if (body.record) this.analytics.recordEvent(body.record);
        await this.armAlarm();
      }
      return reply({ ok: true });
    }

    if (isPost && path === "/share-stat") {
      const slug = cleanText(body.slug || "", 60);
      let viewerPreviouslySeen = null;
      if (slug) {
        viewerPreviouslySeen = this.analytics.bumpShareStat(slug, body);
        await this.armAlarm();
      }
      return reply({ ok: true, viewerPreviouslySeen });
    }

    if (isPost && path === "/close") {
      const id = cleanText(body.id || "", 100);
      const slug = cleanText(body.slug || "", 60);
      let closed = 0;
      for (const [sessionId, session] of this.sessions) {
        if (id ? sessionId !== id : session.slug !== slug) continue;
        this.sessions.delete(sessionId);
        this.markDirty(sessionId);
        closed++;
      }
      return reply({ ok: true, closed });
    }

    if (isPost && (path === "/folder" || path === "/pathfolder")) {
      const link = body.link || {};
      const uploader = cleanText(body.uploader || "anonymous", 120) || "anonymous";
      if (!link.slug || !link.folderId) return reply({ error: "link required" }, 400);
      const who = sanitizeFolderName(uploader).toLowerCase();
      // Serialize (nested) folder creation so parallel files from the same
      // uploader or directory never race and create duplicate Drive folders.
      const segments = Array.isArray(body.segments)
        ? body.segments.map((s) => cleanText(s, 90)).filter(Boolean).slice(0, 12)
        : [];
      const [key, resolve] = path === "/folder"
        ? [`${link.slug}:${link.folderId}:${who}`, () => resolveUploaderFolderDirect(this.env, link, uploader)]
        : [`path:${link.slug}:${link.folderId}:${who}:${segments.join("/").toLowerCase()}`, () => resolvePathFolderDirect(this.env, link, uploader, segments)];
      return this.folderReply(key, resolve);
    }

    if (isPost && path === "/linkfolder") {
      // Serialize lazy Drive folder creation for links created "instantly".
      const slug = cleanText(body.slug || "", 60);
      if (!slug) return reply({ error: "slug required" }, 400);
      return this.folderReply(`__link__:${slug}`, () => ensureLinkFolderDirect(this.env, slug));
    }

    if (isPost && path === "/session-start") {
      const link = body.link || {};
      const id = cleanText(body.sessionId || "", 80);
      if (!link.slug || !id) return reply({ first: false });
      const key = `${link.slug}:${id}`;
      // Memory answers repeats for free; the KV guard only matters after a
      // hibernation wake emptied `started` mid-session.
      if (this.started.has(key) || (await this.env.KV.get(`started:${key}`))) {
        this.started.add(key);
        return reply({ first: false });
      }
      this.started.add(key);
      this.analytics.bumpDay(link.slug, { sessions: 1 });
      await this.armAlarm();
      this.env.KV.put(`started:${key}`, "1", { expirationTtl: 24 * 3600 }).catch(() => {});
      return reply({ first: true });
    }

    if (isPost && path === "/progress") {
      this.recordProgress(body);
      return reply({ ok: true });
    }

    if (isPost && path === "/complete") {
      const slug = cleanText(body.slug || "", 60);
      if (!slug || !body.meta) return reply({ ok: false });
      const label = cleanText(body.label || "", 100);
      const { id, meta } = this.completions.add(slug, label, body.meta);
      if (meta.si) {
        this.digests.note(meta.si, { slug, label, verifiedUploader: meta.u, origin: cleanText(body.origin || "", 200), client: body.client || null, file: { id, bytes: meta.s, name: meta.n } });
      }
      await this.armAlarm();
      return reply({ ok: true, queued: true });
    }

    if (request.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });

    // Hibernatable sockets: the DO is evicted (and unbilled) while admin
    // dashboards sit idle, and events arrive via webSocketMessage/Close.
    // Per-socket state must live in the attachment, not on the object.
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const role = url.searchParams.get("role") === "admin" ? "admin" : "upload";
    const slug = url.searchParams.get("slug") || "";

    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, slug, sessionId: "" });
    if (role === "admin") {
      this.safeSend(server, { type: "snapshot", active: this.snapshot(), recent: this.recentDone });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async folderReply(key, resolve) {
    try {
      return reply({ folderId: await this.resolveFolderOnce(key, resolve) });
    } catch (err) {
      return reply({ error: err.message }, 502);
    }
  }

  webSocketMessage(ws, data) {
    const meta = ws.deserializeAttachment() || {};
    if (meta.role !== "upload") return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg?.type !== "progress") return;
    const session = this.recordProgress({ ...msg, slug: meta.slug });
    if (meta.sessionId !== session.id) ws.serializeAttachment({ ...meta, sessionId: session.id });
  }

  webSocketClose(ws) {
    const meta = ws.deserializeAttachment() || {};
    const existing = meta.sessionId && this.sessions.get(meta.sessionId);
    if (existing) {
      existing.state = existing.state === "done" ? "done" : "stale";
      existing.lastSeen = Date.now();
      this.markDirty(existing.id);
    }
    try {
      ws.close();
    } catch {}
  }

  webSocketError(ws) {
    this.webSocketClose(ws);
  }

  // Shared by the WebSocket path and the /api/progress fallback.
  recordProgress(input) {
    const session = this.recordSession(input);
    this.digests.note(session.id, { slug: session.slug, label: session.label, uploader: session.uploader, expected: session.count, done: session.state === "done" });
    return session;
  }

  // Resolve a Drive folder once per DO lifetime. Parallel files from one
  // uploader used to queue on the in-flight lock and then each re-read a KV
  // cache that had not propagated yet, so every file paid a Drive lookup in
  // series - about one file per second no matter how fast the network was.
  async resolveFolderOnce(key, resolve) {
    const known = this.folderIds.get(key);
    if (known && Date.now() - known.at < FOLDER_ID_TTL_MS) return known.id;
    if (!this.folderLocks.has(key)) {
      this.folderLocks.set(key, resolve().finally(() => this.folderLocks.delete(key)));
    }
    const id = await this.folderLocks.get(key);
    // A folder deleted in Drive stays cached for at most the TTL.
    if (id) this.folderIds.set(key, { id, at: Date.now() });
    return id;
  }

  rateLimit(key, max, windowSec) {
    const now = Date.now();
    // Memory guard that only drops expired buckets: clearing everything at
    // once handed every client a coordinated free window.
    if (this.rateBuckets.size > 5000) {
      for (const [k, b] of this.rateBuckets) if (b.reset <= now) this.rateBuckets.delete(k);
    }
    let bucket = this.rateBuckets.get(key);
    if (!bucket || bucket.reset <= now) {
      bucket = { count: 0, reset: now + windowSec * 1000 };
      this.rateBuckets.set(key, bucket);
    }
    bucket.count++;
    if (bucket.count > max) return { allowed: false, retryAfter: Math.ceil((bucket.reset - now) / 1000) };
    return { allowed: true, retryAfter: 0 };
  }

  async armAlarm() {
    const existing = await this.state.storage.getAlarm();
    if (!existing) await this.state.storage.setAlarm(Date.now() + COMPLETION_FLUSH_MS);
  }

  prune() {
    const cutoff = Date.now() - SESSION_STALE_MS;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen >= cutoff) continue;
      this.sessions.delete(id);
      this.markDirty(id);
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
    session.eta = session.state !== "done" && session.speed > 0 ? Math.round(remaining / session.speed) : 0;
    if (session.state === "done" && session.prevState !== "done") {
      this.noteFinished(session);
      this.analytics.recordEvent(
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
    this.markDirty(session.id);
    return session;
  }

  // Compact summaries of recently completed sessions for the admin Live tab
  // ("Finished this hour"). Persisted so a hibernation wake keeps them.
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
    this.recentDirty = true;
    this.state.storage.put(RECENT_DONE_KEY, this.recentDone).catch(() => {});
  }

  async alarm() {
    // 1) completions -> recent:/stats: keys + day rollups
    await this.completions.flush();

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

    // 3) share stats / events KV fallback + day rollups -> DO SQLite
    await this.analytics.flushKV(this.env);

    // 4) finished-session digest emails
    await this.digests.flush();

    if (this.digests.size || this.completions.size || this.pendingOpens.size || this.analytics.hasPending()) {
      await this.state.storage.setAlarm(Date.now() + COMPLETION_FLUSH_MS);
    }
  }

  snapshot() {
    this.prune();
    this.sortedSessions ??= [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
    return this.sortedSessions;
  }

  // Admin viewers get deltas, not the whole list: a progress tick used to
  // re-sort and re-serialize every session for every socket. Ticks inside the
  // coalesce window collapse into one patch; new sockets still get a snapshot.
  markDirty(sessionId) {
    this.sortedSessions = null;
    this.dirtySessions.add(sessionId);
    this.broadcastTimer ??= setTimeout(() => this.flushBroadcast(), BROADCAST_COALESCE_MS);
  }

  flushBroadcast() {
    this.broadcastTimer = null;
    if (!this.dirtySessions.size && !this.recentDirty) return;
    const patch = {
      type: "patch",
      updated: [...this.dirtySessions].map((id) => this.sessions.get(id)).filter(Boolean),
      removed: [...this.dirtySessions].filter((id) => !this.sessions.has(id)),
    };
    if (this.recentDirty) patch.recent = this.recentDone;
    this.dirtySessions.clear();
    this.recentDirty = false;
    const payload = JSON.stringify(patch);
    for (const socket of this.adminSockets()) this.safeSend(socket, payload);
  }

  safeSend(socket, payload) {
    try {
      socket.send(typeof payload === "string" ? payload : JSON.stringify(payload));
    } catch {}
  }
}
