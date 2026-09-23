# Documentation

Start with **[CONTEXT.md](CONTEXT.md)** — the repo map, the request flows, the
conventions and the traps. Everything else is a detail of something it
mentions.

## Current

| Document | What it answers |
| --- | --- |
| [CONTEXT.md](CONTEXT.md) | What is where, how it works, how work ships here. Read once per session. |
| [RUNBOOK.md](RUNBOOK.md) | How to operate the live service: health, re-index, dedupe, drain previews, sweep R2, chase a failed upload. |
| [REVIEW.md](REVIEW.md) | The deep review pass: every file read end to end, every surface reviewed as a whole. How to run it, what it costs, how to work through the results. |
| [API.md](API.md) | Every endpoint, with payloads. |
| [ARCHITECTURE.md](ARCHITECTURE.md) | The drop side in depth: KV schema, the Durable Object, batched completions, upload tuning. |
| [CHANGELOG.md](CHANGELOG.md) | Newest first, with the reasoning. The fastest way to learn why something looks odd. |
| [DEPLOY.md](DEPLOY.md) | Secrets, bindings, first deploy, the GitHub integration. |
| [EMAIL.md](EMAIL.md) | Notification and digest email. |
| [SECURITY.md](SECURITY.md) | Threat model and the controls that answer it. |
| [superpowers/specs/](superpowers/specs) | Durable design specs, kept verbatim as received. Tracked in git. |

`superpowers/plans/` holds per-task progress trackers. It is **gitignored on
purpose** — plans are working notes, specs are the durable record, and
`scripts/plan-policy-test.mjs` fails the build if that stops being true.

## Archive

[archive/](archive) holds documents that were true once and are kept for
provenance. Nothing there describes the system as it is now — see its
[README](archive/README.md) for what each one was and what replaced it.
