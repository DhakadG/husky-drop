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
  shareState,
  slugify,
  timingSafeEqual,
} from "./util.js";
import {
  driveFileMeta,
  driveGrantAnyoneReader,
  driveListFolder,
  driveRevokePermission,
  accessToken,
} from "./drive.js";
import { bumpShareStats, gatePin, liveStub, logEvent, mergeEventsKV } from "./store.js";

export function parseDriveFolderInput(value) {
  const s = String(value || "").trim();
  if (!s) return "";
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return "";
}

export function adminShare(share, stats = {}) {
  return {
    slug: share.slug,
    label: share.label,
    mode: share.mode,
    folderIds: share.folderIds || [],
    folderNames: share.folderNames || [],
    hasPin: !!share.pinHash,
    allowZip: share.allowZip !== false,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt || null,
    disabled: !!share.disabled,
    state: shareState(share),
    stats: normalizeShareStats(stats),
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

export async function getShareMeta(env, slug) {
  const raw = await env.KV.get(`share:${slug}`, "json");
  if (!raw) return json({ error: "share not found" }, 404);
  return json({
    slug: raw.slug,
    label: raw.label,
    mode: raw.mode,
    requiresPin: !!raw.pinHash,
    allowZip: raw.allowZip !== false,
    state: shareState(raw),
    expiresAt: raw.expiresAt || null,
    theme: normalizeTheme(raw.theme),
    appName: APP_NAME,
  });
}

export async function verifySharePin(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  return json({ ok: true });
}

export async function logShareOpened(request, env) {
  const b = await request.json().catch(() => ({}));
  const slug = cleanText(b.slug || "", 60);
  const share = await env.KV.get(`share:${slug}`, "json");
  if (!share) return json({ error: "share not found" }, 404);
  const record = normalizeEvent({ type: "share-open", slug, label: share.label }, request);
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
  return json({ ok: true });
}

export async function listShareFiles(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  if (!env.GOOGLE_CLIENT_ID) return json({ folders: [], allowZip: share.allowZip !== false });

  const single = "folderIndex" in b;
  const folderIndex = clamp(Number(b.folderIndex) || 0, 0, share.folderIds.length - 1);
  const folders = [];
  const targets = single
    ? [[folderIndex, share.folderIds[folderIndex]]]
    : share.folderIds.map((id, i) => [i, id]);

  for (const [i, folderId] of targets) {
    const page = await driveListFolder(env, folderId, single ? cleanText(b.pageToken || "", 500) : "");
    const files = [];
    for (const f of page.files || []) {
      if (f.mimeType === "application/vnd.google-apps.folder") continue; // v1: flat listing
      const token = await signShareToken(env, "dl", share.slug, f.id);
      files.push({
        id: f.id,
        name: cleanText(f.name || "file", 200),
        size: Number(f.size) || 0,
        mime: cleanText(f.mimeType || "", 100),
        at: Date.parse(f.modifiedTime || f.createdTime) || 0,
        thumb: f.thumbnailLink || "",
        dl: `/api/share/dl/${token}`,
      });
    }
    folders.push({
      index: i,
      name: share.folderNames[i] || `Folder ${i + 1}`,
      files,
      nextPageToken: page.nextPageToken || "",
    });
  }
  return json({ folders, allowZip: share.allowZip !== false });
}

export async function shareRedirect(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  if (share.mode !== "redirect") return json({ error: "not a redirect share" }, 400);
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
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${scope}.${slug}.${fileId}.${exp}`;
  const key = await shareSigningKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${b64url(new TextEncoder().encode(body))}.${b64url(new Uint8Array(mac))}`;
}

export async function verifyShareToken(env, token, expectScope) {
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
  if (Number(exp) * 1000 < Date.now()) return null;
  return { slug, fileId };
}

export async function shareDownload(request, env, token) {
  const parsed = await verifyShareToken(env, token, "dl");
  if (!parsed) return json({ error: "invalid or expired download token" }, 403);
  const { share, error } = await loadActiveShare(env, parsed.slug);
  if (error) return error;
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);

  const meta = await driveFileMeta(env, parsed.fileId);
  if (!meta?.id) return json({ error: "file not found" }, 404);

  const tok = await accessToken(env);
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(parsed.fileId)}?alt=media&supportsAllDrives=true`,
    { headers: { authorization: `Bearer ${tok}` } }
  );
  if (!r.ok || !r.body) return json({ error: "Drive download failed" }, 502);

  const bytes = Number(meta.size) || 0;
  const record = normalizeEvent(
    { type: "share-dl", slug: share.slug, label: share.label, file: meta.name, bytes },
    request
  );
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

  const headers = new Headers({
    "content-type": meta.mimeType || "application/octet-stream",
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(meta.name || "file")}`,
    "cache-control": "private, no-store",
    "x-content-type-options": "nosniff",
  });
  if (bytes) headers.set("content-length", String(bytes));
  return new Response(r.body, { status: 200, headers });
}
