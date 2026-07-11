# README Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the root README with a modern product showcase and accurate self-hosting guide, supported by a generated banner and real interface captures.

**Architecture:** The README remains a portable GitHub Markdown document. Project-bound visual assets live under `docs/assets/readme/`; an automated validation script checks referenced local files, documentation links, required safety copy, and forbidden placeholders.

**Tech Stack:** GitHub Flavored Markdown, Mermaid, PNG/WebP assets, Node.js validation, existing npm test suite, Wrangler.

## Global Constraints

- Use only claims supported by production code or current documentation.
- Never expose secrets, real Drive identifiers, personal email addresses, or private admin data.
- Keep the README useful to portfolio visitors and self-hosters equally.
- Do not add runtime dependencies.

---

### Task 1: Add README validation

**Files:**
- Create: `scripts/readme-test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: root `README.md` and repository filesystem.
- Produces: a zero-exit validation command included in `npm test`.

- [ ] Write assertions for required sections, local links, local images, banned placeholders, and the direct-to-Drive security statement.
- [ ] Run `node scripts/readme-test.mjs` and confirm it fails against the old README.
- [ ] Add the script to the end of the existing `npm test` chain.

### Task 2: Produce project visuals

**Files:**
- Create: `docs/assets/readme/husky-drop-banner.png`
- Create: `docs/assets/readme/admin-overview.png`
- Create: `docs/assets/readme/drop-page.png`
- Create: `docs/assets/readme/share-links.png`

**Interfaces:**
- Consumes: current product palette and static redesign mockups.
- Produces: optimized, repository-local images referenced by the README.

- [ ] Generate an original text-free hero banner using the built-in image generation tool.
- [ ] Capture the real static mockups at a consistent desktop viewport using placeholder data only.
- [ ] Verify dimensions, file sizes, legibility, and absence of sensitive data.

### Task 3: Replace the README

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the visual assets, current code behavior, and `docs/*.md` operational references.
- Produces: the repository landing page rendered by GitHub.

- [ ] Write the hero, badges, live link, screenshot showcase, differentiators, architecture, security, stack, quick start, configuration, deployment, documentation, and limits sections.
- [ ] Use relative links for repository assets and documentation.
- [ ] Keep setup commands consistent with `package.json`, `wrangler.example.jsonc`, and `docs/DEPLOY.md`.

### Task 4: Verify and publish

**Files:**
- Verify: `README.md`, `docs/assets/readme/*`, `scripts/readme-test.mjs`

**Interfaces:**
- Consumes: completed README and assets.
- Produces: a tested commit on `main` pushed to `origin/main`.

- [ ] Run `node scripts/readme-test.mjs` and expect `README checks passed`.
- [ ] Run `npm test` and expect every suite to pass.
- [ ] Run `npx wrangler deploy --dry-run` and expect exit code 0.
- [ ] Run `git diff --check` and inspect the final diff for secret or claim mistakes.
- [ ] Commit without co-author metadata and push `main` to `origin/main`.
