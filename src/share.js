// Share links (outbound): let friends browse/download chosen Drive folders
// via /s/:slug. Two modes:
//  - "gallery": folder stays private; the Worker lists it and streams files
//    through short-lived HMAC-signed download tokens. PIN + expiry enforced.
//  - "redirect": grants Drive "anyone with link, reader" on the folders and
//    hands out drive.google.com URLs. Revoked on pause/delete/expiry.

import {
  APP_NAME,
  MAX_EXPIRY_DAYS,
  SHARE_TOKEN_TTL,
  SHARE_ZIP_TICKET_TTL,
  b64url,
  b64urlDecode,
  clamp,
  cleanText,
  json,
  makePinFields,
  normalizeEvent,
  normalizeShareStats,
  normalizeTheme,
  randomSlug,
  sanitizeFilename,
  sha256,
  shareState,
  slugify,
  timingSafeEqual,
} from "./util.js";
import { driveFileMeta, driveGrantAnyoneReader, driveListFolder, driveRevokePermission, driveThumbnail, driveThumbnailSize, accessToken } from "./drive.js";
import { bumpShareStats, gatePin, liveStub, logEvent, mergeEventsKV, rateLimitRemote } from "./store.js";
import { getViewer } from "./auth.js";

const BLOCKED_PUBLIC_DOWNLOAD_EXTS = new Set([
  "7z",
  "ace",
  "apk",
  "app",
  "arj",
  "bat",
  "bin",
  "bz2",
  "cab",
  "cmd",
  "com",
  "cpl",
  "deb",
  "dmg",
  "dll",
  "docm",
  "dotm",
  "exe",
  "gz",
  "hta",
  "img",
  "ipa",
  "iso",
  "jar",
  "js",
  "jse",
  "lnk",
  "msi",
  "msp",
  "pkg",
  "pl",
  "pptm",
  "ps1",
  "psd1",
  "psm1",
  "py",
  "pyc",
  "rar",
  "reg",
  "rpm",
  "run",
  "scr",
  "sh",
  "tar",
  "tgz",
  "vbe",
  "vbs",
  "wsf",
  "wsh",
  "xlam",
  "xlsm",
  "xz",
  "zip",
]);

const BLOCKED_PUBLIC_DOWNLOAD_MIME = [
  /^application\/(x-)?(7z|gzip|java-archive|vnd\.rar|zip)/i,
  /^application\/(x-)?(bzip2|cab|compress|compressed|gtar|rar-compressed|tar)/i,
  /^application\/(x-)?(apple-diskimage|dosexec|executable|iso9660-image|mach-binary|msdownload|msi|ms-installer|msdos-program|sh)/i,
  /^application\/vnd\.(android\.package-archive|microsoft\.portable-executable)/i,
  /^application\/x-httpd-php/i,
  /^text\/x-(shellscript|perl|php|python|ruby)/i,
];

export function parseDriveFolderInput(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return "";
}

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

export async function getShareIndex(env) {
  return (await env.KV.get("shares:index", "json")) || [];
}

export async function getAllShares(env) {
  const slugs = await getShareIndex(env);
  const shares = [];
  for (const slug of slugs) {
    const share = await env.KV.get(`share:${slug}`, "json");
    if (share) shares.push(share);
  }
  return shares;
}

export async function listShares(env) {
  const shares = await getAllShares(env);
  const out = [];
  for (const share of shares) {
    out.push(adminShare(share, await env.KV.get(`sstats:${share.slug}`, "json")));
  }
  out.sort((a, b) => b.createdAt - a.createdAt);
  return json({ shares: out });
}

export async function createShare(request, env) {
  const b = await request.json().catch(() => ({}));
  const label = cleanText(b.label || "", 80);
  if (!label) return json({ error: "label is required" }, 400);
  const slug = slugify(b.slug) || randomSlug();
  if (await env.KV.get(`share:${slug}`)) return json({ error: `slug "${slug}" already exists` }, 409);

  const rawFolders = Array.isArray(b.folders) ? b.folders : String(b.folders || "").split(/[,\n]/);
  const folderIds = [...new Set(rawFolders.map(parseDriveFolderInput).filter(Boolean))].slice(0, 10);
  if (!folderIds.length) return json({ error: "at least one Drive folder ID or URL is required" }, 400);

  const folderNames = [];
  if (env.GOOGLE_CLIENT_ID) {
    for (const id of folderIds) {
      const meta = await driveFileMeta(env, id);
      if (!meta) return json({ error: `folder ${id} was not found in Drive` }, 400);
      if (meta.mimeType !== "application/vnd.google-apps.folder") {
        return json({ error: `${meta.name || id} is not a folder` }, 400);
      }
      folderNames.push(meta.name || id);
    }
  } else {
    for (const id of folderIds) folderNames.push(id);
  }

  const mode = b.mode === "redirect" ? "redirect" : "gallery";
  const days = clamp(Number(b.expiresDays) || 0, 0, MAX_EXPIRY_DAYS);
  const share = {
    slug,
    label,
    mode,
    folderIds,
    folderNames,
    allowZip: b.allowZip !== false,
    requireAuth: b.requireAuth !== false,
    disabled: false,
    permissionIds: {},
    ...(b.pin ? await makePinFields(b.pin) : { pinSalt: null, pinHash: null, pinAlgo: null }),
    createdAt: Date.now(),
    expiresAt: days > 0 ? Date.now() + days * 86400_000 : null,
    theme: normalizeTheme(b.theme),
  };

  if (mode === "redirect" && env.GOOGLE_CLIENT_ID) {
    for (const id of folderIds) {
      share.permissionIds[id] = await driveGrantAnyoneReader(env, id);
    }
  }

  await env.KV.put(`share:${slug}`, JSON.stringify(share));
  await env.KV.put(`sstats:${slug}`, JSON.stringify(normalizeShareStats()));
  const index = await getShareIndex(env);
  if (!index.includes(slug)) {
    index.push(slug);
    await env.KV.put("shares:index", JSON.stringify(index));
  }
  await logEvent(env, { type: "sharenew", slug, label }, request);
  return json({ ok: true, slug, url: `/s/${slug}` });
}

