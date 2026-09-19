// Live loudness meter on the master output: Momentary (400 ms) and Short-term
// (3 s) LUFS, per ITU-R BS.1770 / EBU R128 — approximated in the live graph.
//
// Tap: _fadeGain (final master node) → K-weighting (highshelf +4 dB @ 1681 Hz,
// highpass 38 Hz) → channel splitter → one AnalyserNode per channel.
// Every ~100 ms the newest 100 ms of each analyser's time-domain window is
// squared and summed into a ring of hops; M = mean of the last 4 hops, S = the
// last 30. The meter is metering-only — it never feeds the audible path.
import { S } from './state.js';
import { lufsFromMeanSquare } from '../shared/loudness.js';

const HOP_MS = 100, M_HOPS = 4, S_HOPS = 30;
let _an = [], _buf = null, _ring = [], _timer = null, _hopLen = 0;

export function setupLufsMeter() {
  const x = S._actx;
  if (!x || !S._fadeGain || _an.length) return;
  const shelf = x.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1681.97; shelf.gain.value = 4;
  const hp = x.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38.1; hp.Q.value = 0.5;
  // Force stereo through the filters so a mono moment doesn't collapse the split.
  for (const f of [shelf, hp]) { f.channelCount = 2; f.channelCountMode = 'explicit'; }
  const split = x.createChannelSplitter(2);
  S._fadeGain.connect(shelf); shelf.connect(hp); hp.connect(split);
  _hopLen = Math.round(x.sampleRate * HOP_MS / 1000);
  const fft = _hopLen * 2 <= 8192 ? 8192 : 16384;   // window always holds > one hop
  for (let c = 0; c < 2; c++) {
    const a = x.createAnalyser(); a.fftSize = fft; a.smoothingTimeConstant = 0;
    split.connect(a, c); _an.push(a);
  }
  _buf = new Float32Array(fft);
  S._lufsMeter = { reset: resetLufsMeter };
  _timer = setInterval(tick, HOP_MS);
}

export function resetLufsMeter() { _ring = []; paint(-Infinity, -Infinity); }

function tick() {
  if (!S._playing) { if (_ring.length) { _ring = []; paint(-Infinity, -Infinity, true); } return; }
  let e = 0;
  for (const a of _an) {
    a.getFloatTimeDomainData(_buf);
    const n = _buf.length;
    for (let i = n - _hopLen; i < n; i++) e += _buf[i] * _buf[i];
  }
  _ring.push(e / _hopLen);                       // channel-summed mean square for this hop
  if (_ring.length > S_HOPS) _ring.shift();
  const mean = (k) => { const s = _ring.slice(-k); return s.reduce((p, v) => p + v, 0) / s.length; };
  paint(lufsFromMeanSquare(mean(M_HOPS)), _ring.length >= S_HOPS ? lufsFromMeanSquare(mean(S_HOPS)) : lufsFromMeanSquare(mean(_ring.length)));
}

const fmt = (v) => (isFinite(v) && v > -70 ? v.toFixed(1) : '--.-');
function paint(m, s, idle = false) {
  const me = document.getElementById('lufs-m'), se = document.getElementById('lufs-s'), bar = document.getElementById('lufs-bar');
  if (!me) return;
  me.textContent = fmt(m); se.textContent = fmt(s);
  S._lufsLive = { m, s };
  if (bar) {
    // Bar spans -36 … 0 LUFS; colour zones: under -18 dim, -18…-8 cyan, over -8 hot.
    const pct = isFinite(m) ? Math.max(0, Math.min(100, (m + 36) / 36 * 100)) : 0;
    bar.style.width = pct + '%';
    bar.style.background = !isFinite(m) || idle ? '#1a3a3a' : m > -8 ? '#ff6b5a' : m > -18 ? '#8cffff' : '#2a7a7a';
  }
}
