#!/usr/bin/env node
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PUBLIC_ROOT = path.join(ROOT, "public");
const DEFAULT_MEDIA_ROOT = path.join(ROOT, "test", "dev-fixtures", "media");
const HOST = "127.0.0.1";
const SHARE_PATH = "/s/local-media";
const SHARE_API_PREFIX = "/api/share/";
const MEDIA_PATH_PREFIX = "/api/fixtures/media/";
const FIXTURE_AT = "2026-07-14T00:00:00.000Z";
const FAR_FUTURE = 4102444800000;
const MAX_JSON_BODY_BYTES = 64 * 1024;
const FIXTURE_CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:";

const MEDIA_DEFINITIONS = [
  {
    id: "landscape-image",
    file: "landscape.png",
    name: "Landscape fixture.png",
    type: "image/png",
    width: 480,
    height: 270,
    durationMs: 0,
    infoWidth: 480,
    infoHeight: 270,
    infoDurationMs: 0,
    thumbnailId: "landscape-image",
  },
  {
    id: "portrait-image",
    file: "portrait.jpg",
    name: "Portrait fixture.jpg",
    type: "image/jpeg",
    width: 270,
    height: 480,
    durationMs: 0,
    infoWidth: 270,
    infoHeight: 480,
    infoDurationMs: 0,
    thumbnailId: "portrait-image",
  },
  {
    id: "h264-video",
    file: "compatible-h264.mp4",
    name: "Compatible H264.mp4",
    type: "video/mp4",
    width: 320,
    height: 180,
    durationMs: 2000,
    infoWidth: 320,
    infoHeight: 180,
    infoDurationMs: 2000,
    thumbnailId: "landscape-image",
  },
  {
    id: "webm-video",
    file: "compatible-vp9.webm",
    name: "Compatible VP9.webm",
    type: "video/webm",
    width: 320,
    height: 180,
    durationMs: 2000,
    infoWidth: 320,
    infoHeight: 180,
    infoDurationMs: 2000,
    thumbnailId: "landscape-image",
  },
  {
    id: "unsupported-mov",
    file: "unsupported.mov",
    name: "Unsupported QuickTime.mov",
    type: "video/quicktime",
    width: 640,
    height: 360,
    durationMs: 1000,
    infoWidth: 0,
    infoHeight: 0,
    infoDurationMs: 0,
    thumbnailId: "landscape-image",
  },
];

const MEDIA = new Map(MEDIA_DEFINITIONS.map((media) => [media.id, media]));

const SHARE_META = {
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
};

const LANDSCAPE_EXIF = {
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

const SHARE_POST_PATHS = new Set([
  "/api/share/verify",
  "/api/share/redirect",
  "/api/share/list",
  "/api/share/summary",
  "/api/share/refresh-dl",
  "/api/share/file-info",
  "/api/share/zip-ticket",
  "/api/share/opened",
  "/api/share/track",
]);

const CONTENT_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".ico", "image/x-icon"],
]);

function decodeRequestPath(rawUrl) {
  const rawPath = String(rawUrl || "/").split("?", 1)[0];
  if (/%(?:00|2f|5c)/i.test(rawPath)) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.split(/[\\/]+/).includes("..")) return null;
  return decoded.replaceAll("\\", "/");
}

function resolveInside(root, requestPath) {
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, requestPath.replace(/^\/+/, ""));
  return candidate === absoluteRoot || candidate.startsWith(`${absoluteRoot}${path.sep}`)
    ? candidate
    : null;
}

