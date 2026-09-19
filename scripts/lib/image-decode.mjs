// Shared "get pixels sharp can read" path for the image-archive runner
// (transcode-images.mjs) and the share preview runner
// (transcode-share-previews.mjs). One place for RAW/HEIC decoding and the
// fidelity rules from the media-cache spec §5.1: explicit sRGB out of
// libraw, ICC kept, metadata copied back with orientation always cleared.
// Needs on PATH: dcraw_emu (libraw-bin), heif-convert (libheif-examples),
// exiftool, darktable-cli (fallback for RAWs libraw refuses).

import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

export const run = promisify(execFile);
export const RAW_EXT = /\.(arw|srf|sr2|cr2|cr3|nef|nrw|dng|raf|orf|rw2|pef|3fr|iiq)$/i;
export const ext = (name) => (name.match(/\.([^.]+)$/)?.[1] || "").toLowerCase();
export const isRaw = (file) => RAW_EXT.test(file.name || "");
export const isHeic = (file) => /^hei[cf]$/.test(ext(file.name || "")) || /hei[cf]/.test(file.mime || "");

// RAW: libraw develop -> 16-bit TIFF in sRGB (-o 1: never inherit the tool's
// default colour space), falling back to the camera's embedded JPEG, then
// darktable for the HDR/linear DNGs libraw refuses. HEIC: libheif -> JPEG.
export async function decodable(input, file) {
  if (isRaw(file)) {
    const tiff = `${input}.tiff`;
    try {
      await run("dcraw_emu", ["-w", "-q", "3", "-o", "1", "-T", "-Z", tiff, input]);
      return { path: tiff, via: "libraw" };
    } catch {
      const jpg = `${input}.preview.jpg`;
      for (const tag of ["JpgFromRaw", "PreviewImage", "OtherImage"]) {
        try {
          const { stdout } = await run("exiftool", ["-b", `-${tag}`, input], { encoding: "buffer", maxBuffer: 256 * 1024 * 1024 });
          if (stdout.length > 50_000) {
            await pipeline(Readable.from(stdout), createWriteStream(jpg));
            return { path: jpg, via: "preview" };
          }
        } catch {}
      }
      const dt = `${input}.dt.jpg`;
      try {
        // darktable locks library.db per config dir, so parallel workers need their own.
        await run("darktable-cli", [input, dt, "--apply-custom-presets", "false", "--core", "--configdir", `${input}.dtcfg`, "--cachedir", `${input}.dtcache`, "--conf", "write_sidecar_files=never", "--conf", "plugins/imageio/format/jpeg/quality=95"], { timeout: 180_000 });
        return { path: dt, via: "darktable" };
      } catch (error) {
        const tail = `exit ${error.code ?? "?"}: ${String(error.stderr || error.stdout || "").trim().split("\n").slice(-3).join(" | ")}`.slice(0, 300);
        throw new Error(`unsupported RAW (libraw, embedded preview and darktable all failed): ${tail}`);
      }
    }
  }
  if (isHeic(file)) {
    const jpg = `${input}.heic.jpg`;
    await run("heif-convert", ["-q", "95", input, jpg]);
    return { path: jpg, via: "libheif" };
  }
  return { path: input, via: "direct" };
}

// Copy every tag from the original onto an output whose pixels are already
// upright (sharp .rotate()), and clear the orientation tag so it is not
// rotated a second time by whatever displays it. The only correct way to
// copy metadata back after a rotate - use this, never a bare -tagsfromfile.
export async function copyMetadataUpright(original, output, extraArgs = []) {
  await run("exiftool", ["-overwrite_original", "-q", "-tagsfromfile", original, "-all:all", "-orientation=", ...extraArgs, output]).catch(() => {});
}

// Gain-map HDR JPEGs (Apple Adaptive HDR, Google Ultra HDR) carry a second
// image sharp cannot preserve; recompressing one silently flattens it to
// SDR. Detect the markers in the first part of the file so callers can keep
// the original instead. Cheap: a bounded read, no parsing.
// (A bare MPF segment is not enough: ordinary cameras use MPF for previews.)
const GAIN_MAP_MARKERS = ["hdrgm:Version", "GContainer", "HDRGainMap", "urn:com:apple:photo:2020:aux:hdrgainmap"];
export async function hasGainMap(path, file = {}) {
  if (!/^image\/jpe?g$/i.test(file.mime || "") && !/\.jpe?g$/i.test(file.name || "")) return false;
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(length);
    await fh.read(buf, 0, length, 0);
    const text = buf.toString("latin1");
    return GAIN_MAP_MARKERS.some((marker) => text.includes(marker));
  } finally {
    await fh.close();
  }
}
