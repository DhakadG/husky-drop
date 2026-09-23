// Analytics storage for the LiveTracker Durable Object: per-day rollups,
// raw telemetry batches, the admin activity feed and share counters, all in
// the DO's own SQLite so none of it touches the KV write budget. When SQLite
// is unavailable the same data is buffered in memory and the caller flushes
// it to KV on the next alarm.

import { EVENT_CAP, cleanText, dayKey } from "./util.js";
import { bumpShareStats, mergeEventsKV } from "./store.js";

const DAY_MS = 86400_000;
const PRUNE_EVERY_MS = 6 * 3600_000;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS day_stats (
    slug TEXT NOT NULL,
    day TEXT NOT NULL,
    opens INTEGER NOT NULL DEFAULT 0,
    sessions INTEGER NOT NULL DEFAULT 0,
    files INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (slug, day)
  )`,
  `CREATE TABLE IF NOT EXISTS telemetry_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    slug TEXT NOT NULL,
    session_id TEXT NOT NULL,
    at INTEGER NOT NULL,
    started_at INTEGER NOT NULL DEFAULT 0,
    viewer TEXT NOT NULL DEFAULT '',
    events_json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS telemetry_at_idx ON telemetry_batches(at)",
  "CREATE INDEX IF NOT EXISTS telemetry_slug_idx ON telemetry_batches(slug, at)",
  `CREATE TABLE IF NOT EXISTS activity_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    day TEXT NOT NULL,
    slug TEXT NOT NULL DEFAULT '',
    record_json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS activity_at_idx ON activity_events(at DESC)",
  "CREATE INDEX IF NOT EXISTS activity_day_idx ON activity_events(day, at DESC)",
  `CREATE TABLE IF NOT EXISTS share_stats (
    slug TEXT PRIMARY KEY,
    opens INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    views INTEGER NOT NULL DEFAULT 0,
    viewers_json TEXT NOT NULL DEFAULT '{}'
  )`,
];

const emptyDay = () => ({ opens: 0, sessions: 0, files: 0, bytes: 0, downloads: 0 });
// Share traffic is rolled up under "share:<slug>" with the same columns. The
// chart must not add a guest's downloads to "Data received" or gallery visits
// to "Link opens", so the series keeps drop and share activity apart.
const SHARE_PREFIX = "share:";
const emptySeries = () => ({ opens: 0, sessions: 0, files: 0, bytes: 0, downloads: 0, shareOpens: 0, servedBytes: 0 });
function addToSeries(cur, slug, d) {
  if (slug.startsWith(SHARE_PREFIX)) {
    cur.shareOpens += Number(d.opens) || 0;
    cur.downloads += Number(d.downloads) || 0;
    cur.servedBytes += Number(d.bytes) || 0;
  } else {
    for (const k of ["opens", "sessions", "files", "bytes"]) cur[k] += Number(d[k]) || 0;
  }
}
const emptyShare = () => ({ opens: 0, downloads: 0, bytes: 0, views: 0, viewers: {} });

export class Analytics {
  constructor(sql) {
    this.sql = sql;
    this.ready = false;
    this.pendingDays = new Map(); // `${slug}|${day}` -> delta object
    this.pendingEvents = []; // KV fallback when SQLite is unavailable
    this.pendingShareStats = new Map(); // slug -> { opens, downloads, bytes, views, viewers }
    this.lastTelemetryPrune = 0;
    this.lastActivityPrune = 0;
  }

  init() {
    if (!this.sql) return;
    try {
      for (const statement of SCHEMA) this.sql.exec(statement);
      this.ready = true;
    } catch (err) {
      console.error("analytics schema init failed", err.message);
    }
  }

  hasPending() {
    return this.pendingDays.size > 0 || this.pendingEvents.length > 0 || this.pendingShareStats.size > 0;
  }

  // ---- activity feed ----

  recentEvents(limit) {
    if (!this.ready) return [];
    const rows = this.sql.exec("SELECT record_json FROM activity_events ORDER BY at DESC LIMIT ?", limit).toArray();
    return rows.map((row) => JSON.parse(row.record_json)).filter(Boolean);
  }

  // `before` is an exclusive YYYY-MM-DD upper bound. One ranged query,
  // bucketed in JS, instead of one query per day.
  eventDays(before, days) {
    const start = new Date(`${before}T00:00:00Z`).getTime();
    if (!Number.isFinite(start)) return null;
    const byDay = new Map();
    for (let index = 1; index <= days; index++) byDay.set(dayKey(start - index * DAY_MS), []);
    const oldest = dayKey(start - days * DAY_MS);
    const rows = this.ready
      ? this.sql.exec("SELECT day, record_json FROM activity_events WHERE day >= ? AND day < ? ORDER BY at DESC", oldest, before).toArray()
      : [];
    for (const row of rows) {
      const bucket = byDay.get(row.day);
      if (!bucket || bucket.length >= EVENT_CAP) continue;
      const record = JSON.parse(row.record_json);
      if (record) bucket.push(record);
    }
    return { days: [...byDay].map(([day, events]) => ({ day, events })), oldest };
  }

  recordEvent(record) {
    if (!record || !record.t) return;
    if (this.ready) {
      const at = Number(record.at) || Date.now();
      try {
        this.sql.exec(
          "INSERT INTO activity_events (at, day, slug, record_json) VALUES (?, ?, ?, ?)",
          at, dayKey(at), cleanText(record.s || record.slug || "", 60), JSON.stringify(record),
        );
        if (at - this.lastActivityPrune > PRUNE_EVERY_MS) {
          this.sql.exec("DELETE FROM activity_events WHERE at < ?", at - 90 * DAY_MS);
          this.lastActivityPrune = at;
        }
        return;
      } catch (err) {
        console.error("activity SQLite write failed", err.message);
      }
    }
    this.pendingEvents.push(record);
    if (this.pendingEvents.length > EVENT_CAP + 50) this.pendingEvents = this.pendingEvents.slice(-EVENT_CAP);
  }

  // ---- raw telemetry ----

  // Upload-session view (upload spec §1.5): batches for one drop, newest
  // first, events flattened, with the per-event fields the admin filters on.
  queryTelemetry({ slug = "", kind = "drop", limit = 300, since = 0 } = {}) {
    if (!this.ready) return [];
    const rows = this.sql
      .exec(
        `SELECT kind, slug, session_id, at, started_at, viewer, events_json FROM telemetry_batches
         WHERE (? = '' OR slug = ?) AND (? = '' OR kind = ?) AND at >= ? ORDER BY at DESC LIMIT ?`,
        slug, slug, kind, kind, Number(since) || 0, Math.max(1, Math.min(2000, Number(limit) || 300)),
      )
      .toArray();
    return rows.map((r) => {
      let events = [];
      try {
        events = JSON.parse(r.events_json) || [];
      } catch {}
      return { kind: r.kind, slug: r.slug, sessionId: r.session_id, at: r.at, startedAt: r.started_at, viewer: r.viewer, events };
    });
  }

  storeTelemetry(body) {
    const events = Array.isArray(body.events) ? body.events.slice(0, 40) : [];
    if (!this.ready || !events.length) return false;
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
    if (at - this.lastTelemetryPrune > PRUNE_EVERY_MS) {
      this.sql.exec("DELETE FROM telemetry_batches WHERE at < ?", at - 30 * DAY_MS);
      this.lastTelemetryPrune = at;
    }
    return true;
  }

  // ---- share counters ----

  shareStatRows() {
    if (!this.ready) return [];
    return this.sql.exec("SELECT slug, opens, downloads, bytes, views, viewers_json FROM share_stats").toArray().map((row) => ({
      slug: row.slug,
      opens: Number(row.opens) || 0,
      downloads: Number(row.downloads) || 0,
      bytes: Number(row.bytes) || 0,
      views: Number(row.views) || 0,
      viewers: JSON.parse(row.viewers_json || "{}"),
    }));
  }

  // Returns whether the viewer (if any) had been seen on this share before.
  bumpShareStat(slug, body) {
    const stored = this.ready
      ? this.sql.exec("SELECT opens, downloads, bytes, views, viewers_json FROM share_stats WHERE slug = ?", slug).toArray()[0]
      : null;
    const cur = stored
      ? { opens: Number(stored.opens) || 0, downloads: Number(stored.downloads) || 0, bytes: Number(stored.bytes) || 0, views: Number(stored.views) || 0, viewers: JSON.parse(stored.viewers_json || "{}") }
      : this.pendingShareStats.get(slug) || emptyShare();
    const delta = { opens: Number(body.opens) || 0, downloads: Number(body.downloads) || 0, bytes: Number(body.bytes) || 0 };
    cur.opens += delta.opens;
    cur.downloads += delta.downloads;
    cur.bytes += delta.bytes;
    cur.views += Number(body.views) || 0;
    let viewerPreviouslySeen = null;
    const viewerEmail = cleanText(body.viewer?.email || "", 80);
    if (viewerEmail) {
      viewerPreviouslySeen = Object.prototype.hasOwnProperty.call(cur.viewers, viewerEmail);
      cur.viewers[viewerEmail] = { n: cleanText(body.viewer.name || "", 80), at: Date.now() };
    }
    if (this.ready) {
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
    this.bumpDay(`share:${slug}`, delta);
    if (body.record) this.recordEvent(body.record);
    return viewerPreviouslySeen;
  }

  // ---- per-day rollups ----

  bumpDay(slug, delta) {
    const key = `${slug}|${dayKey(Date.now())}`;
    const cur = this.pendingDays.get(key) || emptyDay();
    for (const [k, v] of Object.entries(delta)) cur[k] = (cur[k] || 0) + Number(v || 0);
    this.pendingDays.set(key, cur);
  }

  flushDays() {
    if (!this.ready || this.pendingDays.size === 0) return;
    const pending = this.pendingDays;
    this.pendingDays = new Map();
    try {
      for (const [key, d] of pending) {
        const sep = key.lastIndexOf("|");
        this.sql.exec(
          `INSERT INTO day_stats (slug, day, opens, sessions, files, bytes, downloads)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(slug, day) DO UPDATE SET
             opens = opens + excluded.opens,
             sessions = sessions + excluded.sessions,
             files = files + excluded.files,
             bytes = bytes + excluded.bytes,
             downloads = downloads + excluded.downloads`,
          key.slice(0, sep), key.slice(sep + 1), d.opens, d.sessions, d.files, d.bytes, d.downloads,
        );
      }
    } catch (err) {
      console.error("day flush failed", err.message);
    }
  }

  timeseries(days, slugFilter) {
    const since = dayKey(Date.now() - days * DAY_MS);
    const byDay = new Map();
    if (this.ready) {
      try {
        const query = `SELECT day, slug LIKE 'share:%' AS share, SUM(opens) AS opens, SUM(sessions) AS sessions,
            SUM(files) AS files, SUM(bytes) AS bytes, SUM(downloads) AS downloads
          FROM day_stats WHERE day >= ?${slugFilter ? " AND slug = ?" : ""}
          GROUP BY day, share ORDER BY day`;
        const cursor = slugFilter ? this.sql.exec(query, since, slugFilter) : this.sql.exec(query, since);
        for (const row of cursor.toArray()) {
          const cur = byDay.get(row.day) || { day: row.day, ...emptySeries() };
          addToSeries(cur, row.share ? SHARE_PREFIX : "", row);
          byDay.set(row.day, cur);
        }
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
      if (day < since || (slugFilter && slug !== slugFilter)) continue;
      const cur = byDay.get(day) || { day, ...emptySeries() };
      addToSeries(cur, slug, d);
      byDay.set(day, cur);
    }
    return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  }

  // ---- KV fallback flush (only has work when SQLite was unavailable) ----

  async flushKV(env) {
    const shareStats = this.pendingShareStats;
    this.pendingShareStats = new Map();
    for (const [slug, delta] of shareStats) {
      try {
        await bumpShareStats(env, slug, delta);
      } catch (err) {
        console.error("share stats flush failed", err.message);
        const cur = this.pendingShareStats.get(slug) || emptyShare();
        cur.opens += delta.opens;
        cur.downloads += delta.downloads;
        cur.bytes += delta.bytes;
        cur.views += delta.views || 0;
        Object.assign(cur.viewers, delta.viewers || {});
        this.pendingShareStats.set(slug, cur);
      }
    }
    if (this.pendingEvents.length) {
      const batch = this.pendingEvents;
      this.pendingEvents = [];
      try {
        await mergeEventsKV(env, batch);
      } catch (err) {
        console.error("event flush failed", err.message);
        this.pendingEvents = batch.concat(this.pendingEvents).slice(-EVENT_CAP);
      }
    }
    this.flushDays();
  }
}