export async function patchShare(request, env, slug) {
  const share = await env.KV.get(`share:${slug}`, "json");
  if (!share) return json({ error: "share not found" }, 404);
  const b = await request.json().catch(() => ({}));
  if ("label" in b) share.label = cleanText(b.label, 80) || share.label;
  if ("pin" in b) {
    if (b.pin) Object.assign(share, await makePinFields(b.pin));
    else {
      share.pinSalt = null;
      share.pinHash = null;
      share.pinAlgo = null;
    }
  }
  if ("allowZip" in b) share.allowZip = !!b.allowZip;
  if ("requireAuth" in b) share.requireAuth = !!b.requireAuth;
  if ("expiresDays" in b) {
    const days = clamp(Number(b.expiresDays) || 0, 0, MAX_EXPIRY_DAYS);
    share.expiresAt = days > 0 ? Date.now() + days * 86400_000 : null;
  }
  if ("disabled" in b) {
    share.disabled = !!b.disabled;
    // Pausing a redirect share revokes Drive access; resuming re-grants it.
    if (share.mode === "redirect" && env.GOOGLE_CLIENT_ID) {
      if (share.disabled) {
        await revokeSharePermissions(env, share);
      } else {
        for (const id of share.folderIds) {
          if (!share.permissionIds[id]) {
            share.permissionIds[id] = await driveGrantAnyoneReader(env, id);
          }
        }
      }
    }
  }
  await env.KV.put(`share:${slug}`, JSON.stringify(share));
  await logEvent(env, { type: "shareedit", slug, label: share.label }, request);
  return json(adminShare(share, await env.KV.get(`sstats:${slug}`, "json")));
}

export async function revokeSharePermissions(env, share) {
  if (!env.GOOGLE_CLIENT_ID) return;
  for (const [folderId, permId] of Object.entries(share.permissionIds || {})) {
    if (permId) await driveRevokePermission(env, folderId, permId);
  }
  share.permissionIds = {};
}

export async function deleteShare(request, env, slug) {
  const share = await env.KV.get(`share:${slug}`, "json");
  if (share) await revokeSharePermissions(env, share);
  await env.KV.delete(`share:${slug}`);
  await env.KV.delete(`sstats:${slug}`);
  const index = (await getShareIndex(env)).filter((s) => s !== slug);
  await env.KV.put("shares:index", JSON.stringify(index));
  await logEvent(env, { type: "sharedel", slug }, request);
  return json({ ok: true });
}

// Expired shares are revoked lazily the first time anyone touches them after
// expiry (no cron needed on the free tier).
export async function loadActiveShare(env, slug) {
  const share = await env.KV.get(`share:${slug}`, "json");
  if (!share) return { share: null, error: json({ error: "share not found" }, 404) };
  const state = shareState(share);
  if (state === "expired") {
    if (share.mode === "redirect" && Object.keys(share.permissionIds || {}).length) {
      await revokeSharePermissions(env, share);
      await env.KV.put(`share:${slug}`, JSON.stringify(share));
    }
    return { share: null, error: json({ error: "this share link has expired" }, 410) };
  }
  if (state === "paused") return { share: null, error: json({ error: "this share link is paused" }, 403) };
  return { share, error: null };
}

export async function getShareMeta(request, env, slug) {
  const raw = await env.KV.get(`share:${slug}`, "json");
  if (!raw) return json({ error: "share not found" }, 404);
  const requiresAuth = raw.requireAuth !== false && !!env.GOOGLE_CLIENT_ID;
  const viewer = requiresAuth ? await getViewer(request, env) : null;
  return json({
    slug: raw.slug,
    label: raw.label,
    mode: raw.mode,
    requiresPin: !!raw.pinHash,
    requiresAuth,
    viewer,
    allowZip: raw.allowZip !== false,
    state: shareState(raw),
    expiresAt: raw.expiresAt || null,
    theme: normalizeTheme(raw.theme),
    appName: APP_NAME,
  });
}

// Blocks access to gated endpoints until the guest has signed in with
// Google, when the share owner has required it. Placed before the PIN gate
// so the flow is "sign in, then enter the PIN" as one combined screen.
async function requireViewer(request, env, share) {
  if (share.requireAuth === false || !env.GOOGLE_CLIENT_ID) return { viewer: null, error: null };
  const viewer = await getViewer(request, env);
  if (!viewer) {
    return { viewer: null, error: json({ error: "sign-in required", authRequired: true }, 401) };
  }
  return { viewer, error: null };
}

export async function verifySharePin(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  return json({ ok: true });
}

export async function logShareOpened(request, env) {
  const b = await request.json().catch(() => ({}));
  const slug = cleanText(b.slug || "", 60);
  const share = await env.KV.get(`share:${slug}`, "json");
  if (!share) return json({ error: "share not found" }, 404);
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
  return json({ ok: true });
}

