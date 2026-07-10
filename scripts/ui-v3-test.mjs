#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const css = await read("public/style.css");
assert.match(css, /--grad:\s*linear-gradient\(120deg/, "plan 00 uses the 120-degree signature gradient");
assert.match(css, /\.bg-fx\s*\{/, "plan 00 defines the shared ambient background layer");
assert.match(css, /\.grad-border\s*\{/, "plan 00 defines gradient-border hero cards");
assert.match(css, /\.brand-mark::after\s*\{/, "plan 00 defines the droplet inside the logo mark");

const workerSource = await read("src/worker.js");
const liveSource = await read("src/live.js");
const shareSource = await read("src/share.js");
assert.match(workerSource, /\/api\/admin\/events/, "plan 09 registers activity pagination");
assert.match(workerSource, /\/api\/admin\/drive\/folders/, "plan 09 registers Drive folder browsing");
assert.match(workerSource, /ownerName:\s*cleanText\(env\.OWNER_DISPLAY_NAME/, "plan 09 returns a configured collector name");
assert.match(liveSource, /speedHist/, "plan 09 retains live speed history");
assert.match(liveSource, /recentDone/, "plan 09 retains recently completed transfers");
assert.match(shareSource, /recentViewers/, "plan 09 exposes recent identified share viewers");

console.log("UI v3 structure tests passed");
