# Plan 09 — Backend: new endpoints & data for UI 3.0

**Files touched:** `src/util.js`, `src/store.js`, `src/live.js`, `src/share.js`, `src/drive.js`, `src/worker.js`, `wrangler.example.jsonc`.
**Depends on:** nothing (frontend plans 04, 05, 07, 08 and the Live tab consume these).
**New assets:** none. **Storage changes:** `sstats:{slug}` KV records gain `views` + `viewers`; new KV keys `events:day:YYYY-MM-DD` (TTL 90 days). No Durable Object migration needed (in-memory + existing SQLite only).

House rules obeyed throughout (match existing style): flat if-chain routing in `api()`, `json()` responses, `cleanText`/`clamp` input hygiene, hot-path writes relayed to the `LiveTracker` DO and batched by its alarm — never direct KV writes in request handlers when `env.LIVE_TRACKER` is bound.

Feature sections: **B1** speed sparkline · **B2** finished-sessions list · **B3** share viewer analytics (+ **B6** first-open flag) · **B4** activity day pagination · **B5** Drive folder picker · **B8** paused live state. (B7 "Drive write rate" is a frontend derivation — sum of `speed` over the snapshot — no backend change.)

---

## B1 + B8 — Live session: 60s speed history + paused flag

### Change 1: carry `paused` through session normalization
**File:** `src/util.js`
**Why:** The drop page will send `paused:true` while the uploader has paused; admin UI needs to render it. (Plan 08 adds the client side.)
**Locate:**
```js
    done: clamp(Number(input.done) || 0, 0, count || Number.MAX_SAFE_INTEGER),
    error: Math.max(0, Number(input.error) || 0),
    speed: Math.max(0, Number(input.speed) || 0),
    eta: 0,
    files,
    state: cleanText(input.state || "uploading", 20),
    lastSeen: Date.now(),
```
**Action:** REPLACE
**Old code:**
```js
    done: clamp(Number(input.done) || 0, 0, count || Number.MAX_SAFE_INTEGER),
    error: Math.max(0, Number(input.error) || 0),
    speed: Math.max(0, Number(input.speed) || 0),
    eta: 0,
    files,
    state: cleanText(input.state || "uploading", 20),
    lastSeen: Date.now(),
```
**New code:**
```js
    done: clamp(Number(input.done) || 0, 0, count || Number.MAX_SAFE_INTEGER),
    error: Math.max(0, Number(input.error) || 0),
    speed: Math.max(0, Number(input.speed) || 0),
    eta: 0,
    paused: !!input.paused,
    files,
    state: cleanText(input.state || "uploading", 20),
    lastSeen: Date.now(),
```
**Verify:** `npm test` still passes; live session objects include `paused:false` by default.

### Change 2: speed-history ring buffer + finished-session capture in `recordSession`
**File:** `src/live.js`
**Why:** The Live tab sparkline needs the last ~60s of throughput samples, and "Finished this hour" needs a summary the moment a session first reaches `done`.
**Locate:**
```js
  recordSession(input) {
    const session = normalizeLiveSession(input);
    const prev = this.sessions.get(session.id);
    if (prev) {
      session.digestSent = prev.digestSent || false;
      session.prevState = prev.state;
```
**Action:** REPLACE
**Old code:**
```js
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
```
**New code:**
```js
  recordSession(input) {
    const session = normalizeLiveSession(input);
    const prev = this.sessions.get(session.id);
    session.startedAt = prev?.startedAt || Date.now();
    session.speedHist = prev?.speedHist || [];
    if (prev) {
      session.digestSent = prev.digestSent || false;
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
    if (session.state === "done" && session.prevState !== "done") this.noteFinished(session);
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
```
**Verify:** With a live upload running, admin WS snapshots show a growing `speedHist` array per session; finishing an upload adds an entry visible in the next snapshot's `recent` array (Change 4).

### Change 3: initialize the finished-sessions list
**File:** `src/live.js`
**Why:** `noteFinished` needs its backing array.
**Locate:**
```js
    this.pendingOpens = new Map(); // slug -> count
    this.pendingShareStats = new Map(); // slug -> { opens, downloads, bytes }
    this.pendingDays = new Map(); // `${slug}|${day}` -> delta object
    this.rateBuckets = new Map(); // key -> { count, reset }
    this.sqlReady = false;
    try {
      this.sql = state.storage.sql;
```
**Action:** REPLACE
**Old code:**
```js
    this.pendingDays = new Map(); // `${slug}|${day}` -> delta object
    this.rateBuckets = new Map(); // key -> { count, reset }
    this.sqlReady = false;
```
**New code:**
```js
    this.pendingDays = new Map(); // `${slug}|${day}` -> delta object
    this.rateBuckets = new Map(); // key -> { count, reset }
    this.recentDone = []; // finished-session summaries for the Live tab
    this.sqlReady = false;
```
**Verify:** DO constructs without errors (any admin page load exercises it).

