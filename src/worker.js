// LostHusky's DropBox - receive huge trip files straight into Google Drive.
// File bytes never pass through this Worker. The Worker mints Google Drive
// resumable sessions, stores durable metadata in KV, and relays live progress
// through a Durable Object so progress does not burn KV writes.
//
// Modules:
//   util.js  - constants, pure helpers, normalizers
//   drive.js - Google Drive API calls
//   store.js - KV state, PIN gate/lockouts, events, notifications
//   live.js  - LiveTracker Durable Object (live WS, batched flushes, rollups)
//   share.js - outbound Share Links (gallery + redirect modes)

import {
  ADMIN_SESSION_TTL,
  APP_NAME,
  MAX_EXPIRY_DAYS,
  QUOTA_RESERVE,
  SECURITY_HEADERS,
  b64url,
  clamp,
  cleanText,
  clientIp,
  escapeHtml,
  json,
  linkState,
  makePinFields,
  normalizeEvent,
  normalizeNotify,
  normalizeSettings,
  normalizeStats,
  normalizeTheme,
  randomSlug,
  retryJson,
  sanitizeFilename,
  sanitizeRelPath,
  slugify,
  timingSafeEqual,
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
  getUploads,
  liveProgress,
  liveSnapshot,
  liveStub,
  logEvent,
  mergeEventsKV,
  rateLimitRemote,
  recentEvents,
  recordCompletion,
  sendNotify,
} from "./store.js";
import {
  adminShare,
  createShareZipTicket,
  createShare,
  deleteShare,
  getAllShares,
  getShareMeta,
  listShareFiles,
  listShares,
  logShareOpened,
  patchShare,
  refreshShareDownload,
  shareDownload,
  shareRedirect,
  shareSummary,
  shareZipDownload,
  verifySharePin,
} from "./share.js";

export { LiveTracker } from "./live.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(request, env, url, ctx);
      if (p === "/") return servePage(env, url, "/index.html");
      if (p.startsWith("/d/")) return servePage(env, url, "/drop.html");
      if (p.startsWith("/s/")) return servePage(env, url, "/share.html");
      if (p === "/admin") return servePage(env, url, "/admin.html");
      return secureAsset(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error(err.stack || err.message);
      return json({ error: err.message || "internal error" }, 500);
    }
  },
};

async function servePage(env, url, assetPath) {
  const res = await env.ASSETS.fetch(new Request(url.origin + assetPath));
  const type = res.headers.get("content-type") || "";
  if (env.CF_BEACON_TOKEN && type.includes("text/html")) {
    // Inject the Cloudflare Web Analytics beacon only when a token is
    // configured, keeping pages dependency-free otherwise.
    let html = await res.text();
    const beacon = `<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${escapeHtml(env.CF_BEACON_TOKEN)}"}'></script>`;
    html = html.includes("</body>") ? html.replace("</body>", `${beacon}</body>`) : html + beacon;
    return secureAsset(new Response(html, { status: res.status, headers: { "content-type": type } }));
  }
  return secureAsset(res);
}

