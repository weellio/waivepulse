// Volume + pan automation lanes (per track).
//
// Data model — on each track:
//   t.auto     = { vol: [{t, v}], pan: [{t, v}] }   song-time breakpoints, sorted by t
//   t.autoShow = bool (lane visible), t.autoMode = 'vol' | 'pan' (lane being edited)
// vol v ∈ [0, 1.5] is a MULTIPLIER on the track's VOL knob (1 = unchanged).
// pan v ∈ [-1, 1] is applied by a second StereoPanner after the PAN knob.
// No points = no automation (vol 1, pan 0). Before the first / after the last point
// the envelope holds that point's value; between points it ramps linearly.
//
// Live playback: t.autoGain / t.autoPan (wired in audio-graph.wireTrack) get
// setValueAtTime + linearRampToValueAtTime scheduled from the playhead — rescheduled
// on every play/seek/loop (startPlayback) and whenever a lane is edited mid-play.
// Offline: applyAutomationOffline() schedules the same envelope in renderMix().
// Cut: shiftAutomationForCut() ripples breakpoints exactly like mute regions.
import { S } from './state.js';
import { getCanvasWidth } from './transport.js';

export const AUTO_RANGE = { vol: [0, 1.5], pan: [-1, 1] };
const AUTO_DEFAULT = { vol: 1, pan: 0 };
export const LANE_H = 56;   // px added to the strip + row when the lane is open

export function ensureAuto(t) {
  if (!t.auto) t.auto = { vol: [], pan: [] };
  if (!t.auto.vol) t.auto.vol = [];
  if (!t.auto.pan) t.auto.pan = [];
  if (!t.autoMode) t.autoMode = 'vol';
  return t.auto;
}

export function hasAutomation(t) { return !!(t.auto && (t.auto.vol?.length || t.auto.pan?.length)); }

// Envelope value at song time s.
export function autoValueAt(pts, s, mode) {
  if (!pts || !pts.length) return AUTO_DEFAULT[mode];
  if (s <= pts[0].t) return pts[0].v;
  const last = pts[pts.length - 1];
  if (s >= last.t) return last.v;
  for (let i = 1; i < pts.length; i++) {
    const b = pts[i];
    if (s <= b.t) {
      const a = pts[i - 1], span = b.t - a.t;
      return span <= 0 ? b.v : a.v + (b.v - a.v) * ((s - a.t) / span);
    }
  }
  return last.v;
}

// Schedule one AudioParam so that song position `pos` plays at context time `ctxT`.
function scheduleParam(param, pts, mode, pos, ctxT, now) {
  param.cancelScheduledValues(now);
  param.setValueAtTime(autoValueAt(pts, pos, mode), Math.max(now, ctxT));
  if (!pts || !pts.length) return;
  for (const p of pts) {
    if (p.t <= pos) continue;
    param.linearRampToValueAtTime(p.v, ctxT + (p.t - pos));
  }
}

// (Re)schedule automation for one track (or all). Safe to call any time.
// Song position → context time follows transport.startPlayback, which starts the
// sources at _startTime + 0.05 playing from _startOff.
export function scheduleAutomation(key = null) {
  if (!S._actx) return;
  const keys = key ? [key] : Object.keys(S.tracks);
  const x = S._actx, now = x.currentTime;
  for (const k of keys) {
    const t = S.tracks[k]; if (!t || !t.autoGain) continue;
    ensureAuto(t);
    if (S._playing) {
      const T0 = S._startTime + 0.05;
      // before the sources start, anchor at T0/startOff; after, at now/current pos
      const anchorCtx = Math.max(now, T0);
      const anchorPos = S._startOff + (anchorCtx - T0);
      scheduleParam(t.autoGain.gain, t.auto.vol, 'vol', anchorPos, anchorCtx, now);
      scheduleParam(t.autoPan.pan, t.auto.pan, 'pan', anchorPos, anchorCtx, now);
    } else {
      holdParam(t.autoGain.gain, autoValueAt(t.auto.vol, S._startOff, 'vol'), now);
      holdParam(t.autoPan.pan, autoValueAt(t.auto.pan, S._startOff, 'pan'), now);
    }
  }
}