### Change 4: include finished sessions in snapshots and broadcasts
**File:** `src/live.js`
**Why:** Admin Live tab renders `recent` next to `active`.
**Locate:**
```js
  }

  broadcast() {
    const payload = { type: "snapshot", active: this.snapshot() };
    for (const socket of [...this.adminSockets]) this.safeSend(socket, payload);
  }

```
**Action:** REPLACE
**Old code:**
```js
  broadcast() {
    const payload = { type: "snapshot", active: this.snapshot() };
    for (const socket of [...this.adminSockets]) this.safeSend(socket, payload);
  }
```
**New code:**
```js
  broadcast() {
    const payload = { type: "snapshot", active: this.snapshot(), recent: this.recentDone };
    for (const socket of [...this.adminSockets]) this.safeSend(socket, payload);
  }
```
**Verify:** Admin WS messages carry `recent: []` (or summaries after a finished upload).

### Change 5: `/snapshot` HTTP path also returns `recent`
**File:** `src/live.js`
**Why:** Keeps the polling fallback consistent with the WS payload.
**Locate:**
```js
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot") {
      this.prune();
      return new Response(JSON.stringify({ active: this.snapshot() }), { headers: JSON_HEADERS });
    }

```
**Action:** REPLACE
**Old code:**
```js
    if (url.pathname === "/snapshot") {
      this.prune();
      return new Response(JSON.stringify({ active: this.snapshot() }), { headers: JSON_HEADERS });
    }
```
**New code:**
```js
    if (url.pathname === "/snapshot") {
      this.prune();
      return new Response(JSON.stringify({ active: this.snapshot(), recent: this.recentDone }), {
        headers: JSON_HEADERS,
      });
    }
```
**Verify:** `GET /api/admin/overview` still works (its `liveSnapshot` reads only `.active`).

**Consuming frontend (plan for Live tab, applied by admin plans):** the existing admin WS handler in `admin.js` receives `{type:"snapshot", active, recent}` — the Live tab reads `msg.recent` for the "Finished this hour" list and `session.speedHist` for sparklines. The drop page (plan 08) adds `paused: state.paused` to the object it already sends in `sendLive()`.

---

## B3 + B6 — Share viewer analytics (views, unique viewers, first open)

### Change 6: extend `normalizeShareStats` with views + viewers
**File:** `src/util.js`
**Why:** `sstats:{slug}` must carry a file-view counter and a capped map of viewer identities.
**Locate:**
```js
export function normalizeShareStats(stats = {}) {
  stats = stats || {};
  return {
    opens: Number(stats.opens) || 0,
    downloads: Number(stats.downloads) || 0,
    bytes: Number(stats.bytes) || 0,
  };
}
```
**Action:** REPLACE
**Old code:**
```js
export function normalizeShareStats(stats = {}) {
  stats = stats || {};
  return {
    opens: Number(stats.opens) || 0,
    downloads: Number(stats.downloads) || 0,
    bytes: Number(stats.bytes) || 0,
  };
}
```
**New code:**
```js
export function normalizeShareStats(stats = {}) {
  stats = stats || {};
  return {
    opens: Number(stats.opens) || 0,
    downloads: Number(stats.downloads) || 0,
    bytes: Number(stats.bytes) || 0,
    views: Number(stats.views) || 0,
    // email -> { n: display name, at: last-seen ms }. Capped in bumpShareStats.
    viewers: stats.viewers && typeof stats.viewers === "object" ? stats.viewers : {},
  };
}
```
**Verify:** `npm test`; existing `sstats:` records normalize without data loss.

### Change 7: `bumpShareStats` accepts views + viewer identity
**File:** `src/store.js`
**Why:** Single write path for share stats — every caller (DO flush and no-DO fallback) routes through here, so views/viewers are counted exactly once.
**Locate:**
```js
export async function bumpShareStats(env, slug, delta) {
  const key = `sstats:${slug}`;
  const stats = normalizeShareStats(await env.KV.get(key, "json"));
  stats.opens += Number(delta.opens) || 0;
  stats.downloads += Number(delta.downloads) || 0;
  stats.bytes += Number(delta.bytes) || 0;
  await env.KV.put(key, JSON.stringify(stats));
  return stats;
}
```
**Action:** REPLACE
**Old code:**
```js
export async function bumpShareStats(env, slug, delta) {
  const key = `sstats:${slug}`;
  const stats = normalizeShareStats(await env.KV.get(key, "json"));
  stats.opens += Number(delta.opens) || 0;
  stats.downloads += Number(delta.downloads) || 0;
  stats.bytes += Number(delta.bytes) || 0;
  await env.KV.put(key, JSON.stringify(stats));
  return stats;
}
```
**New code:**
```js
export async function bumpShareStats(env, slug, delta) {
  const key = `sstats:${slug}`;
  const stats = normalizeShareStats(await env.KV.get(key, "json"));
  stats.opens += Number(delta.opens) || 0;
  stats.downloads += Number(delta.downloads) || 0;
  stats.bytes += Number(delta.bytes) || 0;
  stats.views += Number(delta.views) || 0;
  for (const [email, v] of Object.entries(delta.viewers || {})) {
    const clean = cleanText(email, 80);
    if (!clean) continue;
    stats.viewers[clean] = { n: cleanText(v?.n || "", 80), at: Number(v?.at) || Date.now() };
  }
  // Cap the identity map: keep the 50 most recently seen viewers.
  const entries = Object.entries(stats.viewers);
  if (entries.length > 50) {
    entries.sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
    stats.viewers = Object.fromEntries(entries.slice(0, 50));
  }
  await env.KV.put(key, JSON.stringify(stats));
  return stats;
}
```
**Verify:** `npm test`; a share download still bumps `downloads` and now records the viewer under `viewers`.

