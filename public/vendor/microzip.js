// microzip.js - minimal streaming ZIP writer (STORE only, no compression).
// Photos/videos are already compressed, so STORE keeps CPU near zero and the
// bytes flow straight from fetch() to disk. No zip64: keep the total archive
// and each file under 4 GB (the gallery UI enforces this).
// API: microzip.zipStream(files, write)
//   files: [{ name: string, stream: () => Promise<ReadableStream> }]
//   write: async (Uint8Array) => void   (called in order)
(function (global) {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  // Incremental: pass the previous return value back in (start with 0).
  function crc32(crc, buf) {
    crc = crc ^ 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function u16(v) { return new Uint8Array([v & 255, (v >>> 8) & 255]); }
  function u32(v) { return new Uint8Array([v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]); }
  function concat(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }

  function dosDateTime(d = new Date()) {
    const time = ((d.getHours() & 31) << 11) | ((d.getMinutes() & 63) << 5) | ((d.getSeconds() >> 1) & 31);
    const date = (((d.getFullYear() - 1980) & 127) << 9) | (((d.getMonth() + 1) & 15) << 5) | (d.getDate() & 31);
    return { time, date };
  }

  async function zipStream(files, write) {
    const enc = new TextEncoder();
    const { time, date } = dosDateTime();
    const central = [];
    let offset = 0;

    for (const file of files) {
      const nameBytes = enc.encode(file.name);
      const lfhOffset = offset;
      // Local file header: bit 3 (sizes/crc in trailing data descriptor)
      // + bit 11 (UTF-8 names). Method 0 = STORE.
      const lfh = concat([
        u32(0x04034b50), u16(20), u16(0x0808), u16(0),
        u16(time), u16(date), u32(0), u32(0), u32(0),
        u16(nameBytes.length), u16(0), nameBytes,
      ]);
      await write(lfh);
      offset += lfh.length;

      let crc = 0;
      let size = 0;
      const stream = await file.stream();
      const reader = stream.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        crc = crc32(crc, chunk);
        size += chunk.length;
        await write(chunk);
      }
      offset += size;

      const descriptor = concat([u32(0x08074b50), u32(crc), u32(size), u32(size)]);
      await write(descriptor);
      offset += descriptor.length;

      central.push(concat([
        u32(0x02014b50), u16(20), u16(20), u16(0x0808), u16(0),
        u16(time), u16(date), u32(crc), u32(size), u32(size),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(lfhOffset), nameBytes,
      ]));
    }

    const cdStart = offset;
    for (const entry of central) {
      await write(entry);
      offset += entry.length;
    }
    const cdSize = offset - cdStart;
    const eocd = concat([
      u32(0x06054b50), u16(0), u16(0),
      u16(central.length), u16(central.length),
      u32(cdSize), u32(cdStart), u16(0),
    ]);
    await write(eocd);
    offset += eocd.length;
    return offset;
  }

  global.microzip = { zipStream };
})(typeof window !== "undefined" ? window : globalThis);