function holdParam(p, v, now) { p.cancelScheduledValues(now); p.setValueAtTime(v, now); }

// Stop any scheduled ramps (pause/stop) and park at the playhead value.
export function holdAutomation() { scheduleAutomation(); }

// Offline render: schedule the envelope from song time 0.
export function applyAutomationOffline(t, gainParam, panParam) {
  if (!t.auto) return;
  for (const [mode, param] of [['vol', gainParam], ['pan', panParam]]) {
    const pts = t.auto[mode];
    if (!pts || !pts.length) continue;
    param.setValueAtTime(autoValueAt(pts, 0, mode), 0);
    for (const p of pts) if (p.t > 0) param.linearRampToValueAtTime(p.v, p.t);
  }
}

// Ripple cut [a, b): points inside are removed, later points slide left by (b-a),
// and boundary points keep the envelope continuous up to the cut and correct after it.
export function shiftAutomationForCut(t, a, b) {
  if (!t.auto) return;
  const len = b - a;
  for (const mode of ['vol', 'pan']) {
    const pts = t.auto[mode]; if (!pts || !pts.length) continue;
    const vA = autoValueAt(pts, a, mode), vB = autoValueAt(pts, b, mode);
    const out = [];
    for (const p of pts) {
      if (p.t < a) out.push({ t: p.t, v: p.v });
      else if (p.t >= b) out.push({ t: p.t - len, v: p.v });
    }
    const hasBefore = pts.some(p => p.t < a), hasAfter = pts.some(p => p.t >= b);
    if (hasBefore && (hasAfter || Math.abs(vA - vB) > 1e-6)) out.push({ t: a, v: vA });
    if (Math.abs(vA - vB) > 1e-6 || (!hasBefore && hasAfter)) out.push({ t: a + 0.001, v: vB });
    out.sort((p, q) => p.t - q.t);
    // drop exact duplicates
    t.auto[mode] = out.filter((p, i) => i === 0 || Math.abs(p.t - out[i - 1].t) > 1e-6 || Math.abs(p.v - out[i - 1].v) > 1e-6);
  }
}

export function shiftAutomationBy(t, pts0, dt) {
  if (!pts0) return;
  t.auto = { vol: pts0.vol.map(p => ({ t: Math.max(0, p.t + dt), v: p.v })), pan: pts0.pan.map(p => ({ t: Math.max(0, p.t + dt), v: p.v })) };
}

export function cloneAuto(auto) {
  return { vol: (auto?.vol || []).map(p => ({ ...p })), pan: (auto?.pan || []).map(p => ({ ...p })) };
}

// ── Lane UI ─────────────────────────────────────────────────────────────────
// Sidebar strip + waveform row both grow by LANE_H when the lane is open, so the
// scroll-synced sidebar stays aligned with the rows.
export function buildAutoControls(strip, key) {
  const t = S.tracks[key];
  const box = document.createElement('div');
  box.className = 'auto-ctrl';
  const lbl = document.createElement('span'); lbl.className = 'auto-lbl'; lbl.textContent = 'AUTO';
  const vBtn = document.createElement('button'); vBtn.className = 'tb tb-norm auto-mode'; vBtn.textContent = 'VOL'; vBtn.dataset.mode = 'vol';
  const pBtn = document.createElement('button'); pBtn.className = 'tb tb-norm auto-mode'; pBtn.textContent = 'PAN'; pBtn.dataset.mode = 'pan';
  vBtn.title = 'Edit the volume automation lane (multiplier on VOL: 0–150%)';
  pBtn.title = 'Edit the pan automation lane (L100–R100, on top of the PAN knob)';
  for (const b of [vBtn, pBtn]) b.onclick = e => { e.stopPropagation(); setAutoMode(key, b.dataset.mode); };
  const clr = document.createElement('button'); clr.className = 'tb tb-norm'; clr.textContent = 'CLR';
  clr.title = 'Clear every point in the current lane';
  clr.style.color = '#e05555';
  clr.onclick = e => {
    e.stopPropagation(); ensureAuto(t);
    if (!t.auto[t.autoMode].length) return;
    t.auto[t.autoMode] = []; onAutoChanged(key);
  };
  const hint = document.createElement('span'); hint.className = 'auto-hint';
  hint.textContent = 'click add · drag move · dbl/right-click delete';
  box.append(lbl, vBtn, pBtn, clr, hint);
  strip.appendChild(box);
  refreshAutoButtons(key);
}

