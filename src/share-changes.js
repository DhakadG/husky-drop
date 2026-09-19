// Change detection (design spec §3, §3.1), scheduling (§4) and R2 orphan
// sweeps (§1.1) for share-index.
//
//   KV  changes:cursor   { pageToken, checkedAt }  - one token for the whole
//                        app (single Drive, confirmed); polled at most once
//                        per CHANGE_WINDOW no matter how many viewers ask.
//
// A share-page load calls maybeCheckChanges() in the background. If the
// window has not passed, nothing happens. Otherwise one changes.list call
// is fanned out across every indexed share: an id that share knows (a file
// or a folder, so a new file inside a known folder counts) flips
// needsReindex and starts a targeted job with exactly those ids.

import { accessToken } from "./drive.js";
import { json, shareState } from "./util.js";
import { appLog } from "./applog.js";
import { getAllShares } from "./share-admin.js";
import { knownIds, loadFiles, loadJobs, planShareIndex, runShareIndexChunk, statsPointerKey } from "./share-index.js";

const CURSOR_KEY = "changes:cursor";
const MAX_CHANGE_PAGES = 5;
const FULL_WALK_EVERY = { daily: 1, weekly: 7, monthly: 30 };
export const changeWindowMs = (env) => Math.max(30, Number(env.CHANGE_WINDOW_SEC) || 300) * 1000;

