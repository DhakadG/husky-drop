# Upload flow redesign, media sizing correction, and three loose ends

> Received 2026-09-20, second document. Reproduced verbatim below; the author's own caveat: where behaviour of unseen code (drop-api.js, live.js, live-completions.js, drive.js) is inferred, it is marked as such and must be verified against the files before implementing. Progress: [`../plans/2026-09-20-upload-flow-and-loose-ends.md`](../plans/2026-09-20-upload-flow-and-loose-ends.md). The user added one more ask at the end (§5).

Separate document, not merged into the media-cache-ladder spec — this covers a different part of the system (the upload path, not the share/serving path) plus a few things flagged against work already shipped there. Where I'm inferring behavior of code I haven't seen (drop-api.js, live.js, live-completions.js, drive.js), I've said so explicitly rather than presenting it as fact — verify against the actual files before implementing.

## 1. What actually happened to Arjun, and the fix

The report was: some videos wouldn't upload, the UI said "failed" with no code or explanation, no visual indication anything was happening while it sat stuck, and possibly-duplicated files afterward. That's five separate problems wearing one trenchcoat. Taking them in the order a fixed flow would address them.

### 1.0 This happened months ago and hasn't been reproduced on a fresh upload — treat everything below accordingly

That one fact changes the priority order. Nothing in §1.1–§1.6 should be read as "the confirmed cause" — it's "the most plausible explanations for symptoms described after the fact, unverified against current code." Two things follow from that:

- The incident itself is very likely undiagnosable now. Check the actual retention window on applog.js/live-analytics.js before assuming otherwise, but a system that wasn't designed with months-long upload-event retention in mind (and per §1.5 below, doesn't yet even capture per-file upload events at all, just system/rollup-level ones) almost certainly has nothing left from that far back. Don't spend effort trying to reconstruct exactly what Arjun hit — spend it on the two things that are actually recoverable from here.
- Reproduce before fixing. Before treating any specific hypothesis in §1.1–§1.4 as a real bug to patch, run a deliberate test upload against the current code: a large video file, a big batch, and ideally throttled/unstable network (Chrome DevTools network throttling, or a flaky Wi-Fi on purpose) — the conditions most likely to surface a silent stall or an opaque failure. Whatever reproduces is a confirmed bug; whatever doesn't reproduce may already be fine, and the corresponding section below is then forward-looking resilience rather than a patch for something proven broken today.
- Build §1.5 (the logging pipeline) first, regardless of what the reproduction test finds — it's the thing that turns the next "it failed and nobody knows why," whenever it happens, into a query instead of another unreproducible incident.

### 1.1 Instant local listing, before any network call

The "takes quite a while... without visual cues" complaint is almost certainly this: the file list only appears once something server-side confirms it, rather than the moment the browser has the file handles. Enumerating File objects (name, size, type, lastModified) from a drag-drop or file-picker event is synchronous and instant — there's no reason the full list, with a per-file placeholder status, shouldn't render before a single byte leaves the browser:

```
selected 47 files → render all 47 rows immediately as "queued"
→ then, per file, transition: queued → checking → (skip-duplicate |
   resuming | uploading) → verifying → done | failed
```

Each state transition is a UI update, not a network wait the user stares through blank.

### 1.2 Preflight dedup/resume check — three outcomes, not two

Before uploading anything, send a single batched request: for each file, its `{name, size, lastModified}` (cheap, already in hand from 1.1). The server checks this against what it already knows for this drop (completions already recorded, per live-completions.js) and answers per file with one of:

- **new** — nothing matching on record; upload normally.
- **duplicate** — a completed upload already matches on name + size (+ lastModified if you're recording that today) closely enough to treat as the same file; skip it, and say so in the UI rather than silently dropping it (an unexplained skip looks exactly like a failure from the user's side).
- **resumable** — a previous upload for this file started and has a live Drive resumable-session URI on record, not yet completed. Two sub-cases:
  - Session still valid → resume it directly via Drive's resumable-upload protocol: an empty PUT with `Content-Range: bytes */{size}` returns 308 Resume Incomplete with a Range header telling you exactly which bytes Drive already has; continue from there. This is Drive's own mechanism, not something to reinvent.
  - Session expired (resumable session URIs have a finite lifetime and do expire — Arjun coming back a day or two later is exactly this case) → the fingerprint match from the preflight check is what saves you here, not Drive's session; start a fresh resumable session but skip re-asking the user, since the match already told you it's the same file.

Name+size+mtime is a reasonable first heuristic (matches what you described), but it's a heuristic — two different files can coincidentally share all three. If that risk matters here, add a cheap content fingerprint (hash the first ~64KB + size, computed client-side, sent alongside the metadata) as a tiebreaker before committing to "duplicate." Don't hash the whole file client-side just for this check — that reintroduces the slowness you're trying to eliminate.

### 1.3 Progress that doesn't look identical to "frozen"

Two distinct pieces of state got collapsed into one in Arjun's experience: "still transferring bytes" and "stuck." Fix:

- Real progress, per file, from actual bytes-sent (either the resumable-upload chunk acknowledgments, or fetch/XHR upload progress events) — not a fake/estimated bar.
- A distinct "verifying" state after the last byte is sent but before Drive confirms the file is fully there — this is exactly the gap where "no error, but also nothing visibly happening" lives. Show it as its own labeled state, not as a continuation of the progress bar sitting at 100%.
- A client-side stall watchdog: no progress event for N seconds (e.g. 15–20s) on a file marked "uploading" → flip its UI state to "stalled," distinct from both "uploading" and "failed," with a manual retry affordance. This is the single change that would have told Arjun something was actually wrong instead of him having to guess.

### 1.4 Errors get a taxonomy, not just "failed"

Map whatever failure classes actually occur today into short codes with a plain-language line each, shown per file, with a "details" disclosure for the raw error. At minimum: network drop mid-transfer, Drive quota exceeded, OAuth token expired mid-session (needs a transparent refresh-and-retry, not a user-facing error at all, ideally), file rejected by Drive (unsupported/corrupt), request timeout, browser tab backgrounded/throttled long enough to kill the upload. "Failed" with no code is worse than any of these individually — it turns every future incident back into guesswork.

### 1.5 The activity/debug log, done properly

You already have the infrastructure for this (applog.js — "system log in the LiveTracker DO (SQLite), admin endpoint" — and live-analytics.js for rollups). The gap is scope: rollups and system-level events aren't the same thing as a queryable, per-file upload event stream. Concretely:

- Client buffers structured events locally (`{sessionId, fileId, fileName, stage, byteOffset, error?, timestamp}`) for every state transition in 1.1–1.4, and flushes them in small batches (not one request per event — that would itself become a reliability problem) to a Worker endpoint.
- Store them in the same DO's SQLite, in their own table, keyed for lookup by session and by drop — not folded into the general system log where they'd be hard to isolate later.
- Admin-facing: a per-drop "upload sessions" view, filterable by error type/file/time, so the next "it failed and I don't know why" report is a query, not a reconstruction from memory.
- Keep this bounded: batch/backoff the client's flush so a bad network doesn't turn logging itself into another failure source, and give the table the same kind of retention discipline as everything else in this system (a rolling window, not indefinite growth).

### 1.6 Also worth adding, since "no skipping, no errors" was the brief

