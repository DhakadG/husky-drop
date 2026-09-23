// KV-backed state: stats, events, upload history, PIN gating with lockouts,
// notifications, and relays into the LiveTracker Durable Object.
//
// KV write budget rule: request handlers never write hot-path keys directly.
// With a DO bound, events/opens/completions are batched there and flushed by
// its alarm; the direct-write branches below only run without a DO (tests).

import {
  EVENT_CAP,
  LOCK_ATTEMPTS,
  LOCK_BASE_SECONDS,
  LOCK_MAX_SECONDS,
  RECENT_CAP,
  cleanText,
  clientIp,
  dayKey,
  escapeHtml,
  extractClientInfo,
  fmtBytesServer,
  json,
  makePinFields,
  normalizeEvent,
  normalizeShareStats,
  normalizeStats,
  pinMatches,
  retryJson,
  sha256,
} from "./util.js";
import { driveUploadsForLink } from "./drive.js";
import { getViewer } from "./auth.js";

export function liveStub(env) {
  return env.LIVE_TRACKER.get(env.LIVE_TRACKER.idFromName("global"));
}

export async function rateLimitRemote(env, key, max, windowSec) {
  if (!env.LIVE_TRACKER) return { allowed: true, retryAfter: 0 };
  try {
    const res = await liveStub(env).fetch("https://live.internal/ratelimit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, max, windowSec }),
    });
    return await res.json();
  } catch {
    return { allowed: true, retryAfter: 0 };
  }
}

export async function liveSnapshot(env) {
  if (!env.LIVE_TRACKER) return [];
  const res = await liveStub(env).fetch("https://live.internal/snapshot");
  if (!res.ok) return [];
  const d = await res.json();
  return d.active || [];
}

export async function liveProgress(env, session) {
  if (!env.LIVE_TRACKER) return;
  await liveStub(env).fetch("https://live.internal/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(session),
  });
}

export async function liveShareStats(env) {
  const rows = new Map();
  if (!env.LIVE_TRACKER) return rows;
  try {
    const response = await liveStub(env).fetch("https://live.internal/share-stats");
    if (!response.ok) return rows;
    const data = await response.json();
    for (const row of data.rows || []) if (row?.slug) rows.set(row.slug, row);
  } catch (error) {
    console.error("share stats SQLite read failed", String(error?.message || error));
  }
  return rows;
}

// Raw click/performance telemetry is high-volume and must never consume the
// global KV write allowance. The Durable Object persists it in its own SQLite
// storage; if analytics storage is unavailable, the user-facing request still
// succeeds and the batch is intentionally dropped.
export async function storeTelemetry(env, batch) {
  if (!env.LIVE_TRACKER) return false;
  try {
    const body = JSON.stringify(batch);
    if (body.length > 64 * 1024) return false;
    const response = await liveStub(env).fetch("https://live.internal/telemetry", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    return response.ok;
  } catch (error) {
    console.error("telemetry storage unavailable", String(error?.message || error));
    return false;
  }
}

export async function bumpStats(env, slug, delta) {
  const key = `stats:${slug}`;
  const stats = normalizeStats(await env.KV.get(key, "json"));
  for (const [k, v] of Object.entries(delta)) stats[k] = (stats[k] || 0) + Number(v || 0);
  await env.KV.put(key, JSON.stringify(stats));
  return stats;
}

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

// All events flow into a single rolling KV key (`events:recent`) instead of
// one KV key per event: the old ev:* scheme needed KV.list on every dashboard
// poll and one write per event, which busts the free tier's 1k writes/day and
// 1k lists/day caps.
export async function logEvent(env, event, request) {
  if (!event.email && request?.headers && env?.GOOGLE_CLIENT_ID) {
    try {
      const viewer = await getViewer(request, env);
      if (viewer?.email) event = { ...event, email: viewer.email };
    } catch {}
  }
  const record = normalizeEvent(event, request);
  if (env.LIVE_TRACKER) {
    await liveStub(env)
      .fetch("https://live.internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ record }),
      })
      .catch(() => {});
    return;
  }
  await mergeEventsKV(env, [record]);
}

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

