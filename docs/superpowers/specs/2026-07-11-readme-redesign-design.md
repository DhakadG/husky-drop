# README Redesign — Design Specification

## Objective

Turn the root README into a modern landing page that works equally well as a portfolio showcase and a self-hosting guide. The first screen should explain the product and establish visual quality; the rest should let a technical reader evaluate architecture, security, setup, and operations without searching through the repository.

## Audience

- Portfolio visitors should understand the product, its originality, and the quality of the interface within one minute.
- Self-hosters should understand the data path, prerequisites, security boundaries, setup sequence, configuration, tests, and deployment workflow.

## Visual Direction

- Preserve the product's current blue, teal, violet, glass, and soft-cloud visual language.
- Generate one original wide hero illustration with no embedded text, logos, fake screenshots, or claims.
- Show real interface captures for the admin dashboard, public drop page, and share gallery.
- Prefer a compact static showcase over a large GIF. Animation is not useful enough to justify its download cost here.
- Keep GitHub rendering portable: standard Markdown, supported HTML alignment, Mermaid, relative image paths, and Shields badges.

## Information Architecture

1. Hero banner, product name, one-sentence value proposition, badges, and live-site link.
2. Product showcase with real screenshots and three audience-facing experiences.
3. Differentiators: direct-to-Drive data path, resumability, adaptive transfers, live operations, private sharing, and abuse containment.
4. Architecture diagram and request/data-flow explanation.
5. Security and privacy boundaries, including explicit non-goals.
6. Technology stack and repository map.
7. Quick start, Google/Cloudflare prerequisites, secrets, and local development.
8. Validation and deployment workflow.
9. Documentation index and known limits.

## Truth and Safety Constraints

- Every feature claim must be traceable to production code or current documentation.
- Do not claim end-to-end encryption, antivirus scanning, Turnstile, unlimited storage, zero cost in every deployment, or production readiness for arbitrary public use.
- State that file bytes travel from the browser directly to Google Drive and the Worker acts as the control plane.
- Do not expose real tokens, OAuth credentials, account IDs, Drive folder IDs, personal email addresses, or private admin data in text or images.
- Use `wrangler.example.jsonc` in setup instructions; never present the local `wrangler.jsonc` as a file to commit.
- Keep the two-step release model explicit: push Git history, then deploy separately to Cloudflare.

## Assets

- `docs/assets/readme/husky-drop-banner.png`: generated abstract hero illustration.
- `docs/assets/readme/admin-overview.png`: real admin mockup capture using placeholder data.
- `docs/assets/readme/drop-page.png`: real public uploader mockup capture.
- `docs/assets/readme/share-links.png`: real share-links mockup capture.

## Acceptance Criteria

- README opens with a polished, recognizable visual identity and an accurate product summary.
- Both target audiences can find their primary information without reading the entire document.
- All relative image and documentation links resolve.
- Mermaid uses GitHub-supported syntax.
- Commands match the repository's current scripts and deployment model.
- `npm test`, Markdown link checks, asset checks, and a Wrangler dry run pass before commit.
