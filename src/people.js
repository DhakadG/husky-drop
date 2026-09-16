// People: one profile per visitor, built from the activity log in the
// LiveTracker Durable Object.
//
// Identity resolution (strongest first): Google e-mail on the event → e-mail
// this device (hd_did cookie) has signed in with before → device id → the
// uploader name typed on a drop page. A device that later signs in with
// Google retroactively claims its anonymous history, which is what makes
// the social login worth having.

import { json, cleanText } from "./util.js";
import { liveStub } from "./store.js";

export const IDENTITY_SCHEMA = `CREATE TABLE IF NOT EXISTS identities (
  did TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  name TEXT,
  last_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS aliases (
  key TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  at INTEGER NOT NULL
)`;

const SHARE_TYPES = /^share/;
export const eventKind = (t) => (SHARE_TYPES.test(t) ? "share" : ["linknew", "linkedit", "linkdel", "sharenew", "shareedit", "sharedel", "lock", "global-lock"].includes(t) ? "admin" : "drop");

// Inside the DO: remember which device belongs to which e-mail.
export function rememberIdentity(sql, record) {
  const email = record?.d ? emailOf(record, new Map()) : "";
  if (!email) return;
  sql.exec("INSERT INTO identities (did, email, name, last_at) VALUES (?, ?, ?, ?) ON CONFLICT(did) DO UPDATE SET email = excluded.email, name = COALESCE(excluded.name, identities.name), last_at = excluded.last_at", record.d, email, record.u || null, Number(record.at) || Date.now());
}

// Device → account, plus aliases: manual merges from the admin and typed
// names that only one signed-in account has ever used (so "Pixel" typed on
// Daksh's phone means Daksh everywhere, even on a link without sign-in).
export function identityMap(sql) {
  const map = new Map();
  const aliases = new Map();
  try {
    const byName = new Map();
    for (const row of sql.exec("SELECT did, email, name FROM identities").toArray()) {
      map.set(row.did, { email: row.email, name: row.name });
      const n = String(row.name || "").trim().toLowerCase();
      if (n && !n.includes("@")) byName.set(n, (byName.get(n) || new Set()).add(row.email));
    }
    for (const [n, emails] of byName) if (emails.size === 1) aliases.set(`name:${n}`, [...emails][0]);
    for (const row of sql.exec("SELECT key, email FROM aliases").toArray()) aliases.set(row.key, row.email);
  } catch {}
  map.aliases = aliases;
  return map;
}
export function setAlias(sql, key, email) {
  if (!email) sql.exec("DELETE FROM aliases WHERE key = ?", key);
  else sql.exec("INSERT INTO aliases (key, email, at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET email = excluded.email, at = excluded.at", key, email.toLowerCase(), Date.now());
}

// Stable key for one person given an event and the device→email map.
// Older events carry the signed-in address only as the uploader name, so an
// e-mail-shaped name counts as the account too.
export const emailOf = (record, ids) => (record.e || (record.d && ids.get(record.d)?.email) || (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(record.u || "") ? record.u : "")).toLowerCase();
export function personKey(record, ids) {
  const email = emailOf(record, ids);
  if (email) return `email:${email}`;
  const raw = record.d ? `device:${record.d}` : record.u ? `name:${String(record.u).trim().toLowerCase()}` : "";
  const a = ids.aliases?.get(raw) || (record.d && record.u && ids.aliases?.get(`name:${String(record.u).trim().toLowerCase()}`));
  return a ? `email:${a}` : raw;
}

