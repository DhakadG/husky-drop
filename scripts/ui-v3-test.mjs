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

console.log("UI v3 structure tests passed");
