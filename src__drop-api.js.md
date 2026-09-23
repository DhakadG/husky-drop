# Review — `src/drop-api.js`

_agent review (file) · 2026-09-23_

> Solid public endpoints: sessions are minted only after link state, sign-in, PIN, size, budget and quota checks, and completions are verified against Drive's own size. The incomplete preflight and the ungated /api/complete are filed under the drop-upload surface; the remaining file-local issue is that byte budgets only see completed files.

## Findings

### LOW · Count in-flight sessions against the byte budget

**Where:** 252-269 · **Category:** correctness · **Confidence:** 0.65

**When:** A drop has a 10 GB budget with 9.5 GB received; an uploader queues forty 400 MB videos and the page pre-mints sessions for up to 12 files ahead (prefetchNextSessions).

**Result:** Each /api/session checks stats.bytes (completed files only, and only after the Durable Object flushes) plus this one file, so every pre-minted and parallel session passes; the link can finish several GB over its budget before the auto-pause fires - the budget meant to stop a leaked link filling Drive leaks.

**Fix:** Keep a per-link 'reserved bytes' counter in the Durable Object (reserve on session mint, release on completion or after the session goes stale) and check stats.bytes + reserved + size.
