// Text that people control must not reach HTML unescaped.
//
// This started as a one-off audit of the ~61 innerHTML findings Skylos
// reports on this repo. Every one of them turned out to be escaped, set
// through textContent, or not text at all - but nothing stopped the next one
// from being different. So the audit lives here instead of in someone's
// memory.
//
// The rule is deliberately narrow, because that is what makes it usable: a
// static checker cannot tell a count from a caption, so this only looks at
// values whose *name* says they carry text a user can choose - a Drive file
// or folder name, an uploader's name, a share label, an error or log
// message, a typed filter, an email. Those are the ones that can carry
// markup. If such a value is interpolated into HTML and is not wrapped in
// esc() / escAttr() / escapeHtml(), this fails.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

// Names that hold user-chosen text. Short field names (n, u, s, f, l, d) are
// the wire format the drop/share APIs use for exactly these values.
const UNTRUSTED =
  /(^|[.\s([{?:!&|=+])(name|label|title|caption|message|detail|error|err|reason|note|path|query|search|filter|uploader|who|email|displayName|folderName|fileName|viewer|text|slug|subject)\b|\.\s*(n|u|s|f|l|d|q|m)\b/i;

// Wrappers that make any value safe to drop into HTML.
const ESCAPED = /^(esc|escAttr|escapeHtml|encodeURIComponent)\s*\(/;

// Calls that build their own markup or return nothing textual.
const SAFE_CALL =
  /^(icon|uiIcon|skel[A-Z]\w*|fmt[A-Z]\w*|ago|dur|pct|initialsOf|activityTimeRange|activityTypeLabel|eventTypeIcon|eventKind|label|opts|toggle|optCards|budgetBar|detailStatCard|linkActionButton|stat|cell|banBtn|rowHtml|runLabel|runClass|infoSection|exposureSummary)\s*\(/;

// Reviewed by hand. Key is "file:expression", value is why it is allowed.
const REVIEWED = {
  "public/admin-images.js:name": "internal setting key (maxMp, format, metadata), not user text",
  "public/share-viewer-panels.js:label": "call sites pass literals (Download, Share, Info, ...)",
  "public/share-viewer-panels.js:name": "uiIcon() on the line above validates it against the icon catalog",
  "public/admin-people.js:label": "call sites pass literals (uploads, views, last seen)",
  "public/admin-people-profile.js:label": "call sites pass literals; the value beside it is esc()'d",
  "public/admin-detail.js:label(e)": "maps an event type to a fixed phrase",
  "public/share.js:name.slice(0, 20)": "inside shortName(); every caller esc()s the result",
  "public/share.js:name.slice(-11)": "inside shortName(); every caller esc()s the result",
  "src/drop-api.js:link.slug": "slug is [a-z0-9-] by validation, and this is an email href",
  "src/store.js:cta.label": "call sites pass literals; notifyEmail escapes it one line below",
  "public/admin-previews.js:detail": "local, built out of esc()'d parts a few lines above",
  "public/admin-previews.js:label": "FILTERS is a literal table of segment labels",
  "public/admin-images.js:i.q": "encoder quality, a number the admin picked from a fixed list",
};

const files = [];
for (const dir of ["public", "src"]) {
  for (const f of readdirSync(dir)) if (f.endsWith(".js")) files.push(`${dir}/${f}`);
}

// Every ${...} inside a template literal, nested ones included. Nested
// templates are reported on their own, so an outer expression never has to
// vouch for what is inside them.
function interpolations(src) {
  const out = [];
  const walk = (text, offset) => {
    let i = 0;
    let inTemplate = false;
    while (i < text.length) {
      const c = text[i];
      if (c === "\\") { i += 2; continue; }
      if (c === "`") { inTemplate = !inTemplate; i++; continue; }
      if (inTemplate && c === "$" && text[i + 1] === "{") {
        let depth = 1;
        let j = i + 2;
        let nested = 0;
        while (j < text.length && depth) {
          const d = text[j];
          if (d === "\\") { j += 2; continue; }
          if (d === "`") nested ^= 1;
          else if (!nested && d === "{") depth++;
          else if (!nested && d === "}") depth--;
          j++;
        }
        const body = text.slice(i + 2, j - 1);
        out.push({ at: offset + i, text: body });
        walk(body, offset + i + 2);
        i = j;
        continue;
      }
      i++;
    }
  };
  walk(src, 0);
  return out;
}

// Is this interpolation inside a template that builds markup?
const buildsHtml = (src, at) => /<[a-zA-Z][^`]*$/.test(src.slice(Math.max(0, at - 400), at));

// Reduce an expression to the parts that actually reach the page.
function rendered(expr) {
  let e = expr;
  e = e.replace(/`(?:[^`\\]|\\.)*`/gs, '""'); // nested template: checked separately
  e = e.replace(/'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"/g, '""'); // literals
  e = e.replace(/\.(map|filter|flatMap|forEach|sort|find|some|every)\s*\(\s*\([^)]*\)\s*=>/g, ".$1(("); // callback params are bindings, not output
  // A ternary only renders its branches.
  for (let pass = 0; pass < 6; pass++) {
    const next = e.replace(/(^|[(,{[])\s*[^?()]*?\?([^]*)$/, "$1$2");
    if (next === e) break;
    e = next;
  }
  return e;
}

const findings = [];
for (const path of files) {
  const src = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  for (const { at, text } of interpolations(src)) {
    const expr = text.trim().replace(/\s+/g, " ");
    if (!expr || !buildsHtml(src, at)) continue;
    if (ESCAPED.test(expr) || SAFE_CALL.test(expr)) continue;
    // An expression containing a template literal is a container - a .map()
    // that builds rows, a helper called with markup. What it interpolates is
    // visited on its own, so the container itself vouches for nothing.
    if (expr.includes("`")) continue;
    const visible = rendered(expr);
    if (!UNTRUSTED.test(visible)) continue;
    // Escaped somewhere inside what is actually rendered? Then the untrusted
    // part is already handled and any leftover is a literal or a number.
    const stripped = visible.replace(/\b(esc|escAttr|escapeHtml|encodeURIComponent)\s*\([^()]*\)/g, '""');
    if (!UNTRUSTED.test(stripped)) continue;
    if (REVIEWED[`${path}:${expr}`]) continue;
    findings.push({ path, line: src.slice(0, at).split("\n").length, expr: expr.slice(0, 100) });
  }
}

if (findings.length) {
  assert.fail(
    `${findings.length} user-controlled value(s) reach HTML without escaping:\n` +
      findings.map((f) => `  ${f.path}:${f.line}  ${f.expr}`).join("\n") +
      "\n\nWrap it in esc() (escAttr() inside an attribute, escapeHtml() on the " +
      "server), set it with textContent instead, or - if the name is misleading " +
      "and it cannot carry markup - add it to REVIEWED in " +
      "scripts/innerhtml-audit-test.mjs with the reason.",
  );
}

// The escapers themselves, or the rule above is theatre.
const clientEsc = readFileSync("public/public.js", "utf8");
assert.match(clientEsc, /function esc\(s\)[\s\S]{0,120}\[&<>"']/, "esc() covers & < > \" '");
assert.match(clientEsc, /function escAttr\(s\)[\s\S]{0,120}esc\(s\)/, "escAttr() builds on esc()");
assert.match(readFileSync("src/util.js", "utf8"), /escapeHtml[\s\S]{0,200}\[&<>"']/, "escapeHtml() covers the same five");

console.log(`innerHTML audit passed (${files.length} files, ${Object.keys(REVIEWED).length} reviewed exceptions)`);
