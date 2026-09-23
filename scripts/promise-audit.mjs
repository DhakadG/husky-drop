// Finds browser code that can end in an "unhandledrejection" or crash the
// page on a flaky connection or locked-down browser. Each finding is a place
// where a rejection nobody handles is possible:
//
//   floating   a call to an async function that can reject, whose promise is
//              dropped (statement, `a && f()`, `void f()`, `.then`/`.finally`
//              without `.catch`, or returned from a callback nobody awaits)
//   listener   an async function that can reject, handed to an event
//              listener / observer / timer, which ignore the promise
//
// Storage that throws (blocked site data, full quota) is handled once, by the
// safeStorage shim at the top of public/public.js; the test checks it loads
// first on every page.
// "Can reject" is worked out per function: an `await` of a call that can
// reject (fetch, json(), import(), or an async function that can reject),
// or a `throw`, outside a try block with a catch. Used by
// scripts/promise-audit-test.mjs; run directly to list everything.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as espree from "espree";

const PARSE = { ecmaVersion: "latest", sourceType: "module" };
const FN = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
// Calls that reject on a network drop or a bad response.
const REJECTING_CALLS = new Set(["fetch", "json", "text", "arrayBuffer", "blob", "import"]);
// Callbacks whose return value is ignored by the platform.
const IGNORING_SINKS = new Set(["addEventListener", "setTimeout", "setInterval", "requestAnimationFrame", "requestIdleCallback", "forEach", "IntersectionObserver", "ResizeObserver", "MutationObserver", "on", "once"]);

function walk(node, visit, parent = null) {
  if (!node || typeof node.type !== "string") return;
  if (visit(node, parent) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const v = node[key];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === "string" && walk(c, visit, node));
    else if (v && typeof v.type === "string") walk(v, visit, node);
  }
}

const calleeName = (call) => {
  const c = call.callee;
  if (c.type === "Identifier") return c.name;
  if (c.type === "MemberExpression" && !c.computed) return c.property.name;
  if (c.type === "Import") return "import";
  return "";
};

