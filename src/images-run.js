// Image archive jobs - control, queue, runner API, Drive writes, undo.
// Planning lives in images.js.
//
// Modes (what happens to the original once the smaller copy is verified):
//   replace - new bytes become a new revision of the SAME file id (name and
//             folder kept, extension updated if the format changed). Drive
//             keeps the previous revision ~30 days.
//   archive - original moved to _archive/<root>/<sub>/ (metadata patch, no
//             copy); the new file takes its place with the same name.
//   copy    - original untouched; the new file goes to _compressed/<root>/<sub>/.
// Copy and archive jobs can be undone from the admin; replace cannot.

import { accessToken, driveCreateFolder, driveFindFolder, driveTrashFile } from "./drive.js";
import { json, cleanText, escapeHtml } from "./util.js";
import { loadJobs, publicJob, saveJobs } from "./images.js";
import { appLog } from "./applog.js";
import { sendNotify } from "./store.js";

const MAX_UPLOAD = 90 * 1024 * 1024;
const WORKFLOW = "transcode-images.yml";
const MIME = { jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif", png: "image/png" };
const withExt = (name, format) => name.replace(/\.[^.]+$/, "") + { jpeg: ".jpg", webp: ".webp", avif: ".avif", png: ".png" }[format];
const ACTIVE = ["running", "pausing"];

async function dispatch(env, jobId) {
  if (!env.GITHUB_TOKEN) return { dispatched: false, reason: "GITHUB_TOKEN not set - run scripts/transcode-images.mjs locally with JOB_ID=" + jobId };
  const repo = env.GITHUB_REPO || "DhakadG/husky-drop";
  const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: "application/vnd.github+json", "user-agent": "husky-drop-worker", "content-type": "application/json" },
    body: JSON.stringify({ ref: "main", inputs: { job: jobId } }),
  });
  return r.status === 204 ? { dispatched: true } : { dispatched: false, reason: `GitHub refused: ${r.status}` };
}

export async function listImageJobs(env) {
  const jobs = await loadJobs(env);
  const active = jobs.find((j) => [...ACTIVE, "paused"].includes(j.status)) || null;
  return json({ jobs: jobs.map(publicJob), active: publicJob(active), dispatchConfigured: !!env.GITHUB_TOKEN });
}

// Mark a planned job running (or queued behind an active one) and dispatch.
// Shared by the admin start button and the rules cron.
export async function startJobRecord(env, ctx, jobs, job) {
  if (jobs.some((j) => j !== job && ACTIVE.includes(j.status))) {
    job.status = "queued";
    await saveJobs(env, jobs);
    appLog(env, ctx, { area: "images", message: `job ${job.id} queued (${job.digest.files} files, ${job.options.mode})` });
    return { status: "queued", dispatched: false, reason: "queued behind the running job" };
  }
  job.status = "running";
  job.startedAt = Date.now();
  await saveJobs(env, jobs);
  const result = await dispatch(env, job.id);
  appLog(env, ctx, { level: result.dispatched ? "info" : "warn", area: "images", message: `job ${job.id} started (${job.digest.files} files, ${job.options.mode}, x${job.options.parallel || 1})${result.dispatched ? "" : " - not dispatched: " + result.reason}` });
  return { status: "running", ...result };
}

