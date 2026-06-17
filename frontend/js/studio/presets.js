// Stem presets (mute combinations), the one-click MASTER mastering preset,
// and saveable mix presets (full mixer state: per-stem + master chain).
import { S, PRESETS, STEM_ORDER } from './state.js';
import { baseStemOf, applyGains, duplicateTrack, resetAllTracks } from './tracks.js';
import { setBand, snapshotEq, createEq7, resetEq } from '../shared/eq7.js';
import { toggleExciter, toggleCompressor, toggleClipper, toggleGate, toggleGateDuck,
         toggleCrusher, toggleFolder, togglePlate } from './audio-graph.js';

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

// RST ALL — reset the WHOLE mix back to the original Full Mix, so it fully undoes
// MASTER and any genre/saved preset: every track knob + per-track EQ, the master FX
// chain (limiter/clipper/exciter/gate/crush/fold/plate), master EQ and volume, and
// the active preset. Tracks themselves are kept (use a track's ✕ to remove extras).
export function resetMix() {
  resetAllTracks();                                          // every knob → default
  for (const t of Object.values(S.tracks)) if (t.eq) resetEq(t.eq);   // per-track EQ flat
  if (S._actx) {
    const now = S._actx.currentTime;
    if (S._exciterEnabled) toggleExciter();
    if (S._compEnabled)    toggleCompressor();
    if (S._clipEnabled)    toggleClipper();
    if (S._gateEnabled)    toggleGate();
    if (S._gateNode && S._gateNode.parameters.get('duck').value >= 0.5) toggleGateDuck();
    if (S._crusherEnabled) toggleCrusher();
    if (S._folderEnabled)  toggleFolder();
    if (S._plateEnabled)   togglePlate();
    if (S._masterSubEQ) S._masterSubEQ.gain.setTargetAtTime(0, now, 0.05);   // master EQ flat
    if (S._masterAirEQ) S._masterAirEQ.gain.setTargetAtTime(0, now, 0.05);
  }
  const mv = document.getElementById('master-vol'); if (mv) mv.value = 100;  // master volume 100%
  setMasterVolume(100);
  applyPreset('full');                                       // un-mute everything, highlight Full Mix
}

// ── Mix Presets (full mixer state save/load) ─────────────────────────────────

const MIX_PRESETS_KEY = 'waivepulse_mix_presets';