export async function recentEvents(env, limit = 60) {
  if (env.LIVE_TRACKER) {
    try {
      const response = await liveStub(env).fetch(`https://live.internal/events?limit=${Math.max(1, Math.min(EVENT_CAP, Number(limit) || 60))}`);
      if (response.ok) {
        const data = await response.json();
        if (Array.isArray(data.events)) return data.events.slice(0, limit);
      }
    } catch (error) {
      console.error("activity SQLite read failed", String(error?.message || error));
    }
  }
  const rows = await env.KV.get("events:recent", "json");
  if (rows) return rows.slice(0, limit);
  // One-time lazy migration from the legacy ev:* key-per-event layout.
  const events = [];
  try {
    const page = await env.KV.list({ prefix: "ev:", limit: Math.min(100, limit) });
    for (const k of page.keys) {
      const ev = await env.KV.get(k.name, "json");
      if (ev) events.push(ev);
      if (events.length >= limit) break;
    }
    await env.KV.put("events:recent", JSON.stringify(events));
  } catch (err) {
    console.error("event migration failed", err.message);
  }
  return events;
}

// ---- Upload history ----

export async function getUploads(env, slug, fresh = false) {
  if (fresh) {
    const drive = await driveUploadsForLink(env, slug);
    if (drive.length) {
      await env.KV.put(`recent:${slug}`, JSON.stringify(drive.slice(0, RECENT_CAP)));
      return drive;
    }
  }
  const recent = await getRecentUploads(env, slug);
  if (recent.length) return recent;
  return await driveUploadsForLink(env, slug);
}

export async function getRecentUploads(env, slug) {
  const rows = (await env.KV.get(`recent:${slug}`, "json")) || [];
  return rows.sort((a, b) => b.at - a.at);
}

export async function addRecentUpload(env, slug, meta) {
  const rows = await getRecentUploads(env, slug);
  const next = [meta, ...rows.filter((u) => u.f !== meta.f)].slice(0, RECENT_CAP);
  await env.KV.put(`recent:${slug}`, JSON.stringify(next));
}

// ---- PIN gate with per-IP lockouts + per-link global damping ----

async function bruteKey(slug, request) {
  return `bf:${slug}:${await sha256(clientIp(request))}`;
}

async function currentLock(env, slug, request) {
  const key = await bruteKey(slug, request);
  const state = (await env.KV.get(key, "json")) || { attempts: 0, level: 0, lockedUntil: 0 };
  if (state.lockedUntil && state.lockedUntil > Date.now()) {
    return { key, state, retryAfter: Math.ceil((state.lockedUntil - Date.now()) / 1000) };
  }
  return { key, state, retryAfter: 0 };
}

async function currentGlobalLock(env, slug) {
  const key = `bfg:${slug}`;
  const state = (await env.KV.get(key, "json")) || {
    attempts: 0,
    windowStart: Date.now(),
    lockedUntil: 0,
  };
  if (state.lockedUntil && state.lockedUntil > Date.now()) {
    return { key, state, retryAfter: Math.ceil((state.lockedUntil - Date.now()) / 1000) };
  }
  return { key, state, retryAfter: 0 };
}

// Counting every wrong PIN in KV spent two writes per attempt of attacker
// traffic, enough to exhaust the daily write budget app-wide. With the
// Durable Object bound, its in-memory buckets count the attempts and KV is
// written only when a lockout starts. The level / generation leads the key
// so the 120-char bucket key can never truncate it away.
async function pinFailureTripped(env, key, max, windowSec) {
  return !(await rateLimitRemote(env, key, max, windowSec)).allowed;
}

async function recordGlobalPinFailure(env, link, request) {
  const { key, state } = await currentGlobalLock(env, link.slug);
  const now = Date.now();
  if (env.LIVE_TRACKER) {
    const gen = state.gen || 0;
    if (!(await pinFailureTripped(env, `pg${gen}:${link.slug}`, 60, 3600))) return 0;
    await logEvent(env, { type: "global-lock", slug: link.slug, label: link.label, message: "Global PIN damping started" }, request);
    await env.KV.put(key, JSON.stringify({ gen: gen + 1, lockedUntil: now + 600_000 }), { expirationTtl: 2 * 3600 });
    return 600;
  }
  const windowStart = now - (state.windowStart || 0) > 3600_000 ? now : state.windowStart || now;
  const attempts = windowStart === now ? 1 : (state.attempts || 0) + 1;
  const next = { attempts, windowStart, lockedUntil: 0 };
  let retryAfter = 0;
  if (attempts > 60) {
    retryAfter = 10 * 60;
    next.attempts = 0;
    next.windowStart = now;
    next.lockedUntil = now + retryAfter * 1000;
    await logEvent(
      env,
      { type: "global-lock", slug: link.slug, label: link.label, message: "Global PIN damping started" },
      request
    );
  }
  await env.KV.put(key, JSON.stringify(next), { expirationTtl: 2 * 3600 });
  return retryAfter;
}