// start | pause | resume | cancel. Starting while another job runs queues
// this one; the runner's final report starts the next queued job.
export async function controlImageJob(request, env, ctx, jobId, action) {
  const b = await request.json().catch(() => ({}));
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  let dispatchNow = false;
  if (action === "start") {
    if (!["planned", "queued"].includes(job.status)) return json({ error: `job is ${job.status}` }, 409);
    if (job.options.mode === "replace" && b.confirm !== "REPLACE") return json({ error: "type REPLACE to confirm overwriting originals" }, 400);
    job.notify = b.notify !== false;
    const started = await startJobRecord(env, ctx, jobs, job);
    return json({ ok: true, job: publicJob(job), ...started });
  } else if (action === "pause") {
    if (job.status !== "running") return json({ error: `job is ${job.status}` }, 409);
    job.status = "pausing"; // the runner finishes the current file, then stops
  } else if (action === "resume") {
    if (!["paused", "pausing"].includes(job.status)) return json({ error: `job is ${job.status}` }, 409);
    // "pausing" = runner still alive; it sees "running" on its next poll, so
    // dispatching again would start a second runner on the same files.
    if (job.status === "pausing") job.status = "running";
    else if (jobs.some((j) => j !== job && ACTIVE.includes(j.status))) job.status = "queued";
    else {
      job.status = "running";
      dispatchNow = true;
    }
  } else if (action === "cancel") {
    if (["done", "cancelled"].includes(job.status)) return json({ error: `job is ${job.status}` }, 409);
    job.status = "cancelled";
    job.finishedAt = Date.now();
  } else return json({ error: "unknown action" }, 400);
  await saveJobs(env, jobs);
  const result = dispatchNow ? await dispatch(env, job.id) : job.status === "queued" ? { dispatched: false, reason: "queued behind the running job" } : {};
  appLog(env, ctx, { area: "images", message: `job ${job.id} ${action} → ${job.status}${result.reason ? " - " + result.reason : ""}` });
  return json({ ok: true, job: publicJob(job), ...result });
}

// ---- runner API ----
export async function nextImageBatch(request, env, jobId) {
  const n = Math.max(1, Math.min(50, Number(new URL(request.url).searchParams.get("n")) || 10));
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  const seen = new Set(job.items.map((i) => i.id));
  const files = job.status === "running" ? job.files.filter((f) => !seen.has(f.id)).slice(0, n) : [];
  return json({ status: job.status, options: job.options, files, remaining: job.files.length - seen.size });
}