### Change 8: DO buffers views + viewers between flushes
**File:** `src/live.js`
**Why:** `/share-stat` batches deltas in `pendingShareStats`; the new fields must survive batching.
**Locate:**
```js
    if (request.method === "POST" && url.pathname === "/share-stat") {
      const body = await request.json().catch(() => ({}));
      const slug = cleanText(body.slug || "", 60);
      if (slug) {
        const cur = this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0 };
        cur.opens += Number(body.opens) || 0;
        cur.downloads += Number(body.downloads) || 0;
        cur.bytes += Number(body.bytes) || 0;
        this.pendingShareStats.set(slug, cur);
```
**Action:** REPLACE
**Old code:**
```js
        const cur = this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0 };
        cur.opens += Number(body.opens) || 0;
        cur.downloads += Number(body.downloads) || 0;
        cur.bytes += Number(body.bytes) || 0;
        this.pendingShareStats.set(slug, cur);
```
**New code:**
```js
        const cur = this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0, views: 0, viewers: {} };
        cur.opens += Number(body.opens) || 0;
        cur.downloads += Number(body.downloads) || 0;
        cur.bytes += Number(body.bytes) || 0;
        cur.views += Number(body.views) || 0;
        if (body.viewer && body.viewer.email) {
          cur.viewers[cleanText(body.viewer.email, 80)] = {
            n: cleanText(body.viewer.name || "", 80),
            at: Date.now(),
          };
        }
        this.pendingShareStats.set(slug, cur);
```
**Verify:** Share opens/downloads still count; `sstats:` records gain `views`/`viewers` after the next alarm flush.

### Change 9: alarm retry path preserves the new fields
**File:** `src/live.js`
**Why:** The flush-failure re-queue must not drop views/viewers.
**Locate:**
```js
      } catch (err) {
        console.error("share stats flush failed", err.message);
        const cur = this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0 };
        cur.opens += delta.opens;
        cur.downloads += delta.downloads;
        cur.bytes += delta.bytes;
        this.pendingShareStats.set(slug, cur);
      }
```
**Action:** REPLACE
**Old code:**
```js
      } catch (err) {
        console.error("share stats flush failed", err.message);
        const cur = this.pendingShareStats.get(slug) || { opens: 0, downloads: 0, bytes: 0 };
        cur.opens += delta.opens;
        cur.downloads += delta.downloads;
        cur.bytes += delta.bytes;
        this.pendingShareStats.set(slug, cur);
      }
```
**New code:**
```js
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
```
**Verify:** No behavior change on the happy path; `npm test`.

### Change 10: `shareTrack` relays view counts + viewer identity
**File:** `src/share.js`
**Why:** File views currently become events only; the per-share `views` counter and viewer map must move too. This piggybacks one `/share-stat` call on the existing beacon flush (no extra KV writes).
**Locate:**
```js
  if (!records.length) return json({ ok: true });
  if (env.LIVE_TRACKER) {
    await Promise.all(
      records.map((record) =>
        liveStub(env)
          .fetch("https://live.internal/event", {
```
**Action:** REPLACE
**Old code:**
```js
  if (!records.length) return json({ ok: true });
  if (env.LIVE_TRACKER) {
    await Promise.all(
      records.map((record) =>
        liveStub(env)
          .fetch("https://live.internal/event", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ record }),
          })
          .catch(() => {}),
      ),
    );
  } else {
    await mergeEventsKV(env, records);
  }
  return json({ ok: true });
}
```
**New code:**
```js
  if (!records.length) return json({ ok: true });
  if (env.LIVE_TRACKER) {
    await Promise.all(
      records.map((record) =>
        liveStub(env)
          .fetch("https://live.internal/event", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ record }),
          })
          .catch(() => {}),
      ),
    );
    if (viewEvents.length || viewer?.email) {
      await liveStub(env)
        .fetch("https://live.internal/share-stat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            slug,
            views: viewEvents.length,
            viewer: viewer ? { email: viewer.email, name: viewer.name || "" } : null,
          }),
        })
        .catch(() => {});
    }
  } else {
    await mergeEventsKV(env, records);
    if (viewEvents.length || viewer?.email) {
      await bumpShareStats(env, slug, {
        views: viewEvents.length,
        viewers: viewer?.email ? { [viewer.email]: { n: viewer.name || "", at: Date.now() } } : {},
      });
    }
  }
  return json({ ok: true });
}
```
**Verify:** Browsing a gallery while signed in increments `views` and adds the viewer to `sstats:{slug}.viewers` after the flush.

