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
  await env.KV.put(key, JSON.stringify(stats));
  return stats;
}

// All events flow into a single rolling KV key (`events:recent`) instead of
// one KV key per event: the old ev:* scheme needed KV.list on every dashboard
// poll and one write per event, which busts the free tier's 1k writes/day and
// 1k lists/day caps.
export async function logEvent(env, event, request) {
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
}

export async function recentEvents(env, limit = 60) {
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

async function recordGlobalPinFailure(env, link, request) {
  const { key, state } = await currentGlobalLock(env, link.slug);
  const now = Date.now();
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
  const attempts = (state.attempts || 0) + 1;
  const level = state.level || 0;
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
    await clearPinFailures(env, slug, request);
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
      Automated notification from LostHusky's DropBox
    </p>
  </div>
</body>
</html>`;
}

export async function sendNotify(env, msg) {
  if (!env.RESEND_API_KEY || !env.NOTIFY_TO || !env.NOTIFY_FROM) return;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.NOTIFY_FROM,
      to: [env.NOTIFY_TO],
      subject: msg.subject,
      html: emailTemplate(msg.html),
    }),
  }).catch((err) => console.error("notify failed", err.message));
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
        body: JSON.stringify({ slug: link.slug, label: link.label, meta }),
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
    },
    request
  );
}