export async function imageSource(request, env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return json({ error: "bad file id" }, 400);
  const tok = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` }, signal: request.signal });
  if (!r.ok || !r.body) return json({ error: "Drive download failed" }, 502);
  return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "application/octet-stream", "content-length": r.headers.get("content-length") || "" } });
}

export const imageMirrorPath = (env, base, relativePath) => mirrorPath(env, base, relativePath);
export const imageMoveFile = (env, tok, fileId, fromId, toId) => moveFile(env, tok, fileId, fromId, toId);
export const imageParentOf = (env, tok, fileId) => archiveFolderOf(env, tok, fileId);
async function subfolder(env, name, parentId) {
  return (await driveFindFolder(env, name, parentId)) || driveCreateFolder(env, name, parentId);
}
// _archive/<root>/<sub>/... mirrors the source tree so two folders that
// share a leaf name never merge. Folder ids memoised per isolate.
// ponytail: isolate-lifetime cache, no expiry; a folder deleted by hand
// outside the app stays cached until the isolate recycles.
const folderMemo = new Map();
async function mirrorPath(env, base, relativePath) {
  let parent = env.DRIVE_PARENT_ID || undefined;
  let key = "";
  for (const segment of [base, ...relativePath.split("/").filter(Boolean)]) {
    key += `/${segment}`;
    if (!folderMemo.has(key)) folderMemo.set(key, (await subfolder(env, segment, parent)).id);
    parent = folderMemo.get(key);
  }
  return parent;
}
async function moveFile(env, tok, fileId, fromId, toId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${toId}&removeParents=${fromId}&supportsAllDrives=true`, { method: "PATCH", headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: "{}" });
  if (!r.ok) throw new Error("Drive move failed");
}
// A retried PUT must not leave two copies behind: drop anything already
// tagged as made from this original.
async function trashPriorCopies(env, tok, originalId, jobId) {
  const params = new URLSearchParams({ q: `appProperties has { key='archivedFrom' and value='${originalId}' } and appProperties has { key='archiveJob' and value='${jobId}' } and trashed=false`, fields: "files(id)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
  const r = await fetch("https://www.googleapis.com/drive/v3/files?" + params, { headers: { authorization: `Bearer ${tok}` } });
  if (!r.ok) return;
  for (const f of (await r.json()).files || []) await driveTrashFile(env, f.id).catch(() => {});
}
async function multipart(env, tok, url, method, meta, body, mime) {
  const boundary = `hd-${crypto.randomUUID()}`;
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`;
  const r = await fetch(url, { method, headers: { authorization: `Bearer ${tok}`, "content-type": `multipart/related; boundary=${boundary}` }, body: new Blob([head, body, `\r\n--${boundary}--`]) });
  if (!r.ok) throw new Error("Drive upload failed: " + (await r.text()).slice(0, 160));
  return r.json();
}

// The runner PUTs the encoded image; the worker applies the job's mode and
// verifies what Drive stored (size + dimensions) before answering ok.
export async function putImageResult(request, env, ctx, jobId, fileId) {
  try {
    return await putImageResultInner(request, env, jobId, fileId);
  } catch (error) {
    appLog(env, ctx, { level: "error", area: "drive", message: `store failed for ${fileId} (job ${jobId})`, detail: error.message });
    return json({ error: error.message }, 502);
  }
}
async function putImageResultInner(request, env, jobId, fileId) {
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  const file = job?.files.find((f) => f.id === fileId);
  if (!job || !file) return json({ error: "unknown job/file" }, 404);
  if (job.status !== "running") return json({ error: `job is ${job.status}` }, 409);
  const format = cleanText(request.headers.get("x-format") || file.format, 8);
  const mime = MIME[format];
  if (!mime) return json({ error: "bad format" }, 400);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_UPLOAD) return json({ error: "empty or too large" }, 413);
  if (job.options.onlyIfSmaller && body.byteLength >= file.size) return json({ ok: false, skipped: "output not smaller" });

  const tok = await accessToken(env);
  const name = withExt(file.name, format);
  const props = { appProperties: { archivedFrom: file.id, archiveJob: job.id } };
  // Idempotent per job, whatever the runner remembers: a replaced original
  // is stamped with this job (a second pass would re-encode the lossy copy),
  // and an earlier copy made by this job is dropped before the new one.
  if (job.options.mode === "replace") {
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${file.id}?fields=appProperties&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` } });
    const stamp = r.ok ? (await r.json().catch(() => ({}))).appProperties?.archiveJob : "";
    if (stamp === job.id) return json({ ok: false, skipped: "already replaced by this job" });
  } else await trashPriorCopies(env, tok, file.id, job.id);
  let created;
  let parent = file.folderId;
  if (job.options.mode === "replace") {
    created = await multipart(env, tok, `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=multipart&fields=id,size,imageMediaMetadata(width,height)&supportsAllDrives=true`, "PATCH", { name, mimeType: mime, ...props }, body, mime);
  } else {
    // Archive stores and verifies the new file in the original's folder
    // before the original moves: moving first left the folder (and any share
    // gallery) without the photo whenever the upload or the size check failed.
    if (job.options.mode !== "archive") parent = await mirrorPath(env, "_compressed", file.path);
    created = await multipart(env, tok, "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size,imageMediaMetadata(width,height)&supportsAllDrives=true", "POST", { name, mimeType: mime, parents: [parent], ...props }, body, mime);
  }
  const size = Number(created.size) || 0;
  if (size !== body.byteLength) {
    if (job.options.mode !== "replace") await driveTrashFile(env, created.id).catch(() => {});
    return json({ error: `Drive stored ${size} bytes, expected ${body.byteLength}` }, 502);
  }
  if (job.options.mode === "archive") {
    const archive = await mirrorPath(env, "_archive", file.path);
    // A retried PUT may find the original already archived by an earlier attempt.
    const current = (await archiveFolderOf(env, tok, file.id)) || file.folderId;
    if (current !== archive) {
      try {
        await moveFile(env, tok, file.id, current, archive);
      } catch (error) {
        await driveTrashFile(env, created.id).catch(() => {});
        throw error;
      }
    }
  }
  return json({ ok: true, id: created.id, size, w: created.imageMediaMetadata?.width || 0, h: created.imageMediaMetadata?.height || 0, parent });
}