### Change 11: share opens record viewer identity + first-open flag (B6)
**File:** `src/share.js`
**Why:** "Recent viewers" needs opens to register identity too, and the Activity mockup shows "first open of this share".
**Locate:**
```js
  const viewer = await getViewer(request, env);
  const record = normalizeEvent({ type: "share-open", slug, label: share.label, uploader: viewer?.email || "" }, request);
  if (env.LIVE_TRACKER) {
    await liveStub(env)
      .fetch("https://live.internal/share-stat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, opens: 1, record }),
      })
      .catch(() => {});
  } else {
    await bumpShareStats(env, slug, { opens: 1, downloads: 0, bytes: 0 });
    await mergeEventsKV(env, [record]);
  }
```
**Action:** REPLACE
**Old code:**
```js
  const viewer = await getViewer(request, env);
  const record = normalizeEvent({ type: "share-open", slug, label: share.label, uploader: viewer?.email || "" }, request);
  if (env.LIVE_TRACKER) {
    await liveStub(env)
      .fetch("https://live.internal/share-stat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug, opens: 1, record }),
      })
      .catch(() => {});
  } else {
    await bumpShareStats(env, slug, { opens: 1, downloads: 0, bytes: 0 });
    await mergeEventsKV(env, [record]);
  }
```
**New code:**
```js
  const viewer = await getViewer(request, env);
  const stats = normalizeShareStats(await env.KV.get(`sstats:${slug}`, "json"));
  const first = !!viewer?.email && !stats.viewers[viewer.email];
  const record = normalizeEvent(
    { type: "share-open", slug, label: share.label, uploader: viewer?.email || "", message: first ? "first open" : "" },
    request
  );
  if (env.LIVE_TRACKER) {
    await liveStub(env)
      .fetch("https://live.internal/share-stat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          opens: 1,
          viewer: viewer ? { email: viewer.email, name: viewer.name || "" } : null,
          record,
        }),
      })
      .catch(() => {});
  } else {
    await bumpShareStats(env, slug, {
      opens: 1,
      downloads: 0,
      bytes: 0,
      viewers: viewer?.email ? { [viewer.email]: { n: viewer.name || "", at: Date.now() } } : {},
    });
    await mergeEventsKV(env, [record]);
  }
```
**Verify:** First signed-in open of a share yields an activity event with `m: "first open"`; later opens do not.

### Change 12: download stat bumps carry viewer identity
**File:** `src/share.js`
**Why:** Downloads should also refresh the viewer map (mockup counts "unique viewers" across all interactions).
**Locate:**
```js
async function bumpDownloadStats(env, share, request, fileName, bytes, viewer) {
  const record = normalizeEvent({ type: "share-dl", slug: share.slug, label: share.label, file: fileName, bytes, uploader: viewer?.email || "" }, request);
  if (env.LIVE_TRACKER) {
    liveStub(env)
      .fetch("https://live.internal/share-stat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: share.slug, downloads: 1, bytes, record }),
      })
      .catch(() => {});
  } else {
    await bumpShareStats(env, share.slug, { opens: 0, downloads: 1, bytes });
    await mergeEventsKV(env, [record]);
  }
}
```
**Action:** REPLACE
**Old code:**
```js
async function bumpDownloadStats(env, share, request, fileName, bytes, viewer) {
  const record = normalizeEvent({ type: "share-dl", slug: share.slug, label: share.label, file: fileName, bytes, uploader: viewer?.email || "" }, request);
  if (env.LIVE_TRACKER) {
    liveStub(env)
      .fetch("https://live.internal/share-stat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: share.slug, downloads: 1, bytes, record }),
      })
      .catch(() => {});
  } else {
    await bumpShareStats(env, share.slug, { opens: 0, downloads: 1, bytes });
    await mergeEventsKV(env, [record]);
  }
}
```
**New code:**
```js
async function bumpDownloadStats(env, share, request, fileName, bytes, viewer) {
  const record = normalizeEvent({ type: "share-dl", slug: share.slug, label: share.label, file: fileName, bytes, uploader: viewer?.email || "" }, request);
  if (env.LIVE_TRACKER) {
    liveStub(env)
      .fetch("https://live.internal/share-stat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug: share.slug,
          downloads: 1,
          bytes,
          viewer: viewer ? { email: viewer.email, name: viewer.name || "" } : null,
          record,
        }),
      })
      .catch(() => {});
  } else {
    await bumpShareStats(env, share.slug, {
      opens: 0,
      downloads: 1,
      bytes,
      viewers: viewer?.email ? { [viewer.email]: { n: viewer.name || "", at: Date.now() } } : {},
    });
    await mergeEventsKV(env, [record]);
  }
}
```
**Verify:** Downloading a file as a signed-in viewer updates `viewers[email].at`.

