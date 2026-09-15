// Short-lived HMAC download tokens (scoped, bound to slug + file) and the
// public-download safety list shared by the share endpoints.

import {
  SHARE_TOKEN_TTL,
  b64url,
  b64urlDecode,
  cleanText,
  timingSafeEqual,
} from "./util.js";
import { requireSecret } from "./auth.js";

const BLOCKED_PUBLIC_DOWNLOAD_EXTS = new Set([
  "7z",
  "ace",
  "apk",
  "app",
  "arj",
  "bat",
  "bin",
  "bz2",
  "cab",
  "cmd",
  "com",
  "cpl",
  "deb",
  "dmg",
  "dll",
  "docm",
  "dotm",
  "exe",
  "gz",
  "hta",
  "img",
  "ipa",
  "iso",
  "jar",
  "js",
  "jse",
  "lnk",
  "msi",
  "msp",
  "pkg",
  "pl",
  "pptm",
  "ps1",
  "psd1",
  "psm1",
  "py",
  "pyc",
  "rar",
  "reg",
  "rpm",
  "run",
  "scr",
  "sh",
  "tar",
  "tgz",
  "vbe",
  "vbs",
  "wsf",
  "wsh",
  "xlam",
  "xlsm",
  "xz",
  "zip",
]);

const BLOCKED_PUBLIC_DOWNLOAD_MIME = [
  /^application\/(x-)?(7z|gzip|java-archive|vnd\.rar|zip)/i,
  /^application\/(x-)?(bzip2|cab|compress|compressed|gtar|rar-compressed|tar)/i,
  /^application\/(x-)?(apple-diskimage|dosexec|executable|iso9660-image|mach-binary|msdownload|msi|ms-installer|msdos-program|sh)/i,
  /^application\/vnd\.(android\.package-archive|microsoft\.portable-executable)/i,
  /^application\/x-httpd-php/i,
  /^text\/x-(shellscript|perl|php|python|ruby)/i,
];

// Same fail-loud rule as auth.js: never sign with a guessable default.
async function shareSigningKey(env) {
  const secret = env.SHARE_SIGNING_KEY || `${requireSecret(env, "ADMIN_TOKEN")}:hd-share-v1`;
  const seed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

export async function signShareToken(env, scope, slug, fileId, ttlSec = SHARE_TOKEN_TTL) {
  return (await signShareTokenWithExpiry(env, scope, slug, fileId, ttlSec)).token;
}

export async function signShareTokenWithExpiry(env, scope, slug, fileId, ttlSec = SHARE_TOKEN_TTL) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const body = `${scope}.${slug}.${fileId}.${exp}`;
  const key = await shareSigningKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return {
    token: `${b64url(new TextEncoder().encode(body))}.${b64url(new Uint8Array(mac))}`,
    expiresAt: exp * 1000,
  };
}

export async function verifyShareToken(env, token, expectScope, options = {}) {
  const dot = String(token || "").indexOf(".");
  if (dot < 1) return null;
  let body;
  try {
    body = new TextDecoder().decode(b64urlDecode(token.slice(0, dot)));
  } catch {
    return null;
  }
  const key = await shareSigningKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  if (!timingSafeEqual(token.slice(dot + 1), b64url(new Uint8Array(mac)))) return null;
  const parts = body.split(".");
  if (parts.length !== 4) return null;
  const [scope, slug, fileId, exp] = parts;
  if (scope !== expectScope) return null;
  const expiresAt = Number(exp) * 1000;
  if (!options.allowExpired && expiresAt < Date.now()) return null;
  return { slug, fileId, expiresAt, expired: expiresAt < Date.now() };
}

export function downloadTokenFrom(value) {
  const raw = cleanText(value || "", 1200);
  if (!raw) return "";
  try {
    const url = new URL(raw, "https://share.local");
    const prefix = "/api/share/dl/";
    if (url.pathname.startsWith(prefix)) return url.pathname.slice(prefix.length);
  } catch {
    // Fall through to path parsing.
  }
  const marker = "/api/share/dl/";
  const i = raw.indexOf(marker);
  const token = i >= 0 ? raw.slice(i + marker.length) : raw;
  return token.split(/[?#]/)[0];
}

function fileExtension(name = "") {
  const clean = String(name || "")
    .split(/[?#]/)[0]
    .trim()
    .toLowerCase();
  const leaf = clean.split(/[\\/]/).pop() || "";
  const dot = leaf.lastIndexOf(".");
  return dot > 0 && dot < leaf.length - 1 ? leaf.slice(dot + 1) : "";
}

export function publicDownloadSafety(file = {}) {
  const name = cleanText(file.name || "", 240);
  const mime = cleanText(file.mimeType || file.mime || "", 140);
  const ext = fileExtension(name);
  if (BLOCKED_PUBLIC_DOWNLOAD_EXTS.has(ext)) {
    return {
      blocked: true,
      reason: "This public share blocks executable, script, installer, and archive downloads.",
    };
  }
  if (mime && BLOCKED_PUBLIC_DOWNLOAD_MIME.some((rx) => rx.test(mime))) {
    return {
      blocked: true,
      reason: "This public share blocks executable, script, installer, and archive downloads.",
    };
  }
  return { blocked: false, reason: "" };
}