export function toggleAutoLane(key) {
  const t = S.tracks[key]; if (!t) return;
  ensureAuto(t);
  t.autoShow = !t.autoShow;
  applyLaneVisibility(key);
}

export function applyLaneVisibility(key) {
  const t = S.tracks[key]; if (!t) return;
  const strip = document.querySelector(`#sidebar-tracks .ctrl-strip[data-stem="${key}"]`);
  const row = document.querySelector(`#scroll-content .track-row[data-stem="${key}"]`);
  strip?.classList.toggle('auto-open', !!t.autoShow);
  row?.classList.toggle('auto-open', !!t.autoShow);
  refreshAutoButtons(key);
  // waveform canvas height changed → redraw it (lazy import to avoid a cycle at eval)
  import('./waveform.js').then(m => m.redrawAll());
}

export function setAutoMode(key, mode) {
  const t = S.tracks[key]; if (!t) return;
  ensureAuto(t); t.autoMode = mode;
  refreshAutoButtons(key); drawLane(key);
}

export function refreshAutoButtons(key) {
  const t = S.tracks[key]; if (!t) return;
  const a = document.getElementById('a-' + key);
  if (a) {
    a.classList.toggle('active', !!t.autoShow);
    a.classList.toggle('has-auto', hasAutomation(t));
  }
  const strip = document.querySelector(`#sidebar-tracks .ctrl-strip[data-stem="${key}"]`);
  strip?.querySelectorAll('.auto-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === (t.autoMode || 'vol')));
}

function onAutoChanged(key) {
  drawLane(key); refreshAutoButtons(key);
  scheduleAutomation(key);
}

// Create the lane canvas inside a track row and wire its mouse editing.
export function attachLane(row, key) {
  const cv = document.createElement('canvas');
  cv.className = 'auto-lane';
  row.appendChild(cv);
  const t = S.tracks[key];
  t.laneCanvas = cv;

  const toTV = e => {
    const r = cv.getBoundingClientRect();
    const mode = t.autoMode || 'vol', [lo, hi] = AUTO_RANGE[mode];
    const s = Math.max(0, Math.min(S._dur, ((e.clientX - r.left) / getCanvasWidth()) * S._dur));
    const fy = 1 - Math.max(0, Math.min(1, (e.clientY - r.top - 4) / (r.height - 8)));
    let v = lo + fy * (hi - lo);
    if (mode === 'vol' && Math.abs(v - 1) < 0.03) v = 1;     // gentle snap to unity
    if (mode === 'pan' && Math.abs(v) < 0.04) v = 0;         // …and to centre
    return { s, v };
  };
  const hitIdx = e => {
    const r = cv.getBoundingClientRect();
    const pts = ensureAuto(t)[t.autoMode || 'vol'];
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    let best = -1, bd = 8;
    pts.forEach((p, i) => {
      const [px, py] = ptXY(p, t.autoMode || 'vol', r.width, r.height);
      const d = Math.hypot(px - mx, py - my);
      if (d < bd) { bd = d; best = i; }
    });
    return best;
  };

  cv.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();
    import('./tracks.js').then(m => m.selectTrack(key));
    if (e.button === 2) return;               // contextmenu handler deletes
    if (e.button !== 0) return;
    const mode = t.autoMode || 'vol';
    const pts = ensureAuto(t)[mode];
    let idx = hitIdx(e);
    if (idx < 0) {
      const { s, v } = toTV(e);
      pts.push({ t: s, v }); pts.sort((a, b) => a.t - b.t);
      idx = pts.findIndex(p => p.t === s && p.v === v);
      onAutoChanged(key);
    }
    let drag = pts[idx];
    const onMove = e2 => {
      const { s, v } = toTV(e2);
      drag.t = s; drag.v = v;
      pts.sort((a, b) => a.t - b.t);
      drawLane(key, drag);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      onAutoChanged(key);
    };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  });
  const del = e => {
    e.preventDefault(); e.stopPropagation();
    const idx = hitIdx(e); if (idx < 0) return;
    ensureAuto(t)[t.autoMode || 'vol'].splice(idx, 1);
    onAutoChanged(key);
  };
  cv.addEventListener('dblclick', del);
  cv.addEventListener('contextmenu', del);
  cv.addEventListener('mousemove', e => {
    cv.style.cursor = hitIdx(e) >= 0 ? 'move' : 'crosshair';
    const { s, v } = toTV(e);
    cv.title = `${fmtS(s)} · ${fmtV(v, t.autoMode || 'vol')}`;
  });
}