// Batched browsing-session analytics beacon: the client queues folder
// navigation and media-view events and flushes them here (via
// navigator.sendBeacon, so it survives tab close) so the owner can see who
// viewed what and where load is slow, without a KV write per click.
export async function shareTrack(request, env) {
  const telemetryRate = await rateLimitRemote(env, `strack:${request.headers.get("cf-connecting-ip") || "local"}`, 90, 60);
  if (!telemetryRate.allowed) return json({ error: "slow down", retryAfter: telemetryRate.retryAfter }, 429);
  const b = await request.json().catch(() => ({}));
  const slug = cleanText(b.slug || "", 60);
  const share = await env.KV.get(`share:${slug}`, "json");
  if (!share) return json({ error: "share not found" }, 404);
  const viewer = await getViewer(request, env);
  const events = Array.isArray(b.events) ? b.events.slice(0, 40).map(normalizeTelemetryEvent) : [];
  const sessionId = cleanText(b.sessionId || "", 40);
  if (!events.length) return json({ ok: true });
  await env.KV.put(
    `telemetry:share:${slug}:${sessionId || "anonymous"}:${Date.now()}:${randomSlug(4)}`,
    JSON.stringify({ at: Date.now(), startedAt: Number(b.startedAt) || 0, viewer: viewer?.email || "anonymous", events }),
    { expirationTtl: 30 * 24 * 3600 },
  );
  const navEvents = events.filter((e) => e.t === "nav");
  const viewEvents = events.filter((e) => e.t === "view" || e.t === "media_view_start");
  const clickEvents = events.filter((e) => e.t === "click");
  const meaningfulTypes = new Set(["download", "download_handoff", "zip_requested", "zip_started", "zip_failed", "file_info_open", "layout", "client_error", "promise_rejection", "performance", "session_end", "media_view_end"]);
  const otherEvents = events.filter((e) => meaningfulTypes.has(e.t));
  const records = [];
  if (navEvents.length || viewEvents.length) {
    const last = viewEvents[viewEvents.length - 1] || navEvents[navEvents.length - 1] || {};
    records.push(
      normalizeEvent(
        {
          type: "share-browse",
          slug,
          label: share.label,
          uploader: viewer?.email || "anonymous",
          file: cleanText(last.name || "", 160),
          message: `viewed ${viewEvents.length} file(s), browsed ${navEvents.length} folder(s)`,
          sessionId,
        },
        request,
      ),
    );
  }
  if (clickEvents.length) {
    const last = clickEvents.at(-1);
    records.push(normalizeEvent({
      type: "share-clicks",
      slug,
      label: share.label,
      uploader: viewer?.email || "anonymous",
      file: last.name,
      count: clickEvents.length,
      message: `${clickEvents.length} interaction${clickEvents.length === 1 ? "" : "s"}; last: ${last.name}`,
      sessionId,
    }, request));
  }
  for (const e of otherEvents) {
    const rawType = cleanText(e?.t || "event", 32);
    records.push(
      normalizeEvent(
        {
          type: rawType === "download" || rawType === "download_handoff" || rawType === "dl" ? "share-dl" : rawType === "file_info_open" ? "share-file-info" : rawType.startsWith("share-") ? rawType : `share-${rawType}`,
          slug,
          label: share.label,
          uploader: viewer?.email || "anonymous",
          file: cleanText(e?.name || "", 160),
          message: telemetrySummary(e),
          sessionId,
        },
        request,
      ),
    );
  }
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

// A stable, non-reversible id for a Drive folder, used as the client-side
// navigation key so breadcrumbs/history/caching never depend on the
// short-lived signed "ls" token (which is re-minted, with a new signature,
// on every listing call and therefore compares unequal across requests).
async function folderFid(env, folderId) {
  return (await sha256(`fid:${folderId}:${env.SHARE_SIGNING_KEY || env.ADMIN_TOKEN || "dev"}`)).slice(0, 16);
}

export async function listShareFiles(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  if (!env.GOOGLE_CLIENT_ID) return json({ folders: [], allowZip: share.allowZip !== false });

  const resolved = await resolveShareTargets(env, share, b);
  if (resolved.error) return resolved.error;
  const targets = resolved.targets;
  const folderToken = resolved.folderToken;
  const single = !!folderToken || "folderIndex" in b;

  const folders = [];
  for (const [i, folderId] of targets) {
    const page = await driveListFolder(env, folderId, single ? cleanText(b.pageToken || "", 500) : "");
    const files = [];
    const subfolders = [];
    for (const f of page.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") {
        subfolders.push({
          fid: await folderFid(env, f.id),
          name: cleanText(f.name || "folder", 200),
          ls: await signShareToken(env, "ls", share.slug, f.id, 4 * 3600),
        });
        continue;
      }
      files.push(await publicShareFile(env, share, f));
    }
    folders.push({
      index: i,
      fid: folderToken ? await folderFid(env, folderId) : "",
      name: folderToken ? "" : share.folderNames[i] || `Folder ${i + 1}`,
      files,
      subfolders,
      nextPageToken: page.nextPageToken || "",
      loadedCount: files.length,
      hasMore: !!page.nextPageToken,
    });
  }
  return json({ folders, allowZip: share.allowZip !== false });
}

async function resolveShareTargets(env, share, body) {
  // Three listing modes:
  //  - root (default): every shared root folder at once
  //  - folderIndex: one root folder (pagination)
  //  - folderToken: a subfolder previously handed out as a signed "ls" token,
  //    so guests can browse the folder tree without ever seeing raw Drive IDs.
  const folderToken = cleanText(body.folderToken || "", 800);
  if (folderToken) {
    const parsedTok = await verifyShareToken(env, folderToken, "ls");
    if (!parsedTok || parsedTok.slug !== share.slug) {
      return { error: json({ error: "this folder view expired - reload the page" }, 403) };
    }
    return { folderToken, targets: [[0, parsedTok.fileId]] };
  }
  if ("folderIndex" in body) {
    const folderIndex = clamp(Number(body.folderIndex) || 0, 0, share.folderIds.length - 1);
    return { folderToken: "", targets: [[folderIndex, share.folderIds[folderIndex]]] };
  }
  return {
    folderToken: "",
    targets: share.folderIds.map((id, i) => [i, id]),
  };
}

