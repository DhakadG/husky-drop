#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const css = await read("public/style.css");
const faviconSvg = await read("public/favicon.svg");
assert.match(css, /--grad:\s*linear-gradient\(120deg/, "plan 00 uses the 120-degree signature gradient");
assert.match(css, /\.bg-fx\s*\{/, "plan 00 defines the shared ambient background layer");
assert.match(css, /\.grad-border\s*\{/, "plan 00 defines gradient-border hero cards");
assert.match(css, /\.brand-mark\s*\{[\s\S]*?url\("\/logo-mark\.svg"\)/, "every live brand mark uses the canonical SVG asset");
assert.match(css, /\.brand-mark::after\s*\{[\s\S]*?content:\s*none/, "the retired CSS-drawn droplet cannot overlay the canonical logo");
assert.match(faviconSvg, /<path[^>]+fill="#fff"/, "favicon contains the banner-derived white droplet");

const workerSource = (await Promise.all(["worker", "drop-api", "admin-api"].map((n) => read(`src/${n}.js`)))).join(" ");
const liveSource = (await Promise.all(["live", "live-completions"].map((n) => read(`src/${n}.js`)))).join(" ");
const shareSource = await read("src/share-admin.js");
const storeSource = await read("src/store.js");
assert.match(workerSource, /\/api\/admin\/events/, "plan 09 registers activity pagination");
assert.match(workerSource, /\/api\/admin\/drive\/folders/, "plan 09 registers Drive folder browsing");
assert.match(workerSource, /ownerName:\s*cleanText\(env\.OWNER_DISPLAY_NAME/, "plan 09 returns a configured collector name");
assert.match(liveSource, /speedHist/, "plan 09 retains live speed history");
assert.match(liveSource, /recentDone/, "plan 09 retains recently completed transfers");
assert.match(liveSource, /role === "admin"[\s\S]*?safeSend\(server,\s*\{[^}]*recent:\s*this\.recentDone/, "initial admin WebSocket snapshots include recent completed transfers");
assert.match(liveSource, /newBySession/, "completion batches retain separate activity counts for concurrent upload sessions");
assert.match(liveSource, /type:\s*"sessionclose"[\s\S]*?sessionId:\s*session\.id/, "terminal live progress writes an automatic completed-session activity event");
assert.match(shareSource, /recentViewers/, "plan 09 exposes recent identified share viewers");
assert.match(storeSource, /text:\s*msg\.text/, "transactional emails include a plain-text alternative");
assert.match(storeSource, /Resend rejected email/, "notification provider rejections are logged without breaking uploads");

const home = await read("public/index.html");
assert.match(home, /class="[^"]*\bhome-v3\b[^"]*"/, "plan 01 installs the redesigned homepage shell");
assert.match(home, /class="hero-v3"/, "plan 01 installs the two-column hero");
assert.match(home, /class="steps-v3"/, "plan 01 installs the three-step section");
assert.match(home, /class="[^"]*\bstrip-v3\b[^"]*"/, "plan 01 installs the feature strip");
assert.match(home, /class="bg-fx"/, "plan 01 mounts the ambient background layer");

const adminHtml = await read("public/admin.html");
const adminJs = (await Promise.all(["admin", "admin-state", "admin-chart", "admin-live", "admin-activity", "admin-links", "admin-shares", "admin-detail", "admin-folders"].map((n) => read(`public/${n}.js`)))).join("\n");
assert.match(adminHtml, /id="auth" class="auth-wrap"/, "plan 02 installs the v3 authentication wrapper");
assert.match(adminHtml, /class="grad-border auth-card"/, "plan 02 wraps admin unlock in the gradient card");
assert.match(adminHtml, /id="tok-eye"/, "plan 02 provides the password visibility control");
assert.match(adminHtml, /id="tok-eye"[^>]*aria-pressed="false"/, "token visibility starts with an accessible unpressed state");
assert.match(adminHtml, /class="auth-note"/, "plan 02 provides the rate-limit reassurance notice");
assert.match(adminJs, /tok-eye/, "plan 02 wires the password visibility control");
assert.match(adminJs, /setAttribute\("aria-pressed",\s*String\(visible\)\)/, "token visibility exposes its current pressed state");
assert.match(adminJs, /setAttribute\("aria-label",\s*action\)/, "token visibility exposes its current action");
assert.match(adminHtml, /id="tok-go"/, "admin unlock keeps the submit binding");
assert.match(adminHtml, /id="tok-err"/, "admin unlock keeps the error binding");
assert.doesNotMatch(adminHtml, /id="(?:login|auth-err)"/, "retired Admin unlock bindings stay removed");
assert.doesNotMatch(`${adminHtml}\n${adminJs}`, /Drive write rate/i, "live UI does not label upload throughput as an unmeasured Drive write rate");
assert.match(adminJs, /\["Files remaining", remaining\]/, "live metrics report a directly measured file count");

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
assert.match(adminHtml, /id="folder-new-name"/, "Drive picker can create a folder in the current location");
assert.match(adminHtml, /id="share-folder-browse"/, "New share link can browse Drive");
assert.match(adminHtml, /id="tab-create-share"/, "New share link has its own tab pane in the shared admin page");
assert.match(adminHtml, /data-tab="create-share"/, "shared admin navigation exposes New share link");
assert.match(adminHtml, /id="confirm-dialog"/, "admin uses a branded confirmation dialog");
assert.match(adminHtml, /id="create-success"/, "plan 05 provides the inline creation success state");
assert.match(adminJs, /function makeLinkCard\(/, "plan 05 renders complete Drop Link cards");
assert.match(adminJs, /function showCreateStep\(/, "plan 05 implements the two-step creation flow");
assert.match(adminJs, /async function openFolderPicker\(/, "plan 05 browses real Drive folders");
assert.match(adminJs, /\/api\/admin\/drive\/folders/, "plan 05 uses the real Drive folder endpoint");
assert.match(adminJs, /const shareSelectedFolders = new Map\(\)/, "Drive picker supports multiple share folders without a fabricated parent");
assert.match(adminJs, /async function createFolderHere\(/, "Drive picker creates a child folder through the backend");
assert.match(adminJs, /async function confirmAction\(/, "destructive actions use the shared asynchronous dialog");
assert.doesNotMatch(adminJs, /\bconfirm\s*\(/, "native browser confirmations are removed");
assert.match(css, /\.folder-picker-panel\s*\{/, "plan 05 styles the Drive picker");

assert.match(adminJs, /let detailShowAll = false/, "plan 06 tracks collapsed upload history");
assert.match(adminJs, /class="detail-breadcrumb"/, "plan 06 renders the Link Detail breadcrumb");
assert.match(adminJs, /function detailStatCard\(/, "plan 06 renders Link Detail stat cards");
assert.match(adminJs, /id="up-show-all"/, "plan 06 provides upload-history expansion");
assert.match(adminJs, /class="settings-accordion"/, "plan 06 renders focused settings accordions");
assert.match(adminJs, /class="leader-row"/, "plan 06 renders proportional uploader bars");
assert.match(css, /\.detail-breadcrumb\s*\{/, "plan 06 styles the Link Detail breadcrumb");
assert.match(css, /\.settings-accordion\s*\{/, "plan 06 styles the settings accordions");

assert.match(adminHtml, /class="share-mode-fieldset"/, "plan 07 provides accessible Share Link mode choices");
assert.match(adminHtml, /id="s-mode" type="hidden"/, "plan 07 preserves the existing Share Link payload field");
assert.match(adminJs, /function makeShareCard\(/, "plan 07 renders Share Link analytics cards");
assert.match(adminJs, /share\.recentViewers/, "plan 07 renders real recent viewer identities");
assert.match(adminJs, /data-view-share-activity/, "plan 07 connects Share Link cards to the shared Activity tab");
assert.match(css, /\.viewer-chip\s*\{/, "plan 07 styles recent-viewer chips");
assert.match(css, /\.share-mode-card\s*\{/, "plan 07 styles the Share Link mode choices");

const dropHtml = await read("public/drop.html");
const dropJs = (await Promise.all(["drop", "drop-state", "drop-queue", "drop-render", "drop-live", "drop-resume", "drop-report", "drop-utils"].map((n) => read(`public/${n}.js`)))).join("\n");
assert.match(dropHtml, /id="collector-name"/, "plan 08 displays the real collector name");
assert.match(dropHtml, /id="progress-ring-value"/, "plan 08 provides the transfer progress ring");
assert.match(dropHtml, /id="budget-notice"/, "plan 08 provides the real budget-stop notice");
assert.match(dropHtml, /id="done-card"/, "plan 08 provides the delivered-files recap");
assert.match(dropHtml, /class="[^"]*trust-strip[^"]*"/, "plan 08 provides uploader trust guidance");
assert.match(dropJs, /queuePaused: false/, "plan 08 tracks queue pause state");
assert.match(dropJs, /function toggleQueuePause\(/, "plan 08 implements queue pause and resume");
assert.match(dropJs, /paused:\s*st\.queuePaused/, "plan 08 reports queue pause state to the live admin feed");
assert.match(dropJs, /budgetHit/, "plan 08 handles real backend budget limits");
assert.match(dropJs, /sessionId,\s*\n\s*\}\),?\s*\n\s*\}\)/, "completion logging includes the upload session id");
assert.match(dropJs, /setState\(item, "done"\);\s*\n\s*sendLive\(true\)/, "final Drive verification forces a terminal live update");
assert.match(css, /\.transfer-panel-v3\s*\{/, "plan 08 styles the uploader transfer queue");

console.log("UI v3 structure tests passed");
