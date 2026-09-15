// Share links: admin CRUD (create, patch, delete, list) and Drive permission
// revocation for redirect-mode shares.

import {
  MAX_EXPIRY_DAYS,
  clamp,
  cleanText,
  json,
  makePinFields,
  normalizeShareStats,
  normalizeTheme,
  randomSlug,
  shareState,
  slugify,
} from "./util.js";
import { driveFileMeta, driveGrantAnyoneReader, driveRevokePermission } from "./drive.js";
import { liveShareStats, logEvent } from "./store.js";

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
    theme: normalizeTheme(share.theme),
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
  const shares = await Promise.all(slugs.map((slug) => env.KV.get(`share:${slug}`, "json")));
  return shares.filter(Boolean);
}

export async function listShares(env) {
  const [shares, deltas] = await Promise.all([getAllShares(env), liveShareStats(env)]);
  const stats = await Promise.all(shares.map((share) => env.KV.get(`sstats:${share.slug}`, "json")));
  const out = [];
  for (const [i, share] of shares.entries()) {
    const base = stats[i] || {};
    const delta = deltas.get(share.slug) || {};
    out.push(adminShare(share, {
      opens: (Number(base.opens) || 0) + (Number(delta.opens) || 0),
      downloads: (Number(base.downloads) || 0) + (Number(delta.downloads) || 0),
      bytes: (Number(base.bytes) || 0) + (Number(delta.bytes) || 0),
      views: (Number(base.views) || 0) + (Number(delta.views) || 0),
      viewers: { ...(base.viewers || {}), ...(delta.viewers || {}) },
    }));
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
  const nextMode = "mode" in b ? (b.mode === "redirect" ? "redirect" : "gallery") : share.mode;
  let nextFolderIds = share.folderIds || [];
  let nextFolderNames = share.folderNames || [];
  if ("folders" in b) {
    const rawFolders = Array.isArray(b.folders) ? b.folders : String(b.folders || "").split(/[,\n]/);
    nextFolderIds = [...new Set(rawFolders.map(parseDriveFolderInput).filter(Boolean))].slice(0, 10);
    if (!nextFolderIds.length) return json({ error: "at least one Drive folder is required" }, 400);
    nextFolderNames = [];
    for (const id of nextFolderIds) {
      if (!env.GOOGLE_CLIENT_ID) { nextFolderNames.push(id); continue; }
      const meta = await driveFileMeta(env, id);
      if (!meta || meta.mimeType !== "application/vnd.google-apps.folder") return json({ error: `folder ${id} was not found in Drive` }, 400);
      nextFolderNames.push(meta.name || id);
    }
  }
  const destinationChanged = nextMode !== share.mode || nextFolderIds.join(",") !== (share.folderIds || []).join(",");
  if (destinationChanged && share.mode === "redirect") await revokeSharePermissions(env, share);
  share.mode = nextMode;
  share.folderIds = nextFolderIds;
  share.folderNames = nextFolderNames;
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
  if ("theme" in b) share.theme = normalizeTheme({ ...share.theme, ...b.theme });
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
  if (destinationChanged && share.mode === "redirect" && !share.disabled && env.GOOGLE_CLIENT_ID) {
    share.permissionIds = {};
    for (const id of share.folderIds) share.permissionIds[id] = await driveGrantAnyoneReader(env, id);
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
