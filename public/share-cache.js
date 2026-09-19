// L0 of the media cache ladder: this device. Folder listings are kept in the
// browser Cache API so a reload (or a deep link opened again) paints from
// local data instead of re-listing Drive. Thumbnail and preview bytes take
// the plain HTTP cache route instead - their URLs are content-addressed and
// served `immutable` (see src/share-media.js), which needs no JS at all.
//
// Everything here is best-effort: private windows and insecure contexts can
// refuse the Cache API, and the gallery must work exactly the same without it.

const CACHE_NAME = "husky-media-v1";
const ORIGIN = "https://l0.husky.local";

async function open() {
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

const keyFor = (kind, id) => `${ORIGIN}/${kind}/${encodeURIComponent(id)}`;

// Stored JSON younger than maxAgeMs, else null.
export async function cachedJson(kind, id, maxAgeMs) {
  const cache = await open();
  if (!cache) return null;
  try {
    const hit = await cache.match(keyFor(kind, id));
    if (!hit) return null;
    const at = Number(hit.headers.get("x-cached-at")) || 0;
    if (Date.now() - at > maxAgeMs) return null;
    return { at, data: await hit.json() };
  } catch {
    return null;
  }
}

export async function rememberJson(kind, id, data) {
  const cache = await open();
  if (!cache) return;
  try {
    await cache.put(
      keyFor(kind, id),
      new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "x-cached-at": String(Date.now()) } }),
    );
  } catch {
    // Quota or a closed context: the in-memory copy still serves this session.
  }
}
