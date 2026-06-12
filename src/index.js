// LostHusky's DropBox - receive huge trip files straight into Google Drive.
// File bytes never pass through this Worker. The Worker mints Google Drive
// resumable sessions, stores durable metadata in KV, and relays live progress
// through a Durable Object so progress does not burn KV writes.

const APP_NAME = "LostHusky's DropBox";
const MAX_DEFAULT_BYTES = 5 * 1024 ** 4; // 5 TB, bounded by Drive quota/limits.
const MAX_EXPIRY_DAYS = 30;
const LOCK_ATTEMPTS = 5;
const LOCK_BASE_SECONDS = 60;
const LOCK_MAX_SECONDS = 3600;

const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://api.resend.com",
    "img-src 'self' data: https:",
    "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
};

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(request, env, url);
      if (p.startsWith("/d/")) return servePage(env, url, "/drop.html");
      if (p === "/admin") return servePage(env, url, "/admin.html");
      return secureAsset(await env.ASSETS.fetch(request));
    } catch (err) {
      console.error(err.stack || err.message);
      return json({ error: err.message || "internal error" }, 500);
    }
  },
};

export class LiveTracker {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.sessions = new Map();
    this.adminSockets = new Set();
    this.folderLocks = new Map();
    this.started = new Set();
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/snapshot") {
      this.prune();
      return new Response(JSON.stringify({ active: this.snapshot() }), {
        headers: JSON_HEADERS,
      });
    }

    if (request.method === "POST" && url.pathname === "/close") {
      const body = await request.json().catch(() => ({}));
      const id = cleanText(body.id || "", 100);
      const slug = cleanText(body.slug || "", 60);
      let closed = 0;
      if (id && this.sessions.delete(id)) closed++;
      if (!id && slug) {
        for (const [sessionId, session] of this.sessions) {
          if (session.slug === slug) {
            this.sessions.delete(sessionId);
            closed++;
          }
        }
      }
      if (closed) this.broadcast();
      return new Response(JSON.stringify({ ok: true, closed }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/folder") {
      const body = await request.json().catch(() => ({}));
      const link = body.link || {};
      const uploader = cleanText(body.uploader || "anonymous", 60) || "anonymous";
      if (!link.slug || !link.folderId) {
        return new Response(JSON.stringify({ error: "link required" }), {
          status: 400,
          headers: JSON_HEADERS,
        });
      }
      const key = `${link.slug}:${sanitizeFolderName(uploader).toLowerCase()}`;
      if (!this.folderLocks.has(key)) {
        this.folderLocks.set(
          key,
          resolveUploaderFolderDirect(this.env, link, uploader).finally(() => this.folderLocks.delete(key))
        );
      }
      const folderId = await this.folderLocks.get(key);
      return new Response(JSON.stringify({ folderId }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/session-start") {
      const body = await request.json().catch(() => ({}));
      const link = body.link || {};
      const id = cleanText(body.sessionId || "", 80);
      if (!link.slug || !id) {
        return new Response(JSON.stringify({ first: false }), { headers: JSON_HEADERS });
      }
      const key = `${link.slug}:${id}`;
      if (this.started.has(key)) {
        return new Response(JSON.stringify({ first: false }), { headers: JSON_HEADERS });
      }
      this.started.add(key);
      this.env.KV.put(`started:${key}`, "1", { expirationTtl: 24 * 3600 }).catch(() => {});
      return new Response(JSON.stringify({ first: true }), { headers: JSON_HEADERS });
    }

    if (request.method === "POST" && url.pathname === "/progress") {
      const body = await request.json().catch(() => ({}));
      const session = normalizeLiveSession(body);
      this.sessions.set(session.id, session);
      this.broadcast();
      return new Response(JSON.stringify({ ok: true }), { headers: JSON_HEADERS });
    }

    if (request.headers.get("upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const role = url.searchParams.get("role");
    const slug = url.searchParams.get("slug") || "";

    server.accept();
    if (role === "admin") {
      this.adminSockets.add(server);
      this.safeSend(server, { type: "snapshot", active: this.snapshot() });
      server.addEventListener("close", () => this.adminSockets.delete(server));
      server.addEventListener("error", () => this.adminSockets.delete(server));
    } else {
      server.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        if (msg.type !== "progress") return;
        const session = normalizeLiveSession({ ...msg, slug });
        server.sessionId = session.id;
        this.sessions.set(session.id, session);
        this.broadcast();
      });
      server.addEventListener("close", () => {
        if (server.sessionId) {
          const existing = this.sessions.get(server.sessionId);
          if (existing) {
            existing.state = existing.state === "done" ? "done" : "stale";
            existing.lastSeen = Date.now();
            this.sessions.set(server.sessionId, existing);
            this.broadcast();
          }
        }
      });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  prune() {
    const cutoff = Date.now() - 2 * 60_000;
    for (const [id, session] of this.sessions) {
      if (session.lastSeen < cutoff) this.sessions.delete(id);
    }
  }

  snapshot() {
    this.prune();
    return [...this.sessions.values()].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  broadcast() {
    const payload = { type: "snapshot", active: this.snapshot() };
    for (const socket of [...this.adminSockets]) this.safeSend(socket, payload);
  }

  safeSend(socket, payload) {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      this.adminSockets.delete(socket);
    }
  }
}

function json(obj, status = 200, extraHeaders = {}) {
  const headers = new Headers(JSON_HEADERS);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(obj), { status, headers });
}

function servePage(env, url, assetPath) {
  return env.ASSETS.fetch(new Request(url.origin + assetPath)).then(secureAsset);
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

async function api(request, env, url) {
  const p = url.pathname;
  const m = request.method;

  if (m === "GET" && p.startsWith("/api/live/upload/")) {
    return openUploadLiveSocket(request, env, p.slice("/api/live/upload/".length));
  }
  if (m === "GET" && p === "/api/admin/live") return openAdminLiveSocket(request, env, url);

  if (m === "GET" && p.startsWith("/api/link/")) {
    return getPublicLink(env, p.slice("/api/link/".length));
  }
  if (m === "POST" && p === "/api/verify") return verifyPin(request, env);
  if (m === "POST" && p === "/api/opened") return logOpened(request, env);
  if (m === "POST" && p === "/api/progress") return logProgress(request, env);
  if (m === "POST" && p === "/api/session") return createSession(request, env);
  if (m === "POST" && p === "/api/complete") return logComplete(request, env);

  if (p.startsWith("/api/admin/")) {
    if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
    if (m === "GET" && p === "/api/admin/overview") return adminOverview(env);
    if (m === "GET" && p === "/api/admin/links") return listLinks(env);
    if (m === "POST" && p === "/api/admin/links") return createLink(request, env);
    if (m === "POST" && p === "/api/admin/live/close") return closeLiveSession(request, env);
    if (m === "GET" && p.startsWith("/api/admin/link/")) {
      return linkDetail(env, p.slice("/api/admin/link/".length));
    }
    if (m === "PATCH" && p.startsWith("/api/admin/links/")) {
      return patchLink(request, env, p.slice("/api/admin/links/".length));
    }
    if (m === "DELETE" && p.startsWith("/api/admin/links/")) {
      return deleteLink(env, p.slice("/api/admin/links/".length));
    }
    if (m === "GET" && p.startsWith("/api/admin/uploads/")) {
      return listUploads(env, p.slice("/api/admin/uploads/".length));
    }
    if (m === "GET" && p.startsWith("/api/admin/thumb/")) {
      return driveThumb(env, p.slice("/api/admin/thumb/".length));
    }
  }
  return json({ error: "not found" }, 404);
}

function isAdmin(request, env) {
  const h = request.headers.get("authorization") || "";
  return env.ADMIN_TOKEN && h === `Bearer ${env.ADMIN_TOKEN}`;
}

function liveStub(env) {
  return env.LIVE_TRACKER.get(env.LIVE_TRACKER.idFromName("global"));
}

async function openUploadLiveSocket(request, env, slug) {
  if (request.headers.get("upgrade") !== "websocket") {
    return json({ error: "expected websocket" }, 426);
  }
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link || linkState(link) !== "active") return json({ error: "link unavailable" }, 404);
  const req = new Request(`https://live.internal/ws?role=upload&slug=${encodeURIComponent(slug)}`, request);
  return liveStub(env).fetch(req);
}

async function openAdminLiveSocket(request, env, url) {
  const token = url.searchParams.get("token") || "";
  if (!env.ADMIN_TOKEN || token !== env.ADMIN_TOKEN) return json({ error: "unauthorized" }, 401);
  const req = new Request("https://live.internal/ws?role=admin", request);
  return liveStub(env).fetch(req);
}

async function liveSnapshot(env) {
  if (!env.LIVE_TRACKER) return [];
  const res = await liveStub(env).fetch("https://live.internal/snapshot");
  if (!res.ok) return [];
  const d = await res.json();
  return d.active || [];
}

async function liveProgress(env, session) {
  if (!env.LIVE_TRACKER) return;
  await liveStub(env).fetch("https://live.internal/progress", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(session),
  });
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
  if (result.closed) await logEvent(env, { type: "sessionclose", slug, message: id });
  return json(result);
}

async function accessToken(env) {
  const cached = await env.KV.get("gtoken", "json");
  if (cached && cached.exp > Date.now() / 1000 + 120) return cached.tok;

  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!r.ok) throw new Error("Google token refresh failed: " + (await r.text()).slice(0, 300));
  const d = await r.json();
  await env.KV.put(
    "gtoken",
    JSON.stringify({ tok: d.access_token, exp: Date.now() / 1000 + d.expires_in }),
    { expirationTtl: Math.max(60, d.expires_in - 60) }
  );
  return d.access_token;
}

async function driveCreateFolder(env, name, parentId) {
  const tok = await accessToken(env);
  const body = { name, mimeType: "application/vnd.google-apps.folder" };
  if (parentId) body.parents = [parentId];
  const r = await fetch(
    "https://www.googleapis.com/drive/v3/files?fields=id,name&supportsAllDrives=true",
    {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }
  );
  if (!r.ok) throw new Error("Drive folder create failed: " + (await r.text()).slice(0, 300));
  return r.json();
}

async function driveFindFolder(env, name, parentId) {
  const tok = await accessToken(env);
  const parts = [
    "mimeType='application/vnd.google-apps.folder'",
    "trashed=false",
    `name='${driveQueryEscape(name)}'`,
  ];
  if (parentId) parts.push(`'${driveQueryEscape(parentId)}' in parents`);
  const url =
    "https://www.googleapis.com/drive/v3/files?" +
    new URLSearchParams({
      q: parts.join(" and "),
      fields: "files(id,name)",
      pageSize: "1",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok) throw new Error("Drive folder lookup failed: " + (await r.text()).slice(0, 300));
  const d = await r.json();
  return d.files && d.files[0] ? d.files[0] : null;
}

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

async function resolveUploaderFolderDirect(env, link, uploader) {
  if (!link.settings?.perUploaderFolders) return link.folderId;
  const safeName = sanitizeFolderName(uploader || "anonymous");
  const cacheKey = `folder:${link.slug}:${await sha256(safeName.toLowerCase())}`;
  const cached = await env.KV.get(cacheKey, "json");
  if (cached?.id) return cached.id;
  const found = await driveFindFolder(env, safeName, link.folderId);
  const folder = found || (await driveCreateFolder(env, safeName, link.folderId));
  await env.KV.put(cacheKey, JSON.stringify(folder), { expirationTtl: 180 * 86400 });
  return folder.id;
}

async function driveThumb(env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return json({ error: "missing file id" }, 400);
  const meta = await driveFileMeta(env, id);
  if (!meta) return json({ error: "thumbnail lookup failed" }, 502);
  return json(meta);
}

async function driveFileMeta(env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return null;
  const tok = await accessToken(env);
  const url = `https://www.googleapis.com/drive/v3/files/${id}?` + new URLSearchParams({
    fields: "id,name,size,mimeType,parents,appProperties,thumbnailLink,webViewLink,iconLink",
    supportsAllDrives: "true",
  });
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok) return null;
  return r.json();
}

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function randomSlug(n = 8) {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}

function randomHex(n = 16) {
  return [...crypto.getRandomValues(new Uint8Array(n))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function pinHash(pin, salt) {
  return sha256(`${salt}:${String(pin)}`);
}

async function pinMatches(link, pin) {
  if (!link.pinHash) return true;
  const candidate = link.pinSalt
    ? await pinHash(pin || "", link.pinSalt)
    : await sha256(String(pin || ""));
  return candidate === link.pinHash;
}

function linkState(link) {
  if (!link) return "missing";
  if (link.expiresAt && Date.now() > link.expiresAt) return "expired";
  return "active";
}

function clientIp(request) {
  return (
    request.headers.get("cf-connecting-ip") ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "0.0.0.0"
  );
}

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

async function recordGlobalPinFailure(env, link) {
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
    await logEvent(env, { type: "global-lock", slug: link.slug, label: link.label, message: "Global PIN damping started" });
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
    await logEvent(env, { type: "lock", slug, message: "PIN lockout started" });
  }
  await env.KV.put(key, JSON.stringify(next), { expirationTtl: 24 * 3600 });
  return retryAfter;
}

async function clearPinFailures(env, slug, request) {
  await env.KV.delete(await bruteKey(slug, request));
}

function retryJson(message, retryAfter) {
  return json({ error: message, retryAfter }, 429, { "retry-after": String(retryAfter) });
}

async function gatePin(request, env, link, pin) {
  if (!link.pinHash) return null;
  const globalLock = await currentGlobalLock(env, link.slug);
  if (globalLock.retryAfter) return retryJson("too many attempts for this link", globalLock.retryAfter);
  const lock = await currentLock(env, link.slug, request);
  if (lock.retryAfter) return retryJson("too many wrong attempts", lock.retryAfter);
  if (await pinMatches(link, pin)) {
    await clearPinFailures(env, link.slug, request);
    return null;
  }
  const retryAfter = await recordPinFailure(env, link.slug, request);
  if (retryAfter) return retryJson("too many wrong attempts", retryAfter);
  const globalRetry = await recordGlobalPinFailure(env, link);
  if (globalRetry) return retryJson("too many attempts for this link", globalRetry);
  return json({ error: "wrong PIN" }, 403);
}

function normalizeSettings(input = {}) {
  const concurrency = clamp(Number(input.concurrency) || 2, 1, 4);
  const chunkMB = [8, 16, 32].includes(Number(input.chunkMB)) ? Number(input.chunkMB) : 8;
  const maxTransferBytes = clamp(Number(input.maxTransferBytes) || MAX_DEFAULT_BYTES, 1, MAX_DEFAULT_BYTES);
  return {
    concurrency,
    chunkMB,
    perUploaderFolders: !!input.perUploaderFolders,
    maxTransferBytes,
  };
}

function normalizeTheme(input = {}) {
  return {
    logoUrl: safeUrl(input.logoUrl),
    backgroundUrl: safeUrl(input.backgroundUrl),
    backgroundColor: safeColor(input.backgroundColor) || "#101418",
    accentColor: safeColor(input.accentColor) || "#f2a33c",
    welcome: cleanText(input.welcome || "Send the full-resolution photos and videos here.", 180),
    promoTitle: cleanText(input.promoTitle || "", 80),
    promoText: cleanText(input.promoText || "", 180),
    ctaLabel: cleanText(input.ctaLabel || "", 40),
    ctaUrl: safeUrl(input.ctaUrl),
    videoUrl: safeVideoUrl(input.videoUrl),
  };
}

function normalizeNotify(input = {}) {
  return {
    enabled: !!input.enabled,
    start: input.start !== false,
    complete: !!input.complete,
  };
}

function publicLink(link) {
  return {
    slug: link.slug,
    label: link.label,
    requiresPin: !!link.pinHash,
    expiresAt: link.expiresAt || null,
    expired: linkState(link) === "expired",
    settings: normalizeSettings(link.settings),
    theme: normalizeTheme(link.theme),
    appName: APP_NAME,
  };
}

function adminLink(link, stats = {}) {
  return {
    slug: link.slug,
    label: link.label,
    folderId: link.folderId,
    folderName: link.folderName || null,
    hasPin: !!link.pinHash,
    createdAt: link.createdAt,
    expiresAt: link.expiresAt || null,
    state: linkState(link),
    settings: normalizeSettings(link.settings),
    theme: normalizeTheme(link.theme),
    notify: normalizeNotify(link.notify),
    stats: normalizeStats(stats),
  };
}

function normalizeStats(stats = {}) {
  stats = stats || {};
  return {
    opens: Number(stats.opens) || 0,
    sessions: Number(stats.sessions) || 0,
    files: Number(stats.files) || 0,
    bytes: Number(stats.bytes) || 0,
  };
}

async function getPublicLink(env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  return json(publicLink(link));
}

async function verifyPin(request, env) {
  const b = await request.json().catch(() => ({}));
  const link = await env.KV.get(`link:${b.linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  if (linkState(link) === "expired") return json({ error: "this link has expired" }, 410);
  const failure = await gatePin(request, env, link, b.pin);
  if (failure) return failure;
  return json({ ok: true });
}

async function logOpened(request, env) {
  const b = await request.json().catch(() => ({}));
  const link = await env.KV.get(`link:${b.linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  if (linkState(link) === "expired") return json({ error: "this link has expired" }, 410);
  await bumpStats(env, link.slug, { opens: 1 });
  await logEvent(env, { type: "open", slug: link.slug, label: link.label });
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
  await recordSessionStart(env, link, cleanText(b.uploader || "anonymous", 60), sessionId);
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
  const { linkId, pin, filename, size, mimeType, uploaderName, sessionId } = b;

  if (!linkId || !filename || !Number.isFinite(size) || size <= 0) {
    return json({ error: "linkId, filename and size are required" }, 400);
  }
  const link = await env.KV.get(`link:${linkId}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  if (linkState(link) === "expired") return json({ error: "this link has expired" }, 410);
  const failure = await gatePin(request, env, link, pin);
  if (failure) return failure;

  const settings = normalizeSettings(link.settings);
  if (size > settings.maxTransferBytes) return json({ error: "file too large for this link" }, 413);

  const safeName = sanitizeFilename(filename);
  const uploader = cleanText(uploaderName || "anonymous", 60) || "anonymous";
  const folderId = await resolveUploaderFolder(env, link, uploader);
  const tok = await accessToken(env);
  const origin = new URL(request.url).origin;

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
        description: `Uploaded by ${uploader} via ${APP_NAME} (${linkId})`,
        appProperties: { uploader, dropLink: linkId },
      }),
    }
  );
  if (!r.ok) {
    return json({ error: "Drive session failed: " + (await r.text()).slice(0, 300) }, 502);
  }
  const sessionUri = r.headers.get("location");
  if (!sessionUri) return json({ error: "Drive returned no session URI" }, 502);

  await recordSessionStart(env, link, uploader, sessionId);
  return json({ sessionUri });
}

async function recordSessionStart(env, link, uploader, sessionId) {
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
  await logEvent(env, { type: "start", slug: link.slug, label: link.label, uploader });
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
  await env.KV.put(`up:${linkId}:${Date.now()}:${randomSlug(4)}`, "1", {
    metadata: meta,
    expirationTtl: 365 * 86400,
  });
  await bumpStats(env, link.slug, { files: 1, bytes: meta.s });
  await logEvent(env, {
    type: "file",
    slug: link.slug,
    label: link.label,
    uploader: meta.u,
    file: meta.n,
    bytes: meta.s,
  });
  const notify = normalizeNotify(link.notify);
  if (notify.enabled && notify.complete) {
    await sendNotify(env, {
      subject: `${APP_NAME}: ${meta.u} uploaded ${meta.n}`,
      html: `<p><b>${escapeHtml(meta.u)}</b> uploaded <b>${escapeHtml(meta.n)}</b> to <b>${escapeHtml(link.label)}</b>.</p>`,
    });
  }
  return json({ ok: true });
}

async function listLinks(env) {
  const links = await getAllLinks(env);
  const out = [];
  for (const link of links) out.push(adminLink(link, await env.KV.get(`stats:${link.slug}`, "json")));
  out.sort((a, b) => b.createdAt - a.createdAt);
  return json({ links: out });
}

async function createLink(request, env) {
  const b = await request.json().catch(() => ({}));
  let { slug, label, pin, expiresDays, folderId, folderName } = b;
  if (!label) return json({ error: "label is required" }, 400);
  slug = slugify(slug) || randomSlug();
  if (await env.KV.get(`link:${slug}`)) return json({ error: `slug "${slug}" already exists` }, 409);

  let resolvedFolderName = cleanText(folderName || "", 80) || null;
  if (!folderId) {
    const folder = await driveCreateFolder(env, resolvedFolderName || label, env.DRIVE_PARENT_ID || undefined);
    folderId = folder.id;
    resolvedFolderName = folder.name;
  }

  const salt = pin ? randomHex() : null;
  const days = clamp(Number(expiresDays) || 0, 0, MAX_EXPIRY_DAYS);
  const link = {
    slug,
    label: cleanText(label, 80),
    folderId: cleanText(folderId, 160),
    folderName: resolvedFolderName,
    pinSalt: salt,
    pinHash: salt ? await pinHash(pin, salt) : null,
    createdAt: Date.now(),
    expiresAt: days > 0 ? Date.now() + days * 86400_000 : null,
    settings: normalizeSettings(b.settings),
    theme: normalizeTheme(b.theme),
    notify: normalizeNotify(b.notify),
  };
  const opts = {};
  if (link.expiresAt) opts.expirationTtl = Math.ceil((link.expiresAt - Date.now()) / 1000) + 30 * 86400;
  await env.KV.put(`link:${slug}`, JSON.stringify(link), opts);
  await env.KV.put(`stats:${slug}`, JSON.stringify(normalizeStats()), opts);
  await addLinkToIndex(env, slug);
  await logEvent(env, { type: "linknew", slug, label: link.label });
  return json({ ok: true, slug, folderId, url: `/d/${slug}` });
}

async function patchLink(request, env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const b = await request.json().catch(() => ({}));
  if ("label" in b) link.label = cleanText(b.label, 80) || link.label;
  if ("pin" in b) {
    if (b.pin) {
      link.pinSalt = randomHex();
      link.pinHash = await pinHash(b.pin, link.pinSalt);
    } else {
      link.pinSalt = null;
      link.pinHash = null;
    }
  }
  if ("expiresDays" in b) {
    const days = clamp(Number(b.expiresDays) || 0, 0, MAX_EXPIRY_DAYS);
    link.expiresAt = days > 0 ? Date.now() + days * 86400_000 : null;
  }
  if ("settings" in b) link.settings = normalizeSettings({ ...link.settings, ...b.settings });
  if ("theme" in b) link.theme = normalizeTheme({ ...link.theme, ...b.theme });
  if ("notify" in b) link.notify = normalizeNotify({ ...link.notify, ...b.notify });
  await env.KV.put(`link:${slug}`, JSON.stringify(link));
  await logEvent(env, { type: "linkedit", slug, label: link.label });
  return json(adminLink(link, await env.KV.get(`stats:${slug}`, "json")));
}

async function deleteLink(env, slug) {
  await env.KV.delete(`link:${slug}`);
  await removeLinkFromIndex(env, slug);
  await logEvent(env, { type: "linkdel", slug });
  return json({ ok: true });
}

async function listUploads(env, slug) {
  const uploads = await getUploads(env, slug);
  const totalBytes = uploads.reduce((t, u) => t + (u.s || 0), 0);
  return json({ uploads, count: uploads.length, totalBytes });
}

async function linkDetail(env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const uploads = await getUploads(env, slug);
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
  return json({
    appName: APP_NAME,
    totals,
    links: rows,
    active: await liveSnapshot(env),
    events: await recentEvents(env).catch(() => []),
  });
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

async function getUploads(env, slug) {
  const uploads = [];
  let cursor;
  do {
    let page;
    try {
      page = await env.KV.list({ prefix: `up:${slug}:`, cursor });
    } catch {
      return [];
    }
    for (const k of page.keys) if (k.metadata) uploads.push(k.metadata);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  uploads.sort((a, b) => b.at - a.at);
  return uploads;
}

async function bumpStats(env, slug, delta) {
  const key = `stats:${slug}`;
  const stats = normalizeStats(await env.KV.get(key, "json"));
  for (const [k, v] of Object.entries(delta)) stats[k] = (stats[k] || 0) + Number(v || 0);
  await env.KV.put(key, JSON.stringify(stats));
  return stats;
}

async function logEvent(env, event) {
  const ts = Date.now();
  const reverse = String(9_999_999_999_999 - ts).padStart(13, "0");
  const record = {
    t: cleanText(event.type || "event", 20),
    at: ts,
    s: cleanText(event.slug || "", 60),
    l: cleanText(event.label || "", 100),
    u: cleanText(event.uploader || "", 80),
    f: cleanText(event.file || "", 160),
    b: Number(event.bytes) || 0,
    m: cleanText(event.message || "", 160),
  };
  await env.KV.put(`ev:${reverse}:${randomSlug(5)}`, JSON.stringify(record), {
    expirationTtl: 90 * 86400,
  });
}

async function recentEvents(env, limit = 60) {
  const events = [];
  let cursor;
  do {
    const page = await env.KV.list({ prefix: "ev:", cursor, limit: Math.min(100, limit) });
    for (const k of page.keys) {
      const ev = await env.KV.get(k.name, "json");
      if (ev) events.push(ev);
      if (events.length >= limit) break;
    }
    cursor = page.list_complete || events.length >= limit ? null : page.cursor;
  } while (cursor);
  return events;
}

async function sendNotify(env, msg) {
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
      html: msg.html,
    }),
  }).catch((err) => console.error("notify failed", err.message));
}

function normalizeLiveSession(input) {
  const files = Array.isArray(input.files)
    ? input.files.slice(0, 20).map((f) => ({
        name: cleanText(f.name || f.n || "file", 120),
        sent: Number(f.sent) || 0,
        size: Number(f.size || f.s) || 0,
        state: cleanText(f.state || f.st || "uploading", 20),
      }))
    : [];
  const total = Number(input.total) || files.reduce((t, f) => t + f.size, 0);
  const sent = Number(input.sent) || files.reduce((t, f) => t + f.sent, 0);
  return {
    id: cleanText(input.sessionId || input.id || crypto.randomUUID(), 100),
    slug: cleanText(input.slug || "", 60),
    label: cleanText(input.label || "", 100),
    uploader: cleanText(input.uploader || "anonymous", 60),
    sent,
    total,
    pct: total ? Math.min(100, Math.floor((sent / total) * 100)) : 0,
    files,
    state: cleanText(input.state || "uploading", 20),
    lastSeen: Date.now(),
  };
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function sanitizeFilename(value) {
  return cleanText(value, 200).replace(/[\\/:*?"<>|]/g, "_") || "upload.bin";
}

function sanitizeFolderName(value) {
  return cleanText(value, 60).replace(/[\\/:*?"<>|]/g, "_") || "anonymous";
}

function safeUrl(value) {
  const s = cleanText(value || "", 400);
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
}

function safeVideoUrl(value) {
  const s = safeUrl(value);
  if (!s) return "";
  const u = new URL(s);
  if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
    const id = u.hostname.includes("youtu.be") ? u.pathname.slice(1) : u.searchParams.get("v");
    return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : "";
  }
  if (u.hostname.includes("vimeo.com")) {
    const id = u.pathname.split("/").filter(Boolean).pop();
    return id ? `https://player.vimeo.com/video/${encodeURIComponent(id)}` : "";
  }
  return "";
}

function safeColor(value) {
  const s = cleanText(value || "", 20);
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : "";
}

function driveQueryEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}