// Inside the DO: fold every event of the last `days` into profiles.
export function buildPeople(sql, days = 90) {
  const ids = identityMap(sql);
  const since = Date.now() - days * 86400e3;
  const rows = sql.exec("SELECT record_json FROM activity_events WHERE at >= ? ORDER BY at DESC", since).toArray();
  const people = new Map();
  for (const row of rows) {
    let r;
    try {
      r = JSON.parse(row.record_json);
    } catch {
      continue;
    }
    const key = personKey(r, ids);
    if (!key) continue;
    const p = people.get(key) || { key, emails: new Set(), names: new Set(), devices: new Map(), places: new Set(), first: r.at, last: r.at, events: 0, dropOpens: 0, uploads: 0, bytes: 0, shareOpens: 0, views: 0, downloads: 0, errors: 0, links: new Map(), shares: new Map() };
    people.set(key, p);
    const email = key.startsWith("email:") ? key.slice(6) : "";
    if (email) p.emails.add(email);
    if (r.u && !r.u.includes("@")) p.names.add(r.u);
    if (r.d) p.devices.set(r.d, r.c?.o || "device");
    if (r.c?.l) p.places.add(r.c.l);
    p.first = Math.min(p.first, r.at);
    p.last = Math.max(p.last, r.at);
    p.events += 1;
    const kind = eventKind(r.t);
    if (r.t === "open") p.dropOpens += 1;
    if (r.t === "share-open") p.shareOpens += 1;
    if (r.t === "share-view" || r.t === "share-browse") p.views += 1;
    if (r.t === "share-dl") p.downloads += 1;
    if (r.t === "file") {
      p.uploads += Number(r.n) || 1;
      p.bytes += Number(r.b) || 0;
    }
    if (r.t === "clienterror") p.errors += 1;
    if (r.s && kind !== "admin") {
      const bucket = kind === "share" ? p.shares : p.links;
      const entry = bucket.get(r.s) || { slug: r.s, label: r.l || r.s, events: 0, last: 0, files: 0, bytes: 0 };
      entry.events += 1;
      entry.last = Math.max(entry.last, r.at);
      if (r.t === "file") {
        entry.files += Number(r.n) || 1;
        entry.bytes += Number(r.b) || 0;
      }
      bucket.set(r.s, entry);
    }
  }
  const merged = new Map();
  for (const [key, email] of ids.aliases || []) merged.set(`email:${email}`, [...(merged.get(`email:${email}`) || []), key]);
  return [...people.values()]
    .map((p) => ({ ...p, aliases: merged.get(p.key) || [], emails: [...p.emails], names: [...p.names], devices: [...p.devices].map(([id, os]) => ({ id, os })), places: [...p.places], links: [...p.links.values()], shares: [...p.shares.values()] }))
    .sort((a, b) => b.last - a.last);
}

export function personEvents(sql, key, limit = 300) {
  const ids = identityMap(sql);
  const rows = sql.exec("SELECT record_json FROM activity_events ORDER BY at DESC LIMIT 20000").toArray();
  const out = [];
  for (const row of rows) {
    let r;
    try {
      r = JSON.parse(row.record_json);
    } catch {
      continue;
    }
    if (personKey(r, ids) === key) {
      out.push(r);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// ---- admin endpoints (worker side) ----
export async function adminPeople(env, url) {
  const days = Math.max(1, Math.min(365, Number(url.searchParams.get("days")) || 90));
  const r = await liveStub(env).fetch(`https://live.internal/people?days=${days}`);
  if (!r.ok) return json({ error: "people unavailable" }, 503);
  return json(await r.json());
}
export async function adminMerge(request, env) {
  const b = await request.json().catch(() => ({}));
  const key = cleanText(b.key || "", 200);
  const email = cleanText(b.email || "", 120).toLowerCase();
  if (!/^(device|name):/.test(key) || (email && !email.includes("@"))) return json({ error: "key must be device:/name:, email optional" }, 400);
  const r = await liveStub(env).fetch("https://live.internal/alias", { method: "POST", body: JSON.stringify({ key, email }) });
  return json(await r.json(), r.status);
}
export async function adminPerson(env, key) {
  const r = await liveStub(env).fetch(`https://live.internal/person?key=${encodeURIComponent(cleanText(key, 200))}`);
  if (!r.ok) return json({ error: "person unavailable" }, 503);
  return json(await r.json());
}
