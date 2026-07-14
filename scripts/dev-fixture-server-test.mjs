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
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createFixtureServer } from "./dev-fixture-server.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicRoot = path.join(root, "public");
const mediaRoot = path.join(root, "test", "dev-fixtures", "media");
const FIXTURE_AT = "2026-07-14T00:00:00.000Z";
const FAR_FUTURE = 4102444800000;
const fixtureRecords = [
  {
    id: "landscape-image",
    file: "landscape.png",
    name: "Landscape fixture.png",
    mime: "image/png",
    width: 480,
    height: 270,
    durationMs: 0,
    thumbnailId: "landscape-image",
    infoWidth: 480,
    infoHeight: 270,
    infoDurationMs: 0,
  },
  {
    id: "portrait-image",
    file: "portrait.jpg",
    name: "Portrait fixture.jpg",
    mime: "image/jpeg",
    width: 270,
    height: 480,
    durationMs: 0,
    thumbnailId: "portrait-image",
    infoWidth: 270,
    infoHeight: 480,
    infoDurationMs: 0,
  },
  {
    id: "h264-video",
    file: "compatible-h264.mp4",
    name: "Compatible H264.mp4",
    mime: "video/mp4",
    width: 320,
    height: 180,
    durationMs: 2000,
    thumbnailId: "landscape-image",
    infoWidth: 320,
    infoHeight: 180,
    infoDurationMs: 2000,
  },
  {
    id: "webm-video",
    file: "compatible-vp9.webm",
    name: "Compatible VP9.webm",
    mime: "video/webm",
    width: 320,
    height: 180,
    durationMs: 2000,
    thumbnailId: "landscape-image",
    infoWidth: 320,
    infoHeight: 180,
    infoDurationMs: 2000,
  },
  {
    id: "unsupported-mov",
    file: "unsupported.mov",
    name: "Unsupported QuickTime.mov",
    mime: "video/quicktime",
    width: 640,
    height: 360,
    durationMs: 1000,
    thumbnailId: "landscape-image",
    infoWidth: 0,
    infoHeight: 0,
    infoDurationMs: 0,
  },
];
const fixtureFiles = fixtureRecords.map(({ id, file, mime }) => [id, file, mime]);
const expectedApiFiles = fixtureRecords.map((fixture) => {
  const mediaPath = `/api/fixtures/media/${fixture.id}`;
  const thumbnailPath = `/api/fixtures/media/${fixture.thumbnailId}`;
  return {
    id: fixture.id,
    name: fixture.name,
    size: fs.statSync(path.join(mediaRoot, fixture.file)).size,
    mime: fixture.mime,
    at: Date.parse(FIXTURE_AT),
    thumb: thumbnailPath,
    thumbs: {
      base: thumbnailPath,
      mid: thumbnailPath,
      max: thumbnailPath,
    },
    thumbsExpireAt: FAR_FUTURE,
    w: fixture.width,
    h: fixture.height,
    aspect: fixture.width / fixture.height,
    dur: fixture.durationMs,
    dl: mediaPath,
    dlExpiresAt: FAR_FUTURE,
    downloadBlocked: false,
    downloadBlockReason: "",
  };
});
const expectedLandscapeExif = {
  source: "fixture",
  time: FIXTURE_AT,
  cameraMake: "Husky Labs",
  cameraModel: "Fixture Camera",
  lens: "Synthetic 24mm",
  exposureTime: 0.008,
  aperture: 5.6,
  isoSpeed: 100,
  focalLength: 24,
  focalLength35mm: 24,
  exposureBias: 0,
  exposureMode: "Manual",
  exposureProgram: "Manual",
  meteringMode: "Pattern",
  whiteBalance: "Auto",
  flashUsed: false,
  colorSpace: "sRGB",
  rotation: 0,
  location: null,
};
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

function abortAfterFirstChunk(port, requestPath) {
  return new Promise((resolve, reject) => {
    let status = null;
    const req = request({ host: "127.0.0.1", port, path: requestPath }, (response) => {
      status = response.statusCode;
      response.once("data", () => {
        response.destroy();
        resolve({ status });
      });
      response.on("error", () => {});
    });
    req.on("error", (error) => {
      if (error.code === "ECONNRESET") resolve({ status });
      else reject(error);
    });
    req.end();
  });
}

