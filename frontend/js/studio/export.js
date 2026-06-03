// Export Mix (OfflineAudioContext render) + Stems ZIP download + WAV encoder.
// The offline render reproduces the entire live signal chain — per-track EQ,
// sends, mute regions, the master EQ/limiter/clipper/exciter, AND the four new
// effects (noise gate, bitcrusher, wavefolder, Dattorro plate reverb) — so
// "what you hear is what you get".
import { S } from './state.js';
import { applyEqOffline, snapshotEq, eqIsFlat } from '../shared/eq7.js';
import { makeSatCurve, makeClipperCurve, makeFolderCurve, makeIR } from './audio-graph.js';
import { soloCount } from './waveform.js';

// The three worklet-based effects must be available in the offline context too.
const OFFLINE_WORKLETS = [
  '/worklets/studio-gate.js',
  '/worklets/studio-bitcrusher.js',
  '/worklets/studio-dattorro.js',
];

export async function exportMix() {
  const btn = document.getElementById('export-btn');
  btn.disabled = true; btn.textContent = '⏳ Rendering…';
  try {
    const sc = soloCount();
    const first = Object.values(S.tracks)[0].buffer;
    const sr = first.sampleRate, len = Math.ceil(S._dur * sr);
    const off = new OfflineAudioContext(2, len, sr);

    // Load worklet modules into the offline context if any worklet effect is on.
    let offWorklets = false;
    if (S._workletsReady && (S._gateEnabled || S._crusherEnabled || S._plateEnabled)) {
      try {
        for (const f of OFFLINE_WORKLETS) await off.audioWorklet.addModule(f);
        offWorklets = true;
      } catch (e) { console.warn('Offline worklet load failed; gate/crusher/plate skipped in export:', e); }
    }

    const offBus = off.createGain(); offBus.gain.value = S._masterBus ? S._masterBus.gain.value : 1;
    const offRev = off.createConvolver(); offRev.buffer = makeIR(off);
    const offRevRtn = off.createGain(); offRevRtn.gain.value = 0.85;
    offRev.connect(offRevRtn); offRevRtn.connect(offBus);
    const offDlyIn = off.createGain();
    const offDly = off.createDelay(2.0); offDly.delayTime.value = S._delayNode.delayTime.value;
    const offDlyFB = off.createGain(); offDlyFB.gain.value = S._delayFeedback.gain.value;
    const offDlyRtn = off.createGain(); offDlyRtn.gain.value = 0.8;
    offDlyIn.connect(offDly); offDly.connect(offDlyFB); offDlyFB.connect(offDly);
    offDly.connect(offDlyRtn); offDlyRtn.connect(offBus);

    // Master EQ chain: subEQ → airEQ → [GATE] → [CRUSH] → [FOLD] → fxOut
    const offSubEQ = off.createBiquadFilter(); offSubEQ.type = 'lowshelf'; offSubEQ.frequency.value = 60; offSubEQ.gain.value = S._masterSubEQ.gain.value;
    const offAirEQ = off.createBiquadFilter(); offAirEQ.type = 'highshelf'; offAirEQ.frequency.value = 10000; offAirEQ.gain.value = S._masterAirEQ.gain.value;
    offBus.connect(offSubEQ); offSubEQ.connect(offAirEQ);

    let chainTail = offAirEQ;

    // Noise gate (worklet) — only if enabled and worklet loaded.
    if (offWorklets && S._gateEnabled && S._gateNode) {
      const offGate = new AudioWorkletNode(off, 'studio-gate', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      for (const name of ['highThresh', 'lowThresh', 'attack', 'hold', 'release', 'duck']) {
        const p = S._gateNode.parameters.get(name), op = offGate.parameters.get(name);
        if (p && op) op.value = p.value;
      }
      chainTail.connect(offGate); chainTail = offGate;
    }

    // Bitcrusher (worklet).
    if (offWorklets && S._crusherEnabled && S._crusherNode) {
      const offCrush = new AudioWorkletNode(off, 'studio-bitcrusher', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      for (const name of ['bits', 'rate', 'wet']) {
        const p = S._crusherNode.parameters.get(name), op = offCrush.parameters.get(name);
        if (p && op) op.value = p.value;
      }
      chainTail.connect(offCrush); chainTail = offCrush;
    }

    // Wavefolder (WaveShaper 4x): preGain(drive) → shaper.
    if (S._folderEnabled) {
      const offFoldPre = off.createGain(); offFoldPre.gain.value = S._folderDrive;
      const offFoldSh = off.createWaveShaper(); offFoldSh.curve = makeFolderCurve(); offFoldSh.oversample = '4x';
      chainTail.connect(offFoldPre); offFoldPre.connect(offFoldSh); chainTail = offFoldSh;
    }

    // fxOut: collector after the serial FX block.
    const offFxOut = off.createGain();
    chainTail.connect(offFxOut);

    // Master limiter / clipper (mutually exclusive), exciter in parallel.
    let offMasterOut = offFxOut;
    if (S._compEnabled) {
      const offComp = off.createDynamicsCompressor();
      offComp.threshold.value = -18; offComp.knee.value = 12;
      offComp.ratio.value = 4; offComp.attack.value = 0.005; offComp.release.value = 0.15;
      offMasterOut.connect(offComp); offMasterOut = offComp;
    }
    if (S._clipEnabled) {
      const offClip = off.createWaveShaper(); offClip.curve = makeClipperCurve(); offClip.oversample = '4x';
      offMasterOut.connect(offClip); offMasterOut = offClip;
    }
    offMasterOut.connect(off.destination);
    if (S._exciterEnabled) {
      const offExcHP = off.createBiquadFilter(); offExcHP.type = 'highpass'; offExcHP.frequency.value = 3000;
      const offExcSat = off.createWaveShaper(); offExcSat.curve = makeSatCurve(200); offExcSat.oversample = '4x';
      const offExcWet = off.createGain(); offExcWet.gain.value = S._exciterWet.gain.value;
      offFxOut.connect(offExcHP); offExcHP.connect(offExcSat); offExcSat.connect(offExcWet); offExcWet.connect(off.destination);
    }

    // Dattorro plate reverb (worklet) — parallel master send tapped post-FX.
    if (offWorklets && S._plateEnabled && S._plateNode) {
      const offPlateSend = off.createGain(); offPlateSend.gain.value = S._plateMix;
      const offPlate = new AudioWorkletNode(off, 'studio-dattorro', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
      for (const name of ['decay', 'damping', 'predelay', 'bandwidth']) {
        const p = S._plateNode.parameters.get(name), op = offPlate.parameters.get(name);
        if (p && op) op.value = p.value;
      }
      const offPlateRtn = off.createGain(); offPlateRtn.gain.value = 1;
      offFxOut.connect(offPlateSend); offPlateSend.connect(offPlate); offPlate.connect(offPlateRtn); offPlateRtn.connect(off.destination);
    }

    // Per-track render graph.
    for (const [, t] of Object.entries(S.tracks)) {
      let g = t.volume; if (t.muted || (sc > 0 && !t.solo)) g = 0; if (g === 0) continue;
      const gain = off.createGain(); gain.gain.value = g;
      const muteGain = off.createGain(); muteGain.gain.setValueAtTime(1, 0);
      for (const r of (t.muteRanges || [])) {
        muteGain.gain.setValueAtTime(0, Math.max(0, r.start));
        muteGain.gain.setValueAtTime(1, Math.min(S._dur, r.end));
      }
      const pan = off.createStereoPanner(); pan.pan.value = t.pan;
      const revS = off.createGain(); revS.gain.value = t.revAmt;
      const dlyS = off.createGain(); dlyS.gain.value = t.dlyAmt;
      const src = off.createBufferSource(); src.buffer = t.buffer;
      const ofs = off.createDelay(0.051); ofs.delayTime.value = t.offset || 0;
      src.connect(ofs); ofs.connect(muteGain); muteGain.connect(gain); gain.connect(pan);
      // 7-band parametric EQ (matches the live chain: pan → eq → bus/sends)
      let post = pan;
      if (t.eq && !eqIsFlat(t.eq)) { const oeq = applyEqOffline(off, snapshotEq(t.eq)); pan.connect(oeq.input); post = oeq.output; }
      post.connect(offBus); post.connect(revS); revS.connect(offRev); post.connect(dlyS); dlyS.connect(offDlyIn);
      if (t.isImport && t.loopTrack) { src.loop = true; src.start(0); }
      else if (t.isImport) { src.start(t.startTime || 0); }
      else { src.start(0); }
    }

    const rendered = await off.startRendering();
    const wav = audioBufferToWav(rendered);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = (S._title || 'mix').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') + '_mix.wav';
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert('Export failed: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '⬇ Export Mix'; }
}

export async function downloadZip() {
  if (!S._sepId) return;
  const btn = document.getElementById('zip-btn');
  btn.disabled = true; btn.textContent = '⏳ Zipping…';
  try {
    const res = await fetch(`/stems/${S._sepId}/zip`);
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = (S._title || 'stems').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') + '_stems.zip';
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) { alert('Zip download failed: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = '⬇ Stems'; }
}

export function audioBufferToWav(buffer) {
  const nc = buffer.numberOfChannels, sr = buffer.sampleRate, ns = buffer.length, dl = ns * nc * 2;
  const view = new DataView(new ArrayBuffer(44 + dl));
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, 36 + dl, true); ws(8, 'WAVE');
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nc, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * nc * 2, true); view.setUint16(32, nc * 2, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, dl, true);
  let o = 44; const ch = []; for (let c = 0; c < nc; c++) ch.push(buffer.getChannelData(c));
  for (let i = 0; i < ns; i++) for (let c = 0; c < nc; c++) {
    const s = Math.max(-1, Math.min(1, ch[c][i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return view.buffer;
}