function secureAsset(response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  headers.set("cache-control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function api(request, env, url, ctx) {
  const p = url.pathname;
  const m = request.method;

  if (m === "GET" && p.startsWith("/api/live/upload/")) {
    return openUploadLiveSocket(request, env, p.slice("/api/live/upload/".length));
  }
  if (m === "GET" && p === "/api/admin/live") return openAdminLiveSocket(request, env);

  if (m === "GET" && p.startsWith("/api/link/")) {
    return getPublicLink(env, p.slice("/api/link/".length));
  }
  if (m === "POST" && p === "/api/verify") return verifyPin(request, env);
  if (m === "POST" && p === "/api/opened") return logOpened(request, env);
  if (m === "POST" && p === "/api/progress") return logProgress(request, env);
  if (m === "POST" && p === "/api/session") return createSession(request, env);
  if (m === "POST" && p === "/api/complete") return logComplete(request, env);
  if (m === "POST" && p === "/api/client-error") return logClientError(request, env);

  // Public share-link endpoints (gallery + redirect modes).
  if (m === "GET" && p.startsWith("/api/share/meta/")) {
    return getShareMeta(env, p.slice("/api/share/meta/".length));
  }
  if (m === "POST" && p === "/api/share/verify") return verifySharePin(request, env);
  if (m === "POST" && p === "/api/share/opened") return logShareOpened(request, env);
  if (m === "POST" && p === "/api/share/list") return listShareFiles(request, env);
  if (m === "POST" && p === "/api/share/summary") return shareSummary(request, env);
  if (m === "POST" && p === "/api/share/refresh-dl") return refreshShareDownload(request, env);
  if (m === "POST" && p === "/api/share/zip-ticket") return createShareZipTicket(request, env);
  if (m === "POST" && p === "/api/share/redirect") return shareRedirect(request, env);
  if (m === "GET" && p.startsWith("/api/share/dl/")) {
    return shareDownload(request, env, p.slice("/api/share/dl/".length));
  }
  if (m === "GET" && p.startsWith("/api/share/zip/")) {
    return shareZipDownload(request, env, p.slice("/api/share/zip/".length));
  }

  if (m === "POST" && p === "/api/admin/login") return adminLogin(request, env);
  if (m === "POST" && p === "/api/admin/logout") return adminLogout();

  if (p.startsWith("/api/admin/")) {
    if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
    if (!sameOriginOk(request, url)) return json({ error: "bad origin" }, 403);
    if (m === "GET" && p === "/api/admin/overview") return adminOverview(env);
    if (m === "GET" && p === "/api/admin/timeseries") return adminTimeseries(env, url);
    if (m === "GET" && p === "/api/admin/links") return listLinks(env);
    if (m === "POST" && p === "/api/admin/links") return createLink(request, env, ctx);
    if (m === "POST" && p === "/api/admin/live/close") return closeLiveSession(request, env);
    if (m === "GET" && p === "/api/admin/shares") return listShares(env);
    if (m === "POST" && p === "/api/admin/shares") return createShare(request, env);
    if (m === "PATCH" && p.startsWith("/api/admin/shares/")) {
      return patchShare(request, env, p.slice("/api/admin/shares/".length));
    }
    if (m === "DELETE" && p.startsWith("/api/admin/shares/")) {
      return deleteShare(request, env, p.slice("/api/admin/shares/".length));
    }
    if (m === "GET" && p.startsWith("/api/admin/link/")) {
      return linkDetail(env, p.slice("/api/admin/link/".length), url);
    }
    if (m === "PATCH" && p.startsWith("/api/admin/links/")) {
      return patchLink(request, env, p.slice("/api/admin/links/".length));
    }
    if (m === "DELETE" && p.startsWith("/api/admin/links/")) {
      return deleteLink(request, env, p.slice("/api/admin/links/".length));
    }
    if (m === "GET" && p.startsWith("/api/admin/uploads/")) {
      return listUploads(env, p.slice("/api/admin/uploads/".length), url);
    }
    if (m === "GET" && p.startsWith("/api/admin/thumb/")) {
      return driveThumbMeta(env, p.slice("/api/admin/thumb/".length));
    }
  }
  return json({ error: "not found" }, 404);
}

// ---- Admin auth: bearer token (scripts/tests) or HMAC session cookie ----

function sameOriginOk(request, url) {
  const origin = request.headers.get("origin");
  if (!origin) return true; // same-origin GET/fetch without Origin header
  return origin === url.origin;
}

async function isAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
  const h = request.headers.get("authorization") || "";
  if (h && timingSafeEqual(h, `Bearer ${env.ADMIN_TOKEN}`)) return true;
  const cookie = getCookie(request, "hd_admin");
  if (!cookie) return false;
  return verifyAdminSession(env, cookie);
}

function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return "";
}

