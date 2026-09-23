// The video coverage crawl fanned out over every subfolder at once and
// silently dropped folders whose listing failed or that sat deeper than three
// levels. It now runs a bounded pool and reports what it could not see.
import assert from "node:assert/strict";
import { previewsCoverage } from "../src/previews.js";

const kv = new Map([["shares:index", JSON.stringify(["album"])], ["share:album", JSON.stringify({ slug: "album", label: "Album", mode: "gallery", folderIds: ["root"] })]]);
const env = {
  GOOGLE_CLIENT_ID: "g", GOOGLE_CLIENT_SECRET: "s", GOOGLE_REFRESH_TOKEN: "r",
  KV: { get: async (k, t) => (kv.has(k) ? (t === "json" ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, String(v)) },
};
// root -> a0..a9, a0 -> b -> c -> d (depth 4, skipped); a1 fails to list.
const children = { root: Array.from({ length: 10 }, (_, i) => `a${i}`), a0: ["b"], b: ["c"], c: ["d"] };
const FOLDER = "application/vnd.google-apps.folder";
let inFlight = 0;
let peak = 0;
globalThis.fetch = async (input) => {
  const url = new URL(typeof input === "string" ? input : input.url);
  if (url.hostname === "oauth2.googleapis.com") return Response.json({ access_token: "t", expires_in: 3600 });
  const id = (url.searchParams.get("q") || "").match(/'([^']+)' in parents/)?.[1] || "";
  inFlight += 1;
  peak = Math.max(peak, inFlight);
  await new Promise((r) => setTimeout(r, 5));
  inFlight -= 1;
  if (id === "a1") return new Response("rate limited", { status: 403 });
  return Response.json({ files: [...(children[id] || []).map((c) => ({ id: c, name: c, mimeType: FOLDER })), { id: `v-${id}`, name: `${id}.mp4`, mimeType: "video/mp4", size: "10" }] });
};
console.error = () => {};

const cov = await (await previewsCoverage(new Request("https://x/?fresh=1"), env)).json();
assert.deepEqual(cov.unreadable, ["a1"], "a folder whose listing failed is reported");
assert.equal(cov.tooDeep, 1, "a subfolder past three levels is counted");
assert.ok(peak <= 6, `listings are bounded (peak ${peak})`);
console.log("preview-crawl-test: ok");