function closesWithin(
  stream,
  milliseconds = 1000,
  allowedErrors = ["ECONNRESET", "ERR_STREAM_PREMATURE_CLOSE"],
) {
  if (stream.closed) return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.off("close", onClose);
      stream.off("error", onError);
      if (error) reject(error);
      else resolve(result);
    };
    const onClose = () => finish(null, true);
    const onError = (error) => {
      if (!allowedErrors.includes(error.code)) {
        finish(error);
      }
    };
    const timeout = setTimeout(() => finish(null, false), milliseconds);
    stream.once("close", onClose);
    stream.on("error", onError);
    if (stream.closed) finish(null, true);
  });
}

function listenerCounts(stream) {
  return Object.fromEntries(stream.eventNames()
    .filter((eventName) => typeof eventName === "string")
    .map((eventName) => [eventName, stream.listenerCount(eventName)]));
}

function deferred(label, milliseconds = 1000) {
  const { promise, resolve: finish, reject } = Promise.withResolvers();
  const timeout = setTimeout(
    () => reject(new Error(`timed out waiting for ${label}`)),
    milliseconds,
  );
  return {
    promise,
    resolve(value) {
      clearTimeout(timeout);
      finish(value);
    },
  };
}

function exactJsonBody(byteLength) {
  const prefix = Buffer.from('{"slug":"local-media","padding":"', "utf8");
  const suffix = Buffer.from('"}', "utf8");
  const paddingLength = byteLength - prefix.length - suffix.length;
  assert.ok(paddingLength >= 0, `cannot build a ${byteLength}-byte fixture JSON body`);
  const body = Buffer.concat([prefix, Buffer.alloc(paddingLength, "x"), suffix]);
  assert.equal(body.byteLength, byteLength);
  assert.doesNotThrow(() => JSON.parse(body.toString("utf8")));
  return body;
}

function rawChunkedJsonRequest(port, requestPath, body) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "transfer-encoding": "chunked",
      },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    req.on("error", reject);
    assert.equal(req.getHeader("content-length"), undefined);
    for (let offset = 0; offset < body.byteLength; offset += 4096) {
      req.write(body.subarray(offset, Math.min(offset + 4096, body.byteLength)));
    }
    req.end();
  });
}