async function driveChanges(env, path) {
  const tok = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com/drive/v3/changes${path}`, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok) throw Object.assign(new Error(`Drive changes failed: ${r.status}`), { status: r.status });
  return r.json();
}
const startToken = async (env) => (await driveChanges(env, "/startPageToken?supportsAllDrives=true")).startPageToken;

// The cheap check. Returns what it did, for logs and tests.
export async function maybeCheckChanges(env, ctx, request, { force = false } = {}) {
  if (!env.GOOGLE_CLIENT_ID || !env.MEDIA_BUCKET) return { skipped: "not configured" };
  const cursor = (await env.KV.get(CURSOR_KEY, "json")) || {};
  if (!force && cursor.checkedAt && Date.now() - cursor.checkedAt < changeWindowMs(env)) return { skipped: "checked recently" };
  let token = cursor.pageToken;
  if (!token) {
    // First run: nothing to diff against yet, just anchor the cursor.
    token = await startToken(env);
    await env.KV.put(CURSOR_KEY, JSON.stringify({ pageToken: token, checkedAt: Date.now() }));
    return { anchored: true };
  }
  const changed = new Map(); // fileId -> parents[]
  let pages = 0;
  let next = token;
  try {
    while (next && pages < MAX_CHANGE_PAGES) {
      const params = new URLSearchParams({ pageToken: next, pageSize: "1000", supportsAllDrives: "true", includeItemsFromAllDrives: "true", includeRemoved: "true", fields: "nextPageToken,newStartPageToken,changes(fileId,removed,file(id,parents,mimeType,trashed))" });
      const page = await driveChanges(env, `?${params}`);
      pages += 1;
      for (const c of page.changes || []) if (c.fileId) changed.set(c.fileId, c.file?.parents || []);
      next = page.nextPageToken || "";
      if (!next) token = page.newStartPageToken || token;
    }
  } catch (error) {
    if (error.status !== 404 && error.status !== 410) throw error;
    // Page token expired after a long quiet stretch: re-anchor and let the
    // scheduled full walks cover the gap (spec §3 safety net).
    token = await startToken(env);
    await env.KV.put(CURSOR_KEY, JSON.stringify({ pageToken: token, checkedAt: Date.now(), reanchoredAt: Date.now() }));
    appLog(env, ctx, { level: "warn", area: "share-index", message: "Drive change token expired; re-anchored, next full walks will catch up" });
    return { reanchored: true };
  }
  await env.KV.put(CURSOR_KEY, JSON.stringify({ pageToken: token, checkedAt: Date.now() }));
  if (!changed.size) return { changes: 0, shares: 0 };

  let hits = 0;
  for (const share of await getAllShares(env)) {
    if (shareState(share) !== "active") continue;
    const pointer = await env.KV.get(statsPointerKey(share.slug), "json");
    if (!pointer?.r2Key) continue;
    const { folderIds, fileIds } = await knownIds(env, share.slug);
    const mine = [...changed].filter(([id, parents]) => fileIds.has(id) || folderIds.has(id) || parents.some((p) => folderIds.has(p))).map(([id]) => id);
    if (!mine.length) continue;
    hits += 1;
    await env.KV.put(statsPointerKey(share.slug), JSON.stringify({ ...pointer, needsReindex: true, changed: mine.slice(0, 500) }));
    const { job, started } = await planShareIndex(env, ctx, share, { trigger: "changes", full: false, changed: mine });
    if (started && job) ctx?.waitUntil?.(runShareIndexChunk(env, ctx, job.id, request));
  }
  appLog(env, ctx, { area: "share-index", message: `change feed: ${changed.size} change(s) across Drive, ${hits} share(s) affected` });
  return { changes: changed.size, shares: hits };
}

// ---- scheduling (spec §4, §3.4): one global cron; per-share override ----
// share.indexSchedule: "daily" | "weekly" | "monthly" | null (= global daily).
// A full walk is also forced monthly regardless (page-token-gap insurance).
export async function runDueShareIndex(env, ctx) {
  if (!env.MEDIA_BUCKET) return;
  const jobs = await loadJobs(env);
  // Resume anything the self-continuation dropped (isolate recycled, etc).
  for (const job of jobs.filter((j) => j.status === "running")) {
    if (Date.now() - (job.startedAt || 0) > 60_000) ctx?.waitUntil?.(runShareIndexChunk(env, ctx, job.id, null));
  }
  const now = Date.now();
  for (const share of await getAllShares(env)) {
    if (shareState(share) !== "active") continue;
    const pointer = (await env.KV.get(statsPointerKey(share.slug), "json")) || {};
    const every = FULL_WALK_EVERY[share.indexSchedule] || FULL_WALK_EVERY[env.INDEX_SCHEDULE] || 1;
    const dueFull = !pointer.lastFullAt || now - pointer.lastFullAt >= every * 86400e3 - 3600e3 || now - pointer.lastFullAt >= 30 * 86400e3;
    if (!dueFull && !pointer.needsReindex) continue;
    const { job, started } = await planShareIndex(env, ctx, share, { trigger: "schedule", full: dueFull, changed: pointer.changed || [] });
    if (started && job) ctx?.waitUntil?.(runShareIndexChunk(env, ctx, job.id, null));
  }
}

// ---- orphans (spec §1.1): drop R2 media nobody references any more ----
// Chunked: lists up to one page of objects per call and reports what is
// left, so the admin button loops until done inside the subrequest budget.
export async function sweepOrphans(request, env) {
  if (!env.MEDIA_BUCKET) return json({ error: "MEDIA_BUCKET not bound" }, 503);
  const b = await request.json().catch(() => ({}));
  const live = new Set();
  const covers = new Set();
  for (const share of await getAllShares(env)) {
    for (const f of await loadFiles(env, share.slug)) live.add(`${f.id}/${f.r}`);
  }
  const previews = (await env.KV.get("previews:index", "json")) || {};
  for (const [origId, entry] of Object.entries(previews.files || {})) if (entry?.id) covers.add(`${origId}/${entry.id.replace(/[^a-z0-9]/gi, "").slice(0, 16)}`);
  const page = await env.MEDIA_BUCKET.list({ prefix: "media/", cursor: b.cursor || undefined, limit: 1000 });
  const doomed = [];
  for (const obj of page.objects || []) {
    const m = obj.key.match(/^media\/([^/]+)\/([a-z0-9-]+)-([A-Za-z0-9]+)$/);
    if (!m) continue;
    const ref = `${m[1]}/${m[3]}`;
    if (live.has(ref) || covers.has(ref)) continue;
    doomed.push(obj.key);
  }
  if (doomed.length && !b.dryRun) await env.MEDIA_BUCKET.delete(doomed);
  return json({ ok: true, scanned: (page.objects || []).length, removed: b.dryRun ? 0 : doomed.length, wouldRemove: doomed.length, cursor: page.truncated ? page.cursor : null, referenced: live.size });
}