// Batch report: {done: [{id, newId, size, ms, via, parent}], skipped: [{id, error}], finished?, stopped?}
export async function reportImageBatch(request, env, ctx, jobId) {
  const b = await request.json().catch(() => ({}));
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  const known = new Map(job.files.map((f) => [f.id, f]));
  job.outputs ||= [];
  job.runIds ||= [];
  const runId = cleanText(String(b.runId || ""), 30);
  if (runId && !job.runIds.includes(runId) && job.runIds.length < 10) job.runIds.push(runId);
  // A batch the runner re-sends (its first response was lost, or it rides
  // along with the stop report) must not count twice.
  const seen = new Map(job.items.map((i) => [i.id, i]));
  for (const d of b.done || []) {
    const f = known.get(d.id);
    if (!f || seen.get(d.id)?.ok) continue;
    seen.set(d.id, { ok: true });
    job.items.push({ id: d.id, ok: true, newId: d.newId, size: Number(d.size) || 0, ms: Number(d.ms) || 0, via: cleanText(d.via || "", 12) || undefined, q: Number(d.q) || undefined, mode: job.options.mode });
    job.progress.done += 1;
    job.progress.bytesIn += f.size;
    job.progress.bytesOut += Number(d.size) || 0;
    if (d.parent && job.outputs.length < 40 && !job.outputs.includes(d.parent)) job.outputs.push(cleanText(d.parent, 120));
  }
  for (const s of b.skipped || []) {
    if (!known.has(s.id) || seen.has(s.id)) continue;
    seen.set(s.id, { ok: false });
    const soft = /not smaller|unsupported|gain-map|already/i.test(s.error || "");
    job.items.push({ id: s.id, ok: false, soft, error: cleanText(s.error || "failed", 160) });
    job.progress[soft ? "skipped" : "failed"] += 1;
    if (!soft) appLog(env, ctx, { level: "warn", area: "images", message: `job ${job.id}: ${known.get(s.id)?.name || s.id} failed`, detail: s.error });
  }
  let next = null;
  if (b.finished) {
    job.status = "done";
    job.finishedAt = Date.now();
    next = jobs.find((j) => j.status === "queued");
    if (next) {
      next.status = "running";
      next.startedAt = Date.now();
    }
  } else if (b.stopped && ["pausing", "running"].includes(job.status)) job.status = "paused";
  await saveJobs(env, jobs);
  if (b.finished) {
    appLog(env, ctx, { area: "images", message: `job ${job.id} finished: ${job.progress.done} done, ${job.progress.failed} failed, ${job.progress.skipped} skipped, ${job.progress.bytesIn} → ${job.progress.bytesOut} bytes` });
    if (job.notify !== false) ctx?.waitUntil?.(emailJobDigest(env, job).catch((error) => appLog(env, ctx, { level: "warn", area: "email", message: "job digest email failed", detail: error.message })));
  } else if (b.stopped) appLog(env, ctx, { area: "images", message: `job ${job.id} paused at ${job.progress.done}/${job.files.length}` });
  if (next) {
    const result = await dispatch(env, next.id);
    appLog(env, ctx, { level: result.dispatched ? "info" : "warn", area: "images", message: `queued job ${next.id} started after ${job.id}${result.dispatched ? "" : " - not dispatched: " + result.reason}` });
  }
  return json({ ok: true, status: job.status, progress: job.progress, next: next?.id });
}

