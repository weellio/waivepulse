// ── WAV read/write for project files (pure; node-testable) ────────────────────
// Loops are stored as 32-bit float WAV so a save → open round trip is bit-exact
// (no 16-bit requantization of a loop that gets re-saved again and again).
//
//   encodeWavF32(channels: Float32Array[], sampleRate) -> Uint8Array
//   decodeWav(Uint8Array) -> { sampleRate, channels: Float32Array[] }
//     (reads PCM 16/24/32-bit and IEEE float 32, any channel count)

export function encodeWavF32(channels, sampleRate) {
  const nc = channels.length, len = channels[0]?.length || 0;
  const dataBytes = len * nc * 4;
  const out = new Uint8Array(44 + dataBytes);
  const v = new DataView(out.buffer);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);                  // WAVE_FORMAT_IEEE_FLOAT
  v.setUint16(22, nc, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nc * 4, true);
  v.setUint16(32, nc * 4, true);
  v.setUint16(34, 32, true);
  ws(36, 'data'); v.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < len; i++)
    for (let c = 0; c < nc; c++) { v.setFloat32(o, channels[c][i], true); o += 4; }
  return out;
}

export function decodeWav(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = o => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= bytes.length) {
    const id = tag(p), size = v.getUint32(p + 4, true);
    if (id === 'fmt ') {
      let format = v.getUint16(p + 8, true);
      const bits = v.getUint16(p + 22, true);
      if (format === 0xFFFE && size >= 40) format = v.getUint16(p + 32, true);   // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, nc: v.getUint16(p + 10, true), sr: v.getUint32(p + 12, true), bits };
    } else if (id === 'data') {
      data = { start: p + 8, size: Math.min(size, bytes.length - p - 8) };
    }
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('WAV is missing fmt/data');
  const { format, nc, sr, bits } = fmt;
  const bps = bits / 8, frames = Math.floor(data.size / (bps * nc));
  const channels = Array.from({ length: nc }, () => new Float32Array(frames));
  let o = data.start;
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < nc; c++) {
      let x;
      if (format === 3 && bits === 32)      x = v.getFloat32(o, true);
      else if (format === 3 && bits === 64) x = v.getFloat64(o, true);
      else if (bits === 16)                 x = v.getInt16(o, true) / 32768;
      else if (bits === 24) { let s = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16); if (s & 0x800000) s -= 0x1000000; x = s / 8388608; }
      else if (bits === 32)                 x = v.getInt32(o, true) / 2147483648;
      else if (bits === 8)                  x = (bytes[o] - 128) / 128;
      else throw new Error('Unsupported WAV bit depth ' + bits);
      channels[c][i] = x;
      o += bps;
    }
  }
  return { sampleRate: sr, channels };
}

// 16- or 24-bit PCM WAV from an AudioBuffer-like { numberOfChannels, sampleRate,
// length, getChannelData(c) } — the export format (Looper ⬇ Export, Song Builder).
export function encodePcmWav(buf, bits = 16) {
  const nc = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const bps = bits / 8;
  const ab = new ArrayBuffer(44 + len * nc * bps);
  const v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + len * nc * bps, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nc, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true);
  ws(36, 'data'); v.setUint32(40, len * nc * bps, true);
  let off = 44;
  const chans = Array.from({ length: nc }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nc; c++) {
      const x = Math.max(-1, Math.min(1, chans[c][i]));
      if (bits === 16) { v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true); off += 2; }
      else {
        const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7FFFFF);
        v.setUint8(off, s & 0xFF); v.setUint8(off + 1, (s >> 8) & 0xFF); v.setUint8(off + 2, (s >> 16) & 0xFF);
        off += 3;
      }
    }
  }
  return ab;
}
