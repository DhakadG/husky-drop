// Shared constants, pure helpers, normalizers. No network, no KV.

export const APP_NAME = "LostHusky's DropBox";
export const MAX_DEFAULT_BYTES = 5 * 1024 ** 4; // 5 TB
export const MAX_EXPIRY_DAYS = 30;
export const LOCK_ATTEMPTS = 5;
export const LOCK_BASE_SECONDS = 60;
export const LOCK_MAX_SECONDS = 3600;
export const COMPLETION_FLUSH_MS = 4000;
export const RECENT_CAP = 200;
export const EVENT_CAP = 200;
export const SHARE_TOKEN_TTL = 15 * 60; // seconds a gallery download token lives
export const SHARE_ZIP_TICKET_TTL = 15 * 60; // seconds a server ZIP ticket lives
export const ADMIN_SESSION_TTL = 7 * 86400; // seconds an admin cookie session lives
export const QUOTA_RESERVE = 5 * 1024 ** 3; // keep 5 GB of Drive headroom
export const PBKDF2_ITERATIONS = 100000;

export const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self' https://static.cloudflareinsights.com https://*.clarity.ms",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "connect-src 'self' https://www.googleapis.com https://oauth2.googleapis.com https://api.resend.com https://cloudflareinsights.com https://*.clarity.ms",
    "img-src 'self' data: blob: https:",
    "frame-src https://www.youtube-nocookie.com https://player.vimeo.com",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; "),
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
  "x-content-type-options": "nosniff",
};

export const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export function json(obj, status = 200, extraHeaders = {}) {
  const headers = new Headers(JSON_HEADERS);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(obj), { status, headers });
}

export function retryJson(message, retryAfter) {
  return json({ error: message, retryAfter }, 429, { "retry-after": String(retryAfter) });
}

