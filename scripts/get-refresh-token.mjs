#!/usr/bin/env node
/* One-time: mint a Google OAuth refresh token for husky-drop.
 *
 * Usage:
 *   node scripts/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>
 *
 * Opens a local server on http://localhost:8765, prints an auth URL —
 * open it IN THE BROWSER WHERE YOU'RE LOGGED INTO THE 5TB ACCOUNT,
 * approve, and the refresh token prints here.
 */
import http from "node:http";

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("usage: node scripts/get-refresh-token.mjs <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const REDIRECT = "http://localhost:8765/cb";
const SCOPE = "https://www.googleapis.com/auth/drive";

const authUrl =
  "https://accounts.google.com/o/oauth2/v2/auth?" +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    scope: SCOPE,
    access_type: "offline",
    prompt: "consent", // forces a refresh token even if previously granted
  });

http
  .createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost:8765");
    if (url.pathname !== "/cb") return res.end();
    const code = url.searchParams.get("code");
    if (!code) {
      res.end("No code in callback. Check the terminal.");
      return;
    }
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }),
    });
    const d = await r.json();
    if (d.refresh_token) {
      console.log("\n================ REFRESH TOKEN ================\n");
      console.log(d.refresh_token);
      console.log("\n===============================================");
      console.log('\nNow run:  wrangler secret put GOOGLE_REFRESH_TOKEN');
      res.end("Got it — refresh token printed in your terminal. You can close this tab.");
    } else {
      console.error("No refresh_token in response:", d);
      res.end("Something went wrong — check the terminal.");
    }
    setTimeout(() => process.exit(0), 200);
  })
  .listen(8765, () => {
    console.log("\n1. Open this URL in the browser logged into the 5TB Google account:\n");
    console.log(authUrl + "\n");
    console.log("2. Approve access. The refresh token will print here.\n");
  });
