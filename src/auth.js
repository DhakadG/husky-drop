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

async function authSigningKey(env) {
  const secret = env.SHARE_SIGNING_KEY || `${env.ADMIN_TOKEN || "dev"}:hd-viewer-v1`;
  const seed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
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
  if (!tokenRes.ok) return null;
  const tokenData = await tokenRes.json();
  if (!tokenData.id_token) return null;

  const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(tokenData.id_token)}`);
  if (!infoRes.ok) return null;
  const info = await infoRes.json();
  if (info.aud !== env.GOOGLE_CLIENT_ID || !info.email) return null;
  return info;
}

export function authLogin(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID) return json({ error: "Google sign-in is not configured" }, 503);
  const slug = cleanText(url.searchParams.get("slug") || "", 60);
  const kind = url.searchParams.get("kind") === "drop" ? "drop" : "share";
  return signPayload(env, { slug, kind, exp: Math.floor(Date.now() / 1000) + STATE_TTL }).then((state) => {
    const p = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${url.origin}/api/auth/callback`,
      response_type: "code",
      scope: "openid email profile",
      prompt: "select_account",
      access_type: "online",
      state,
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`, 302);
  });
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

async function adminSessionKey(env) {
  const seed = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${env.ADMIN_TOKEN}:hd-admin-session-v1`));
  return crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
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

export function adminAuthLogin(request, env, url) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.ADMIN_EMAIL) {
    return json({ error: "Admin Google sign-in is not configured" }, 503);
  }
  return signPayload(env, { purpose: "admin", exp: Math.floor(Date.now() / 1000) + STATE_TTL }).then((state) => {
    const p = new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      redirect_uri: `${url.origin}/api/admin/auth/callback`,
      response_type: "code",
      scope: "openid email profile",
      prompt: "select_account",
      access_type: "online",
      state,
    });
    return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`, 302);
  });
}

export async function adminAuthCallback(request, env, url) {
  const stateToken = url.searchParams.get("state") || "";
  const code = url.searchParams.get("code") || "";
  const stateData = await verifyPayload(env, stateToken);
  if (!stateData || stateData.purpose !== "admin" || stateData.exp < Math.floor(Date.now() / 1000)) {
    return redirectAdminWithError(url, "sign-in expired, please try again");
  }
  if (!code) return redirectAdminWithError(url, "sign-in was cancelled");
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !env.ADMIN_EMAIL) {
    return redirectAdminWithError(url, "admin sign-in is not configured");
  }

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
