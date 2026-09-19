# Media caching ladder, folder stats, and preview pipeline — design spec

> Received 2026-09-20 (source: claude.ai artifact `CQqLYpcq69mNGHmXFKcSLT`), revised the same day
> after a second review (auth ordering, Range support, per-share job lock, incremental stats writes,
> public-page escaping, single-drive confirmation). Reproduced verbatim below. Implementation progress is tracked in
> [`../plans/2026-09-20-media-cache-ladder.md`](../plans/2026-09-20-media-cache-ladder.md).

Everything here is written to slot into the existing husky-drop architecture (share-media.js, previews.js, images.js/images-run.js/images-rules.js, single-KV-key job records) rather than bolt on a parallel system. Section 0 is the two standalone bugs — ship those first, independent of everything else. Sections 1+ are one coherent system even though the original ask split it into "caching," "folder stats," and "RAW previews."

## 0. Bugs to fix first

### 0.1 Hover preview clipped at the window edge

The preview is being positioned from a fixed offset off the cursor/anchor without checking it against the viewport. Fix: measure the preview's real rendered size, then clamp/flip against `window.innerWidth`/`innerHeight`:

```js
function positionPreview(preview, anchorRect) {
  const margin = 8;
  const { innerWidth: vw, innerHeight: vh } = window;
  const { width: pw, height: ph } = preview.getBoundingClientRect();

  let left = anchorRect.right + margin;
  if (left + pw > vw - margin) left = anchorRect.left - pw - margin; // flip to the left
  left = Math.min(Math.max(left, margin), vw - pw - margin);

  let top = anchorRect.top;
  top = Math.min(Math.max(top, margin), vh - ph - margin);

  preview.style.left = `${left}px`;
  preview.style.top = `${top}px`;
}
```

Render the preview first frame with `visibility: hidden` (not `display: none`, so it still lays out and reports a real `getBoundingClientRect()`), measure, position, then flip to visible — avoids a flash of the wrongly-placed tooltip. Close on scroll rather than repositioning continuously; simpler and fine for a hover preview.

### 0.2 Refresh on a nested share folder drops to root and re-fetches everything

Two bugs presenting as one symptom:

- **Routing bug:** folder navigation inside the share page is client-side (the URL updates via pushState but nothing round-trips to the worker). On an actual page load, the server route for `/s/:slug/...` needs to parse the folder path out of the URL and hand the client app that starting folder — right now it's almost certainly serving the same shell regardless of path depth, and the client only knows to open a subfolder from a click handler, not from `location.pathname` on boot. Fix on the worker side: make the deep path a first-class route, not something normalized away before the client sees it. Fix on the client side: derive the initial folder from the URL on mount, not just after nav events.
- **Cache bug:** this is really solved by section 1 below. Today the loaded thumbnails/listings live in an in-page JS variable, so any reload — even one that gets the routing right — throws them away and re-hits Drive. Once thumbnails are backed by the browser Cache API / IndexedDB instead of page-lifetime memory, a refresh stops meaning "re-fetch everything," which is the actual complaint ("cache is stored in the browser for a while... on page load the local browser cache will be loaded").

## 1. The caching ladder

Three tiers, checked in order, each one only hit on a miss in the one above it:

```
L0  Browser (Cache API / IndexedDB)   — this device, ~30+ days
L1  Warm cache (R2 bucket)            — every viewer, effectively forever
L2  Origin (Google Drive, via share-media.js)  — only on a true miss
```

Cache key is content-addressed, not just file-id-based, so it self-invalidates without any explicit busting:

```
{fileId}-{driveChecksum-or-mtime}-{variant}
```

`variant` = `thumb-lo` / `thumb-hi` / `preview-webp` / `video-poster`, etc. **Decided:** video isn't a separate caching path — previews.js already produces 720p transcodes via GitHub Actions, so `video-poster`/video variants here just mean fronting those existing outputs with this same R2 + edge-cache ladder, not building parallel video handling. When a file changes in Drive, its `md5Checksum` (images/most files) or `modifiedTime` (fallback for types Drive doesn't checksum) changes, so the key changes, so old L0/L1 entries are simply never looked up again — no delete pass needed. Old keys age out of R2 via the lifecycle rule below instead of being actively hunted down.

