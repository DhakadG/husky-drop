#!/usr/bin/env node
// One-time: move preview-webp objects out of R2 into Drive, then evict the
// stale thumb-hi / video-720 tiers from R2. Run once after this change deploys.
//   HUSKY_ORIGIN=https://... HUSKY_ADMIN_TOKEN=... node scripts/migrate-r2.mjs
// Safe to re-run: migration skips entries already moved, the sweep is idempotent.
const origin = (process.env.HUSKY_ORIGIN || "").replace(/\/$/, "");
const token = process.env.HUSKY_ADMIN_TOKEN || "";
const dryRun = process.argv.includes("--dry-run");
if (!origin || !token) {
  console.error("HUSKY_ORIGIN and HUSKY_ADMIN_TOKEN are required");
  process.exit(2);
}
const api = (path, body) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  }).then((r) => r.json());

// 1) preview-webp R2 -> Drive, in batches, until nothing is left.
let moved = 0;
for (let guard = 0; guard < 5000; guard += 1) {
  const r = await api("/api/admin/share-index/migrate-previews?limit=12");
  if (r.error) throw new Error(r.error);
  moved += r.migrated || 0;
  console.log(`migrated ${r.migrated} (dropped ${r.gone}, failed ${r.failed}) · ${r.remaining} left`);
  if (!r.remaining) break;
}
console.log(`preview-webp moved to Drive: ${moved}`);

// 2) evict thumb-hi / video-720 from R2.
let cursor = null;
let removed = 0;
do {
  const r = await api("/api/admin/share-index/sweep-stale-tiers", { cursor, dryRun });
  if (r.error) throw new Error(r.error);
  removed += r.removed || 0;
  cursor = r.cursor;
  console.log(`swept: scanned ${r.scanned}, removed ${r.removed}${r.wouldRemove !== r.removed ? ` (would ${r.wouldRemove})` : ""}`);
} while (cursor);
console.log(`stale tiers evicted: ${removed}. R2 now holds lo/md thumbnails only.`);
