// ── Synth keyboard, guitar, sampler, filter, arpeggiator ──────────────────────
import { S } from './state.js';
import { ensureCtx } from './core.js';
import { setStatus } from './util.js';
import { refreshRollOctave } from './pianoseq.js';
import { snapMidi, isLocked } from './scale.js';
import { buildVoice, PRESETS, glideMsFor, oscCount, voiceCount, MAX_OSC } from './ensemble.js';

// ── Ensemble settings ─────────────────────────────────────────────────────────
// One note = 1–7 detuned, staggered, seated sub-voices (see ensemble.js). These
// live on S like every other synth setting; the `solo` preset is the old engine.
const ENS_KEY = 'wp.looper.ens';
const P0 = PRESETS.section;
S.ens = { size: P0.size, spread: P0.spread, stagger: P0.stagger, depth: P0.depth,
          preset: 'section', legato: false };
try {
  const saved = JSON.parse(localStorage.getItem(ENS_KEY) || 'null');
  if (saved && typeof saved === 'object')
    for (const k of ['size', 'spread', 'stagger', 'depth', 'preset', 'legato'])
      if (saved[k] != null) S.ens[k] = saved[k];
} catch (_) {}
function saveEns() { try { localStorage.setItem(ENS_KEY, JSON.stringify(S.ens)); } catch (_) {} }

// Default expression for a note with no curve drawn into it: velocity, but
// mapped so even a hard hit leaves headroom for the onset swell to open into.
export function defaultExpr(vel) { return Math.min(1, 0.28 + 0.64 * (vel == null ? 1 : vel)); }

// What the current instrument hands ensemble.js as its source spec.
function waveSpec() {
  if (S.sampleMode && S.sampleBuffer) return { buffer: S.sampleBuffer, rootHz: 261.63 };
  return S.wave;
}
function ensOpts() {
  const e = S.ens;
  return { size: e.size, spread: e.spread, stagger: e.stagger, depth: e.depth };
}

let voiceSeq = 0;

// Scale lock: semitone correction for a key/MIDI note (0 when unlocked / in scale).
// A note's MIDI = 60 (C4) + its semi + the OCT shift, exactly as noteOn pitches it.
function scaleDelta(n) {
  if (!isLocked(S.scaleName) || n.semi == null) return 0;
  const midi = 60 + n.semi + (S.octave - 4) * 12;
  return snapMidi(midi, S.scaleRoot, S.scaleName) - midi;
}

// `semi` = semitones above C4 (for sample pitch-shifting)
export const WHITE_KEYS = [
  {k:'a', note:'C4',  hz:261.63, semi:0 },
  {k:'s', note:'D4',  hz:293.66, semi:2 },
  {k:'d', note:'E4',  hz:329.63, semi:4 },
  {k:'f', note:'F4',  hz:349.23, semi:5 },
  {k:'g', note:'G4',  hz:392.00, semi:7 },
  {k:'h', note:'A4',  hz:440.00, semi:9 },
  {k:'j', note:'B4',  hz:493.88, semi:11},
  {k:'k', note:'C5',  hz:523.25, semi:12},
];
export const BLACK_KEYS = [
  {k:'w', note:'C#4', hz:277.18, lx: 33, semi:1 },
  {k:'e', note:'D#4', hz:311.13, lx: 80, semi:3 },
  {k:'t', note:'F#4', hz:369.99, lx:174, semi:6 },
  {k:'y', note:'G#4', hz:415.30, lx:220, semi:8 },
  {k:'u', note:'A#4', hz:466.16, lx:267, semi:10},
];

export const keyMap = Object.fromEntries([...WHITE_KEYS, ...BLACK_KEYS].map(n => [n.k, n]));

