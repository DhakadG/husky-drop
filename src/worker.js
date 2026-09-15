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
//   drop-api.js  - public /api drop-link endpoints (sessions, progress, completions)
//   admin-api.js - /api/admin drop-link management, overview, cleanup
//   share*.js    - outbound Share Links (gallery + redirect modes)

import {
  ADMIN_SESSION_TTL,
  SECURITY_HEADERS,
  cleanText,
  clientIp,
  escapeHtml,
  getCookie,
  json,
  linkState,
  retryJson,
  timingSafeEqual,
} from "./util.js";
import { liveStub, logEvent, rateLimitRemote } from "./store.js";
import {
  getShareMeta,
  listShareFiles,
  logShareOpened,
  shareRedirect,
  shareSummary,
  shareTrack,
  verifySharePin,
} from "./share.js";
import { createShare, deleteShare, listShares, patchShare } from "./share-admin.js";
import { refreshShareDownload, shareDownload, shareFileInfo, shareThumbnail } from "./share-media.js";
import { createShareZipTicket, shareZipDownload } from "./share-zip.js";
import {
  adminAuthCallback,
  adminAuthLogin,
  authCallback,
  authLogin,
  authLogout,
  mintAdminSession,
  verifyAdminSession,
} from "./auth.js";
import {
  getPublicLink,
  verifyPin,
  logOpened,
  logProgress,
  createSession,
  logComplete,
  logClientError,
  dropTrack,
} from "./drop-api.js";
import {
  browseAdminDriveFolders,
  createAdminDriveFolder,
  listLinks,
  createLink,
  patchLink,
  deleteLink,
  listUploads,
  trashUpload,
  linkDetail,
  adminOverview,
  adminTimeseries,
  adminEvents,
  driveThumbMeta,
  cleanupInactiveRecords,
  linkFolder,
} from "./admin-api.js";
import {
  deletePreview,
  listPendingPreviews,
  previewSource,
  previewsOverview,
  putPreview,
  reindexPreviews,
  reportPreviewRun,
  retryFailedPreviews,
  startPreviewRun,
} from "./previews.js";
import {
  controlImageJob,
  imageJobItems,
  imageSource,
  listImageJobs,
  nextImageBatch,
  planImageJob,
  putImageResult,
  reportImageBatch,
} from "./images.js";

export { LiveTracker } from "./live.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p.startsWith("/api/")) return await api(request, env, url, ctx);
      if (p === "/") return servePage(env, url, "/index.html");
      if (p === "/privacy") return servePage(env, url, "/privacy.html");
      if (p === "/terms") return servePage(env, url, "/terms.html");
      if (p.startsWith("/d/")) return servePage(env, url, "/drop.html");
      if (p.startsWith("/s/")) return servePage(env, url, "/share.html");
      if (p === "/admin" || p.startsWith("/admin/")) return servePage(env, url, "/admin.html");
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
  if (type.includes("text/html") && (env.CF_BEACON_TOKEN || env.CLARITY_PROJECT_ID)) {
    let html = await res.text();
    const scripts = [];
    if (env.CF_BEACON_TOKEN) {
      // Inject the Cloudflare Web Analytics beacon only when a token is
      // configured, keeping pages dependency-free otherwise.
      scripts.push(`<script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token":"${escapeHtml(env.CF_BEACON_TOKEN)}"}'></script>`);
    }
    // The Clarity bootstrap is inline (not src=), so a strict CSP blocks it
    // outright unless the script carries a nonce - host-allowlisting
    // clarity.ms in script-src only covers the *fetched* tag it creates.
    let scriptNonce = "";
    if (env.CLARITY_PROJECT_ID) {
      scriptNonce = crypto.randomUUID();
      scripts.push(`<script nonce="${scriptNonce}">(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y)})(window,document,"clarity","script","${escapeHtml(env.CLARITY_PROJECT_ID)}");</script>`);
    }
    const injection = scripts.join("");
    html = html.includes("</body>") ? html.replace("</body>", `${injection}</body>`) : html + injection;
    return secureAsset(new Response(html, { status: res.status, headers: { "content-type": type } }), scriptNonce);
  }
  return secureAsset(res);
}