// 4 built-in genre templates
const GENRE_TEMPLATES = [
  {
    name: 'Radio Pop',
    stems: {
      vocals: { volume: 1.1, pan: 0, revAmt: 0.08, dlyAmt: 0, offset: 0 },
      drums:  { volume: 1.0, pan: 0, revAmt: 0.06, dlyAmt: 0, offset: 0 },
      bass:   { volume: 0.95, pan: 0, revAmt: 0, dlyAmt: 0, offset: 0 },
      guitar: { volume: 0.75, pan: -0.2, revAmt: 0.15, dlyAmt: 0.05, offset: 0 },
      piano:  { volume: 0.7, pan: 0.2, revAmt: 0.12, dlyAmt: 0, offset: 0 },
      other:  { volume: 0.65, pan: 0, revAmt: 0.1, dlyAmt: 0, offset: 0 },
    },
    master: { volume: 1, subEQ: 1, airEQ: 2, exciter: true, exciterWet: 0.12, comp: false, clip: true,
              gate: null, crusher: null, folder: null,
              plate: { enabled: false, mix: 0.3 }, fadeIn: 0, fadeOut: 0 },
  },
  {
    name: 'Lo-Fi Hip Hop',
    stems: {
      vocals: { volume: 0.85, pan: 0, revAmt: 0.2, dlyAmt: 0.08, offset: 0 },
      drums:  { volume: 1.05, pan: 0, revAmt: 0.15, dlyAmt: 0, offset: 0 },
      bass:   { volume: 1.1, pan: 0, revAmt: 0, dlyAmt: 0, offset: 0 },
      guitar: { volume: 0.7, pan: -0.15, revAmt: 0.25, dlyAmt: 0.1, offset: 0 },
      piano:  { volume: 0.8, pan: 0.15, revAmt: 0.3, dlyAmt: 0.05, offset: 0 },
      other:  { volume: 0.6, pan: 0, revAmt: 0.2, dlyAmt: 0, offset: 0 },
    },
    master: { volume: 0.9, subEQ: 3, airEQ: -1, exciter: false, exciterWet: 0, comp: false, clip: false,
              gate: null, crusher: { enabled: true, bits: 12, rate: 80 }, folder: null,
              plate: { enabled: true, mix: 0.25 }, fadeIn: 0, fadeOut: 0 },
  },
  {
    name: 'Rock',
    stems: {
      vocals: { volume: 1.0, pan: 0, revAmt: 0.1, dlyAmt: 0.03, offset: 0 },
      drums:  { volume: 1.15, pan: 0, revAmt: 0.08, dlyAmt: 0, offset: 0 },
      bass:   { volume: 1.1, pan: 0, revAmt: 0, dlyAmt: 0, offset: 0 },
      guitar: { volume: 1.0, pan: -0.3, revAmt: 0.12, dlyAmt: 0.04, offset: 0 },
      piano:  { volume: 0.6, pan: 0.3, revAmt: 0.15, dlyAmt: 0, offset: 0 },
      other:  { volume: 0.7, pan: 0, revAmt: 0.08, dlyAmt: 0, offset: 0 },
    },
    master: { volume: 1, subEQ: 2, airEQ: 1.5, exciter: true, exciterWet: 0.15, comp: false, clip: true,
              gate: null, crusher: null, folder: { enabled: true, drive: 1.5 },
              plate: { enabled: false, mix: 0.3 }, fadeIn: 0, fadeOut: 0 },
  },
  {
    name: 'EDM',
    stems: {
      vocals: { volume: 0.9, pan: 0, revAmt: 0.15, dlyAmt: 0.1, offset: 0 },
      drums:  { volume: 1.2, pan: 0, revAmt: 0.05, dlyAmt: 0, offset: 0 },
      bass:   { volume: 1.15, pan: 0, revAmt: 0, dlyAmt: 0, offset: 0 },
      guitar: { volume: 0.65, pan: -0.25, revAmt: 0.2, dlyAmt: 0.12, offset: 0 },
      piano:  { volume: 0.75, pan: 0.25, revAmt: 0.18, dlyAmt: 0.08, offset: 0 },
      other:  { volume: 0.8, pan: 0, revAmt: 0.12, dlyAmt: 0.06, offset: 0 },
    },
    master: { volume: 1.05, subEQ: 4, airEQ: 2, exciter: true, exciterWet: 0.18, comp: true, clip: false,
              gate: null, crusher: null, folder: null,
              plate: { enabled: true, mix: 0.35 }, fadeIn: 0, fadeOut: 0 },
  },
];

/** Capture the full mixer state into a serializable object. */
export function snapshotMix() {
  const stems = {};
  for (const [key, t] of Object.entries(S.tracks)) {
    if (t.isDuplicate || t.isImport) continue;  // only save base stems
    stems[key] = {
      volume: t.volume, pan: t.pan,
      eq7: t.eq ? snapshotEq(t.eq) : null,
      revAmt: t.revAmt || 0, dlyAmt: t.dlyAmt || 0, offset: t.offset || 0,
    };
  }
  const now = S._actx ? S._actx.currentTime : 0;
  const master = {
    volume: S._masterBus ? S._masterBus.gain.value : 1,
    subEQ: S._masterSubEQ ? S._masterSubEQ.gain.value : 0,
    airEQ: S._masterAirEQ ? S._masterAirEQ.gain.value : 0,
    exciter: S._exciterEnabled,
    exciterWet: S._exciterWet ? S._exciterWet.gain.value : 0,
    comp: S._compEnabled,
    clip: S._clipEnabled,
    // New effects
    gate: S._gateNode ? {
      enabled: S._gateEnabled,
      duck: S._gateNode.parameters.get('duck').value >= 0.5,
    } : null,
    crusher: S._crusherNode ? {
      enabled: S._crusherEnabled,
      bits: S._crusherNode.parameters.get('bits').value,
      rate: S._crusherNode.parameters.get('rate').value * 100,
    } : null,
    folder: {
      enabled: S._folderEnabled,
      drive: S._folderDrive,
    },
    plate: S._plateNode ? {
      enabled: S._plateEnabled,
      mix: S._plateMix,
    } : null,
    fadeIn: S._fadeIn || 0,
    fadeOut: S._fadeOut || 0,
  };
  return { stems, master };
}