export function buildKbd() {
  const wrap = document.getElementById('kbdWrap');
  wrap.innerHTML = '';
  const KW = 60, SP = 62, BW = 34; // white key width, spacing, black key width
  // Black key left positions: sit on the white-key boundaries after C,D,F,G,A
  const BLX = [1, 2, 4, 5, 6].map(b => b * SP - BW / 2);

  function addKey(cls, id, x, label, noteObj) {
    const el = document.createElement('div');
    el.className = cls; el.id = id;
    el.style.left = x + 'px';
    el.textContent = label;
    el.addEventListener('mousedown', ev => { ev.preventDefault(); noteOn(noteObj); });
    el.addEventListener('mouseup',   ()  => noteOff(noteObj));
    // Slide: gliding onto a key with the button held plays it; leaving releases it
    el.addEventListener('mouseenter',()  => { if (S.isMouseDown) noteOn(noteObj); });
    el.addEventListener('mouseleave',()  => noteOff(noteObj));
    wrap.appendChild(el);
  }

  // ── Octave 1: keyboard-mapped (A–K white, W E T Y U black) ──
  WHITE_KEYS.forEach((n, i) => addKey('pkey white', 'pk-'+n.note, i*SP, n.k.toUpperCase(), n));
  BLACK_KEYS.forEach((n, i) => addKey('pkey black', 'pk-'+n.note, BLX[i], n.k.toUpperCase(), n));

  // ── Octave 2 whites: bound to the Z-row (Z X C V B N M) ──
  // White keys: D(oct+1) through C(oct+2) — positions 8–14
  // Frequencies stored as base-octave × 2, so noteOn's × 2^(octave-4) applies correctly
  S.upperKeyMap = {};
  const upW = [
    {name:'D', k:'z', hz:293.66*2, semi:14}, {name:'E', k:'x', hz:329.63*2, semi:16},
    {name:'F', k:'c', hz:349.23*2, semi:17}, {name:'G', k:'v', hz:392.00*2, semi:19},
    {name:'A', k:'b', hz:440.00*2, semi:21}, {name:'B', k:'n', hz:493.88*2, semi:23},
    {name:'C', k:'m', hz:261.63*4, semi:24},
  ];
  upW.forEach((d, i) => {
    const oct  = d.name === 'C' ? S.octave + 2 : S.octave + 1;
    const note = d.name + oct;
    const n2   = {note, hz: d.hz, semi: d.semi, k: d.k, uid: 'u_' + note};
    S.upperKeyMap[d.k] = n2;
    addKey('pkey white upper', 'pk-'+note, (8+i)*SP, d.k.toUpperCase(), n2);
  });

  // Black keys of octave+1: offset from C(oct+1) = position 7*SP = 259
  const upB = [
    {name:'C#', hz:277.18*2, semi:13}, {name:'D#', hz:311.13*2, semi:15},
    {name:'F#', hz:369.99*2, semi:18}, {name:'G#', hz:415.30*2, semi:20},
    {name:'A#', hz:466.16*2, semi:22},
  ];
  const oct2X = 7 * SP; // 259
  upB.forEach((d, i) => {
    const note = d.name + (S.octave + 1);
    const n2   = {note, hz: d.hz, semi: d.semi, k: null, uid: 'u_' + note};
    addKey('pkey black', 'pk-'+note, oct2X + BLX[i], '', n2);
  });
}