function realPathIsInside(root, candidate) {
  const realRoot = fs.realpathSync.native(root);
  const realCandidate = fs.realpathSync.native(candidate);
  const relative = path.relative(realRoot, realCandidate);
  return relative === "" || (
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

function parseSingleRange(value, size) {
  if (!value) return null;
  if (typeof value !== "string" || value.includes(",")) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return false;

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(requestedEnd)) return false;
  if (start < 0 || start >= size || requestedEnd < start) return false;
  return { start, end: Math.min(requestedEnd, size - 1) };
}

function sendStatus(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendJson(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendNoContent(response) {
  response.writeHead(204, { "Content-Length": 0 });
  response.end();
}

function fixtureMediaPath(id) {
  return `${MEDIA_PATH_PREFIX}${id}`;
}

function fixtureThumbnails(id) {
  const url = fixtureMediaPath(id);
  return { base: url, mid: url, max: url };
}

function buildFixtureData(mediaRoot) {
  const records = MEDIA_DEFINITIONS.map((definition) => {
    const stats = fs.statSync(path.join(mediaRoot, definition.file));
    if (!stats.isFile()) {
      throw new Error(`fixture media must be a file: ${definition.file}`);
    }
    const dl = fixtureMediaPath(definition.id);
    const thumbs = fixtureThumbnails(definition.thumbnailId);
    return {
      ...definition,
      size: stats.size,
      dl,
      thumbs,
      listing: {
        id: definition.id,
        name: definition.name,
        size: stats.size,
        mime: definition.type,
        at: Date.parse(FIXTURE_AT),
        thumb: thumbs.base,
        thumbs,
        thumbsExpireAt: FAR_FUTURE,
        w: definition.width,
        h: definition.height,
        aspect: definition.width / definition.height,
        dur: definition.durationMs,
        dl,
        dlExpiresAt: FAR_FUTURE,
        downloadBlocked: false,
        downloadBlockReason: "",
      },
    };
  });
  return {
    records,
    byDownload: new Map(records.map((record) => [record.dl, record])),
    totalBytes: records.reduce((total, record) => total + record.size, 0),
  };
}

function readJsonBody(request) {
  const declaredLength = Number(request.headers["content-length"]);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BODY_BYTES) {
    request.resume();
    return Promise.resolve({ ok: false, status: 413, error: "request body too large" });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let size = 0;
    let chunks = [];

    request.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_JSON_BODY_BYTES) {
        settled = true;
        chunks = [];
        request.resume();
        resolve({ ok: false, status: 413, error: "request body too large" });
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (settled) return;
      settled = true;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        resolve({ ok: true, value });
      } catch {
        resolve({ ok: false, status: 400, error: "invalid JSON body" });
      }
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
  });
}

function sendShareNotFound(response) {
  sendJson(response, 404, { error: "fixture share not found" });
}

function hasFixtureSlug(body) {
  return body != null && typeof body === "object" && body.slug === SHARE_META.slug;
}

function sendRootListing(response, fixtureData) {
  sendJson(response, 200, {
    folders: [{
      index: 0,
      fid: "",
      name: "Local fixture media",
      files: fixtureData.records.map((record) => record.listing),
      subfolders: [{
        fid: "fixture-empty-folder",
        name: "Empty fixture folder",
        ls: "fixture-folder:empty",
      }],
      nextPageToken: "",
      loadedCount: fixtureData.records.length,
      hasMore: false,
    }],
    allowZip: false,
  });
}

