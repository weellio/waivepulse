// Web Audio graph construction: master bus, sends, per-track wiring, and the
// master-bus effect chain (existing limiter/clipper/exciter + the four new
// effects: noise gate, bitcrusher, wavefolder, Dattorro plate reverb).
import { S } from './state.js';
import { createEq7 } from '../shared/eq7.js';

// ── Master-chain topology ───────────────────────────────────────────────────
//
//  tracks ─┐
//          ├─► _masterBus ─► _masterSubEQ ─► _masterAirEQ ─► [GATE] ─► [CRUSH]
//          │                                                             │
//  reverb/delay/plate returns ──────────────────────────────────────────┘
//                                                                         ▼
//                                                                     [FOLD]
//                                                                         │
//                                                                     _fxOut ──┬─► _compDryGain ─► dest
//                                                                              ├─► _masterComp ─► _compWetGain ─► dest
//                                                                              ├─► _masterClip ─► _clipWetGain ─► dest
//                                                                              ├─► _exciterHP ─► _exciterSat ─► _exciterWet ─► dest
//                                                                              └─► _plateSend ─► _plateNode ─► _plateReturn ─► dest
//
// Each new effect is a dry/wet pair so it can be bypassed (wet=0) without
// rerouting. GATE/CRUSH/FOLD are serial; the plate reverb is a parallel send.

const WORKLET_FILES = [
  '/worklets/studio-gate.js',
  '/worklets/studio-bitcrusher.js',
  '/worklets/studio-dattorro.js',
];

export async function loadWorklets(ctx) {
  try {
    for (const f of WORKLET_FILES) await ctx.audioWorklet.addModule(f);
    S._workletsReady = true;
  } catch (e) {
    console.warn('AudioWorklet modules failed to load; gate/crusher/plate disabled:', e);
    S._workletsReady = false;
  }
}

export function makeSatCurve(k) {
  const n = 256, c = new Float32Array(n);
  for (let i = 0; i < n; i++) { const x = (i * 2 / n) - 1; c[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x)); }
  return c;
}

export function makeClipperCurve(threshold = 0.6, ceiling = 0.94) {
  const n = 4096, c = new Float32Array(n), range = ceiling - threshold;
  for (let i = 0; i < n; i++) {
    const x = (i * 2 / (n - 1)) - 1, ax = Math.abs(x);
    if (ax <= threshold) { c[i] = x; }
    else { c[i] = Math.sign(x) * (threshold + range * Math.tanh((ax - threshold) / range)); }
  }
  return c;
}

// Wavefolder transfer curve: a triangle/sine fold so that signal exceeding the
// implicit ±1 boundary folds back instead of clipping. Pre-gain (drive) is
// applied by a gain node before this shaper; the shaper itself maps the driven
// signal back into range with repeated reflections.
export function makeFolderCurve() {
  const n = 8192, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2 / (n - 1)) - 1;
    // sine folding: smooth, musical reflections as |x| grows past 1
    c[i] = Math.sin(x * Math.PI * 0.5 * 1.0);
    // add triangle-style hard folds for higher drive content
    let f = x;
    while (f > 1) f = 2 - f;
    while (f < -1) f = -2 - f;
    c[i] = 0.5 * c[i] + 0.5 * f;
  }
  return c;
}