// noteOn(noteObject)                          — keys / pads / MIDI in (as before)
// noteOn(freqHz, { vel, expr, seat })          — the piano roll's per-note form
// Returns the voice id, so a caller can drive setExpr(id, …) over the note.
export function noteOn(n, opts = {}) {
  ensureCtx();
  const ctx = S.ctx;
  if (ctx.state === 'suspended') ctx.resume();
  const byFreq = typeof n === 'number';
  if (byFreq) n = { hz: n, note: null, semi: null, uid: '_v' + (++voiceSeq) };
  if (S.arpOn && !S._arpFiring && !byFreq) { arpHold(n); return; }   // arp captures held notes
  const uid = n.uid ?? n.k ?? n.note;
  if (S.activeOsc[uid]) return uid;
  const t   = ctx.currentTime;
  const sd  = byFreq ? 0 : scaleDelta(n);            // scale lock snap (semitones)
  const hz  = byFreq ? n.hz : n.hz * Math.pow(2, S.octave - 4 + sd / 12);
  const atk = Math.max(0.004, S.attackMs / 1000);  // ≥4 ms so the onset can't click
  const dec = S.decayMs     / 1000;
  const vel = opts.vel ?? n.vel ?? 1;                // MIDI velocity (keys/mouse = 1)
  const expr = opts.expr ?? n.expr ?? defaultExpr(vel);
  const seat = opts.seat ?? n.seat ?? null;
  const pk  = 0.65 * vel;
  const sus = pk * S.sustainLevel;

  // ── Scripted legato ───────────────────────────────────────────────────────
  // A new note while one is still held on this part glides instead of
  // retriggering. Velocity sets the transition time (fast attack = short
  // glide): Infinite Brass models 1700 ms down to 50 ms, so that is the range.
  if (S.ens.legato && !S.guitarMode) {
    const held = Object.entries(S.activeOsc).filter(([, a]) => a.voice);
    if (held.length) {
      held.sort((a, b) => (b[1]._t || 0) - (a[1]._t || 0));
      const [oldUid, a] = held[0];
      delete S.activeOsc[oldUid];
      if (a._n && a._n.note) document.getElementById('pk-' + a._n.note)?.classList.remove('on');
      a.voice.setFreq(hz, t, glideMsFor(vel));
      a.voice.setExpr(expr, t + 0.07);
      a._n = n; a._t = t; a.legato = true;
      S.activeOsc[uid] = a;
      if (n.note) document.getElementById('pk-' + n.note)?.classList.add('on');
      return uid;
    }
  }

  if (S.guitarMode) {
    // ── Plucked string: periodic wave + brightness sweep + exponential decay ──
    // No feedback loop — avoids the instability/screech of Karplus-Strong in Web Audio
    const harmonics = [0, 1.0, 0.5, 0.25, 0.12, 0.06, 0.03, 0.015];
    const real = new Float32Array(harmonics);
    const imag = new Float32Array(harmonics.length);
    const osc  = ctx.createOscillator();
    osc.setPeriodicWave(ctx.createPeriodicWave(real, imag));
    osc.frequency.value = hz;
    // Brightness filter sweeps from bright (pluck transient) → mellow (sustain body)
    const filt = ctx.createBiquadFilter();
    filt.type  = 'lowpass';
    filt.frequency.setValueAtTime(Math.min(hz * 14, 12000), t);
    filt.frequency.exponentialRampToValueAtTime(hz * 2, t + 0.06);
    // Fast (but not instant) attack to soften the transient spike, then decay ~2.5 s
    const env  = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.linearRampToValueAtTime(Math.max(0.0002, S.guitarVol * vel), t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    osc.connect(filt); filt.connect(env); env.connect(S.inputBus);
    osc.start(t); osc.stop(t + 2.6);
    S.activeOsc[uid] = {osc, env, out: env, isGuitar: true};

  } else {
    // ── Ensemble voice: 1–7 sub-voices, one expression value ───────
    // Covers both the oscillator waves and the sampler (ensemble.js pitches an
    // AudioBufferSource by playbackRate, and detunes it in cents just the same).
    // At size 1 / depth 0 this is node-for-node the old single-oscillator graph.
    const isSample = !!(S.sampleMode && S.sampleBuffer);
    const voice = buildVoice(ctx, S.inputBus, {
      freq: isSample ? 261.63 * Math.pow(2, (n.semi + sd + (S.octave - 4) * 12) / 12) : hz,
      vel, expr, seat, wave: waveSpec(),
      adsr: { a: S.attackMs, d: S.decayMs, s: S.sustainLevel, r: S.releaseMs },
      filter: { cutoff: S.filterCutoff, reso: S.filterReso },
      peak: 0.65, swellMs: 300, when: t, ...ensOpts(),
    });
    S.activeOsc[uid] = {
      voice, isSample, isEnsemble: true,
      env: voice.nodes.subs[0].env, osc: voice.nodes.subs[0].src,
      filt: voice.nodes.groups[0], filts: voice.nodes.groups,
    };
  }

  S.activeOsc[uid]._n = n;   // keep note ref so any caller can release it
  S.activeOsc[uid]._t = t;
  if (n.note) document.getElementById('pk-' + n.note)?.classList.add('on');
  return uid;
}

// Drive one sounding voice's expression over time — the hook the piano roll uses
// to draw a CC1-style curve into a held note. `when` = when the value arrives.
export function setExpr(voiceId, value, when) {
  const a = typeof voiceId === 'object' && voiceId ? voiceId : S.activeOsc[voiceId];
  const v = a && (a.voice || (a.setExpr ? a : null));
  if (!v || !v.setExpr) return false;
  v.setExpr(value, when);
  return true;
}

// Live load read-out for the controls / stress tests.
export function synthLoad() {
  // pass S.ctx explicitly: the registry is per-context, and the last context
  // touched may well be an OfflineAudioContext left over from an export
  return { oscs: oscCount(S.ctx ? S.ctx.currentTime : 0, S.ctx), voices: voiceCount(S.ctx), cap: MAX_OSC };
}

export function noteOff(n) {
  if (S.arpOn && !S._arpFiring) { arpRelease(n); return; }
  const uid = n.uid ?? n.k ?? n.note;
  const a = S.activeOsc[uid]; if (!a) return;
  delete S.activeOsc[uid];
  if (n.note) document.getElementById('pk-' + n.note)?.classList.remove('on');
  const t   = S.ctx.currentTime;
  const rel = S.releaseMs / 1000;
  if (a.voice) {                       // ensemble voice releases all its sub-voices
    a.voice.stop(t, rel);
  } else if (a.isGuitar) {
    // Cancel the 2.5 s auto-decay and apply the release slope instead
    a.out.gain.cancelScheduledValues(t);
    a.out.gain.setValueAtTime(a.out.gain.value, t);
    a.out.gain.exponentialRampToValueAtTime(0.0001, t + rel);
    try { a.osc.stop(t + rel + 0.02); } catch(_) {}
  } else {
    a.env.gain.setValueAtTime(a.env.gain.value, t);
    a.env.gain.exponentialRampToValueAtTime(0.0001, t + rel);
    if (a.isSample) { try { a.src.stop(t + rel + 0.02); } catch(_) {} }
    else            { a.osc.stop(t + rel + 0.02); }
  }
}

export function setWave(btn) {
  S.wave = btn.dataset.w;
  S.guitarMode = false;
  document.querySelectorAll('.ibtn[data-w]').forEach(b => b.classList.remove('on'));
  document.getElementById('guitarBtn').classList.remove('on');
  btn.classList.add('on');
}

export function setGuitarVol(val) {
  S.guitarVol = parseFloat(val);
  document.getElementById('guitarVolVal').textContent = Math.round(S.guitarVol * 100) + '%';
}

// ── Subtractive filter ────────────────────────────────────────────────────────
export function makeSynthFilter() {
  const f = S.ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = S.filterCutoff;
  f.Q.value = S.filterReso;
  return f;
}

// Schedule ONE polyphonic voice at absolute time `when` for `gate` seconds, using the
// current instrument (wave / guitar / sample), ADSR and filter. `actx`/`dest` let the
// piano-roll render into either the live graph or an OfflineAudioContext (for → Loop).
export function spawnVoice(hz, { when, gate, vel = 1, expr, seat, actx = S.ctx, dest = S.inputBus }) {
  // Everything but the guitar pluck goes through the SAME ensemble builder the
  // live keyboard uses, with actx/dest pointing at either the live graph or an
  // OfflineAudioContext — which is what makes an exported WAV match what you
  // heard, ensemble and all.
  if (!S.guitarMode) {
    return buildVoice(actx, dest, {
      freq: hz, vel, expr: expr != null ? expr : defaultExpr(vel), seat,
      wave: S.sampleMode && S.sampleBuffer ? { buffer: S.sampleBuffer, rootHz: 261.63 } : S.wave,
      adsr: { a: S.attackMs, d: S.decayMs, s: S.sustainLevel, r: S.releaseMs },
      filter: { cutoff: S.filterCutoff, reso: S.filterReso },
      peak: 0.5, swellMs: 300, when, gate, ...ensOpts(),
    });
  }

  // ── Guitar pluck: its own engine (brightness sweep + fixed decay), unchanged ──
  const t   = when;
  const atk = Math.max(0.004, S.attackMs / 1000);   // ≥ 4 ms so the onset can't click
  const dec = S.decayMs   / 1000;
  const rel = S.releaseMs / 1000;
  const pk  = S.guitarVol * vel;
  const sus = pk * S.sustainLevel;
  const relStart = t + Math.max(gate, atk + 0.01);

  const env = actx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(pk, t + atk);
  const decEnd = t + atk + dec;
  if (decEnd < relStart) {               // normal: attack → decay → hold → release
    env.gain.linearRampToValueAtTime(sus, decEnd);
    env.gain.setValueAtTime(Math.max(sus, 0.0001), relStart);
  } else {                               // gate shorter than A+D: ramp straight to release
    env.gain.linearRampToValueAtTime(Math.max(sus, 0.0001), relStart);
  }
  env.gain.exponentialRampToValueAtTime(0.0001, relStart + rel);

  const h = [0, 1, 0.5, 0.25, 0.12, 0.06, 0.03, 0.015];
  const src = actx.createOscillator();
  src.setPeriodicWave(actx.createPeriodicWave(new Float32Array(h), new Float32Array(h.length)));
  src.frequency.value = hz;

  const filt = actx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = S.filterCutoff;
  filt.Q.value = S.filterReso;

  // env BEFORE the filter (see noteOn): the filter never sees the onset step, so it
  // can't ring at its cutoff — that fixed-pitch "clap" you heard on every note.
  src.connect(env); env.connect(filt); filt.connect(dest);
  src.start(t);
  try { src.stop(relStart + rel + 0.05); } catch (_) {}
  return null;
}

export function setFilter() {
  S.filterCutoff = parseFloat(document.getElementById('cutSlider').value);
  S.filterReso   = parseFloat(document.getElementById('resSlider').value);
  // Update any currently-sounding voices live (an ensemble voice has up to three
  // filter groups; their cutoffs sit a little apart, so keep them proportional)
  if (S.ctx) Object.values(S.activeOsc).forEach(a => {
    const fs = a.filts || (a.filt ? [a.filt] : []);
    const base = fs.length ? fs[0].frequency.value || S.filterCutoff : S.filterCutoff;
    fs.forEach(f => {
      const k = fs.length > 1 ? (f.frequency.value || base) / base : 1;
      f.frequency.cancelScheduledValues(S.ctx.currentTime);
      f.frequency.setValueAtTime(Math.max(60, Math.min(20000, S.filterCutoff * k)), S.ctx.currentTime);
      f.Q.setValueAtTime(S.filterReso, S.ctx.currentTime);
    });
  });
  document.getElementById('cutVal').textContent = S.filterCutoff >= 1000
    ? (S.filterCutoff / 1000).toFixed(1) + 'k' : Math.round(S.filterCutoff);
  document.getElementById('resVal').textContent = S.filterReso.toFixed(1);
}

// ── Arpeggiator ───────────────────────────────────────────────────────────────
export function toggleArp() {
  S.arpOn = !S.arpOn;
  document.getElementById('arpBtn').classList.toggle('on', S.arpOn);
  if (S.arpOn) { ensureCtx(); if (S.ctx.state === 'suspended') S.ctx.resume(); startArp(); }
  else { stopArp(); }
}

export function setArpRate(div, btn) {
  S.arpDiv = div;
  document.querySelectorAll('.arp-rate').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
  if (S.arpOn) { stopArp(); startArp(); }
}

export function setArpMode(mode, btn) {
  S.arpMode = mode; S.arpDir = 1;
  document.querySelectorAll('.arp-mode').forEach(b => b.classList.remove('on'));
  btn.classList.add('on');
}

export function arpHold(n) {
  const uid = n.uid ?? n.k ?? n.note;
  if (!S.arpHeld.some(x => (x.uid ?? x.k ?? x.note) === uid)) S.arpHeld.push(n);
  document.getElementById('pk-' + n.note)?.classList.add('on');
}

export function arpRelease(n) {
  const uid = n.uid ?? n.k ?? n.note;
  S.arpHeld = S.arpHeld.filter(x => (x.uid ?? x.k ?? x.note) !== uid);
  document.getElementById('pk-' + n.note)?.classList.remove('on');
}

export function startArp() {
  stopArp();
  S.arpIdx = 0;
  S.arpTimer = setInterval(arpTick, (60000 / S.bpm) / S.arpDiv);
}

export function stopArp() {
  clearInterval(S.arpTimer); S.arpTimer = null;
  // release any visual holds and sounding notes
  S.arpHeld.forEach(n => document.getElementById('pk-' + n.note)?.classList.remove('on'));
  S.arpHeld = [];
}

export function arpTick() {
  if (!S.arpHeld.length) return;
  // Order the held notes by pitch
  const sorted = [...S.arpHeld].sort((a, b) => a.hz - b.hz);
  let note;
  if (S.arpMode === 'random') {
    note = sorted[Math.floor(Math.random() * sorted.length)];
  } else if (S.arpMode === 'down') {
    S.arpIdx = (S.arpIdx + 1) % sorted.length;
    note = sorted[sorted.length - 1 - S.arpIdx];
  } else if (S.arpMode === 'updown' && sorted.length > 1) {
    note = sorted[S.arpIdx];
    S.arpIdx += S.arpDir;
    if (S.arpIdx >= sorted.length - 1) { S.arpIdx = sorted.length - 1; S.arpDir = -1; }
    else if (S.arpIdx <= 0)            { S.arpIdx = 0;                 S.arpDir =  1; }
  } else { // up
    S.arpIdx = S.arpIdx % sorted.length;
    note = sorted[S.arpIdx];
    S.arpIdx++;
  }
  if (!note) return;
  // Fire one gated note through the normal voice path
  const gateMs = Math.min(((60000 / S.bpm) / S.arpDiv) * 0.85, 400);
  S._arpFiring = true;
  noteOn(note);
  S._arpFiring = false;
  setTimeout(() => { S._arpFiring = true; noteOff(note); S._arpFiring = false; }, gateMs);
}

export function toggleGuitar() {
  S.guitarMode = !S.guitarMode;
  document.getElementById('guitarBtn').classList.toggle('on', S.guitarMode);
  if (S.guitarMode) {
    // Guitar defaults: snap attack, full decay to zero, natural release
    document.getElementById('atkSlider').value =   3;
    document.getElementById('decSlider').value = 500;
    document.getElementById('susSlider').value =   0;
    document.getElementById('relSlider').value = 500;
    setADSR();
    document.querySelectorAll('.ibtn[data-w]').forEach(b => b.classList.remove('on'));
    if (S.sampleMode) toggleSampleMode();
  }
}

export function setADSR() {
  S.attackMs     = parseInt(document.getElementById('atkSlider').value);
  S.decayMs      = parseInt(document.getElementById('decSlider').value);
  S.sustainLevel = parseInt(document.getElementById('susSlider').value) / 100;
  S.releaseMs    = parseInt(document.getElementById('relSlider').value);
  const fmt = v => v < 1000 ? v + 'ms' : (v / 1000).toFixed(1) + 's';
  document.getElementById('atkVal').textContent = fmt(S.attackMs);
  document.getElementById('decVal').textContent = fmt(S.decayMs);
  document.getElementById('susVal').textContent = Math.round(S.sustainLevel * 100) + '%';
  document.getElementById('relVal').textContent = fmt(S.releaseMs);
}

export function chOctave(delta) {
  S.octave = Math.max(1, Math.min(6, S.octave + delta)); // max 6 so oct+2 ≤ 8
  document.getElementById('octDisplay').textContent = S.octave;
  // Release every held note (both octaves) so nothing sticks at the old pitch
  Object.values(S.activeOsc).forEach(a => { if (a._n) noteOff(a._n); });
  buildKbd();
  refreshRollOctave();   // transpose the piano roll (pitches + labels + notation) too
}

// ── Sample import / use-as-sample ────────────────────────────────────────────
export async function loadSample(input) {
  const file = input.files[0]; if (!file) return;
  ensureCtx(); if (S.ctx.state === 'suspended') await S.ctx.resume();
  try {
    S.sampleBuffer = await S.ctx.decodeAudioData(await file.arrayBuffer());
    S.sampleMode = true; S.guitarMode = false;
    document.getElementById('guitarBtn').classList.remove('on');
    document.getElementById('sampleName').textContent = file.name.replace(/\.[^.]+$/, '');
    const mb = document.getElementById('synthModeBtn');
    mb.textContent = '🎹 Sample'; mb.classList.add('on'); mb.style.display = '';
    setStatus('Sample loaded — play keyboard to pitch it');
  } catch(_) { setStatus('Could not decode that file — try WAV or MP3'); }
  input.value = '';
}

export function toggleSampleMode() {
  if (!S.sampleBuffer) return;
  S.sampleMode = !S.sampleMode;
  const mb = document.getElementById('synthModeBtn');
  mb.textContent = S.sampleMode ? '🎹 Sample' : '🎹 Synth';
  mb.classList.toggle('on', S.sampleMode);
}

export function useAsSample(id) {
  const s = S.slots[id]; if (!s.buffer) return;
  ensureCtx();
  S.sampleBuffer = s.buffer; S.sampleMode = true; S.guitarMode = false;
  document.getElementById('guitarBtn').classList.remove('on');
  document.getElementById('sampleName').textContent = 'Loop ' + (id + 1);
  const mb = document.getElementById('synthModeBtn');
  mb.textContent = '🎹 Sample'; mb.classList.add('on'); mb.style.display = '';
  setStatus('Loop ' + (id + 1) + ' loaded as sample — play keyboard to pitch it');
}

// ── Ensemble controls ─────────────────────────────────────────────────────────
// Size / spread / stagger / expression depth + a preset dropdown + legato.
// Kept in S.ens and remembered per browser under 'wp.looper.ens', the same way
// the export format / loudness selectors are remembered.
const ENS_IDS = { size: 'ensSizeSlider', spread: 'ensSpreadSlider', stagger: 'ensStagSlider', depth: 'ensDepthSlider' };

function ensLabels() {
  const g = id => document.getElementById(id);
  const e = S.ens;
  if (g('ensSizeVal'))   g('ensSizeVal').textContent   = e.size + (e.size === 1 ? ' voice' : ' voices');
  if (g('ensSpreadVal')) g('ensSpreadVal').textContent = e.spread.toFixed(0) + '¢';
  if (g('ensStagVal'))   g('ensStagVal').textContent   = e.stagger.toFixed(0) + 'ms';
  if (g('ensDepthVal'))  g('ensDepthVal').textContent  = Math.round(e.depth * 100) + '%';
  if (g('ensLoad'))      g('ensLoad').textContent      = `${e.size}×${Math.floor(MAX_OSC / e.size)} notes max`;
  if (g('ensLegatoBtn')) g('ensLegatoBtn').classList.toggle('on', !!e.legato);
  if (g('ensPreset'))    g('ensPreset').value = e.preset || 'custom';
}

// Read the four sliders into S.ens. Changes land on the NEXT note (a sub-voice
// count can't be grown underneath a note that is already sounding).
export function setEnsemble() {
  const num = id => parseFloat(document.getElementById(id).value);
  S.ens.size    = Math.max(1, Math.min(7, Math.round(num(ENS_IDS.size))));
  S.ens.spread  = num(ENS_IDS.spread);
  S.ens.stagger = num(ENS_IDS.stagger);
  S.ens.depth   = num(ENS_IDS.depth) / 100;
  // the sliders no longer match a named shape unless they happen to
  const hit = Object.keys(PRESETS).find(k => {
    const p = PRESETS[k];
    return p.size === S.ens.size && p.spread === S.ens.spread &&
           p.stagger === S.ens.stagger && Math.abs(p.depth - S.ens.depth) < 0.005;
  });
  S.ens.preset = hit || 'custom';
  ensLabels(); saveEns();
}

export function setEnsemblePreset(name) {
  const p = PRESETS[name];
  if (!p) { S.ens.preset = 'custom'; ensLabels(); saveEns(); return; }
  S.ens.size = p.size; S.ens.spread = p.spread; S.ens.stagger = p.stagger;
  S.ens.depth = p.depth; S.ens.preset = name;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set(ENS_IDS.size, p.size); set(ENS_IDS.spread, p.spread);
  set(ENS_IDS.stagger, p.stagger); set(ENS_IDS.depth, Math.round(p.depth * 100));
  ensLabels(); saveEns();
  setStatus(`Ensemble: ${p.label} — ${p.size} sub-voice${p.size === 1 ? '' : 's'}, ` +
            `${p.spread}¢ spread, ${p.stagger}ms stagger, ${Math.round(p.depth * 100)}% expression`);
}

export function toggleLegato() {
  S.ens.legato = !S.ens.legato;
  ensLabels(); saveEns();
  setStatus(S.ens.legato
    ? 'Legato on — a new note glides from the held one (fast attack = short glide)'
    : 'Legato off — every note retriggers its own envelope');
}

export function initEnsembleUI() {
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  set(ENS_IDS.size, S.ens.size); set(ENS_IDS.spread, S.ens.spread);
  set(ENS_IDS.stagger, S.ens.stagger); set(ENS_IDS.depth, Math.round(S.ens.depth * 100));
  ensLabels();
}

// main.js owns the window bindings for everything that existed before the
// ensemble; these four are ours, so we bind them here rather than edit it.
Object.assign(window, { setEnsemble, setEnsemblePreset, toggleLegato, setExpr, synthLoad });

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initEnsembleUI);
  else initEnsembleUI();
}
