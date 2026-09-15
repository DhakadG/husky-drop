// Admin drop-link management: CRUD, uploads listing, overview/timeseries/
// activity feeds, Drive folder browsing and inactive-record cleanup. Every
// route here sits behind isAdmin() in worker.js.

import {
  APP_NAME,
  MAX_EXPIRY_DAYS,
  clamp,
  cleanText,
  dayKey,
  json,
  linkState,
  makePinFields,
  normalizeNotify,
  normalizeSettings,
  normalizeStats,
  normalizeTheme,
  randomSlug,
  sanitizeFolderName,
  slugify,
} from "./util.js";
import { driveBrowseFolders, driveCreateFolder, driveFileMeta, driveQuota, driveTrashFile, quotaFree } from "./drive.js";
import { forgetPreview } from "./previews.js";
import {
  getUploads,
  liveShareStats,
  liveSnapshot,
  liveStub,
  logEvent,
  recentEvents,
} from "./store.js";
import { adminShare, getAllShares, revokeSharePermissions } from "./share-admin.js";
import { ensureLinkFolder } from "./drop-api.js";

export async function browseAdminDriveFolders(env, url) {
  if (!env.GOOGLE_CLIENT_ID) return json({ currentId: "root", folders: [], breadcrumbs: [{ id: "root", name: "My Drive" }] });
  const parent = cleanText(url.searchParams.get("parent") || "root", 80);
  try {
    return json(await driveBrowseFolders(env, parent));
  } catch (err) {
    return json({ error: err.message }, 502);
  }
}

export async function createAdminDriveFolder(request, env) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Google Drive is not configured" }, 503);
  const body = await request.json().catch(() => ({}));
  const name = sanitizeFolderName(body.name || "");
  const parentId = String(body.parentId || "root").replace(/[^a-zA-Z0-9_-]/g, "") || "root";
  if (!name) return json({ error: "folder name is required" }, 400);
  try {
    return json({ folder: await driveCreateFolder(env, name, parentId) }, 201);
  } catch (error) {
    return json({ error: error.message }, 502);
  }
}

