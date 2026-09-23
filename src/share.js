// Share links (outbound): let friends browse/download chosen Drive folders
// via /s/:slug. Two modes:
//  - "gallery": folder stays private; the Worker lists it and streams files
//    through short-lived HMAC-signed download tokens. PIN + expiry enforced.
//  - "redirect": grants Drive "anyone with link, reader" on the folders and
//    hands out drive.google.com URLs. Revoked on pause/delete/expiry.
//
// Split by concern: share-admin.js (CRUD), share-token.js (signed tokens),
// share-media.js (thumbnails/downloads/EXIF), share-zip.js (zip streaming).

import {
  APP_NAME,
  clamp,
  cleanText,
  json,
  normalizeEvent,
  normalizeShareStats,
  normalizeTheme,
  sha256,
  shareState,
} from "./util.js";
import { driveGrantAnyoneReader, driveListFolder } from "./drive.js";
import {
  bumpShareStats,
  gatePin,
  liveStub,
  mergeEventsKV,
  rateLimitRemote,
  storeTelemetry,
} from "./store.js";
import { getViewer } from "./auth.js";
import { previewFields, previewIndex } from "./previews.js";
import { revokeSharePermissions } from "./share-admin.js";
import { signShareToken, signShareTokenWithExpiry, verifyShareToken, publicDownloadSafety } from "./share-token.js";
import { mediaThumbs } from "./media-cache.js";
import { summaryFromStats } from "./share-index.js";
import { sharePreviewFields, sharePreviewIndex } from "./share-previews.js";
import { maybeCheckChanges } from "./share-changes.js";

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
  const viewer = env.GOOGLE_CLIENT_ID ? await getViewer(request, env) : null;
  return json({
    slug: raw.slug,
    label: raw.label,
    mode: raw.mode,
    requiresPin: !!raw.pinHash,
    pinDigits: raw.pinDigits !== false,
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
export async function requireViewer(request, env, share) {
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
  const tracker = env.LIVE_TRACKER ? liveStub(env) : null;
  let first = false;
  if (tracker) {
    const result = await tracker
      .fetch("https://live.internal/share-stat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slug,
          opens: 1,
          viewer: viewer ? { email: viewer.email, name: viewer.name || "" } : null,
        }),
      })
      .then((response) => response.json())
      .catch(() => null);
    first = !!viewer?.email && result?.viewerPreviouslySeen === false;
  } else {
    const stats = normalizeShareStats(await env.KV.get(`sstats:${slug}`, "json"));
    first = !!viewer?.email && !stats.viewers[viewer.email];
  }
  const record = normalizeEvent(
    { type: "share-open", slug, label: share.label, uploader: viewer?.email || "", message: first ? "first open" : "" },
    request
  );
  if (tracker) {
    await tracker
      .fetch("https://live.internal/event", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ record }),
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
  await storeTelemetry(env, {
    kind: "share",
    slug,
    sessionId,
    at: Date.now(),
    startedAt: Number(b.startedAt) || 0,
    viewer: viewer?.email || "anonymous",
    events,
  });
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

export async function listShareFiles(request, env, ctx) {
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
  // The cheap freshness check (spec §3.1): at most one Drive changes.list
  // call per window across the whole app, off the request path.
  ctx?.waitUntil?.(maybeCheckChanges(env, ctx, request).catch((error) => console.warn("change check failed", String(error?.message || error))));

  const [previews, imagePreviews] = await Promise.all([previewIndex(env), sharePreviewIndex(env)]);
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
      files.push(await publicShareFile(env, share, f, previews, imagePreviews));
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

export async function resolveShareTargets(env, share, body) {
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

export async function publicShareFile(env, share, f, previews = {}, imagePreviews = { files: {} }) {
  const [{ token, expiresAt }, media] = await Promise.all([
    signShareTokenWithExpiry(env, "dl", share.slug, f.id),
    f.thumbnailLink ? mediaThumbs(env, share, f) : null,
  ]);
  const img = f.imageMediaMetadata || {};
  const vid = f.videoMediaMetadata || {};
  const safety = publicDownloadSafety(f);
  let w = Number(img.width || vid.width) || 0;
  let h = Number(img.height || vid.height) || 0;
  // EXIF rotation of 90/270 means the rendered thumb is portrait.
  if (Number(img.rotation) % 2 === 1) [w, h] = [h, w];
  const thumbs = media?.thumbs || {};
  const thumbsExpireAt = media?.thumbsExpireAt || 0;
  // RAW / oversized originals (spec §5): the WebP preview-equivalent stands
  // in as the high-resolution tier; the original stays one click away.
  const imagePreview = await sharePreviewFields(env, share, f, imagePreviews);
  if (imagePreview.previewImage) thumbs.max = imagePreview.previewImageUrl;
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
    ...imagePreview,
    ...(await previewFields(env, share, f, previews)),
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

  // Indexed share (spec §2.6): the numbers come from the stats blob, no
  // Drive walk at all. Falls through to the walk until the first index lands.
  const indexed = await summaryFromStats(env, share, resolved.targets.map(([, id]) => id));
  if (indexed) return json({ ...indexed, allowZip: share.allowZip !== false });

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
