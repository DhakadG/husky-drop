// Public drop-link endpoints: link metadata, PIN checks, Drive resumable
// session minting, progress/completion relays and uploader telemetry. File
// bytes never pass through here - the browser talks to Drive directly.
import { appLog } from "./applog.js";

import {
  APP_NAME,
  QUOTA_RESERVE,
  cleanText,
  clientIp,
  escapeHtml,
  fmtBytesServer,
  extractClientInfo,
  json,
  linkState,
  normalizeEvent,
  normalizeNotify,
  normalizeSettings,
  normalizeStats,
  normalizeTheme,
  retryJson,
  sanitizeFilename,
  sanitizeRelPath,
} from "./util.js";
import {
  accessToken,
  driveFileMeta,
  driveQuota,
  ensureLinkFolderDirect,
  quotaFree,
  resolvePathFolderDirect,
  resolveUploaderFolderDirect,
} from "./drive.js";
import {
  bumpStats,
  gatePin,
  liveProgress,
  liveStub,
  logEvent,
  mergeEventsKV,
  notifyEmail,
  rateLimitRemote,
  recordCompletion,
  sendNotify,
  storeTelemetry,
} from "./store.js";
import { getViewer } from "./auth.js";

// ---- Folder resolution ----

async function resolveUploaderFolder(env, link, uploader) {
  if (!link.settings?.perUploaderFolders) return link.folderId;
  if (!env.LIVE_TRACKER) return resolveUploaderFolderDirect(env, link, uploader);
  const res = await liveStub(env).fetch("https://live.internal/folder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link, uploader }),
  });
  if (!res.ok) throw new Error("folder resolver failed");
  const d = await res.json();
  return d.folderId || link.folderId;
}

// Resolve the final Drive folder for a file, recreating the uploaded folder
// tree (relativePath directories) beneath the link / per-uploader folder.
async function resolveTargetFolder(env, link, uploader, segments) {
  if (!segments.length) return resolveUploaderFolder(env, link, uploader);
  if (!env.LIVE_TRACKER) return resolvePathFolderDirect(env, link, uploader, segments);
  const res = await liveStub(env).fetch("https://live.internal/pathfolder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ link, uploader, segments }),
  });
  if (!res.ok) throw new Error("folder resolver failed");
  const d = await res.json();
  return d.folderId || link.folderId;
}

// Lazy Drive folder creation for links returned instantly at create time.
export async function ensureLinkFolder(env, link) {
  if (link.folderId) return link.folderId;
  if (env.LIVE_TRACKER) {
    const res = await liveStub(env).fetch("https://live.internal/linkfolder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: link.slug }),
    });
    const d = await res.json().catch(() => ({}));
    if (res.ok && d.folderId) return d.folderId;
    throw new Error(d.error || "link folder create failed");
  }
  return ensureLinkFolderDirect(env, link.slug);
}

// Fire-and-forget side work (telemetry, live relays): the client only needs
// the ack, so finish it after the response when the runtime lets us.
function background(ctx, promise, what) {
  const guarded = promise.catch((err) => console.error(`${what} failed`, err.message));
  if (!ctx?.waitUntil) return guarded;
  ctx.waitUntil(guarded);
  return Promise.resolve();
}

// ponytail: isolate-local 30s cache; a batch of hundreds of photos preflighted
// one Drive quota call per file and could trip Google's per-user rate limit.
let quotaCache = { free: null, at: 0 };
async function cachedQuotaFree(env) {
  if (Date.now() - quotaCache.at < 30_000) return quotaCache.free;
  const free = quotaFree(await driveQuota(env));
  quotaCache = { free, at: Date.now() };
  return free;
}

// ---- Public drop-link endpoints ----

