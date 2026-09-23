# Review — `scripts/lib/image-decode.mjs`

_agent review (file) · 2026-09-23_

> One shared decode path for RAW and HEIC with sensible fallbacks (libraw, embedded preview, darktable; libheif, pillow-heif), metadata copied back with orientation cleared, and a bounded gain-map sniff. No defects found here; the archive runner not calling hasGainMap is filed under scripts/transcode-images.mjs.

No findings.