async function adminSessionKey(env) {
  const seed = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${env.ADMIN_TOKEN}:hd-admin-session-v1`)
  );
  return crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function mintAdminSession(env) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL;
  const key = await adminSessionKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(exp)));
  return `${exp}.${b64url(new Uint8Array(mac))}`;
}

async function verifyAdminSession(env, value) {
  const dot = value.indexOf(".");
  if (dot < 1) return false;
  const exp = Number(value.slice(0, dot));
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const key = await adminSessionKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(exp)));
  return timingSafeEqual(value.slice(dot + 1), b64url(new Uint8Array(mac)));
}

async function adminLogin(request, env) {
  const rl = await rateLimitRemote(env, `login:${clientIp(request)}`, 5, 15 * 60);
  if (!rl.allowed) return retryJson("too many login attempts", rl.retryAfter);
  const body = await request.json().catch(() => ({}));
  const token = String(body.token || "");
  if (!env.ADMIN_TOKEN || !timingSafeEqual(token, env.ADMIN_TOKEN)) {
    await logEvent(env, { type: "lock", message: "admin login failed" }, request);
    return json({ error: "wrong token" }, 403);
  }
  const session = await mintAdminSession(env);
  return json({ ok: true }, 200, {
    "set-cookie": `hd_admin=${session}; Path=/; Max-Age=${ADMIN_SESSION_TTL}; HttpOnly; Secure; SameSite=Strict`,
  });
}

function adminLogout() {
  return json({ ok: true }, 200, {
    "set-cookie": "hd_admin=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict",
  });
}

// ---- Live sockets ----

async function openUploadLiveSocket(request, env, slug) {
  if (request.headers.get("upgrade") !== "websocket") {
    return json({ error: "expected websocket" }, 426);
  }
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link || linkState(link) !== "active") return json({ error: "link unavailable" }, 404);
  const req = new Request(`https://live.internal/ws?role=upload&slug=${encodeURIComponent(slug)}`, request);
  return liveStub(env).fetch(req);
}

async function openAdminLiveSocket(request, env) {
  // Cookie-authenticated: the browser sends hd_admin on same-origin WS
  // upgrades, so the token never appears in a URL anymore.
  if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
  const req = new Request("https://live.internal/ws?role=admin", request);
  return liveStub(env).fetch(req);
}

