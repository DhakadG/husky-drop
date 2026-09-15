// Low-res video previews. Originals stay untouched; a GitHub Actions job
// (.github/workflows/transcode-previews.yml) pulls videos that have no
// preview yet, runs ffmpeg, and PUTs a 720p MP4 back here. The worker stores
// it in a private "_previews" folder under DRIVE_PARENT_ID (never inside a
// shared folder, so folder-level "anyone with link" grants never reach it)
// and keeps a fileId -> previewId map in KV.
//
// Share pages get `preview` next to `dl`: hover playback and the viewer's
// first play use it; the viewer's HD button switches to the original.

import { accessToken, driveCreateFolder, driveFindFolder, driveListFolder } from "./drive.js";
import { json, shareState } from "./util.js";
import { signShareTokenWithExpiry } from "./share-token.js";

const INDEX_KEY = "previews:index";
const FOLDER_KEY = "previews:folder";
const FOLDER_NAME = "_previews";
const PREVIEW_TTL = 4 * 3600;
const MAX_PREVIEW_BYTES = 90 * 1024 * 1024; // Workers request-body ceiling with margin

export async function previewIndex(env) {
  return (await env.KV.get(INDEX_KEY, "json")) || {};
}

// `preview` + `previewExpiresAt` for a listed file, or nothing.
export async function previewFields(env, slug, file, index) {
  const entry = index[file.id];
  if (!entry || !/^video\//.test(file.mimeType || "")) return {};
  const { token, expiresAt } = await signShareTokenWithExpiry(env, "dl", slug, entry.id, PREVIEW_TTL);
  return { preview: `/api/share/dl/${token}`, previewExpiresAt: expiresAt };
}

async function previewFolderId(env) {
  const cached = await env.KV.get(FOLDER_KEY);
  if (cached) return cached;
  const parent = env.DRIVE_PARENT_ID || undefined;
  const folder = (await driveFindFolder(env, FOLDER_NAME, parent)) || (await driveCreateFolder(env, FOLDER_NAME, parent));
  await env.KV.put(FOLDER_KEY, folder.id);
  return folder.id;
}

// Videos in active shares that have no preview yet. Walks each share's
// folders (depth 3) and stops at `limit`.
export async function listPendingPreviews(request, env) {
  const limit = Math.max(1, Math.min(100, Number(new URL(request.url).searchParams.get("limit")) || 20));
  const index = await previewIndex(env);
  const slugs = (await env.KV.get("shares:index", "json")) || [];
  const seen = new Set();
  const pending = [];
  const walk = async (folderId, depth) => {
    if (pending.length >= limit || depth > 3 || seen.has(folderId)) return;
    seen.add(folderId);
    let pageToken = "";
    do {
      const page = await driveListFolder(env, folderId, pageToken);
      for (const f of page.files || []) {
        if (pending.length >= limit) return;
        if (f.mimeType === "application/vnd.google-apps.folder") await walk(f.id, depth + 1);
        else if (/^video\//.test(f.mimeType || "") && !index[f.id] && !seen.has(f.id)) {
          seen.add(f.id);
          pending.push({ id: f.id, name: f.name, size: Number(f.size) || 0, mime: f.mimeType });
        }
      }
      pageToken = page.nextPageToken || "";
    } while (pageToken && pending.length < limit);
  };
  for (const slug of slugs) {
    const share = await env.KV.get(`share:${slug}`, "json");
    if (shareState(share) !== "active") continue;
    for (const id of share.folderIds || []) await walk(id, 0);
  }
  return json({ pending, indexed: Object.keys(index).length });
}

// Stream the original to the transcoder.
export async function previewSource(request, env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return json({ error: "bad file id" }, 400);
  const tok = await accessToken(env);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${id}?alt=media&supportsAllDrives=true`, {
    headers: { authorization: `Bearer ${tok}` },
    signal: request.signal,
  });
  if (!r.ok || !r.body) return json({ error: "Drive download failed" }, 502);
  return new Response(r.body, { headers: { "content-type": r.headers.get("content-type") || "application/octet-stream" } });
}

// Store one finished preview and record it in the index.
export async function putPreview(request, env, fileId) {
  const id = String(fileId || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return json({ error: "bad file id" }, 400);
  const declared = Number(request.headers.get("content-length")) || 0;
  if (declared > MAX_PREVIEW_BYTES) return json({ error: "preview too large" }, 413);
  const body = await request.arrayBuffer();
  if (!body.byteLength || body.byteLength > MAX_PREVIEW_BYTES) return json({ error: "preview empty or too large" }, 413);

  const tok = await accessToken(env);
  const meta = { name: `${id}.mp4`, parents: [await previewFolderId(env)], appProperties: { previewOf: id } };
  const boundary = `hd-${crypto.randomUUID()}`;
  const head = `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n--${boundary}\r\ncontent-type: video/mp4\r\n\r\n`;
  const tail = `\r\n--${boundary}--`;
  const payload = new Blob([head, body, tail]);
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,size&supportsAllDrives=true", {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": `multipart/related; boundary=${boundary}` },
    body: payload,
  });
  if (!r.ok) return json({ error: "Drive upload failed: " + (await r.text()).slice(0, 200) }, 502);
  const created = await r.json();

  const index = await previewIndex(env);
  index[id] = { id: created.id, size: Number(created.size) || body.byteLength, at: Date.now() };
  await env.KV.put(INDEX_KEY, JSON.stringify(index));
  return json({ ok: true, previewId: created.id, indexed: Object.keys(index).length }, 201);
}

// Rebuild the index from the _previews folder (recovery after a KV wipe).
export async function reindexPreviews(request, env) {
  const folderId = await previewFolderId(env);
  const tok = await accessToken(env);
  const index = {};
  let pageToken = "";
  do {
    const params = new URLSearchParams({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken,files(id,size,appProperties)",
      pageSize: "1000",
      supportsAllDrives: "true",
      includeItemsFromAllDrives: "true",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const r = await fetch("https://www.googleapis.com/drive/v3/files?" + params, { headers: { authorization: `Bearer ${tok}` } });
    if (!r.ok) return json({ error: "Drive list failed" }, 502);
    const page = await r.json();
    for (const f of page.files || []) {
      const of = f.appProperties?.previewOf;
      if (of) index[of] = { id: f.id, size: Number(f.size) || 0, at: Date.now() };
    }
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  await env.KV.put(INDEX_KEY, JSON.stringify(index));
  return json({ ok: true, indexed: Object.keys(index).length });
}
