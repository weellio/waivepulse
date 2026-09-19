// Spectrogram view for a track: replaces its waveform with a log-frequency
// spectrogram (40 Hz – 16 kHz, dB colour map). Computed once per AudioBuffer with a
// small in-page radix-2 FFT and cached (WeakMap keyed by the buffer), so edits that
// replace the buffer (cut, stretch, key change) recompute automatically.
import { S } from './state.js';

const N = 2048, COLS = 1400, ROWS = 120, F_LO = 40, F_HI = 16000;
const cache = new WeakMap();

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

// Inferno-ish colour map, v ∈ [0,1]
function cmap(v) {
  const stops = [[0, 0, 0, 4], [0.25, 60, 15, 110], [0.5, 180, 50, 90], [0.75, 245, 140, 30], [1, 252, 250, 170]];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const a = stops[i - 1], b = stops[i], f = (v - a[0]) / (b[0] - a[0]);
      return [a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f, a[3] + (b[3] - a[3]) * f];
    }
  }
  return stops[stops.length - 1].slice(1);
}

export function computeSpectrogram(buf) {
  if (cache.has(buf)) return cache.get(buf);
  const sr = buf.sampleRate, len = buf.length;
  const chs = []; for (let c = 0; c < buf.numberOfChannels; c++) chs.push(buf.getChannelData(c));
  const cols = Math.max(1, Math.min(COLS, Math.floor(len / 256)));
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
  // row → FFT bin (log-spaced frequencies)
  const rowBin = new Float32Array(ROWS);
  for (let r = 0; r < ROWS; r++) rowBin[r] = (F_LO * Math.pow(F_HI / F_LO, r / (ROWS - 1))) / sr * N;
  const cv = document.createElement('canvas'); cv.width = cols; cv.height = ROWS;
  const ctx = cv.getContext('2d'); const img = ctx.createImageData(cols, ROWS);
  const re = new Float32Array(N), im = new Float32Array(N), mag = new Float32Array(N / 2);
  const hop = len / cols;
  for (let c = 0; c < cols; c++) {
    const start = Math.floor(c * hop + hop / 2 - N / 2);
    for (let i = 0; i < N; i++) {
      const idx = start + i; let s = 0;
      if (idx >= 0 && idx < len) { for (const ch of chs) s += ch[idx]; s /= chs.length; }
      re[i] = s * win[i]; im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] = Math.hypot(re[k], im[k]);
    for (let r = 0; r < ROWS; r++) {
      const b = rowBin[r], b0 = Math.max(1, Math.floor(b)), b1 = Math.min(N / 2 - 1, Math.max(b0, Math.floor(rowBin[Math.min(ROWS - 1, r + 1)])));
      let m = 0; for (let k = b0; k <= b1; k++) if (mag[k] > m) m = mag[k];
      const db = 20 * Math.log10(m / (N / 4) + 1e-9);          // ≈ dBFS
      const v = Math.max(0, Math.min(1, (db + 90) / 90));
      const [R, G, B] = cmap(v);
      const p = ((ROWS - 1 - r) * cols + c) * 4;
      img.data[p] = R; img.data[p + 1] = G; img.data[p + 2] = B; img.data[p + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  cache.set(buf, cv);
  return cv;
}

// Draw into a track's waveform canvas (full width for stems, clip span for imports).
export function drawSpectrogram(t) {
  const canvas = t.canvas; if (!canvas || !t.buffer) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800, h = canvas.clientHeight || 72;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#050505'; ctx.fillRect(0, 0, w, h);
  const img = computeSpectrogram(t.buffer);
  ctx.imageSmoothingEnabled = true;
  if (t.isImport && S._dur) {
    const xS = (t.startTime || 0) / S._dur * w, cw = t.buffer.duration / S._dur * w;
    if (t.loopTrack) for (let x = 0; x < w; x += cw) ctx.drawImage(img, x, 0, cw, h);
    else ctx.drawImage(img, xS, 0, cw, h);
  } else {
    const cw = S._dur ? (t.buffer.duration / S._dur) * w : w;
    ctx.drawImage(img, 0, 0, cw, h);
  }
  ctx.fillStyle = 'rgba(255,255,255,.55)'; ctx.font = '9px Segoe UI, sans-serif';
  ctx.fillText('16k', 3, 10); ctx.fillText('1k', 3, h * 0.47); ctx.fillText('40', 3, h - 3);
}

export function toggleSpectrogram(key = S._selectedTrack) {
  if (!key || !S.tracks[key]) { alert('Select a track first (click its strip or waveform), then press SPEC.'); return; }
  const t = S.tracks[key];
  t.showSpec = !t.showSpec;
  refreshSpecButton();
  import('./waveform.js').then(m => m.redrawAll());
}

export function refreshSpecButton() {
  const b = document.getElementById('spec-btn'); if (!b) return;
  const t = S._selectedTrack && S.tracks[S._selectedTrack];
  const on = !!(t && t.showSpec);
  b.classList.toggle('active', on);
  b.textContent = on ? 'SPEC ON' : 'SPEC';
}