### Change 13: `adminShare` DTO exposes viewerCount + recentViewers
**File:** `src/share.js`
**Why:** Plan 07's share cards render "3 unique viewers", "64 file views" and viewer avatar chips from `GET /api/admin/shares` / `GET /api/admin/overview` without extra requests.
**Locate:**
```js
export function adminShare(share, stats = {}) {
  return {
    slug: share.slug,
    label: share.label,
    mode: share.mode,
```
**Action:** REPLACE
**Old code:**
```js
export function adminShare(share, stats = {}) {
  return {
    slug: share.slug,
    label: share.label,
    mode: share.mode,
    folderIds: share.folderIds || [],
    folderNames: share.folderNames || [],
    hasPin: !!share.pinHash,
    allowZip: share.allowZip !== false,
    requireAuth: share.requireAuth !== false,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt || null,
    disabled: !!share.disabled,
    state: shareState(share),
    stats: normalizeShareStats(stats),
    url: `/s/${share.slug}`,
  };
}
```
**New code:**
```js
export function adminShare(share, stats = {}) {
  const s = normalizeShareStats(stats);
  const recentViewers = Object.entries(s.viewers)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
    .slice(0, 6)
    .map(([email, v]) => ({ email, name: v.n || "" }));
  return {
    slug: share.slug,
    label: share.label,
    mode: share.mode,
    folderIds: share.folderIds || [],
    folderNames: share.folderNames || [],
    hasPin: !!share.pinHash,
    allowZip: share.allowZip !== false,
    requireAuth: share.requireAuth !== false,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt || null,
    disabled: !!share.disabled,
    state: shareState(share),
    stats: { opens: s.opens, downloads: s.downloads, bytes: s.bytes, views: s.views },
    viewerCount: Object.keys(s.viewers).length,
    recentViewers,
    url: `/s/${share.slug}`,
  };
}
```
**Verify:** `GET /api/admin/shares` returns `stats.views`, `viewerCount`, `recentViewers` per share (0/empty for old shares). The full `viewers` email map is NOT exposed beyond the top-6 recent list.

**Consuming frontend (plan 07):** no new fetch calls — the existing `overview.shares` / `/api/admin/shares` payload now carries the fields.

---

## B4 — Activity history: day buckets + "load earlier days" endpoint

### Change 14: `mergeEventsKV` also writes day buckets
**File:** `src/store.js`
**Why:** Both the DO flush and the no-DO fallback funnel through `mergeEventsKV`, so this is the single place where events also land in per-day KV keys for pagination.
**Locate:**
```js
export async function mergeEventsKV(env, records) {
  const existing = (await env.KV.get("events:recent", "json")) || [];
  const merged = [...records, ...existing].sort((a, b) => b.at - a.at).slice(0, EVENT_CAP);
  await env.KV.put("events:recent", JSON.stringify(merged));
}
```
**Action:** REPLACE
**Old code:**
```js
export async function mergeEventsKV(env, records) {
  const existing = (await env.KV.get("events:recent", "json")) || [];
  const merged = [...records, ...existing].sort((a, b) => b.at - a.at).slice(0, EVENT_CAP);
  await env.KV.put("events:recent", JSON.stringify(merged));
}
```
**New code:**
```js
export async function mergeEventsKV(env, records) {
  const existing = (await env.KV.get("events:recent", "json")) || [];
  const merged = [...records, ...existing].sort((a, b) => b.at - a.at).slice(0, EVENT_CAP);
  await env.KV.put("events:recent", JSON.stringify(merged));

  // Day buckets for "load earlier days": one KV key per calendar day, capped
  // like the rolling key and expired after 90 days. Batched flushes mean this
  // costs one extra write per flush, not per event.
  const byDay = new Map();
  for (const r of records) {
    const day = dayKey(r.at || Date.now());
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  for (const [day, batch] of byDay) {
    const key = `events:day:${day}`;
    const cur = (await env.KV.get(key, "json")) || [];
    const next = [...batch, ...cur].sort((a, b) => b.at - a.at).slice(0, EVENT_CAP);
    await env.KV.put(key, JSON.stringify(next), { expirationTtl: 90 * 86400 });
  }
}
```
**Verify:** After any event flush, `events:day:<today>` exists in KV alongside `events:recent`; `npm test`.

