// Guards against the class of bug behind the "unhandledrejection Failed to
// fetch" alert: browser code that drops a promise which can reject on a
// flaky connection, and storage access that throws when a browser blocks it.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { audit } from "./promise-audit.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".js")).map((f) => `public/${f}`);

// 1) The browser code has no unhandled rejection paths.
const findings = audit(root, files);
assert.deepEqual(findings.map((x) => `${x.kind} ${x.file}:${x.line} ${x.text}`), [], "every promise that can reject is awaited or caught");

// 2) The analyzer still sees the pattern (so an empty result means something).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "promise-audit-"));
fs.mkdirSync(path.join(tmp, "public"));
fs.writeFileSync(path.join(tmp, "public/a.js"), `
async function load() { const r = await fetch("/x"); return r.json(); }
async function safe() { try { await fetch("/y"); } catch {} }
async function viaLoad() { await load(); }
load();
load().catch(() => {});
safe();
viaLoad().finally(() => {});
el.addEventListener("click", load);
el.addEventListener("click", async () => { await fetch("/z"); });
new IntersectionObserver((entries) => load());
`);
const planted = audit(tmp, ["public/a.js"]).map((x) => `${x.kind}:${x.line}`);
fs.rmSync(tmp, { recursive: true, force: true });
assert.deepEqual(planted.sort(), ["floating:5", "floating:8", "listener:9", "listener:10", "floating:11"].sort(), "the audit flags dropped, finally-only, listener and observer promises - not caught or safe ones");

// 3) Storage that throws cannot take a page down: public.js wraps it first.
const publicJs = fs.readFileSync(path.join(root, "public/public.js"), "utf8");
const shim = publicJs.match(/\(function safeStorage\(\) \{[\s\S]*?\n\}\)\(\);/)?.[0];
assert.ok(shim, "public.js starts with the safeStorage shim");
assert.ok(publicJs.indexOf(shim) < publicJs.indexOf("function esc("), "before anything else in public.js");
const blocked = {};
for (const name of ["localStorage", "sessionStorage"]) {
  Object.defineProperty(blocked, name, { configurable: true, get() { throw new Error("SecurityError: access denied"); } });
}
vm.runInNewContext(shim, { window: blocked });
blocked.localStorage.setItem("lhdb_sort", "new");
assert.equal(blocked.localStorage.getItem("lhdb_sort"), "new", "blocked storage falls back to memory");
assert.equal(blocked.sessionStorage.getItem("missing"), null);
const full = { store: new Map() };
full.localStorage = { getItem: (k) => full.store.get(k) ?? null, setItem() { throw new Error("QuotaExceededError"); }, removeItem() {}, clear() {}, key: () => null, length: 0 };
full.sessionStorage = full.localStorage;
vm.runInNewContext(shim, { window: full });
full.localStorage.setItem("k", "v");
assert.equal(full.localStorage.getItem("k"), null, "a full quota never throws (the write is simply not kept on disk)");

// ...and every page loads public.js before any script that uses storage.
for (const html of fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".html"))) {
  const srcs = [...fs.readFileSync(path.join(root, "public", html), "utf8").matchAll(/<script[^>]*src="\/([^"]+)"/g)].map((m) => m[1]);
  if (!srcs.length) continue;
  const at = srcs.indexOf("public.js");
  for (const [i, src] of srcs.entries()) {
    const file = path.join(root, "public", src);
    // Third-party bundles (vendor*) guard their own storage probes.
    if (src.startsWith("vendor") || !fs.existsSync(file) || !/\b(localStorage|sessionStorage)\b/.test(fs.readFileSync(file, "utf8")) || src === "public.js") continue;
    assert.ok(at >= 0 && at < i, `${html}: ${src} uses storage, so public.js must load before it`);
  }
}
console.log(`promise-audit-test: ok (${files.length} browser files, 0 unhandled rejection paths)`);
