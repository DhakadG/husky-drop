#!/usr/bin/env node
import assert from "node:assert/strict";
import worker from "../src/index.js";

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

function makeEnv() {
  return {
    ADMIN_TOKEN: "test-admin",
    KV: new FakeKV(),
    ASSETS: {
      fetch: async () =>
        new Response("<!doctype html><html><body>ok</body></html>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    },
  };
}

function request(path, init = {}) {
  return new Request(`https://drop.test${path}`, init);
}

function jsonRequest(path, body, token = "test-admin") {
  return request(path, {
    method: "POST",
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
  assert.notEqual(stored.pinHash, await legacySha256("4821"), "PIN hash must not be raw SHA-256");

  res = await worker.fetch(request("/api/link/spiti"), env);
  assert.equal(res.status, 200);
  const publicLink = await res.json();
  assert.equal(publicLink.requiresPin, true);
  assert.equal("folderId" in publicLink, false, "public link metadata must not expose Drive folder IDs");

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
      settings: { concurrency: 4, chunkMB: 32, perUploaderFolders: true },
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
  assert.equal(res.status, 200, "progress fallback accepts valid no-PIN link");

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

  res = await worker.fetch(request("/api/admin/overview", { headers: { authorization: "Bearer test-admin" } }), env);
  assert.equal(res.status, 200, "admin overview is available");
  const overview = await res.json();
  assert.equal(overview.totals.links, 2);
  assert.equal(overview.totals.opens, 1);
  assert.equal(overview.totals.sessions, 1);
  assert.equal(overview.totals.files, 1);
  assert.equal(overview.totals.bytes, 200);

  res = await worker.fetch(request("/"), env);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy") || "", /connect-src[^;]*googleapis\.com/);
  assert.match(res.headers.get("permissions-policy") || "", /camera=\(\)/);

  console.log("smoke tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