async function closeLiveSession(request, env) {
  const body = await request.json().catch(() => ({}));
  const id = cleanText(body.id || "", 100);
  const slug = cleanText(body.slug || "", 60);
  if (!id && !slug) return json({ error: "id or slug required" }, 400);
  const res = await liveStub(env).fetch("https://live.internal/close", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, slug }),
  });
  const result = await res.json().catch(() => ({ ok: false, closed: 0 }));
  if (result.closed) await logEvent(env, { type: "sessionclose", slug, message: id }, request);
  return json(result);
}

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
async function ensureLinkFolder(env, link) {
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

// ---- Public drop-link endpoints ----

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

function adminLink(link, stats = {}) {
  return {
    slug: link.slug,
    label: link.label,
    folderId: link.folderId || null,
    folderName: link.folderName || null,
    folderPending: !!link.folderPending,
    hasPin: !!link.pinHash,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt || null,
    disabled: !!link.disabled,
    disabledReason: link.disabledReason || "",
    state: linkState(link),
    settings: normalizeSettings(link.settings),
    theme: normalizeTheme(link.theme),
    notify: normalizeNotify(link.notify),
    stats: normalizeStats(stats),
  };
}

async function getPublicLink(env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const quota = env.GOOGLE_CLIENT_ID ? await driveQuota(env) : null;
  return json(publicLink(link, quota));
}

async function verifyPin(request, env) {
  const b = await request.json().catch(() => ({}));
  const link = await env.KV.get(`link:${b.linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const state = linkState(link);
  if (state === "expired") return json({ error: "this link has expired" }, 410);
  if (state === "paused") return json({ error: "this link is paused" }, 403);
  const failure = await gatePin(request, env, link, b.pin);
  if (failure) return failure;
  return json({ ok: true });
}

async function logOpened(request, env) {
  const b = await request.json().catch(() => ({}));
  const link = await env.KV.get(`link:${b.linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  if (linkState(link) === "expired") return json({ error: "this link has expired" }, 410);
  const record = normalizeEvent({ type: "open", slug: link.slug, label: link.label }, request);
  if (env.LIVE_TRACKER) {
    await liveStub(env)
      .fetch("https://live.internal/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ slug: link.slug, record }),
      })
      .catch(() => {});
  } else {
    await bumpStats(env, link.slug, { opens: 1 });
    await mergeEventsKV(env, [record]);
  }
  return json({ ok: true });
}

async function logProgress(request, env) {
  const b = await request.json().catch(() => ({}));
  const link = await env.KV.get(`link:${b.linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  if (linkState(link) === "expired") return json({ error: "this link has expired" }, 410);
  const failure = await gatePin(request, env, link, b.pin);
  if (failure) return failure;
  const sessionId = cleanText(b.sessionId || "", 100) || `${Date.now()}-${randomSlug(5)}`;
  await recordSessionStart(env, link, cleanText(b.uploader || "anonymous", 60), sessionId, request);
  await liveProgress(env, {
    type: "progress",
    sessionId,
    slug: link.slug,
    label: link.label,
    uploader: b.uploader,
    sent: b.sent,
    total: b.total,
    files: b.files,
    state: b.final ? "done" : "uploading",
  });
  return json({ ok: true });
}

async function createSession(request, env) {
  const b = await request.json().catch(() => ({}));
  const { linkId, pin, filename, size, mimeType, uploaderName, sessionId, relativePath } = b;

  if (!linkId || !filename || !Number.isFinite(size) || size <= 0) {
    return json({ error: "linkId, filename and size are required" }, 400);
  }
  const link = await env.KV.get(`link:${linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const state = linkState(link);
  if (state === "expired") return json({ error: "this link has expired" }, 410);
  if (state === "paused") return json({ error: "this link is paused" }, 403);
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
      const started = sessionId ? await env.KV.get(`started:${link.slug}:${cleanText(sessionId, 80)}`) : null;
      if (!started) breach = "session budget reached";
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
    const free = quotaFree(await driveQuota(env));
    if (free != null && size > Math.max(0, free - QUOTA_RESERVE)) {
      return json({ error: "not enough free Google Drive space for this file" }, 507);
    }
  }

  const safeName = sanitizeFilename(filename);
  const uploader = cleanText(uploaderName || "anonymous", 60) || "anonymous";
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
  const origin = new URL(request.url).origin;

  const appProperties = { uploader, dropLink: linkId };
  const relPath = cleanText(relativePath || "", 200);
  // appProperties key+value pairs are limited to 124 bytes; keep it short.
  if (relPath && relPath !== safeName) appProperties.relPath = relPath.slice(0, 100);

  const r = await fetch(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true",
    {
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
    }
  );
  if (!r.ok) {
    return json({ error: "Drive session failed: " + (await r.text()).slice(0, 300) }, 502);
  }
  const sessionUri = r.headers.get("location");
  if (!sessionUri) return json({ error: "Drive returned no session URI" }, 502);

  await recordSessionStart(env, link, uploader, sessionId, request);
  return json({ sessionUri });
}

async function recordSessionStart(env, link, uploader, sessionId, request) {
  const id = cleanText(sessionId || "", 80) || `${Date.now()}-${randomSlug(5)}`;
  const guardKey = `started:${link.slug}:${id}`;
  if (await env.KV.get(guardKey)) return;
  if (env.LIVE_TRACKER) {
    const res = await liveStub(env).fetch("https://live.internal/session-start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link, uploader, sessionId: id }),
    });
    const d = await res.json().catch(() => ({ first: true }));
    if (!d.first) return;
  } else {
    await env.KV.put(guardKey, "1", { expirationTtl: 24 * 3600 });
  }
  await bumpStats(env, link.slug, { sessions: 1 });
  await logEvent(env, { type: "start", slug: link.slug, label: link.label, uploader }, request);
  const notify = normalizeNotify(link.notify);
  if (notify.enabled && notify.start) {
    await sendNotify(env, {
      subject: `${APP_NAME}: ${uploader} started uploading`,
      html: `<p><b>${escapeHtml(uploader)}</b> started uploading to <b>${escapeHtml(link.label)}</b>.</p>`,
    });
  }
}

async function logComplete(request, env) {
  const b = await request.json().catch(() => ({}));
  const { linkId, filename, size, mimeType, uploader, fileId } = b;
  if (!linkId || !filename || !fileId) return json({ error: "linkId, filename and fileId required" }, 400);
  const link = await env.KV.get(`link:${linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
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
    u: cleanText(uploader || "anonymous", 60),
    f: cleanText(fileId || "", 120),
    at: Date.now(),
  };
  await recordCompletion(env, link, meta, request);
  // Per-file "complete" emails were replaced by the per-session digest sent
  // from the Durable Object (maybeSendDigest) to respect Resend's free tier.
  return json({ ok: true });
}

async function logClientError(request, env) {
  const rl = await rateLimitRemote(env, `cerr:${clientIp(request)}`, 5, 60);
  if (!rl.allowed) return retryJson("slow down", rl.retryAfter);
  const b = await request.json().catch(() => ({}));
  await logEvent(
    env,
    {
      type: "clienterror",
      slug: cleanText(b.linkId || "", 60),
      uploader: cleanText(b.uploader || "", 60),
      message: cleanText(`${b.name || ""} ${b.message || ""} ${b.stack || ""}`, 160),
    },
    request
  );
  return json({ ok: true });
}

// ---- Drop link admin ----

async function listLinks(env) {
  const links = await getAllLinks(env);
  const out = [];
  for (const link of links) out.push(adminLink(link, await env.KV.get(`stats:${link.slug}`, "json")));
  out.sort((a, b) => b.createdAt - a.createdAt);
  return json({ links: out });
}

async function createLink(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  let { slug, label, pin, expiresDays, folderId, folderName } = b;
  if (!label) return json({ error: "label is required" }, 400);
  slug = slugify(slug) || randomSlug();
  if (await env.KV.get(`link:${slug}`)) return json({ error: `slug "${slug}" already exists` }, 409);

  const days = clamp(Number(expiresDays) || 0, 0, MAX_EXPIRY_DAYS);
  const link = {
    slug,
    label: cleanText(label, 80),
    folderId: cleanText(folderId || "", 160) || null,
    folderName: cleanText(folderName || "", 80) || null,
    folderPending: false,
    disabled: false,
    disabledReason: "",
    ...(pin ? await makePinFields(pin) : { pinSalt: null, pinHash: null, pinAlgo: null }),
    createdAt: Date.now(),
    expiresAt: days > 0 ? Date.now() + days * 86400_000 : null,
    settings: normalizeSettings(b.settings),
    theme: normalizeTheme(b.theme),
    notify: normalizeNotify(b.notify),
  };

  // Instant link creation: return the copyable URL immediately and create the
  // Drive folder in the background (or lazily on the first upload session).
  if (!link.folderId && env.GOOGLE_CLIENT_ID) {
    link.folderPending = true;
    if (!link.folderName) link.folderName = link.label;
  }

  const opts = {};
  if (link.expiresAt) opts.expirationTtl = Math.ceil((link.expiresAt - Date.now()) / 1000) + 30 * 86400;
  await env.KV.put(`link:${slug}`, JSON.stringify(link), opts);
  await env.KV.put(`stats:${slug}`, JSON.stringify(normalizeStats()), opts);
  await addLinkToIndex(env, slug);
  await logEvent(env, { type: "linknew", slug, label: link.label }, request);

  if (link.folderPending && ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(
      ensureLinkFolder(env, link).catch((err) => console.error("bg folder create failed", err.message))
    );
  }
  return json({ ok: true, slug, folderId: link.folderId, folderPending: link.folderPending, url: `/d/${slug}` });
}

async function patchLink(request, env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const b = await request.json().catch(() => ({}));
  if ("label" in b) link.label = cleanText(b.label, 80) || link.label;
  if ("pin" in b) {
    if (b.pin) {
      Object.assign(link, await makePinFields(b.pin));
    } else {
      link.pinSalt = null;
      link.pinHash = null;
      link.pinAlgo = null;
    }
  }
  if ("disabled" in b) {
    link.disabled = !!b.disabled;
    link.disabledReason = link.disabled ? cleanText(b.disabledReason || "paused by admin", 80) : "";
  }
  if ("expiresDays" in b) {
    const days = clamp(Number(b.expiresDays) || 0, 0, MAX_EXPIRY_DAYS);
    link.expiresAt = days > 0 ? Date.now() + days * 86400_000 : null;
  }
  if ("settings" in b) link.settings = normalizeSettings({ ...link.settings, ...b.settings });
  if ("theme" in b) link.theme = normalizeTheme({ ...link.theme, ...b.theme });
  if ("notify" in b) link.notify = normalizeNotify({ ...link.notify, ...b.notify });
  await env.KV.put(`link:${slug}`, JSON.stringify(link));
  await logEvent(env, { type: "linkedit", slug, label: link.label }, request);
  return json(adminLink(link, await env.KV.get(`stats:${slug}`, "json")));
}

async function deleteLink(request, env, slug) {
  await env.KV.delete(`link:${slug}`);
  await removeLinkFromIndex(env, slug);
  await logEvent(env, { type: "linkdel", slug }, request);
  return json({ ok: true });
}

async function listUploads(env, slug, url) {
  const fresh = url?.searchParams.get("fresh") === "1";
  const uploads = await getUploads(env, slug, fresh);
  const totalBytes = uploads.reduce((t, u) => t + (u.s || 0), 0);
  return json({ uploads, count: uploads.length, totalBytes });
}

async function linkDetail(env, slug, url) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const fresh = url?.searchParams.get("fresh") === "1";
  const uploads = await getUploads(env, slug, fresh);
  const active = (await liveSnapshot(env)).filter((s) => s.slug === slug);
  const totalBytes = uploads.reduce((t, u) => t + (u.s || 0), 0);
  return json({
    link: adminLink(link, await env.KV.get(`stats:${slug}`, "json")),
    uploads,
    count: uploads.length,
    totalBytes,
    active,
  });
}

async function adminOverview(env) {
  const links = await getAllLinks(env);
  const rows = [];
  const totals = { links: links.length, opens: 0, sessions: 0, files: 0, bytes: 0 };
  for (const link of links) {
    const stats = normalizeStats(await env.KV.get(`stats:${link.slug}`, "json"));
    totals.opens += stats.opens;
    totals.sessions += stats.sessions;
    totals.files += stats.files;
    totals.bytes += stats.bytes;
    rows.push(adminLink(link, stats));
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const shares = await getAllShares(env);
  const shareRows = [];
  for (const share of shares) {
    shareRows.push(adminShare(share, await env.KV.get(`sstats:${share.slug}`, "json")));
  }
  shareRows.sort((a, b) => b.createdAt - a.createdAt);
  const quota = env.GOOGLE_CLIENT_ID ? await driveQuota(env) : null;
  return json({
    appName: APP_NAME,
    totals,
    links: rows,
    shares: shareRows,
    quota: quota ? { limit: quota.limit, usage: quota.usage, free: quotaFree(quota) } : null,
    active: await liveSnapshot(env),
    events: await recentEvents(env).catch(() => []),
  });
}

async function adminTimeseries(env, url) {
  if (!env.LIVE_TRACKER) return json({ rows: [] });
  const days = clamp(Number(url.searchParams.get("days")) || 30, 1, 120);
  const slug = cleanText(url.searchParams.get("slug") || "", 66);
  const res = await liveStub(env).fetch(
    `https://live.internal/timeseries?days=${days}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}`
  );
  if (!res.ok) return json({ rows: [] });
  return json(await res.json());
}

async function driveThumbMeta(env, fileId) {
  const meta = await driveFileMeta(env, fileId);
  if (!meta) return json({ error: "thumbnail lookup failed" }, 502);
  return json(meta);
}

async function getAllLinks(env) {
  const slugs = await getLinkIndex(env);
  if (slugs.length) {
    const links = [];
    for (const slug of slugs) {
      const link = await env.KV.get(`link:${slug}`, "json");
      if (link) links.push(link);
    }
    return links;
  }

  const links = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: "link:", cursor });
    for (const k of page.keys) {
      const link = await env.KV.get(k.name, "json");
      if (link) links.push(link);
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return links;
}

async function getLinkIndex(env) {
  const configured = (env.LINK_SLUGS || "")
    .split(",")
    .map((s) => slugify(s))
    .filter(Boolean);
  const stored = (await env.KV.get("links:index", "json")) || [];
  return [...new Set([...configured, ...stored.map(slugify).filter(Boolean)])];
}

async function addLinkToIndex(env, slug) {
  const slugs = await getLinkIndex(env);
  if (!slugs.includes(slug)) slugs.push(slug);
  await env.KV.put("links:index", JSON.stringify(slugs));
}

async function removeLinkFromIndex(env, slug) {
  const slugs = (await getLinkIndex(env)).filter((s) => s !== slug);
  await env.KV.put("links:index", JSON.stringify(slugs));
}
