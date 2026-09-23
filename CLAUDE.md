# husky-drop

**Read [`docs/CONTEXT.md`](docs/CONTEXT.md) before doing anything else.** It is
the map of this repo: what each file is for, how a request flows, where state
lives, and which traps have already cost someone an afternoon. It is written to
be read once per session instead of re-derived by grepping.

A personal file-delivery service on Cloudflare Workers, live at
https://dropbox.losthusky.qzz.io. Drop links receive files straight into Google
Drive; share links hand out galleries of Drive folders. **File bytes never pass
through the Worker on upload.**

## Ground rules

- Branch → PR (one concern each) → merge. The GitHub → Cloudflare integration
  deploys in ~1–2 minutes. **Never `npm run deploy`.**
- `npm test` runs ESLint and every script in `scripts/`. It must exit 0 before
  a PR, no exceptions.
- Update `docs/API.md` (endpoints) and `docs/CHANGELOG.md` (the why) in the
  same PR as the change, not after.
- After merging, probe production. Merged is not finished.
- Non-trivial logic leaves behind the smallest check that fails if it breaks.
- Vanilla JS, no bundler, no framework. Keep modules under ~500 lines.
- Anything user-controlled that reaches HTML goes through `esc()` / `escAttr()`
  / `escapeHtml()`, or is set with `textContent`.
- Match the line endings already in a file; several are CRLF.
- Never commit secrets. `.dev.vars` is local-only and gitignored.

## Where things are

| | |
| --- | --- |
| Session primer | [`docs/CONTEXT.md`](docs/CONTEXT.md) |
| Operating the live service | [`docs/RUNBOOK.md`](docs/RUNBOOK.md) |
| Endpoints | [`docs/API.md`](docs/API.md) |
| Why things are this way | [`docs/CHANGELOG.md`](docs/CHANGELOG.md) |
| Deploy and secrets | [`docs/DEPLOY.md`](docs/DEPLOY.md) |
| Everything else | [`docs/README.md`](docs/README.md) |
