// Per-track 7-band parametric EQ modal — uses the shared component (spectrum +
// per-band colour fills + draggable curve + type-glyph readouts) on track.eq.
import { S } from './state.js';
import { mountEq7UI, resetEq } from '../shared/eq7.js';

let _ctrl = null, _analyser = null, _stem = null;

export function openTrackEQ(stemKey) {
  if (!S._actx || !S.tracks[stemKey]) return;
  const t = S.tracks[stemKey];
  if (!t.eq) return;
  if (_ctrl) closeTrackEQ();
  _stem = stemKey;

  _analyser = S._actx.createAnalyser();
  _analyser.fftSize = 2048; _analyser.smoothingTimeConstant = 0.82;
  t.eq.output.connect(_analyser);

  document.getElementById('eq-modal').classList.add('open');
  const base = t.baseStem || stemKey;
  const name = t.isImport ? (t.importName || stemKey) :
    t.isDuplicate ? `${base} ×${stemKey.split('_')[1]}` : stemKey;
  document.getElementById('eq-title').textContent = `${name.toUpperCase()} — 7-band EQ`;

  _ctrl = mountEq7UI(
    document.getElementById('eq-canvas'),
    t.eq,
    { analyser: _analyser, readoutEl: document.getElementById('eq-readouts') }
  );
  _ctrl.start();
}

export function closeTrackEQ() {
  if (_ctrl) { _ctrl.destroy(); _ctrl = null; }
  if (_analyser && _stem && S.tracks[_stem]?.eq) {
    try { S.tracks[_stem].eq.output.disconnect(_analyser); } catch (_) {}
  }
  _analyser = null; _stem = null;
  document.getElementById('eq-modal').classList.remove('open');
}

export function resetTrackEQ() {
  if (_stem && S.tracks[_stem]?.eq) resetEq(S.tracks[_stem].eq);
}
