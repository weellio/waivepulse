// ── Per-loop EQ modal ─────────────────────────────────────────────────────────
import { S } from './state.js';
import { mountEq7UI, resetEq } from '../shared/eq7.js';
import { setStatus } from './util.js';

let ctrl = null, analyser = null, curId = -1;

export function openLoopEq(id) {
  const s = S.slots[id];
  if (!s || !s.eq) { setStatus('Record into this loop first'); return; }
  curId = id;
  document.getElementById('loopeq-title').textContent = 'Loop ' + (id + 1) + ' — 7-band EQ';
  document.getElementById('loopeq-modal').classList.add('open');

  // Tap a spectrum analyser on the loop's post-EQ output
  analyser = S.ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.82;
  s.eq.output.connect(analyser);

  ctrl = mountEq7UI(
    document.getElementById('loopeq-canvas'),
    s.eq,
    { analyser, readoutEl: document.getElementById('loopeq-readout') }
  );
  ctrl.start();
}

export function closeLoopEq() {
  document.getElementById('loopeq-modal').classList.remove('open');
  if (ctrl) { ctrl.destroy(); ctrl = null; }
  if (analyser && curId >= 0 && S.slots[curId]?.eq) {
    try { S.slots[curId].eq.output.disconnect(analyser); } catch (_) {}
  }
  analyser = null; curId = -1;
}

export function resetLoopEq() {
  if (curId >= 0 && S.slots[curId]?.eq) { resetEq(S.slots[curId].eq); setStatus('EQ reset'); }
}

export function loopEqOpen() {
  return document.getElementById('loopeq-modal').classList.contains('open');
}
