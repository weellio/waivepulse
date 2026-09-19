// ── Tiny ZIP writer / reader (no dependencies, no CDN) ────────────────────────
// Writes STORE-only archives (no compression — the payload is mostly WAV audio,
// which barely deflates anyway). The reader handles STORE, and DEFLATE too when
// the browser has DecompressionStream (so a .wploop re-zipped by another tool
// still opens). Pure functions — unit-tested under node.
//
//   makeZip([{ name, data: Uint8Array|string }]) -> Uint8Array
//   await readZip(Uint8Array) -> Map<name, Uint8Array>

const enc = new TextEncoder();

let CRC_TABLE = null;
function crcTable() {
  if (CRC_TABLE) return CRC_TABLE;
  CRC_TABLE = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    CRC_TABLE[n] = c >>> 0;
  }
  return CRC_TABLE;
}

export function crc32(bytes) {
  const t = crcTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// DOS date/time for the local file headers (zip has no timezone; local time).
function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export function makeZip(files, when = new Date()) {
  const { time, date } = dosTime(when);
  const entries = files.map(f => {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    return { name, data, crc: crc32(data), offset: 0 };
  });

  let size = 0;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  size += 22;
  const out = new Uint8Array(size);
  const v = new DataView(out.buffer);
  let p = 0;

  // local file header + data
  for (const e of entries) {
    e.offset = p;
    v.setUint32(p, 0x04034b50, true);
    v.setUint16(p + 4, 20, true);            // version needed
    v.setUint16(p + 6, 0x0800, true);        // flags: UTF-8 names
    v.setUint16(p + 8, 0, true);             // method: STORE
    v.setUint16(p + 10, time, true);
    v.setUint16(p + 12, date, true);
    v.setUint32(p + 14, e.crc, true);
    v.setUint32(p + 18, e.data.length, true);
    v.setUint32(p + 22, e.data.length, true);
    v.setUint16(p + 26, e.name.length, true);
    v.setUint16(p + 28, 0, true);
    out.set(e.name, p + 30);
    out.set(e.data, p + 30 + e.name.length);
    p += 30 + e.name.length + e.data.length;
  }

  // central directory
  const cdStart = p;
  for (const e of entries) {
    v.setUint32(p, 0x02014b50, true);
    v.setUint16(p + 4, 20, true);            // version made by
    v.setUint16(p + 6, 20, true);            // version needed
    v.setUint16(p + 8, 0x0800, true);
    v.setUint16(p + 10, 0, true);
    v.setUint16(p + 12, time, true);
    v.setUint16(p + 14, date, true);
    v.setUint32(p + 16, e.crc, true);
    v.setUint32(p + 20, e.data.length, true);
    v.setUint32(p + 24, e.data.length, true);
    v.setUint16(p + 28, e.name.length, true);
    v.setUint16(p + 30, 0, true);            // extra
    v.setUint16(p + 32, 0, true);            // comment
    v.setUint16(p + 34, 0, true);            // disk
    v.setUint16(p + 36, 0, true);            // internal attrs
    v.setUint32(p + 38, 0, true);            // external attrs
    v.setUint32(p + 42, e.offset, true);
    out.set(e.name, p + 46);
    p += 46 + e.name.length;
  }

  // end of central directory
  v.setUint32(p, 0x06054b50, true);
  v.setUint16(p + 8, entries.length, true);
  v.setUint16(p + 10, entries.length, true);
  v.setUint32(p + 12, p - cdStart, true);
  v.setUint32(p + 16, cdStart, true);
  return out;
}

async function inflateRaw(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('This zip is compressed and the browser cannot inflate it');
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

export async function readZip(bytes) {
  if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // find the end-of-central-directory record (scan back over a possible comment)
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 65535); i--) {
    if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  const count = v.getUint16(eocd + 10, true);
  let p = v.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt zip directory');
    const method = v.getUint16(p + 10, true);
    const csize  = v.getUint32(p + 20, true);
    const nlen   = v.getUint16(p + 28, true);
    const xlen   = v.getUint16(p + 30, true);
    const clen   = v.getUint16(p + 32, true);
    const loc    = v.getUint32(p + 42, true);
    const name   = dec.decode(bytes.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) continue;                       // directory entry
    const lnl = v.getUint16(loc + 26, true), lxl = v.getUint16(loc + 28, true);
    const start = loc + 30 + lnl + lxl;
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error('Unsupported zip compression (method ' + method + ') for ' + name);
  }
  return out;
}
