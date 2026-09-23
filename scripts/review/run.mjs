#!/usr/bin/env node
// Whole-file and whole-surface review runner.
//
// CodeRabbit and the opencode action review a diff. This reviews the thing
// itself: every source file end to end, and every feature surface as a whole.
// It runs in GitHub Actions across shards, writes one JSON + one Markdown per
// target, and skips targets whose content has not changed since the last run.
//
//   node scripts/review/run.mjs --mode file    --shard 0 --shards 8
//   node scripts/review/run.mjs --mode surface --only share-gallery
//   node scripts/review/run.mjs --mode file    --dry        # no API calls
//
// ANTHROPIC_API_KEY is required unless --dry.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { fileReviewPrompt, surfaceReviewPrompt } from "./prompts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const surfaces = JSON.parse(fs.readFileSync(path.join(root, "scripts/review/surfaces.json"), "utf8"));

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) continue;
  const next = process.argv[i + 1];
  args.set(a.slice(2), next && !next.startsWith("--") ? (i++, next) : "true");
}
const MODE = args.get("mode") || "file";
const SHARD = Number(args.get("shard") || 0);
const SHARDS = Math.max(1, Number(args.get("shards") || 1));
const OUT = path.resolve(root, args.get("out") || "review-out");
const DRY = args.get("dry") === "true";
const ONLY = args.get("only") || "";
const MODEL = args.get("model") || (MODE === "surface" ? "claude-opus-5" : "claude-sonnet-5");
const MAX_BYTES = Number(args.get("max-bytes") || 160_000);
// Read once, by name: the only environment value that ever leaves this process.
const API_KEY = process.env.ANTHROPIC_API_KEY || "";
if (!DRY && !API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set (use --dry to build prompts without calling the API)");
  process.exit(1);
}

// Files worth reviewing: tracked, ours, and not generated.
const SKIP = /^(public\/vendor\/|public\/icons\.svg|docs\/archive\/|docs\/assets\/|graphify-out\/)|\.(png|jpe?g|webm|mp4|mov|svg)$|package-lock\.json$/;
const CODE = /\.(js|mjs|css|html|jsonc?|yml)$/;

const tracked = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
const reviewable = tracked.filter((f) => CODE.test(f) && !SKIP.test(f));

const numbered = (text) =>
  text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
    .join("\n");

const sha = (s) => createHash("sha256").update(s).digest("hex").slice(0, 16);

// The repo's own primer is the context. Trimmed so it does not dwarf the file.
function repoContext() {
  const context = fs.readFileSync(path.join(root, "docs/CONTEXT.md"), "utf8").replace(/\r\n/g, "\n");
  const wanted = ["## 1.", "## 2.", "## 4.", "## 5.", "## 7."];
  const sections = context.split(/\n(?=## )/).filter((s) => wanted.some((w) => s.startsWith(w)));
  return `## What this codebase is (from its own docs/CONTEXT.md)\n\n${sections.join("\n").slice(0, 14_000)}`;
}

// A file's role line out of CONTEXT.md's tables, plus its import graph.
function fileFacts(rel) {
  const base = path.basename(rel);
  const context = fs.readFileSync(path.join(root, "docs/CONTEXT.md"), "utf8");
  const row = context.split(/\r?\n/).find((l) => l.startsWith(`| \`${base}\``) || l.includes(`\`${rel}\` |`));
  const role = row ? row.split("|").slice(2).join("|").replace(/\|/g, " ").trim() : "";
  const source = fs.readFileSync(path.join(root, rel), "utf8");
  const imports = [...source.matchAll(/from "\.\/([\w.-]+)"/g)].map((m) => m[1]);
  const importedBy = reviewable
    .filter((f) => f !== rel && /\.(js|mjs)$/.test(f) && path.dirname(f) === path.dirname(rel))
    .filter((f) => fs.readFileSync(path.join(root, f), "utf8").includes(`./${base}`))
    .map((f) => path.basename(f));
  return { role, source, imports: [...new Set(imports)], importedBy };
}

async function ask(prompt, model) {
  const body = {
    model,
    max_tokens: 8000,
    messages: [{ role: "user", content: prompt }],
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    }).catch((error) => ({ ok: false, status: 0, text: async () => String(error) }));
    if (res.ok) {
      const json = await res.json();
      return { text: json.content?.map((c) => c.text || "").join("") || "", usage: json.usage || {} };
    }
    const detail = (await res.text()).slice(0, 300);
    if (res.status === 429 || res.status >= 500 || res.status === 0) {
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
      continue;
    }
    throw new Error(`anthropic ${res.status}: ${detail}`);
  }
  throw new Error("anthropic: giving up after 4 attempts");
}

// Models wrap JSON in prose often enough that this has to be forgiving.
function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try {
    return JSON.parse(candidate);
  } catch {
    return { verdict: "unparseable model output", findings: [], raw: text.slice(0, 4000) };
  }
}

const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
const bySeverity = (a, b) => (sevRank[a.severity] ?? 9) - (sevRank[b.severity] ?? 9) || (b.confidence || 0) - (a.confidence || 0);

