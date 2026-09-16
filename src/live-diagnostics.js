// LiveTracker routes for the app log and the People view. Split out of
// live.js to keep the Durable Object file readable.

import { cleanText, clamp } from "./util.js";
import { logInsert, logQuery } from "./applog.js";
import { buildPeople, personEvents, setAlias } from "./people.js";

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function diagnosticsRoute(state, path, url, body, isPost) {
  const sql = state.storage.sql;
  try {
    if (path === "/people") return reply({ people: buildPeople(sql, clamp(Number(url.searchParams.get("days")) || 90, 1, 365)) });
    if (path === "/person") return reply({ events: personEvents(sql, cleanText(url.searchParams.get("key") || "", 200)) });
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
