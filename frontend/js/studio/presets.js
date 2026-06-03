// Stem presets (mute combinations) + the one-click MASTER mastering preset.
import { S, PRESETS } from './state.js';
import { baseStemOf, applyGains, duplicateTrack } from './tracks.js';
import { setBand } from '../shared/eq7.js';

export function applyPreset(name) {
  S._activePreset = name;
  const muteSet = PRESETS[name] || {};
  for (const [key, t] of Object.entries(S.tracks)) {
    const base = baseStemOf(key);
    t.muted = !!muteSet[base];
    t.solo = false;
    const mb = document.getElementById('m-' + key);
    const sb = document.getElementById('s-' + key);
    if (mb) mb.classList.toggle('mute-on', t.muted);
    if (sb) sb.classList.remove('solo-on');
  }
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
  const pb = document.getElementById('pb-' + name);
  if (pb) pb.classList.add('active');
  applyGains();
}

export function applyMasterPreset() {
  if (!S._actx || !Object.keys(S.tracks).length) return;
  // Drums ADT duplicate at 12ms for thickness
  if (S.tracks['drums'] && !S.tracks['drums_2']) {
    duplicateTrack('drums');
    S.tracks['drums_2'].knobs.ofs.set(12);
    S.tracks['drums_2'].knobs.vol.set(0.65);
    S.tracks['drums_2'].knobs.rev.set(0.12);
  }
  // Per-stem EQ (7-band band gains) + reverb tuning — low=low-shelf, b1=350Hz bell,
  // b3=1kHz bell, high=high-shelf
  const cfg = {
    drums:  { low: 2,  b1: 1,   rev: 0.10 },
    bass:   { low: 3,  b1: 1.5 },
    vocals: { b3: -1,  high: 2, rev: 0.08 },
    guitar: { b3: 1,   rev: 0.22 },
    piano:  { high: 1, rev: 0.18 },
    other:  { rev: 0.10 },
  };
  for (const [key, t] of Object.entries(S.tracks)) {
    const s = cfg[baseStemOf(key)]; if (!s) continue;
    if (t.eq) for (const id of ['low', 'b1', 'b3', 'high']) {
      if (s[id] != null) { const i = t.eq.bands.findIndex(b => b.id === id); if (i >= 0) setBand(t.eq, i, { gain: s[id] }); }
    }
    if (s.rev != null) t.knobs.rev?.set(s.rev);
  }
  // Master bus
  S._masterSubEQ.gain.setTargetAtTime(2, S._actx.currentTime, 0.05);
  S._masterAirEQ.gain.setTargetAtTime(2, S._actx.currentTime, 0.05);
  S._exciterEnabled = true;
  S._exciterWet.gain.setTargetAtTime(0.10, S._actx.currentTime, 0.05);
  const eb = document.getElementById('exciter-btn');
  if (eb) { eb.classList.add('active'); eb.textContent = 'EXC ON'; }
  // Enable clipper to catch peaks (preserves transient punch better than the limiter)
  if (!S._clipEnabled) {
    S._clipEnabled = true;
    const now = S._actx.currentTime;
    if (S._compEnabled) {
      S._compEnabled = false;
      S._compWetGain.gain.setTargetAtTime(0, now, 0.02);
      const cb = document.getElementById('comp-btn');
      if (cb) { cb.textContent = 'LMT OFF'; cb.classList.remove('active'); }
    }
    S._compDryGain.gain.setTargetAtTime(0, now, 0.02);
    S._clipWetGain.gain.setTargetAtTime(1, now, 0.02);
    const clb = document.getElementById('clip-btn');
    if (clb) { clb.textContent = 'CLP ON'; clb.classList.add('active'); }
  }
  // Flash the master button to confirm
  const mb = document.getElementById('master-btn');
  if (mb) { mb.style.color = '#8cffff'; mb.style.borderColor = '#1ab8b8'; setTimeout(() => { mb.style.color = ''; mb.style.borderColor = ''; }, 800); }
}

export function setMasterVolume(v) {
  if (S._masterBus) S._masterBus.gain.setTargetAtTime(v / 100, S._actx.currentTime, 0.01);
  document.getElementById('master-vol-label').textContent = v + '%';
}
