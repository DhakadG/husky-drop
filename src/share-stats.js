// Share-page and admin endpoints for share-index (design spec §2, §4).

import { cleanText, json } from "./util.js";
import { gatePin } from "./store.js";
import { loadActiveShare, requireViewer } from "./share.js";
import { planShareIndex, runShareIndexChunk, shareStatsPayload } from "./share-index.js";

// POST /api/share/stats {slug, pin} - every folder's subtree totals + cover,
// keyed by the listing's stable fid. Answered from R2, never Drive.
export async function shareStats(request, env) {
  const b = await request.json().catch(() => ({}));
  const { share, error } = await loadActiveShare(env, cleanText(b.slug || "", 60));
  if (error) return error;
  const gate = await requireViewer(request, env, share);
  if (gate.error) return gate.error;
  const failure = await gatePin(request, env, share, b.pin, "share:", `share-${share.slug}`);
  if (failure) return failure;
  return json(await shareStatsPayload(env, share), 200, { "cache-control": "private, max-age=60" });
}

// POST /api/admin/share-index/run {slug, full?} - the "Process now" button.
export async function startShareIndex(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const slug = cleanText(b.slug || "", 60);
  const share = await env.KV.get(`share:${slug}`, "json");
  if (!share) return json({ error: "share not found" }, 404);
  if (share.mode !== "gallery") return json({ error: "redirect shares are not indexed" }, 400);
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Drive not configured" }, 503);
  const { job, started, reason } = await planShareIndex(env, ctx, share, { trigger: "manual", full: b.full !== false });
  if (!job) return json({ error: reason }, 503);
  if (started) ctx?.waitUntil?.(runShareIndexChunk(env, ctx, job.id, request));
  return json({ ok: true, started, reason, job }, started ? 202 : 200);
}
