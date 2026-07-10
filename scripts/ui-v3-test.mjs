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

const home = await read("public/index.html");
assert.match(home, /class="[^"]*\bhome-v3\b[^"]*"/, "plan 01 installs the redesigned homepage shell");
assert.match(home, /class="hero-v3"/, "plan 01 installs the two-column hero");
assert.match(home, /class="steps-v3"/, "plan 01 installs the three-step section");
assert.match(home, /class="[^"]*\bstrip-v3\b[^"]*"/, "plan 01 installs the feature strip");
assert.match(home, /class="bg-fx"/, "plan 01 mounts the ambient background layer");

const adminHtml = await read("public/admin.html");
const adminJs = await read("public/admin.js");
assert.match(adminHtml, /id="auth" class="auth-wrap"/, "plan 02 installs the v3 authentication wrapper");
assert.match(adminHtml, /class="grad-border auth-card"/, "plan 02 wraps admin unlock in the gradient card");
assert.match(adminHtml, /id="tok-eye"/, "plan 02 provides the password visibility control");
assert.match(adminHtml, /class="auth-note"/, "plan 02 provides the rate-limit reassurance notice");
assert.match(adminJs, /tok-eye/, "plan 02 wires the password visibility control");

console.log("UI v3 structure tests passed");
