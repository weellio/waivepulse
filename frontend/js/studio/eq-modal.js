// Per-track visual EQ modal: live spectrum analyser + draggable band points
// that mirror the four EQ knobs (SUB/BASS/MID/TREB) on the mixer strip.
import { S } from './state.js';

const EQ_F_MIN = 20, EQ_F_MAX = 20000, EQ_DB_MAX = 15;
const EQ_BAND_DEFS = [
  { key: 'sub', label: 'SUB', freq: 60, color: '#4ae8d4' },
  { key: 'bass', label: 'BASS', freq: 200, color: '#4a9ee8' },
  { key: 'mid', label: 'MID', freq: 1000, color: '#e8cc4a' },
  { key: 'treb', label: 'TREB', freq: 4000, color: '#e87c4a' },
];

function _eqFreqToX(f, W) { return W * Math.log2(f / EQ_F_MIN) / Math.log2(EQ_F_MAX / EQ_F_MIN); }
function _eqDbToY(db, H) { return H * (1 - (db + EQ_DB_MAX) / (2 * EQ_DB_MAX)); }
function _eqYToDb(y, H) { return EQ_DB_MAX - (y / H) * 2 * EQ_DB_MAX; }

export function openTrackEQ(stemKey) {
  if (!S._actx || !S.tracks[stemKey]) return;
  if (S._eqState) closeTrackEQ();
  const t = S.tracks[stemKey];
  const analyser = S._actx.createAnalyser();
  analyser.fftSize = 2048; analyser.smoothingTimeConstant = 0.82;
  t.eqTreble.connect(analyser);

  const canvas = document.getElementById('eq-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(720, Math.round(rect.width));
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(340 * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW, H = 340;
  const freqs = new Float32Array(W);
  for (let i = 0; i < W; i++) freqs[i] = EQ_F_MIN * Math.pow(EQ_F_MAX / EQ_F_MIN, i / (W - 1));

  S._eqState = {
    stemKey, analyser, canvas, ctx, W, H,
    freqs, magBuf: new Float32Array(W), phaseBuf: new Float32Array(W), dbBuf: new Float32Array(W),
    freqData: new Uint8Array(analyser.frequencyBinCount),
    rafId: null, dragBand: null,
  };

  document.getElementById('eq-modal').classList.add('open');
  const base = t.baseStem || stemKey;
  const name = t.isImport ? (t.importName || stemKey) :
    t.isDuplicate ? `${base} ×${stemKey.split('_')[1]}` : stemKey;
  document.getElementById('eq-title').textContent = `${name.toUpperCase()} — Visual EQ`;

  canvas.onmousedown = _onEqMouseDown;
  canvas.onwheel = _onEqWheel;
  _drawEq();
}

export function closeTrackEQ() {
  if (!S._eqState) return;
  const s = S._eqState;
  if (s.rafId) cancelAnimationFrame(s.rafId);
  try { S.tracks[s.stemKey]?.eqTreble.disconnect(s.analyser); } catch (_) {}
  s.canvas.onmousedown = null; s.canvas.onwheel = null;
  document.getElementById('eq-modal').classList.remove('open');
  S._eqState = null;
}

export function resetTrackEQ() {
  if (!S._eqState) return;
  const t = S.tracks[S._eqState.stemKey];
  ['sub', 'bass', 'mid', 'treb'].forEach(k => t.knobs[k]?.set(0));
}

function _drawEq() {
  const s = S._eqState; if (!s) return;
  const t = S.tracks[s.stemKey]; if (!t) { closeTrackEQ(); return; }
  const { ctx, W, H } = s;

  ctx.fillStyle = '#070b0b';
  ctx.fillRect(0, 0, W, H);

  ctx.font = '10px "Courier New",monospace';
  const octaves = [31, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
  for (const f of octaves) {
    const x = _eqFreqToX(f, W);
    ctx.strokeStyle = '#15201f'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillStyle = '#2a3a3a';
    ctx.fillText(f >= 1000 ? (f / 1000) + 'k' : f + '', x + 3, H - 4);
  }
  for (let db = -12; db <= 12; db += 3) {
    const y = _eqDbToY(db, H);
    ctx.strokeStyle = db === 0 ? '#2a3a3a' : '#15201f';
    ctx.lineWidth = db === 0 ? 1 : 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillStyle = db === 0 ? '#3a5a5a' : '#2a3a3a';
    ctx.fillText((db > 0 ? '+' : '') + db, 4, y - 2);
  }

  s.analyser.getByteFrequencyData(s.freqData);
  const nyquist = S._actx.sampleRate / 2;
  const bins = s.freqData.length;
  ctx.fillStyle = 'rgba(140,255,255,0.10)';
  ctx.strokeStyle = 'rgba(140,255,255,0.40)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H);
  let started = false;
  for (let i = 1; i < bins; i++) {
    const f = (i / bins) * nyquist;
    if (f < EQ_F_MIN || f > EQ_F_MAX) continue;
    const x = _eqFreqToX(f, W);
    const mag = s.freqData[i] / 255;
    const y = H - mag * (H * 0.78);
    if (!started) { ctx.lineTo(x, H); started = true; }
    ctx.lineTo(x, y);
  }
  ctx.lineTo(W, H);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();

  const { freqs, magBuf, phaseBuf, dbBuf } = s;
  dbBuf.fill(1);
  const nodes = [t.eqSub, t.eqBass, t.eqMid, t.eqTreble];
  let combined = null;
  for (const node of nodes) {
    node.getFrequencyResponse(freqs, magBuf, phaseBuf);
    if (!combined) { combined = new Float32Array(W); for (let i = 0; i < W; i++) combined[i] = magBuf[i]; }
    else { for (let i = 0; i < W; i++) combined[i] *= magBuf[i]; }
  }
  ctx.strokeStyle = '#ffe066';
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (let x = 0; x < W; x++) {
    const db = 20 * Math.log10(Math.max(1e-6, combined[x]));
    const y = _eqDbToY(db, H);
    if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();

  for (const b of EQ_BAND_DEFS) {
    const gain = t.knobs[b.key]?.val || 0;
    const x = _eqFreqToX(b.freq, W);
    const y = _eqDbToY(gain, H);
    ctx.fillStyle = b.color;
    ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#000'; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 9px "Courier New",monospace';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(b.label[0], x, y + 1);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  }

  const r = document.getElementById('eq-readouts');
  r.innerHTML = EQ_BAND_DEFS.map(b => {
    const g = t.knobs[b.key]?.val || 0;
    const sign = g >= 0 ? '+' : '';
    return `<span style="color:${b.color}">${b.label} @${b.freq >= 1000 ? (b.freq / 1000) + 'k' : b.freq}Hz<b>${sign}${g.toFixed(1)}dB</b></span>`;
  }).join('');

  s.rafId = requestAnimationFrame(_drawEq);
}

function _eqHitBand(mx, my) {
  const s = S._eqState; if (!s) return null;
  const t = S.tracks[s.stemKey];
  let best = null, bestDist = Infinity;
  for (const b of EQ_BAND_DEFS) {
    const x = _eqFreqToX(b.freq, s.W);
    const y = _eqDbToY(t.knobs[b.key]?.val || 0, s.H);
    const d = Math.hypot(mx - x, my - y);
    if (d < bestDist) { bestDist = d; best = b; }
  }
  return { band: best, dist: bestDist };
}

function _eqMouseCoords(e) {
  const s = S._eqState; const rect = s.canvas.getBoundingClientRect();
  return { mx: (e.clientX - rect.left) * (s.W / rect.width), my: (e.clientY - rect.top) * (s.H / rect.height), rect };
}

function _onEqMouseDown(e) {
  const s = S._eqState; if (!s) return;
  const { mx, my, rect } = _eqMouseCoords(e);
  const hit = _eqHitBand(mx, my);
  if (!hit || hit.dist > 22) return;
  e.preventDefault();
  const t = S.tracks[s.stemKey];
  const knob = t.knobs[hit.band.key]; if (!knob) return;
  s.dragBand = hit.band;
  const onMove = e2 => {
    const my2 = (e2.clientY - rect.top) * (s.H / rect.height);
    knob.set(_eqYToDb(my2, s.H));
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    s.dragBand = null;
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

function _onEqWheel(e) {
  const s = S._eqState; if (!s) return;
  const { mx, my } = _eqMouseCoords(e);
  const hit = _eqHitBand(mx, my);
  if (!hit || hit.dist > 40) return;
  e.preventDefault();
  const knob = S.tracks[s.stemKey].knobs[hit.band.key]; if (!knob) return;
  const step = e.shiftKey ? 0.1 : 0.5;
  knob.set(knob.val + (e.deltaY < 0 ? step : -step));
}