### Change 14a: import `dayKey` in the event store
**File:** `src/store.js`
**Why:** Change 14 calls the existing date-key helper.
**Locate:**
```js
  cleanText,
  clientIp,
  json,
  makePinFields,
  normalizeEvent,
```
**Action:** REPLACE
**Old code:**
```js
  cleanText,
  clientIp,
  json,
  makePinFields,
  normalizeEvent,
```
**New code:**
```js
  cleanText,
  clientIp,
  dayKey,
  json,
  makePinFields,
  normalizeEvent,
```
**Verify:** `src/store.js` resolves `dayKey` from `./util.js`; `npm test` has no undefined identifier.

### Change 15: admin route for older days
**File:** `src/worker.js`
**Why:** The Activity tab's "load earlier days" button pages backwards through day buckets.
**Locate:**
```js
    if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
    if (!sameOriginOk(request, url)) return json({ error: "bad origin" }, 403);
    if (m === "GET" && p === "/api/admin/overview") return adminOverview(env);
    if (m === "GET" && p === "/api/admin/timeseries") return adminTimeseries(env, url);
    if (m === "GET" && p === "/api/admin/links") return listLinks(env);
    if (m === "POST" && p === "/api/admin/links") return createLink(request, env, ctx);
    if (m === "POST" && p === "/api/admin/live/close") return closeLiveSession(request, env);
```
**Action:** INSERT AFTER
**New code:**
```js
    if (m === "GET" && p === "/api/admin/events") return adminEvents(env, url);
```
**Verify:** Route responds (after Change 16).

### Change 16: `adminEvents` handler
**File:** `src/worker.js`
**Why:** Implementation for Change 15.
**Locate:**
```js
async function adminTimeseries(env, url) {
  if (!env.LIVE_TRACKER) return json({ rows: [] });
  const days = clamp(Number(url.searchParams.get("days")) || 30, 1, 120);
  const slug = cleanText(url.searchParams.get("slug") || "", 66);
  const res = await liveStub(env).fetch(`https://live.internal/timeseries?days=${days}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}`);
  if (!res.ok) return json({ rows: [] });
  return json(await res.json());
}
```
**Action:** INSERT AFTER
**New code:**
```js

