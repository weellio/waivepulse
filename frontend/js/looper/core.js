// ── Audio context, capture worklets, global FX, bypass, export ────────────────
import { S } from './state.js';
import { setStatus } from './util.js';
import { applyEqOffline, snapshotEq, eqIsFlat } from '../shared/eq7.js';

// Soft-clip curve: transparent (linear) below ±0.7, then soft-knees toward ±1 so
// extreme peaks are rounded instead of clipped — kills the static the guitar's
// pluck transient was adding to recordings, without touching normal levels.
function makeSoftClipCurve() {
  const n = 2048, c = new Float32Array(n), thr = 0.7;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1, ax = Math.abs(x), s = Math.sign(x);
    c[i] = ax <= thr ? x : s * (thr + (1 - thr) * Math.tanh((ax - thr) / (1 - thr)));
  }
  return c;
}

export function ensureCtx() {
  if (S.ctx) return;
  S.ctx = new (window.AudioContext || window.webkitAudioContext)();
  const ctx = S.ctx;

  S.inputBus       = ctx.createGain();
  S.loopBus        = ctx.createGain();
  S.masterOut      = ctx.createGain(); S.masterOut.gain.value = 0.85;
  S.captureOutGain = ctx.createGain(); S.captureOutGain.gain.value = 1;
  S.bypassGain     = ctx.createGain(); S.bypassGain.gain.value = 0;

  // ── Global FX (reverb + delay) off the master bus ──
  S.reverbNode = ctx.createConvolver();
  S.reverbGain = ctx.createGain(); S.reverbGain.gain.value = 0;
  S.delayFX    = ctx.createDelay(1.0); S.delayFX.delayTime.value = 60 / 120 / 2;
  S.delayFB    = ctx.createGain();     S.delayFB.gain.value = 0.38;
  S.delayGain  = ctx.createGain();     S.delayGain.gain.value = 0;

  // Synthetic reverb IR (~1.5 s smooth decay)
  const irLen = Math.floor(ctx.sampleRate * 1.5);
  const ir = ctx.createBuffer(2, irLen, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < irLen; i++) d[i] = (Math.random()*2-1) * Math.pow(1 - i/irLen, 1.8);
  }
  S.reverbNode.buffer = ir;

  // Delay feedback loop
  S.delayFX.connect(S.delayFB); S.delayFB.connect(S.delayFX);

  // masterOut → dry + reverb send + delay send
  S.masterOut.connect(ctx.destination);
  S.masterOut.connect(S.reverbNode); S.reverbNode.connect(S.reverbGain); S.reverbGain.connect(ctx.destination);
  S.masterOut.connect(S.delayFX);    S.delayFX.connect(S.delayGain);    S.delayGain.connect(ctx.destination);

  // Soft clipper on the instrument bus — tames extreme peaks before the recorder
  S.inputClip = ctx.createWaveShaper();
  S.inputClip.curve = makeSoftClipCurve();
  S.inputClip.oversample = '4x';
  S.inputBus.connect(S.inputClip);

  // captureNode wired in async below; bypass path always ready
  S.captureOutGain.connect(S.masterOut);
  S.inputClip.connect(S.bypassGain);
  S.bypassGain.connect(S.masterOut);
  S.loopBus.connect(S.masterOut);

  initCapture();
}

export async function initCapture() {
  const ctx = S.ctx;
  try {
    await ctx.audioWorklet.addModule('/worklets/looper-capture.js');

    S.captureNode = new AudioWorkletNode(ctx, 'looper-capture', {
      numberOfInputs: 1, numberOfOutputs: 1, channelCount: 2, outputChannelCount: [2]
    });
    S.captureNode.port.onmessage = e => {
      if (S.capturing && S.captureChunks) {
        S.captureChunks.L.push(e.data[0]);
        S.captureChunks.R.push(e.data[1]);
      }
    };
    S.inputClip.connect(S.captureNode);
    S.captureNode.connect(S.captureOutGain);

    // Autotune processor (best-effort; only affects the mic when enabled)
    try {
      await ctx.audioWorklet.addModule('/worklets/looper-autotune.js');
      S.autotuneNode = new AudioWorkletNode(ctx, 'autotune');
      S.autotuneNode.parameters.get('mix').value = 0;
      S.autotuneNode.parameters.get('speed').value = S.atSpeed;
      S.autotuneNode.port.postMessage({ scale: S.atScale, root: S.atRoot });
    } catch (e) { console.warn('Autotune unavailable:', e); S.autotuneNode = null; }

    // Harmonizer processor (best-effort; only affects the mic when enabled)
    try {
      await ctx.audioWorklet.addModule('/worklets/looper-harmonizer.js');
      S.harmonizerNode = new AudioWorkletNode(ctx, 'harmonizer');
      S.harmonizerNode.parameters.get('mix').value = 0;
    } catch (e) { console.warn('Harmonizer unavailable:', e); S.harmonizerNode = null; }
  } catch (err) {
    // Fallback: ScriptProcessor with larger buffer to reduce (not eliminate) main-thread glitches
    console.warn('AudioWorklet unavailable, falling back to ScriptProcessor:', err);
    const sp = ctx.createScriptProcessor(8192, 2, 2);
    sp.onaudioprocess = e => {
      const L = e.inputBuffer.getChannelData(0);
      const R = e.inputBuffer.numberOfChannels > 1 ? e.inputBuffer.getChannelData(1) : L;
      e.outputBuffer.copyToChannel(L, 0);
      e.outputBuffer.copyToChannel(R, 1);
      if (S.capturing && S.captureChunks) {
        S.captureChunks.L.push(new Float32Array(L));
        S.captureChunks.R.push(new Float32Array(R));
      }
    };
    S.inputClip.connect(sp);
    sp.connect(S.captureOutGain);
    S.captureNode = {port: {postMessage: () => {}}};
  }
}

