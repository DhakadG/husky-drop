// Visitor identity: device sessions, fingerprints and bans.
//
// Every /d/ and /s/ page says "hello" once with its FingerprintJS visitor id
// (kept in the hd_fp cookie so later requests carry it) and a handful of
// client details. The LiveTracker DO keeps one row per device in `sessions`
// and learns which Google account it belongs to. Bans are checked by
// account, device cookie and fingerprint before pages and upload/share APIs.

import { json, cleanText, deviceIdFrom, fpFrom, extractClientInfo } from "./util.js";
import { getViewer } from "./auth.js";
import { liveStub } from "./store.js";
import { appLog } from "./applog.js";

export const SESSION_SCHEMA = `CREATE TABLE IF NOT EXISTS sessions (
  key TEXT PRIMARY KEY,
  did TEXT, fp TEXT, email TEXT, os TEXT, loc TEXT, ua TEXT, meta TEXT, slug TEXT,
  first INTEGER NOT NULL, last INTEGER NOT NULL, visits INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS bans (
  kind TEXT NOT NULL, value TEXT NOT NULL, reason TEXT, at INTEGER NOT NULL,
  PRIMARY KEY (kind, value)
)`;

const META_KEYS = ["screen", "viewport", "tz", "lang", "platform", "cores", "mem", "touch", "conn", "standalone", "ref", "browser"];

// Fingerprint Server API verdict for one page load (needs FP_SERVER_KEY,
// region ap). Only the bits the admin acts on are kept.
async function fpVerdict(env, eventId) {
  if (!env.FP_SERVER_KEY || !/^[\w.-]{8,60}$/.test(eventId || "")) return null;
  const r = await fetch(`https://ap.api.fpjs.io/v4/events/${encodeURIComponent(eventId)}`, { headers: { authorization: `Bearer ${env.FP_SERVER_KEY}`, accept: "application/json" } }).catch(() => null);
  if (!r?.ok) return null;
  const e = await r.json().catch(() => ({}));
  const ip = e.ip_info?.v4 || e.ip_info?.v6 || {};
  const geo = ip.geolocation || {};
  return {
    fpConfidence: e.identification?.confidence?.score,
    visitorFound: e.identification?.visitor_found,
    linkedId: e.linked_id,
    firstSeen: e.identification?.first_seen_at,
    osVersion: e.os_version || e.browser_details?.os_version,
    browserName: e.browser_details?.browser_name,
    device: e.device,
    city: [geo.city_name, geo.subdivisions?.[0]?.iso_code, geo.country_code].filter(Boolean).join(", "),
    asn: ip.asn_name,
    datacenter: !!ip.datacenter_result,
    vpn: !!e.vpn, proxy: !!e.proxy, tor: !!e.ip_blocklist?.tor_node, attackSource: !!e.ip_blocklist?.attack_source,
    tampering: !!e.tampering, antiDetect: !!e.tampering_details?.anti_detect_browser,
    devTools: !!e.developer_tools, highActivity: !!e.high_activity_device,
    suspect: e.suspect_score,
    ips24h: e.velocity?.distinct_ip?.["24_hours"], countries24h: e.velocity?.distinct_country?.["24_hours"],
  };
}
export const riskFlags = (m = {}) => [m.tor && "tor", m.vpn && "vpn", m.proxy && "proxy", m.datacenter && "datacenter", m.tampering && "tampering", m.antiDetect && "anti-detect", m.attackSource && "attack source", m.highActivity && "high activity", Number(m.suspect) >= 25 && `suspect ${m.suspect}`, Number(m.countries24h) > 1 && `${m.countries24h} countries/24h`].filter(Boolean);

// ---- DO side ----
export function upsertSession(sql, s) {
  const key = s.did || s.fp || s.si;
  if (!key) return;
  sql.exec(
    `INSERT INTO sessions (key, did, fp, email, os, loc, ua, meta, slug, first, last, visits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(key) DO UPDATE SET
       did = COALESCE(NULLIF(excluded.did, ''), sessions.did), fp = COALESCE(NULLIF(excluded.fp, ''), sessions.fp),
       email = COALESCE(NULLIF(excluded.email, ''), sessions.email), os = excluded.os, loc = excluded.loc, ua = excluded.ua,
       meta = CASE WHEN excluded.meta = '' THEN sessions.meta ELSE excluded.meta END, slug = excluded.slug,
       last = excluded.last, visits = sessions.visits + 1`,
    key, s.did || "", s.fp || "", s.email || "", s.os || "", s.loc || "", s.ua || "", s.meta || "", s.slug || "", s.at, s.at,
  );
}
const parseRow = (r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : {} });
export function sessionsFor(sql, { email = "", keys = [] }) {
  const ids = keys.filter(Boolean);
  const marks = ids.map(() => "?").join(",") || "''";
  return sql.exec(`SELECT * FROM sessions WHERE email = ? OR key IN (${marks}) OR did IN (${marks}) OR fp IN (${marks}) ORDER BY last DESC LIMIT 100`, email || "-", ...ids, ...ids, ...ids).toArray().map(parseRow);
}
export const listSessions = (sql, limit = 200) => sql.exec("SELECT * FROM sessions ORDER BY last DESC LIMIT ?", limit).toArray().map(parseRow);
export const banRows = (sql) => sql.exec("SELECT kind, value, reason, at FROM bans ORDER BY at DESC").toArray();
export function setBan(sql, kind, value, reason, on) {
  if (!["email", "device", "fp"].includes(kind) || !value) return false;
  if (on) sql.exec("INSERT INTO bans (kind, value, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT(kind, value) DO UPDATE SET reason = excluded.reason, at = excluded.at", kind, value, reason || "", Date.now());
  else sql.exec("DELETE FROM bans WHERE kind = ? AND value = ?", kind, value);
  return true;
}
export const isBanned = (sql, { email, did, fp }) => sql.exec("SELECT 1 FROM bans WHERE (kind = 'email' AND value = ?) OR (kind = 'device' AND value = ?) OR (kind = 'fp' AND value = ?) LIMIT 1", email || "-", did || "-", fp || "-").toArray().length > 0;

