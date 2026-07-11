# Analytics Backend Implementation Plan

**Goal:** Validate, batch, retain, and summarize Drop/Share trekker events without per-click KV writes or unbounded personal data.

## Change 1 — shared validator

**Locate:** `src/util.js` after `normalizeEvent()`.

**Action:** INSERT `normalizeTelemetryEvent(raw, scope, slug, sessionId, receivedAt)` returning `null` for invalid versions/types/timestamps and a compact record `{v,id,sc,t,at,em,q,s,si,d}`. Clamp client timestamps to `receivedAt ± 5 minutes`, strings to documented bounds, numeric counts to safe ranges, and reject keys outside the per-scope allowlist.

**Old code:** no telemetry normalizer.

**New code:**

```js
export function normalizeTelemetryEvent(raw, scope, slug, sessionId, receivedAt = Date.now()) {
  if (Number(raw?.v) !== 1 || !["drop", "share"].includes(scope)) return null;
  const type = cleanText(raw.t || "", 40);
  const id = cleanText(raw.id || "", 80);
  if (!type || !id) return null;
  const clientAt = Number(raw.at) || receivedAt;
  return {
    v: 1, id, sc: scope, t: type,
    at: clamp(clientAt, receivedAt - 300000, receivedAt + 300000),
    em: clamp(Number(raw.elapsedMs) || 0, 0, 86400000),
    q: clamp(Number(raw.seq) || 0, 0, 1000000),
    s: cleanText(slug, 60), si: cleanText(sessionId, 80),
    d: normalizeTelemetryData(raw.data, scope),
  };
}
```

## Change 2 — public routes

**Locate:** `src/worker.js`, public API routing.

**Action:** INSERT:

```js
if (m === "POST" && p === "/api/drop/track") return ingestTelemetry(request, env, "drop");
```

**Locate:** `src/share.js`, existing `shareTrack()`.

**Action:** REPLACE its coarse event conversion with `ingestTelemetry(request, env, "share")`; retain compatibility for old `{t,name}` events for one release by converting them before validation.

## Change 3 — ingestion and limits

**Locate:** `src/store.js`.

**Action:** ADD `ingestTelemetry()` that validates slug existence, accepts at most 30 events and 48 KB JSON, rate-limits `scope+slug+hashed IP` to 180 events/minute, and relays one batch to `https://live.internal/telemetry`. Return `202 {accepted,rejected}`. Never write KV in the request handler.

## Change 4 — Durable Object storage

**Locate:** `src/live.js`, `initSql()`.

**Action:** INSERT tables:

```sql
CREATE TABLE IF NOT EXISTS telemetry_events (
  id TEXT PRIMARY KEY, scope TEXT NOT NULL, slug TEXT NOT NULL,
  session_id TEXT NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL, seq INTEGER NOT NULL, data_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS telemetry_session_at ON telemetry_events(scope, slug, session_id, at);
CREATE TABLE IF NOT EXISTS telemetry_sessions (
  scope TEXT NOT NULL, slug TEXT NOT NULL, session_id TEXT NOT NULL,
  started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0, views INTEGER NOT NULL DEFAULT 0,
  downloads INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(scope, slug, session_id)
);
```

Add `/telemetry` POST to insert with `INSERT OR IGNORE`, update the summary counters in one transaction, cap raw rows to 50,000, and delete raw rows older than 30 days. Keep session summaries 90 days.

## Change 5 — admin query

**Locate:** `src/worker.js`, authenticated routes.

**Action:** ADD `GET /api/admin/analytics/sessions?scope=&slug=&before=&limit=`. Route to DO `/analytics/sessions`; return summaries and optionally the selected session's ordered events. Never return IP addresses, PINs, tokens, signed URLs, or disallowed data.

## Change 6 — tests

**Locate:** `scripts/telemetry-test.mjs`.

**Action:** CREATE tests for size/count limits, timestamp clamping, unsafe-key removal, deduplication, rate limits, ordering by `seq`, retention deletion, and backward compatibility. Add route/DO integration cases to `scripts/smoke-test.mjs`.
