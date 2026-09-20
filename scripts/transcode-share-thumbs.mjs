#!/usr/bin/env node
// Re-encodes share thumbnails as WebP (media-cache ladder, R2 storage and
// bandwidth). Drive's JPEG derivative comes through the worker, sharp turns
// it into WebP, the worker stores it under the same content-addressed key.
//   GET /api/admin/share-index/thumbs/pending?limit=&shards=&shard=
//   GET /api/admin/share-index/thumb-source/:id/:variant/:rev   (204 = done already)
//   PUT /api/admin/share-index/thumb/:id/:variant/:rev          (WebP bytes)
// Needs: node 22+, sharp.

const origin = (process.env.HUSKY_ORIGIN || "").replace(/\/$/, "");
const token = process.env.HUSKY_ADMIN_TOKEN || "";
const limit = Math.max(1, Number(process.env.LIMIT) || 20_000);
const shards = Math.max(1, Number(process.env.SHARDS) || 1);
const shard = Math.max(0, Number(process.env.SHARD) || 0);
const parallel = Math.max(1, Math.min(16, Number(process.env.PARALLEL) || 8));
const budgetMs = (Number(process.env.TIME_BUDGET_MIN) || 270) * 60_000;
// Caps per tier (sizing spec §2): resolution is where the bytes go, not
// quality. lo serves 512px cells and folder covers, md the default grid,
// hi the hover/large grid. Drive's derivative is already at most this size;
// the resize is the guarantee, not the usual path.
const TIER = { "thumb-lo": { edge: 512, quality: 75 }, "thumb-md": { edge: 1024, quality: 78 }, "thumb-hi": { edge: 1600, quality: 80 } };
if (!origin || !token) {
  console.error("HUSKY_ORIGIN and HUSKY_ADMIN_TOKEN are required");
  process.exit(2);
}
const sharp = (await import("sharp")).default;
const api = (path, init = {}) => fetch(`${origin}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.headers || {}) } });

const res = await api(`/api/admin/share-index/thumbs/pending?limit=${limit}&shards=${shards}&shard=${shard}`);
if (!res.ok) throw new Error(`pending ${res.status}: ${(await res.text()).slice(0, 200)}`);
const { pending, total } = await res.json();
const queue = pending.flatMap((row) => row.v.map((variant) => ({ ...row, variant })));
console.log(`${pending.length} files / ${queue.length} thumbnails for shard ${shard}/${shards} (${total} files overall) · ${parallel} in parallel`);

const started = Date.now();
let made = 0;
let had = 0;
let failed = 0;
let bytesIn = 0;
let bytesOut = 0;
const worker = async () => {
  for (let job = queue.shift(); job; job = queue.shift()) {
    if (Date.now() - started > budgetMs) return;
    try {
      const src = await api(`/api/admin/share-index/thumb-source/${job.id}/${job.variant}/${job.rev}`);
      if (src.status === 204) {
        had += 1;
        continue;
      }
      if (!src.ok) throw new Error(`source ${src.status}`);
      const input = Buffer.from(await src.arrayBuffer());
      const tier = TIER[job.variant] || TIER["thumb-md"];
      const webp = await sharp(input, { failOn: "none" }).rotate().resize({ width: tier.edge, height: tier.edge, fit: "inside", withoutEnlargement: true }).webp({ quality: tier.quality, effort: 4 }).toBuffer();
      let put;
      for (let attempt = 0; attempt < 3; attempt++) {
        put = await api(`/api/admin/share-index/thumb/${job.id}/${job.variant}/${job.rev}`, { method: "PUT", headers: { "content-type": "image/webp", "content-length": String(webp.length) }, body: webp }).catch(() => null);
        if (put?.ok || (put && put.status < 500)) break;
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
      }
      if (!put?.ok) throw new Error(`put ${put?.status || "network"}`);
      made += 1;
      bytesIn += input.length;
      bytesOut += webp.length;
    } catch (error) {
      failed += 1;
      if (failed <= 20) console.log(`skip ${job.id} ${job.variant}: ${error.message}`);
    }
    if ((made + had + failed) % 500 === 0) console.log(`… ${made} made, ${had} already WebP, ${failed} failed`);
  }
};
await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
console.log(`finished: ${made} made (${(bytesIn / 1e6).toFixed(1)} MB JPEG -> ${(bytesOut / 1e6).toFixed(1)} MB WebP), ${had} already WebP, ${failed} failed`);