// ---- worker side ----
const banCache = new Map(); // ponytail: per-isolate 30 s cache; a fresh ban may take that long to bite
export async function bannedRequest(env, request) {
  if (!env.LIVE_TRACKER) return false;
  const viewer = env.GOOGLE_CLIENT_ID ? await getViewer(request, env).catch(() => null) : null;
  const ids = { email: (viewer?.email || "").toLowerCase(), did: deviceIdFrom(request), fp: fpFrom(request) };
  if (!ids.email && !ids.did && !ids.fp) return false;
  const key = `${ids.email}|${ids.did}|${ids.fp}`;
  const hit = banCache.get(key);
  if (hit && Date.now() - hit.at < 30_000) return hit.banned;
  const r = await liveStub(env).fetch("https://live.internal/banned", { method: "POST", body: JSON.stringify(ids) }).catch(() => null);
  const banned = !!(r && r.ok && (await r.json()).banned);
  banCache.set(key, { at: Date.now(), banned });
  return banned;
}
export const blockedResponse = (html) =>
  html
    ? new Response('<!doctype html><meta name="viewport" content="width=device-width"><title>Blocked</title><body style="font-family:system-ui;padding:48px 24px;text-align:center;color:#0c1a2b"><h1 style="font-size:22px">Access blocked</h1><p style="color:#4a5b70">The owner has blocked this account or device.</p>', { status: 403, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } })
    : json({ error: "blocked" }, 403);

export async function clientHello(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const viewer = env.GOOGLE_CLIENT_ID ? await getViewer(request, env).catch(() => null) : null;
  const c = extractClientInfo(request) || {};
  const meta = {};
  for (const k of META_KEYS) if (b.meta && b.meta[k] != null) meta[k] = cleanText(String(b.meta[k]), 80);
  const s = {
    did: deviceIdFrom(request),
    fp: /^[A-Za-z0-9]{16,40}$/.test(b.fp || "") ? b.fp : "",
    si: cleanText(b.sessionId || "", 80),
    email: (viewer?.email || "").toLowerCase(),
    os: c.o || "",
    loc: c.l || "",
    ua: cleanText(request.headers.get("user-agent") || "", 200),
    meta: Object.keys(meta).length ? JSON.stringify(meta) : "",
    slug: cleanText(b.slug || "", 60),
    at: Date.now(),
  };
  if (env.LIVE_TRACKER) {
    ctx.waitUntil(
      (async () => {
        const verdict = await fpVerdict(env, b.fpEvent);
        if (verdict) {
          Object.assign(meta, Object.fromEntries(Object.entries(verdict).filter(([, v]) => v !== undefined && v !== "")));
          s.meta = JSON.stringify(meta);
          const flags = riskFlags(verdict);
          if (flags.length) appLog(env, null, { level: "warn", area: "people", message: `risky visit on ${s.slug || "page"}: ${flags.join(", ")}${s.email ? ` (${s.email})` : ""}`, detail: { did: s.did, fp: s.fp, ...verdict } });
        }
        await liveStub(env).fetch("https://live.internal/hello", { method: "POST", body: JSON.stringify(s) });
      })().catch(() => {}),
    );
  }
  return json({ ok: true });
}

// ---- admin ----
const proxy = async (env, path, init) => {
  const r = await liveStub(env).fetch(`https://live.internal${path}`, init);
  return json(await r.json().catch(() => ({ error: "unavailable" })), r.status);
};
export const adminSessions = (env, url) => proxy(env, `/sessions?limit=${Math.min(500, Number(url.searchParams.get("limit")) || 200)}`);
export async function adminBans(request, env) {
  if (request.method === "GET") return proxy(env, "/bans");
  const b = await request.json().catch(() => ({}));
  const kind = cleanText(b.kind || "", 10);
  const value = cleanText(b.value || "", 120).toLowerCase();
  if (!["email", "device", "fp"].includes(kind) || !value) return json({ error: "kind email|device|fp and value required" }, 400);
  banCache.clear();
  return proxy(env, "/bans", { method: "POST", body: JSON.stringify({ kind, value, reason: cleanText(b.reason || "", 120), on: request.method !== "DELETE" }) });
}