/** Restore a mix preset onto the current tracks. */
export function restoreMix(preset) {
  if (!S._actx || !Object.keys(S.tracks).length) return;
  const now = S._actx.currentTime;

  // ── Per-stem restoration ──
  for (const [key, t] of Object.entries(S.tracks)) {
    if (t.isDuplicate || t.isImport) continue;
    const s = preset.stems[key];
    if (!s) continue;  // skip if preset doesn't have this stem
    // Volume
    if (s.volume != null) { t.volume = s.volume; t.knobs.vol?.set(s.volume); }
    // Pan
    if (s.pan != null) { t.pan = s.pan; t.knobs.pan?.set(s.pan); }
    // Reverb / Delay sends
    if (s.revAmt != null) { t.revAmt = s.revAmt; t.knobs.rev?.set(s.revAmt); }
    if (s.dlyAmt != null) { t.dlyAmt = s.dlyAmt; t.knobs.dly?.set(s.dlyAmt); }
    // Offset
    if (s.offset != null) { t.offset = s.offset; t.knobs.ofs?.set(s.offset * 1000); }
    // 7-band EQ
    if (s.eq7 && t.eq) {
      for (let i = 0; i < s.eq7.length && i < t.eq.bands.length; i++) {
        const b = s.eq7[i];
        setBand(t.eq, i, { freq: b.freq, gain: b.gain, q: b.q });
      }
    }
  }

  // ── Master restoration ──
  const m = preset.master;
  if (!m) { applyGains(); return; }

  // Master volume
  if (m.volume != null && S._masterBus) {
    S._masterBus.gain.setTargetAtTime(m.volume, now, 0.02);
    const pct = Math.round(m.volume * 100);
    const sl = document.getElementById('master-vol');
    const lb = document.getElementById('master-vol-label');
    if (sl) sl.value = pct;
    if (lb) lb.textContent = pct + '%';
  }
  // Sub / Air EQ
  if (m.subEQ != null && S._masterSubEQ) S._masterSubEQ.gain.setTargetAtTime(m.subEQ, now, 0.05);
  if (m.airEQ != null && S._masterAirEQ) S._masterAirEQ.gain.setTargetAtTime(m.airEQ, now, 0.05);

  // Exciter
  if (m.exciter != null) {
    S._exciterEnabled = !!m.exciter;
    const wet = m.exciterWet != null ? m.exciterWet : (m.exciter ? 0.18 : 0);
    if (S._exciterWet) S._exciterWet.gain.setTargetAtTime(wet, now, 0.05);
    const eb = document.getElementById('exciter-btn');
    if (eb) { eb.classList.toggle('active', S._exciterEnabled); eb.textContent = S._exciterEnabled ? 'EXC ON' : 'EXC'; }
  }

  // Compressor / Clipper (mutually exclusive)
  if (m.comp != null || m.clip != null) {
    S._compEnabled = !!m.comp;
    S._clipEnabled = !!m.clip;
    if (S._compWetGain) S._compWetGain.gain.setTargetAtTime(S._compEnabled ? 1 : 0, now, 0.02);
    if (S._clipWetGain) S._clipWetGain.gain.setTargetAtTime(S._clipEnabled ? 1 : 0, now, 0.02);
    if (S._compDryGain) S._compDryGain.gain.setTargetAtTime(S._compEnabled || S._clipEnabled ? 0 : 1, now, 0.02);
    const cb = document.getElementById('comp-btn');
    if (cb) { cb.textContent = S._compEnabled ? 'LMT ON' : 'LMT OFF'; cb.classList.toggle('active', S._compEnabled); }
    const clb = document.getElementById('clip-btn');
    if (clb) { clb.textContent = S._clipEnabled ? 'CLP ON' : 'CLP'; clb.classList.toggle('active', S._clipEnabled); }
  }

  // Gate
  if (m.gate && S._gateNode) {
    const want = !!m.gate.enabled;
    if (want !== S._gateEnabled) {
      S._gateEnabled = want;
      S._gateWetGain.gain.setTargetAtTime(want ? 1 : 0, now, 0.02);
      S._gateDryGain.gain.setTargetAtTime(want ? 0 : 1, now, 0.02);
      const gb = document.getElementById('gate-btn');
      if (gb) { gb.classList.toggle('active', want); gb.textContent = want ? 'GATE ON' : 'GATE'; }
    }
    if (m.gate.duck != null) {
      S._gateNode.parameters.get('duck').setValueAtTime(m.gate.duck ? 1 : 0, now);
      const db = document.getElementById('gateduck-btn');
      if (db) { db.classList.toggle('active', m.gate.duck); db.textContent = m.gate.duck ? 'DUCK ON' : 'DUCK'; }
    }
  }

  // Crusher
  if (m.crusher && S._crusherNode) {
    const want = !!m.crusher.enabled;
    if (want !== S._crusherEnabled) {
      S._crusherEnabled = want;
      S._crusherWetGain.gain.setTargetAtTime(want ? 1 : 0, now, 0.02);
      S._crusherDryGain.gain.setTargetAtTime(want ? 0 : 1, now, 0.02);
      const b = document.getElementById('crush-btn');
      if (b) { b.classList.toggle('active', want); b.textContent = want ? 'CRUSH ON' : 'CRUSH'; }
    }
    if (m.crusher.bits != null) {
      S._crusherNode.parameters.get('bits').setValueAtTime(m.crusher.bits, now);
      const sl = document.getElementById('crush-bits');
      const lb = document.getElementById('crush-bits-label');
      if (sl) sl.value = m.crusher.bits;
      if (lb) lb.textContent = Math.round(m.crusher.bits) + ' bit';
    }
    if (m.crusher.rate != null) {
      S._crusherNode.parameters.get('rate').setValueAtTime(Math.max(0.02, m.crusher.rate / 100), now);
      const sl = document.getElementById('crush-rate');
      const lb = document.getElementById('crush-rate-label');
      if (sl) sl.value = m.crusher.rate;
      if (lb) lb.textContent = Math.round(m.crusher.rate) + '%';
    }
  }

  // Folder
  if (m.folder) {
    const want = !!m.folder.enabled;
    if (want !== S._folderEnabled) {
      S._folderEnabled = want;
      S._folderWetGain.gain.setTargetAtTime(want ? 1 : 0, now, 0.02);
      S._folderDryGain.gain.setTargetAtTime(want ? 0 : 1, now, 0.02);
      const b = document.getElementById('fold-btn');
      if (b) { b.classList.toggle('active', want); b.textContent = want ? 'FOLD ON' : 'FOLD'; }
    }
    if (m.folder.drive != null) {
      S._folderDrive = m.folder.drive;
      if (S._folderPreGain) S._folderPreGain.gain.setTargetAtTime(S._folderDrive, now, 0.02);
      const sl = document.getElementById('fold-drive');
      const lb = document.getElementById('fold-drive-label');
      if (sl) sl.value = Math.round(S._folderDrive * 100);
      if (lb) lb.textContent = S._folderDrive.toFixed(1) + '\u00d7';
    }
  }

  // Plate
  if (m.plate && S._plateNode) {
    S._plateEnabled = !!m.plate.enabled;
    S._plateMix = m.plate.mix ?? 0.3;
    S._plateSend.gain.setTargetAtTime(S._plateEnabled ? S._plateMix : 0, now, 0.05);
    const b = document.getElementById('plate-btn');
    if (b) { b.classList.toggle('active', S._plateEnabled); b.textContent = S._plateEnabled ? 'PLATE ON' : 'PLATE'; }
    const sl = document.getElementById('plate-mix');
    const lb = document.getElementById('plate-mix-label');
    if (sl) sl.value = Math.round(S._plateMix * 100);
    if (lb) lb.textContent = Math.round(S._plateMix * 100) + '%';
  }

  // Fades
  if (m.fadeIn != null) {
    S._fadeIn = m.fadeIn;
    const sl = document.getElementById('fade-in');
    const lb = document.getElementById('fade-in-label');
    if (sl) sl.value = m.fadeIn;
    if (lb) lb.textContent = m.fadeIn > 0 ? m.fadeIn.toFixed(1) + 's' : 'off';
  }
  if (m.fadeOut != null) {
    S._fadeOut = m.fadeOut;
    const sl = document.getElementById('fade-out');
    const lb = document.getElementById('fade-out-label');
    if (sl) sl.value = m.fadeOut;
    if (lb) lb.textContent = m.fadeOut > 0 ? m.fadeOut.toFixed(1) + 's' : 'off';
  }

  applyGains();
}