async function postJson(origin, pathname, body) {
  const response = await fetch(`${origin}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null, text };
}

function assertJsonResponse(response) {
  assert.match(response.headers.get("content-type") || "", /^application\/json\b/);
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
  const startStopFixture = createFixtureServer({ port: 0, mediaRoot, logger: silentLogger });
  try {
    const pendingStart = startStopFixture.start();
    await startStopFixture.stop();
    const brieflyStarted = await pendingStart;
    await assert.rejects(() => fetch(brieflyStarted.origin, {
      signal: AbortSignal.timeout(1000),
    }));
  } finally {
    await startStopFixture.stop();
  }

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

    const metaResponse = await fetch(`${started.origin}/api/share/meta/local-media`);
    assert.equal(metaResponse.status, 200);
    assertJsonResponse(metaResponse);
    assert.deepEqual(await metaResponse.json(), {
      slug: "local-media",
      label: "Local media fixtures",
      mode: "gallery",
      requiresPin: false,
      requiresAuth: false,
      viewer: null,
      allowZip: false,
      state: "active",
      expiresAt: null,
      theme: { accentColor: "#2f6bff" },
      appName: "LostHusky's DropBox",
    });

    const missingMeta = await fetch(`${started.origin}/api/share/meta/missing-share`);
    assert.equal(missingMeta.status, 404);
    assertJsonResponse(missingMeta);
    assert.deepEqual(await missingMeta.json(), { error: "fixture share not found" });

    const verified = await postJson(started.origin, "/api/share/verify", {
      slug: "local-media",
      pin: "",
    });
    assert.equal(verified.response.status, 200);
    assertJsonResponse(verified.response);
    assert.deepEqual(verified.body, { ok: true });

    const missingVerify = await postJson(started.origin, "/api/share/verify", {
      slug: "missing-share",
      pin: "",
    });
    assert.equal(missingVerify.response.status, 404);
    assertJsonResponse(missingVerify.response);
    assert.deepEqual(missingVerify.body, { error: "fixture share not found" });

    const redirect = await postJson(started.origin, "/api/share/redirect", {
      slug: "local-media",
      pin: "",
    });
    assert.equal(redirect.response.status, 400);
    assertJsonResponse(redirect.response);
    assert.deepEqual(redirect.body, { error: "not a redirect share" });

    const listing = await postJson(started.origin, "/api/share/list", {
      slug: "local-media",
      pin: "",
    });
    assert.equal(listing.response.status, 200);
    assertJsonResponse(listing.response);
    assert.deepEqual(listing.body, {
      folders: [{
        index: 0,
        fid: "",
        name: "Local fixture media",
        files: expectedApiFiles,
        subfolders: [{
          fid: "fixture-empty-folder",
          name: "Empty fixture folder",
          ls: "fixture-folder:empty",
        }],
        nextPageToken: "",
        loadedCount: 5,
        hasMore: false,
      }],
      allowZip: false,
    });

    const fileFields = [
      "aspect",
      "at",
      "dl",
      "dlExpiresAt",
      "downloadBlockReason",
      "downloadBlocked",
      "dur",
      "h",
      "id",
      "mime",
      "name",
      "size",
      "thumb",
      "thumbs",
      "thumbsExpireAt",
      "w",
    ];
    for (const file of listing.body.folders[0].files) {
      assert.deepEqual(Object.keys(file).sort(), fileFields);
      for (const field of ["id", "name", "mime", "thumb", "dl", "downloadBlockReason"]) {
        assert.equal(typeof file[field], "string", `${file.id}.${field}`);
      }
      for (const field of ["size", "at", "thumbsExpireAt", "w", "h", "aspect", "dur", "dlExpiresAt"]) {
        assert.equal(typeof file[field], "number", `${file.id}.${field}`);
      }
      assert.equal(typeof file.downloadBlocked, "boolean", `${file.id}.downloadBlocked`);
      assert.equal(typeof file.thumbs, "object", `${file.id}.thumbs`);
      assert.deepEqual(Object.keys(file.thumbs).sort(), ["base", "max", "mid"]);
      assert.equal(file.thumb, file.thumbs.base);

      for (const url of [file.dl, file.thumb, file.thumbs.base, file.thumbs.mid, file.thumbs.max]) {
        const resolved = new URL(url, started.origin);
        assert.equal(resolved.origin, started.origin);
        assert.ok(resolved.pathname.startsWith("/api/fixtures/media/"), url);
      }

      const expectedThumbnailId = file.mime.startsWith("image/") ? file.id : "landscape-image";
      for (const tier of ["base", "mid", "max"]) {
        assert.equal(file.thumbs[tier], `/api/fixtures/media/${expectedThumbnailId}`);
      }
    }

    const emptyListing = await postJson(started.origin, "/api/share/list", {
      slug: "local-media",
      pin: "",
      folderToken: "fixture-folder:empty",
    });
    assert.equal(emptyListing.response.status, 200);
    assertJsonResponse(emptyListing.response);
    assert.deepEqual(emptyListing.body, {
      folders: [{
        index: 0,
        fid: "fixture-empty-folder",
        name: "Empty fixture folder",
        files: [],
        subfolders: [],
        nextPageToken: "",
        loadedCount: 0,
        hasMore: false,
      }],
      allowZip: false,
    });

    const missingListing = await postJson(started.origin, "/api/share/list", {
      slug: "missing-share",
    });
    assert.equal(missingListing.response.status, 404);
    assertJsonResponse(missingListing.response);
    assert.deepEqual(missingListing.body, { error: "fixture share not found" });

    const summary = await postJson(started.origin, "/api/share/summary", {
      slug: "local-media",
      pin: "",
    });
    assert.equal(summary.response.status, 200);
    assertJsonResponse(summary.response);
    assert.deepEqual(summary.body, {
      files: 5,
      folders: 1,
      bytes: expectedApiFiles.reduce((total, file) => total + file.size, 0),
      images: 2,
      videos: 3,
      allowZip: false,
    });

    for (const file of expectedApiFiles) {
      const refreshed = await postJson(started.origin, "/api/share/refresh-dl", {
        slug: "local-media",
        pin: "",
        dl: file.dl,
      });
      assert.equal(refreshed.response.status, 200);
      assertJsonResponse(refreshed.response);
      assert.deepEqual(refreshed.body, {
        dl: file.dl,
        dlExpiresAt: FAR_FUTURE,
        thumbs: file.thumbs,
        thumbsExpireAt: FAR_FUTURE,
      });
      assert.ok(refreshed.body.dlExpiresAt > Date.now());
      assert.ok(refreshed.body.thumbsExpireAt > Date.now());
    }

    const missingRefresh = await postJson(started.origin, "/api/share/refresh-dl", {
      slug: "local-media",
      dl: "/api/fixtures/media/missing-file",
    });
    assert.equal(missingRefresh.response.status, 404);
    assertJsonResponse(missingRefresh.response);
    assert.deepEqual(missingRefresh.body, { error: "fixture file not found" });

    for (const fixtureRecord of fixtureRecords) {
      const fileInfo = await postJson(started.origin, "/api/share/file-info", {
        slug: "local-media",
        pin: "",
        dl: `/api/fixtures/media/${fixtureRecord.id}`,
      });
      assert.equal(fileInfo.response.status, 200);
      assertJsonResponse(fileInfo.response);
      const megapixels = fixtureRecord.infoWidth && fixtureRecord.infoHeight
        ? Math.round((fixtureRecord.infoWidth * fixtureRecord.infoHeight) / 10000) / 100
        : 0;
      assert.deepEqual(fileInfo.body, {
        file: {
          id: fixtureRecord.id,
          name: fixtureRecord.name,
          mime: fixtureRecord.mime,
          size: fs.statSync(path.join(mediaRoot, fixtureRecord.file)).size,
          createdAt: Date.parse(FIXTURE_AT),
          modifiedAt: Date.parse(FIXTURE_AT),
          width: fixtureRecord.infoWidth,
          height: fixtureRecord.infoHeight,
          megapixels,
          durationMs: fixtureRecord.infoDurationMs,
        },
        exif: fixtureRecord.id === "landscape-image" ? expectedLandscapeExif : {},
      });
    }

    const zipTicket = await postJson(started.origin, "/api/share/zip-ticket", {
      slug: "local-media",
      pin: "",
      files: expectedApiFiles.map(({ dl, name, size, mime }) => ({ dl, name, size, mime })),
    });
    assert.equal(zipTicket.response.status, 501);
    assertJsonResponse(zipTicket.response);
    assert.deepEqual(zipTicket.body, {
      error: "ZIP downloads are not supported by the local fixture server.",
    });

    for (const pathname of ["/api/share/opened", "/api/share/track"]) {
      const discarded = await postJson(started.origin, pathname, { slug: "local-media" });
      assert.equal(discarded.response.status, 204);
      assert.equal(discarded.text.length, 0);
      assert.equal(discarded.body, null);
    }

    const unknownApi = await fetch(`${started.origin}/api/share/not-a-fixture-route`);
    assert.equal(unknownApi.status, 404);
    assertJsonResponse(unknownApi);
    assert.deepEqual(await unknownApi.json(), { error: "fixture API route not found" });

    const wrongMethodCases = [
      ["POST", "/api/share/meta/local-media"],
      ["GET", "/api/share/verify"],
      ["GET", "/api/share/redirect"],
      ["GET", "/api/share/list"],
      ["GET", "/api/share/summary"],
      ["GET", "/api/share/refresh-dl"],
      ["GET", "/api/share/file-info"],
      ["GET", "/api/share/zip-ticket"],
      ["GET", "/api/share/opened"],
      ["GET", "/api/share/track"],
    ];
    for (const [method, pathname] of wrongMethodCases) {
      const wrongMethod = await fetch(`${started.origin}${pathname}`, { method });
      assert.equal(wrongMethod.status, 405, `${method} ${pathname}`);
      assertJsonResponse(wrongMethod);
      assert.deepEqual(await wrongMethod.json(), { error: "Method Not Allowed" });
    }

    const invalidJsonResponse = await fetch(`${started.origin}/api/share/list`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    assert.equal(invalidJsonResponse.status, 400);
    assertJsonResponse(invalidJsonResponse);
    assert.deepEqual(await invalidJsonResponse.json(), { error: "invalid JSON body" });

    const boundaryBody = exactJsonBody(64 * 1024);
    const boundaryResponse = await rawChunkedJsonRequest(
      started.port,
      "/api/share/track",
      boundaryBody,
    );
    assert.equal(boundaryResponse.status, 204);
    assert.equal(boundaryResponse.body.byteLength, 0);

    const oversizedBody = exactJsonBody((64 * 1024) + 1);
    const oversizedResponse = await rawChunkedJsonRequest(
      started.port,
      "/api/share/track",
      oversizedBody,
    );
    assert.equal(oversizedResponse.status, 413);
    assert.match(oversizedResponse.headers["content-type"] || "", /^application\/json\b/);
    assert.deepEqual(JSON.parse(oversizedResponse.body.toString("utf8")), {
      error: "request body too large",
    });

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

  const abortRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "husky-drop-stream-abort-"));
  const abortPublicRoot = path.join(abortRoot, "public");
  const abortMediaRoot = path.join(abortRoot, "media");
  await fs.promises.mkdir(abortPublicRoot);
  await fs.promises.cp(mediaRoot, abortMediaRoot, { recursive: true });
  const earlyFile = path.join(abortPublicRoot, "early.bin");
  const errorFile = path.join(abortPublicRoot, "error.bin");
  await fs.promises.writeFile(earlyFile, Buffer.from("early"));
  await fs.promises.writeFile(errorFile, Buffer.alloc(1));
  await fs.promises.truncate(errorFile, 256 * 1024 * 1024);
  await fs.promises.writeFile(path.join(abortPublicRoot, "small.bin"), Buffer.from("fixture"));
  await fs.promises.writeFile(path.join(abortPublicRoot, "large.bin"), Buffer.alloc(1));
  await fs.promises.truncate(path.join(abortPublicRoot, "large.bin"), 256 * 1024 * 1024);
  await fs.promises.truncate(
    path.join(abortMediaRoot, "compatible-h264.mp4"),
    256 * 1024 * 1024,
  );

  const originalCreateReadStream = fs.createReadStream;
  const originalStat = fs.promises.stat;
  const capturedReadStreams = [];
  const earlyStatEntered = deferred("delayed early-file stat");
  const earlyStreamCreated = deferred("early-file read stream");
  const delayedDestroyStarted = deferred("delayed stream destruction");
  let delayedDestroyCallback = null;
  let releaseEarlyStat;
  const earlyStatRelease = new Promise((resolve) => { releaseEarlyStat = resolve; });
  let delayEarlyStat = true;
  fs.promises.stat = async (...args) => {
    if (delayEarlyStat && path.resolve(String(args[0])) === path.resolve(earlyFile)) {
      delayEarlyStat = false;
      earlyStatEntered.resolve();
      await earlyStatRelease;
    }
    return originalStat(...args);
  };
  fs.createReadStream = (...args) => {
    const isErrorStream = path.resolve(String(args[0])) === path.resolve(errorFile);
    const stream = isErrorStream
      ? new Readable({
          read() { this.push(Buffer.alloc(64 * 1024)); },
          destroy(_error, callback) {
            delayedDestroyCallback = callback;
            delayedDestroyStarted.resolve();
          },
        })
      : originalCreateReadStream(...args);
    capturedReadStreams.push(stream);
    if (path.resolve(String(args[0])) === path.resolve(earlyFile)) {
      earlyStreamCreated.resolve(stream);
    }
    return stream;
  };
  const abortLoggerErrors = [];
  const abortFixture = createFixtureServer({
    port: 0,
    publicRoot: abortPublicRoot,
    mediaRoot: abortMediaRoot,
    logger: { log() {}, error(error) { abortLoggerErrors.push(error); } },
  });
  try {
    const abortStarted = await abortFixture.start();
    const completedResponse = await rawRequest(abortStarted.port, "/small.bin");
    assert.equal(completedResponse.body.toString("utf8"), "fixture");
    const completedStream = capturedReadStreams.at(-1);

    const earlyRequest = request({ host: "127.0.0.1", port: abortStarted.port, path: "/early.bin" });
    earlyRequest.on("error", () => {});
    earlyRequest.end();
    await earlyStatEntered.promise;
    earlyRequest.destroy();
    releaseEarlyStat();
    const earlyStream = await earlyStreamCreated.promise;
    fs.promises.stat = originalStat;

    const mediaStreamCount = capturedReadStreams.length;
    const mediaAbort = await abortAfterFirstChunk(
      abortStarted.port,
      "/api/fixtures/media/h264-video",
    );
    assert.equal(mediaAbort.status, 200);
    assert.equal(capturedReadStreams.length, mediaStreamCount + 1);
    const mediaStream = capturedReadStreams[mediaStreamCount];

    const staticStreamCount = capturedReadStreams.length;
    const staticAbort = await abortAfterFirstChunk(abortStarted.port, "/large.bin");
    assert.equal(staticAbort.status, 200);
    assert.equal(capturedReadStreams.length, staticStreamCount + 1);
    const staticStream = capturedReadStreams[staticStreamCount];
    assert.notEqual(mediaStream, staticStream);

    const errorStreamCount = capturedReadStreams.length;
    const errorAbort = await abortAfterFirstChunk(abortStarted.port, "/error.bin");
    assert.equal(errorAbort.status, 200);
    assert.equal(capturedReadStreams.length, errorStreamCount + 1);
    const errorStream = capturedReadStreams[errorStreamCount];
    await delayedDestroyStarted.promise;
    assert.equal(errorStream.listenerCount("error"), 1);
    const errorClose = closesWithin(errorStream, 1000, ["EIO"]);
    const delayedCloseError = Object.assign(new Error("fixture close failure"), { code: "EIO" });
    delayedDestroyCallback(delayedCloseError);
    delayedDestroyCallback = null;
    assert.equal(await errorClose, true);

    for (const [responsePath, stream] of [
      ["completed", completedStream],
      ["early", earlyStream],
      ["media", mediaStream],
      ["static", staticStream],
      ["error", errorStream],
    ]) {
      assert.equal(await closesWithin(stream), true, `${responsePath} stream did not close`);
      assert.equal(stream.destroyed, true, `${responsePath} stream was not destroyed`);
      assert.equal(stream.closed, true, `${responsePath} stream was not closed`);
      assert.deepEqual(listenerCounts(stream), {}, `${responsePath} stream retained listeners`);
    }
    assert.deepEqual(abortLoggerErrors, [delayedCloseError]);
  } finally {
    releaseEarlyStat();
    if (delayedDestroyCallback) delayedDestroyCallback();
    fs.promises.stat = originalStat;
    for (const stream of capturedReadStreams) stream.destroy();
    fs.createReadStream = originalCreateReadStream;
    await abortFixture.stop();
    await fs.promises.rm(abortRoot, { recursive: true, force: true });
  }

  const overlappingRootsFixture = createFixtureServer({
    port: 0,
    publicRoot: root,
    mediaRoot,
    logger: silentLogger,
  });
  try {
    const overlappingRootsStarted = await overlappingRootsFixture.start();
    const leakedFixture = await rawRequest(
      overlappingRootsStarted.port,
      "/test/dev-fixtures/media/compatible-h264.mp4",
    );
    assert.equal(leakedFixture.status, 404);
    assertNoPaths(leakedFixture);

    const fixtureDirectory = await rawRequest(
      overlappingRootsStarted.port,
      "/test/dev-fixtures/media",
    );
    assert.equal(fixtureDirectory.status, 404);
    assertNoPaths(fixtureDirectory);
  } finally {
    await overlappingRootsFixture.stop();
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