export function audit(root, files) {
  const asts = new Map();
  for (const f of files) {
    const src = fs.readFileSync(path.join(root, f), "utf8");
    const ast = espree.parse(src, { ...PARSE, loc: true });
    // Parent links, used to climb from a call to where its promise goes.
    walk(ast, (n, p) => {
      n.parent = p;
    });
    asts.set(f, ast);
  }

  // Named async functions across all files (modules import by the same name).
  const fns = new Map(); // name -> [fnNode]
  const nameOf = (fn) => fn.id?.name || (fn.parent?.type === "VariableDeclarator" && fn.parent.id.name) || (fn.parent?.type === "Property" && fn.parent.key?.name) || (fn.parent?.type === "MethodDefinition" && fn.parent.key?.name) || "";
  for (const [file, ast] of asts) {
    walk(ast, (n) => {
      if (FN.has(n.type)) n.file = file;
      if (FN.has(n.type) && n.async) {
        const name = nameOf(n);
        if (name) fns.set(name, [...(fns.get(name) || []), n]);
      }
    });
  }

  // A name defined in the calling file wins over same-named functions elsewhere.
  const resolve = (name, file) => {
    const all = fns.get(name) || [];
    const local = all.filter((fn) => fn.file === file);
    return local.length ? local : all;
  };
  const guarded = (node, fnNode) => {
    // Inside a try block (with a catch) of the same function.
    for (let p = node.parent, child = node; p && p !== fnNode; child = p, p = p.parent) {
      if (FN.has(p.type)) return false;
      if (p.type === "TryStatement" && p.block === child && p.handler) return true;
    }
    return false;
  };
  const handledChain = (call) => {
    // x.catch(), or x.then(a, b)
    const m = call.parent;
    if (m?.type === "MemberExpression" && m.object === call && m.parent?.type === "CallExpression") {
      const name = m.property.name;
      if (name === "catch") return true;
      if (name === "then" && m.parent.arguments.length >= 2) return true;
      if (name === "then" || name === "finally") return handledChain(m.parent);
    }
    return false;
  };

  let rejects = new Map(); // fnNode -> reason
  const reasonFor = (fnNode) => {
    let reason = "";
    walk(fnNode.body, (n) => {
      if (reason) return false;
      if (n !== fnNode.body && FN.has(n.type)) return false; // nested functions are their own
      if (n.type === "ThrowStatement" && !guarded(n, fnNode)) reason = `throw at ${n.loc.start.line}`;
      if (n.type === "AwaitExpression" && !guarded(n, fnNode)) {
        let arg = n.argument;
        if (arg.type === "CallExpression" && handledChain(arg)) return;
        // `await x.then(..)` / `.finally(..)` without catch still rejects.
        while (arg?.type === "CallExpression" && arg.callee.type === "MemberExpression" && ["then", "finally"].includes(arg.callee.property.name)) arg = arg.callee.object;
        if (arg?.type === "ImportExpression") reason = `await import() at ${n.loc.start.line}`;
        else if (arg?.type === "CallExpression") {
          const name = calleeName(arg);
          if (REJECTING_CALLS.has(name)) reason = `await ${name}() at ${n.loc.start.line}`;
          else if (resolve(name, fnNode.file).some((f) => rejects.has(f))) reason = `await ${name}() at ${n.loc.start.line}`;
        }
      }
    });
    return reason;
  };
  // Fixpoint: a function that awaits a rejecting function rejects too.
  for (let changed = true; changed; ) {
    changed = false;
    for (const list of fns.values()) {
      for (const fn of list) {
        if (rejects.has(fn)) continue;
        const r = reasonFor(fn);
        if (r) {
          rejects.set(fn, r);
          changed = true;
        }
      }
    }
  }
  // Inline async callbacks are judged the same way.
  const mayReject = (fn) => rejects.get(fn) || (fn.async ? reasonFor(fn) : "");

  const findings = [];
  const add = (f, node, kind, text) => findings.push({ file: f, line: node.loc.start.line, kind, text });
  for (const [f, ast] of asts) {
    walk(ast, (n) => {
      // floating: named async call whose promise is dropped
      if (n.type === "CallExpression") {
        const name = calleeName(n);
        const targets = resolve(name, f).filter((fn) => rejects.has(fn));
        if (targets.length && n.callee.type !== "Super") {
          let top = n;
          if (handledChain(n)) return;
          // climb .then()/.finally() chains
          while (top.parent?.type === "MemberExpression" && top.parent.object === top && ["then", "finally"].includes(top.parent.property.name) && top.parent.parent?.type === "CallExpression") top = top.parent.parent;
          let p = top.parent;
          while (p && (p.type === "LogicalExpression" || p.type === "ConditionalExpression" || p.type === "SequenceExpression" || (p.type === "UnaryExpression" && p.operator === "void"))) p = p.parent;
          const dropped = p?.type === "ExpressionStatement" || (p?.type === "ArrowFunctionExpression" && p.body !== top.parent && isIgnoredCallback(p));
          const arrowBody = p?.type === "ArrowFunctionExpression" && isIgnoredCallback(p);
          if (dropped || arrowBody) add(f, n, "floating", `${name}() may reject (${rejects.get(targets[0])})`);
        }
      }
      // listener: async function handed to something that ignores it
      if (n.type === "CallExpression" && IGNORING_SINKS.has(calleeName(n)) || n.type === "NewExpression" && IGNORING_SINKS.has(n.callee.name)) {
        for (const arg of n.arguments) {
          if (FN.has(arg.type) && arg.async) {
            const r = mayReject(arg);
            if (r) add(f, arg, "listener", `async callback to ${calleeName(n) || n.callee.name} may reject (${r})`);
          } else if (arg.type === "Identifier") {
            const t = resolve(arg.name, f).find((fn) => rejects.has(fn));
            if (t) add(f, arg, "listener", `${arg.name} passed to ${calleeName(n) || n.callee.name} may reject (${rejects.get(t)})`);
          }
        }
      }
    });
  }
  return findings;

  function isIgnoredCallback(arrow) {
    const call = arrow.parent;
    if (!call || (call.type !== "CallExpression" && call.type !== "NewExpression") || !call.arguments.includes(arrow)) return false;
    const name = call.type === "NewExpression" ? call.callee.name : calleeName(call);
    return IGNORING_SINKS.has(name);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = fs.readdirSync(path.join(root, "public")).filter((f) => f.endsWith(".js")).map((f) => `public/${f}`);
  const findings = audit(root, files);
  for (const x of findings) console.log(`${x.kind.padEnd(8)} ${x.file}:${x.line}  ${x.text}`);
  console.log(`\n${findings.length} findings`);
}
