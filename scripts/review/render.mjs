#!/usr/bin/env node
// Turn a directory of per-target review JSON into three things a person can
// actually work from: an index, a ranked list of what is broken, and the
// makeover backlog (missing features, missing links, layout changes).
//
//   node scripts/review/render.mjs --out review-out
import fs from "node:fs";
import path from "node:path";

const args = new Map();
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args.set(a.slice(2), process.argv[i + 1]?.startsWith("--") ? "true" : process.argv[++i]);
}
const OUT = path.resolve(args.get("out") || "review-out");

const results = fs
  .readdirSync(OUT)
  .filter((f) => f.endsWith(".json") && f !== "manifest.json")
  .map((f) => JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8")))
  .map((r) => ({ ...r, slug: r.target.replace(/[/\\]/g, "__") }));

const sevRank = { critical: 0, high: 1, medium: 2, low: 3 };
const rank = (f) => (sevRank[f.severity] ?? 9) - (f.confidence || 0) / 10;
const count = (r, sev) => (r.findings || []).filter((f) => f.severity === sev).length;
const esc = (s) => String(s ?? "").replace(/\|/g, "\\|").replace(/\n+/g, " ");

const totals = { critical: 0, high: 0, medium: 0, low: 0 };
for (const r of results) for (const f of r.findings || []) if (totals[f.severity] != null) totals[f.severity] += 1;

// ---- index ----
const index = [
  "# Review index",
  "",
  `${results.length} targets reviewed · **${totals.critical} critical**, ${totals.high} high, ${totals.medium} medium, ${totals.low} low`,
  "",
  "| Target | C | H | M | L | Verdict |",
  "| --- | --: | --: | --: | --: | --- |",
];
for (const r of [...results].sort((a, b) => count(b, "critical") - count(a, "critical") || count(b, "high") - count(a, "high"))) {
  index.push(`| [${r.target}](${r.slug}.md) | ${count(r, "critical")} | ${count(r, "high")} | ${count(r, "medium")} | ${count(r, "low")} | ${esc(r.verdict).slice(0, 160)} |`);
}
fs.writeFileSync(path.join(OUT, "INDEX.md"), index.join("\n") + "\n");

// ---- what is broken ----
const flat = results.flatMap((r) => (r.findings || []).map((f) => ({ ...f, target: r.target, slug: r.slug })));
const serious = flat.filter((f) => f.severity === "critical" || f.severity === "high").sort((a, b) => rank(a) - rank(b));
const top = ["# What is broken", "", `${serious.length} critical and high findings, worst first.`, ""];
for (const f of serious) {
  top.push(
    `## ${f.severity.toUpperCase()} · ${f.title}`,
    "",
    `\`${f.target}\` ${f.lines || f.where || ""} · ${f.category} · confidence ${f.confidence ?? "?"} · [full review](${f.slug}.md)`,
    "",
    `**When:** ${f.scenario}`,
    "",
    `**Result:** ${f.consequence}`,
    "",
    `**Fix:** ${f.fix}`,
    "",
  );
}
const rest = flat.filter((f) => f.severity === "medium" || f.severity === "low");
if (rest.length) {
  top.push("## Everything else", "", "| Target | Severity | Finding | Where |", "| --- | --- | --- | --- |");
  for (const f of rest.sort((a, b) => rank(a) - rank(b))) {
    top.push(`| [${f.target}](${f.slug}.md) | ${f.severity} | ${esc(f.title)} | ${esc(f.lines || f.where || "")} |`);
  }
  top.push("");
}
fs.writeFileSync(path.join(OUT, "TOP.md"), top.join("\n") + "\n");

// ---- the makeover backlog ----
const plan = ["# Makeover backlog", "", "What the reviews say this product should have and does not.", ""];

const features = results.flatMap((r) => (r.missing_features || []).map((m) => ({ ...m, target: r.target, slug: r.slug })));
if (features.length) {
  plan.push("## Missing features", "", "| Feature | Where it belongs | Why | Effort | Needs | Surface |", "| --- | --- | --- | --- | --- | --- |");
  const order = { small: 0, medium: 1, large: 2 };
  for (const m of features.sort((a, b) => (order[a.effort] ?? 9) - (order[b.effort] ?? 9))) {
    plan.push(`| ${esc(m.title)} | ${esc(m.where)} | ${esc(m.why)} | ${esc(m.effort)} | ${esc(m.depends_on)} | [${m.target}](${m.slug}.md) |`);
  }
  plan.push("");
}

const links = results.flatMap((r) => (r.interlinks || []).map((l) => ({ ...l, target: r.target, slug: r.slug })));
if (links.length) {
  plan.push("## Things that should link to each other", "", "| From | To | Why | Surface |", "| --- | --- | --- | --- |");
  for (const l of links) plan.push(`| ${esc(l.from)} | ${esc(l.to)} | ${esc(l.why)} | [${l.target}](${l.slug}.md) |`);
  plan.push("");
}

const layout = results.filter((r) => (r.layout || []).length);
if (layout.length) {
  plan.push("## Layout and organisation", "");
  for (const r of layout) {
    plan.push(`### ${r.target}`, "", ...r.layout.map((l) => `- ${l}`), "");
  }
}

const misc = results.filter((r) => (r.missing || []).length);
if (misc.length) {
  plan.push("## Gaps noted in file reviews", "");
  for (const r of misc) plan.push(`### \`${r.target}\``, "", ...r.missing.map((m) => `- ${m}`), "");
}
fs.writeFileSync(path.join(OUT, "PLAN.md"), plan.join("\n") + "\n");

const tokens = results.reduce((t, r) => t + (r.tokensIn || 0) + (r.tokensOut || 0), 0);
console.log(`rendered ${results.length} reviews: ${totals.critical} critical, ${totals.high} high, ${features.length} missing features, ${links.length} missing links (${tokens} tokens spent)`);
