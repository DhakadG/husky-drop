// Finds browser code that can end in an "unhandledrejection" on a flaky
// connection. Each finding is a place where a rejection nobody handles is
// possible:
//
//   floating   a call to an async function that can reject, whose promise is
//              dropped (statement, `a && f()`, `void f()`, `.then`/`.finally`
//              without `.catch`, or returned from a callback nobody awaits)
//   listener   an async function that can reject, handed to an event
//              listener / observer / timer, which ignore the promise
//
// "Can reject" is worked out per function: an `await` of a call that can
// reject (fetch, json(), import(), or an async function that can reject),
// or a `throw`, outside a try block with a catch.
//
// Storage that throws (blocked site data, full quota) is handled once, by the
// safeStorage shim at the top of public/public.js; the test checks it loads
// first on every page. Used by scripts/promise-audit-test.mjs; run directly
// to list everything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";

const PARSE = { ecmaVersion: "latest", sourceType: "module", loc: true };
const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
// Calls that reject on a network drop or a bad response.
const REJECTING_CALLS = new Set(["fetch", "json", "text", "arrayBuffer", "blob", "import"]);
// Callbacks whose return value is ignored by the platform.
const IGNORING_SINKS = new Set(["addEventListener", "setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "forEach", "IntersectionObserver", "ResizeObserver", "MutationObserver", "on", "once"]);
// Wrappers a dropped promise passes through on its way to a statement.
const PASS_THROUGH = new Set(["LogicalExpression", "ConditionalExpression", "SequenceExpression"]);

function children(node) {
  const out = [];
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const v = node[key];
    if (Array.isArray(v)) out.push(...v.filter((c) => c && typeof c.type === "string"));
    else if (v && typeof v.type === "string") out.push(v);
  }
  return out;
}

function walk(node, visit, parent = null) {
  if (visit(node, parent) === false) return;
  for (const child of children(node)) walk(child, visit, node);
}

function calleeName(call) {
  const c = call.callee;
  if (c.type === "Identifier") return c.name;
  if (c.type === "MemberExpression" && !c.computed) return c.property.name;
  return "";
}

function sinkName(node) {
  return node.type === "NewExpression" ? node.callee.name : calleeName(node);
}

function nameOf(fn) {
  const p = fn.parent;
  if (fn.id?.name) return fn.id.name;
  if (p?.type === "VariableDeclarator") return p.id.name;
  if (p?.type === "Property" || p?.type === "MethodDefinition") return p.key?.name || "";
  return "";
}

// Inside a try block (with a catch) of the same function.
function guarded(node, fnNode) {
  for (let p = node.parent, child = node; p && p !== fnNode; child = p, p = p.parent) {
    if (FN.has(p.type)) return false;
    if (p.type === "TryStatement" && p.block === child && p.handler) return true;
  }
  return false;
}

// x.catch(..) or x.then(a, b), possibly after .then(a)/.finally(..) links.
function handledChain(call) {
  const m = call.parent;
  if (m?.type !== "MemberExpression" || m.object !== call || m.parent?.type !== "CallExpression") return false;
  const name = m.property.name;
  if (name === "catch") return true;
  if (name === "then" && m.parent.arguments.length >= 2) return true;
  return (name === "then" || name === "finally") && handledChain(m.parent);
}

// `await x.then(..)` / `.finally(..)` without catch still rejects like x.
function unwrapChain(arg) {
  let a = arg;
  while (a?.type === "CallExpression" && a.callee.type === "MemberExpression" && ["then", "finally"].includes(a.callee.property.name)) a = a.callee.object;
  return a;
}

function parseAll(root, files) {
  const asts = new Map();
  for (const f of files) {
    const ast = espree.parse(fs.readFileSync(path.join(root, f), "utf8"), PARSE);
    walk(ast, (n, p) => {
      n.parent = p;
      if (FN.has(n.type)) n.file = f;
    });
    asts.set(f, ast);
  }
  return asts;
}

// Named async functions across all files (modules import by the same name).
function collectAsync(asts) {
  const fns = new Map();
  for (const ast of asts.values()) {
    walk(ast, (n) => {
      const name = FN.has(n.type) && n.async ? nameOf(n) : "";
      if (name) fns.set(name, [...(fns.get(name) || []), n]);
    });
  }
  return fns;
}

class Analysis {
  constructor(asts) {
    this.fns = collectAsync(asts);
    this.rejects = new Map(); // fnNode -> reason
    this.solve();
  }

  // A name defined in the calling file wins over same-named functions elsewhere.
  resolve(name, file) {
    const all = this.fns.get(name) || [];
    const local = all.filter((fn) => fn.file === file);
    return local.length ? local : all;
  }

  rejectingTarget(name, file) {
    return this.resolve(name, file).find((fn) => this.rejects.has(fn));
  }

  awaitReason(n, fnNode) {
    if (n.argument.type === "CallExpression" && handledChain(n.argument)) return "";
    const arg = unwrapChain(n.argument);
    const at = n.loc.start.line;
    if (arg?.type === "ImportExpression") return `await import() at ${at}`;
    if (arg?.type !== "CallExpression") return "";
    const name = calleeName(arg);
    return REJECTING_CALLS.has(name) || this.rejectingTarget(name, fnNode.file) ? `await ${name}() at ${at}` : "";
  }

  reasonFor(fnNode) {
    let reason = "";
    walk(fnNode.body, (n) => {
      if (reason || (n !== fnNode.body && FN.has(n.type))) return false; // nested functions are their own
      if (guarded(n, fnNode)) return undefined;
      if (n.type === "ThrowStatement") reason = `throw at ${n.loc.start.line}`;
      else if (n.type === "AwaitExpression") reason = this.awaitReason(n, fnNode);
      return undefined;
    });
    return reason;
  }

  // Fixpoint: a function that awaits a rejecting function rejects too.
  solve() {
    for (let changed = true; changed; ) {
      changed = false;
      for (const fn of [...this.fns.values()].flat()) {
        const r = this.rejects.has(fn) ? "" : this.reasonFor(fn);
        if (r) {
          this.rejects.set(fn, r);
          changed = true;
        }
      }
    }
  }

  mayReject(fn) {
    return this.rejects.get(fn) || (fn.async ? this.reasonFor(fn) : "");
  }
}

function isIgnoredCallback(fn) {
  const call = fn.parent;
  if (!call || !["CallExpression", "NewExpression"].includes(call.type) || !call.arguments.includes(fn)) return false;
  return IGNORING_SINKS.has(sinkName(call));
}

// Where does this call's promise end up? true when nobody can see a rejection.
function isDropped(call) {
  let top = call;
  while (top.parent?.type === "MemberExpression" && top.parent.object === top && ["then", "finally"].includes(top.parent.property.name) && top.parent.parent?.type === "CallExpression") top = top.parent.parent;
  let p = top.parent;
  while (p && (PASS_THROUGH.has(p.type) || (p.type === "UnaryExpression" && p.operator === "void"))) p = p.parent;
  return p?.type === "ExpressionStatement" || (p?.type === "ArrowFunctionExpression" && isIgnoredCallback(p));
}

function floatingFinding(n, file, analysis) {
  if (n.type !== "CallExpression" || handledChain(n)) return null;
  const name = calleeName(n);
  const target = analysis.rejectingTarget(name, file);
  if (!target || !isDropped(n)) return null;
  return { file, line: n.loc.start.line, kind: "floating", text: `${name}() may reject (${analysis.rejects.get(target)})` };
}

function listenerFindings(n, file, analysis) {
  if (!["CallExpression", "NewExpression"].includes(n.type) || !IGNORING_SINKS.has(sinkName(n))) return [];
  const out = [];
  for (const arg of n.arguments) {
    let reason = "";
    if (FN.has(arg.type) && arg.async) reason = analysis.mayReject(arg);
    else if (arg.type === "Identifier") reason = analysis.rejects.get(analysis.rejectingTarget(arg.name, file)) || "";
    if (reason) out.push({ file, line: arg.loc.start.line, kind: "listener", text: `${arg.type === "Identifier" ? arg.name : "async callback"} passed to ${sinkName(n)} may reject (${reason})` });
  }
  return out;
}

export function audit(root, files) {
  const asts = parseAll(root, files);
  const analysis = new Analysis(asts);
  const findings = [];
  for (const [file, ast] of asts) {
    walk(ast, (n) => {
      const floating = floatingFinding(n, file, analysis);
      if (floating) findings.push(floating);
      findings.push(...listenerFindings(n, file, analysis));
    });
  }
  return findings;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".js")).map((f) => `public/${f}`);
  const findings = audit(root, files);
  for (const x of findings) console.log(`${x.kind.padEnd(8)} ${x.file}:${x.line}  ${x.text}`);
  console.log(`\n${findings.length} findings`);
}
