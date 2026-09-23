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
import { IDENTITY_SCHEMA, identityMap, personKey, rememberIdentity } from "./people.js";
import { SESSION_SCHEMA } from "./identity.js";
import { SUGGESTION_SCHEMA } from "./stitch.js";
import { diagnosticsRoute } from "./live-diagnostics.js";
import { applyPreviewReports, serialBatches } from "./previews.js";
import { applySharePreviewPuts } from "./share-previews.js";
import { applyJobOps } from "./share-index.js";

// Progress ticks from N uploaders inside this window become one admin patch.
const BROADCAST_COALESCE_MS = 200;
const FOLDER_ID_TTL_MS = 6 * 3600_000;
const SESSION_STALE_MS = 2 * 60_000;
const RECENT_DONE_KEY = "recentDone";
const TRANSCODER_STALE_MS = 120_000; // no telemetry for 2 min = the runner is gone

const DISMISS_MS = 10 * 60_000;
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
    this.dismissed = new Map(); // session id -> hidden until (admin "dismiss")
    this.digests = new DigestQueue(env, () => this.armAlarm().catch(() => {}));
    let sql = null;
    try {
      sql = state.storage.sql;
    } catch {}
    this.analytics = new Analytics(sql);
    this.completions = new CompletionQueue(env, this.analytics);
    // Video runner shards report here so their writes to previews:index are serialized.
    this.previewReports = serialBatches((bodies) => applyPreviewReports(env, { waitUntil() {} }, bodies));
    this.sharePreviewPuts = serialBatches((puts) => applySharePreviewPuts(env, puts));
    this.shareIndexJobs = serialBatches((ops) => applyJobOps(env, ops));
    // One run can be spread over up to 20 runners, all reporting here.
    // `runners` is keyed by shard; `workers` by "shard:slot".
    this.transcoderState = {
      active: false,
      runId: null,
      trigger: "manual",
      parallel: 0,
      shards: 0,
      runners: {},
      total: 0,
      done: 0,
      skipped: 0,
      bytesIn: 0,
      bytesOut: 0,
      workers: {},
      recent: [],
      updatedAt: 0,
    };
    this.transcoderTimer = null;
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
      this.safeSend(socket, { type: "snapshot", active: this.snapshot(), recent: this.recentDone, previewsLive: this.transcoderView() });
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
    // `k` is the person key the People tab uses (merges and aliases applied),
    // so an Activity card's "profile" finds the same person.
    return events.map((e) => {
      if (!e) return e;
      const out = !e.e && e.d && ids.get(e.d) ? { ...e, e: ids.get(e.d).email, ei: 1 } : { ...e };
      out.k = personKey(e, ids);
      return out;
    });
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

    if (path === "/snapshot") return reply({ active: this.snapshot(), recent: this.recentDone, previewsLive: this.transcoderView() });
    if (path === "/transcoder-status") return reply(this.transcoderView());

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
    if (isPost && path === "/preview-report") return reply(await this.previewReports(body));
    if (isPost && path === "/share-preview-put") return reply(await this.sharePreviewPuts(body));
    if (isPost && path === "/share-index-jobs") return reply(await this.shareIndexJobs(body));
    if (isPost && path === "/preflight") return reply({ matches: this.analytics.matchCompleted(cleanText(body.slug || "", 60), Array.isArray(body.files) ? body.files.slice(0, 500) : []) });

    const diag = diagnosticsRoute(this.state, path, url, body, isPost, request.method);
    if (diag) return diag;

    if (isPost && path === "/ratelimit") {
      const key = cleanText(body.key || "", 120);
      const max = clamp(Number(body.max) || 5, 1, 1000);
      const windowSec = clamp(Number(body.windowSec) || 60, 1, 86400);
      return reply(this.rateLimit(key, max, windowSec));
    }

    if (isPost && path === "/telemetry") return reply({ ok: true, stored: this.analytics.storeTelemetry(body) });
    if (path === "/telemetry-query") return reply({ batches: this.analytics.queryTelemetry({ slug: url.searchParams.get("slug") || "", kind: url.searchParams.get("kind") || "drop", limit: url.searchParams.get("limit"), since: url.searchParams.get("since") }) });

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
        // The uploader's next frame would re-create it within a second.
        this.dismissed.set(sessionId, Date.now() + DISMISS_MS);
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
    const reqRole = url.searchParams.get("role");
    const role = reqRole === "admin" ? "admin" : reqRole === "transcoder" ? "transcoder" : "upload";
    const slug = url.searchParams.get("slug") || "";

    this.state.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, slug, sessionId: "" });
    if (role === "admin") {
      this.safeSend(server, { type: "snapshot", active: this.snapshot(), recent: this.recentDone, previewsLive: this.transcoderView() });
    } else if (role === "transcoder") {
      this.safeSend(server, { type: "transcoder:ack", ok: true });
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
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (meta.role === "transcoder") {
      if (msg?.type === "transcoder:hello" && meta.shard !== msg.shard) {
        ws.serializeAttachment({ ...meta, shard: msg.shard ?? 0 });
      }
      this.handleTranscoderMessage(msg);
      return;
    }
    if (meta.role !== "upload") return;
    if (msg?.type !== "progress") return;
    const session = this.recordProgress({ ...msg, slug: meta.slug });
    if (meta.sessionId !== session.id) ws.serializeAttachment({ ...meta, sessionId: session.id });
  }

  webSocketClose(ws) {
    const meta = ws.deserializeAttachment() || {};
    if (meta.role === "transcoder") {
      if (meta.shard != null) this.dropRunner(String(meta.shard));
      this.broadcastTranscoderState();
      try {
        ws.close();
      } catch {}
      return;
    }
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

  handleTranscoderMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    const now = Date.now();
    this.transcoderState.updatedAt = now;

    if (msg.type === "transcoder:hello") {
      const runId = cleanText(msg.runId || "", 60);
      // A second runner joining the same run must add to the totals, not wipe
      // them. Only a new run id starts the counters over.
      if (runId !== this.transcoderState.runId) {
        this.transcoderState = {
          ...this.transcoderState,
          runId,
          trigger: cleanText(msg.trigger || "manual", 20),
          runners: {},
          done: 0,
          skipped: 0,
          bytesIn: 0,
          bytesOut: 0,
          total: 0,
          parallel: 0,
          startedAt: Number(msg.startedAt) || now,
          workers: {},
          recent: [],
        };
      }
      const shard = String(msg.shard ?? 0);
      this.transcoderState.runners[shard] = {
        parallel: clamp(Number(msg.parallel) || 1, 1, 16),
        total: Math.max(0, Number(msg.total) || 0),
        startedAt: Number(msg.startedAt) || now,
        seenAt: now,
      };
      this.transcoderState.active = true;
      this.transcoderState.shards = clamp(Number(msg.shards) || 1, 1, 20);
      this.transcoderState.parallel = this.sumRunners("parallel");
      this.transcoderState.total = this.sumRunners("total");
      this.transcoderState.updatedAt = now;
      this.broadcastTranscoderState();
      return;
    }

    if (msg.type === "transcoder:progress") {
      const slot = this.slotKey(msg);
      this.transcoderState.active = true;
      this.transcoderState.workers[slot] = {
        fileId: cleanText(msg.fileId || "", 80),
        name: cleanText(msg.name || "", 120),
        size: Number(msg.size) || 0,
        stage: cleanText(msg.stage || "transcoding", 30),
        percent: clamp(Number(msg.percent) || 0, 0, 100),
        speed: cleanText(String(msg.speed || ""), 16),
        fps: Number(msg.fps) || 0,
        etaSec: Math.max(0, Number(msg.etaSec) || 0),
        startedAt: Number(msg.startedAt) || now,
      };
      this.queueTranscoderBroadcast();
      return;
    }

    if (msg.type === "transcoder:file_done") {
      const slot = this.slotKey(msg);
      delete this.transcoderState.workers[slot];
      this.transcoderState.done += 1;
      this.transcoderState.bytesIn += Number(msg.size) || 0;
      this.transcoderState.bytesOut += Number(msg.previewSize) || 0;
      this.transcoderState.recent = [
        {
          id: cleanText(msg.id || "", 80),
          name: cleanText(msg.name || "", 120),
          ok: true,
          size: Number(msg.size) || 0,
          previewSize: Number(msg.previewSize) || 0,
          ms: Number(msg.ms) || 0,
          via: cleanText(msg.via || "ffmpeg", 20),
          at: now,
        },
        ...this.transcoderState.recent,
      ].slice(0, 40);
      this.broadcastTranscoderState();
      return;
    }

    if (msg.type === "transcoder:file_skip") {
      const slot = this.slotKey(msg);
      delete this.transcoderState.workers[slot];
      this.transcoderState.skipped += 1;
      this.transcoderState.recent = [
        {
          id: cleanText(msg.id || "", 80),
          name: cleanText(msg.name || "", 120),
          ok: false,
          error: cleanText(msg.error || "error", 200),
          at: now,
        },
        ...this.transcoderState.recent,
      ].slice(0, 40);
      this.broadcastTranscoderState();
      return;
    }

    if (msg.type === "transcoder:bye") {
      this.dropRunner(String(msg.shard ?? 0), now);
      this.broadcastTranscoderState();
      return;
    }

    if (msg.type === "transcoder:heartbeat") {
      const runner = this.transcoderState.runners[String(msg.shard ?? 0)];
      if (runner) runner.seenAt = now;
      this.transcoderState.active = true;
      this.transcoderState.updatedAt = now;
      return;
    }
  }

  // Workers are per runner, so a slot number alone is not unique.
  slotKey(msg) {
    return `${String(msg.shard ?? 0)}:${String(msg.slot ?? 0)}`;
  }

  sumRunners(field) {
    return Object.values(this.transcoderState.runners).reduce((n, r) => n + (r[field] || 0), 0);
  }

  // One runner finished or died: forget its slots, and only call the whole run
  // over once every runner has gone.
  dropRunner(shard, now = Date.now()) {
    delete this.transcoderState.runners[shard];
    for (const key of Object.keys(this.transcoderState.workers)) {
      if (key.startsWith(`${shard}:`)) delete this.transcoderState.workers[key];
    }
    this.transcoderState.parallel = this.sumRunners("parallel");
    this.transcoderState.active = Object.keys(this.transcoderState.runners).length > 0;
    this.transcoderState.updatedAt = now;
  }

  // A runner that is killed (cancelled workflow, dead runner) may never send
  // "bye" or close cleanly, which used to pin the dashboard to "live" forever.
  transcoderView() {
    const stale = Date.now() - (this.transcoderState.updatedAt || 0) > TRANSCODER_STALE_MS;
    if (!stale) return this.transcoderState;
    return { ...this.transcoderState, active: false, workers: {}, runners: {} };
  }

  queueTranscoderBroadcast() {
    this.transcoderTimer ??= setTimeout(() => {
      this.transcoderTimer = null;
      this.broadcastTranscoderState();
    }, 250);
  }

  broadcastTranscoderState() {
    const payload = JSON.stringify({
      type: "previews:live",
      live: this.transcoderView(),
    });
    for (const socket of this.adminSockets()) {
      this.safeSend(socket, payload);
    }
  }

  // Shared by the WebSocket path and the /api/progress fallback.
  recordProgress(input) {
    const peek = normalizeLiveSession(input);
    const session = (this.dismissed.get(peek.id) || 0) > Date.now() ? peek : this.recordSession(input);
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
    for (const [id, until] of this.dismissed) if (until <= Date.now()) this.dismissed.delete(id);
    for (const [id, session] of this.sessions) {
      if (session.lastSeen >= cutoff) continue;
      // An upload that died mid-way (tab closed, network gone) would otherwise
      // vanish without a trace; the Live tab lists it as stopped.
      if (session.state !== "done" && (session.done || session.sent)) this.noteFinished(session, true);
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
            message: `${session.done} file${session.done === 1 ? "" : "s"} uploaded${session.error ? `, ${session.error} failed or canceled` : ""}`,
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
  noteFinished(session, stopped = false) {
    this.recentDone.unshift({
      ...(stopped ? { stopped: true, count: session.count } : {}),
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
