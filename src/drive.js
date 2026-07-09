// Google Drive API helpers. All calls authenticate with the cached OAuth
// access token minted from the refresh token secret.

import { cleanText, driveQueryEscape, sanitizeFolderName, sha256 } from "./util.js";

export async function accessToken(env) {
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

// Drive storage quota, cached for an hour. Used to refuse uploads that cannot
// fit and to show headroom on the drop page + admin dashboard.
export async function driveQuota(env) {
  if (!env.GOOGLE_CLIENT_ID) return null;
  const cached = await env.KV.get("gquota", "json");
  if (cached && cached.at > Date.now() - 3600_000) return cached;
  try {
    const tok = await accessToken(env);
    const r = await fetch("https://www.googleapis.com/drive/v3/about?fields=storageQuota", {
      headers: { authorization: `Bearer ${tok}` },
    });
    if (!r.ok) return cached || null;
    const d = await r.json();
    const quota = {
      limit: Number(d.storageQuota?.limit) || 0,
      usage: Number(d.storageQuota?.usage) || 0,
      at: Date.now(),
    };
    await env.KV.put("gquota", JSON.stringify(quota), { expirationTtl: 7200 });
    return quota;
  } catch {
    return cached || null;
  }
}

export function quotaFree(quota) {
  if (!quota || !quota.limit) return null; // unlimited or unknown
  return Math.max(0, quota.limit - quota.usage);
}

export async function driveCreateFolder(env, name, parentId) {
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

export async function driveFindFolder(env, name, parentId) {
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

export async function driveFileMeta(env, fileId) {
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

export async function driveListFolder(env, folderId, pageToken, options = {}) {
  const tok = await accessToken(env);
  const pageSize = Math.max(1, Math.min(Number(options.pageSize) || 200, 1000));
  const params = new URLSearchParams({
    q: `'${driveQueryEscape(folderId)}' in parents and trashed=false`,
    fields:
      "nextPageToken,files(id,name,size,mimeType,modifiedTime,createdTime,thumbnailLink," +
      "imageMediaMetadata(width,height,rotation),videoMediaMetadata(width,height,durationMillis))",
    orderBy: "folder,name",
    pageSize: String(pageSize),
    supportsAllDrives: "true",
    includeItemsFromAllDrives: "true",
  });
  if (pageToken) params.set("pageToken", pageToken);
  const r = await fetch("https://www.googleapis.com/drive/v3/files?" + params, {
    headers: { authorization: `Bearer ${tok}` },
  });
  if (!r.ok) throw new Error("Drive list failed: " + (await r.text()).slice(0, 200));
  return r.json();
}

export async function driveGrantAnyoneReader(env, folderId) {
  const tok = await accessToken(env);
  const r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}/permissions?supportsAllDrives=true`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
      body: JSON.stringify({ type: "anyone", role: "reader" }),
    }
  );
  if (!r.ok) throw new Error("Drive permission grant failed: " + (await r.text()).slice(0, 200));
  const d = await r.json();
  return d.id;
}

export async function driveRevokePermission(env, folderId, permissionId) {
  try {
    const tok = await accessToken(env);
    await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(folderId)}/permissions/${encodeURIComponent(permissionId)}?supportsAllDrives=true`,
      { method: "DELETE", headers: { authorization: `Bearer ${tok}` } }
    );
  } catch (err) {
    console.error("permission revoke failed", err.message);
  }
}

export async function driveUploadsForLink(env, slug) {
  if (!env.GOOGLE_CLIENT_ID) return [];
  const tok = await accessToken(env);
  const q = `trashed=false and appProperties has { key='dropLink' and value='${driveQueryEscape(slug)}' }`;
  const url =
    "https://www.googleapis.com/drive/v3/files?" +
    new URLSearchParams({
      q,
      fields: "files(id,name,size,mimeType,createdTime,modifiedTime,appProperties)",
      orderBy: "modifiedTime desc",
      pageSize: "200",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
  const r = await fetch(url, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok) return [];
  const d = await r.json();
  return (d.files || []).map((f) => ({
    n: cleanText(f.name || "file", 160),
    s: Number(f.size) || 0,
    m: cleanText(f.mimeType || "", 80),
    u: cleanText(f.appProperties?.uploader || "anonymous", 60),
    f: cleanText(f.id || "", 120),
    at: Date.parse(f.modifiedTime || f.createdTime) || Date.now(),
  }));
}

// Resolves (and caches) the per-uploader Drive subfolder for a link.
export async function resolveUploaderFolderDirect(env, link, uploader) {
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

// Resolves (and caches) a nested subfolder path under the upload target
// folder, creating any missing folders along the way. Used to mirror the
// folder tree of a folder upload ("Trip/Day 1/...") inside Drive.
export async function resolvePathFolderDirect(env, link, uploader, segments) {
  let parentId = await resolveUploaderFolderDirect(env, link, uploader);
  if (!Array.isArray(segments) || !segments.length) return parentId;
  let pathKey = parentId;
  for (const segment of segments) {
    const name = sanitizeFolderName(segment);
    pathKey += `/${name.toLowerCase()}`;
    const cacheKey = `pathfolder:${link.slug}:${await sha256(pathKey)}`;
    const cached = await env.KV.get(cacheKey, "json");
    if (cached?.id) {
      parentId = cached.id;
      continue;
    }
    const found = await driveFindFolder(env, name, parentId);
    const folder = found || (await driveCreateFolder(env, name, parentId));
    await env.KV.put(cacheKey, JSON.stringify({ id: folder.id }), { expirationTtl: 180 * 86400 });
    parentId = folder.id;
  }
  return parentId;
}

// Lazy Drive folder creation for links returned instantly at create time.
export async function ensureLinkFolderDirect(env, slug) {
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) throw new Error("link not found");
  if (link.folderId) return link.folderId;
  const folder = await driveCreateFolder(
    env,
    link.folderName || link.label || slug,
    env.DRIVE_PARENT_ID || undefined
  );
  link.folderId = folder.id;
  link.folderName = folder.name;
  link.folderPending = false;
  await env.KV.put(`link:${slug}`, JSON.stringify(link));
  return folder.id;
}