### 1.1 Reclaiming orphaned R2 objects

**Decision:** a flat 30-day R2 lifecycle rule on the `media/` and `stats` prefixes, plus a manual "clear orphans now" button in the admin.

This deliberately does not try to track Drive's own trash-retention timer. An R2 object is orphaned the moment our own index no longer references its key (superseded by a new checksum, or the source file is gone from every folder we've walked) — that's true whether the Drive file is sitting in Drive's trash, permanently deleted, or just moved somewhere outside any indexed share. Coupling reclamation to Drive's trash-empty timing would mean polling trash state for no real benefit; our own 30-day grace window is independent of it and just as safe, since "is this actually superseded" was already established at index time — the lifecycle rule is just delayed cleanup of something we already know is unreferenced, not a safety check in itself. The manual button covers wanting space back sooner (e.g. right after a large deletion in Drive) than waiting on the rule.

**L0 — browser:** Use the Cache API (`caches.open('husky-media-v1')`) rather than IndexedDB for the binary thumbnail/preview bytes — it's built for exactly this (request/response pairs, works with fetch, no manual blob-to-base64 dance), and set `Cache-Control: public, max-age=2592000, immutable` (30 days) on the responses since the content-addressed key means a cached response is never stale by definition — a changed file gets a new key, an unchanged one is genuinely immutable. Fall back to IndexedDB only if you need to store non-fetchable metadata (e.g. the folder stats JSON from §3) as structured data rather than bytes.

**L1 — warm cache:** R2, fronted by the same Worker that already serves share-media.js (no need for a genuinely separate service — "a worker that works in parallel" is satisfied by adding an R2 binding + a route to the existing Worker; running an actual second Worker just adds cold-start/deploy complexity for no benefit here). Flow on a thumbnail request — note `ctx` and the pre-checked `range` are both passed in, not implicit:

```js
async function serveMedia(request, ctx, env, fileId, variant, checksumKey, range) {
  const r2Key = `media/${fileId}/${variant}-${checksumKey}`;
  const cache = caches.default; // edge cache, free, in front of R2 reads too
  const cacheReq = new Request(request.url);

  if (!range) { // range requests bypass the edge cache; see §1.2
    const cached = await cache.match(cacheReq);
    if (cached) return cached;
  }

  let obj = await env.MEDIA_BUCKET.get(r2Key, range ? { range } : undefined);
  if (!obj) {
    const bytes = await fetchAndMaybeTranscodeFromDrive(env, fileId, variant); // existing share-media.js path
    await env.MEDIA_BUCKET.put(r2Key, bytes, {
      httpMetadata: { contentType: mimeFor(variant), cacheControl: "public, max-age=2592000, immutable" },
    });
    obj = await env.MEDIA_BUCKET.get(r2Key, range ? { range } : undefined);
  }
  const res = new Response(obj.body, {
    status: range ? 206 : 200,
    headers: { ...obj.httpMetadata, ...(range ? rangeHeaders(obj, r2Key) : {}) },
  });
  if (!range) ctx.waitUntil(cache.put(cacheReq, res.clone()));
  return res;
}
```

Layering Cloudflare's free edge `caches.default` in front of the R2 read means most requests never even hit R2's Class B counter — R2 is the durable fallback, the edge cache is the hot path. This is the "don't slow down what's already fast" requirement: on a warm edge cache hit this is strictly faster than what exists today (no Drive round-trip at all), and even an R2-tier hit is a single low-latency object read vs. a Drive API call, so nothing here regresses current load time — it only removes work.

**L2 — origin:** unchanged, this is today's share-media.js behavior. Only reached on a genuine cold miss (first-ever view of a file, or its first view after being edited in Drive).

### 1.2 Two things the pseudocode above doesn't show, but must hold

