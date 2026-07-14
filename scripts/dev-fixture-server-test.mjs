#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createFixtureServer } from "./dev-fixture-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const silentLogger = { log() {}, error() {} };

async function main() {
  const fixture = createFixtureServer({ port: 0, logger: silentLogger });
  const started = await fixture.start();
  try {
    assert.equal(started.host, "127.0.0.1");
    assert.ok(Number.isInteger(started.port) && started.port > 0);
    assert.equal(started.origin, `http://127.0.0.1:${started.port}`);
    assert.equal(started.shareUrl, `${started.origin}/s/local-media`);

    const collision = createFixtureServer({ port: started.port, logger: silentLogger });
    await assert.rejects(() => collision.start(), /EADDRINUSE|address.*use/i);
    await collision.stop();

    const share = await fetch(started.shareUrl);
    assert.equal(share.status, 200);
    assert.match(share.headers.get("content-type") || "", /^text\/html\b/);
    const fixtureCsp = share.headers.get("content-security-policy") || "";
    assert.match(fixtureCsp, /connect-src 'self'/);
    assert.match(fixtureCsp, /font-src 'self' data:/);
    assert.doesNotMatch(fixtureCsp, /https?:/);
    assert.equal(await share.text(), fs.readFileSync(path.join(publicRoot, "share.html"), "utf8"));

    const css = await fetch(`${started.origin}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type") || "", /^text\/css\b/);

    const unknownShare = await fetch(`${started.origin}/s/unknown`);
    assert.equal(unknownShare.status, 404);

    const outside = await fetch(`${started.origin}/package.json`);
    assert.equal(outside.status, 404);
  } finally {
    await fixture.stop();
    await fixture.stop();
  }

  const missing = createFixtureServer({
    port: 0,
    publicRoot: path.join(root, "test", "missing-public-root"),
    logger: silentLogger,
  });
  await assert.rejects(() => missing.start(), /public root/i);
  assert.throws(() => createFixtureServer({ port: 65536 }), /port/i);

  const child = spawn(process.execPath, [path.join(root, "scripts", "dev-fixture-server.mjs")], {
    cwd: root,
    env: { ...process.env, PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  try {
    const [line] = await once(lines, "line", { signal: AbortSignal.timeout(5000) });
    const match = /^Husky Drop fixture share: (http:\/\/127\.0\.0\.1:\d+\/s\/local-media)$/.exec(line);
    assert.ok(match, `unexpected fixture startup output: ${line}`);
    const directShare = await fetch(match[1]);
    assert.equal(directShare.status, 200);
  } finally {
    lines.close();
    if (child.exitCode == null) {
      const exited = once(child, "exit", { signal: AbortSignal.timeout(5000) });
      child.kill("SIGTERM");
      await exited;
    }
  }
  console.log("development fixture server checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