function secureAsset(response, scriptNonce) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  if (scriptNonce) {
    headers.set(
      "content-security-policy",
      SECURITY_HEADERS["content-security-policy"].replace("script-src 'self'", `script-src 'self' 'nonce-${scriptNonce}'`),
    );
  }
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
    return getPublicLink(request, env, p.slice("/api/link/".length));
  }
  if (m === "POST" && p === "/api/verify") return verifyPin(request, env);
  if (m === "POST" && p === "/api/opened") return logOpened(request, env, ctx);
  if (m === "POST" && p === "/api/progress") return logProgress(request, env, ctx);
  if (m === "POST" && p === "/api/session") return createSession(request, env);
  if (m === "POST" && p === "/api/complete") return logComplete(request, env);
  if (m === "POST" && p === "/api/client-error") return logClientError(request, env);
  if (m === "POST" && p === "/api/drop/track") return dropTrack(request, env, ctx);

  // Public share-link endpoints (gallery + redirect modes).
  if (m === "GET" && p.startsWith("/api/share/meta/")) {
    return getShareMeta(request, env, p.slice("/api/share/meta/".length));
  }
  if (m === "POST" && p === "/api/share/verify") return verifySharePin(request, env);
  if (m === "POST" && p === "/api/share/opened") return logShareOpened(request, env);
  if (m === "POST" && p === "/api/share/track") return shareTrack(request, env);
  if (m === "POST" && p === "/api/share/list") return listShareFiles(request, env);
  if (m === "POST" && p === "/api/share/summary") return shareSummary(request, env);
  if (m === "POST" && p === "/api/share/refresh-dl") return refreshShareDownload(request, env);
  if (m === "POST" && p === "/api/share/file-info") return shareFileInfo(request, env);
  if (m === "POST" && p === "/api/share/zip-ticket") return createShareZipTicket(request, env);
  if (m === "POST" && p === "/api/share/redirect") return shareRedirect(request, env);
  if (m === "GET" && p.startsWith("/api/share/thumb/")) {
    const parts = p.slice("/api/share/thumb/".length).split("/");
    if (parts.length !== 2) return json({ error: "invalid thumbnail path" }, 400);
    return shareThumbnail(request, env, parts[0], parts[1], ctx);
  }
  if ((m === "GET" || m === "HEAD") && p.startsWith("/api/share/dl/")) {
    return shareDownload(request, env, p.slice("/api/share/dl/".length), ctx);
  }
  if (m === "GET" && p.startsWith("/api/share/zip/")) {
    return shareZipDownload(request, env, p.slice("/api/share/zip/".length));
  }

  // Google sign-in used only to attribute /s/ share-link viewing sessions.
  if (m === "GET" && p === "/api/auth/login") return authLogin(request, env, url);
  if (m === "GET" && p === "/api/auth/callback") return authCallback(request, env, url);
  if (m === "POST" && p === "/api/auth/logout") return authLogout();

  if (m === "GET" && p === "/api/admin/auth/login") return adminAuthLogin(request, env, url);
  if (m === "GET" && p === "/api/admin/auth/callback") return adminAuthCallback(request, env, url);
  if (m === "POST" && p === "/api/admin/login") return adminLogin(request, env);
  if (m === "POST" && p === "/api/admin/logout") return adminLogout();

  if (p.startsWith("/api/admin/")) {
    if (!(await isAdmin(request, env))) return json({ error: "unauthorized" }, 401);
    if (!sameOriginOk(request, url)) return json({ error: "bad origin" }, 403);
    if (m === "GET" && p === "/api/admin/me") return json({ ok: true });
    if (m === "GET" && p === "/api/admin/overview") return adminOverview(env);
    if (m === "POST" && p === "/api/admin/maintenance/cleanup") return cleanupInactiveRecords(request, env);
    if (m === "GET" && p === "/api/admin/timeseries") return adminTimeseries(env, url);
    if (m === "GET" && p === "/api/admin/links") return listLinks(env);
    if (m === "POST" && p === "/api/admin/links") return createLink(request, env, ctx);
    if (m === "POST" && p === "/api/admin/live/close") return closeLiveSession(request, env);
    if (m === "GET" && p === "/api/admin/events") return adminEvents(env, url);
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
    if (m === "POST" && p.startsWith("/api/admin/links/") && p.endsWith("/folder")) {
      return linkFolder(env, p.slice("/api/admin/links/".length, -"/folder".length));
    }
    if (m === "PATCH" && p.startsWith("/api/admin/links/")) {
      return patchLink(request, env, p.slice("/api/admin/links/".length));
    }
    if (m === "DELETE" && p.startsWith("/api/admin/links/")) {
      return deleteLink(request, env, p.slice("/api/admin/links/".length));
    }
    if (p.startsWith("/api/admin/previews/")) {
      const rest = p.slice("/api/admin/previews/".length);
      if (m === "GET" && rest === "pending") return listPendingPreviews(request, env);
      if (m === "GET" && rest === "overview") return previewsOverview(request, env);
      if (m === "POST" && rest === "report") return reportPreviewRun(request, env);
      if (m === "POST" && rest === "run") return startPreviewRun(request, env);
      if (m === "POST" && rest === "retry") return retryFailedPreviews(request, env);
      if (m === "POST" && rest === "reindex") return reindexPreviews(request, env);
      if (m === "GET" && rest.startsWith("source/")) return previewSource(request, env, rest.slice(7));
      if (m === "PUT" && rest) return putPreview(request, env, rest);
      if (m === "DELETE" && rest) return deletePreview(env, rest);
    }
    if (p.startsWith("/api/admin/images/")) {
      const seg = p.slice("/api/admin/images/".length).split("/");
      if (m === "POST" && seg[0] === "plan") return planImageJob(request, env);
      if (m === "GET" && seg[0] === "jobs" && !seg[1]) return listImageJobs(env);
      if (m === "GET" && seg[0] === "source" && seg[1]) return imageSource(request, env, seg[1]);
      if (seg[0] === "jobs" && seg[1]) {
        const jobId = cleanText(seg[1], 40);
        if (m === "GET" && seg[2] === "next") return nextImageBatch(request, env, jobId);
        if (m === "GET" && seg[2] === "items") return imageJobItems(env, jobId);
        if (m === "POST" && seg[2] === "report") return reportImageBatch(request, env, jobId);
        if (m === "PUT" && seg[2] === "file" && seg[3]) return putImageResult(request, env, jobId, seg[3]);
        if (m === "POST" && ["start", "pause", "resume", "cancel"].includes(seg[2])) return controlImageJob(request, env, jobId, seg[2]);
      }
    }
    if (m === "DELETE" && p.startsWith("/api/admin/uploads/")) {
      const [uploadSlug, fileId] = p.slice("/api/admin/uploads/".length).split("/");
      return trashUpload(request, env, uploadSlug, fileId || "");
    }
    if (m === "GET" && p.startsWith("/api/admin/uploads/")) {
      return listUploads(env, p.slice("/api/admin/uploads/".length), url);
    }
    if (m === "GET" && p.startsWith("/api/admin/thumb/")) {
      return driveThumbMeta(env, p.slice("/api/admin/thumb/".length));
    }
    if (m === "GET" && p === "/api/admin/drive/folders") return browseAdminDriveFolders(env, url);
    if (m === "POST" && p === "/api/admin/drive/folders") return createAdminDriveFolder(request, env);
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
