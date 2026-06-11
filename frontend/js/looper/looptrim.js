// ── Per-loop "Trim start" modal ───────────────────────────────────────────────
// You can rarely hit the exact downbeat, so a recorded loop has dead air at the
// front. This lets you pick where the loop should *start* (the first hit, or beat
// 2, etc.) on the waveform. The buffer is ROTATED so that point becomes t=0 and the
// leading dead air wraps to the (silent) tail — the loop stays exactly one cycle
// long, so it stays perfectly in time with the rest of the mix.
import { S } from './state.js';
import { drawWave, playSlot } from './loops.js';
import { setStatus } from './util.js';

let curId = -1, marker = 0, dragging = false;

export function loopTrimOpen() {
  return document.getElementById('trim-modal').classList.contains('open');
}

export function openLoopTrim(id) {
  const s = S.slots[id];
  if (!s || !s.buffer) { setStatus('Record into this loop first'); return; }
  curId = id; marker = 0;
  document.getElementById('trim-title').textContent = 'Loop ' + (id + 1) + ' — Trim start';
  document.getElementById('trim-modal').classList.add('open');
  const cv = document.getElementById('trim-canvas');
  cv.onpointerdown = e => { dragging = true; cv.setPointerCapture(e.pointerId); setMarkerFromEvent(e); };
  cv.onpointermove = e => { if (dragging) setMarkerFromEvent(e); };
  cv.onpointerup   = () => { dragging = false; };
  drawTrim();
}

export function closeLoopTrim() {
  document.getElementById('trim-modal').classList.remove('open');
  curId = -1; dragging = false;
}

function setMarkerFromEvent(e) {
  const cv = document.getElementById('trim-canvas');
  const rect = cv.getBoundingClientRect();
  const s = S.slots[curId]; if (!s || !s.buffer) return;
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  marker = frac * s.buffer.duration;
  drawTrim();
}

// Snap the start marker to the first audible sample (skips the leading dead air).
export function snapTrimToSound() {
  const s = S.slots[curId]; if (!s || !s.buffer) return;
  const d = s.buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
  const thr = Math.max(0.015, peak * 0.12);
  let idx = 0;
  for (let i = 0; i < d.length; i++) { if (Math.abs(d[i]) > thr) { idx = i; break; } }
  // back off ~5 ms so the transient isn't clipped
  marker = Math.max(0, idx / s.buffer.sampleRate - 0.005);
  drawTrim();
}

// Rotate the buffer so `marker` becomes t=0; dead air wraps to the tail.
function rotate(buf, offSamples) {
  const n = buf.length, ch = buf.numberOfChannels;
  const out = S.ctx.createBuffer(ch, n, buf.sampleRate);
  for (let c = 0; c < ch; c++) {
    const src = buf.getChannelData(c), dst = out.getChannelData(c);
    for (let i = 0; i < n; i++) dst[i] = src[(i + offSamples) % n];
  }
  return out;
}

export function applyTrim() {
  const s = S.slots[curId]; if (!s || !s.buffer) return;
  const off = Math.round(marker * s.buffer.sampleRate);
  if (off <= 0) { setStatus('Marker is already at the start'); return; }
  if (!s._trimOrig) s._trimOrig = s.buffer;   // stash original so Reset can restore
  s.buffer = rotate(s.buffer, off);
  marker = 0;
  drawWave(curId);
  if (s.state === 'playing') playSlot(curId);
  drawTrim();
  setStatus('Loop ' + (curId + 1) + ' start trimmed — first sound is now on the beat');
}

export function resetTrim() {
  const s = S.slots[curId]; if (!s || !s._trimOrig) { marker = 0; drawTrim(); return; }
  s.buffer = s._trimOrig; s._trimOrig = null; marker = 0;
  drawWave(curId);
  if (s.state === 'playing') playSlot(curId);
  drawTrim();
  setStatus('Loop ' + (curId + 1) + ' restored to the original recording');
}

function drawTrim() {
  const s = S.slots[curId]; if (!s || !s.buffer) return;
  const cv = document.getElementById('trim-canvas');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 700, H = cv.clientHeight || 200;
  cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, W, H);

  const data = s.buffer.getChannelData(0);
  const step = Math.max(1, Math.ceil(data.length / W));
  const mid = H / 2;
  const markerX = (marker / s.buffer.duration) * W;

  // shaded "moves to the tail" region before the marker
  c.fillStyle = 'rgba(248,113,113,0.12)';
  c.fillRect(0, 0, markerX, H);

  // waveform
  const grad = c.createLinearGradient(0, 0, W, 0);
  grad.addColorStop(0, '#1ab8b8'); grad.addColorStop(1, '#22c55e');
  c.strokeStyle = grad; c.lineWidth = 1;
  c.beginPath();
  for (let x = 0; x < W; x++) {
    let mn = 1, mx = -1;
    for (let j = 0; j < step; j++) { const v = data[x * step + j] || 0; if (v < mn) mn = v; if (v > mx) mx = v; }
    c.moveTo(x, mid - mx * mid * 0.95);
    c.lineTo(x, mid - mn * mid * 0.95);
  }
  c.stroke();

  // marker line
  c.strokeStyle = '#f8fafc'; c.lineWidth = 2;
  c.beginPath(); c.moveTo(markerX, 0); c.lineTo(markerX, H); c.stroke();
  c.fillStyle = '#f8fafc';
  c.beginPath(); c.moveTo(markerX, 0); c.lineTo(markerX - 5, 8); c.lineTo(markerX + 5, 8); c.closePath(); c.fill();

  document.getElementById('trim-readout').textContent =
    'Start at ' + (marker * 1000).toFixed(0) + ' ms' + (marker > 0 ? '  ·  ' + (marker / s.buffer.duration * 100).toFixed(0) + '% in' : '');
}
