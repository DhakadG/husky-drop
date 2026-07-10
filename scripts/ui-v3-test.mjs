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

assert.match(adminHtml, /class="brand side-brand"/, "plan 03 installs the shared admin sidebar brand");
assert.match(adminHtml, /class="tab tab-create" data-tab="create"/, "plan 03 keeps the create view inside the shared admin page");
assert.match(adminHtml, /id="live-empty"/, "plan 03 provides the live-transfer empty state");
assert.match(adminHtml, /id="live-finished-list"/, "plan 03 provides the finished-transfer host");
assert.match(adminJs, /const STAT_ICONS =/, "plan 03 renders icon stat cards");
assert.match(adminJs, /let liveRecent = \[\]/, "plan 03 retains recent sessions from the shared live feed");
assert.match(adminJs, /function speedSparkline\(/, "plan 03 renders speed samples from live data");
assert.match(adminJs, /function makeMiniLiveRow\(/, "plan 03 keeps overview live rows compact");
assert.match(css, /\.live-summary-strip\s*\{/, "plan 03 styles the live-transfer summary strip");

assert.match(adminHtml, /id="activity-filters"/, "plan 04 provides Activity filters inside the shared admin page");
assert.match(adminHtml, /id="activity-query"/, "plan 04 provides Activity search");
assert.match(adminHtml, /id="activity-more"/, "plan 04 provides older-day pagination");
assert.match(adminJs, /function groupActivityDays\(/, "plan 04 groups Activity entries by day");
assert.match(adminJs, /function groupActivitySessions\(/, "plan 04 groups Activity entries into sessions");
assert.match(adminJs, /async function loadEarlierActivity\(/, "plan 04 loads older Activity days from the backend");
assert.match(adminJs, /\/api\/admin\/events\?/, "plan 04 uses the real paginated Activity endpoint");
assert.match(css, /\.activity-session-summary\s*\{/, "plan 04 styles expandable Activity sessions");

assert.match(adminHtml, /id="expired-links-section"/, "plan 05 separates expired Drop Links");
assert.match(adminHtml, /id="drop-create-form"/, "plan 05 keeps link creation in the shared admin page");
assert.match(adminHtml, /id="folder-picker-panel"/, "plan 05 provides the Drive folder picker");
assert.match(adminHtml, /id="create-success"/, "plan 05 provides the inline creation success state");
assert.match(adminJs, /function makeLinkCard\(/, "plan 05 renders complete Drop Link cards");
assert.match(adminJs, /function showCreateStep\(/, "plan 05 implements the two-step creation flow");
assert.match(adminJs, /async function openFolderPicker\(/, "plan 05 browses real Drive folders");
assert.match(adminJs, /\/api\/admin\/drive\/folders/, "plan 05 uses the real Drive folder endpoint");
assert.match(css, /\.folder-picker-panel\s*\{/, "plan 05 styles the Drive picker");

console.log("UI v3 structure tests passed");