function sendEmptyListing(response) {
  sendJson(response, 200, {
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
}

async function serveShareApiRequest(request, response, requestPath, fixtureData) {
  if (requestPath.startsWith("/api/share/meta/")) {
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method Not Allowed" });
      return;
    }
    if (requestPath.slice("/api/share/meta/".length) !== SHARE_META.slug) {
      sendShareNotFound(response);
      return;
    }
    sendJson(response, 200, SHARE_META);
    return;
  }

  if (!SHARE_POST_PATHS.has(requestPath)) {
    sendJson(response, 404, { error: "fixture API route not found" });
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  const parsed = await readJsonBody(request);
  if (!parsed.ok) {
    sendJson(response, parsed.status, { error: parsed.error });
    return;
  }
  const body = parsed.value;
  if (!hasFixtureSlug(body)) {
    sendShareNotFound(response);
    return;
  }

  switch (requestPath) {
    case "/api/share/verify":
      sendJson(response, 200, { ok: true });
      return;
    case "/api/share/redirect":
      sendJson(response, 400, { error: "not a redirect share" });
      return;
    case "/api/share/list":
      if (!body.folderToken) {
        sendRootListing(response, fixtureData);
      } else if (body.folderToken === "fixture-folder:empty") {
        sendEmptyListing(response);
      } else {
        sendJson(response, 404, { error: "fixture folder not found" });
      }
      return;
    case "/api/share/summary":
      if (!body.folderToken) {
        sendJson(response, 200, {
          files: fixtureData.records.length,
          folders: 1,
          bytes: fixtureData.totalBytes,
          images: fixtureData.records.filter((record) => record.type.startsWith("image/")).length,
          videos: fixtureData.records.filter((record) => record.type.startsWith("video/")).length,
          allowZip: false,
        });
      } else if (body.folderToken === "fixture-folder:empty") {
        sendJson(response, 200, {
          files: 0,
          folders: 0,
          bytes: 0,
          images: 0,
          videos: 0,
          allowZip: false,
        });
      } else {
        sendJson(response, 404, { error: "fixture folder not found" });
      }
      return;
    case "/api/share/refresh-dl": {
      const record = fixtureData.byDownload.get(body.dl);
      if (!record) {
        sendJson(response, 404, { error: "fixture file not found" });
        return;
      }
      sendJson(response, 200, {
        dl: record.dl,
        dlExpiresAt: FAR_FUTURE,
        thumbs: record.thumbs,
        thumbsExpireAt: FAR_FUTURE,
      });
      return;
    }
    case "/api/share/file-info": {
      const record = fixtureData.byDownload.get(body.dl);
      if (!record) {
        sendJson(response, 404, { error: "fixture file not found" });
        return;
      }
      const megapixels = record.infoWidth && record.infoHeight
        ? Math.round((record.infoWidth * record.infoHeight) / 10000) / 100
        : 0;
      sendJson(response, 200, {
        file: {
          id: record.id,
          name: record.name,
          mime: record.type,
          size: record.size,
          createdAt: FIXTURE_AT,
          modifiedAt: FIXTURE_AT,
          width: record.infoWidth,
          height: record.infoHeight,
          megapixels,
          durationMs: record.infoDurationMs,
        },
        exif: record.id === "landscape-image" ? LANDSCAPE_EXIF : {},
      });
      return;
    }
    case "/api/share/zip-ticket":
      sendJson(response, 501, {
        error: "ZIP downloads are not supported by the local fixture server.",
      });
      return;
    case "/api/share/opened":
    case "/api/share/track":
      sendNoContent(response);
      return;
    default:
      sendJson(response, 404, { error: "fixture API route not found" });
  }
}

async function serveMediaRequest(request, response, mediaRoot, requestPath, logger) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method Not Allowed" });
    return;
  }

  const id = requestPath.slice(MEDIA_PATH_PREFIX.length);
  const media = MEDIA.get(id);
  if (!media) {
    sendStatus(response, 404, "Not Found");
    return;
  }

  const file = resolveInside(mediaRoot, media.file);
  let stats;
  try {
    stats = file ? await fs.promises.stat(file) : null;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      sendStatus(response, 404, "Not Found");
      return;
    }
    throw error;
  }
  if (!file || !stats?.isFile() || !realPathIsInside(mediaRoot, file)) {
    sendStatus(response, 404, "Not Found");
    return;
  }

  const range = parseSingleRange(request.headers.range, stats.size);
  if (range === false) {
    response.writeHead(416, {
      "Accept-Ranges": "bytes",
      "Content-Range": `bytes */${stats.size}`,
      "Content-Length": 0,
    });
    response.end();
    return;
  }

  const start = range?.start ?? 0;
  const end = range?.end ?? stats.size - 1;
  const headers = {
    "Content-Type": media.type,
    "Content-Length": end - start + 1,
    "Accept-Ranges": "bytes",
  };
  if (range) {
    headers["Content-Range"] = `bytes ${start}-${end}/${stats.size}`;
  }
  const query = new URL(request.url || "/", `http://${HOST}`).searchParams;
  if (query.get("inline") === "1") {
    headers["X-Husky-Asset-Tier"] = "full";
    headers["X-Husky-Original-Bytes"] = stats.size;
  }

  response.writeHead(range ? 206 : 200, headers);
  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = fs.createReadStream(file, { start, end });
  stream.on("error", (error) => {
    logger.error?.(error);
    response.destroy();
  });
  stream.pipe(response);
}

