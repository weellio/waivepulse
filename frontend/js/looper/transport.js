// ── Transport: BPM, metronome, count-in, tap tempo, quantize ──────────────────
import { S } from './state.js';
import { ensureCtx } from './core.js';
import { setStatus } from './util.js';
import { stopSeq, startSeq } from './drums.js';
import { startArp } from './synth.js';

// ── Metronome ─────────────────────────────────────────────────────────────────
export function chBPM(d) {
  S.bpm = Math.max(40, Math.min(240, S.bpm + d));
  document.getElementById('bpmVal').textContent = S.bpm;
  if (S.metroOn) { clearInterval(S.metroTid); startMetro(); }
  if (S.seqPlaying) { stopSeq(); startSeq(); }
  if (S.arpOn) { startArp(); }
  if (S.delayFX && S.ctx) S.delayFX.delayTime.setValueAtTime(60 / S.bpm / 2, S.ctx.currentTime);
}

export function toggleMetro() {
  ensureCtx();
  if (S.ctx.state === 'suspended') S.ctx.resume();
  S.metroOn = !S.metroOn;
  const btn = document.getElementById('metroBtn');
  btn.classList.toggle('on', S.metroOn);
  btn.textContent = S.metroOn ? 'Metro ●' : 'Metronome';
  if (S.metroOn) { S.metroBeat = 0; startMetro(); }
  else { clearInterval(S.metroTid); document.querySelectorAll('.beat').forEach(b => b.classList.remove('on')); }
}

export function startMetro() {
  tickMetro();
  S.metroTid = setInterval(tickMetro, 60000 / S.bpm);
}

export function tickMetro() {
  document.querySelectorAll('.beat').forEach((el, i) => el.classList.toggle('on', i === S.metroBeat));
  playClick(S.metroBeat === 0);
  S.metroBeat = (S.metroBeat + 1) % 4;
}

export function playClick(accent) {
  if (!S.ctx) return;
  const t = S.ctx.currentTime;
  const osc = S.ctx.createOscillator();
  const g   = S.ctx.createGain();
  osc.frequency.value = accent ? 1200 : 800;
  g.gain.setValueAtTime(accent ? 0.45 : 0.22, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
  osc.connect(g); g.connect(S.ctx.destination);
  osc.start(t); osc.stop(t + 0.04);
}

export function chCountIn(delta) {
  S.countIn = Math.max(0, Math.min(4, S.countIn + delta));
  document.getElementById('countInVal').textContent = S.countIn === 0 ? 'off' : S.countIn;
}

// ── Tap tempo ─────────────────────────────────────────────────────────────────
const tapTimes = [];
export function tapTempo() {
  ensureCtx();
  const now = Date.now();
  if (tapTimes.length && now - tapTimes[tapTimes.length - 1] > 2500) tapTimes.length = 0;
  tapTimes.push(now);
  if (tapTimes.length > 8) tapTimes.shift();
  if (tapTimes.length >= 2) {
    let sum = 0;
    for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i-1];
    S.bpm = Math.max(40, Math.min(240, Math.round(60000 / (sum / (tapTimes.length-1)))));
    document.getElementById('bpmVal').textContent = S.bpm;
    if (S.metroOn) { clearInterval(S.metroTid); startMetro(); }
    if (S.seqPlaying) { stopSeq(); startSeq(); }
    if (S.arpOn) { startArp(); }
    if (S.delayFX) S.delayFX.delayTime.setValueAtTime(60/S.bpm/2, S.ctx.currentTime);
    setStatus('BPM → ' + S.bpm);
  }
}

// ── Quantize ──────────────────────────────────────────────────────────────────
export function toggleQuantize() {
  S.quantize = !S.quantize;
  document.getElementById('quantBtn').classList.toggle('on', S.quantize);
  setStatus(S.quantize ? 'Quantize ON — first loop snaps to nearest bar' : 'Quantize off');
}

export function quantizeLen(len) {
  const bar = (60 / S.bpm) * 4;
  return bar * Math.max(1, Math.round(len / bar));
}