async function recordPinFailure(env, slug, request) {
  const { key, state } = await currentLock(env, slug, request);
  const level = state.level || 0;
  if (env.LIVE_TRACKER) {
    if (!(await pinFailureTripped(env, `p${level}:${key.slice(3)}`, LOCK_ATTEMPTS - 1, 24 * 3600))) return 0;
    const retryAfter = Math.min(LOCK_MAX_SECONDS, LOCK_BASE_SECONDS * 2 ** level);
    await logEvent(env, { type: "lock", slug, message: "PIN lockout started" }, request);
    await env.KV.put(key, JSON.stringify({ attempts: 0, level: level + 1, lockedUntil: Date.now() + retryAfter * 1000 }), { expirationTtl: 24 * 3600 });
    return retryAfter;
  }
  const attempts = (state.attempts || 0) + 1;
  const next = { attempts, level, lockedUntil: 0 };
  let retryAfter = 0;
  if (attempts >= LOCK_ATTEMPTS) {
    retryAfter = Math.min(LOCK_MAX_SECONDS, LOCK_BASE_SECONDS * 2 ** level);
    next.attempts = 0;
    next.level = level + 1;
    next.lockedUntil = Date.now() + retryAfter * 1000;
    await logEvent(env, { type: "lock", slug, message: "PIN lockout started" }, request);
  }
  await env.KV.put(key, JSON.stringify(next), { expirationTtl: 24 * 3600 });
  return retryAfter;
}

async function clearPinFailures(env, slug, request) {
  await env.KV.delete(await bruteKey(slug, request));
}

async function upgradePinHash(env, keyPrefix, link, pin) {
  if (link.pinAlgo === "pbkdf2" || !link.pinHash) return;
  try {
    Object.assign(link, await makePinFields(pin));
    await env.KV.put(`${keyPrefix}${link.slug}`, JSON.stringify(link));
  } catch (err) {
    console.error("pin upgrade failed", err.message);
  }
}

// Works for drop links AND share links: pass a keyPrefix ("link:"/"share:")
// so a successful legacy PIN entry re-hashes the right KV object, and a
// bruteSlug so lockout counters never collide across the two namespaces.
export async function gatePin(request, env, link, pin, keyPrefix = "link:", bruteSlug = null) {
  if (!link.pinHash) return null;
  const slug = bruteSlug || link.slug;
  const globalLock = await currentGlobalLock(env, slug);
  if (globalLock.retryAfter) return retryJson("too many attempts for this link", globalLock.retryAfter);
  const lock = await currentLock(env, slug, request);
  if (lock.retryAfter) return retryJson("too many wrong attempts", lock.retryAfter);
  if (await pinMatches(link, pin)) {
    // KV deletes count against the same write budget as puts. Most successful
    // checks have nothing to clear, so avoid a write on every folder change.
    if (lock.state.attempts || lock.state.level || lock.state.lockedUntil) {
      await clearPinFailures(env, slug, request).catch((error) =>
        console.error("PIN failure cleanup deferred", String(error?.message || error)),
      );
    }
    await upgradePinHash(env, keyPrefix, link, pin);
    return null;
  }
  const retryAfter = await recordPinFailure(env, slug, request);
  if (retryAfter) return retryJson("too many wrong attempts", retryAfter);
  const globalRetry = await recordGlobalPinFailure(env, { slug, label: link.label }, request);
  if (globalRetry) return retryJson("too many attempts for this link", globalRetry);
  return json({ error: "wrong PIN" }, 403);
}

// ---- Notifications ----

