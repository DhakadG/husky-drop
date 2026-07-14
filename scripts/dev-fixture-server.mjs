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
const MEDIA_PATH_PREFIX = "/api/fixtures/media/";
const FIXTURE_CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:";

const MEDIA = new Map([
  ["landscape-image", { file: "landscape.png", type: "image/png" }],
  ["portrait-image", { file: "portrait.jpg", type: "image/jpeg" }],
  ["h264-video", { file: "compatible-h264.mp4", type: "video/mp4" }],
  ["webm-video", { file: "compatible-vp9.webm", type: "video/webm" }],
  ["unsupported-mov", { file: "unsupported.mov", type: "video/quicktime" }],
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

async function serveRequest(request, response, publicRoot, mediaRoot, logger) {
  const decodedPath = decodeRequestPath(request.url);
  if (decodedPath == null) {
    sendStatus(response, 400, "Bad Request");
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

  if (!stats.isFile() || !realPathIsInside(publicRoot, candidate)) {
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

      const candidate = createServer((request, response) => {
        serveRequest(request, response, publicRoot, mediaRoot, logger).catch((error) => {
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
