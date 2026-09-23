// Recurring image-archive rules and job-outcome conversion.
//
// Rules: `images:rules` KV key = { rules: [{id, name, options, every,
// enabled, createdAt, lastRunAt, lastJobId, lastResult}] }. The Worker cron
// (wrangler `triggers.crons`) calls runDueRules() nightly; a due rule plans
// with its saved options and starts (or queues) the job like the admin.
//
// Conversion: a finished copy job can become an archive job (originals to
// _archive/, copies take their place) and back. Replace jobs stay as they are.

import { json, cleanText } from "./util.js";
import { loadJobs, normalizeOptions, planJobRecord, publicJob, saveJobs } from "./images.js";
import { startJobRecord, imageMirrorPath, imageMoveFile, imageParentOf } from "./images-run.js";
import { appLog } from "./applog.js";
import { accessToken } from "./drive.js";

const RULES_KEY = "images:rules";
const EVERY = { daily: 1, weekly: 7, monthly: 30 };

async function loadRules(env) {
  return ((await env.KV.get(RULES_KEY, "json")) || {}).rules || [];
}
const saveRules = (env, rules) => env.KV.put(RULES_KEY, JSON.stringify({ rules: rules.slice(0, 20) }));

export async function listImageRules(env) {
  return json({ rules: await loadRules(env) });
}

export async function upsertImageRule(request, env, ctx) {
  const b = await request.json().catch(() => ({}));
  const rules = await loadRules(env);
  const id = cleanText(b.id || "", 40) || `rule-${Date.now().toString(36)}`;
  const existing = rules.find((r) => r.id === id);
  // Pause / enable: no options in the body means "change state only". The
  // stored options stay exactly as saved (and a replace rule needs no fresh
  // REPLACE confirmation just to be paused).
  if (existing && !("options" in b)) {
    if ("enabled" in b) existing.enabled = b.enabled !== false;
    if ("notify" in b) existing.notify = b.notify !== false;
    if (EVERY[b.every]) existing.every = b.every;
    if (b.name) existing.name = cleanText(b.name, 80);
    await saveRules(env, rules);
    appLog(env, ctx, { area: "rules", message: `${existing.enabled ? "enabled" : "paused"} rule "${existing.name}"` });
    return json({ ok: true, rule: existing });
  }
  const options = normalizeOptions(b.options || {});
  if (!options.folderIds.length) return json({ error: "a rule needs at least one folder" }, 400);
  if (options.mode === "replace" && b.confirm !== "REPLACE") return json({ error: "type REPLACE to save a rule that overwrites originals" }, 400);
  const rule = {
    ...(existing || { createdAt: Date.now() }),
    id,
    name: cleanText(b.name || existing?.name || "Nightly archive", 80),
    options,
    every: EVERY[b.every] ? b.every : existing?.every || "daily",
    enabled: b.enabled !== false,
    notify: b.notify !== false,
  };
  if (existing) Object.assign(existing, rule);
  else rules.unshift(rule);
  await saveRules(env, rules);
  appLog(env, ctx, { area: "rules", message: `${existing ? "updated" : "created"} rule "${rule.name}"`, detail: { id, every: rule.every, mode: options.mode, folders: options.folderIds.length } });
  return json({ ok: true, rule });
}

export async function deleteImageRule(env, ctx, id) {
  const rules = await loadRules(env);
  const next = rules.filter((r) => r.id !== id);
  if (next.length === rules.length) return json({ error: "rule not found" }, 404);
  await saveRules(env, next);
  appLog(env, ctx, { area: "rules", message: `deleted rule ${id}` });
  return json({ ok: true });
}

// Run one rule now (admin "run now") or all due rules (cron).
export async function runImageRule(env, ctx, id) {
  const rules = await loadRules(env);
  const rule = rules.find((r) => r.id === id);
  if (!rule) return json({ error: "rule not found" }, 404);
  const result = await executeRule(env, ctx, rule, "manual");
  await saveRules(env, rules);
  return json({ ok: true, ...result });
}