/** Save current mix as a named preset to localStorage. */
export function saveMixPreset() {
  const name = prompt('Name this mix preset:');
  if (!name || !name.trim()) return;
  const presets = _loadMixPresets();
  presets.push({ name: name.trim(), timestamp: Date.now(), ...snapshotMix() });
  localStorage.setItem(MIX_PRESETS_KEY, JSON.stringify(presets));
  renderMixPresetBar();
}

/** Load a user-saved mix preset by index. */
export function loadMixPreset(i) {
  const presets = _loadMixPresets();
  if (i < 0 || i >= presets.length) return;
  restoreMix(presets[i]);
}

/** Load a built-in genre template by index. */
export function loadGenreTemplate(i) {
  if (i < 0 || i >= GENRE_TEMPLATES.length) return;
  restoreMix(GENRE_TEMPLATES[i]);
}

/** Delete a user-saved mix preset by index. */
export function deleteMixPreset(i) {
  const presets = _loadMixPresets();
  if (i < 0 || i >= presets.length) return;
  if (!confirm(`Delete preset "${presets[i].name}"?`)) return;
  presets.splice(i, 1);
  localStorage.setItem(MIX_PRESETS_KEY, JSON.stringify(presets));
  renderMixPresetBar();
}

function _loadMixPresets() {
  try { return JSON.parse(localStorage.getItem(MIX_PRESETS_KEY) || '[]'); }
  catch { return []; }
}

