import exifr from "exifr";

const RAW_EXTENSIONS = /\.(?:arw|cr2|cr3|dng|nef|nrw|orf|raf|rw2|sr2|srf|pef|iiq|3fr)$/i;
const RAW_MIME = /(?:raw|sony-arw|canon-cr|nikon-nef|adobe-dng|fuji-raf|olympus-orf|panasonic-rw2)/i;

export function shouldParseRawExif(meta = {}) {
  return RAW_EXTENSIONS.test(String(meta.name || "")) || RAW_MIME.test(String(meta.mimeType || ""));
}

const hasValue = (value) => value !== undefined && value !== null && value !== "";
const first = (source, ...keys) => keys.map((key) => source?.[key]).find(hasValue);
const prefer = (current, source, ...keys) => (hasValue(current) ? current : first(source, ...keys));
const isoDate = (value) => {
  if (!hasValue(value)) return "";
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(value);
};

export function mergeExifMetadata(drive = {}, parsed = {}) {
  const latitude = prefer(drive.location?.latitude, parsed, "latitude", "GPSLatitude");
  const longitude = prefer(drive.location?.longitude, parsed, "longitude", "GPSLongitude");
  const altitude = prefer(drive.location?.altitude, parsed, "GPSAltitude");
  return {
    ...drive,
    cameraMake: prefer(drive.cameraMake, parsed, "Make", "CameraMake"),
    cameraModel: prefer(drive.cameraModel, parsed, "Model", "CameraModelName"),
    lens: prefer(drive.lens, parsed, "LensModel", "Lens", "LensInfo"),
    time: isoDate(prefer(drive.time, parsed, "DateTimeOriginal", "CreateDate", "DateTimeDigitized", "ModifyDate")),
    aperture: prefer(drive.aperture, parsed, "FNumber", "ApertureValue"),
    exposureTime: prefer(drive.exposureTime, parsed, "ExposureTime", "ShutterSpeedValue"),
    exposureBias: prefer(drive.exposureBias, parsed, "ExposureBiasValue"),
    exposureMode: prefer(drive.exposureMode, parsed, "ExposureMode"),
    exposureProgram: first(parsed, "ExposureProgram"),
    isoSpeed: prefer(drive.isoSpeed, parsed, "ISO", "ISOSpeedRatings", "PhotographicSensitivity"),
    focalLength: prefer(drive.focalLength, parsed, "FocalLength"),
    focalLength35mm: first(parsed, "FocalLengthIn35mmFormat", "FocalLengthIn35mmFilm"),
    flashUsed: prefer(drive.flashUsed, parsed, "Flash"),
    meteringMode: prefer(drive.meteringMode, parsed, "MeteringMode"),
    whiteBalance: prefer(drive.whiteBalance, parsed, "WhiteBalance"),
    colorSpace: prefer(drive.colorSpace, parsed, "ColorSpace"),
    sensor: prefer(drive.sensor, parsed, "Sensor", "SensorType"),
    maxApertureValue: prefer(drive.maxApertureValue, parsed, "MaxApertureValue"),
    subjectDistance: prefer(drive.subjectDistance, parsed, "SubjectDistance"),
    rotation: prefer(drive.rotation, parsed, "Orientation"),
    software: first(parsed, "Software", "Firmware"),
    artist: first(parsed, "Artist", "Creator"),
    copyright: first(parsed, "Copyright", "Rights"),
    description: first(parsed, "ImageDescription", "Description", "Caption"),
    lightSource: first(parsed, "LightSource"),
    contrast: first(parsed, "Contrast"),
    saturation: first(parsed, "Saturation"),
    sharpness: first(parsed, "Sharpness"),
    customRendered: first(parsed, "CustomRendered"),
    location: hasValue(latitude) || hasValue(longitude) || hasValue(altitude) ? { latitude, longitude, altitude } : null,
    source: Object.keys(parsed).length ? "embedded-raw" : "drive",
  };
}

export async function parseRawExif(buffer) {
  if (!buffer?.byteLength) return {};
  return (await exifr.parse(buffer, {
    tiff: true,
    ifd0: true,
    exif: true,
    gps: true,
    xmp: true,
    iptc: true,
    icc: false,
    jfif: false,
    ihdr: false,
    mergeOutput: true,
    translateKeys: true,
    translateValues: true,
    reviveValues: true,
    sanitize: true,
  })) || {};
}