export function adminLink(link, stats = {}) {
  return {
    slug: link.slug,
    label: link.label,
    folderId: link.folderId || null,
    folderName: link.folderName || null,
    folderPending: !!link.folderPending,
    hasPin: !!link.pinHash,
    requireAuth: !!link.requireAuth,
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

// ---- Drop link admin ----

export async function listLinks(env) {
  const links = await getAllLinks(env);
  const stats = await Promise.all(links.map((link) => env.KV.get(`stats:${link.slug}`, "json")));
  const out = links.map((link, i) => adminLink(link, stats[i]));
  out.sort((a, b) => b.createdAt - a.createdAt);
  return json({ links: out });
}

export async function createLink(request, env, ctx) {
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
    requireAuth: b.requireAuth === true,
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
    ctx.waitUntil(ensureLinkFolder(env, link).catch((err) => console.error("bg folder create failed", err.message)));
  }
  return json({ ok: true, slug, folderId: link.folderId, folderPending: link.folderPending, url: `/d/${slug}` });
}

export async function patchLink(request, env, slug) {
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
  if ("requireAuth" in b) link.requireAuth = !!b.requireAuth;
  if ("folderId" in b) {
    link.folderId = cleanText(b.folderId || "", 160) || null;
    link.folderName = cleanText(b.folderName || "", 80) || null;
    link.folderPending = !link.folderId && !!env.GOOGLE_CLIENT_ID;
  }
  if ("settings" in b) link.settings = normalizeSettings({ ...link.settings, ...b.settings });
  if ("theme" in b) link.theme = normalizeTheme({ ...link.theme, ...b.theme });
  if ("notify" in b) link.notify = normalizeNotify({ ...link.notify, ...b.notify });
  await env.KV.put(`link:${slug}`, JSON.stringify(link));
  await logEvent(env, { type: "linkedit", slug, label: link.label }, request);
  return json(adminLink(link, await env.KV.get(`stats:${slug}`, "json")));
}

export async function deleteLink(request, env, slug) {
  await env.KV.delete(`link:${slug}`);
  await removeLinkFromIndex(env, slug);
  await logEvent(env, { type: "linkdel", slug }, request);
  return json({ ok: true });
}

export async function listUploads(env, slug, url) {
  const fresh = url?.searchParams.get("fresh") === "1";
  const uploads = await getUploads(env, slug, fresh);
  const totalBytes = uploads.reduce((t, u) => t + (u.s || 0), 0);
  return json({ uploads, count: uploads.length, totalBytes });
}

export async function linkDetail(env, slug, url) {
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

export async function adminOverview(env) {
  const links = await getAllLinks(env);
  const rows = [];
  const totals = { links: links.length, opens: 0, sessions: 0, files: 0, bytes: 0 };
  const allStats = await Promise.all(links.map((link) => env.KV.get(`stats:${link.slug}`, "json")));
  for (const [i, link] of links.entries()) {
    const stats = normalizeStats(allStats[i]);
    totals.opens += stats.opens;
    totals.sessions += stats.sessions;
    totals.files += stats.files;
    totals.bytes += stats.bytes;
    rows.push(adminLink(link, stats));
  }
  rows.sort((a, b) => b.createdAt - a.createdAt);
  const shares = await getAllShares(env);
  const shareStatDeltas = await liveShareStats(env);
  const shareRows = [];
  const allShareStats = await Promise.all(shares.map((share) => env.KV.get(`sstats:${share.slug}`, "json")));
  for (const [i, share] of shares.entries()) {
    const base = allShareStats[i] || {};
    const delta = shareStatDeltas.get(share.slug) || {};
    shareRows.push(adminShare(share, {
      opens: (Number(base.opens) || 0) + (Number(delta.opens) || 0),
      downloads: (Number(base.downloads) || 0) + (Number(delta.downloads) || 0),
      bytes: (Number(base.bytes) || 0) + (Number(delta.bytes) || 0),
      views: (Number(base.views) || 0) + (Number(delta.views) || 0),
      viewers: { ...(base.viewers || {}), ...(delta.viewers || {}) },
    }));
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

export async function adminTimeseries(env, url) {
  if (!env.LIVE_TRACKER) return json({ rows: [] });
  const days = clamp(Number(url.searchParams.get("days")) || 30, 1, 120);
  const slug = cleanText(url.searchParams.get("slug") || "", 66);
  const res = await liveStub(env).fetch(`https://live.internal/timeseries?days=${days}${slug ? `&slug=${encodeURIComponent(slug)}` : ""}`);
  if (!res.ok) return json({ rows: [] });
  return json(await res.json());
}

// Older activity, one KV read per calendar day. `before` is an exclusive
// YYYY-MM-DD upper bound (defaults to today); `days` is how many earlier
// days to return. The rolling events:recent key still serves the fresh view.
export async function adminEvents(env, url) {
  const beforeRaw = cleanText(url.searchParams.get("before") || "", 10);
  const before = /^\d{4}-\d{2}-\d{2}$/.test(beforeRaw) ? beforeRaw : dayKey(Date.now());
  const days = clamp(Number(url.searchParams.get("days")) || 3, 1, 14);
  if (env.LIVE_TRACKER) {
    const response = await liveStub(env).fetch(`https://live.internal/events-days?before=${encodeURIComponent(before)}&days=${days}`);
    if (response.ok) return json(await response.json());
  }
  const start = new Date(`${before}T00:00:00Z`).getTime();
  if (!Number.isFinite(start)) return json({ error: "bad before date" }, 400);
  const out = [];
  for (let i = 1; i <= days; i++) {
    const day = dayKey(start - i * 86400_000);
    const events = (await env.KV.get(`events:day:${day}`, "json")) || [];
    out.push({ day, events });
  }
  return json({ days: out, oldest: out.length ? out[out.length - 1].day : before });
}

export async function driveThumbMeta(env, fileId) {
  const meta = await driveFileMeta(env, fileId);
  if (!meta) return json({ error: "thumbnail lookup failed" }, 502);
  return json(meta);
}

async function getAllLinks(env) {
  const slugs = await getLinkIndex(env);
  if (slugs.length) {
    const links = await Promise.all(slugs.map((slug) => env.KV.get(`link:${slug}`, "json")));
    return links.filter(Boolean);
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

export async function cleanupInactiveRecords(request, env) {
  const report = {
    dropLinksRemoved: 0,
    shareLinksRemoved: 0,
    staleIndexEntries: 0,
    keysDeleted: 0,
    operationsDeferred: 0,
    indexUpdatesDeferred: 0,
  };
  const deleteKey = async (key, knownToExist = false) => {
    try {
      // A delete for a missing key still consumes a KV write. Reads are much
      // cheaper, so cleanup retries probe optional companion records first.
      if (!knownToExist && (await env.KV.get(key)) == null) return false;
      await env.KV.delete(key);
      report.keysDeleted += 1;
      return true;
    } catch (error) {
      report.operationsDeferred += 1;
      console.warn(JSON.stringify({ event: "maintenance_cleanup_deferred", operation: "delete", key, message: error?.message || "KV delete failed" }));
      return false;
    }
  };
  const compactIndex = async (key, before, after) => {
    if (JSON.stringify(after) === JSON.stringify(before)) return;
    try {
      await env.KV.put(key, JSON.stringify(after));
    } catch (error) {
      report.indexUpdatesDeferred += 1;
      console.warn(JSON.stringify({ event: "maintenance_cleanup_deferred", operation: "compact_index", key, message: error?.message || "KV put failed" }));
    }
  };
  const storedLinks = (await env.KV.get("links:index", "json")) || [];
  const keptLinks = [];
  for (const slug of storedLinks.map(slugify).filter(Boolean)) {
    const link = await env.KV.get(`link:${slug}`, "json");
    if (link && linkState(link) !== "expired") { keptLinks.push(slug); continue; }
    if (!link) report.staleIndexEntries += 1;
    else report.dropLinksRemoved += 1;
    if (link) await deleteKey(`link:${slug}`, true);
    await deleteKey(`stats:${slug}`);
    await deleteKey(`recent:${slug}`);
  }
  await compactIndex("links:index", storedLinks, keptLinks);

  const storedShares = (await env.KV.get("shares:index", "json")) || [];
  const keptShares = [];
  for (const slug of storedShares.map(slugify).filter(Boolean)) {
    const share = await env.KV.get(`share:${slug}`, "json");
    const expired = !!share?.expiresAt && Number(share.expiresAt) <= Date.now();
    if (share && !expired) { keptShares.push(slug); continue; }
    if (!share) report.staleIndexEntries += 1;
    else {
      report.shareLinksRemoved += 1;
      if (share.mode === "redirect") await revokeSharePermissions(env, share);
    }
    if (share) await deleteKey(`share:${slug}`, true);
    await deleteKey(`sstats:${slug}`);
  }
  await compactIndex("shares:index", storedShares, keptShares);
  return json({ ok: true, complete: report.operationsDeferred === 0 && report.indexUpdatesDeferred === 0, ...report });
}

// Resolves (creating if still pending) the Drive folder behind a drop link so
// the dashboard can offer "share this drop" right after creating it.
export async function linkFolder(env, slug) {
  const link = await env.KV.get(`link:${cleanText(slug, 60)}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  if (!link.folderId) {
    try {
      link.folderId = await ensureLinkFolder(env, link);
    } catch (err) {
      return json({ error: "Drive folder is not ready yet: " + err.message }, 503);
    }
  }
  return json({ folderId: link.folderId, folderName: link.folderName || link.label });
}

// Trash one delivered file: Drive trash (recoverable), drop it from the
// recent list, and take it out of the link's counters. The file must carry
// this link's dropLink property so an admin cannot trash arbitrary Drive ids.
export async function trashUpload(request, env, slug, fileId) {
  slug = cleanText(slug, 60);
  const id = cleanText(fileId, 120);
  const link = await env.KV.get(`link:${slug}`, "json");
  if (!link) return json({ error: "link not found" }, 404);
  const rows = (await env.KV.get(`recent:${slug}`, "json")) || [];
  const row = rows.find((u) => u.f === id);
  if (env.GOOGLE_CLIENT_ID) {
    const meta = await driveFileMeta(env, id);
    if (!meta?.id) return json({ error: "Drive file not found" }, 404);
    if (meta.appProperties?.dropLink !== slug) return json({ error: "file does not belong to this link" }, 403);
    if (!(await driveTrashFile(env, id))) return json({ error: "Drive refused to trash the file" }, 502);
    await forgetPreview(env, id);
  }
  if (row) {
    await env.KV.put(`recent:${slug}`, JSON.stringify(rows.filter((u) => u.f !== id)));
    const stats = normalizeStats(await env.KV.get(`stats:${slug}`, "json"));
    stats.files = Math.max(0, stats.files - 1);
    stats.bytes = Math.max(0, stats.bytes - (Number(row.s) || 0));
    await env.KV.put(`stats:${slug}`, JSON.stringify(stats));
  }
  await logEvent(env, { type: "filedel", slug, label: link.label, file: row?.n || id, message: "trashed by admin" }, request);
  return json({ ok: true, removed: !!row });
}
