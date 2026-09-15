// Google OAuth "viewer identity" for share links: a lightweight sign-in used
// only to attribute browsing/download activity on /s/ links to a real person
// (name + email), independent of the existing admin-token auth and the
// existing Google Drive service-account OAuth used by drive.js. Reuses the
// same GOOGLE_CLIENT_ID/SECRET already configured for Drive, so the only
// manual step is adding the callback URL as an authorized redirect URI in
// the Google Cloud Console for that OAuth client.
//
// This is a personal/private tool: the only scopes requested are the
// non-sensitive "openid email profile", which does not require Google's
// verification review, and viewer identity is used solely so the owner can
// see who viewed/downloaded what in their own admin dashboard.

import { ADMIN_SESSION_TTL, b64url, b64urlDecode, cleanText, getCookie, json, safeUrl, timingSafeEqual } from "./util.js";

const VIEWER_COOKIE = "hd_viewer";
const VIEWER_TTL = 30 * 86400; // seconds a signed-in viewer session lives
const STATE_TTL = 10 * 60; // seconds an OAuth state token is valid

// Every HMAC key derives from a deployment secret. A guessable fallback
// ("dev", "undefined") would let anyone who has read this file mint viewer
// and admin cookies, so a missing secret fails loud instead of degrading.
function requireSecret(env, name) {
  if (!env[name]) throw new Error(`${name} must be set - refusing to sign with a default key`);
  return env[name];
}

async function hmacKey(material) {
  const seed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(material));
  return crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

// Same derivation as before so existing viewer cookies keep verifying.
function authSigningKey(env) {
  return hmacKey(env.SHARE_SIGNING_KEY || `${requireSecret(env, "ADMIN_TOKEN")}:hd-viewer-v1`);
}

async function signPayload(env, obj) {
  const body = b64url(new TextEncoder().encode(JSON.stringify(obj)));
  const key = await authSigningKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64url(new Uint8Array(mac))}`;
}

async function verifyPayload(env, token) {
  const dot = String(token || "").indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const key = await authSigningKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  if (!timingSafeEqual(token.slice(dot + 1), b64url(new Uint8Array(mac)))) return null;
  try {
    return JSON.parse(new TextDecoder().decode(b64urlDecode(body)));
  } catch {
    return null;
  }
}

// ---- Login / callback ----

// Shared 2-step Google OAuth code exchange: authorization code -> id_token ->
// verified tokeninfo. Both the viewer flow (authCallback) and the admin flow
// (adminAuthCallback) need identical steps here, only what happens with the
// resulting email differs.
async function exchangeGoogleCode(env, code, redirectUri) {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  if (!tokenRes.ok) {
    console.error("google token exchange failed", tokenRes.status, (await tokenRes.text()).slice(0, 200));
    return null;
  }
  const tokenData = await tokenRes.json();
  if (!tokenData.id_token) return null;

  // ponytail: tokeninfo is rate-limited and meant for low volume; swap for
  // local JWKS verification if sign-ins ever exceed a handful a day.
  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`);
  if (!infoRes.ok) {
    console.error("google tokeninfo failed", infoRes.status, (await infoRes.text()).slice(0, 200));
    return null;
  }
  const info = await infoRes.json();
  // tokeninfo returns email_verified as the string "true"; the email is the
  // whole admin allow-list, so an unverified address is never trusted.
  if (info.aud !== env.GOOGLE_CLIENT_ID || !info.email || String(info.email_verified) !== "true") return null;
  return info;
}

function googleAuthRedirect(env, redirectUri, state) {
  const p = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    prompt: "select_account",
    access_type: "online",
    state,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`, 302);
}

export async function authLogin(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Google sign-in is not configured" }, 503);
  const slug = cleanText(url.searchParams.get("slug") || "", 60);
  const kind = url.searchParams.get("kind") === "drop" ? "drop" : "share";
  const state = await signPayload(env, { slug, kind, exp: Math.floor(Date.now() / 1000) + STATE_TTL });
  return googleAuthRedirect(env, `${url.origin}/api/auth/callback`, state);
}

export async function authCallback(request, env, url) {
  const stateToken = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const stateData = await verifyPayload(env, stateToken);
  if (!stateData || stateData.exp < Math.floor(Date.now() / 1000)) {
    return redirectWithError(url, "", "sign-in expired, please try again");
  }
  const slug = cleanText(stateData.slug || "", 60);
  const kind = stateData.kind === "drop" ? "drop" : "share";
  if (!code) return redirectWithError(url, slug, "sign-in was cancelled", kind);

  try {
    const info = await exchangeGoogleCode(env, code, `${url.origin}/api/auth/callback`);
    if (!info) return redirectWithError(url, slug, "Google sign-in failed", kind);

    const viewer = {
      e: cleanText(info.email, 160),
      n: cleanText(info.name || info.email.split("@")[0], 100),
      p: safeUrl(info.picture),
      exp: Date.now() + VIEWER_TTL * 1000,
    };
    const cookie = await signPayload(env, viewer);
    return new Response(null, {
      status: 302,
      headers: {
        location: slug ? `/${kind === "drop" ? "d" : "s"}/${encodeURIComponent(slug)}` : "/",
        "set-cookie": `${VIEWER_COOKIE}=${cookie}; Path=/; Max-Age=${VIEWER_TTL}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  } catch (err) {
    console.error("auth callback failed", err.message);
    return redirectWithError(url, slug, "sign-in failed, please try again", kind);
  }
}

