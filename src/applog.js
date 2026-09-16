// Application log: what the transcoders, rules and admin actions did and
// where they failed. Lives in the LiveTracker Durable Object's SQLite (no
// KV writes, no per-line cost); capped at LOG_CAP rows. Worker code calls
// appLog() and never awaits it on the request path.

import { json, cleanText } from "./util.js";
import { liveStub } from "./store.js";

export const LOG_CAP = 3000;
export const LOG_SCHEMA = `CREATE TABLE IF NOT EXISTS app_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  level TEXT NOT NULL,
  area TEXT NOT NULL,
  message TEXT NOT NULL,
  detail TEXT
)`;

// level: info | warn | error. area: images | previews | rules | email | drive | admin
export function appLog(env, ctx, entry) {
  const body = JSON.stringify({
    at: Date.now(),
    level: ["info", "warn", "error"].includes(entry.level) ? entry.level : "info",
    area: cleanText(entry.area || "app", 24),
    message: cleanText(entry.message || "", 300),
    detail: entry.detail == null ? "" : cleanText(typeof entry.detail === "string" ? entry.detail : JSON.stringify(entry.detail), 2000),
  });
  if (!env?.LIVE_TRACKER) {
    console.log("applog", body);
    return Promise.resolve();
  }
  const send = liveStub(env)
    .fetch("https://live.internal/log", { method: "POST", headers: { "content-type": "application/json" }, body })
    .catch(() => {});
  if (ctx?.waitUntil) ctx.waitUntil(send);
  return send;
}

// Inside the Durable Object.
export function logInsert(sql, body) {
  sql.exec("INSERT INTO app_log (at, level, area, message, detail) VALUES (?, ?, ?, ?, ?)", Number(body.at) || Date.now(), String(body.level || "info"), String(body.area || "app"), String(body.message || ""), String(body.detail || ""));
  // Trim rarely: every ~100 inserts is plenty for a 3000-row cap.
  if (Math.random() < 0.01) sql.exec("DELETE FROM app_log WHERE id NOT IN (SELECT id FROM app_log ORDER BY id DESC LIMIT ?)", LOG_CAP);
}
export function logQuery(sql, { limit = 200, area = "", level = "", before = 0 } = {}) {
  const where = [];
  const args = [];
  if (area) {
    where.push("area = ?");
    args.push(area);
  }
  if (level === "warn") where.push("level IN ('warn','error')");
  else if (level === "error") where.push("level = 'error'");
  if (before) {
    where.push("id < ?");
    args.push(before);
  }
  const rows = sql.exec(`SELECT id, at, level, area, message, detail FROM app_log${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`, ...args, limit).toArray();
  return rows;
}

// Admin endpoint.
export async function adminLogs(env, url) {
  const params = new URLSearchParams({
    limit: String(Math.max(1, Math.min(500, Number(url.searchParams.get("limit")) || 200))),
    area: cleanText(url.searchParams.get("area") || "", 24),
    level: cleanText(url.searchParams.get("level") || "", 8),
    before: String(Number(url.searchParams.get("before")) || 0),
  });
  const r = await liveStub(env).fetch(`https://live.internal/logs?${params}`);
  if (!r.ok) return json({ error: "log store unavailable" }, 503);
  return json(await r.json());
}