export async function runDueRules(env, ctx) {
  const rules = await loadRules(env);
  const now = Date.now();
  let touched = false;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const due = !rule.lastRunAt || now - rule.lastRunAt >= EVERY[rule.every] * 86400e3 - 3600e3;
    if (!due) continue;
    await executeRule(env, ctx, rule, "schedule");
    touched = true;
  }
  if (touched) await saveRules(env, rules);
}

async function executeRule(env, ctx, rule, trigger) {
  rule.lastRunAt = Date.now();
  try {
    const { job, jobs } = await planJobRecord(env, rule.options, { rule: rule.id, notify: rule.notify });
    if (!job.digest.files) {
      rule.lastResult = "nothing to do";
      appLog(env, ctx, { area: "rules", message: `rule "${rule.name}" (${trigger}): nothing to process`, detail: job.digest.skipped });
      return { started: false, reason: "nothing to do" };
    }
    const started = await startJobRecord(env, ctx, jobs, job);
    rule.lastJobId = job.id;
    rule.lastResult = `${job.digest.files} files ${started.status}`;
    appLog(env, ctx, { area: "rules", message: `rule "${rule.name}" (${trigger}): ${job.digest.files} files → job ${job.id} ${started.status}` });
    return { started: true, jobId: job.id, status: started.status };
  } catch (error) {
    rule.lastResult = `failed: ${error.message}`;
    appLog(env, ctx, { level: "error", area: "rules", message: `rule "${rule.name}" failed`, detail: error.message });
    return { started: false, reason: error.message };
  }
}

// ---- outcome conversion (copy <-> archive), chunked like undo ----
export async function convertImageJob(env, ctx, jobId, to) {
  const jobs = await loadJobs(env);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return json({ error: "job not found" }, 404);
  if (!["copy", "archive"].includes(to) || job.options.mode === "replace") return json({ error: "only copy and archive jobs can be converted" }, 409);
  if (!["done", "paused", "cancelled"].includes(job.status)) return json({ error: "finish, pause or cancel the job first" }, 409);
  if (job.options.mode === to && !job.converting) return json({ ok: true, remaining: 0, status: job.status });
  job.converting = to;
  const tok = await accessToken(env);
  const files = new Map(job.files.map((f) => [f.id, f]));
  const pending = job.items.filter((i) => i.ok && !i.undone && i.mode !== to);
  let converted = 0;
  for (const item of pending.slice(0, 40)) {
    const f = files.get(item.id);
    if (!f || !item.newId) continue;
    try {
      const copyParent = await imageParentOf(env, tok, item.newId);
      const origParent = await imageParentOf(env, tok, item.id);
      if (to === "archive") {
        // original -> _archive mirror, copy -> original's folder
        await imageMoveFile(env, tok, item.id, origParent, await imageMirrorPath(env, "_archive", f.path));
        await imageMoveFile(env, tok, item.newId, copyParent, f.folderId);
      } else {
        // copy -> _compressed mirror, original -> its folder
        await imageMoveFile(env, tok, item.newId, copyParent, await imageMirrorPath(env, "_compressed", f.path));
        await imageMoveFile(env, tok, item.id, origParent, f.folderId);
      }
      item.mode = to;
      converted += 1;
    } catch (error) {
      item.convertError = cleanText(error.message, 120);
    }
  }
  const remaining = job.items.filter((i) => i.ok && !i.undone && i.mode !== to && !i.convertError).length;
  if (!remaining) {
    job.options.mode = to;
    job.converting = undefined;
    appLog(env, ctx, { area: "images", message: `job ${job.id} converted to ${to}`, detail: { converted: job.items.filter((i) => i.mode === to).length } });
  }
  await saveJobs(env, jobs);
  return json({ ok: true, converted, remaining, job: publicJob(job) });
}