async function publicShareFile(env, share, f) {
  const [{ token, expiresAt }, { token: thumbToken, expiresAt: thumbsExpireAt }] = await Promise.all([
    signShareTokenWithExpiry(env, "dl", share.slug, f.id),
    signShareTokenWithExpiry(env, "th", share.slug, f.id),
  ]);
  const img = f.imageMediaMetadata || {};
  const vid = f.videoMediaMetadata || {};
  const safety = publicDownloadSafety(f);
  let w = Number(img.width || vid.width) || 0;
  let h = Number(img.height || vid.height) || 0;
  // EXIF rotation of 90/270 means the rendered thumb is portrait.
  if (Number(img.rotation) % 2 === 1) [w, h] = [h, w];
  const thumbs = f.thumbnailLink
    ? Object.fromEntries(["base", "mid", "max"].map((tier) => [tier, `/api/share/thumb/${thumbToken}/${tier}`]))
    : {};
  return {
    id: f.id,
    name: cleanText(f.name || "file", 200),
    size: Number(f.size) || 0,
    mime: cleanText(f.mimeType || "", 100),
    at: Date.parse(f.modifiedTime || f.createdTime) || 0,
    thumb: thumbs.base || "",
    thumbs,
    thumbsExpireAt,
    w,
    h,
    aspect: w && h ? w / h : 0,
    dur: Number(vid.durationMillis) || 0,
    dl: `/api/share/dl/${token}`,
    dlExpiresAt: expiresAt,
    downloadBlocked: safety.blocked,
    downloadBlockReason: safety.reason,
  };
}