export function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function cleanText(value, max) {
  return String(value ?? "")
    .replace(/[\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function sanitizeFilename(value) {
  return cleanText(value, 200).replace(/[\\/:*?"<>|]/g, "_") || "upload.bin";
}

export function sanitizeFolderName(value) {
  return cleanText(value, 60).replace(/[\\/:*?"<>|]/g, "_") || "anonymous";
}

// Split an uploader-supplied relative path ("Trip/Day 1/IMG_001.jpg") into
// safe folder segments. Strips traversal parts and caps depth so a malicious
// client cannot spray thousands of nested Drive folders.
export function sanitizeRelPath(value, maxSegments = 12) {
  const raw = String(value || "").replace(/\\/g, "/");
  return raw
    .split("/")
    .map((s) => cleanText(s, 90))
    .filter((s) => s && s !== "." && s !== "..")
    .slice(0, maxSegments);
}

export function safeUrl(value) {
  const s = cleanText(value || "", 400);
  if (!s) return "";
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.toString() : "";
  } catch {
    return "";
  }
}

export function safeVideoUrl(value) {
  const s = safeUrl(value);
  if (!s) return "";
  const u = new URL(s);
  if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
    const id = u.hostname.includes("youtu.be") ? u.pathname.slice(1) : u.searchParams.get("v");
    return id ? `https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}` : "";
  }
  if (u.hostname.includes("vimeo.com")) {
    const id = u.pathname.split("/").filter(Boolean).pop();
    return id ? `https://player.vimeo.com/video/${encodeURIComponent(id)}` : "";
  }
  return "";
}

export function safeColor(value) {
  const s = cleanText(value || "", 20);
  return /^#[0-9a-fA-F]{6}$/.test(s) ? s : "";
}

export function driveQueryEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

export function fmtBytesServer(b) {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) {
    b /= 1024;
    i++;
  }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function dayKey(ts) {
  return new Date(ts).toISOString().slice(0, 10);
}

export function slugify(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

export function randomSlug(n = 8) {
  const abc = "abcdefghjkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => abc[b % abc.length]).join("");
}

export function randomHex(n = 16) {
  return [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function timingSafeEqual(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

export function b64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// PINs are hashed with PBKDF2-SHA256 (100k iterations). Legacy links hashed
// with salted (or unsalted) single SHA-256 still verify and are transparently
// re-hashed to PBKDF2 on the next successful entry (see gatePin in store.js).
export async function pinHashPbkdf2(pin, saltHex) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS }, key, 256);
  return [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makePinFields(pin) {
  const salt = randomHex();
  return { pinSalt: salt, pinHash: await pinHashPbkdf2(pin, salt), pinAlgo: "pbkdf2" };
}

export async function pinMatches(link, pin) {
  if (!link.pinHash) return true;
  let candidate;
  if (link.pinAlgo === "pbkdf2") {
    candidate = await pinHashPbkdf2(pin || "", link.pinSalt);
  } else if (link.pinSalt) {
    candidate = await sha256(`${link.pinSalt}:${String(pin || "")}`);
  } else {
    candidate = await sha256(String(pin || ""));
  }
  return timingSafeEqual(candidate, link.pinHash);
}

export function linkState(link) {
  if (!link) return "missing";
  if (link.disabled) return "paused";
  if (link.expiresAt && Date.now() > link.expiresAt) return "expired";
  return "active";
}

export function shareState(share) {
  if (!share) return "missing";
  if (share.disabled) return "paused";
  if (share.expiresAt && Date.now() > share.expiresAt) return "expired";
  return "active";
}

export function clientIp(request) {
  return request?.headers?.get("cf-connecting-ip") || request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || "0.0.0.0";
}

export function getCookie(request, name) {
  const raw = request.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return "";
}

export function extractClientInfo(request) {
  if (!request || !request.headers) return null;
  const ua = request.headers.get("user-agent") || "";
  let os = "Unknown";
  let icon = "monitor";
  if (/android/i.test(ua)) {
    os = "Android";
    icon = "smartphone";
  } else if (/iphone|ipad|ipod/i.test(ua)) {
    os = "iOS";
    icon = "smartphone";
  } else if (/mac os x/i.test(ua)) {
    os = "macOS";
    icon = "laptop";
  } else if (/windows/i.test(ua)) {
    os = "Windows";
    icon = "monitor";
  } else if (/linux/i.test(ua)) {
    os = "Linux";
    icon = "terminal";
  }

  const cf = request.cf || {};
  let loc = "";
  if (cf.city && cf.country) loc = `${cf.city}, ${cf.country}`;
  else if (cf.country) loc = cf.country;

  return { o: os, l: loc, i: icon };
}

export function normalizeEvent(event, request) {
  return {
    t: cleanText(event.type || "event", 32),
    at: Date.now(),
    s: cleanText(event.slug || "", 60),
    l: cleanText(event.label || "", 100),
    u: cleanText(event.uploader || "", 80),
    f: cleanText(event.file || "", 160),
    b: Number(event.bytes) || 0,
    n: clamp(Number(event.count) || 0, 0, 1000000),
    m: cleanText(event.message || "", 160),
    si: cleanText(event.sessionId || "", 80),
    c: extractClientInfo(request),
  };
}

export function normalizeSettings(input = {}) {
  // Fast defaults (4 parallel files, 32 MB chunks) apply whenever a link has no
  // explicit tuning. Admins can still pick any supported value in the editor.
  const concurrency = clamp(Number(input.concurrency) || 4, 1, 8);
  const chunkMB = [8, 16, 32, 64].includes(Number(input.chunkMB)) ? Number(input.chunkMB) : 32;
  const maxTransferBytes = clamp(Number(input.maxTransferBytes) || MAX_DEFAULT_BYTES, 1, MAX_DEFAULT_BYTES);
  return {
    concurrency,
    chunkMB,
    adaptiveConcurrency: !!input.adaptiveConcurrency,
    perUploaderFolders: !!input.perUploaderFolders,
    maxTransferBytes,
    // Budgets: 0 = unlimited. When a budget is crossed the link auto-pauses.
    maxTotalBytes: clamp(Number(input.maxTotalBytes) || 0, 0, MAX_DEFAULT_BYTES),
    maxTotalFiles: clamp(Number(input.maxTotalFiles) || 0, 0, 1000000),
    maxSessions: clamp(Number(input.maxSessions) || 0, 0, 100000),
  };
}

export function normalizeTheme(input = {}) {
  // Links saved before the blue UI refresh have the old orange/dark defaults
  // baked into KV; treat those exact values as "unset" so everything renders
  // with the current brand theme.
  let accent = safeColor(input.accentColor);
  if (!accent || accent.toLowerCase() === "#f2a33c") accent = "#2f6bff";
  let bg = safeColor(input.backgroundColor);
  if (!bg || bg.toLowerCase() === "#101418") bg = "#eaf0f9";
  return {
    logoUrl: safeUrl(input.logoUrl),
    backgroundUrl: safeUrl(input.backgroundUrl),
    backgroundColor: bg,
    accentColor: accent,
    welcome: cleanText(input.welcome || "Send the full-resolution photos and videos here.", 180),
    promoTitle: cleanText(input.promoTitle || "", 80),
    promoText: cleanText(input.promoText || "", 180),
    ctaLabel: cleanText(input.ctaLabel || "", 40),
    ctaUrl: safeUrl(input.ctaUrl),
    videoUrl: safeVideoUrl(input.videoUrl),
  };
}

export function normalizeNotify(input = {}) {
  return {
    enabled: !!input.enabled,
    start: input.start !== false,
    complete: !!input.complete,
  };
}

export function normalizeStats(stats = {}) {
  stats = stats || {};
  return {
    opens: Number(stats.opens) || 0,
    sessions: Number(stats.sessions) || 0,
    files: Number(stats.files) || 0,
    bytes: Number(stats.bytes) || 0,
  };
}

export function normalizeShareStats(stats = {}) {
  stats = stats || {};
  return {
    opens: Number(stats.opens) || 0,
    downloads: Number(stats.downloads) || 0,
    bytes: Number(stats.bytes) || 0,
    views: Number(stats.views) || 0,
    // email -> { n: display name, at: last-seen ms }. Capped in bumpShareStats.
    viewers: stats.viewers && typeof stats.viewers === "object" ? stats.viewers : {},
  };
}

export function normalizeLiveSession(input) {
  const files = Array.isArray(input.files)
    ? input.files.slice(0, 20).map((f) => ({
        name: cleanText(f.name || f.n || "file", 120),
        sent: Number(f.sent) || 0,
        size: Number(f.size || f.s) || 0,
        state: cleanText(f.state || f.st || "uploading", 20),
      }))
    : [];
  const total = Number(input.total) || files.reduce((t, f) => t + f.size, 0);
  const sent = Number(input.sent) || files.reduce((t, f) => t + f.sent, 0);
  const count = Number(input.count) || files.length;
  return {
    id: cleanText(input.sessionId || input.id || crypto.randomUUID(), 100),
    slug: cleanText(input.slug || "", 60),
    label: cleanText(input.label || "", 100),
    uploader: cleanText(input.uploader || "anonymous", 60),
    sent,
    total,
    pct: total ? Math.min(100, Math.floor((sent / total) * 100)) : 0,
    count,
    done: clamp(Number(input.done) || 0, 0, count || Number.MAX_SAFE_INTEGER),
    error: Math.max(0, Number(input.error) || 0),
    speed: Math.max(0, Number(input.speed) || 0),
    eta: 0,
    paused: !!input.paused,
    files,
    state: cleanText(input.state || "uploading", 20),
    lastSeen: Date.now(),
  };
}

export function normalizeUploadMeta(meta = {}) {
  return {
    n: cleanText(meta.n || "file", 160),
    s: Number(meta.s) || 0,
    m: cleanText(meta.m || "", 80),
    u: cleanText(meta.u || "anonymous", 60),
    f: cleanText(meta.f || "", 120),
    si: cleanText(meta.si || meta.sessionId || "", 80),
    at: Number(meta.at) || Date.now(),
  };
}

export function mergeRecent(existing, incoming) {
  const byId = new Map();
  for (const m of existing) byId.set(m.f || `${m.n}:${m.at}`, m);
  for (const m of incoming) byId.set(m.f || `${m.n}:${m.at}`, m);
  return [...byId.values()].sort((a, b) => b.at - a.at).slice(0, RECENT_CAP);
}
