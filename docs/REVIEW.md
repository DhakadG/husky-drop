# Deep review

CI, Skylos, opencode and CodeRabbit all review **diffs**. Nothing reviewed the
code that is already here. This does: every source file read end to end, and
every feature surface — the files of one tab or one page, server and client
together — reviewed as a whole for what it should be and is not.

It runs in GitHub Actions, writes Markdown to a `reviews` branch, and costs
money, so it is `workflow_dispatch` only.

## One-time setup

Add one repo secret:

```
ANTHROPIC_API_KEY
```

Settings → Secrets and variables → Actions → New repository secret. The same
secret also wakes up `pr-review.yml`, which skips itself until it exists.

## Running it

Actions → **Deep review** → Run workflow.

| Input | Meaning |
| --- | --- |
| `mode` | `file` (every source file), `surface` (every feature area), or `both` |
| `only` | comma-separated targets, e.g. `src/share-index.js` or `admin-pipelines`. Blank means everything |
| `force` | re-review targets whose content has not changed since the last run |
| `shards` | how many parallel jobs the file pass uses (default 8) |
| `model` | override the model; blank uses Sonnet for files and Opus for surfaces |

Locally, the same runner works if you have a key in your environment:

```bash
node scripts/review/run.mjs --mode file --only src/share-index.js
node scripts/review/run.mjs --mode surface --only admin-pipelines
node scripts/review/run.mjs --mode file --dry            # prompts and token counts, no API calls
node scripts/review/render.mjs --out review-out
```

## What comes back

Results land on the **`reviews`** branch (an orphan branch — it never touches
`main`'s history) and as workflow artifacts:

| File | What it is |
| --- | --- |
| `INDEX.md` | every target, its severity counts and its one-line verdict, worst first |
| `TOP.md` | every critical and high finding in full, ranked — the fix-it list |
| `PLAN.md` | **the makeover backlog**: missing features with where they belong and what they need, things that should link to each other, and layout changes |
| `<target>.md` | the full review of one file or surface |
| `<target>.json` | the same, structured, for tooling |

To read them:

```bash
git fetch origin reviews:reviews && git checkout reviews
```

## What it costs

A full pass over this repo, measured with `--dry`:

| Pass | Targets | Input tokens |
| --- | --- | --- |
| file | 133 files | ~900k |
| surface | 14 surfaces | ~444k |

Output adds roughly 1–2k tokens per target. At list prices that is single-digit
dollars for the file pass on Sonnet and more for the surface pass on Opus —
check current pricing before a full run, and use `--only` while iterating.

Re-runs are cheap: each target's content is fingerprinted in `manifest.json`,
and unchanged targets are skipped unless you pass `force`.

## Why it is not generic

The prompts carry this repo's own context — `docs/CONTEXT.md`, the house rules
(no compare-and-set in KV, `waitUntil` caps at 30 s, escaping, the skeleton
vocabulary, what R2 is allowed to hold), the file's role, and its import graph.
They also carry an explicit list of what will be **discarded**: "consider adding
tests", style opinions, "this function is long", and any suggestion to adopt a
framework, TypeScript or a test runner. Twelve findings maximum per target, each
needing a location, a triggering scenario, a consequence a person would notice,
and an applicable fix.

The surface pass asks different questions from the file pass: is this surface
complete, is it connected, is it organised, does it tell the truth, does it hold
up across file boundaries. That is where "the tabs should do more than this"
comes from.

`scripts/review-test.mjs` runs in `npm test` and checks the plumbing against a
fake API: every surface names files that exist, every server and client module
belongs to a surface, sharding covers each file exactly once, unchanged targets
are skipped, and the renderer produces the three working documents.

## Working through the results

1. `TOP.md` first. Each finding is a candidate PR; confirm it against the code
   before believing it — a model reviewing a file in isolation can be confidently
   wrong about something the caller already guarantees.
2. Anything it flags that turns out to be real and preventable deserves a test,
   the way the innerHTML audit and the shard-report race did.
3. `PLAN.md` is a menu, not a mandate. Pick what the product actually wants.
4. When a finding is wrong because the reviewer lacked context, that is usually
   a gap in `docs/CONTEXT.md` — fix it there and the next run is smarter.
