import assert from "node:assert/strict";

let exifTools;
try {
  exifTools = await import("../src/exif.js");
} catch (error) {
  assert.fail(`RAW EXIF helpers must exist and import cleanly: ${error.message}`);
}

const { mergeExifMetadata, shouldParseRawExif } = exifTools;

assert.equal(shouldParseRawExif({ name: "DSC00001.ARW", mimeType: "image/x-sony-arw" }), true);
assert.equal(shouldParseRawExif({ name: "photo.jpg", mimeType: "image/jpeg" }), false);

const merged = mergeExifMetadata(
  { cameraMake: "SONY", cameraModel: "ILCE-7M4" },
  {
    Make: "SONY",
    Model: "ILCE-7M4",
    LensModel: "24-70mm F2.8 DG DN II | Art 024",
    ExposureTime: 0.001,
    FNumber: 5,
    ISO: 250,
    FocalLength: 56.2,
    ExposureBiasValue: 0,
    ExposureProgram: "Manual",
    MeteringMode: "Multi-segment",
    WhiteBalance: "Auto",
    Flash: "No flash, compulsory",
    Software: "ILCE-7M4 v6.01",
    DateTimeOriginal: new Date("2026-06-06T08:13:46Z"),
    Copyright: "LostHusky",
  },
);

assert.equal(merged.lens, "24-70mm F2.8 DG DN II | Art 024");
assert.equal(merged.exposureTime, 0.001);
assert.equal(merged.aperture, 5);
assert.equal(merged.isoSpeed, 250);
assert.equal(merged.software, "ILCE-7M4 v6.01");
assert.equal(merged.copyright, "LostHusky");
assert.match(merged.time, /^2026-06-06/);

console.log("RAW EXIF helper tests passed");
