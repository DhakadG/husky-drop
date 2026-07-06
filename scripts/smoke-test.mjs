#!/usr/bin/env node
import assert from "node:assert/strict";
import worker from "../src/worker.js";

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

function makeEnv(extra = {}) {
  return {
    ADMIN_TOKEN: "test-admin",
    KV: new FakeKV(),
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><html><body>ok</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
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

async function legacySha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function main() {
  const env = makeEnv();

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
      body: JSON.stringify({ linkId: "spiti", pin: "4821", filename: "x.bin", size: 0 }),
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
      settings: { concurrency: 4, chunkMB: 32, perUploaderFolders: true, maxTotalFiles: 2 },
      theme: { accentColor: "#ff8800", welcome: "Send everything here." },
    }),
    env
  );
  assert.equal(res.status, 200, "admin can create a no-PIN link with v2 settings");

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
      }),
    }),
    env
  );
  assert.equal(res.status, 200, "duplicate completion is accepted");

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
      body: JSON.stringify({ linkId: "inbox", filename: "a.jpg", size: 10 }),
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
      body: JSON.stringify({ linkId: "inbox", filename: "c.jpg", size: 10 }),
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

  res = await worker.fetch(request("/api/share/dl/garbage-token"), env);
  assert.equal(res.status, 403, "invalid download token rejected");

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

  // Security headers + beacon injection.
  res = await worker.fetch(request("/"), env);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy") || "", /connect-src[^;]*googleapis\.com/);
  assert.match(res.headers.get("content-security-policy") || "", /cloudflareinsights\.com/);
  assert.match(res.headers.get("permissions-policy") || "", /camera=\(\)/);
  let body = await res.text();
  assert.ok(!body.includes("cloudflareinsights"), "no beacon without a token");

  const beaconEnv = makeEnv({ CF_BEACON_TOKEN: "beacon-token-123" });
  res = await worker.fetch(request("/"), beaconEnv);
  body = await res.text();
  assert.ok(
    body.includes("static.cloudflareinsights.com/beacon.min.js") && body.includes("beacon-token-123"),
    "beacon script injected when CF_BEACON_TOKEN is set"
  );

  // Unauthorized admin access still blocked.
  res = await worker.fetch(request("/api/admin/overview"), env);
  assert.equal(res.status, 401, "no cookie/bearer = unauthorized");

  console.log("smoke tests passed (v2)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
