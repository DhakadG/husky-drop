// Nightly identity stitching. Unsigned visits (session/device/fingerprint
// profiles) are compared against known Google accounts by Claude using the
// device details we hold - OS, browser, screen, timezone, language, places,
// links opened, times - and the result lands as *suggestions* the admin
// accepts or dismisses on the People tab. Nothing merges on its own.

import { json, cleanText } from "./util.js";
import { liveStub } from "./store.js";
import { appLog } from "./applog.js";

export const SUGGESTION_SCHEMA = `CREATE TABLE IF NOT EXISTS suggestions (
  key TEXT PRIMARY KEY, email TEXT NOT NULL, confidence REAL NOT NULL, reason TEXT, at INTEGER NOT NULL
)`;
export const suggestionRows = (sql) => sql.exec("SELECT * FROM suggestions ORDER BY confidence DESC").toArray();
export function replaceSuggestions(sql, rows) {
  sql.exec("DELETE FROM suggestions");
  for (const r of rows) sql.exec("INSERT INTO suggestions (key, email, confidence, reason, at) VALUES (?, ?, ?, ?, ?)", r.key, r.email, r.confidence, r.reason, Date.now());
}
export const dropSuggestion = (sql, key) => sql.exec("DELETE FROM suggestions WHERE key = ?", key);

// ponytail: Gemini free tier first (GEMINI_API_KEY), Anthropic if that is
// what is configured. Same prompt, both return JSON text.
async function askModel(env, prompt) {
  if (env.GEMINI_API_KEY) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${env.GEMINI_MODEL || "gemini-3.6-flash"}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": env.GEMINI_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: "application/json", maxOutputTokens: 4000 } }),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, d, text: (d.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""), usage: `${d.usageMetadata?.promptTokenCount || 0} in / ${d.usageMetadata?.candidatesTokenCount || 0} out (gemini)` };
  }
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-5", max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, d, text: (d.content || []).map((c) => c.text || "").join(""), usage: `${d.usage?.input_tokens || 0} in / ${d.usage?.output_tokens || 0} out (claude)` };
}
const brief = (p, sessions) => ({
  key: p.key,
  names: p.names,
  places: p.places,
  devices: sessions.filter((s) => s.email === p.emails?.[0] || p.devices.some((d) => d.id === s.did || d.id === s.fp) || s.key === p.key.replace(/^(device|fp|session):/, "")).map((s) => ({ os: s.os, ...s.meta, loc: s.loc, visits: s.visits })),
  links: p.links.map((l) => l.slug),
  shares: p.shares.map((s) => s.slug),
  first: new Date(p.first).toISOString(),
  last: new Date(p.last).toISOString(),
  uploads: p.uploads,
});

export async function runIdentityStitch(env, ctx, { force = false } = {}) {
  if (!env.GEMINI_API_KEY && !env.ANTHROPIC_API_KEY) {
    appLog(env, ctx, { area: "people", message: "identity stitch skipped: set GEMINI_API_KEY (free) or ANTHROPIC_API_KEY" });
    return { skipped: "no key" };
  }
  const live = liveStub(env);
  const [{ people = [] }, { sessions = [] }] = await Promise.all([live.fetch("https://live.internal/people?days=90").then((r) => r.json()), live.fetch("https://live.internal/sessions?limit=500").then((r) => r.json())]);
  const known = people.filter((p) => p.emails.length).map((p) => ({ email: p.emails[0], ...brief(p, sessions) }));
  const unknown = people.filter((p) => !p.emails.length).map((p) => brief(p, sessions));
  if (!known.length || !unknown.length) return { suggestions: 0 };
  if (!force && unknown.length > 300) unknown.length = 300;
  const prompt = `You match anonymous website visits to known Google accounts for a private photo-drop site. Be conservative: only suggest a match when device details (OS, browser, screen, timezone, language), places and behaviour (same links/shares, overlapping times, typed names similar to the account's names) make it likely. Output JSON only: {"suggestions":[{"key":"<unknown key>","email":"<known email>","confidence":0.0-1.0,"reason":"<one short sentence>"}]}. Omit anything under 0.5 confidence.\n\nKNOWN ACCOUNTS:\n${JSON.stringify(known)}\n\nUNKNOWN VISITS:\n${JSON.stringify(unknown)}`;
  let r = await askModel(env, prompt);
  // Gemini free tier throws 503 "high demand" in bursts; one retry after 20 s
  // clears most of them without an error in the log.
  if (r.status === 503 || r.status === 429) {
    await new Promise((res) => setTimeout(res, 20_000));
    r = await askModel(env, prompt);
  }
  if (!r.ok) {
    appLog(env, ctx, { level: "error", area: "people", message: `identity stitch failed: ${r.status}`, detail: r.d });
    return { error: r.status };
  }
  const text = r.text;
  let parsed = { suggestions: [] };
  try {
    parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  } catch {}
  const knownEmails = new Set(known.map((k) => k.email));
  const unknownKeys = new Set(unknown.map((u) => u.key));
  const rows = (parsed.suggestions || [])
    .filter((s) => unknownKeys.has(s.key) && knownEmails.has(String(s.email || "").toLowerCase()) && Number(s.confidence) >= 0.5)
    .map((s) => ({ key: s.key, email: String(s.email).toLowerCase(), confidence: Math.min(1, Number(s.confidence)), reason: cleanText(s.reason || "", 200) }));
  await live.fetch("https://live.internal/suggestions", { method: "POST", body: JSON.stringify({ rows }) });
  appLog(env, ctx, { area: "people", message: `identity stitch: ${rows.length} suggestion${rows.length === 1 ? "" : "s"} from ${unknown.length} unknown vs ${known.length} accounts (${r.usage} tokens)` });
  return { suggestions: rows.length };
}

// ---- admin ----
export async function adminSuggestions(request, env, ctx) {
  const live = liveStub(env);
  if (request.method === "POST") return json(await runIdentityStitch(env, ctx, { force: true }));
  if (request.method === "DELETE") {
    const b = await request.json().catch(() => ({}));
    await live.fetch("https://live.internal/suggestions", { method: "DELETE", body: JSON.stringify({ key: cleanText(b.key || "", 200) }) });
    return json({ ok: true });
  }
  const r = await live.fetch("https://live.internal/suggestions");
  return json(await r.json().catch(() => ({ suggestions: [] })), r.status);
}
