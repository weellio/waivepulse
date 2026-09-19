// MP3 encoder for rendered mixes — wraps the vendored lamejs 1.2.1 build
// (frontend/js/shared/vendor/lame.min.js, loaded on demand; no runtime CDN).
//
//   await audioBufferToMp3(buffer, kbps = 320, onProgress?) -> Blob (audio/mpeg)
//
// Encodes in 1152-sample frames (one MPEG-1 Layer III granule pair), stereo
// (mono sources are duplicated), yielding to the event loop every ~0.5 s of
// audio so the page stays responsive during long encodes.

const LAME_SRC = '/js/shared/vendor/lame.min.js';
let _lamePromise = null;

/** Load lame.min.js once as a classic script; resolves to the global `lamejs`. */
export function loadLame() {
  if (typeof window !== 'undefined' && window.lamejs && window.lamejs.Mp3Encoder) return Promise.resolve(window.lamejs);
  if (_lamePromise) return _lamePromise;
  _lamePromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = LAME_SRC; s.async = true;
    s.onload = () => (window.lamejs && window.lamejs.Mp3Encoder)
      ? resolve(window.lamejs)
      : reject(new Error('lamejs loaded but Mp3Encoder missing'));
    s.onerror = () => { _lamePromise = null; reject(new Error('Could not load MP3 encoder (' + LAME_SRC + ')')); };
    document.head.appendChild(s);
  });
  return _lamePromise;
}

function floatToInt16(src, start, end, out) {
  for (let i = start, j = 0; i < end; i++, j++) {
    const s = src[i] < -1 ? -1 : src[i] > 1 ? 1 : src[i];
    out[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
}

export async function audioBufferToMp3(buffer, kbps = 320, onProgress = null, lame = null) {
  const lj = lame || await loadLame();
  const sr = buffer.sampleRate, n = buffer.length;
  // MPEG-1 Layer III supports 32 / 44.1 / 48 kHz — anything else is unusual for a mix.
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const enc = new lj.Mp3Encoder(2, sr, kbps);
  const FRAME = 1152;
  const l16 = new Int16Array(FRAME), r16 = new Int16Array(FRAME);
  const parts = [];
  const yieldEvery = Math.max(1, Math.round(sr * 0.5 / FRAME));
  let frames = 0;
  for (let i = 0; i < n; i += FRAME) {
    const end = Math.min(n, i + FRAME), len = end - i;
    floatToInt16(left, i, end, l16); floatToInt16(right, i, end, r16);
    const out = len === FRAME ? enc.encodeBuffer(l16, r16) : enc.encodeBuffer(l16.subarray(0, len), r16.subarray(0, len));
    if (out.length) parts.push(new Uint8Array(out));   // copy — lame reuses its buffer
    if (++frames % yieldEvery === 0) {
      if (onProgress) onProgress(end / n);
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  const tail = enc.flush();
  if (tail.length) parts.push(new Uint8Array(tail));
  if (onProgress) onProgress(1);
  return new Blob(parts, { type: 'audio/mpeg' });
}