/** Render the mix preset bar with built-in templates + user presets. */
export function renderMixPresetBar() {
  const bar = document.getElementById('mix-preset-bar');
  if (!bar) return;
  // Keep the label, save button and the right-aligned MASTER/RST ALL actions; clear the rest.
  // New buttons are inserted BEFORE the actions group so MASTER/RST ALL stay at the far right.
  const btns = bar.querySelectorAll('.mp-btn');
  btns.forEach(b => b.remove());
  const anchor = document.getElementById('mix-actions');
  const place = el => anchor ? bar.insertBefore(el, anchor) : bar.appendChild(el);

  // Genre templates
  GENRE_TEMPLATES.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = 'preset-btn mp-btn';
    btn.textContent = t.name;
    btn.title = `Load "${t.name}" genre template`;
    btn.onclick = () => loadGenreTemplate(i);
    place(btn);
  });

  // Divider if user presets exist
  const presets = _loadMixPresets();
  if (presets.length) {
    const div = document.createElement('span');
    div.className = 'mp-btn';
    div.style.cssText = 'width:1px;height:16px;background:#333;margin:0 4px;flex-shrink:0';
    place(div);
  }

  // User presets
  presets.forEach((p, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'mp-btn';
    wrap.style.cssText = 'display:inline-flex;align-items:center;gap:2px';
    const btn = document.createElement('button');
    btn.className = 'preset-btn';
    btn.textContent = p.name;
    btn.title = `Load "${p.name}"`;
    btn.onclick = () => loadMixPreset(i);
    const del = document.createElement('button');
    del.className = 'mp-del';
    del.textContent = '\u00d7';
    del.title = `Delete "${p.name}"`;
    del.onclick = e => { e.stopPropagation(); deleteMixPreset(i); };
    wrap.appendChild(btn);
    wrap.appendChild(del);
    place(wrap);
  });
}
