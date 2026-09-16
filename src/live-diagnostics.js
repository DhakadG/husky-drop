// LiveTracker routes for the app log and the People view. Split out of
// live.js to keep the Durable Object file readable.

import { cleanText, clamp } from "./util.js";
import { logInsert, logQuery } from "./applog.js";
import { buildPeople, personEvents, rememberIdentity, setAlias } from "./people.js";
import { banRows, isBanned, listSessions, sessionsFor, setBan, upsertSession } from "./identity.js";
import { dropSuggestion, replaceSuggestions, suggestionRows } from "./stitch.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function diagnosticsRoute(state, path, url, body, isPost, method = "") {
  const sql = state.storage.sql;
  try {
    if (path === "/people") return reply({ people: buildPeople(sql, clamp(Number(url.searchParams.get("days")) || 90, 1, 365)) });
    if (path === "/person") {
      const key = cleanText(url.searchParams.get("key") || "", 200);
      const events = personEvents(sql, key);
      const ids = [...new Set(events.flatMap((e) => [e.d, e.p]).filter(Boolean))];
      return reply({ events, sessions: sessionsFor(sql, { email: key.startsWith("email:") ? key.slice(6) : "", keys: [...ids, key.replace(/^(device|fp|session):/, "")] }) });
    }
    if (isPost && path === "/hello") {
      upsertSession(sql, body);
      if (body.email) rememberIdentity(sql, { d: body.did, p: body.fp, e: body.email, at: body.at });
      return reply({ ok: true });
    }
    if (isPost && path === "/banned") return reply({ banned: isBanned(sql, body) });
    if (path === "/sessions") return reply({ sessions: listSessions(sql, clamp(Number(url.searchParams.get("limit")) || 200, 1, 500)) });
    if (path === "/bans" && !isPost) return reply({ bans: banRows(sql) });
    if (path === "/bans" && isPost) return reply({ ok: setBan(sql, body.kind, body.value, body.reason, body.on !== false) });
    if (path === "/suggestions") {
      if (method === "DELETE") dropSuggestion(sql, cleanText(body.key || "", 200));
      else if (isPost) replaceSuggestions(sql, body.rows || []);
      return reply({ suggestions: suggestionRows(sql) });
    }
    if (isPost && path === "/alias") {
      setAlias(sql, cleanText(body.key || "", 200), cleanText(body.email || "", 120));
      return reply({ ok: true });
    }
    if (isPost && path === "/log") {
      logInsert(sql, body);
      return reply({ ok: true });
    }
    if (path === "/logs") {
      return reply({ rows: logQuery(sql, { limit: clamp(Number(url.searchParams.get("limit")) || 200, 1, 500), area: cleanText(url.searchParams.get("area") || "", 24), level: cleanText(url.searchParams.get("level") || "", 8), before: Number(url.searchParams.get("before")) || 0 }) });
    }
  } catch (err) {
    return reply({ error: err.message }, 500);
  }
  return null;
}