- **Authorization happens before this function is ever called, on every request, hit or miss.** `serveMedia()` only knows a `fileId` — it has no concept of which share is asking or whether they're allowed to. That's intentional: caching stays keyed by file identity (correct and efficient, since the same file can legitimately appear in more than one share), but it means the calling route is entirely responsible for re-validating the share token/permissions on every request before reaching this code — a cache hit must never become a way to skip that check. This isn't a cache-invalidation problem (revoking a share doesn't need to touch R2 at all) — it's a request-ordering requirement: check access first, consult the ladder second, always.
- **Range requests need to skip the edge cache and go straight to R2's own `range` option**, as sketched above — share-media.js already supports Range downloads (needed for video scrubbing), and the original pseudocode silently dropped that by always returning a full object. `caches.default` can serve partial ranges too, but keeping it simple — full responses through the edge cache, ranged reads straight from R2 — avoids getting the partial-content caching semantics subtly wrong.

## 2. Folder stats (counts, sizes, dates) — cached, not computed live

Right now presumably every share-page folder view has to ask Drive "how many files, what size, what types" on the spot, which is slow and is exactly the "6 second intent time" cost. Split this into a background job and a fast read:

Job walks a folder tree once (reusing the exact `walk()` pattern already in images.js — same recursion, same per-page Drive listing, same skip of `_archive`/`_compressed`/`_previews`) and produces one JSON blob per root:

```json
{
  "rootId": "...", "generatedAt": 1234567890, "driveChangeToken": "...",
  "folders": {
    "<folderId>": { "path": "Trip/Day 2", "files": 142, "photos": 130, "videos": 12,
                     "bytes": 4831201984, "oldestMtime": ..., "newestMtime": ..., "subfolders": [...] }
  }
}
```

- **Storage:** R2, not KV — a share with thousands of files produces a stats blob well past comfortable KV value sizes for frequent writes, and KV's 1,000-writes/day ceiling is far too tight for anything that re-generates on a schedule across multiple shares. KV holds only a pointer: `share-stats:<slug>` -> `{ r2Key, generatedAt }`, mirroring the existing `images:jobs` singleton-key style.
- **Read path:** share page fetches the pointer from KV (cheap, read-heavy, fits the free tier fine), then the stats JSON from R2 (or its edge-cached copy). No Drive call on the hot path at all once a folder's been indexed once — this is where the 6s → 3s number actually comes from: it's not a new optimization layered onto the existing Drive-polling path, it's the removal of that path entirely for anything already indexed.

### 2.1 Folder tile redesign (based on the current drop-page screenshot)

The current tile is icon + name only; the page-level aggregate stats (files/folders/size/videos) already exist at the top of the page but never reach the individual tiles. Since §2's stats blob already computes exactly this per folder, the redesign is a rendering change, not a new data requirement:

```
┌───────────────────────────────┐
│ [thumb]  Manali Hampta Pass    │   ← representative thumbnail (newest or
│          -- 27 June - 02 July  │     first photo in the folder, pulled
│                                 │     from the L1 warm cache, §1)
│  📷 214   🎥 12   4.2 GB        │   ← file.photos / file.videos / file.bytes
│  Modified 3 days ago            │   ← folder.newestMtime, relative-formatted
└───────────────────────────────┘
```

- **Thumbnail:** use the folder's `newestMtime` file (or a designated "cover" photo, if that's ever added as a feature) — already sitting in R2 from §1's warm cache, so this costs nothing extra to render once §1 exists.
- **Stat row:** straight fields from the §2 JSON (`photos`, `videos`, `bytes`, `newestMtime`) — no extra Drive calls, no extra job.
- Empty/never-indexed folders (no stats blob yet, e.g. right after creation) fall back to the current icon-only tile rather than showing zeros or a loading spinner per tile — avoids a wall of "0 photos, 0 videos" before the first share-index run completes. A folder that's partway through an in-progress checkpointed walk (§8.3) should show whatever the last-written partial stats blob has for it, not wait for the whole job — see the note on incremental writes at the end of §4.
- Keep the existing "Hover zoom" / grid-density controls as-is; this only changes what's inside each tile, not the grid mechanics.
- Folder and file names in this blob can be attacker-controlled (per the README, invited collaborators upload with arbitrary names) and this is a public-facing page, not an admin one — every name rendered into a tile must go through the same `esc()`/`escAttr()` discipline already established in admin-images.js, not something to assume is safe because it "just" came from a JSON blob rather than directly from Drive.

