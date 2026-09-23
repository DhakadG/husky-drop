# Review — `scripts/review/render.mjs`

_agent review (file) · 2026-09-23_

> Turns the JSON into the three working documents cleanly and ranks by severity then confidence. It assumes a per-target Markdown file exists, which only the API runner writes.

## Findings

### LOW · Render the per-target Markdown that INDEX, TOP and PLAN link to

**Where:** 43, 56, 69, 90 · **Category:** correctness · **Confidence:** 0.9

**When:** A pass done by an agent (docs/REVIEW.md, 'Without an API key'), which writes only <target>.json and then runs render.mjs as instructed.

**Result:** Every '[full review](<slug>.md)' and target link in INDEX.md, TOP.md and PLAN.md points at a file that does not exist on the reviews branch, so the reader cannot open a target's verdict, questions or low-severity findings. REVIEW.md says render.mjs 'regenerates every summary', which it does not.

**Fix:** Move renderMarkdown from run.mjs into a shared module and have render.mjs write <slug>.md for every JSON that lacks one (or always, using tokensIn/model when present).