export function makeIR(ctx, dur = 2.5, decay = 2.0) {
  const len = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  if (!S._reverbIRData) {
    S._reverbIRData = [new Float32Array(len), new Float32Array(len)];
    for (let c = 0; c < 2; c++)
      for (let i = 0; i < len; i++)
        S._reverbIRData[c][i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  for (let c = 0; c < 2; c++) buf.copyToChannel(S._reverbIRData[c], c);
  return buf;
}

export function setupGlobalFX() {
  const x = S._actx;
  S._masterBus = x.createGain();
  S._compDryGain = x.createGain(); S._compDryGain.gain.value = 1;
  S._compWetGain = x.createGain(); S._compWetGain.gain.value = 0;
  S._masterComp = x.createDynamicsCompressor();
  S._masterComp.threshold.value = -18; S._masterComp.knee.value = 12;
  S._masterComp.ratio.value = 4; S._masterComp.attack.value = 0.005; S._masterComp.release.value = 0.15;
  // Master chain: sub EQ → air EQ → [new serial FX] → fxOut → comp + exciter
  S._masterSubEQ = x.createBiquadFilter(); S._masterSubEQ.type = 'lowshelf'; S._masterSubEQ.frequency.value = 60; S._masterSubEQ.gain.value = 0;
  S._masterAirEQ = x.createBiquadFilter(); S._masterAirEQ.type = 'highshelf'; S._masterAirEQ.frequency.value = 10000; S._masterAirEQ.gain.value = 0;
  S._exciterHP = x.createBiquadFilter(); S._exciterHP.type = 'highpass'; S._exciterHP.frequency.value = 3000;
  S._exciterSat = x.createWaveShaper(); S._exciterSat.curve = makeSatCurve(200); S._exciterSat.oversample = '4x';
  S._exciterWet = x.createGain(); S._exciterWet.gain.value = 0;
  S._masterClip = x.createWaveShaper(); S._masterClip.curve = makeClipperCurve(); S._masterClip.oversample = '4x';
  S._clipWetGain = x.createGain(); S._clipWetGain.gain.value = 0;

  S._masterBus.connect(S._masterSubEQ); S._masterSubEQ.connect(S._masterAirEQ);

  // ── New serial FX block: GATE → CRUSH → FOLD, landing at _fxOut ──
  // Gate
  S._gateInput = x.createGain();
  S._gateDryGain = x.createGain(); S._gateDryGain.gain.value = 1;
  S._gateWetGain = x.createGain(); S._gateWetGain.gain.value = 0;
  // Crusher
  S._crusherInput = x.createGain();
  S._crusherDryGain = x.createGain(); S._crusherDryGain.gain.value = 1;
  S._crusherWetGain = x.createGain(); S._crusherWetGain.gain.value = 0;
  // Folder
  S._folderInput = x.createGain();
  S._folderPreGain = x.createGain(); S._folderPreGain.gain.value = S._folderDrive;
  S._folderShaper = x.createWaveShaper(); S._folderShaper.curve = makeFolderCurve(); S._folderShaper.oversample = '4x';
  S._folderDryGain = x.createGain(); S._folderDryGain.gain.value = 1;
  S._folderWetGain = x.createGain(); S._folderWetGain.gain.value = 0;
  // fxOut: collector after the serial block
  S._fxOut = x.createGain();

  // Wire serial chain. AirEQ → gateInput
  S._masterAirEQ.connect(S._gateInput);
  // Gate dry path
  S._gateInput.connect(S._gateDryGain); S._gateDryGain.connect(S._crusherInput);
  // Gate wet path (worklet if available)
  if (S._workletsReady) {
    S._gateNode = new AudioWorkletNode(x, 'studio-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    S._gateInput.connect(S._gateNode); S._gateNode.connect(S._gateWetGain); S._gateWetGain.connect(S._crusherInput);
  }
  // Crusher dry path
  S._crusherInput.connect(S._crusherDryGain); S._crusherDryGain.connect(S._folderInput);
  // Crusher wet path
  if (S._workletsReady) {
    S._crusherNode = new AudioWorkletNode(x, 'studio-bitcrusher', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    S._crusherInput.connect(S._crusherNode); S._crusherNode.connect(S._crusherWetGain); S._crusherWetGain.connect(S._folderInput);
  }
  // Folder dry path
  S._folderInput.connect(S._folderDryGain); S._folderDryGain.connect(S._fxOut);
  // Folder wet path: preGain → shaper → wetGain → fxOut
  S._folderInput.connect(S._folderPreGain); S._folderPreGain.connect(S._folderShaper);
  S._folderShaper.connect(S._folderWetGain); S._folderWetGain.connect(S._fxOut);

  // ── _fxOut feeds the existing parallel destination branches ──
  S._fxOut.connect(S._compDryGain); S._compDryGain.connect(x.destination);
  S._fxOut.connect(S._masterComp); S._masterComp.connect(S._compWetGain); S._compWetGain.connect(x.destination);
  S._fxOut.connect(S._masterClip); S._masterClip.connect(S._clipWetGain); S._clipWetGain.connect(x.destination);
  S._fxOut.connect(S._exciterHP); S._exciterHP.connect(S._exciterSat); S._exciterSat.connect(S._exciterWet); S._exciterWet.connect(x.destination);

  // ── Dattorro plate reverb: parallel master send tapped post-FX ──
  S._plateSend = x.createGain(); S._plateSend.gain.value = 0;
  S._plateReturn = x.createGain(); S._plateReturn.gain.value = 1;
  if (S._workletsReady) {
    S._plateNode = new AudioWorkletNode(x, 'studio-dattorro', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    S._plateNode.parameters.get('decay').value = 0.6;
    S._plateNode.parameters.get('damping').value = 0.0008;
    S._plateNode.parameters.get('predelay').value = 0.01;
    S._fxOut.connect(S._plateSend); S._plateSend.connect(S._plateNode);
    S._plateNode.connect(S._plateReturn); S._plateReturn.connect(x.destination);
  }

  // Existing convolution reverb send
  S._reverbNode = x.createConvolver(); S._reverbNode.buffer = makeIR(x);
  S._reverbReturn = x.createGain(); S._reverbReturn.gain.value = 0.85;
  S._reverbNode.connect(S._reverbReturn); S._reverbReturn.connect(S._masterBus);

  // Existing delay send
  S._delayInput = x.createGain();
  S._delayNode = x.createDelay(2.0); S._delayNode.delayTime.value = 0.35;
  S._delayFeedback = x.createGain(); S._delayFeedback.gain.value = 0.38;
  S._delayReturn = x.createGain(); S._delayReturn.gain.value = 0.8;
  S._delayInput.connect(S._delayNode);
  S._delayNode.connect(S._delayFeedback); S._delayFeedback.connect(S._delayNode);
  S._delayNode.connect(S._delayReturn); S._delayReturn.connect(S._masterBus);
}

export function wireTrack(stem) {
  const t = S.tracks[stem], x = S._actx;
  t.offsetNode = x.createDelay(0.051); t.offsetNode.delayTime.value = t.offset || 0;
  t.panNode = x.createStereoPanner();
  t.reverbSend = x.createGain(); t.reverbSend.gain.value = 0;
  t.delaySend = x.createGain(); t.delaySend.gain.value = 0;
  // 7-band parametric EQ is the per-track EQ
  t.eq = createEq7(x);
  // src → offsetNode → gainNode → panNode → eq7 → masterBus (+ sends)
  t.offsetNode.connect(t.gainNode);
  t.gainNode.connect(t.panNode);
  t.panNode.connect(t.eq.input);
  t.eq.output.connect(S._masterBus);
  t.eq.output.connect(t.reverbSend); t.reverbSend.connect(S._reverbNode);
  t.eq.output.connect(t.delaySend); t.delaySend.connect(S._delayInput);
}

// ── Existing master-effect toggles ──────────────────────────────────────────
export function toggleExciter() {
  S._exciterEnabled = !S._exciterEnabled;
  S._exciterWet.gain.setTargetAtTime(S._exciterEnabled ? 0.18 : 0, S._actx.currentTime, 0.05);
  const eb = document.getElementById('exciter-btn');
  eb.classList.toggle('active', S._exciterEnabled);
  eb.textContent = S._exciterEnabled ? 'EXC ON' : 'EXC';
}

export function toggleCompressor() {
  S._compEnabled = !S._compEnabled;
  const now = S._actx ? S._actx.currentTime : 0;
  if (S._compEnabled && S._clipEnabled) {
    S._clipEnabled = false;
    S._clipWetGain.gain.setTargetAtTime(0, now, 0.02);
    const clb = document.getElementById('clip-btn');
    clb.textContent = 'CLP'; clb.classList.remove('active');
  }
  S._compDryGain.gain.setTargetAtTime(S._compEnabled || S._clipEnabled ? 0 : 1, now, 0.02);
  S._compWetGain.gain.setTargetAtTime(S._compEnabled ? 1 : 0, now, 0.02);
  document.getElementById('comp-btn').textContent = S._compEnabled ? 'LMT ON' : 'LMT OFF';
  document.getElementById('comp-btn').classList.toggle('active', S._compEnabled);
}

export function toggleClipper() {
  S._clipEnabled = !S._clipEnabled;
  const now = S._actx ? S._actx.currentTime : 0;
  if (S._clipEnabled && S._compEnabled) {
    S._compEnabled = false;
    S._compWetGain.gain.setTargetAtTime(0, now, 0.02);
    const cb = document.getElementById('comp-btn');
    cb.textContent = 'LMT OFF'; cb.classList.remove('active');
  }
  S._compDryGain.gain.setTargetAtTime(S._clipEnabled || S._compEnabled ? 0 : 1, now, 0.02);
  S._clipWetGain.gain.setTargetAtTime(S._clipEnabled ? 1 : 0, now, 0.02);
  const clb = document.getElementById('clip-btn');
  clb.textContent = S._clipEnabled ? 'CLP ON' : 'CLP';
  clb.classList.toggle('active', S._clipEnabled);
}

// ── New master-effect toggles ───────────────────────────────────────────────
function _setEffectButton(id, on, base) {
  const b = document.getElementById(id);
  if (!b) return;
  b.classList.toggle('active', on);
  b.textContent = on ? base + ' ON' : base;
}

export function toggleGate() {
  if (!S._gateNode) { console.warn('Gate worklet unavailable'); return; }
  S._gateEnabled = !S._gateEnabled;
  const now = S._actx.currentTime;
  S._gateWetGain.gain.setTargetAtTime(S._gateEnabled ? 1 : 0, now, 0.02);
  S._gateDryGain.gain.setTargetAtTime(S._gateEnabled ? 0 : 1, now, 0.02);
  _setEffectButton('gate-btn', S._gateEnabled, 'GATE');
}

export function toggleGateDuck() {
  if (!S._gateNode) return;
  const p = S._gateNode.parameters.get('duck');
  const newVal = p.value >= 0.5 ? 0 : 1;
  p.setValueAtTime(newVal, S._actx.currentTime);
  const b = document.getElementById('gateduck-btn');
  if (b) { b.classList.toggle('active', newVal >= 0.5); b.textContent = newVal >= 0.5 ? 'DUCK ON' : 'DUCK'; }
}

export function toggleCrusher() {
  if (!S._crusherNode) { console.warn('Bitcrusher worklet unavailable'); return; }
  S._crusherEnabled = !S._crusherEnabled;
  const now = S._actx.currentTime;
  S._crusherWetGain.gain.setTargetAtTime(S._crusherEnabled ? 1 : 0, now, 0.02);
  S._crusherDryGain.gain.setTargetAtTime(S._crusherEnabled ? 0 : 1, now, 0.02);
  _setEffectButton('crush-btn', S._crusherEnabled, 'CRUSH');
}

export function setCrusherBits(v) {
  if (S._crusherNode) S._crusherNode.parameters.get('bits').setValueAtTime(+v, S._actx.currentTime);
  const lbl = document.getElementById('crush-bits-label'); if (lbl) lbl.textContent = (+v).toFixed(0) + ' bit';
}

export function setCrusherRate(v) {
  // slider is 2..100 (%) → 0.02..1
  const r = Math.max(0.02, Math.min(1, +v / 100));
  if (S._crusherNode) S._crusherNode.parameters.get('rate').setValueAtTime(r, S._actx.currentTime);
  const lbl = document.getElementById('crush-rate-label'); if (lbl) lbl.textContent = (+v).toFixed(0) + '%';
}

export function toggleFolder() {
  S._folderEnabled = !S._folderEnabled;
  const now = S._actx.currentTime;
  S._folderWetGain.gain.setTargetAtTime(S._folderEnabled ? 1 : 0, now, 0.02);
  S._folderDryGain.gain.setTargetAtTime(S._folderEnabled ? 0 : 1, now, 0.02);
  _setEffectButton('fold-btn', S._folderEnabled, 'FOLD');
}

export function setFolderDrive(v) {
  // slider 100..600 (%) → drive 1..6
  S._folderDrive = Math.max(1, +v / 100);
  if (S._folderPreGain) S._folderPreGain.gain.setTargetAtTime(S._folderDrive, S._actx.currentTime, 0.02);
  const lbl = document.getElementById('fold-drive-label'); if (lbl) lbl.textContent = S._folderDrive.toFixed(1) + '×';
}

export function togglePlate() {
  if (!S._plateNode) { console.warn('Dattorro plate worklet unavailable'); return; }
  S._plateEnabled = !S._plateEnabled;
  S._plateSend.gain.setTargetAtTime(S._plateEnabled ? S._plateMix : 0, S._actx.currentTime, 0.05);
  _setEffectButton('plate-btn', S._plateEnabled, 'PLATE');
}

export function setPlateMix(v) {
  // slider 0..100 → 0..1
  S._plateMix = Math.max(0, Math.min(1, +v / 100));
  if (S._plateSend && S._plateEnabled) S._plateSend.gain.setTargetAtTime(S._plateMix, S._actx.currentTime, 0.05);
  const lbl = document.getElementById('plate-mix-label'); if (lbl) lbl.textContent = (+v).toFixed(0) + '%';
}
