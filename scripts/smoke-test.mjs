#!/usr/bin/env node
import assert from "node:assert/strict";
import worker from "../src/worker.js";

// Background relays (ctx.waitUntil paths) swallow exceptions into
// console.error, so a missing import there never fails a request. Collect
// them and fail the run on anything that smells like a programming error.
const programmingErrors = [];
const originalConsoleError = console.error;
console.error = (...args) => {
  const text = args.map(String).join(" ");
  if (/is not defined|is not a function|ReferenceError|TypeError|Cannot read/.test(text)) programmingErrors.push(text);
  originalConsoleError(...args);
};

class FakeKV {
  constructor() {
    this.values = new Map();
    this.metadata = new Map();
  }

  async get(key, type) {
    const value = this.values.get(key);
    if (value == null) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(key, value, options = {}) {
    this.values.set(key, String(value));
    if (options.metadata) this.metadata.set(key, options.metadata);
  }

  async delete(key) {
    this.values.delete(key);
    this.metadata.delete(key);
  }

  async list({ prefix = "" } = {}) {
    const keys = [...this.values.keys()]
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => ({ name, metadata: this.metadata.get(name) }));
    return { keys, list_complete: true };
  }
}

class FakeCache {
  constructor() {
    this.values = new Map();
  }

  async match(request) {
    const response = this.values.get(typeof request === "string" ? request : request.url);
    return response?.clone() || undefined;
  }

  async put(request, response) {
    this.values.set(typeof request === "string" ? request : request.url, response.clone());
  }
}

