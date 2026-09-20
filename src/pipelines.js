// Admin "Pipelines": one view of everything that runs in the background -
// share-index jobs, the RAW/HEIC preview runner, the WebP thumbnail runner,
// video previews, image-archive jobs, the Drive change feed and orphan
// sweeps - with the GitHub Actions runs behind them. Read-mostly; the only
// writes are the thumbnail runner's progress reports (one KV key) and the
// orphan sweep's last-result note.

import { cleanText, json, shareState } from "./util.js";
import { getAllShares } from "./share-admin.js";
import { loadJobs as loadIndexJobs, loadFiles, statsPointerKey } from "./share-index.js";
import { sharePreviewIndex, wantsPreview } from "./share-previews.js";
import { previewIndex } from "./previews.js";
import { loadJobs as loadImageJobs, publicJob } from "./images.js";

const THUMB_RUNS_KEY = "share-thumbs:runs";
const ORPHANS_KEY = "media:orphans:last";
const WORKFLOWS = { "transcode-share-previews.yml": "share-previews", "transcode-previews.yml": "video-previews", "transcode-images.yml": "image-archive" };

async function gh(env, path, init = {}) {
  if (!env.GITHUB_TOKEN) return null;
  const repo = env.GITHUB_REPO || "DhakadG/husky-drop";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 4000);
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/${path}`, { ...init, signal: ctrl.signal, headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "husky-drop-worker", ...(init.headers || {}) } });
    return r.ok ? r.json() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Recent runs of the three workflows, active ones with their per-shard jobs.
async function githubRuns(env) {
  const list = await gh(env, "runs?per_page=20");
  const out = [];
  for (const run of list?.workflow_runs || []) {
    const kind = WORKFLOWS[String(run.path || "").split("/").pop()];
    if (!kind) continue;
    const row = { kind, id: run.id, status: run.status, conclusion: run.conclusion, event: run.event, startedAt: Date.parse(run.run_started_at || run.created_at) || 0, updatedAt: Date.parse(run.updated_at) || 0, url: run.html_url, jobs: [] };
    if (["queued", "in_progress", "waiting", "pending"].includes(run.status) && out.filter((r) => r.jobs.length).length < 3) {
      const jobs = await gh(env, `runs/${run.id}/jobs?per_page=50`);
      row.jobs = (jobs?.jobs || []).map((j) => ({ name: j.name, status: j.status, conclusion: j.conclusion, startedAt: Date.parse(j.started_at) || 0 }));
    }
    out.push(row);
  }
  return out;
}

export async function pipelinesOverview(env) {
  const shares = (await getAllShares(env)).filter((s) => s.mode === "gallery");
  const [indexJobs, previewsIdx, videoIdx, imageJobs, thumbRuns, orphans, changes, runs] = await Promise.all([
    loadIndexJobs(env),
    sharePreviewIndex(env),
    previewIndex(env),
    loadImageJobs(env),
    env.KV.get(THUMB_RUNS_KEY, "json"),
    env.KV.get(ORPHANS_KEY, "json"),
    env.KV.get("changes:cursor", "json"),
    githubRuns(env),
  ]);
  // Share index: pointer + live cursor per share.
  const shareRows = [];
  let pendingPreviews = 0;
  let totalFiles = 0;
  for (const share of shares) {
    const pointer = await env.KV.get(statsPointerKey(share.slug), "json");
    const active = indexJobs.find((j) => j.slug === share.slug && j.status === "running") || null;
    let cursor = null;
    if (active) cursor = await env.MEDIA_BUCKET?.get(`stats/${share.slug}.job.json`).then((o) => (o ? o.json() : null)).catch(() => null);
    const last = indexJobs.find((j) => j.slug === share.slug && j.status !== "running") || null;
    let files = 0;
    if (pointer?.r2Key && shareState(share) === "active") {
      const rows = await loadFiles(env, share.slug);
      files = rows.length;
      totalFiles += files;
      for (const f of rows) {
        if (wantsPreview({ name: f.n, mime: f.m, size: f.s })) {
          const e = previewsIdx.files[f.id];
          if (!e || e.r !== f.r) pendingPreviews += 1;
        }
      }
    }
    shareRows.push({
      slug: share.slug,
      label: share.label,
      state: shareState(share),
      files,
      indexedAt: pointer?.generatedAt || 0,
      complete: pointer?.complete === true,
      needsReindex: !!pointer?.needsReindex,
      lastFullAt: pointer?.lastFullAt || 0,
      active: active && { id: active.id, trigger: active.trigger, full: active.full, startedAt: active.startedAt, phase: cursor?.phase || "", chunks: cursor?.chunks || 0, progress: cursor?.progress || null, queue: cursor?.queue?.length || 0, changed: cursor?.changed?.length || 0, warmAt: cursor?.warmAt || 0, updatedAt: cursor?.updatedAt || 0 },
      last: last && { status: last.status, trigger: last.trigger, finishedAt: last.finishedAt, error: last.error || "", progress: last.progress || null, chunks: last.chunks || 0 },
    });
  }
  const skipped = Object.values(previewsIdx.files).filter((e) => e.skip).length;
  return json({
    now: Date.now(),
    github: { configured: !!env.GITHUB_TOKEN, runs },
    shareIndex: { shares: shareRows, jobs: indexJobs.slice(0, 15), chunk: Number(env.INDEX_CHUNK) || 40, chunkMs: Number(env.INDEX_CHUNK_MS) || 20000 },
    sharePreviews: { indexed: Object.keys(previewsIdx.files).length - skipped, keptOriginal: skipped, pending: pendingPreviews, runs: previewsIdx.runs.slice(0, 10) },
    shareThumbs: { runs: (thumbRuns?.runs || []).slice(0, 10), files: totalFiles, note: "pending is unknown until a run lists it; a run skips files already WebP (204)" },
    videoPreviews: { indexed: Object.keys(videoIdx.files).length, failed: Object.keys(videoIdx.failed).length, runs: videoIdx.runs.slice(0, 5), queue: videoIdx.queue },
    images: { active: publicJob(imageJobs.find((j) => ["running", "pausing", "paused", "queued"].includes(j.status)) || null), last: publicJob(imageJobs.find((j) => ["done", "cancelled", "undone"].includes(j.status)) || null) },
    changes: { checkedAt: changes?.checkedAt || 0, anchored: !!changes?.pageToken, windowSec: Number(env.CHANGE_WINDOW_SEC) || 300, reanchoredAt: changes?.reanchoredAt || 0 },
    orphans: orphans || null,
  });
}

// Thumbnail runner progress: {runId, shard, shards, made, had, failed,
// bytesIn, bytesOut, finished?} merged per run, one KV write per report.
export async function reportShareThumbs(request, env) {
  const b = await request.json().catch(() => null);
  if (!b?.runId) return json({ error: "runId required" }, 400);
  const state = (await env.KV.get(THUMB_RUNS_KEY, "json")) || { runs: [] };
  const runId = cleanText(String(b.runId), 40);
  let run = state.runs.find((r) => r.id === runId);
  if (!run) {
    run = { id: runId, startedAt: Date.now(), shards: {}, made: 0, had: 0, failed: 0, bytesIn: 0, bytesOut: 0 };
    state.runs.unshift(run);
  }
  const shard = String(Number(b.shard) || 0);
  run.shards[shard] = { made: Number(b.made) || 0, had: Number(b.had) || 0, failed: Number(b.failed) || 0, bytesIn: Number(b.bytesIn) || 0, bytesOut: Number(b.bytesOut) || 0, total: Number(b.total) || 0, finished: !!b.finished, at: Date.now() };
  for (const k of ["made", "had", "failed", "bytesIn", "bytesOut"]) run[k] = Object.values(run.shards).reduce((t, s) => t + (s[k] || 0), 0);
  run.updatedAt = Date.now();
  if (Object.values(run.shards).length >= (Number(b.shards) || 1) && Object.values(run.shards).every((s) => s.finished)) run.finishedAt = Date.now();
  state.runs = state.runs.slice(0, 10);
  await env.KV.put(THUMB_RUNS_KEY, JSON.stringify(state));
  return json({ ok: true });
}

export const noteOrphanSweep = (env, result) => env.KV.put(ORPHANS_KEY, JSON.stringify({ ...result, at: Date.now() })).catch(() => {});

// Cancel a GitHub run (queued or in progress).
export async function cancelPipelineRun(request, env) {
  const b = await request.json().catch(() => ({}));
  const id = String(Number(b.runId) || "");
  if (!id) return json({ error: "runId required" }, 400);
  if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN not set" }, 400);
  const repo = env.GITHUB_REPO || "DhakadG/husky-drop";
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/runs/${id}/cancel`, { method: "POST", headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "husky-drop-worker" } });
  return json({ ok: r.status === 202, status: r.status }, r.status === 202 ? 200 : 502);
}