## 3. Detecting what changed, without re-walking everything

Two confirmed facts worth designing around:

- **File and folder IDs are permanent** — a Drive file's `id` (folders included, since a folder is just a file with the Drive-folder MIME type) doesn't change on rename or move. Your assumption was right, and it extends to folders, which simplifies incremental diffing a lot: a "file moved" event is just "same id, new parents," not a delete+create.
- **`changes.list` is account-wide, not scoped to a subtree.** Call `changes.getStartPageToken()` once, store the token, then poll `changes.list(pageToken)` — but it returns every change across the whole Drive (or shared drive), not just the folders a given share cares about. Practically: keep one stored page token for the whole app (not one per share), poll it on whatever cadence the workflow schedule dictates, and for each returned change, check whether `change.fileId` is a member of any share's already-indexed file-id set (a `Set` built from the stats blob) before deciding it's relevant. This turns "re-walk the whole tree to find what changed" into "diff a change feed against known IDs," which is both cheaper and simpler than trying to run scoped queries that don't exist in the API.

**Fallback safety net:** keep a periodic full re-walk (e.g. monthly, or configurable per share — see §4) regardless of change-token polling, since page tokens can expire after long gaps of inactivity and it's cheap insurance against any drift.

**Confirmed single-drive setup:** `getStartPageToken`/`changes.list` are scoped per Drive (a personal "My Drive" and each Shared Drive each have their own independent change stream and page token), but husky-drop's content lives under exactly one Drive — so §3.1's single global token is correct as designed. No per-`driveId` keying needed; revisit only if a second Drive/Shared Drive is ever added to the setup.

### 3.1 The "cheap check," debounced globally rather than run per view

The goal is close-to-real-time freshness without a `changes.list` call on every page view. Debounce it globally, not per share:

```
KV: changes:cursor -> { pageToken, checkedAt }
```

On a share-page load: if `now - checkedAt` is under a configurable window (a few minutes by default), skip Drive entirely and answer from whatever the stats blob already says — "checked recently, nothing new" is a cheap, valid answer, not a non-answer. Only once the window has passed does anything call `changes.list(pageToken)` — once, globally, no matter how many shares or concurrent viewers are asking — and that single result set is then fanned out: for each active share, intersect the returned `fileId`s against that share's already-known file-id set (already sitting in its stats blob). A hit flips `needsReindex: true` on that share's KV pointer; a miss touches nothing.

This also unlocks a targeted reindex instead of always waiting for the next scheduled share-index run: since the change feed already names the exact file IDs that moved, a flipped `needsReindex` can trigger re-fetching just those files' metadata, recomputing just their folder's stats delta, and regenerating just their thumbnails — no need to re-walk anything to rediscover what already came for free from `changes.list`. The periodic full walk stays purely as page-token-gap insurance, not as the everyday change-detection path.

## 4. Processing workflow (extends images-rules.js, doesn't replace it)

One job type, `share-index`, that does three things per run and stores its result the same way `planJobRecord` does today (single job record, single KV write):

1. Walk (or diff via §3) → update the folder-stats blob (§2).
2. Pre-warm thumbnails into R2 for anything newly discovered (§1) — low-res always, high-res for anything actually large enough to matter.
3. For RAW / oversized originals, generate the WebP "preview-equivalent" (§5) and drop it in R2 alongside the thumbnails.

Triggers, matching the existing rules-cron shape:

- **Manual** — a "Process now" button on the share admin page.
- **On share creation** — auto-enqueue a share-index job the moment a share is created, so the first visitor doesn't hit an empty cache.
- **Scheduled** — one global default cadence (nightly) applies to every share unless a share explicitly sets its own override; stored the same way images-rules.js already tracks recurring rules (`{ shareId, schedule, lastRunAt }`, with `schedule` absent/null meaning "use the global default").

Reuse the *pattern* of the existing "only one active job of this kind at a time" guard from images-run.js — but not its literal global scope, and not its literal KV key. Two adjustments:

- **Per-share, not global.** images-run.js's guard is a single account-wide lock (one image-archive job at all, ever). If share-index copied that as-is, only one share in the entire app could be indexing at once — a real bottleneck once there's more than a handful of shares on a nightly schedule. The lock should be "this share isn't already indexing," checked per share, so unrelated shares' jobs run independently. Overall throughput (how many chunks get processed per cron tick across all shares) is still bounded by the subrequest/CPU budget in §8.3, but that's a scheduling throttle, not a correctness lock — the two shouldn't be conflated into one mechanism.
- **Its own KV key — `share-index:jobs`, not `images:jobs`.** Sharing the image-archive feature's key would mean the two features' job histories and (if the lock above weren't fixed) their concurrency guards collide, blocking each other for no reason.

Pause/resume/cancel in the image-archive sense isn't needed here — but the job does need to survive a Workers-plan downgrade without breaking, which means it can't assume one invocation can walk an entire library in a single shot. See §8.2/§8.3: Free tier caps a single invocation at 50 subrequests total, and a full walk of a few-hundred-folder library will blow past that easily. share-index should always run as the checkpointed pattern in §8.3 rather than one long-lived invocation — on Paid that typically finishes in one or two chunks; on Free it takes more, smaller chunks; either way it's the same code path, just a different chunk count. Prefer a targeted run (only the changed file IDs from §3.1) when one is available, and fall back to a full walk only on the scheduled cadence or when a page-token gap forces it.

**One more consequence of chunking: write the stats blob incrementally, per chunk, not once at the end.** A checkpointed walk that only updates `share-stats:<slug>` on final completion means every folder looks "never indexed" (§2.1's icon-only fallback) for the entire duration of a job that might take several chunks on Free tier — worse than what exists today for a large first-time index. Each chunk should merge its newly-walked folders into the existing stats blob and bump `generatedAt`, so folders already walked show real numbers immediately while the walk continues on the rest.

## 5. RAW / oversized-original preview pipeline

This is genuinely the same problem the image-archive feature already solves, aimed at a different output target:

| | image-archive (images.js/images-run.js) | share preview pipeline |
| --- | --- | --- |
| Input | RAW/HEIC/TIFF/etc from a folder | same |
| Output | re-encoded file written back to Drive (copy/archive/replace) | WebP preview written to R2 only |
| Trigger | admin-run dry-run + start | share-index job (§4) |
| Original | possibly moved/replaced in Drive | always untouched |

Practically: extract the shared parts of images.js (RAW→sharp decode path, HEIC→sharp path, the `estimate()`/`typeOf()` helpers) into something both features import, rather than duplicating the RAW-handling logic a second time. The output side differs (Drive multipart upload vs. R2 put), but the "how do I even decode this ARW/HEIC" side is identical and should not be forked.

**Serving:** when a viewer requests the large/full view of a RAW or 50–125 MB original, default to the WebP preview-equivalent (fast, from warm cache) with an explicit "Load original" affordance that streams the real bytes from Drive via the existing Range-download path in share-media.js — unchanged, just now opt-in rather than default for this file class.

### 5.1 Color, orientation, and HDR fidelity

"Doesn't look different from the original" needs to be an explicit requirement on this pipeline, not an assumption — a few specific things that are easy to get subtly wrong:

- **Orientation:** sharp's `.rotate()` (no args, already used in transcode-images.mjs) auto-rotates from the EXIF orientation tag and resets that tag on output — this is already correct for the main path. The one place to watch is the RAW-fallback path, which does a separate `exiftool -tagsfromfile` copy of metadata from the original file back onto the already-rotated output — that copy will reintroduce the original (pre-rotation) orientation tag unless explicitly cleared afterward (the existing `-orientation=` flag on that call does this correctly today). The risk is that anyone adding a similar metadata-copy-back step for a different path later forgets this and reintroduces double-rotation — worth centralizing into one shared "copy metadata but always clear orientation" helper rather than repeating the flag at each call site.
- **Color profile / wide gamut:** keep the embedded ICC profile through the pipeline (`keepMetadata()` / `keepIccProfile()` per the earlier metadata-mode fix) rather than letting sharp assume sRGB. For the RAW decode step specifically (`dcraw_emu`), don't rely on its default output color space implicitly — pass an explicit `-o 1` (sRGB) rather than leaving it unstated, since final outputs here are JPEG/WebP for web/archive viewing, and most viewers assume sRGB; embedding a wider-gamut profile in that context tends to look more washed out in typical viewers, not more accurate, unless every consumer end is color-managed. Make the choice explicit rather than inheriting whatever the tool defaults to.
- **Bit depth:** dcraw_emu's 16-bit TIFF intermediate down to 8-bit JPEG/WebP output is handled by sharp's normal gamma-aware pipeline as long as a color profile is actually present on the input (previous point) — no extra handling needed beyond that.
- **HDR gain-map photos** (Apple "Adaptive HDR" / Google Ultra HDR JPEGs, e.g. from recent phones): sharp has no first-class support for preserving the auxiliary gain-map data these formats carry. Recompressing one of these through the normal pipeline will silently drop the HDR boost and fall back to looking like the embedded SDR base image — a real, quiet "looks different from the original" regression if it isn't handled deliberately. Rather than accept silent degradation: detect gain-map-bearing JPEGs (presence of MPF/GContainer/Apple HDRGainMap markers) during the scan and skip them from the "recompress to a preview" path entirely — serve the original for those specific files (large-view and download both) until/unless proper gain-map preservation is worth building. Honest fallback beats silent quality loss.

## 6. Downloads: format choice

Single-file and ZIP ("download all," via share-zip.js) both get the same choice, surfaced once rather than duplicated:

- **Default:** original bytes (unchanged current behavior).
- **Option:** "smaller (WebP) versions" — for a single file this swaps the streamed bytes for the R2 preview; for a ZIP this means share-zip.js pulls from R2 (preview objects) instead of streaming from Drive for files that have one, falling back to the original for anything not yet processed (e.g. a file added since the last share-index run).

## 7. Drop creation → optional share creation

Add one toggle to the drop-creation admin flow: "Also create a public share for this drop's folder." When checked, drop creation additionally calls whatever share-admin.js already exposes for share CRUD, using the drop's folder as the share root, and enqueues the on-creation share-index job from §4 immediately — so by the time the drop link is handed out, the first visitor to the share isn't the one paying the cold-cache cost.

## 8. Budget — designed for Paid, fails safe if downgraded to Free

You're on Paid today; this is designed against Paid's numbers but every piece below has an explicit answer for what happens if Workers ever drops to Free, so nothing breaks silently on a plan change. R2 and KV have their own separate free tiers regardless of which Workers plan is active, so §8.1 doesn't change with a Workers downgrade — only §8.2/§8.3 do.

### 8.1 R2 + KV (independent of Workers plan tier)

| Resource | Free tier | Where it's spent here |
| --- | --- | --- |
| R2 storage | 10 GB | thumbnails + previews; content-addressed keys mean no duplicate storage across viewers, only across distinct file versions |
| R2 Class A (writes/lists) | 1M/month | one write per new/changed file variant — write-once, read-many by design |
| R2 Class B (reads) | 10M/month | thumbnail/preview serves that miss the edge cache; most hits should be absorbed by `caches.default` before they count against this |
| R2 egress | always free, on every tier | this is the whole reason this is viable — every thumbnail/preview serve costs nothing regardless of volume |
| KV reads | 100k/day | stats pointers, job records — read-heavy, matches KV's intended use |
| KV writes | 1,000/day | tightest constraint in the system — stats blobs and thumbnail indexes live in R2, not KV; KV only ever gets one small pointer write per job completion, same pattern the image-archive feature already uses |

### 8.2 Workers compute (this is what actually changes on a downgrade)

Pulled straight from developers.cloudflare.com/workers/platform/limits (Sep 2026):

| Limit | Free | Paid | Bites here? |
| --- | --- | --- | --- |
| Subrequests per invocation (fetch + R2/KV/D1 calls, combined) | 50 | 10,000 | **Yes** — see §8.3, this is the real constraint |
| CPU time per HTTP request/cron tick | 10 ms | 5 min | No — see below |
| Cron Triggers per account | 5 | 250 | No, if scheduling uses one global trigger (§4) |
| Cache API calls per request | 50 (shares the subrequest pool) | 1,000 | Same pool as subrequests, see §8.3 |

**CPU time doesn't bind** regardless of plan, because all actual pixel work (transcoding, RAW decode, resizing) already happens in GitHub Actions, never inside a Worker request or cron handler — that's true of the existing image-archive feature today and stays true here. Worker-side code is orchestration only (parse small JSON, compare timestamps, decide what's due), which Cloudflare's own numbers say averages ~2.2 ms/request — comfortably inside Free's 10 ms even on a downgrade.

**Cron Triggers don't bind** as long as scheduling (§4) uses a single global trigger that internally decides which shares are due, rather than one trigger per share or per job type — 5/account on Free is otherwise a hard wall the moment there's more than a handful of scheduled things.

**A single media-serve request stays well under 50 subrequests** even on a cold path: cache match, R2 get, (on miss) Drive fetch + R2 put + cache put is ~5 total. The §1 caching ladder needs no special handling for a downgrade.

**Bulk walks are the one thing that actually breaks on Free** without the pattern in §8.3 — a single invocation walking a 125-folder, 23k-file library will issue Drive `fetch()` calls well into the hundreds, which Free's 50-subrequest ceiling simply won't allow.

### 8.3 The checkpointed job pattern (what makes §4/§3.1 downgrade-safe)

Any job that walks more than a handful of folders — share-index's full walk, and worth retrofitting into images.js's own walk too, since it has the identical exposure — processes a bounded chunk of subrequests (e.g. ≤40, leaving headroom under Free's 50), persists a resume cursor (which folder/page it got to) to R2 or KV, and stops. Continuation is driven by whatever's already scheduling the job — the next cron tick if that's frequent enough, or a Cloudflare Queues message (Queues has its own modest free allocation, ~10k ops/day) if faster completion matters and one's set up. On Paid, the chunk size can simply be raised toward 10,000 and most jobs finish in one invocation; on Free, the same code just takes more, smaller chunks to finish the same walk. Nothing has to know which plan it's running under beyond the configured chunk size — that's the whole point of writing it this way once rather than branching on plan tier throughout the codebase.

## 9. Suggested build order

1. Ship the two bugs in §0 — independent, fast, immediately noticeable.
2. §1 (caching ladder), including the checkpointed-job pattern from §8.3 — build that pattern once, here, rather than bolting it onto §2/§4 later, since both need it.
3. §2 + §3 (stats + change detection) — the 6s→3s win, using the §8.3 pattern from step 2 for the underlying walk.
4. §4 (workflow/scheduling) to automate what's manual after step 3.
5. §5 + §6 (RAW previews, download choice, HDR/color-fidelity rules from §5.1) — builds on the pipeline, not blocking anything above it.
6. §7 (drop→share toggle) — small, independent, do whenever convenient.

Nothing here is an open question anymore — §1.1, §3 (single-drive, now confirmed), §3.1, §4, and §8 above resolve what were open items in earlier revisions of this doc (orphan reclamation window, drive scope for change detection, staleness/change-detection logic, schedule defaults, video-preview reuse, auth ordering, job concurrency scope). Revisit only if something in implementation surfaces a reason to.
