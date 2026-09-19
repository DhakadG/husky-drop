#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gitignoreLines = fs.readFileSync(path.join(root, ".gitignore"), "utf8").split(/\r?\n/);

for (const rule of ["/docs/plans/", "/docs/superpowers/plans/"]) {
  assert.ok(gitignoreLines.includes(rule), `.gitignore must contain the anchored rule ${rule}`);
}

function git(args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} exited ${result.status}`);
  }
  return result;
}

for (const probe of [
  "docs/plans/policy-probe.md",
  "docs/superpowers/plans/policy-probe.md",
]) {
  const ignored = git(["check-ignore", "-q", "--no-index", probe], { allowFailure: true });
  assert.equal(ignored.status, 0, `${probe} must be ignored`);
}

const trackedPlans = git(["ls-files", "--", "docs/plans", "docs/superpowers/plans"])
  .stdout.trim();
assert.equal(trackedPlans, "", "implementation-plan roots must be absent from the Git index");

for (const durable of [
  "docs/PLAN.md",
  "docs/Personal Dropbox UI Redesign/redesign-package/PLAN.md",
  "docs/superpowers/specs/2026-07-10-redesign-icon-fidelity-design.md",
  "docs/superpowers/specs/2026-07-11-readme-redesign-design.md",
  "docs/superpowers/specs/2026-07-12-drive-sharing-observability-design.md",
  "docs/superpowers/specs/2026-07-12-viewer-intent-resolution-design.md",
  "docs/superpowers/specs/2026-07-14-mobile-responsive-design.md",
  "docs/superpowers/specs/2026-07-14-safe-development-foundation-design.md",
  "docs/superpowers/specs/2026-09-20-media-cache-ladder-design.md",
]) {
  const tracked = git(["ls-files", "--error-unmatch", "--", durable], { allowFailure: true });
  assert.equal(tracked.status, 0, `${durable} must remain tracked`);
}

console.log("implementation plan policy checks passed");