const fmtS = s => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
export function fmtV(v, mode) {
  if (mode === 'pan') return Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100);
  return Math.round(v * 100) + '%';
}

function ptXY(p, mode, w, h) {
  const [lo, hi] = AUTO_RANGE[mode];
  const x = S._dur ? (p.t / S._dur) * w : 0;
  const y = 4 + (1 - (p.v - lo) / (hi - lo)) * (h - 8);
  return [x, y];
}

export function drawLane(key, activePt = null) {
  const t = S.tracks[key]; if (!t || !t.laneCanvas || !t.autoShow) return;
  const cv = t.laneCanvas;
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 800, h = cv.clientHeight || (LANE_H - 4);
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#0a0d0d'; ctx.fillRect(0, 0, w, h);
  const mode = t.autoMode || 'vol', other = mode === 'vol' ? 'pan' : 'vol';
  ensureAuto(t);
  // reference line: unity (vol) / centre (pan)
  const [lo, hi] = AUTO_RANGE[mode];
  const refV = mode === 'vol' ? 1 : 0;
  const refY = 4 + (1 - (refV - lo) / (hi - lo)) * (h - 8);
  ctx.strokeStyle = '#1e2a2a'; ctx.setLineDash([3, 4]); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, refY + .5); ctx.lineTo(w, refY + .5); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = '#2f4444'; ctx.font = '9px Segoe UI, sans-serif';
  if (mode === 'vol') { ctx.fillText('150%', 3, 11); ctx.fillText('100%', 36, refY - 2); ctx.fillText('0%', 3, h - 4); }
  else { ctx.fillText('L', 3, 11); ctx.fillText('C', 3, refY - 2); ctx.fillText('R', 3, h - 4); }

  const drawEnv = (pts, m, color, width, dots) => {
    const [l2, h2] = AUTO_RANGE[m];
    const yOf = v => 4 + (1 - (v - l2) / (h2 - l2)) * (h - 8);
    ctx.strokeStyle = color; ctx.lineWidth = width;
    ctx.beginPath();
    if (!pts.length) { ctx.moveTo(0, yOf(AUTO_DEFAULT[m])); ctx.lineTo(w, yOf(AUTO_DEFAULT[m])); }
    else {
      ctx.moveTo(0, yOf(pts[0].v));
      for (const p of pts) ctx.lineTo((p.t / S._dur) * w, yOf(p.v));
      ctx.lineTo(w, yOf(pts[pts.length - 1].v));
    }
    ctx.stroke();
    if (dots) for (const p of pts) {
      const x = (p.t / S._dur) * w, y = yOf(p.v);
      ctx.fillStyle = p === activePt ? '#ffffff' : color;
      ctx.beginPath(); ctx.arc(x, y, p === activePt ? 4.5 : 3.5, 0, Math.PI * 2); ctx.fill();
      if (p === activePt) {
        ctx.fillStyle = '#ddd'; ctx.font = '10px Courier New, monospace';
        ctx.fillText(fmtV(p.v, m), Math.min(w - 40, x + 7), Math.max(10, y - 6));
      }
    }
  };
  if (!S._dur) return;
  drawEnv(t.auto[other], other, 'rgba(232,200,74,0.22)', 1, false);
  drawEnv(t.auto[mode], mode, mode === 'vol' ? '#8cffff' : '#e8c84a', 1.5, true);
}

export function drawAllLanes() {
  for (const k of Object.keys(S.tracks)) if (S.tracks[k].autoShow) drawLane(k);
}
