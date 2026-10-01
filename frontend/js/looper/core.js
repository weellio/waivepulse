// ── Audio context, capture worklets, global FX, bypass, export ────────────────
import { S } from './state.js';
import { setStatus } from './util.js';
import { applyEqOffline, snapshotEq, eqIsFlat } from '../shared/eq7.js';
import { finishExport, readoutText } from './loudexport.js';
import {
  installSpace, seatForLive, setSpaceAmount, spaceAmount,
  buildOfflineSpace, offlineSpaceOpts, slotSeat,
} from './space.js';

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

  // ── Global FX ───────────────────────────────────────────────────────────────
  // Reverb is no longer one convolver on the master bus fed with generated noise.
  // space.js owns it: three shared convolution busses (close / tree / far) built
  // from a real room recording, with every voice placed in them by its seat
  // (pan + distance). The delay stays a plain master send.
  S.delayFX    = ctx.createDelay(1.0); S.delayFX.delayTime.value = 60 / 120 / 2;
  S.delayFB    = ctx.createGain();     S.delayFB.gain.value = 0.38;
  S.delayGain  = ctx.createGain();     S.delayGain.gain.value = 0;

  // Delay feedback loop
  S.delayFX.connect(S.delayFB); S.delayFB.connect(S.delayFX);

  // masterOut → dry + delay send
  S.masterOut.connect(ctx.destination);
  S.masterOut.connect(S.delayFX);    S.delayFX.connect(S.delayGain);    S.delayGain.connect(ctx.destination);

  // Soft clipper on the instrument bus — tames extreme peaks before the recorder
  S.inputClip = ctx.createWaveShaper();
  S.inputClip.curve = makeSoftClipCurve();
  S.inputClip.oversample = '4x';
  S.inputBus.connect(S.inputClip);

  // The space's wet returns on the master bus; the dry paths stay exactly where
  // they were, so a bypass test and the recorder are untouched.
  S.space = installSpace(ctx, S.masterOut);

  // captureNode wired in async below; bypass path always ready.
  // The live instrument bus gets its own seat: dry straight to masterOut (as
  // before) plus a send into the mic busses. Recording taps inputClip upstream of
  // this, so a recorded loop is still dry — the room is added once, on playback.
  seatForLive(S.captureOutGain, S.masterOut);
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
// `revSlider` migrated from "master reverb amount" to "Space wet amount" — same
// id, same 0–1 range, same handler, so every saved project's master.reverb value
// still means the same thing. It now lives in the Space panel.
export function setGlobalFX() {
  const revEl = document.getElementById('revSlider');
  const dlyEl = document.getElementById('dlySlider');
  const rev = revEl ? parseFloat(revEl.value) : spaceAmount();
  setSpaceAmount(rev);                               // works before the ctx exists
  const revOut = document.getElementById('revVal');
  if (revOut) revOut.textContent = Math.round(rev * 100) + '%';
  if (!dlyEl) return;
  const dly = parseFloat(dlyEl.value);
  const dlyOut = document.getElementById('dlyVal');
  if (dlyOut) dlyOut.textContent = Math.round(dly * 100) + '%';
  if (!S.ctx) return;
  S.delayGain.gain.setValueAtTime(dly * 0.45, S.ctx.currentTime);
  S.delayFX.delayTime.setValueAtTime(60 / S.bpm / 2, S.ctx.currentTime);
}

export function setMasterVol(val) {
  if (S.masterOut) S.masterOut.gain.setValueAtTime(parseFloat(val), S.ctx?.currentTime ?? 0);
  document.getElementById('masterVolVal').textContent = Math.round(parseFloat(val) * 100) + '%';
}

// ── Export ────────────────────────────────────────────────────────────────────
// One cycle of every loop (per-loop volume + EQ baked in) → optional loudness
// target (LUFS, true peak ≤ −1 dBTP) → WAV or MP3 320, per the topbar selectors.
let exporting = false;
export async function exportMix() {
  const active = S.slots.filter(s => s.buffer);
  if (!active.length) { setStatus('No loops recorded yet'); return; }
  if (exporting) return;
  exporting = true;
  const btn = document.getElementById('exportBtn');
  const label = btn ? btn.textContent : '';
  const stage = t => { if (btn) btn.textContent = '⏳ ' + t; };
  try {
    stage('Rendering…'); setStatus('Rendering mix…');
    const dur    = S.masterLen || Math.max(...active.map(s => s.buffer.duration));
    const sr     = S.ctx.sampleRate;
    // The export is ONE loop cycle and has to stay seamless, so the reverb can't
    // just be given a tail on the end. Instead render several cycles and keep the
    // last one: by then the room is in steady state, so its tail wraps correctly.
    const spc = offlineSpaceOpts();
    const frames = Math.max(1, Math.round(dur * sr));
    const reps = spc.amount > 0 ? Math.max(2, Math.ceil(2.5 / dur) + 1) : 1;
    const offCtx = new OfflineAudioContext(2, frames * reps, sr);
    // Same three mic busses, same room, same seats as the live monitor path —
    // this is what puts the room into the exported WAV.
    const space = await buildOfflineSpace(offCtx, offCtx.destination, spc);
    active.forEach(s => {
      const src = offCtx.createBufferSource();
      src.buffer = s.buffer; src.loop = true; src.loopEnd = s.buffer.duration;
      const g = offCtx.createGain();
      g.gain.value = s.gainNode ? s.gainNode.gain.value : (s.vol ?? 1);
      if (s.eq && !eqIsFlat(s.eq)) {                 // bake the per-loop EQ into the render
        const oeq = applyEqOffline(offCtx, snapshotEq(s.eq));
        src.connect(oeq.input); oeq.output.connect(g);
      } else {
        src.connect(g);
      }
      g.connect(space.seatFor(slotSeat(s.id), offCtx.destination));
      src.start(0);
    });
    const full = await offCtx.startRendering();
    const rendered = reps === 1 ? full : lastCycle(full, frames);
    const res = await finishExport(rendered, {
      fmt: document.getElementById('expFmt')?.value || 'wav',
      targetKey: document.getElementById('expTarget')?.value || 'off',
      baseName: (S.projectName || 'looper') + '-mix',
      readoutEl: document.getElementById('expReadout'),
      onStage: stage,
    });
    setStatus(`Exported ${res.name} — ${readoutText(res)}`);
  } catch (e) {
    console.warn('Export failed:', e);
    setStatus('Export failed: ' + e.message);
  } finally {
    exporting = false;
    if (btn) btn.textContent = label || '⬇ Export';
  }
}

// Keep only the final `frames` samples of a multi-cycle render — the cycle whose
// reverb tail is already in steady state, so the exported loop still joins itself.
function lastCycle(buf, frames) {
  const out = new AudioBuffer({
    numberOfChannels: buf.numberOfChannels, length: frames, sampleRate: buf.sampleRate,
  });
  const from = Math.max(0, buf.length - frames);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    out.getChannelData(c).set(buf.getChannelData(c).subarray(from, from + frames));
  }
  return out;
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
