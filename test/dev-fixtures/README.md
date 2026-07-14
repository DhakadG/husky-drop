# Development media fixtures

Every file in `media/` is synthetic, license-clear test data generated locally for Husky Drop development and automated checks. No fixture contains user, production, downloaded, or personal media.

## Generation

Run these exact commands from the repository root:

```powershell
ffmpeg -y -f lavfi -i "testsrc2=size=480x270:rate=1" -frames:v 1 test/dev-fixtures/media/landscape.png
ffmpeg -y -f lavfi -i "testsrc2=size=270x480:rate=1" -frames:v 1 -q:v 3 test/dev-fixtures/media/portrait.jpg
ffmpeg -y -f lavfi -i "testsrc2=size=320x180:rate=15:duration=2" -an -c:v libx264 -profile:v baseline -level:v 3.0 -preset veryfast -crf 30 -pix_fmt yuv420p -movflags +faststart test/dev-fixtures/media/compatible-h264.mp4
ffmpeg -y -f lavfi -i "testsrc2=size=320x180:rate=15:duration=2" -an -c:v libvpx-vp9 -b:v 0 -crf 40 -row-mt 1 -pix_fmt yuv420p test/dev-fixtures/media/compatible-vp9.webm
node --input-type=module -e "import { writeFileSync } from 'node:fs'; writeFileSync('test/dev-fixtures/media/unsupported.mov', Buffer.from('HUSKY_DROP_INVALID_QUICKTIME\n'))"
```

FFmpeg is preparation tooling only and is not required at runtime.

## Inventory

| File | Purpose | MIME | Dimensions / duration | Bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| `landscape.png` | Landscape still-image fixture | `image/png` | 480 x 270 | 16193 | `42945fb8e062ad2c0760949654e5924b1dff24bbc080f2394ed8d5f4927049d4` |
| `portrait.jpg` | Portrait still-image fixture | `image/jpeg` | 270 x 480 | 17188 | `e56047c0d33e620ccdcd16ada42d4a12d62d36e77bee480b4903c21d4ce3f0d8` |
| `compatible-h264.mp4` | Browser-compatible H.264 video fixture | `video/mp4` | 320 x 180 / 2 seconds | 28648 | `12185b2fbbc4632f3ed3b56935f5a3d2149ff0553902302b451f93e5aa7c80f9` |
| `compatible-vp9.webm` | Browser-compatible VP9 video fixture | `video/webm` | 320 x 180 / 2 seconds | 27118 | `e12b2519a3b5cf80f2aa2401a932e315037e5d9a9560738c7701510eeeaf23ef` |
| `unsupported.mov` | Unsupported-media failure fixture | `video/quicktime` | Intentionally invalid | 29 | `62106d5196bafeaa22a3307525ef7b9536a666b1298e500f4951dc9c970f2103` |

`unsupported.mov` is intentionally invalid and must never be replaced with personal media.