function redirectWithError(url, slug, message, kind = "share") {
  const dest = slug ? `/${kind === "drop" ? "d" : "s"}/${encodeURIComponent(slug)}` : "/";
  const q = new URLSearchParams({ signinError: message });
  return Response.redirect(`${url.origin}${dest}?${q.toString()}`, 302);
}

export function authLogout() {
  return json(
    { ok: true },
    200,
    { "set-cookie": `${VIEWER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` }
  );
}

// ---- Admin session + Google OAuth ----

function adminSessionKey(env) {
  return hmacKey(`${requireSecret(env, "ADMIN_TOKEN")}:hd-admin-session-v1`);
}

function adminGoogleConfigured(env) {
  // ADMIN_TOKEN is the admin session signing secret, so Google-only admin
  // sign-in still depends on it.
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.ADMIN_EMAIL && env.ADMIN_TOKEN);
}

export async function mintAdminSession(env) {
  const exp = Math.floor(Date.now() / 1000) + ADMIN_SESSION_TTL;
  const key = await adminSessionKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(exp)));
  return `${exp}.${b64url(new Uint8Array(mac))}`;
}

export async function verifyAdminSession(env, value) {
  const dot = String(value || "").indexOf(".");
  if (dot < 1) return false;
  const exp = Number(value.slice(0, dot));
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  const key = await adminSessionKey(env);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(String(exp)));
  return timingSafeEqual(value.slice(dot + 1), b64url(new Uint8Array(mac)));
}

export async function adminAuthLogin(request, env, url) {
  if (!adminGoogleConfigured(env)) return json({ error: "Admin Google sign-in is not configured" }, 503);
  const state = await signPayload(env, { purpose: "admin", exp: Math.floor(Date.now() / 1000) + STATE_TTL });
  return googleAuthRedirect(env, `${url.origin}/api/admin/auth/callback`, state);
}

export async function adminAuthCallback(request, env, url) {
  const stateToken = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const stateData = await verifyPayload(env, stateToken);
  if (!stateData || stateData.purpose !== "admin" || stateData.exp < Math.floor(Date.now() / 1000)) {
    return redirectAdminWithError(url, "sign-in expired, please try again");
  }
  if (!code) return redirectAdminWithError(url, "sign-in was cancelled");
  if (!adminGoogleConfigured(env)) return redirectAdminWithError(url, "admin sign-in is not configured");

  try {
    const info = await exchangeGoogleCode(env, code, `${url.origin}/api/admin/auth/callback`);
    if (!info) return redirectAdminWithError(url, "Google sign-in failed");
    const email = cleanText(info.email || "", 160).toLowerCase();
    const allowed = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
    if (!email || email !== allowed) {
      return redirectAdminWithError(url, "unauthorized Google account");
    }

    const session = await mintAdminSession(env);
    return new Response(null, {
      status: 302,
      headers: {
        location: "/admin",
        "set-cookie": `hd_admin=${session}; Path=/; Max-Age=${ADMIN_SESSION_TTL}; HttpOnly; Secure; SameSite=Strict`,
      },
    });
  } catch (err) {
    console.error("admin auth callback failed", err.message);
    return redirectAdminWithError(url, "sign-in failed, please try again");
  }
}

function redirectAdminWithError(url, message) {
  const q = new URLSearchParams({ adminSigninError: message });
  return Response.redirect(`${url.origin}/admin?${q.toString()}`, 302);
}

// Resolves the signed-in viewer (if any) from the request cookie. Returns
// null when absent/expired/tampered rather than throwing, since viewer
// identity is optional context everywhere except on requireAuth shares.
export async function getViewer(request, env) {
  const cookie = getCookie(request, VIEWER_COOKIE);
  if (!cookie) return null;
  const data = await verifyPayload(env, cookie);
  if (!data || !data.e || !data.exp || data.exp < Date.now()) return null;
  return { email: data.e, name: data.n || data.e, picture: data.p || "" };
}