// Older activity, one KV read per calendar day. `before` is an exclusive
// YYYY-MM-DD upper bound (defaults to today); `days` is how many earlier
// days to return. The rolling events:recent key still serves the fresh view.
async function adminEvents(env, url) {
  const beforeRaw = cleanText(url.searchParams.get("before") || "", 10);
  const before = /^\d{4}-\d{2}-\d{2}$/.test(beforeRaw) ? beforeRaw : dayKey(Date.now());
  const days = clamp(Number(url.searchParams.get("days")) || 3, 1, 14);
  const start = new Date(`${before}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return json({ error: "bad before date" }, 400);
  const out = [];
  for (let i = 1; i <= days; i++) {
    const day = dayKey(start - i * 86400_000);
    const events = (await env.KV.get(`events:day:${day}`, "json")) || [];
    out.push({ day, events });
  }
  return json({ days: out, oldest: out.length ? out[out.length - 1].day : before });
}
```
**Verify:** `GET /api/admin/events?days=2` (admin cookie) returns `{days:[{day,events},{day,events}], oldest}`.

### Change 16a: import `dayKey` in the Worker router
**File:** `src/worker.js`
**Why:** Change 16 calculates day bucket keys.
**Locate:**
```js
  clamp,
  cleanText,
  clientIp,
  escapeHtml,
  getCookie,
```
**Action:** REPLACE
**Old code:**
```js
  clamp,
  cleanText,
  clientIp,
  escapeHtml,
  getCookie,
```
**New code:**
```js
  clamp,
  cleanText,
  clientIp,
  dayKey,
  escapeHtml,
  getCookie,
```
**Verify:** `adminEvents()` resolves `dayKey`; `npm test` has no import error.

**Consuming frontend (plan 04):**
```js
const r = await fetch(`/api/admin/events?before=${encodeURIComponent(oldestDay)}&days=3`);
const d = await r.json().catch(() => ({ days: [] }));
// append d.days to the activity view; next click passes d.oldest as `before`.
```

---

## B5 — Drive folder picker

### Change 17: Drive child-folder listing helper
**File:** `src/drive.js`
**Why:** The new-link flow needs to browse Drive folders instead of pasting IDs. Style-matched to `driveFindFolder`.
**Locate:**
```js
export async function driveFileMeta(env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return null;
  const tok = await accessToken(env);
  const url = `https://www.googleapis.com/drive/v3/files/${id}?` + new URLSearchParams({
    fields: "id,name,size,mimeType,parents,appProperties,thumbnailLink,webViewLink,iconLink",
    supportsAllDrives: "true",
```
**Action:** INSERT BEFORE
**New code:**
```js
// Child folders of a parent (default: Drive root), for the admin folder picker.
export async function driveListFolders(env, parentId) {
  const parent = String(parentId || "root").replace(/[^a-zA-Z0-9_-]/g, "") || "root";
  const tok = await accessToken(env);
  const url =
    "https://www.googleapis.com/drive/v3/files?" +
    new URLSearchParams({
      q: `mimeType='application/vnd.google-apps.folder' and trashed=false and '${driveQueryEscape(parent)}' in parents`,
      fields: "files(id,name)",
      pageSize: "100",
      orderBy: "name",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error("Drive folder list failed: " + (await r.text()).slice(0, 300));
  const d = await r.json();
  return (d.files || []).map((f) => ({ id: f.id, name: f.name }));
}

```
**Verify:** Function exists; exercised via Change 18.

### Change 18: admin route + handler for the picker
**File:** `src/worker.js`
**Why:** Expose the listing, admin-gated, matching the flat route style.
**Locate:**
```js
      return listUploads(env, p.slice("/api/admin/uploads/".length), url);
    }
    if (m === "GET" && p.startsWith("/api/admin/thumb/")) {
      return driveThumbMeta(env, p.slice("/api/admin/thumb/".length));
    }
  }
  return json({ error: "not found" }, 404);
```
**Action:** REPLACE
**Old code:**
```js
    if (m === "GET" && p.startsWith("/api/admin/thumb/")) {
      return driveThumbMeta(env, p.slice("/api/admin/thumb/".length));
    }
```
**New code:**
```js
    if (m === "GET" && p.startsWith("/api/admin/thumb/")) {
      return driveThumbMeta(env, p.slice("/api/admin/thumb/".length));
    }
    if (m === "GET" && p === "/api/admin/drive/folders") {
      if (!env.GOOGLE_CLIENT_ID) return json({ folders: [] });
      const parent = cleanText(url.searchParams.get("parent") || "root", 80);
      try {
        return json({ folders: await driveListFolders(env, parent) });
      } catch (err) {
        return json({ error: err.message }, 502);
      }
    }
```
**Verify:** `GET /api/admin/drive/folders` (admin cookie) returns `{folders:[{id,name},…]}` of Drive-root folders; `?parent=<folderId>` descends.

### Change 18a: import the Drive folder-list helper
**File:** `src/worker.js`
**Why:** Change 18 calls the helper added in Change 17.
**Locate:**
```js
  timingSafeEqual,
} from "./util.js";
import { accessToken, driveFileMeta, driveQuota, ensureLinkFolderDirect, quotaFree, resolvePathFolderDirect, resolveUploaderFolderDirect } from "./drive.js";
import { bumpStats, gatePin, getUploads, liveProgress, liveSnapshot, liveStub, logEvent, mergeEventsKV, rateLimitRemote, recentEvents, recordCompletion, sendNotify } from "./store.js";
import {
  adminShare,
  createShareZipTicket,
```
**Action:** REPLACE
**Old code:**
```js
import { accessToken, driveFileMeta, driveQuota, ensureLinkFolderDirect, quotaFree, resolvePathFolderDirect, resolveUploaderFolderDirect } from "./drive.js";
```
**New code:**
```js
import { accessToken, driveFileMeta, driveListFolders, driveQuota, ensureLinkFolderDirect, quotaFree, resolvePathFolderDirect, resolveUploaderFolderDirect } from "./drive.js";
```
**Verify:** `driveListFolders` is imported exactly once and the Worker module parses.

**Consuming frontend (plan 05, new-link step 1):**
```js
const r = await fetch(`/api/admin/drive/folders?parent=${encodeURIComponent(parentId || "root")}`);
const d = await r.json().catch(() => ({ folders: [] }));
// render d.folders as a drill-down list; picking one fills the existing folder input with its id.
```

---

## B9 + B10 — Public collector display name + safe budget-hit flag

The Drop-page mockup says “Ghanishth is collecting”, but the current public DTO contains no owner identity. Do not hard-code that mockup name. This personal deployment gets one explicit environment value, and the frontend uses a truthful generic fallback when it is blank.

### Change 19: Document the owner display-name variable
**File:** `wrangler.example.jsonc`
**Why:** Deployments need one real, non-secret source for the public collector name.
**Locate:**
```jsonc
    }
  ],
  "vars": {
    "DRIVE_PARENT_ID": "REPLACE_WITH_OPTIONAL_PARENT_FOLDER_ID",
    "LINK_SLUGS": "comma,separated,existing,slugs",
    // Optional: Cloudflare Web Analytics beacon token (Worker injects it).
    "CF_BEACON_TOKEN": "",
```
**Action:** REPLACE
**Old code:**
```jsonc
  "vars": {
    "DRIVE_PARENT_ID": "REPLACE_WITH_OPTIONAL_PARENT_FOLDER_ID",
    "LINK_SLUGS": "comma,separated,existing,slugs",
    // Optional: Cloudflare Web Analytics beacon token (Worker injects it).
```
**New code:**
```jsonc
  "vars": {
    "DRIVE_PARENT_ID": "REPLACE_WITH_OPTIONAL_PARENT_FOLDER_ID",
    "LINK_SLUGS": "comma,separated,existing,slugs",
    // Public non-secret name shown as “<name> is collecting” on /d/ pages.
    "OWNER_DISPLAY_NAME": "REPLACE_WITH_OWNER_DISPLAY_NAME",
    // Optional: Cloudflare Web Analytics beacon token (Worker injects it).
```
**Verify:** The example configuration documents the value without placing it in code or a secret store.

### Change 20: Expose the configured name in the public link DTO
**File:** `src/worker.js`
**Why:** The uploader page needs real owner identity and must not copy the mockup sample name.
**Locate:**
```js
function publicLink(link, quota) {
  const state = linkState(link);
  const free = quotaFree(quota);
  return {
    slug: link.slug,
```
**Action:** REPLACE
**Old code:**
```js
function publicLink(link, quota) {
  const state = linkState(link);
  const free = quotaFree(quota);
  return {
    slug: link.slug,
    label: link.label,
    requiresPin: !!link.pinHash,
    expiresAt: link.expiresAt || null,
    expired: state === "expired",
    paused: state === "paused",
    state,
    settings: normalizeSettings(link.settings),
    theme: normalizeTheme(link.theme),
    appName: APP_NAME,
    // Rounded to whole GB so guests see headroom without precise account info.
    driveFreeGB: free != null ? Math.floor(free / 1024 ** 3) : null,
  };
}
```
**New code:**
```js
function publicLink(link, quota, env) {
  const state = linkState(link);
  const free = quotaFree(quota);
  return {
    slug: link.slug,
    label: link.label,
    ownerName: cleanText(env.OWNER_DISPLAY_NAME || "", 60),
    requiresPin: !!link.pinHash,
    expiresAt: link.expiresAt || null,
    expired: state === "expired",
    paused: state === "paused",
    budgetHit: state === "paused" && /^(byte|file|session) budget reached$/.test(link.disabledReason || ""),
    state,
    settings: normalizeSettings(link.settings),
    theme: normalizeTheme(link.theme),
    appName: APP_NAME,
    // Rounded to whole GB so guests see headroom without precise account info.
    driveFreeGB: free != null ? Math.floor(free / 1024 ** 3) : null,
  };
}
```
**Verify:** The DTO contains a maximum-60-character `ownerName`; blank configuration produces `""`, not a fabricated person. `budgetHit` is true only for the three server-generated budget reasons and does not disclose arbitrary `disabledReason` text.

### Change 21: Pass Worker environment into the DTO builder
**File:** `src/worker.js`
**Why:** Complete Change 20 without adding another endpoint or KV read.
**Locate:**
```js
async function getPublicLink(env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const quota = env.GOOGLE_CLIENT_ID ? await driveQuota(env) : null;
  return json(publicLink(link, quota));
}
```
**Action:** REPLACE
**Old code:**
```js
async function getPublicLink(env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const quota = env.GOOGLE_CLIENT_ID ? await driveQuota(env) : null;
  return json(publicLink(link, quota));
}
```
**New code:**
```js
async function getPublicLink(env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const quota = env.GOOGLE_CLIENT_ID ? await driveQuota(env) : null;
  return json(publicLink(link, quota, env));
}
```
**Verify:** `GET /api/link/:slug` returns the configured `ownerName`; no new route, storage record, or frontend constant is needed.

**Consuming frontend (plan 08):** `link.ownerName ? `${link.ownerName} is collecting` : "Your files are being collected"`.

---

## Responsive
Not applicable — backend only.

## Placeholder data
None. Mockup numbers (e.g. "3 unique viewers", "64 file views", "38 MB/s") are placeholders that these endpoints now supply for real: `viewerCount`/`stats.views` (B3), `speedHist` (B1), `recent` finished sessions (B2), `days[].events` (B4), and `folders` (B5). The mockup collector name is replaced by configured `ownerName` (B9), and the initial amber state uses server-derived `budgetHit` (B10).

## Post-plan verification (whole file)
1. `npm test` (runs `scripts/smoke-test.mjs`) — must pass; the no-DO fallback branches changed in store.js/share.js are the ones tests exercise.
2. `npx wrangler dev` → open `/admin`, confirm overview/links/shares/activity still render.
3. Exercise: open a share while signed in → check `sstats:` gains viewer; upload a file → finish → WS snapshot contains `recent` entry; `GET /api/admin/events?days=1` returns today-1 bucket (empty array is fine).