function makeEnv(extra = {}) {
  const assets =
    extra.ASSETS || {
      fetch: async () =>
        new Response("<!doctype html><html><body>ok</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    };
  return {
    ADMIN_TOKEN: "test-admin",
    KV: new FakeKV(),
    ASSETS: assets,
    ...extra,
  };
}

function request(path, init = {}) {
  return new Request(`https://drop.test${path}`, init);
}

function jsonRequest(path, body, token = "test-admin", method = "POST") {
  return request(path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function publicJsonRequest(path, body, method = "POST") {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function withMockedGoogleDrive(fn) {
  const originalFetch = globalThis.fetch;
  const originalCaches = globalThis.caches;
  const calls = { listPageSizes: [], mediaRanges: [], thumbnailUrls: [], thumbnailAuth: [] };
  const files = {
    "drive-folder": {
      id: "drive-folder",
      name: "Drive Folder",
      mimeType: "application/vnd.google-apps.folder",
    },
    "file-img": {
      id: "file-img",
      name: "A Photo.jpg",
      size: "4",
      mimeType: "image/jpeg",
      thumbnailLink: "https://lh3.googleusercontent.com/fake=s220",
      imageMediaMetadata: { width: 4000, height: 3000, rotation: 0 },
      modifiedTime: "2026-07-01T00:00:00.000Z",
    },
    "file-video": {
      id: "file-video",
      name: "B Video.mp4",
      size: "6",
      mimeType: "video/mp4",
      thumbnailLink: "https://lh3.googleusercontent.com/video=s220",
      videoMediaMetadata: { width: 1920, height: 1080, durationMillis: "7000" },
      modifiedTime: "2026-07-02T00:00:00.000Z",
    },
    "file-mov": {
      id: "file-mov",
      name: "C No Thumb.mov",
      size: "5",
      mimeType: "video/quicktime",
      modifiedTime: "2026-07-03T00:00:00.000Z",
    },
    "file-exe": {
      id: "file-exe",
      name: "Setup.exe",
      size: "8",
      mimeType: "application/x-msdownload",
      modifiedTime: "2026-07-04T00:00:00.000Z",
    },
    "nested-folder": {
      id: "nested-folder",
      name: "Nested",
      mimeType: "application/vnd.google-apps.folder",
      parents: ["root"], // real Drive folders always carry a parent; only My Drive itself has none
    },
    "file-nested": {
      id: "file-nested",
      name: "D Nested.jpg",
      size: "11",
      mimeType: "image/jpeg",
      modifiedTime: "2026-07-05T00:00:00.000Z",
    },
  };
  const mediaBytes = {
    "file-img": new TextEncoder().encode("IMG!"),
    "file-video": new TextEncoder().encode("VIDEO!"),
    "file-mov": new TextEncoder().encode("MOV!!"),
    "file-exe": new TextEncoder().encode("EXE!!!!!"),
    "file-nested": new TextEncoder().encode("NESTED!!!!!"),
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    if (/^lh[3-6]\.googleusercontent\.com$/.test(url.hostname)) {
      calls.thumbnailUrls.push(url.href);
      const headers = new Headers(init.headers || {});
      calls.thumbnailAuth.push(headers.get("authorization") || "");
      return new Response(new TextEncoder().encode("THUMBNAIL"), {
        headers: { "content-type": "image/jpeg", "content-length": "9" },
      });
    }
    if (url.hostname === "oauth2.googleapis.com") {
      if (url.pathname === "/tokeninfo") {
        return new Response(
          JSON.stringify({
            aud: "google-client",
            email: "viewer@example.com",
            email_verified: "true",
            name: "Viewer Example",
            picture: "https://lh3.googleusercontent.com/a/pic",
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
      // Drive's own refresh-token exchange and the viewer sign-in's
      // authorization-code exchange both POST here; tell them apart by body.
      const bodyText = init.body ? String(init.body) : "";
      if (bodyText.includes("grant_type=authorization_code")) {
        return new Response(JSON.stringify({ access_token: "viewer-access-token", id_token: "fake-id-token" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access_token: "google-token", expires_in: 3600 }), {
        headers: { "content-type": "application/json" },
      });
    }
    if (url.hostname === "www.googleapis.com" && url.pathname.startsWith("/drive/v3/files")) {
      if ((init.method || "GET").toUpperCase() === "POST") {
        const body = JSON.parse(String(init.body || "{}"));
        return new Response(JSON.stringify({ id: "created-folder", name: body.name }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.searchParams.get("alt") === "media") {
        const id = decodeURIComponent(url.pathname.split("/").pop());
        const bytes = mediaBytes[id] || new Uint8Array();
        const requestHeaders = new Headers(init.headers || {});
        const range = requestHeaders.get("range") || "";
        calls.mediaRanges.push(range);
        if (range) {
          const match = range.match(/^bytes=(\d+)-(\d+)$/);
          if (!match || Number(match[1]) >= bytes.length) {
            return new Response(null, { status: 416, headers: { "content-range": `bytes */${bytes.length}` } });
          }
          const start = Number(match[1]);
          const end = Math.min(Number(match[2]), bytes.length - 1);
          return new Response(bytes.slice(start, end + 1), {
            status: 206,
            headers: {
              "content-type": files[id]?.mimeType || "application/octet-stream",
              "content-range": `bytes ${start}-${end}/${bytes.length}`,
              "content-length": String(end - start + 1),
              etag: `"drive-${id}"`,
              "last-modified": new Date(files[id]?.modifiedTime || 0).toUTCString(),
            },
          });
        }
        return new Response(bytes, {
          headers: {
            "content-type": files[id]?.mimeType || "application/octet-stream",
            "content-length": String(bytes.length),
            etag: `"drive-${id}"`,
            "last-modified": new Date(files[id]?.modifiedTime || 0).toUTCString(),
          },
        });
      }

      const id = decodeURIComponent(url.pathname.split("/").pop());
      if (id && id !== "files") {
        const file = files[id];
        return file
          ? new Response(JSON.stringify(file), { headers: { "content-type": "application/json" } })
          : new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      }

      calls.listPageSizes.push(url.searchParams.get("pageSize"));
      const pageToken = url.searchParams.get("pageToken") || "";
      const qParam = url.searchParams.get("q") || "";
      // A folder one level down from the share root, so the recursive
      // summary walk has something real to descend into.
      if (qParam.includes("'nested-folder' in parents")) {
        return new Response(JSON.stringify({ files: [files["file-nested"]] }), {
          headers: { "content-type": "application/json" },
        });
      }
      const body = pageToken === "page-2"
        ? { files: [files["file-mov"], files["file-exe"], files["nested-folder"]] }
        : { nextPageToken: "page-2", files: [files["file-img"], files["file-video"]] };
      return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  };
  globalThis.caches = { default: new FakeCache() };

  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalCaches === undefined) delete globalThis.caches;
    else globalThis.caches = originalCaches;
  }
}

async function legacySha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const env = makeEnv({ OWNER_DISPLAY_NAME: "Ghanishth" });

  const policyAssetRequests = [];
  const policyEnv = makeEnv({
    ASSETS: {
      fetch: async (req) => {
        policyAssetRequests.push(new URL(req.url).pathname);
        return new Response(`page:${new URL(req.url).pathname}`, {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    },
  });
  let policyRes = await worker.fetch(request("/privacy"), policyEnv);
  assert.equal(policyRes.status, 200, "privacy policy route serves a page");
  assert.equal(await policyRes.text(), "page:/privacy.html");
  policyRes = await worker.fetch(request("/terms"), policyEnv);
  assert.equal(policyRes.status, 200, "terms route serves a page");
  assert.equal(await policyRes.text(), "page:/terms.html");
  assert.deepEqual(policyAssetRequests, ["/privacy.html", "/terms.html"]);

  let res = await worker.fetch(
    jsonRequest("/api/admin/links", {
      label: "Spiti Trip",
      slug: "spiti",
      pin: "4821",
      expiresDays: 14,
      folderId: "folder-123",
    }),
    env
  );
  assert.equal(res.status, 200, "admin can create a folder-backed drop link");

  const stored = await env.KV.get("link:spiti", "json");
  assert.equal(stored.folderId, "folder-123");
  assert.ok(stored.pinSalt, "new PIN hashes must be salted");
  assert.equal(stored.pinAlgo, "pbkdf2", "new PINs use PBKDF2");
  assert.notEqual(stored.pinHash, await legacySha256("4821"), "PIN hash must not be raw SHA-256");

  res = await worker.fetch(request("/api/link/spiti"), env);
  assert.equal(res.status, 200);
  const publicLink = await res.json();
  assert.equal(publicLink.requiresPin, true);
  assert.equal("folderId" in publicLink, false, "public link metadata must not expose Drive folder IDs");
  assert.equal(publicLink.paused, false);
  assert.equal(publicLink.ownerName, "Ghanishth", "public link exposes the configured collector name");
  assert.equal(publicLink.budgetHit, false, "active links are not marked as budget-hit");

  await env.KV.put(
    "link:budget-hit",
    JSON.stringify({ ...stored, slug: "budget-hit", disabled: true, disabledReason: "byte budget reached" })
  );
  res = await worker.fetch(request("/api/link/budget-hit"), env);
  assert.equal(res.status, 200);
  const budgetPublicLink = await res.json();
  assert.equal(budgetPublicLink.paused, true);
  assert.equal(budgetPublicLink.budgetHit, true, "public metadata distinguishes budget auto-pause");

  res = await worker.fetch(
    request("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "spiti", pin: "0000" }),
    }),
    env
  );
  assert.equal(res.status, 403, "wrong PIN is rejected");

  res = await worker.fetch(
    request("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "spiti", pin: "4821" }),
    }),
    env
  );
  assert.equal(res.status, 200, "correct PIN is accepted");

  // Legacy salted-SHA256 PIN still verifies and upgrades to PBKDF2.
  const legacy = await env.KV.get("link:spiti", "json");
  legacy.pinAlgo = null;
  legacy.pinSalt = "abcd";
  legacy.pinHash = await legacySha256("abcd:4821");
  await env.KV.put("link:spiti", JSON.stringify(legacy));
  res = await worker.fetch(
    request("/api/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "spiti", pin: "4821" }),
    }),
    env
  );
  assert.equal(res.status, 200, "legacy salted PIN still verifies");
  const upgraded = await env.KV.get("link:spiti", "json");
  assert.equal(upgraded.pinAlgo, "pbkdf2", "legacy PIN was re-hashed to PBKDF2 on success");

  res = await worker.fetch(
    request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        linkId: "spiti",
        sessionId: "session-pin",
        pin: "0000",
        filename: "IMG_0001.MOV",
        size: 1024,
      }),
    }),
    env
  );
  assert.equal(res.status, 403, "session creation rejects wrong PIN before Google auth");

  res = await worker.fetch(
    request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "spiti", sessionId: "session-zero", pin: "4821", filename: "x.bin", size: 0 }),
    }),
    env
  );
  assert.equal(res.status, 400, "zero-byte files are refused");

  for (let i = 0; i < 5; i++) {
    res = await worker.fetch(
      request("/api/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ linkId: "spiti", pin: `bad-${i}` }),
      }),
      env
    );
  }
  assert.equal(res.status, 429, "fifth wrong PIN starts a lockout");
  assert.ok(Number(res.headers.get("retry-after")) > 0, "lockout includes Retry-After");

  res = await worker.fetch(
    jsonRequest("/api/admin/links", {
      label: "Inbox",
      slug: "inbox",
      expiresDays: 0,
      folderId: "folder-456",
      settings: { concurrency: 4, chunkMB: 32, adaptiveConcurrency: true, perUploaderFolders: true, maxTotalFiles: 2 },
      theme: { accentColor: "#ff8800", welcome: "Send everything here." },
      // Start/complete notifications on: the first progress tick renders the
      // start email even when Resend is unconfigured (regression: #18 dropped
      // the notifyEmail import and every /api/progress 500'd).
      notify: { enabled: true, start: true, complete: true },
    }),
    env
  );
  assert.equal(res.status, 200, "admin can create a no-PIN link with v2 settings");
  const adaptiveLink = await env.KV.get("link:inbox", "json");
  assert.equal(adaptiveLink.settings.adaptiveConcurrency, true, "smart parallelism is persisted on the link");
  res = await worker.fetch(request("/api/link/inbox"), env);
  assert.equal((await res.json()).settings.adaptiveConcurrency, true, "uploader receives smart parallelism mode");

  res = await worker.fetch(
    request("/api/opened", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "inbox" }),
    }),
    env
  );
  assert.equal(res.status, 200, "opened endpoint logs link opens");

  res = await worker.fetch(
    request("/api/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        linkId: "inbox",
        sessionId: "session-1",
        uploader: "Riya",
        sent: 100,
        total: 200,
        files: [{ n: "IMG.HEIC", s: 200, sent: 100, st: "uploading" }],
      }),
    }),
    env
  );
  assert.equal(res.status, 200, "progress endpoint works (request bug fixed)");

  res = await worker.fetch(
    request("/api/progress", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "inbox", uploader: "Riya", sent: 1, total: 2 }),
    }),
    env
  );
  assert.equal(res.status, 400, "progress without a sessionId is refused instead of minting a phantom session");

  res = await worker.fetch(
    request("/api/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        linkId: "inbox",
        filename: "IMG.HEIC",
        size: 200,
        mimeType: "image/heic",
        uploader: "Riya",
        fileId: "drive-file-1",
        sessionId: "session-1",
      }),
    }),
    env
  );
  assert.equal(res.status, 200, "complete endpoint logs upload metadata");

  // Re-sending the same completion (a retry / "sync") must not double-count.
  res = await worker.fetch(
    request("/api/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        linkId: "inbox",
        filename: "IMG.HEIC",
        size: 200,
        mimeType: "image/heic",
        uploader: "Riya",
        fileId: "drive-file-1",
        sessionId: "session-1",
      }),
    }),
    env
  );
  assert.equal(res.status, 200, "duplicate completion is accepted");

  // Admin can trash a delivered file: it leaves the history and the counters.
  // (Completions flush to KV on the Durable Object alarm; the test double
  // has no alarm, so seed the recent list directly.)
  await env.KV.put("recent:inbox", JSON.stringify([{ n: "IMG.HEIC", s: 200, m: "image/heic", u: "Riya", f: "drive-file-1", si: "session-1", at: Date.now() }]));
  await env.KV.put("stats:inbox", JSON.stringify({ opens: 1, sessions: 1, files: 1, bytes: 200 }));
  res = await worker.fetch(request("/api/admin/uploads/inbox/drive-file-1", { method: "DELETE", headers: { authorization: "Bearer test-admin" } }), env);
  assert.equal(res.status, 200, "admin can trash a delivered upload");
  assert.equal((await res.json()).removed, true);
  assert.equal(((await env.KV.get("recent:inbox", "json")) || []).length, 0, "trashed upload leaves the recent list");
  assert.equal((await env.KV.get("stats:inbox", "json")).files, 0, "trashed upload leaves the file counter");
  res = await worker.fetch(request("/api/admin/uploads/inbox/drive-file-1", { method: "DELETE" }), env);
  assert.equal(res.status, 401, "trashing requires admin");

  // Preview transcoder endpoints: admin only; an empty preview body is rejected before Drive is touched.
  res = await worker.fetch(request("/api/admin/previews/pending"), env);
  assert.equal(res.status, 401, "preview listing requires admin");
  res = await worker.fetch(request("/api/admin/previews/drive-file-1", { method: "PUT", headers: { authorization: "Bearer test-admin" }, body: "" }), env);
  assert.equal(res.status, 413, "empty preview body is rejected");
  // Put the delivered file back so the rest of the run sees the same totals.
  await env.KV.put("recent:inbox", JSON.stringify([{ n: "IMG.HEIC", s: 200, m: "image/heic", u: "Riya", f: "drive-file-1", si: "session-1", at: Date.now() }]));
  await env.KV.put("stats:inbox", JSON.stringify({ opens: 1, sessions: 1, files: 1, bytes: 200 }));

  // Client error reporting.
  res = await worker.fetch(
    request("/api/client-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "inbox", uploader: "Riya", name: "TypeError", message: "boom" }),
    }),
    env
  );
  assert.equal(res.status, 200, "client errors are accepted");

  // Events live in one rolling key, never one KV key per event.
  const evKeys = (await env.KV.list({ prefix: "ev:" })).keys;
  assert.equal(evKeys.length, 0, "no legacy per-event ev:* keys are written");
  const rolled = await env.KV.get("events:recent", "json");
  assert.ok(Array.isArray(rolled) && rolled.length >= 3, "events merged into events:recent");
  assert.ok(rolled.some((e) => e.t === "clienterror"), "client error appears in events");
  const completedEvent = rolled.find((e) => e.t === "file" && e.f === "IMG.HEIC");
  assert.equal(completedEvent?.si, "session-1", "completion event remains attached to its upload session");
  assert.equal(completedEvent?.n, 1, "completion event stores an explicit file count");
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(Array.isArray(await env.KV.get(`events:day:${today}`, "json")), "events are also stored in a day bucket");
  res = await worker.fetch(request(`/api/admin/events?before=${today}&days=1`, { headers: { authorization: "Bearer test-admin" } }), env);
  assert.equal(res.status, 200, "admin can page through older event-day buckets");
  const eventDays = await res.json();
  assert.equal(eventDays.days.length, 1);

  // Admin cookie login flow.
  res = await worker.fetch(
    request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    }),
    env
  );
  assert.equal(res.status, 403, "wrong admin token rejected");
  res = await worker.fetch(
    request("/api/admin/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "test-admin" }),
    }),
    env
  );
  assert.equal(res.status, 200, "admin login succeeds");
  const cookie = res.headers.get("set-cookie") || "";
  assert.match(cookie, /hd_admin=.+HttpOnly/, "login sets an HttpOnly session cookie");
  const cookieValue = cookie.split(";")[0];
  res = await worker.fetch(request("/api/admin/overview", { headers: { cookie: cookieValue } }), env);
  assert.equal(res.status, 200, "cookie session authorizes admin APIs");

  res = await worker.fetch(request("/api/admin/auth/login"), env);
  assert.equal(res.status, 503, "admin Google sign-in is unavailable until configured");

  res = await worker.fetch(request("/api/admin/overview", { headers: { authorization: "Bearer test-admin" } }), env);
  assert.equal(res.status, 200, "bearer token still works for scripts");
  const overview = await res.json();
  assert.equal(overview.totals.links, 2);
  assert.equal(overview.totals.opens, 1);
  assert.equal(overview.totals.sessions, 1);
  assert.equal(overview.totals.files, 1);
  assert.equal(overview.totals.bytes, 200);
  assert.ok(Array.isArray(overview.shares), "overview includes share links");

  // Pause / resume.
  res = await worker.fetch(jsonRequest("/api/admin/links/inbox", { disabled: true }, "test-admin", "PATCH"), env);
  assert.equal(res.status, 200);
  res = await worker.fetch(
    request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "inbox", sessionId: "session-paused", filename: "a.jpg", size: 10 }),
    }),
    env
  );
  assert.equal(res.status, 403, "paused link refuses upload sessions");
  res = await worker.fetch(jsonRequest("/api/admin/links/inbox", { disabled: false }, "test-admin", "PATCH"), env);
  assert.equal(res.status, 200, "link can be resumed");

  // Budget auto-pause: maxTotalFiles=2, already 1 file logged; log another,
  // then the next session must breach and pause the link.
  await worker.fetch(
    request("/api/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "inbox", filename: "b.jpg", size: 50, uploader: "Riya", fileId: "drive-file-2" }),
    }),
    env
  );
  res = await worker.fetch(
    request("/api/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ linkId: "inbox", sessionId: "session-budget", filename: "c.jpg", size: 10 }),
    }),
    env
  );
  assert.equal(res.status, 413, "file budget breach refuses the session");
  const pausedLink = await env.KV.get("link:inbox", "json");
  assert.equal(pausedLink.disabled, true, "budget breach auto-pauses the link");

  // Share links (no Google creds in tests: folder validation is skipped).
  res = await worker.fetch(
    jsonRequest("/api/admin/shares", {
      label: "Kareri Album",
      slug: "kareri-album",
      folders: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOp, 1QrStUvWxYz123456",
      mode: "gallery",
      pin: "7777",
      expiresDays: 7,
    }),
    env
  );
  assert.equal(res.status, 200, "share link created");
  const shareCreated = await res.json();
  assert.equal(shareCreated.url, "/s/kareri-album");
  const shareStored = await env.KV.get("share:kareri-album", "json");
  assert.deepEqual(shareStored.folderIds, ["1AbCdEfGhIjKlMnOp", "1QrStUvWxYz123456"], "folder URLs parsed to IDs");
  assert.equal(shareStored.pinAlgo, "pbkdf2");

  res = await worker.fetch(request("/api/share/meta/kareri-album"), env);
  assert.equal(res.status, 200);
  const shareMeta = await res.json();
  assert.equal(shareMeta.requiresPin, true);
  assert.equal(shareMeta.state, "active");
  assert.equal("folderIds" in shareMeta, false, "share meta must not expose folder IDs");

  res = await worker.fetch(
    request("/api/share/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "kareri-album", pin: "1111" }),
    }),
    env
  );
  assert.equal(res.status, 403, "wrong share PIN rejected");
  res = await worker.fetch(
    request("/api/share/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "kareri-album", pin: "7777" }),
    }),
    env
  );
  assert.equal(res.status, 200, "correct share PIN accepted");

  res = await worker.fetch(
    publicJsonRequest("/api/share/track", {
      slug: "kareri-album",
      sessionId: "share-session-1",
      events: [
        { t: "view", name: "IMG_001.jpg" },
        { t: "nav", name: "Day 1" },
        { t: "view", name: "IMG_002.jpg" },
        { t: "download", name: "IMG_002.jpg" },
      ],
    }),
    env
  );
  assert.equal(res.status, 200, "share tracking batch succeeds");
  const tracked = (await env.KV.get("events:recent", "json")).filter((e) => e.si === "share-session-1");
  assert.equal(tracked.length, 2, "share tracking collapses view/nav events but keeps download event");
  const browseRow = tracked.find((e) => e.t === "share-browse");
  assert.ok(browseRow, "share tracking writes one browse rollup row");
  assert.equal(browseRow.m, "viewed 2 file(s), browsed 1 folder(s)");
  assert.ok(tracked.some((e) => e.t === "share-dl"), "share tracking keeps high-value download event");

  res = await worker.fetch(request("/api/share/dl/garbage-token"), env);
  assert.equal(res.status, 403, "invalid download token rejected");

  await withMockedGoogleDrive(async (calls) => {
    const driveEnv = makeEnv({
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REFRESH_TOKEN: "google-refresh",
      ADMIN_EMAIL: "viewer@example.com",
    });

    res = await worker.fetch(request("/api/admin/auth/login"), driveEnv);
    assert.equal(res.status, 302, "configured admin Google sign-in redirects to Google");
    let authorizeUrl = new URL(res.headers.get("location"));
    assert.equal(authorizeUrl.hostname, "accounts.google.com");
    assert.equal(authorizeUrl.searchParams.get("redirect_uri"), "https://drop.test/api/admin/auth/callback");
    const adminState = authorizeUrl.searchParams.get("state");
    assert.ok(adminState, "admin auth redirect includes a signed state token");

    res = await worker.fetch(
      request(`/api/admin/auth/callback?code=fake-code&state=${encodeURIComponent(adminState)}`),
      driveEnv
    );
    assert.equal(res.status, 302, "allowed admin Google account returns to the dashboard");
    assert.equal(res.headers.get("location"), "/admin");
    const adminCookie = (res.headers.get("set-cookie") || "").split(";")[0];
    assert.match(adminCookie, /^hd_admin=/, "admin OAuth callback sets the admin cookie");
    res = await worker.fetch(request("/api/admin/overview", { headers: { cookie: adminCookie } }), driveEnv);
    assert.equal(res.status, 200, "admin OAuth cookie authorizes admin APIs");

    res = await worker.fetch(request("/api/admin/drive/folders?parent=nested-folder", { headers: { cookie: adminCookie } }), driveEnv);
    assert.equal(res.status, 200, "admin can browse a nested Drive folder");
    const folderBrowse = await res.json();
    assert.deepEqual(folderBrowse.breadcrumbs.map((crumb) => crumb.id), ["root", "nested-folder"], "Drive browser returns a usable breadcrumb chain");

    res = await worker.fetch(
      request("/api/admin/drive/folders", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ name: "Day 2", parentId: "nested-folder" }),
      }),
      driveEnv,
    );
    assert.equal(res.status, 201, "admin can create a child folder from the Drive browser");
    assert.deepEqual(await res.json(), { folder: { id: "created-folder", name: "Day 2" } });

    const wrongAdminEnv = makeEnv({
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_REFRESH_TOKEN: "google-refresh",
      ADMIN_EMAIL: "owner@example.com",
    });
    res = await worker.fetch(request("/api/admin/auth/login"), wrongAdminEnv);
    authorizeUrl = new URL(res.headers.get("location"));
    const wrongAdminState = authorizeUrl.searchParams.get("state");
    res = await worker.fetch(
      request(`/api/admin/auth/callback?code=fake-code&state=${encodeURIComponent(wrongAdminState)}`),
      wrongAdminEnv
    );
    assert.equal(res.status, 302, "wrong admin Google account is redirected back");
    assert.match(res.headers.get("location") || "", /adminSigninError=/);
    assert.equal(res.headers.get("set-cookie"), null, "wrong admin Google account does not receive an admin cookie");

    res = await worker.fetch(
      jsonRequest("/api/admin/shares", {
        label: "Drive Share",
        slug: "drive-share",
        folders: "drive-folder",
        mode: "gallery",
        pin: "2468",
        expiresDays: 7,
        requireAuth: false,
      }),
      driveEnv
    );
    assert.equal(res.status, 200, "Drive-backed share can be created under mocked Google API");

    res = await worker.fetch(
      publicJsonRequest("/api/share/list", { slug: "drive-share", pin: "2468" }),
      driveEnv
    );
    assert.equal(res.status, 200, "share list succeeds with Google Drive configured");
    const listed = await res.json();
    assert.equal(listed.folders[0].files.length, 2, "first Drive page is listed");
    assert.equal(listed.folders[0].loadedCount, 2, "list response reports loaded count");
    assert.equal(listed.folders[0].hasMore, true, "list response reports more pages");
    assert.ok(Number.isFinite(listed.folders[0].files[0].dlExpiresAt), "list response includes download expiry");
    const firstImage = listed.folders[0].files[0];
    const firstVideo = listed.folders[0].files.find((file) => file.name === "B Video.mp4");
    assert.deepEqual(Object.keys(firstImage.thumbs), ["base", "mid", "max"], "share list returns named thumbnail tiers");
    assert.match(firstImage.thumbs.base, /^\/api\/share\/thumb\/.+\/base$/, "base thumbnail is an app-owned signed route");
    assert.equal(firstImage.thumb, firstImage.thumbs.base, "legacy thumb field points at the Base tier");
    assert.equal(JSON.stringify(firstImage).includes("googleusercontent.com"), false, "listing does not expose Google's thumbnail URL");

    const thumbnailCallsBefore = calls.thumbnailUrls.length;
    res = await worker.fetch(request(firstImage.thumbs.base), driveEnv, { waitUntil: (promise) => promise });
    assert.equal(res.status, 200, "signed Base thumbnail route succeeds");
    assert.equal(res.headers.get("content-type"), "image/jpeg");
    assert.equal(res.headers.get("x-husky-asset-tier"), "base");
    assert.equal(await res.text(), "THUMBNAIL");
    assert.equal(calls.thumbnailUrls.at(-1).endsWith("=s512"), true, "Base tier requests the bounded Drive derivative");
    assert.equal(calls.thumbnailAuth.at(-1), "Bearer google-token", "thumbnail retrieval stays credentialed server-side");
    res = await worker.fetch(request(firstImage.thumbs.base), driveEnv, { waitUntil: (promise) => promise });
    assert.equal(res.status, 200, "cached Base thumbnail succeeds");
    assert.equal(calls.thumbnailUrls.length, thumbnailCallsBefore + 1, "second thumbnail request reuses cached bytes");

    const invalidTierUrl = firstImage.thumbs.base.replace(/\/base$/, "/huge");
    res = await worker.fetch(request(invalidTierUrl), driveEnv);
    assert.equal(res.status, 404, "unrecognized thumbnail tiers are rejected");
    const thumbParts = firstImage.thumbs.base.split("/");
    thumbParts[thumbParts.length - 2] = thumbParts.at(-2).replace(/.$/, thumbParts.at(-2).endsWith("A") ? "B" : "A");
    const tamperedThumb = thumbParts.join("/");
    res = await worker.fetch(request(tamperedThumb), driveEnv);
    assert.equal(res.status, 403, "tampered thumbnail capability is rejected");

    res = await worker.fetch(
      publicJsonRequest("/api/share/summary", { slug: "drive-share", pin: "2468" }),
      driveEnv
    );
    assert.equal(res.status, 200, "share summary endpoint succeeds");
    const summary = await res.json();
    // 4 files across both pages of the share root (img, video, mov, exe)
    // plus 1 more inside "nested-folder", which the summary must recurse
    // into rather than only counting the root level.
    assert.equal(summary.files, 5, "summary recurses into subfolders instead of stopping at the current level");
    assert.equal(summary.bytes, 34, "summary totals bytes across the whole tree, including subfolders");
    assert.equal(summary.images, 2, "summary counts images found inside subfolders too");
    assert.equal(summary.videos, 2, "summary counts videos");
    assert.equal(summary.folders, 1, "summary counts the subfolder it walked into");
    assert.ok(calls.listPageSizes.includes("1000"), "summary uses larger Drive page size");

    res = await worker.fetch(
      publicJsonRequest("/api/share/list", {
        slug: "drive-share",
        pin: "2468",
        folderIndex: 0,
        pageToken: listed.folders[0].nextPageToken,
      }),
      driveEnv
    );
    assert.equal(res.status, 200, "second Drive page is listed");
    const pageTwo = await res.json();
    const blockedExe = pageTwo.folders[0].files.find((f) => f.name === "Setup.exe");
    assert.equal(blockedExe.downloadBlocked, true, "risky executable is flagged in public share listings");
    res = await worker.fetch(request(blockedExe.dl), driveEnv);
    assert.equal(res.status, 451, "risky executable public download is blocked");

    const firstDl = listed.folders[0].files[0].dl;
    res = await worker.fetch(request(`${firstDl}?inline=1`), driveEnv, { waitUntil: (promise) => promise });
    assert.equal(res.status, 200, "inline full-resolution image succeeds");
    assert.equal(res.headers.get("x-husky-asset-tier"), "full", "inline media is explicitly identified as the original file");
    assert.equal(Number(res.headers.get("x-husky-original-bytes")), Number(firstImage.size), "inline media reports the original Drive byte size");
    const rangeCallsBefore = calls.mediaRanges.length;
    res = await worker.fetch(request(`${firstVideo.dl}?inline=1`, { headers: { range: "bytes=1-3" } }), driveEnv);
    assert.equal(res.status, 206, "cold inline video ranges stream immediately as partial responses");
    assert.equal(res.headers.get("content-range"), "bytes 1-3/6");
    assert.equal(res.headers.get("content-length"), "3");
    assert.equal(res.headers.get("accept-ranges"), "bytes");
    assert.equal(await res.text(), "IDE");
    assert.equal(calls.mediaRanges.at(-1), "bytes=1-3", "the exact browser range is forwarded to Drive even for small videos");
    assert.equal(calls.mediaRanges.length, rangeCallsBefore + 1, "a cold range performs one origin request without a whole-file cache fill");
    const validator = res.headers.get("etag");
    assert.ok(validator, "streaming media exposes a stable representation validator");

    res = await worker.fetch(request(`${firstVideo.dl}?inline=1`, { method: "HEAD" }), driveEnv);
    assert.equal(res.status, 200, "HEAD is supported on production media capabilities");
    assert.equal(res.headers.get("content-length"), "6");
    assert.equal(await res.text(), "");
    res = await worker.fetch(request(`${firstVideo.dl}?inline=1`, { method: "HEAD", headers: { range: "bytes=2-4" } }), driveEnv);
    assert.equal(res.status, 200, "HEAD ignores Range and reports the full representation without a media fetch");
    assert.equal(res.headers.get("content-range"), null);
    assert.equal(res.headers.get("content-length"), "6");

    res = await worker.fetch(request(`${firstVideo.dl}?inline=1`, { headers: { range: "bytes=99-120" } }), driveEnv);
    assert.equal(res.status, 416, "unsatisfiable ranges stay 416 instead of becoming a generic gateway error");
    assert.equal(res.headers.get("content-range"), "bytes */6");
    res = await worker.fetch(request(`${firstVideo.dl}?inline=1`, { headers: { range: "bytes=0-1,4-5" } }), driveEnv);
    assert.equal(res.status, 416, "multiple ranges are rejected consistently");
    assert.equal(res.headers.get("content-range"), "bytes */6");

    res = await worker.fetch(request(`${firstVideo.dl}?inline=1`, { headers: { "if-none-match": validator } }), driveEnv);
    assert.equal(res.status, 304, "matching validators avoid re-sending media bytes");
    res = await worker.fetch(request(`${firstVideo.dl}?inline=1`, { headers: { range: "bytes=1-3", "if-none-match": validator } }), driveEnv);
    assert.equal(res.status, 304, "matching validators are evaluated before Range");
    res = await worker.fetch(request(`${firstVideo.dl}?inline=1`, { headers: { range: "bytes=1-3", "if-range": '"stale"' } }), driveEnv);
    assert.equal(res.status, 200, "a stale If-Range falls back to the complete current representation");
    assert.equal(await res.text(), "VIDEO!");
    assert.equal(calls.mediaRanges.at(-1), "", "stale If-Range is not forwarded as a partial request");
    const originalNow = Date.now;
    Date.now = () => originalNow() + 16 * 60 * 1000;
    try {
      res = await worker.fetch(request(firstDl), driveEnv);
      assert.equal(res.status, 403, "expired share download token is rejected");
      res = await worker.fetch(
        publicJsonRequest("/api/share/refresh-dl", { slug: "drive-share", pin: "2468", dl: firstDl }),
        driveEnv
      );
      assert.equal(res.status, 200, "expired but signed download token can be refreshed after PIN validation");
      const refreshed = await res.json();
      assert.match(refreshed.dl, /^\/api\/share\/dl\//, "refresh returns a new download URL");
      assert.ok(refreshed.dlExpiresAt > Date.now(), "refresh returns the new expiry");
      assert.match(refreshed.thumbs.base, /^\/api\/share\/thumb\/.+\/base$/, "refresh renews thumbnail capabilities too");
      assert.ok(refreshed.thumbsExpireAt > Date.now(), "refresh returns the thumbnail expiry");
    } finally {
      Date.now = originalNow;
    }

    res = await worker.fetch(
      publicJsonRequest("/api/share/zip-ticket", {
        slug: "drive-share",
        pin: "2468",
        files: listed.folders[0].files.map((f) => ({ dl: f.dl, name: f.name, size: f.size, mime: f.mime })),
      }),
      driveEnv
    );
    assert.equal(res.status, 200, "zip ticket is created for selected signed files");
    const ticket = await res.json();
    assert.match(ticket.url, /^\/api\/share\/zip\//, "zip ticket returns a download URL");

    res = await worker.fetch(request(ticket.url), driveEnv);
    assert.equal(res.status, 200, "zip ticket streams an archive");
    assert.equal(res.headers.get("content-type"), "application/zip");
    assert.match(res.headers.get("content-disposition") || "", /Drive_Share\.zip/);
    const archive = new Uint8Array(await res.arrayBuffer());
    assert.equal(new TextDecoder().decode(archive.slice(0, 2)), "PK", "streamed zip starts with a ZIP header");

    res = await worker.fetch(
      publicJsonRequest("/api/share/zip-ticket", {
        slug: "drive-share",
        pin: "2468",
        files: [
          { dl: listed.folders[0].files[0].dl, name: listed.folders[0].files[0].name, size: listed.folders[0].files[0].size, mime: listed.folders[0].files[0].mime },
          { dl: blockedExe.dl, name: blockedExe.name, size: blockedExe.size, mime: blockedExe.mime },
        ],
      }),
      driveEnv
    );
    assert.equal(res.status, 200, "server zip ticket skips blocked source files when safe files remain");
    const mixedTicket = await res.json();
    assert.equal(mixedTicket.count, 1, "mixed zip ticket contains only safe files");
    assert.equal(mixedTicket.blocked.length, 1, "mixed zip ticket reports skipped blocked files");

    res = await worker.fetch(
      publicJsonRequest("/api/share/zip-ticket", {
        slug: "drive-share",
        pin: "2468",
        files: [{ dl: blockedExe.dl, name: blockedExe.name, size: blockedExe.size, mime: blockedExe.mime }],
      }),
      driveEnv
    );
    assert.equal(res.status, 451, "server zip ticket refuses all-blocked selections");

    const tampered = firstDl.replace(/.$/, firstDl.endsWith("A") ? "B" : "A");
    res = await worker.fetch(
      publicJsonRequest("/api/share/zip-ticket", {
        slug: "drive-share",
        pin: "2468",
        files: [{ dl: tampered, name: "bad.jpg", size: 1 }],
      }),
      driveEnv
    );
    assert.equal(res.status, 403, "tampered zip selection token is rejected");

    // Google sign-in gate: requireAuth defaults to true, blocks listing until
    // the guest completes the /api/auth/login -> /api/auth/callback round
    // trip, and only THEN succeeds once the resulting cookie is attached.
    res = await worker.fetch(
      jsonRequest("/api/admin/shares", {
        label: "Gated Share",
        slug: "gated-share",
        folders: "drive-folder",
        mode: "gallery",
        expiresDays: 7,
      }),
      driveEnv
    );
    assert.equal(res.status, 200, "Drive-backed share defaults to requireAuth: true");

    res = await worker.fetch(request("/api/share/meta/gated-share"), driveEnv);
    const gatedMeta = await res.json();
    assert.equal(gatedMeta.requiresAuth, true, "share meta reports requireAuth true by default");
    assert.equal(gatedMeta.viewer, null, "no viewer cookie yet");

    res = await worker.fetch(publicJsonRequest("/api/share/list", { slug: "gated-share" }), driveEnv);
    assert.equal(res.status, 401, "listing without a signed-in viewer is blocked");
    const gatedErr = await res.json();
    assert.equal(gatedErr.authRequired, true, "blocked response flags authRequired");

    res = await worker.fetch(request("/api/auth/login?slug=gated-share"), driveEnv);
    assert.equal(res.status, 302, "login redirects to Google");
    authorizeUrl = new URL(res.headers.get("location"));
    assert.equal(authorizeUrl.hostname, "accounts.google.com");
    assert.equal(authorizeUrl.searchParams.get("prompt"), "select_account", "share login always opens Google's account chooser");
    const state = authorizeUrl.searchParams.get("state");
    assert.ok(state, "login redirect includes a signed state token");

    res = await worker.fetch(
      request(`/api/auth/callback?code=fake-code&state=${encodeURIComponent(state)}`),
      driveEnv
    );
    assert.equal(res.status, 302, "callback redirects back to the share after sign-in");
    assert.equal(res.headers.get("location"), "/s/gated-share");
    const viewerCookie = (res.headers.get("set-cookie") || "").split(";")[0];
    assert.match(viewerCookie, /^hd_viewer=/, "callback sets the viewer cookie");

    res = await worker.fetch(jsonRequest("/api/admin/links", {
      label: "Authenticated Drop", slug: "authenticated-drop", folderId: "drive-folder", requireAuth: true,
    }), driveEnv);
    assert.equal(res.status, 200, "admin can require Google sign-in on a drop link");
    res = await worker.fetch(request("/api/link/authenticated-drop"), driveEnv);
    const dropMeta = await res.json();
    assert.equal(dropMeta.requiresAuth, true);
    assert.equal(dropMeta.viewer, null);
    res = await worker.fetch(publicJsonRequest("/api/session", { linkId: "authenticated-drop", sessionId: "session-auth", filename: "photo.jpg", size: 10 }), driveEnv);
    assert.equal(res.status, 401, "drop upload session cannot bypass required sign-in");
    res = await worker.fetch(request("/api/link/authenticated-drop", { headers: { cookie: viewerCookie } }), driveEnv);
    assert.equal((await res.json()).viewer?.email, "viewer@example.com", "drop meta resolves the signed-in viewer");
    res = await worker.fetch(request("/api/auth/login?kind=drop&slug=authenticated-drop"), driveEnv);
    const dropState = new URL(res.headers.get("location")).searchParams.get("state");
    res = await worker.fetch(request(`/api/auth/callback?code=fake-code&state=${encodeURIComponent(dropState)}`), driveEnv);
    assert.equal(res.headers.get("location"), "/d/authenticated-drop", "drop OAuth returns to the drop link");

    res = await worker.fetch(jsonRequest("/api/admin/shares/gated-share", {
      label: "Updated Gallery", folders: ["nested-folder"], mode: "gallery", allowZip: false,
      theme: { welcome: "Updated welcome", accentColor: "#15c0c9" },
    }, "test-admin", "PATCH"), driveEnv);
    assert.equal(res.status, 200, "all editable share settings can be updated together");
    const updatedShare = await res.json();
    assert.deepEqual(updatedShare.folderIds, ["nested-folder"]);
    assert.equal(updatedShare.theme.welcome, "Updated welcome");

    res = await worker.fetch(publicJsonRequest("/api/share/list", { slug: "gated-share" }), driveEnv);
    assert.equal(res.status, 401, "listing without the cookie attached is still blocked");

    res = await worker.fetch(request("/api/share/meta/gated-share", { headers: { cookie: viewerCookie } }), driveEnv);
    const signedInMeta = await res.json();
    assert.equal(signedInMeta.viewer?.email, "viewer@example.com", "meta reports the signed-in viewer once cookie is sent");

    const openCalls = [];
    let viewerSeen = false;
    driveEnv.LIVE_TRACKER = {
      idFromName: () => "global",
      get: () => ({
        fetch: async (input, init = {}) => {
          const path = new URL(typeof input === "string" ? input : input.url).pathname;
          const body = init.body ? JSON.parse(init.body) : null;
          openCalls.push({ path, body });
          if (path === "/share-stat") {
            const viewerPreviouslySeen = viewerSeen;
            if (body?.viewer?.email) viewerSeen = true;
            return Response.json({ ok: true, viewerPreviouslySeen });
          }
          return Response.json({ ok: true });
        },
      }),
    };
    const openedRequest = () => new Request("https://drop.test/api/share/opened", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: viewerCookie },
      body: JSON.stringify({ slug: "gated-share" }),
    });
    assert.equal((await worker.fetch(openedRequest(), driveEnv)).status, 200);
    assert.equal((await worker.fetch(openedRequest(), driveEnv)).status, 200);
    const openMessages = openCalls
      .filter(({ body }) => body?.record?.t === "share-open")
      .map(({ body }) => body.record.m);
    assert.deepEqual(openMessages, ["first open", ""], "Durable Object viewer state marks only the first identified share open");
    delete driveEnv.LIVE_TRACKER;

    res = await worker.fetch(
      new Request("https://drop.test/api/share/list", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: viewerCookie },
        body: JSON.stringify({ slug: "gated-share" }),
      }),
      driveEnv
    );
    assert.equal(res.status, 200, "listing succeeds once the viewer cookie is attached");

    res = await worker.fetch(
      jsonRequest("/api/admin/shares/gated-share", { requireAuth: false }, "test-admin", "PATCH"),
      driveEnv
    );
    assert.equal(res.status, 200, "admin can turn requireAuth off");
    res = await worker.fetch(publicJsonRequest("/api/share/list", { slug: "gated-share" }), driveEnv);
    assert.equal(res.status, 200, "listing succeeds without sign-in once requireAuth is off");
  });

  res = await worker.fetch(jsonRequest("/api/admin/shares/kareri-album", { disabled: true }, "test-admin", "PATCH"), env);
  assert.equal(res.status, 200);
  res = await worker.fetch(
    request("/api/share/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "kareri-album", pin: "7777" }),
    }),
    env
  );
  assert.equal(res.status, 403, "paused share refuses listing");
  res = await worker.fetch(jsonRequest("/api/admin/shares/kareri-album", {}, "test-admin", "DELETE"), env);
  assert.equal(res.status, 200, "share deleted");
  assert.equal(await env.KV.get("share:kareri-album"), null);

  const cleanupEnv = makeEnv();
  await cleanupEnv.KV.put("links:index", JSON.stringify(["expired-drop", "paused-drop", "missing-drop"]));
  await cleanupEnv.KV.put("link:expired-drop", JSON.stringify({ slug: "expired-drop", expiresAt: Date.now() - 1000 }));
  await cleanupEnv.KV.put("stats:expired-drop", "{}");
  await cleanupEnv.KV.put("link:paused-drop", JSON.stringify({ slug: "paused-drop", disabled: true, expiresAt: null }));
  await cleanupEnv.KV.put("shares:index", JSON.stringify(["expired-share", "missing-share"]));
  await cleanupEnv.KV.put("share:expired-share", JSON.stringify({ slug: "expired-share", mode: "gallery", expiresAt: Date.now() - 1000 }));
  res = await worker.fetch(jsonRequest("/api/admin/maintenance/cleanup", {}), cleanupEnv);
  assert.equal(res.status, 200, "admin can clean stale KV records");
  const cleanupReport = await res.json();
  assert.equal(cleanupReport.dropLinksRemoved, 1);
  assert.equal(cleanupReport.shareLinksRemoved, 1);
  assert.ok(await cleanupEnv.KV.get("link:paused-drop"), "paused links are retained by conservative cleanup");
  assert.equal(await cleanupEnv.KV.get("link:expired-drop"), null);

  const cappedCleanupEnv = makeEnv();
  await cappedCleanupEnv.KV.put("links:index", JSON.stringify(["expired-capped"]));
  await cappedCleanupEnv.KV.put("link:expired-capped", JSON.stringify({ slug: "expired-capped", expiresAt: Date.now() - 1000 }));
  const cappedPut = cappedCleanupEnv.KV.put.bind(cappedCleanupEnv.KV);
  cappedCleanupEnv.KV.put = async (key, ...args) => {
    if (key === "links:index") throw new Error("KV put() limit exceeded for the day.");
    return cappedPut(key, ...args);
  };
  res = await worker.fetch(jsonRequest("/api/admin/maintenance/cleanup", {}), cappedCleanupEnv);
  assert.equal(res.status, 200, "cleanup reports a saturated KV quota instead of returning 500");
  const cappedReport = await res.json();
  assert.equal(cappedReport.indexUpdatesDeferred, 1);
  assert.equal(await cappedCleanupEnv.KV.get("link:expired-capped"), null, "successful deletions are retained when index compaction is deferred");

  // Security headers + beacon injection.
  res = await worker.fetch(request("/"), env);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy") || "", /connect-src[^;]*googleapis\.com/);
  assert.match(res.headers.get("content-security-policy") || "", /img-src[^;]*blob:/, "progressive image object URLs must be allowed by CSP");
  assert.match(res.headers.get("content-security-policy") || "", /cloudflareinsights\.com/);
  assert.match(res.headers.get("content-security-policy") || "", /clarity\.ms/);
  assert.match(res.headers.get("permissions-policy") || "", /camera=\(\)/);
  let body = await res.text();
  assert.ok(!body.includes("cloudflareinsights"), "no beacon without a token");
  assert.ok(!body.includes("clarity.ms/tag"), "no Clarity script without a project id");

  const beaconEnv = makeEnv({ CF_BEACON_TOKEN: "beacon-token-123" });
  res = await worker.fetch(request("/"), beaconEnv);
  body = await res.text();
  assert.ok(
    body.includes("static.cloudflareinsights.com/beacon.min.js") && body.includes("beacon-token-123"),
    "beacon script injected when CF_BEACON_TOKEN is set"
  );

  const clarityEnv = makeEnv({ CLARITY_PROJECT_ID: "xjtpz5cm04" });
  res = await worker.fetch(request("/"), clarityEnv);
  body = await res.text();
  assert.ok(body.includes("https://www.clarity.ms/tag/") && body.includes("xjtpz5cm04"), "Clarity script injected when CLARITY_PROJECT_ID is set");

  // Unauthorized admin access still blocked.
  res = await worker.fetch(request("/api/admin/overview"), env);
  assert.equal(res.status, 401, "no cookie/bearer = unauthorized");

  assert.deepEqual(programmingErrors, [], "background relays raised programming errors");
  console.log("smoke tests passed (v2)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