function publicLink(link, quota, env) {
  const state = linkState(link);
  const free = quotaFree(quota);
  return {
    slug: link.slug,
    label: link.label,
    ownerName: cleanText(env.OWNER_DISPLAY_NAME || "", 60),
    requiresPin: !!link.pinHash,
    pinDigits: link.pinDigits !== false,
    requiresAuth: !!link.requireAuth && !!env.GOOGLE_CLIENT_ID,
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


export async function getPublicLink(request, env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const quota = env.GOOGLE_CLIENT_ID ? await driveQuota(env) : null;
  const out = publicLink(link, quota, env);
  out.viewer = out.requiresAuth ? await getViewer(request, env) : null;
  return json(out);
}

async function requireDropViewer(request, env, link) {
  if (!link.requireAuth || !env.GOOGLE_CLIENT_ID) return null;
  if (await getViewer(request, env)) return null;
  return json({ error: "sign-in required", authRequired: true }, 401);
}

// When the link demands Google sign-in, the verified account name beats
// whatever the uploader typed into the "what should we call you" box.
async function resolveUploader(request, env, link, typed) {
  const viewer = link.requireAuth && env.GOOGLE_CLIENT_ID ? await getViewer(request, env) : null;
  return cleanText(viewer?.name || typed || "anonymous", 60) || "anonymous";
}

export async function verifyPin(request, env) {
  const b = await request.json().catch(() => ({}));
  const link = await env.KV.get(`link:${b.linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const state = linkState(link);
  if (state === "expired") return json({ error: "this link has expired" }, 410);
  if (state === "paused") return json({ error: "this link is paused" }, 403);
  const authFailure = await requireDropViewer(request, env, link);
  if (authFailure) return authFailure;
  const failure = await gatePin(request, env, link, b.pin);
  if (failure) return failure;
  return json({ ok: true });
}

export async function logOpened(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const link = await env.KV.get(`link:${b.linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  if (linkState(link) === "expired") return json({ error: "this link has expired" }, 410);
  const record = normalizeEvent({ type: "open", slug: link.slug, label: link.label }, request);
  const work = env.LIVE_TRACKER
    ? liveStub(env).fetch("https://live.internal/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: link.slug, record }),
      })
    : bumpStats(env, link.slug, { opens: 1 }).then(() => mergeEventsKV(env, [record]));
  await background(ctx, work, "open relay");
  return json({ ok: true });
}

export async function logProgress(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const link = await env.KV.get(`link:${b.linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  if (linkState(link) === "expired") return json({ error: "this link has expired" }, 410);
  const authFailure = await requireDropViewer(request, env, link);
  if (authFailure) return authFailure;
  const failure = await gatePin(request, env, link, b.pin);
  if (failure) return failure;
  // Session dedupe, budgets and digests all key off sessionId; a silent
  // per-tick fallback would turn a client regression into phantom sessions.
  const sessionId = cleanText(b.sessionId || "", 80);
  if (!sessionId) return json({ error: "sessionId required" }, 400);
  const uploader = cleanText(b.uploader || "anonymous", 60);
  // Independent DO calls: run together, and after the ack where possible.
  const relay = Promise.all([
    recordSessionStart(env, link, uploader, sessionId, request),
    liveProgress(env, {
      type: "progress",
      sessionId,
      slug: link.slug,
      label: link.label,
      uploader,
      sent: b.sent,
      total: b.total,
      files: b.files,
      state: b.final ? "done" : "uploading",
    }),
  ]);
  await background(ctx, relay, "progress relay");
  return json({ ok: true });
}

export async function createSession(request, env) {
  const b = await request.json().catch(() => ({}));
  const { linkId, pin, filename, size, mimeType, uploaderName, relativePath, queueCount, queueBytes } = b;
  const sessionId = cleanText(b.sessionId || "", 80);

  if (!linkId || !filename || !sessionId || !Number.isFinite(size) || size <= 0) {
    return json({ error: "linkId, filename, size and sessionId are required" }, 400);
  }
  const link = await env.KV.get(`link:${linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const state = linkState(link);
  if (state === "expired") return json({ error: "this link has expired" }, 410);
  if (state === "paused") return json({ error: "this link is paused" }, 403);
  const authFailure = await requireDropViewer(request, env, link);
  if (authFailure) return authFailure;
  const failure = await gatePin(request, env, link, pin);
  if (failure) return failure;

  const settings = normalizeSettings(link.settings);
  if (size > settings.maxTransferBytes) return json({ error: "file too large for this link" }, 413);

  // Budget checks (0 = unlimited). Crossing a budget pauses the link so a
  // leaked URL cannot silently fill the whole Drive.
  if (settings.maxTotalBytes || settings.maxTotalFiles || settings.maxSessions) {
    const stats = normalizeStats(await env.KV.get(`stats:${linkId}`, "json"));
    let breach = "";
    if (settings.maxTotalBytes && stats.bytes + size > settings.maxTotalBytes) breach = "byte budget reached";
    if (settings.maxTotalFiles && stats.files >= settings.maxTotalFiles) breach = "file budget reached";
    if (settings.maxSessions && stats.sessions >= settings.maxSessions) {
      if (!(await env.KV.get(`started:${link.slug}:${sessionId}`))) breach = "session budget reached";
    }
    if (breach) {
      if (!link.disabled) {
        link.disabled = true;
        link.disabledReason = breach;
        await env.KV.put(`link:${linkId}`, JSON.stringify(link));
        await logEvent(env, { type: "autopause", slug: link.slug, label: link.label, message: breach }, request);
      }
      return json({ error: `link paused: ${breach}` }, 413);
    }
  }

  // Drive space preflight: refuse files that cannot fit in the account.
  if (env.GOOGLE_CLIENT_ID) {
    const free = await cachedQuotaFree(env);
    if (free != null && size > Math.max(0, free - QUOTA_RESERVE)) {
      return json({ error: "not enough free Google Drive space for this file" }, 507);
    }
  }

  const safeName = sanitizeFilename(filename);
  const uploader = await resolveUploader(request, env, link, uploaderName);
  if (!link.folderId) {
    try {
      link.folderId = await ensureLinkFolder(env, link);
    } catch (err) {
      return json({ error: "Drive folder is not ready yet: " + err.message }, 503);
    }
  }
  // Recreate the uploaded folder tree: "Trip/Day 1/IMG.jpg" lands in a real
  // Trip/Day 1 folder chain instead of being flattened with metadata only.
  const relSegments = sanitizeRelPath(relativePath || "");
  const folderSegments = relSegments.length > 1 ? relSegments.slice(0, -1) : [];
  let folderId;
  try {
    folderId = await resolveTargetFolder(env, link, uploader, folderSegments);
  } catch (err) {
    return json({ error: "Drive folder create failed: " + err.message }, 502);
  }
  const tok = await accessToken(env);
  // The browser talks to Drive directly, so the resumable session must be
  // CORS-bound to the page origin the browser actually has. Under
  // `wrangler dev` both request.url and the Origin header carry the
  // configured route host, so the client states its origin; it only affects
  // which browser page may PUT to a session that page already owns.
  const pageOrigin = cleanText(b.pageOrigin || "", 200);
  const origin = /^https?:\/\/[\w.-]+(?::\d+)?$/.test(pageOrigin) ? pageOrigin : request.headers.get("origin") || new URL(request.url).origin;

  const appProperties = { uploader, dropLink: linkId };
  const relPath = cleanText(relativePath || "", 200);
  // appProperties key+value pairs are limited to 124 bytes; keep it short.
  if (relPath && relPath !== safeName) appProperties.relPath = relPath.slice(0, 100);

  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true", {
    method: "POST",
    headers: {
      authorization: `Bearer ${tok}`,
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": mimeType || "application/octet-stream",
      "x-upload-content-length": String(size),
      origin,
    },
    body: JSON.stringify({
      name: safeName,
      parents: [folderId],
      description: `Uploaded by ${uploader} via ${APP_NAME} (${linkId})${relPath ? ` from ${relPath}` : ""}`,
      appProperties,
    }),
  });
  if (!r.ok) {
    return json({ error: "Drive session failed: " + (await r.text()).slice(0, 300) }, 502);
  }
  const sessionUri = r.headers.get("location");
  if (!sessionUri) return json({ error: "Drive returned no session URI" }, 502);

  await recordSessionStart(env, link, uploader, sessionId, request, { name: safeName, size, queueCount: Number(queueCount) || 0, queueBytes: Number(queueBytes) || 0 });
  return json({ sessionUri });
}

// Runs on every progress tick. The Durable Object answers "seen before?"
// from memory, so the KV guard is only consulted on the no-DO path.
async function recordSessionStart(env, link, uploader, id, request, firstFile) {
  if (env.LIVE_TRACKER) {
    const res = await liveStub(env).fetch("https://live.internal/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link, uploader, sessionId: id }),
    });
    const d = await res.json().catch(() => ({ first: true }));
    if (!d.first) return;
  } else {
    const guardKey = `started:${link.slug}:${id}`;
    if (await env.KV.get(guardKey)) return;
    await env.KV.put(guardKey, "1", { expirationTtl: 24 * 3600 });
  }
  await bumpStats(env, link.slug, { sessions: 1 });
  await logEvent(env, { type: "start", slug: link.slug, label: link.label, uploader, sessionId: id }, request);
  const notify = normalizeNotify(link.notify);
  if (notify.enabled && notify.start) {
    const client = extractClientInfo(request) || {};
    const origin = new URL(request.url).origin;
    await sendNotify(env, {
      ...notifyEmail({
        subject: `${uploader} is sending files to ${link.label}`,
        headline: `<b>${escapeHtml(uploader)}</b> just started uploading to <b>${escapeHtml(link.label)}</b>.`,
        facts: [
          ["Link", `${origin}/d/${link.slug}`],
          ["Device", [client.o, client.l].filter(Boolean).join(" · ")],
          ["Queued", firstFile?.queueCount ? `${firstFile.queueCount} file${firstFile.queueCount === 1 ? "" : "s"}, ${fmtBytesServer(firstFile.queueBytes)}` : ""],
          ["First file", firstFile ? `${firstFile.name} (${fmtBytesServer(firstFile.size)})` : ""],
          ["Started", new Date().toUTCString()],
        ],
        cta: { href: `${origin}/admin/live`, label: "Watch it live" },
      }),
      category: "upload-started",
    });
  }
}

export async function logComplete(request, env) {
  const b = await request.json().catch(() => ({}));
  const { linkId, filename, size, mimeType, uploader, fileId, sessionId } = b;
  if (!linkId || !filename || !fileId) return json({ error: "linkId, filename and fileId required" }, 400);
  const link = await env.KV.get(`link:${linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const authFailure = await requireDropViewer(request, env, link);
  if (authFailure) return authFailure;
  if (env.GOOGLE_CLIENT_ID) {
    const driveFile = await driveFileMeta(env, fileId);
    if (!driveFile?.id) return json({ error: "Drive file could not be verified" }, 502);
    if (driveFile.appProperties?.dropLink && driveFile.appProperties.dropLink !== linkId) {
      return json({ error: "Drive file belongs to a different drop link" }, 400);
    }
    const driveSize = Number(driveFile.size);
    if (Number.isFinite(driveSize) && driveSize !== Number(size)) {
      return json({ error: "Drive file size mismatch" }, 409);
    }
  }

  const meta = {
    n: cleanText(filename, 160),
    s: Number(size) || 0,
    m: cleanText(mimeType || "", 80),
    u: await resolveUploader(request, env, link, uploader),
    f: cleanText(fileId || "", 120),
    si: cleanText(sessionId || "", 80),
    at: Date.now(),
  };
  await recordCompletion(env, link, meta, request);
  // Per-file "complete" emails were replaced by the per-session digest sent
  // from the Durable Object (flushDigests) to respect Resend's free tier.
  return json({ ok: true });
}

export async function logClientError(request, env) {
  const rl = await rateLimitRemote(env, `cerr:${clientIp(request)}`, 5, 60);
  if (!rl.allowed) return retryJson("slow down", rl.retryAfter);
  const b = await request.json().catch(() => ({}));
  const slug = cleanText(b.linkId || "", 60);
  const message = cleanText(`${b.name || ""} ${b.message || ""}`, 160);
  await logEvent(env, { type: "clienterror", slug, uploader: cleanText(b.uploader || "", 60), message }, request);
  const detail = {
    stack: cleanText(b.stack || "", 1200),
    at: cleanText(b.where || "", 200),
    url: cleanText(b.url || "", 200),
    ua: cleanText(request.headers.get("user-agent") || "", 200),
    uploader: cleanText(b.uploader || "", 60),
    state: b.state && typeof b.state === "object" ? JSON.parse(cleanText(JSON.stringify(b.state), 600)) : undefined,
    crumbs: Array.isArray(b.crumbs) ? b.crumbs.slice(-25).map((c) => cleanText(String(c), 160)) : [],
    client: extractClientInfo(request),
  };
  appLog(env, null, { level: "error", area: "client", message: `${b.url ? cleanText(b.url, 80) : "page"}: ${message}`, detail });
  // One e-mail per page per 15 minutes so a crash loop cannot flood the inbox.
  const mail = await rateLimitRemote(env, `cerr-mail:${slug || cleanText(b.url || "", 60)}`, 1, 15 * 60);
  if (mail.allowed) {
    await sendNotify(env, {
      subject: `Client error on ${slug ? `/d/${slug}` : cleanText(b.url || "a page", 60)}: ${message.slice(0, 80)}`,
      category: "client-error",
      html: `<p><b>${escapeHtml(message)}</b></p><p style="color:#4a5b70">${escapeHtml(detail.url)} · ${escapeHtml(detail.ua)}${detail.uploader ? ` · uploader ${escapeHtml(detail.uploader)}` : ""}${detail.client?.l ? ` · ${escapeHtml(detail.client.l)}` : ""}</p>${detail.at ? `<p>at ${escapeHtml(detail.at)}</p>` : ""}${detail.stack ? `<pre style="font-size:11px;white-space:pre-wrap;background:#f3f6fa;padding:8px;border-radius:6px">${escapeHtml(detail.stack)}</pre>` : ""}${detail.state ? `<p style="font-size:12px"><b>State</b> ${escapeHtml(JSON.stringify(detail.state))}</p>` : ""}${detail.crumbs.length ? `<p style="font-size:12px"><b>Last actions</b></p><ol style="font-size:12px;margin:0;padding-left:18px">${detail.crumbs.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ol>` : ""}<p style="font-size:12px;color:#8a97a8">Full entry in <a href="https://dropbox.losthusky.qzz.io/admin/logs">System log</a>.</p>`,
      text: `${message}\n${detail.url}\n${detail.at}\n${detail.stack}`,
    });
  }
  return json({ ok: true });
}

export async function dropTrack(request, env, ctx) {
  const rl = await rateLimitRemote(env, `dtrack:${clientIp(request)}`, 90, 60);
  if (!rl.allowed) return retryJson("slow down", rl.retryAfter);
  const b = await request.json().catch(() => ({}));
  const slug = cleanText(b.slug || "", 60);
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const sessionId = cleanText(b.sessionId || "", 80);
  const events = Array.isArray(b.events)
    ? b.events.slice(0, 40).map((event) => ({
        t: cleanText(event?.t || "event", 40),
        name: cleanText(event?.name || "", 160),
        at: Number(event?.at) || Date.now(),
        mono: Math.max(0, Number(event?.mono) || 0),
        data: event?.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : {},
      }))
    : [];
  if (!events.length) return json({ ok: true });
  // Pure analytics with no result dependencies: one wave, after the ack.
  const work = [storeTelemetry(env, {
    kind: "drop",
    slug,
    sessionId,
    at: Date.now(),
    startedAt: Number(b.startedAt) || 0,
    events,
  })];

  const clicks = events.filter((event) => event.t === "click");
  if (clicks.length) {
    work.push(logEvent(env, {
      type: "drop-clicks",
      slug,
      label: link.label,
      file: clicks.at(-1).name,
      count: clicks.length,
      message: `${clicks.length} interaction${clicks.length === 1 ? "" : "s"}; last: ${clicks.at(-1).name}`,
      sessionId,
    }, request));
  }
  const progressEvents = events.filter((event) => event.t === "upload_progress");
  if (progressEvents.length) {
    const last = progressEvents.at(-1);
    const data = last.data || {};
    work.push(logEvent(env, {
      type: "drop-upload_progress",
      slug,
      label: link.label,
      file: last.name,
      bytes: Number(data.sent) || 0,
      count: progressEvents.length,
      message: `${Number(data.percent) || 0}% sent`,
      sessionId: cleanText(data.uploadSessionId || sessionId, 80),
    }, request));
  }
  const visible = new Set(["upload_start", "upload_session_created", "upload_resumed", "upload_retry", "upload_bytes_complete", "upload_complete", "upload_error", "network_offline", "network_online", "client_error", "session_end"]);
  for (const event of events.filter((item) => visible.has(item.t))) {
    const data = event.data || {};
    const message = event.t === "upload_error"
      ? cleanText(data.message || "upload error", 160)
      : event.t === "session_end"
        ? `browser session ${Math.round((Number(data.elapsedMs) || 0) / 1000)}s`
        : cleanText(event.t.replaceAll("_", " "), 160);
    work.push(logEvent(env, {
      type: `drop-${event.t}`,
      slug,
      label: link.label,
      file: event.name,
      bytes: Number(data.size) || 0,
      message,
      sessionId: cleanText(data.uploadSessionId || sessionId, 80),
    }, request));
  }
  await background(ctx, Promise.all(work), "drop telemetry");
  return json({ ok: true });
}