// ── Bypass diagnostic ────────────────────────────────────────────────────────
export function toggleBypass() {
  ensureCtx();
  const ctx = S.ctx;
  if (ctx.state === 'suspended') ctx.resume();
  S.bypassed = !S.bypassed;
  S.bypassGain.gain.setValueAtTime(S.bypassed ? 1 : 0, ctx.currentTime);
  S.captureOutGain.gain.setValueAtTime(S.bypassed ? 0 : 1, ctx.currentTime);
  const btn = document.getElementById('bypassBtn');
  btn.classList.toggle('on', S.bypassed);
  btn.textContent = S.bypassed ? '⚡ Direct Mode' : '⚡ Bypass Test';
  setStatus(S.bypassed
    ? 'BYPASS ON — ScriptProcessor/Worklet removed from path. Static still here? → your DAC/driver, not the app.'
    : 'Bypass off — capture chain restored');
}

// ── Global FX ─────────────────────────────────────────────────────────────────
export function setGlobalFX() {
  if (!S.ctx) return;
  const rev = parseFloat(document.getElementById('revSlider').value);
  const dly = parseFloat(document.getElementById('dlySlider').value);
  S.reverbGain.gain.setValueAtTime(rev, S.ctx.currentTime);
  S.delayGain.gain.setValueAtTime(dly * 0.45, S.ctx.currentTime);
  S.delayFX.delayTime.setValueAtTime(60 / S.bpm / 2, S.ctx.currentTime);
  document.getElementById('revVal').textContent  = Math.round(rev * 100) + '%';
  document.getElementById('dlyVal').textContent  = Math.round(dly * 100) + '%';
}

export function setMasterVol(val) {
  if (S.masterOut) S.masterOut.gain.setValueAtTime(parseFloat(val), S.ctx?.currentTime ?? 0);
  document.getElementById('masterVolVal').textContent = Math.round(parseFloat(val) * 100) + '%';
}

// ── Export ────────────────────────────────────────────────────────────────────
export async function exportMix() {
  const active = S.slots.filter(s => s.buffer);
  if (!active.length) { setStatus('No loops recorded yet'); return; }
  setStatus('Rendering mix…');
  const dur    = S.masterLen || Math.max(...active.map(s => s.buffer.duration));
  const sr     = S.ctx.sampleRate;
  const offCtx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
  active.forEach(s => {
    const src = offCtx.createBufferSource();
    src.buffer = s.buffer; src.loop = true; src.loopEnd = s.buffer.duration;
    const g = offCtx.createGain();
    g.gain.value = s.gainNode ? s.gainNode.gain.value : 1;
    if (s.eq && !eqIsFlat(s.eq)) {                 // bake the per-loop EQ into the render
      const oeq = applyEqOffline(offCtx, snapshotEq(s.eq));
      src.connect(oeq.input); oeq.output.connect(g);
    } else {
      src.connect(g);
    }
    g.connect(offCtx.destination); src.start(0);
  });
  const rendered = await offCtx.startRendering();
  const wav = bufToWav(rendered);
  const url = URL.createObjectURL(new Blob([wav], {type: 'audio/wav'}));
  const a   = document.createElement('a');
  a.href = url; a.download = 'looper-mix.wav'; a.click();
  URL.revokeObjectURL(url);
  setStatus('Exported looper-mix.wav');
}

export function bufToWav(buf) {
  const nc = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const ab = new ArrayBuffer(44 + len * nc * 2);
  const v  = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o+i, s.charCodeAt(i)); };
  ws(0,'RIFF'); v.setUint32(4, 36+len*nc*2, true); ws(8,'WAVE');
  ws(12,'fmt '); v.setUint32(16,16,true); v.setUint16(20,1,true);
  v.setUint16(22,nc,true); v.setUint32(24,sr,true);
  v.setUint32(28,sr*nc*2,true); v.setUint16(32,nc*2,true); v.setUint16(34,16,true);
  ws(36,'data'); v.setUint32(40,len*nc*2,true);
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let ch = 0; ch < nc; ch++) {
      const x = Math.max(-1, Math.min(1, buf.getChannelData(ch)[i]));
      v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true);
      off += 2;
    }
  }
  return ab;
}