async function serveRequest(request, response, publicRoot, mediaRoot, fixtureData, logger) {
  const decodedPath = decodeRequestPath(request.url);
  if (decodedPath == null) {
    sendStatus(response, 400, "Bad Request");
    return;
  }

  if (decodedPath.startsWith(SHARE_API_PREFIX)) {
    await serveShareApiRequest(request, response, decodedPath, fixtureData);
    return;
  }

  if (decodedPath.startsWith(MEDIA_PATH_PREFIX)) {
    await serveMediaRequest(request, response, mediaRoot, decodedPath, logger);
    return;
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    sendStatus(response, 404, "Not Found");
    return;
  }

  let requestPath = decodedPath;
  let isFixtureShare = false;
  if (decodedPath === "/") {
    requestPath = "/index.html";
  } else if (decodedPath === SHARE_PATH) {
    requestPath = "/share.html";
    isFixtureShare = true;
  } else if (decodedPath.startsWith("/s/")) {
    sendStatus(response, 404, "Not Found");
    return;
  }

  const candidate = resolveInside(publicRoot, requestPath);
  if (candidate == null) {
    sendStatus(response, 404, "Not Found");
    return;
  }

  let stats;
  try {
    stats = await fs.promises.stat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") {
      sendStatus(response, 404, "Not Found");
      return;
    }
    throw error;
  }

  const isFixtureMedia = realPathIsInside(mediaRoot, candidate);
  if (!stats.isFile() || !realPathIsInside(publicRoot, candidate) || isFixtureMedia) {
    sendStatus(response, 404, "Not Found");
    return;
  }

  const headers = {
    "Content-Type": CONTENT_TYPES.get(path.extname(candidate).toLowerCase()) || "application/octet-stream",
    "Content-Length": stats.size,
  };
  if (isFixtureShare) {
    headers["Content-Security-Policy"] = FIXTURE_CSP;
  }
  response.writeHead(200, headers);

  if (request.method === "HEAD") {
    response.end();
    return;
  }

  const stream = fs.createReadStream(candidate);
  stream.on("error", () => response.destroy());
  stream.pipe(response);
}

async function validatePublicRoot(publicRoot) {
  let stats;
  try {
    stats = await fs.promises.stat(publicRoot);
  } catch {
    throw new Error("public root must be an existing directory");
  }
  if (!stats.isDirectory()) {
    throw new Error("public root must be an existing directory");
  }
}

async function validateMediaRoot(mediaRoot) {
  let stats;
  try {
    stats = await fs.promises.stat(mediaRoot);
  } catch {
    throw new Error("media root must be an existing directory");
  }
  if (!stats.isDirectory()) {
    throw new Error("media root must be an existing directory");
  }
}

export function createFixtureServer({
  port = Number(process.env.PORT ?? 8788),
  publicRoot = DEFAULT_PUBLIC_ROOT,
  mediaRoot = DEFAULT_MEDIA_ROOT,
  logger = console,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("port must be an integer from 0 through 65535");
  }

  let server = null;
  let started = null;
  let starting = null;

  async function start() {
    if (started) return started;
    if (starting) return starting;

    starting = (async () => {
      await validatePublicRoot(publicRoot);
      await validateMediaRoot(mediaRoot);
      const fixtureData = buildFixtureData(mediaRoot);

      const candidate = createServer((request, response) => {
        serveRequest(request, response, publicRoot, mediaRoot, fixtureData, logger).catch((error) => {
          logger.error?.(error);
          if (response.headersSent) {
            response.destroy();
          } else {
            sendStatus(response, 500, "Internal Server Error");
          }
        });
      });
      server = candidate;

      await new Promise((resolve, reject) => {
        const onError = (error) => {
          candidate.off("listening", onListening);
          if (server === candidate) server = null;
          reject(error);
        };
        const onListening = () => {
          candidate.off("error", onError);
          resolve();
        };
        candidate.once("error", onError);
        candidate.once("listening", onListening);
        candidate.listen(port, HOST);
      });

      const address = candidate.address();
      const listeningPort = typeof address === "object" && address ? address.port : null;
      if (!Number.isInteger(listeningPort)) {
        throw new Error("fixture server did not expose a listening port");
      }
      const origin = `http://${HOST}:${listeningPort}`;
      started = {
        host: HOST,
        port: listeningPort,
        origin,
        shareUrl: `${origin}${SHARE_PATH}`,
      };
      return started;
    })();

    try {
      return await starting;
    } finally {
      starting = null;
    }
  }

  async function stop() {
    const active = server;
    if (!active) return;
    server = null;
    started = null;
    await new Promise((resolve, reject) => {
      active.close((error) => {
        if (!error || error.code === "ERR_SERVER_NOT_RUNNING") {
          resolve();
        } else {
          reject(error);
        }
      });
    });
  }

  return { start, stop };
}

async function runDirectly() {
  const fixture = createFixtureServer();
  const started = await fixture.start();
  console.log(`Husky Drop fixture share: ${started.shareUrl}`);

  let stopping = false;
  const stopAndExit = async () => {
    if (stopping) return;
    stopping = true;
    await fixture.stop();
    process.exit(0);
  };
  process.once("SIGINT", stopAndExit);
  process.once("SIGTERM", stopAndExit);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDirectly().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
