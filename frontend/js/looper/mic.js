// ── Microphone input + Autotune controls ─────────────────────────────────────
import { S } from './state.js';
import { ensureCtx } from './core.js';
import { setStatus } from './util.js';

// Allowed pitch-classes per scale (semitone offsets from the root)
export const AT_SCALES = {
  major:     [0, 2, 4, 5, 7, 9, 11],
  minor:     [0, 2, 3, 5, 7, 8, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};
// Default scale (state.js leaves atScale null until now)
if (!S.atScale) S.atScale = AT_SCALES.major;

export async function toggleMic() {
  ensureCtx();
  const ctx = S.ctx;
  if (S.micOn) {
    S.micSrc?.disconnect();
    S.micStream?.getTracks().forEach(t => t.stop());
    S.micSrc = null; S.micStream = null; S.micOn = false;
    document.getElementById('micBtn').classList.remove('on');
    document.getElementById('micStat').textContent = 'Click to enable mic';
    document.getElementById('micFill').style.width = '0%';
  } else {
    try {
      S.micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
      if (ctx.state === 'suspended') await ctx.resume();
      S.micSrc = ctx.createMediaStreamSource(S.micStream);
      S.micAna = ctx.createAnalyser(); S.micAna.fftSize = 256;
      // Compressor prevents mic clipping before the signal hits inputBus
      const micComp = ctx.createDynamicsCompressor();
      micComp.threshold.value = -22;
      micComp.knee.value      =   8;
      micComp.ratio.value     =   6;
      micComp.attack.value    = 0.003;
      micComp.release.value   = 0.12;
      S.micSrc.connect(micComp);
      // Insert autotune between the compressor and the bus (mix=0 = transparent until enabled)
      if (S.autotuneNode) {
        micComp.connect(S.autotuneNode);
        S.autotuneNode.connect(S.micAna);
        S.autotuneNode.connect(S.inputBus);
        S.autotuneNode.parameters.get('mix').setValueAtTime(S.autotuneOn ? 1 : 0, ctx.currentTime);
      } else {
        micComp.connect(S.micAna);
        micComp.connect(S.inputBus);
      }
      S.micOn = true;
      document.getElementById('micBtn').classList.add('on');
      document.getElementById('micStat').textContent = 'Live — voice goes into loops';
      meterLoop();
    } catch (_) {
      document.getElementById('micStat').textContent = 'Permission denied';
    }
  }
}

export function meterLoop() {
  if (!S.micOn || !S.micAna) return;
  const d = new Uint8Array(S.micAna.frequencyBinCount);
  (function tick() {
    if (!S.micOn) return;
    S.micAna.getByteFrequencyData(d);
    const avg = d.reduce((a, b) => a + b, 0) / d.length;
    document.getElementById('micFill').style.width = Math.min(100, avg * 2.2) + '%';
    requestAnimationFrame(tick);
  })();
}

// ── Autotune ──────────────────────────────────────────────────────────────────
export function toggleAutotune() {
  ensureCtx();
  S.autotuneOn = !S.autotuneOn;
  document.getElementById('atBtn').classList.toggle('on', S.autotuneOn);
  if (S.autotuneNode) S.autotuneNode.parameters.get('mix').setValueAtTime(S.autotuneOn ? 1 : 0, S.ctx.currentTime);
  setStatus(S.autotuneOn
    ? 'Autotune ON — enable the mic and sing; pitch snaps to the chosen key'
    : 'Autotune off');
}

export function setAtKey(sel)      { S.atRoot = parseInt(sel.value); sendAt(); }
export function setAtScaleSel(sel) { S.atScale = AT_SCALES[sel.value]; sendAt(); }
export function setAtSpeed(v) {
  S.atSpeed = parseFloat(v);
  if (S.autotuneNode) S.autotuneNode.parameters.get('speed').setValueAtTime(S.atSpeed, S.ctx.currentTime);
}
export function sendAt() {
  if (S.autotuneNode) S.autotuneNode.port.postMessage({ scale: S.atScale, root: S.atRoot });
}