export async function shareSummary(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  if (!env.GOOGLE_CLIENT_ID) {
    return json({ files: 0, folders: 0, bytes: 0, images: 0, videos: 0, allowZip: share.allowZip !== false });
  }
  const resolved = await resolveShareTargets(env, share, b);
  if (resolved.error) return resolved.error;

  // Recurses into every subfolder rather than only counting the immediate
  // level: driveListFolder() is a flat, single-level listing, so a share
  // whose root only contains subfolders (no direct files) previously always
  // summarized as "0 files, 0 B" - the counts from inside those subfolders
  // were never walked at all.
  const summary = { files: 0, folders: 0, bytes: 0, images: 0, videos: 0, allowZip: share.allowZip !== false };
  const MAX_FOLDERS_WALKED = 500; // safety cap for pathologically large/deep trees
  const queue = resolved.targets.map(([, folderId]) => folderId);
  let visited = 0;
  while (queue.length && visited < MAX_FOLDERS_WALKED) {
    const folderId = queue.shift();
    visited++;
    let pageToken = "";
    do {
      const page = await driveListFolder(env, folderId, pageToken, { pageSize: 1000 });
      for (const f of page.files || []) {
        if (f.mimeType === "application/vnd.google-apps.folder") {
          summary.folders++;
          queue.push(f.id);
          continue;
        }
        summary.files++;
        summary.bytes += Number(f.size) || 0;
        if (/^image\//.test(f.mimeType || "")) summary.images++;
        if (/^video\//.test(f.mimeType || "")) summary.videos++;
      }
      pageToken = page.nextPageToken || "";
    } while (pageToken);
  }
  return json(summary);
}

export async function shareRedirect(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  if (share.mode !== "redirect") return json({ error: "not a redirect share" }, 400);
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  // Make sure the grant still exists (it may have been revoked while paused).
  if (env.GOOGLE_CLIENT_ID) {
    let changed = false;
    for (const id of share.folderIds) {
      if (!share.permissionIds[id]) {
        share.permissionIds[id] = await driveGrantAnyoneReader(env, id);
        changed = true;
      }
    }
    if (changed) await env.KV.put(`share:${share.slug}`, JSON.stringify(share));
  }
  const urls = share.folderIds.map((id) => `https://drive.google.com/drive/folders/${encodeURIComponent(id)}`);
  return json({ urls });
}

// ---- Short-lived HMAC download tokens (scoped, bound to slug + file) ----

async function shareSigningKey(env) {
  const secret = env.SHARE_SIGNING_KEY || `${env.ADMIN_TOKEN || "dev"}:hd-share-v1`;
  const seed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signShareToken(env, scope, slug, fileId, ttlSec = SHARE_TOKEN_TTL) {
  return (await signShareTokenWithExpiry(env, scope, slug, fileId, ttlSec)).token;
}

async function signShareTokenWithExpiry(env, scope, slug, fileId, ttlSec = SHARE_TOKEN_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${scope}.${slug}.${fileId}.${exp}`;
  const key = await shareSigningKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return {
    token: `${b64url(new TextEncoder().encode(body))}.${b64url(new Uint8Array(mac))}`,
    expiresAt: exp * 1000,
  };
}

export async function verifyShareToken(env, token, expectScope, options = {}) {
  const dot = String(token || "").indexOf(".");
  if (dot < 1) return null;
  let body;
  try {
    body = new TextDecoder().decode(b64urlDecode(token.slice(0, dot)));
  } catch {
    return null;
  }
  const key = await shareSigningKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  if (!timingSafeEqual(token.slice(dot + 1), b64url(new Uint8Array(mac)))) return null;
  const parts = body.split(".");
  if (parts.length !== 4) return null;
  const [scope, slug, fileId, exp] = parts;
  if (scope !== expectScope) return null;
  const expiresAt = Number(exp) * 1000;
  if (!options.allowExpired && expiresAt < Date.now()) return null;
  return { slug, fileId, expiresAt, expired: expiresAt < Date.now() };
}

function downloadTokenFrom(value) {
  const raw = cleanText(value || "", 1200);
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://share.local");
    const prefix = "/api/share/dl/";
    if (url.pathname.startsWith(prefix)) return url.pathname.slice(prefix.length);
  } catch {
    // Fall through to path parsing.
  }
  const marker = "/api/share/dl/";
  const i = raw.indexOf(marker);
  const token = i >= 0 ? raw.slice(i + marker.length) : raw;
  return token.split(/[?#]/)[0];
}

function fileExtension(name = "") {
  const clean = String(name || "")
    .split(/[?#]/)[0]
    .trim()
    .toLowerCase();
  const leaf = clean.split(/[\\/]/).pop() || "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 && dot < leaf.length - 1 ? leaf.slice(dot + 1) : "";
}

function publicDownloadSafety(file = {}) {
  const name = cleanText(file.name || "", 240);
  const mime = cleanText(file.mimeType || file.mime || "", 140);
  const ext = fileExtension(name);
  if (BLOCKED_PUBLIC_DOWNLOAD_EXTS.has(ext)) {
    return {
      blocked: true,
      reason: "This public share blocks executable, script, installer, and archive downloads.",
    };
  }
  if (mime && BLOCKED_PUBLIC_DOWNLOAD_MIME.some((rx) => rx.test(mime))) {
    return {
      blocked: true,
      reason: "This public share blocks executable, script, installer, and archive downloads.",
    };
  }
  return { blocked: false, reason: "" };
}

export async function refreshShareDownload(request, env) {
  const b = await request.json().catch(() => ({}));
  const oldToken = downloadTokenFrom(b.dl || b.token);
  const parsed = await verifyShareToken(env, oldToken, "dl", { allowExpired: true });
  if (!parsed) return json({ error: "invalid download token" }, 403);
  const slug = cleanText(b.slug || parsed.slug, 60);
  if (slug !== parsed.slug) return json({ error: "download token does not belong to this share" }, 403);
  const { share, error } = await loadActiveShare(env, slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  const [{ token, expiresAt }, { token: thumbToken, expiresAt: thumbsExpireAt }] = await Promise.all([
    signShareTokenWithExpiry(env, "dl", share.slug, parsed.fileId),
    signShareTokenWithExpiry(env, "th", share.slug, parsed.fileId),
  ]);
  return json({
    dl: `/api/share/dl/${token}`,
    dlExpiresAt: expiresAt,
    thumbs: Object.fromEntries(["base", "mid", "max"].map((tier) => [tier, `/api/share/thumb/${thumbToken}/${tier}`])),
    thumbsExpireAt,
  });
}

function normalizeTelemetryEvent(event = {}) {
  let data = {};
  if (event.data && typeof event.data === "object" && !Array.isArray(event.data)) {
    try {
      data = JSON.parse(JSON.stringify(event.data).slice(0, 1600));
    } catch {
      data = {};
    }
  }
  return {
    t: cleanText(event.t || "event", 40),
    name: cleanText(event.name || "", 160),
    at: Number(event.at) || Date.now(),
    mono: Math.max(0, Number(event.mono) || 0),
    data,
  };
}

function telemetrySummary(event) {
  const data = event.data || {};
  if (event.t === "media_view_end" && data.durationMs) return `viewed for ${Math.round(data.durationMs / 100) / 10}s`;
  if (event.t === "performance") return `TTFB ${Number(data.ttfbMs) || 0}ms; loaded ${Number(data.loadMs) || 0}ms`;
  if (event.t === "session_end") return `session ${Math.round((Number(data.elapsedMs) || 0) / 1000)}s`;
  if (event.t === "zip_failed" || event.t === "client_error" || event.t === "promise_rejection") return cleanText(data.message || event.name || event.t, 160);
  return cleanText(event.t.replaceAll("_", " "), 160);
}

// Full image metadata is deliberately fetched on demand. Returning every EXIF
// field in the 200-item gallery listing makes first paint slower and exposes
// location data before the viewer asks for it. The signed download token proves
// this file came from this share; auth/PIN gates are checked again here.
export async function shareFileInfo(request, env) {
  const b = await request.json().catch(() => ({}));
  const oldToken = downloadTokenFrom(b.dl || b.token);
  const parsed = await verifyShareToken(env, oldToken, "dl");
  if (!parsed) return json({ error: "invalid file token" }, 403);
  const slug = cleanText(b.slug || parsed.slug, 60);
  if (slug !== parsed.slug) return json({ error: "file token does not belong to this share" }, 403);
  const { share, error } = await loadActiveShare(env, slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const meta = await driveFileMeta(env, parsed.fileId);
  if (!meta?.id) return json({ error: "file not found" }, 404);
  const image = meta.imageMediaMetadata || {};
  const video = meta.videoMediaMetadata || {};
  let width = Number(image.width || video.width) || 0;
  let height = Number(image.height || video.height) || 0;
  if (Number(image.rotation) % 2 === 1) [width, height] = [height, width];
  return json({
    file: {
      id: meta.id,
      name: cleanText(meta.name || "file", 240),
      mime: cleanText(meta.mimeType || "", 140),
      size: Number(meta.size) || 0,
      createdAt: Date.parse(meta.createdTime) || 0,
      modifiedAt: Date.parse(meta.modifiedTime) || 0,
      width,
      height,
      megapixels: width && height ? Math.round((width * height) / 10000) / 100 : 0,
      durationMs: Number(video.durationMillis) || 0,
    },
    exif: {
      cameraMake: cleanText(image.cameraMake || "", 160),
      cameraModel: cleanText(image.cameraModel || "", 160),
      lens: cleanText(image.lens || "", 240),
      time: cleanText(image.time || "", 80),
      aperture: image.aperture ?? null,
      exposureTime: image.exposureTime ?? null,
      exposureBias: image.exposureBias ?? null,
      exposureMode: cleanText(image.exposureMode || "", 80),
      isoSpeed: image.isoSpeed ?? null,
      focalLength: image.focalLength ?? null,
      flashUsed: image.flashUsed ?? null,
      meteringMode: cleanText(image.meteringMode || "", 80),
      whiteBalance: cleanText(image.whiteBalance || "", 80),
      colorSpace: cleanText(image.colorSpace || "", 80),
      sensor: cleanText(image.sensor || "", 160),
      maxApertureValue: image.maxApertureValue ?? null,
      subjectDistance: image.subjectDistance ?? null,
      rotation: image.rotation ?? null,
      location: image.location && typeof image.location === "object"
        ? {
            latitude: Number(image.location.latitude) || null,
            longitude: Number(image.location.longitude) || null,
            altitude: Number(image.location.altitude) || null,
          }
        : null,
    },
  });
}

export async function createShareZipTicket(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  if (share.allowZip === false) return json({ error: "zip downloads are disabled for this share" }, 403);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const requested = Array.isArray(b.files) ? b.files.slice(0, 1000) : [];
  if (!requested.length) return json({ error: "choose at least one file" }, 400);
  const files = [];
  const blocked = [];
  for (const item of requested) {
    const token = downloadTokenFrom(item?.dl || item?.token);
    const parsed = await verifyShareToken(env, token, "dl", { allowExpired: true });
    if (!parsed || parsed.slug !== share.slug) return json({ error: "invalid file selection" }, 403);
    const meta = await driveFileMeta(env, parsed.fileId);
    if (!meta?.id) return json({ error: "selected file was not found" }, 404);
    const safety = publicDownloadSafety(meta);
    if (safety.blocked) {
      blocked.push(cleanText(meta.name || item?.name || parsed.fileId, 120));
      continue;
    }
    files.push({
      fileId: parsed.fileId,
      name: sanitizeFilename(meta.name || item?.name || `${parsed.fileId}.bin`),
      size: Math.max(0, Number(meta.size || item?.size) || 0),
      mime: cleanText(meta.mimeType || item?.mime || "application/octet-stream", 100),
    });
  }
  if (!files.length && blocked.length) {
    return json({ error: "All selected files are blocked by the public-download safety policy.", blocked }, 451, { "x-robots-tag": "noindex, nofollow, noarchive" });
  }

  const ticket = b64url(crypto.getRandomValues(new Uint8Array(18)));
  const expiresAt = Date.now() + SHARE_ZIP_TICKET_TTL * 1000;
  const zipName = sanitizeFilename(`${share.label.replace(/[^\w-]+/g, "_") || "share"}.zip`);
  await env.KV.put(`sharezip:${ticket}`, JSON.stringify({ slug: share.slug, label: share.label, zipName, files, expiresAt }), { expirationTtl: SHARE_ZIP_TICKET_TTL });
  return json({ ticket, url: `/api/share/zip/${ticket}`, expiresAt, count: files.length, blocked });
}

export async function shareZipDownload(request, env, ticket) {
  const safeTicket = cleanText(ticket || "", 200).replace(/[^A-Za-z0-9_-]/g, "");
  const payload = safeTicket ? await env.KV.get(`sharezip:${safeTicket}`, "json") : null;
  if (!payload) return json({ error: "zip ticket not found or expired" }, 404);
  if (payload.expiresAt && payload.expiresAt < Date.now()) {
    await env.KV.delete(`sharezip:${safeTicket}`);
    return json({ error: "zip ticket expired" }, 410);
  }
  const { share, error } = await loadActiveShare(env, payload.slug);
  if (error) return error;
  if (share.allowZip === false) return json({ error: "zip downloads are disabled for this share" }, 403);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const files = (payload.files || [])
    .filter((file) => !publicDownloadSafety(file).blocked)
    .map((file) => ({
      ...file,
      name: sanitizeFilename(file.name || `${file.fileId}.bin`),
      size: Math.max(0, Number(file.size) || 0),
      stream: async () => driveMediaStream(env, file.fileId),
    }));
  if (!files.length) {
    return json({ error: "This ZIP contains no files allowed by the public-download safety policy." }, 451, { "x-robots-tag": "noindex, nofollow, noarchive" });
  }
  const headers = new Headers({
    "content-type": "application/zip",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(payload.zipName || "share.zip")}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
  });

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  zipStoreStream(files, async (chunk) => writer.write(chunk))
    .then(() => writer.close())
    .catch((err) => writer.abort(err));
  return new Response(readable, { headers });
}

async function driveMediaStream(env, fileId) {
  const tok = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok || !r.body) throw new Error("Drive download failed");
  return r.body;
}

const ZIP32_MAX = 0xffffffffn;
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc, buf) {
  crc = crc ^ 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(v) {
  return new Uint8Array([v & 255, (v >>> 8) & 255]);
}

function u32(v) {
  return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]);
}

function u64(v) {
  const out = new Uint8Array(8);
  let n = BigInt(v);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 255n);
    n >>= 8n;
  }
  return out;
}

function concatBytes(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function dosDateTime(d = new Date()) {
  const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
  const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
  return { time, date };
}

function zip64Extra(values) {
  const body = concatBytes(values.map((v) => u64(v)));
  return concatBytes([u16(0x0001), u16(body.length), body]);
}

async function zipStoreStream(files, write) {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime();
  const central = [];
  let offset = 0n;

  for (const file of files) {
    const nameBytes = enc.encode(dedupeZipName(file.name, central));
    const lfhOffset = offset;
    const declaredSize = BigInt(Math.max(0, Number(file.size) || 0));
    const localZip64 = declaredSize > ZIP32_MAX;
    const localExtra = localZip64 ? zip64Extra([0n, 0n]) : new Uint8Array();
    const lfh = concatBytes([
      u32(0x04034b50),
      u16(localZip64 ? 45 : 20),
      u16(0x0808),
      u16(0),
      u16(time),
      u16(date),
      u32(0),
      u32(localZip64 ? 0xffffffff : 0),
      u32(localZip64 ? 0xffffffff : 0),
      u16(nameBytes.length),
      u16(localExtra.length),
      nameBytes,
      localExtra,
    ]);
    await write(lfh);
    offset += BigInt(lfh.length);

    let crc = 0;
    let size = 0n;
    const stream = await file.stream();
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      crc = crc32(crc, chunk);
      size += BigInt(chunk.length);
      await write(chunk);
    }
    offset += size;

    const zip64 = localZip64 || size > ZIP32_MAX || lfhOffset > ZIP32_MAX;
    const descriptor = zip64 ? concatBytes([u32(0x08074b50), u32(crc), u64(size), u64(size)]) : concatBytes([u32(0x08074b50), u32(crc), u32(Number(size)), u32(Number(size))]);
    await write(descriptor);
    offset += BigInt(descriptor.length);

    const centralExtraValues = [];
    if (size > ZIP32_MAX || localZip64) centralExtraValues.push(size, size);
    if (lfhOffset > ZIP32_MAX) centralExtraValues.push(lfhOffset);
    const centralExtra = centralExtraValues.length ? zip64Extra(centralExtraValues) : new Uint8Array();
    central.push({
      name: new TextDecoder().decode(nameBytes),
      bytes: concatBytes([
        u32(0x02014b50),
        u16(zip64 ? 45 : 20),
        u16(zip64 ? 45 : 20),
        u16(0x0808),
        u16(0),
        u16(time),
        u16(date),
        u32(crc),
        u32(size > ZIP32_MAX || localZip64 ? 0xffffffff : Number(size)),
        u32(size > ZIP32_MAX || localZip64 ? 0xffffffff : Number(size)),
        u16(nameBytes.length),
        u16(centralExtra.length),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(lfhOffset > ZIP32_MAX ? 0xffffffff : Number(lfhOffset)),
        nameBytes,
        centralExtra,
      ]),
    });
  }

  const cdStart = offset;
  for (const entry of central) {
    await write(entry.bytes);
    offset += BigInt(entry.bytes.length);
  }
  const cdSize = offset - cdStart;
  const needsZip64 = central.length >= 0xffff || cdSize > ZIP32_MAX || cdStart > ZIP32_MAX;
  if (needsZip64) {
    const zip64EocdStart = offset;
    const zip64Eocd = concatBytes([u32(0x06064b50), u64(44n), u16(45), u16(45), u32(0), u32(0), u64(BigInt(central.length)), u64(BigInt(central.length)), u64(cdSize), u64(cdStart)]);
    await write(zip64Eocd);
    offset += BigInt(zip64Eocd.length);
    const locator = concatBytes([u32(0x07064b50), u32(0), u64(zip64EocdStart), u32(1)]);
    await write(locator);
    offset += BigInt(locator.length);
  }
  const eocd = concatBytes([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(needsZip64 ? 0xffff : central.length),
    u16(needsZip64 ? 0xffff : central.length),
    u32(needsZip64 ? 0xffffffff : Number(cdSize)),
    u32(needsZip64 ? 0xffffffff : Number(cdStart)),
    u16(0),
  ]);
  await write(eocd);
}

function dedupeZipName(name, central) {
  const used = new Set(central.map((entry) => entry.name));
  const base = sanitizeFilename(name);
  let out = base;
  let i = 1;
  while (used.has(out)) {
    const dot = base.lastIndexOf(".");
    out = dot > 0 ? `${base.slice(0, dot)} (${i})${base.slice(dot)}` : `${base} (${i})`;
    i++;
  }
  return out;
}

// Files at or under this size get fully fetched and cached at Cloudflare's
// edge on first inline view; Cloudflare's Cache API then auto-slices Range
// requests (video seeking, resumed image loads) straight from that cached
// copy, so a second view - or the second half of a scrub - never touches
// Drive again. Larger files always stream straight through (uncached).
const EDGE_CACHEABLE_BYTES = 100 * 1024 * 1024;

function shareThumbnailHeaders(source, tier, browserCache = true) {
  const headers = new Headers({
    "content-type": source.get("content-type") || "image/jpeg",
    "cache-control": browserCache ? "private, max-age=900" : "public, max-age=86400",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "x-husky-asset-tier": tier,
  });
  const length = source.get("content-length");
  if (length) headers.set("content-length", length);
  return headers;
}

export async function shareThumbnail(request, env, token, tier, ctx) {
  const parsed = await verifyShareToken(env, token, "th");
  if (!parsed) return json({ error: "invalid or expired thumbnail token" }, 403);
  if (!driveThumbnailSize(tier)) return json({ error: "thumbnail tier not found" }, 404);
  const { share, error } = await loadActiveShare(env, parsed.slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const meta = await driveFileMeta(env, parsed.fileId);
  if (!meta?.id || !meta.thumbnailLink) return json({ error: "thumbnail unavailable" }, 404);
  const revision = encodeURIComponent(meta.modifiedTime || "0");
  const cache = caches.default;
  const cacheKey = new Request(`https://media.internal.share/thumb/${parsed.fileId}/${tier}/${revision}`);
  const hit = await cache.match(cacheKey);
  if (hit?.body) {
    return new Response(hit.body, { status: 200, headers: shareThumbnailHeaders(hit.headers, tier, true) });
  }

  const asset = await driveThumbnail(env, meta, tier);
  if (!asset?.response?.body) return json({ error: "thumbnail unavailable" }, 404);
  const [clientBody, cacheBody] = asset.response.body.tee();
  const cacheWrite = cache.put(
    cacheKey,
    new Response(cacheBody, { status: 200, headers: shareThumbnailHeaders(asset.response.headers, tier, false) }),
  );
  if (ctx?.waitUntil) ctx.waitUntil(cacheWrite);
  else await cacheWrite;
  return new Response(clientBody, { status: 200, headers: shareThumbnailHeaders(asset.response.headers, tier, true) });
}

export async function shareDownload(request, env, token, ctx) {
  const parsed = await verifyShareToken(env, token, "dl");
  if (!parsed) return json({ error: "invalid or expired download token" }, 403);
  const { share, error } = await loadActiveShare(env, parsed.slug);
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);
  // Attribution only (who downloaded what) - independent of whether this
  // share requires sign-in, so shares without requireAuth still show a
  // viewer's identity in the admin Activity feed when they happen to be
  // signed in from browsing another gated share.
  const viewer = gate.viewer || (await getViewer(request, env));

  // ?inline=1 serves the file for in-page viewing (lightbox images, <video>).
  const inline = new URL(request.url).searchParams.has("inline");
  const range = request.headers.get("range") || "";
  const cache = inline ? caches.default : null;
  const cacheKey = inline ? new Request(`https://media.internal.share/f/${parsed.fileId}`, { headers: range ? { range } : {} }) : null;

  if (cache) {
    const hit = await cache.match(cacheKey);
    if (hit) {
      if (!inline && (!range || /bytes=0-/.test(range))) {
        await bumpDownloadStats(env, share, request, cacheHitName(hit), Number(hit.headers.get("content-length")) || 0, viewer);
      }
      return hit;
    }
  }

  const meta = await driveFileMeta(env, parsed.fileId);
  if (!meta?.id) return json({ error: "file not found" }, 404);
  const bytes = Number(meta.size) || 0;
  const safety = publicDownloadSafety(meta);
  if (!inline && safety.blocked) {
    return json({ error: safety.reason }, 451, { "x-robots-tag": "noindex, nofollow, noarchive" });
  }
  const tok = await accessToken(env);

  // First inline view of a cacheable file: always pull the FULL object from
  // Drive (ignoring any small probe Range the browser sent) so the edge
  // cache holds a complete, seekable copy from here on.
  if (cache && bytes && bytes <= EDGE_CACHEABLE_BYTES) {
    const full = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parsed.fileId)}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` } });
    if (!full.ok || !full.body) return json({ error: "Drive download failed" }, 502);
    const headers = shareMediaHeaders(meta, true);
    headers.set("content-length", String(bytes));
    const [clientBody, cacheBody] = full.body.tee();
    const putPromise = cache
      .put(new Request(`https://media.internal.share/f/${parsed.fileId}`), new Response(cacheBody, { status: 200, headers }))
      .catch((err) => console.error("edge cache put failed", err.message));
    if (range) {
      await putPromise;
      const served = await cache.match(cacheKey);
      if (served) {
        if (!inline && /bytes=0-/.test(range)) await bumpDownloadStats(env, share, request, meta.name, bytes, viewer);
        return served;
      }
    } else {
      if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(putPromise);
      else await putPromise;
      if (!inline) await bumpDownloadStats(env, share, request, meta.name, bytes, viewer);
      return new Response(clientBody, { status: 200, headers });
    }
    // Cache write raced or was rejected (e.g. size limits) - fall through
    // and serve this one request directly instead of failing it.
  }

  const driveHeaders = { authorization: `Bearer ${tok}` };
  if (range) driveHeaders.range = range;
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parsed.fileId)}?alt=media&supportsAllDrives=true`, { headers: driveHeaders });
  if (!(r.status === 200 || r.status === 206) || !r.body) {
    return json({ error: "Drive download failed" }, 502);
  }

  // Count the transfer once: skip stat bumps for mid-file seeks so scrubbing
  // a video does not inflate the download counters.
  const firstChunk = !range || /bytes=0-/.test(range);
  if (!inline && firstChunk) await bumpDownloadStats(env, share, request, meta.name, bytes, viewer);

  const headers = shareMediaHeaders(meta, inline);
  for (const h of ["content-range", "content-length"]) {
    const v = r.headers.get(h);
    if (v) headers.set(h, v);
  }
  if (!headers.has("content-length") && bytes && !range) headers.set("content-length", String(bytes));
  return new Response(r.body, { status: r.status === 206 ? 206 : 200, headers });
}

function shareMediaHeaders(meta, inline) {
  return new Headers({
    "content-type": meta.mimeType || "application/octet-stream",
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(meta.name || "file")}`,
    "cache-control": inline ? "public, max-age=86400" : "private, no-store",
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow, noarchive",
    "accept-ranges": "bytes",
  });
}

function cacheHitName(response) {
  const cd = response.headers.get("content-disposition") || "";
  const m = cd.match(/filename\*=UTF-8''([^;]+)/);
  return m ? decodeURIComponent(m[1]) : "file";
}

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
