#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { request } from "node:http";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { createFixtureServer } from "./dev-fixture-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const mediaRoot = path.join(root, "test", "dev-fixtures", "media");
const fixtureFiles = [
  ["landscape-image", "landscape.png", "image/png"],
  ["portrait-image", "portrait.jpg", "image/jpeg"],
  ["h264-video", "compatible-h264.mp4", "video/mp4"],
  ["webm-video", "compatible-vp9.webm", "video/webm"],
  ["unsupported-mov", "unsupported.mov", "video/quicktime"],
];
const silentLogger = { log() {}, error() {} };

function rawRequest(port, requestPath, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: requestPath, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    req.end();
  });
}

function assertMediaHeaders(response, { type, length, range = null }) {
  assert.equal(response.headers["content-type"], type);
  assert.equal(response.headers["content-length"], String(length));
  assert.equal(response.headers["accept-ranges"], "bytes");
  if (range == null) {
    assert.equal(response.headers["content-range"], undefined);
  } else {
    assert.equal(response.headers["content-range"], range);
  }
}

function assertNoPaths(response) {
  const body = response.body.toString("utf8");
  assert.equal(body.includes(root), false);
  assert.equal(body.includes(mediaRoot), false);
}

async function main() {
  const fixture = createFixtureServer({ port: 0, mediaRoot, logger: silentLogger });
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

    for (const [id, file, type] of fixtureFiles) {
      const expected = fs.readFileSync(path.join(mediaRoot, file));
      const requestPath = `/api/fixtures/media/${id}`;
      const full = await rawRequest(started.port, requestPath);
      assert.equal(full.status, 200);
      assert.deepEqual(full.body, expected);
      assertMediaHeaders(full, { type, length: expected.length });

      const head = await fetch(`${started.origin}${requestPath}`, { method: "HEAD" });
      assert.equal(head.status, 200);
      assert.equal(head.headers.get("content-type"), type);
      assert.equal(head.headers.get("content-length"), String(expected.length));
      assert.equal(head.headers.get("accept-ranges"), "bytes");
      assert.equal((await head.arrayBuffer()).byteLength, 0);

      const ranges = [
        ["bytes=0-7", 0, Math.min(7, expected.length - 1)],
        ["bytes=8-", 8, expected.length - 1],
        ["bytes=-8", Math.max(0, expected.length - 8), expected.length - 1],
        ["bytes=-999999999", 0, expected.length - 1],
        ["bytes=0-999999999", 0, expected.length - 1],
      ];
      for (const [rangeHeader, start, end] of ranges) {
        const ranged = await rawRequest(started.port, requestPath, { Range: rangeHeader });
        const expectedBody = expected.subarray(start, end + 1);
        assert.equal(ranged.status, 206);
        assert.deepEqual(ranged.body, expectedBody);
        assertMediaHeaders(ranged, {
          type,
          length: expectedBody.length,
          range: `bytes ${start}-${end}/${expected.length}`,
        });
      }

      const rangedHead = await fetch(`${started.origin}${requestPath}`, {
        method: "HEAD",
        headers: { Range: "bytes=0-7" },
      });
      assert.equal(rangedHead.status, 206);
      assert.equal(rangedHead.headers.get("content-type"), type);
      assert.equal(rangedHead.headers.get("content-length"), "8");
      assert.equal(rangedHead.headers.get("accept-ranges"), "bytes");
      assert.equal(rangedHead.headers.get("content-range"), `bytes 0-7/${expected.length}`);
      assert.equal((await rangedHead.arrayBuffer()).byteLength, 0);

      const inline = await rawRequest(started.port, `${requestPath}?inline=1`);
      assert.equal(inline.status, 200);
      assert.equal(inline.headers["x-husky-asset-tier"], "full");
      assert.equal(inline.headers["x-husky-original-bytes"], String(expected.length));

      const inlineRange = await rawRequest(started.port, `${requestPath}?inline=1`, {
        Range: "bytes=0-7",
      });
      assert.equal(inlineRange.status, 206);
      assert.equal(inlineRange.headers["x-husky-asset-tier"], "full");
      assert.equal(inlineRange.headers["x-husky-original-bytes"], String(expected.length));
    }

    const h264Size = fs.statSync(path.join(mediaRoot, "compatible-h264.mp4")).size;
    for (const invalidRange of [
      "bytes=abc",
      "bytes=9-3",
      "bytes=-0",
      `bytes=${h264Size}-`,
      "bytes=0-1,3-4",
    ]) {
      const invalid = await rawRequest(started.port, "/api/fixtures/media/h264-video", {
        Range: invalidRange,
      });
      assert.equal(invalid.status, 416);
      assert.equal(invalid.headers["content-range"], `bytes */${h264Size}`);
      assert.equal(invalid.headers["content-length"], "0");
      assert.equal(invalid.body.length, 0);
      assertNoPaths(invalid);
    }

    const errors = [
      [await rawRequest(started.port, "/api/fixtures/media/unknown"), 404],
      [await rawRequest(started.port, "/test/dev-fixtures/media/compatible-h264.mp4"), 404],
      [await rawRequest(started.port, "/..%2fpackage.json"), 400],
      [await rawRequest(started.port, "/%00"), 400],
      [await rawRequest(started.port, "/api/fixtures/media/%2e%2e%2fpackage.json"), 400],
    ];
    for (const [response, status] of errors) {
      assert.equal(response.status, status);
      assertNoPaths(response);
    }

    const wrongMethodFetch = await fetch(`${started.origin}/api/fixtures/media/h264-video`, {
      method: "POST",
    });
    const wrongMethod = {
      status: wrongMethodFetch.status,
      headers: Object.fromEntries(wrongMethodFetch.headers),
      body: Buffer.from(await wrongMethodFetch.arrayBuffer()),
    };
    assert.equal(wrongMethod.status, 405);
    assert.match(wrongMethod.headers["content-type"] || "", /^application\/json\b/);
    assert.doesNotThrow(() => JSON.parse(wrongMethod.body.toString("utf8")));
    assertNoPaths(wrongMethod);

    const readme = fs.readFileSync(path.join(root, "test", "dev-fixtures", "README.md"), "utf8");
    for (const [, file] of fixtureFiles) {
      const bytes = fs.readFileSync(path.join(mediaRoot, file));
      const digest = createHash("sha256").update(bytes).digest("hex");
      assert.ok(readme.includes(digest), `${file} SHA-256 is missing from fixture provenance`);
    }
  } finally {
    await fixture.stop();
    await fixture.stop();
  }

  const temporaryPublicRoot = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "husky-drop-fixture-public-"),
  );
  const escapeFixture = createFixtureServer({
    port: 0,
    publicRoot: temporaryPublicRoot,
    mediaRoot,
    logger: silentLogger,
  });
  try {
    await fs.promises.symlink(
      root,
      path.join(temporaryPublicRoot, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const escapeStarted = await escapeFixture.start();
    const escaped = await rawRequest(escapeStarted.port, "/escape/package.json");
    assert.equal(escaped.status, 404);
    assertNoPaths(escaped);
  } finally {
    await escapeFixture.stop();
    await fs.promises.rm(temporaryPublicRoot, { recursive: true, force: true });
  }

  const missing = createFixtureServer({
    port: 0,
    publicRoot: path.join(root, "test", "missing-public-root"),
    logger: silentLogger,
  });
  await assert.rejects(() => missing.start(), /public root/i);
  assert.throws(() => createFixtureServer({ port: 65536 }), /port/i);

  const missingMedia = createFixtureServer({
    port: 0,
    mediaRoot: path.join(root, "test", "missing-fixture-media"),
    logger: silentLogger,
  });
  try {
    await assert.rejects(() => missingMedia.start(), /media root/i);
  } finally {
    await missingMedia.stop();
  }

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
