# Archive

Documents that were accurate once. They are kept because they explain how the
project got here — several decisions in the live code only make sense next to
them — but **none of them describe the system as it is now**. Do not follow
instructions in this folder.

Current documentation starts at [../CONTEXT.md](../CONTEXT.md).

| Parked | Was | Replaced by |
| --- | --- | --- |
| [PLAN.md](PLAN.md) | The original product plan, June 2026: a Smash-style receiver, Worker + KV + Durable Object, no bytes through the Worker. That premise is still true; the rest of the file is not. | [../CONTEXT.md](../CONTEXT.md), [../ARCHITECTURE.md](../ARCHITECTURE.md) |
| [GITHUB.md](GITHUB.md) | A checklist of which files were safe to push when the repo first went public. | `.gitignore` and [../DEPLOY.md](../DEPLOY.md) |
| [SETUP-REQUIRED.md](SETUP-REQUIRED.md) | A one-off "here is what you must configure after this upgrade" list from July 2026. | [../DEPLOY.md](../DEPLOY.md) |
| [STATUS-2026-09.md](STATUS-2026-09.md) | Goal-by-goal status of the September 2026 fix round, written while it was in flight. | [../CHANGELOG.md](../CHANGELOG.md) |
| [LIGHTBOX-FEATURE-COMPARISON.md](LIGHTBOX-FEATURE-COMPARISON.md) | A July 2026 feature-by-feature comparison of the PhotoSwipe viewer against lightGallery, used to decide what the viewer still needed. The gaps it lists have since been closed or dropped. | the viewer itself, `public/share-viewer-*.js` |
| [ui-redesign-2026-07/](ui-redesign-2026-07) | The UI 3.0 redesign package: hi-fi mockups of every page as standalone HTML, plus the migration plan that was executed against them. Useful if you want to see what the current design was aiming at. | the shipped UI, `public/style.css` |
| [transferzip-audit-2026-07/](transferzip-audit-2026-07) | A full audit of husky-drop against transfer.zip — feature matrix, gap analysis, security and performance notes, a dashboard blueprint and a roadmap. Most of the roadmap has shipped; share links, the image archive and the analytics dashboard all trace back to this document. | [../CHANGELOG.md](../CHANGELOG.md) |

`PLAN.md` and `ui-redesign-2026-07/redesign-package/PLAN.md` are deliberately
tracked in git despite the `/docs/plans/` ignore rules — they are historical
records, not working plans, and `scripts/plan-policy-test.mjs` asserts they
stay tracked at these paths.
