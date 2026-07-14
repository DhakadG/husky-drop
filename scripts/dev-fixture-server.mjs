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
const FIXTURE_CSP = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:";

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

function sendStatus(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function serveRequest(request, response, publicRoot) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendStatus(response, 404, "Not Found");
    return;
  }

  const decodedPath = decodeRequestPath(request.url);
  if (decodedPath == null) {
    sendStatus(response, 400, "Bad Request");
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

export function createFixtureServer({
  port = Number(process.env.PORT ?? 8788),
  publicRoot = DEFAULT_PUBLIC_ROOT,
  mediaRoot = DEFAULT_MEDIA_ROOT,
  logger = console,
} = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new TypeError("port must be an integer from 0 through 65535");
  }

  void mediaRoot;
  let server = null;
  let started = null;
  let starting = null;

  async function start() {
    if (started) return started;
    if (starting) return starting;

    starting = (async () => {
      await validatePublicRoot(publicRoot);

      const candidate = createServer((request, response) => {
        serveRequest(request, response, publicRoot).catch((error) => {
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