function renderMarkdown(target, result, meta) {
  const findings = (result.findings || []).sort(bySeverity);
  const lines = [
    `# Review — \`${target}\``,
    "",
    `_${meta.model} · ${meta.tokensIn} in / ${meta.tokensOut} out · ${new Date().toISOString().slice(0, 10)}_`,
    "",
    `> ${result.verdict || "(no verdict)"}`,
    "",
  ];
  if (findings.length) {
    lines.push("## Findings", "");
    for (const f of findings) {
      lines.push(
        `### ${f.severity?.toUpperCase() || "?"} · ${f.title || "(untitled)"}`,
        "",
        `**Where:** ${f.lines || f.where || "?"} · **Category:** ${f.category || "?"} · **Confidence:** ${f.confidence ?? "?"}`,
        "",
        `**When:** ${f.scenario || "?"}`,
        "",
        `**Result:** ${f.consequence || "?"}`,
        "",
        `**Fix:** ${f.fix || "?"}`,
        "",
      );
    }
  } else {
    lines.push("No findings.", "");
  }
  for (const [key, heading] of [
    ["missing", "## Missing"],
    ["layout", "## Layout"],
    ["questions", "## Open questions"],
  ]) {
    const items = result[key];
    if (Array.isArray(items) && items.length) lines.push(heading, "", ...items.map((i) => `- ${i}`), "");
  }
  if (Array.isArray(result.missing_features) && result.missing_features.length) {
    lines.push("## Missing features", "", "| Feature | Why | Where | Effort | Needs |", "| --- | --- | --- | --- | --- |");
    for (const m of result.missing_features) {
      lines.push(`| ${m.title} | ${m.why} | ${m.where} | ${m.effort} | ${m.depends_on} |`);
    }
    lines.push("");
  }
  if (Array.isArray(result.interlinks) && result.interlinks.length) {
    lines.push("## Should link to", "", "| From | To | Why |", "| --- | --- | --- |");
    for (const l of result.interlinks) lines.push(`| ${l.from} | ${l.to} | ${l.why} |`);
    lines.push("");
  }
  if (result.raw) lines.push("## Unparsed model output", "", "```", result.raw, "```", "");
  return lines.join("\n");
}

function targets() {
  if (MODE === "surface") {
    return Object.entries(surfaces)
      .filter(([key]) => !ONLY || ONLY.split(",").includes(key))
      .map(([key, s]) => ({ key, ...s }));
  }
  return reviewable
    .filter((f) => !ONLY || ONLY.split(",").includes(f))
    .map((f) => ({ key: f }));
}

const mine = targets().filter((_, i) => i % SHARDS === SHARD);
fs.mkdirSync(OUT, { recursive: true });

// A manifest of what was reviewed at which content hash, so a re-run only
// pays for what changed.
const manifestPath = path.join(OUT, "manifest.json");
const manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, "utf8")) : {};

let done = 0;
let skipped = 0;
let tokensIn = 0;
let tokensOut = 0;

for (const target of mine) {
  const slug = target.key.replace(/[/\\]/g, "__");
  let prompt;
  let fingerprint;

  if (MODE === "surface") {
    const parts = [...(target.files || []), ...(target.html || [])].filter((f) => fs.existsSync(path.join(root, f)));
    const bodies = parts.map((f) => `\n\n===== ${f} =====\n${numbered(fs.readFileSync(path.join(root, f), "utf8"))}`).join("");
    if (bodies.length > MAX_BYTES * 4) console.warn(`! ${target.key}: ${bodies.length} chars, this will be an expensive call`);
    // Same fingerprint as queue.mjs and mark.mjs (raw files joined by "\n",
    // before numbering), or a surface marked by one is re-reviewed by the other.
    fingerprint = sha(parts.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n"));
    prompt = surfaceReviewPrompt({ title: target.title, what: target.what, api: target.api || [], files: bodies, context: repoContext() });
  } else {
    const stat = fs.statSync(path.join(root, target.key));
    if (stat.size > MAX_BYTES) {
      console.log(`- skip ${target.key} (${stat.size} bytes, over --max-bytes)`);
      skipped += 1;
      continue;
    }
    const facts = fileFacts(target.key);
    fingerprint = sha(facts.source);
    prompt = fileReviewPrompt({ path: target.key, role: facts.role, imports: facts.imports, importedBy: facts.importedBy, source: numbered(facts.source), context: repoContext() });
  }

  if (manifest[target.key]?.fingerprint === fingerprint && !args.get("force")) {
    console.log(`= skip ${target.key} (unchanged since last review)`);
    skipped += 1;
    continue;
  }

  if (DRY) {
    console.log(`~ ${target.key}: ${Math.round(prompt.length / 4)} tokens of prompt`);
    tokensIn += Math.round(prompt.length / 4);
    done += 1;
    continue;
  }

  const started = Date.now();
  const { text, usage } = await ask(prompt, MODEL);
  const result = parseJson(text);
  const meta = { model: MODEL, tokensIn: usage.input_tokens || 0, tokensOut: usage.output_tokens || 0, ms: Date.now() - started };
  tokensIn += meta.tokensIn;
  tokensOut += meta.tokensOut;
  fs.writeFileSync(path.join(OUT, `${slug}.json`), JSON.stringify({ target: target.key, mode: MODE, ...meta, ...result }, null, 2));
  fs.writeFileSync(path.join(OUT, `${slug}.md`), renderMarkdown(target.key, result, meta));
  manifest[target.key] = { fingerprint, at: Date.now(), findings: (result.findings || []).length };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  done += 1;
  console.log(`✓ ${target.key}: ${(result.findings || []).length} findings (${meta.tokensIn}/${meta.tokensOut} tokens, ${meta.ms} ms)`);
}

console.log(`\n${MODE} review shard ${SHARD}/${SHARDS}: ${done} reviewed, ${skipped} skipped, ${tokensIn} in / ${tokensOut} out`);
if (DRY) console.log(`dry run: ~${tokensIn} input tokens for this shard`);