const fmtMb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
async function emailJobDigest(env, job) {
  const p = job.progress;
  const saved = Math.max(0, p.bytesIn - p.bytesOut);
  const failed = job.items.filter((i) => !i.ok && !i.soft).slice(0, 15);
  const names = new Map(job.files.map((f) => [f.id, f.name]));
  const subject = `Image archive done: ${p.done} files, ${fmtMb(p.bytesIn)} → ${fmtMb(p.bytesOut)}${p.failed ? ` (${p.failed} failed)` : ""}`;
  const html = `<h2 style="margin:0 0 8px">${escapeHtml(job.roots.map((r) => r.name).join(", "))}</h2>
    <p style="margin:0 0 12px;color:#4a5b70">${job.options.mode} · ${job.options.maxMp ? `${job.options.maxMp} MP` : "full resolution"} · ${job.options.targetBytes ? `~${fmtMb(job.options.targetBytes)} target` : `quality ${job.options.quality}`} · ${job.options.format}</p>
    <table style="border-collapse:collapse;font-size:14px"><tr><td style="padding:4px 12px 4px 0">Processed</td><td><b>${p.done}</b> of ${job.files.length}</td></tr><tr><td style="padding:4px 12px 4px 0">Size</td><td><b>${fmtMb(p.bytesIn)} → ${fmtMb(p.bytesOut)}</b> (saved ${fmtMb(saved)}, ${p.bytesIn ? Math.round((saved / p.bytesIn) * 100) : 0}%)</td></tr><tr><td style="padding:4px 12px 4px 0">Failed / skipped</td><td>${p.failed} / ${p.skipped}</td></tr><tr><td style="padding:4px 12px 4px 0">Took</td><td>${Math.round(((job.finishedAt || Date.now()) - job.startedAt) / 60000)} min</td></tr></table>
    ${failed.length ? `<p style="margin:12px 0 4px"><b>Failed</b></p><ul style="margin:0;padding-left:18px;font-size:13px">${failed.map((i) => `<li>${escapeHtml(names.get(i.id) || i.id)} — ${escapeHtml(i.error)}</li>`).join("")}</ul>` : ""}
    ${job.outputs?.length ? `<p style="margin:12px 0 0"><a href="https://drive.google.com/drive/folders/${job.outputs[0]}">Open the output folder</a></p>` : ""}
    <p style="margin:12px 0 0;font-size:12px;color:#8a97a8">Job ${job.id} · <a href="https://dropbox.losthusky.qzz.io/admin/images">Image archive</a></p>`;
  await sendNotify(env, { subject, html, text: subject, category: "image-archive", idempotencyKey: `img-digest-${job.id}` });
}

// Item detail for the admin (names resolved from the plan).
export async function imageJobItems(env, jobId) {
  const job = (await loadJobs(env)).find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  const names = new Map(job.files.map((f) => [f.id, f]));
  return json({ items: job.items.map((i) => ({ ...i, name: names.get(i.id)?.name || i.id, path: names.get(i.id)?.path || "", sizeIn: names.get(i.id)?.size || 0 })).reverse() });
}

// Undo a copy job (trash the copies) or an archive job (move originals
// back, trash the copies). Chunked: the admin calls until `remaining` is 0.
export async function undoImageJob(env, ctx, jobId) {
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  if (job.options.mode === "replace") return json({ error: "replace jobs cannot be undone here - restore the previous revision from Drive's version history" }, 409);
  if (["running", "pausing"].includes(job.status)) return json({ error: "pause or cancel the job first" }, 409);
  if (["planned", "queued"].includes(job.status)) return json({ error: "job has not run yet - nothing to undo" }, 409);
  const tok = await accessToken(env);
  const files = new Map(job.files.map((f) => [f.id, f]));
  const pending = job.items.filter((i) => i.ok && !i.undone);
  let undone = 0;
  for (const item of pending.slice(0, 60)) {
    try {
      if (job.options.mode === "archive") {
        const f = files.get(item.id);
        const archived = await archiveFolderOf(env, tok, item.id);
        if (f && archived) await moveFile(env, tok, item.id, archived, f.folderId);
      }
      if (item.newId) await driveTrashFile(env, item.newId);
      item.undone = true;
      delete item.undoError;
      undone += 1;
    } catch (error) {
      item.undoError = cleanText(error.message, 120);
    }
  }
  const remaining = job.items.filter((i) => i.ok && !i.undone && !i.undoError).length;
  // Files that could not be restored keep the job "done", so undo can be
  // retried, and the admin is told how many are still archived.
  const failed = job.items.filter((i) => i.ok && !i.undone && i.undoError).length;
  if (!remaining && !failed) {
    job.status = "undone";
    appLog(env, ctx, { area: "images", message: `job ${job.id} undone (${job.items.filter((i) => i.undone).length} files)` });
  }
  await saveJobs(env, jobs);
  return json({ ok: true, undone, remaining, failed, status: job.status });
}
async function archiveFolderOf(env, tok, fileId) {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?fields=parents&supportsAllDrives=true`, { headers: { authorization: `Bearer ${tok}` } });
  return r.ok ? ((await r.json()).parents || [])[0] : null;
}