- Idempotency on the server side: if a client retries a request that actually already succeeded server-side (client just didn't see the ack), the server should recognize the repeat and return the existing result rather than processing it twice — this is very likely the actual source of the "might be uploaded twice" suspicion, independent of the client-side dedup in 1.2.
- Post-upload verification against what Drive reports (size at minimum, checksum if available) before marking a file "done" — trusting only the client's "I finished sending" signal is exactly how a silently truncated upload turns into a "completed" file that isn't. If live-completions.js doesn't already do this, it's worth confirming whether it does before assuming completions are trustworthy.

### 1.7 The flow, end to end

```
select files
  → render full list instantly, all "queued" (§1.1)
  → one batched preflight request → server answers new/duplicate/resumable per file (§1.2)
  → duplicates: mark skipped, done
  → resumable: try Drive's resumable session; on expiry, start fresh but skip re-prompting
  → new + resumable-fresh: upload with real progress + verifying state + stall watchdog (§1.3)
  → structured event logged at every transition (§1.5)
  → server verifies against Drive before marking complete (§1.6)
  → final summary: exact per-file end state, not just "N of M done"
```

## 2. Thumbnail/preview sizing — get to actual KB, not MB

Two different tiers exist and shouldn't be conflated when talking about size targets:

| Tier | Purpose | Reasonable cap | Typical result |
| --- | --- | --- | --- |
| thumb-lo | folder-tile covers, small grid cells | 320px longest edge, WebP q75 | ~8–25 KB |
| thumb-md | default grid thumbnail | 640px longest edge, WebP q78 | ~25–70 KB |
| thumb-hi | larger grid / hover-preview source | 1280–1600px longest edge, WebP q80 | ~80–250 KB |
| preview-webp (RAW/HEIC/oversized-original stand-in, §5 of the other spec) | near-original viewing/download | up to ~4096px, WebP q85–90 | 150 KB–2 MB, legitimately |

The reported ~1 MB average and 15 GB projection is almost certainly dominated by the preview tier (the RAW-backlog conversions), not the thumbnail tier — those are two different jobs with two different size budgets, and it's worth confirming which number is which before "shrink the WebPs" gets applied to the wrong one. Shrinking preview-webp too aggressively defeats its purpose (it's supposed to stand in for the original); shrinking the thumb-* tiers is where the real, large discount lives, and it comes from capping resolution, not from pushing quality down at full resolution — a full-resolution WebP at q80 from a 24MP source is still hundreds of KB to a couple MB no matter how good the encoder is. One correction to the "13MB → 10KB with no loss" framing: that's achievable at thumbnail resolutions (roughly what thumb-lo/thumb-md above targets) — at a resolution meant to still look sharp full-screen (what preview-webp is for), 10KB isn't realistic regardless of encoder; the honest tradeoff there is "smaller edge length," not "same size, no visible loss." If the preview tier's total size still matters after the thumbnail fix, dropping its max edge from 4096px to ~2560px (a lever already identified) is the next lever to pull — a separate, smaller decision from the thumbnail cap fix above.

If the current thumbnail pipeline isn't already applying `.resize()` before `.webp()` for each variant — i.e. if it's WebP-encoding the original dimensions and only varying quality — that's the actual gap to close, not the WebP quality setting.

## 3. Three loose ends

### 3.1 Video duration badge — confirmed root cause

Straight from Google's own field documentation on `videoMediaMetadata.durationMillis`: "This may not be available immediately upon upload." That's the whole bug — Drive hasn't finished processing the video server-side at the moment the listing/index read its metadata, so durationMillis comes back null, and the badge has nothing to show. The video preview shows a correct duration because the browser's `<video>` element reads it directly from the file's own container once loaded — it never depended on Drive's metadata at all, which is why the two disagree.

Fix, properly rather than just papering over it:

- Primary: when a file's duration comes back missing at index time, mark it `durationPending` in the stats/index record rather than leaving a blank forever. A later targeted reindex pass (the incremental mechanism from the caching-ladder spec's §3.1) re-checks exactly these files — Drive typically finishes processing within minutes to a couple hours, so a retry a while later should pick it up without ever needing a full re-walk.
- Fallback, exactly as you suggested: when the client actually loads a video's metadata (scrubbing/previewing), read `video.duration` and patch the badge for that session — and optionally report it back so the next viewer doesn't hit the same gap. Frame this as the safety net, not the fix; the primary fix (re-check pending durations) is what makes this "not happen in the first place" for anyone who didn't happen to preview that specific video.