// One layout for every notification: headline, a facts table, an optional
// file list and a button into the dashboard. Real content matters for
// deliverability too - Gmail flagged the old two-line bodies as unsolicited.
// Returns { subject, html, text } ready for sendNotify.
export function notifyEmail({ subject, headline, facts = [], files = [], total = files.length, cta }) {
  const rows = facts
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#5b6b7f;white-space:nowrap;vertical-align:top;">${escapeHtml(k)}</td><td style="padding:6px 0;">${escapeHtml(String(v))}</td></tr>`)
    .join("");
  const shown = files.slice(0, 10);
  const more = total - shown.length;
  const list = shown.length
    ? `<p style="margin:18px 0 6px;font-weight:600;">Files</p><ul style="margin:0;padding-left:18px;color:#0c1a2b;">${shown
        .map((f) => `<li>${escapeHtml(f.n)} <span style="color:#9aa8b8;">${escapeHtml(fmtBytesServer(f.s))}</span></li>`)
        .join("")}${more > 0 ? `<li style="color:#9aa8b8;">and ${more} more</li>` : ""}</ul>`
    : "";
  const button = cta
    ? `<p style="margin:22px 0 0;"><a href="${escapeHtml(cta.href)}" style="display:inline-block;background:#2f6bff;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:600;">${escapeHtml(cta.label)}</a></p>`
    : "";
  const html = `<p style="margin:0 0 14px;font-size:16px;">${headline}</p><table style="border-collapse:collapse;font-size:14px;">${rows}</table>${list}${button}`;
  const text = [
    headline.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ({ amp: "&", lt: "<", gt: ">", quot: "\"", "#39": "'" })[e]),
    "",
    ...facts.filter(([, v]) => v).map(([k, v]) => `${k}: ${v}`),
    ...(shown.length ? ["", "Files:", ...shown.map((f) => `- ${f.n} (${fmtBytesServer(f.s)})`), ...(more > 0 ? [`- and ${more} more`] : [])] : []),
    ...(cta ? ["", `${cta.label}: ${cta.href}`] : []),
  ].join("\n");
  return { subject, html, text };
}

// Branded wrapper applied to every outgoing email so notifications match the
// blue dashboard theme. Body HTML is produced by trusted call sites only.
function emailTemplate(bodyHtml) {
  return `<!doctype html>
<html>
<body style="margin:0;padding:0;background:#eaf0f9;font-family:'Segoe UI',system-ui,-apple-system,sans-serif;">
  <div style="max-width:520px;margin:0 auto;padding:28px 16px;">
    <div style="background:linear-gradient(135deg,#2f6bff,#15c0c9);border-radius:16px 16px 0 0;padding:18px 24px;">
      <span style="color:#ffffff;font-size:16px;font-weight:700;letter-spacing:-0.01em;">losthusky<span style="opacity:.75">/</span>drop</span>
    </div>
    <div style="background:#ffffff;border-radius:0 0 16px 16px;padding:24px;color:#0c1a2b;font-size:14.5px;line-height:1.6;">
      ${bodyHtml}
    </div>
    <p style="color:#9aa8b8;font-size:11.5px;text-align:center;margin:14px 0 0;">
      Sent by LostHusky Drop because a link you created was used.
    </p>
  </div>
</body>
</html>`;
}

export async function sendNotify(env, msg) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_TO || !env.NOTIFY_FROM) return;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        "content-type": "application/json",
        ...(msg.idempotencyKey ? { "idempotency-key": msg.idempotencyKey } : {}),
      },
      body: JSON.stringify({
        from: env.NOTIFY_FROM,
        to: [env.NOTIFY_TO],
        reply_to: env.NOTIFY_REPLY_TO || undefined,
        subject: msg.subject,
        html: emailTemplate(msg.html),
        text: msg.text || msg.subject,
        tags: [{ name: "category", value: msg.category || "drop-notification" }],
      }),
    });
    if (!response.ok) {
      console.error("Resend rejected email", response.status, (await response.text()).slice(0, 300));
      return null;
    }
    return await response.json().catch(() => ({ ok: true }));
  } catch (error) {
    console.error("notify failed", error.message);
    return null;
  }
}

// Records a finished file. With a Durable Object bound, the write is batched
// there (see flushCompletions) so a big transfer costs a few KV writes total.
// Without one (e.g. unit tests) it falls back to immediate inline writes.
export async function recordCompletion(env, link, meta, request) {
  if (env.LIVE_TRACKER) {
    await liveStub(env)
      .fetch("https://live.internal/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: link.slug, label: link.label, meta, origin: request ? new URL(request.url).origin : "", client: extractClientInfo(request) }),
      })
      .catch((err) => console.error("completion relay failed", err.message));
    return;
  }
  const recent = await getRecentUploads(env, link.slug);
  const id = meta.f || `${meta.n}:${meta.at}`;
  const already = recent.some((u) => (u.f || `${u.n}:${u.at}`) === id);
  await addRecentUpload(env, link.slug, meta);
  if (already) return;
  await bumpStats(env, link.slug, { files: 1, bytes: meta.s });
  await logEvent(
    env,
    {
      type: "file",
      slug: link.slug,
      label: link.label,
      uploader: meta.u,
      file: meta.n,
      bytes: meta.s,
      count: 1,
      sessionId: meta.si,
    },
    request
  );
}