### 3.2 URL resets to the share root on refresh — this is a regression, not new

The previous rollout's own status report claimed this was fixed ("deep link restored on reload," PR #87), but your screenshots show breadcrumbs correctly reading Husky Photos PVT / Manali Hampta Pass -- 27 June - 02… / Ghanishth / RAW DATA / D2 – Balu ka Ghera… while the address bar still shows only the base share slug. That specific combination — breadcrumbs right, URL wrong — points at client-side pushState/replaceState doing the breadcrumb update correctly on navigation, while something (possibly a router guard, possibly an initial-mount effect) resets the URL back to the base path without a matching state change, rather than the server-side routing piece being wrong. Worth an explicit regression test rather than trusting the earlier fix: navigate three levels deep, do a hard reload (not a client-side nav), and assert both the URL and the breadcrumbs show the full path immediately on load — not "the breadcrumbs recover because client JS re-derives them after the fact."

### 3.3 Hover-preview edge awareness — extend the existing fix to all four edges, plus "load next"

The clamping fix from before already bounds top between margin and vh - ph - margin, so it technically can't render off the top/bottom — but clamping isn't the same as the smart flip it already does for left/right (flipping to the other side of the anchor when there's no room, rather than just sliding into the margin and potentially covering the cursor/anchor itself). Mirror the horizontal logic vertically:

```js
function positionPreview(preview, anchorRect) {
  const margin = 8;
  const { innerWidth: vw, innerHeight: vh } = window;
  const { width: pw, height: ph } = preview.getBoundingClientRect();

  let left = anchorRect.right + margin;
  if (left + pw > vw - margin) left = anchorRect.left - pw - margin; // flip left
  left = Math.min(Math.max(left, margin), vw - pw - margin);

  let top = anchorRect.top;
  if (top + ph > vh - margin) top = anchorRect.bottom - ph; // flip to sit above the bottom edge
  if (top < margin) top = anchorRect.top; // if flipping would go off the top instead, prefer below
  top = Math.min(Math.max(top, margin), vh - ph - margin);

  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
}
```

For "load next block" — whatever the next/prev navigation affordance is in the lightbox/masonry view (I don't have visibility into its exact DOM structure to give the same level of concrete fix here) — the same principle applies: it should measure its own rendered size against the viewport before deciding which side of the current item to render on, rather than assuming a fixed direction. Worth pointing whoever implements this at the exact element/component name so the same measure-then-clamp-or-flip pattern gets applied there instead of guessed.

## 4. Folder-card unevenness — this is a data gap, not (only) a CSS gap

The uniform-grid CSS fix (already shipped) makes every card the same size regardless of content — but your screenshot still shows some folders as bare icon-with-name and others with a cover photo plus full stats, and per the original design (§2.1 of the caching-ladder spec) that's the expected look for a folder that hasn't been indexed yet. The question is why some folders in a library that was reportedly fully indexed ("23,669 files / 126 folders indexed in 5 chunks") still show no stats at all. Possible causes, in rough likelihood order: the folder was added or renamed after the last completed index run and hasn't been picked up by a subsequent pass yet; that specific folder's walk chunk hit an error that was swallowed rather than surfaced; or the KV pointer for that folder's stats got written under a different key than the tile renderer is reading from. Rather than re-guessing from a screenshot: add (or use, if it already exists) an admin action that lists folders with no stats-blob entry after the most recent completed share-index run — that turns "some folders look wrong" into a specific, checkable list rather than something to eyeball from a screenshot each time.

## 5. (User addendum) Folder sort, filter and hover details

"We have folder stats now — we should be able to sort and filter based on this data as well instead of just name A–Z, size, time etc; folders should also have on-hover previews of some kind showing a lot of info about the folder."
