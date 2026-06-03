// ── Polyphonic piano-roll sequencer ───────────────────────────────────────────
// A pitch×step grid (chords allowed). Plays the current synth voice locked to BPM,
// and can render the pattern straight into a loop slot with perfect timing.
import { S } from './state.js';
import { ensureCtx } from './core.js';
import { spawnVoice } from './synth.js';
import { drawWave, playSlot } from './loops.js';
import { fmtSec, setStatus } from './util.js';

const STEPS = 16;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LOW_MIDI = 48;       // C3
const ROWS = 24;           // two octaves, C3–B4

const midiToHz   = m => 440 * Math.pow(2, (m - 69) / 12);
const midiToName = m => NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);

// Rows top→bottom = high→low pitch (piano-roll orientation)
const PR = [];
for (let r = 0; r < ROWS; r++) {
  const midi = LOW_MIDI + (ROWS - 1 - r);
  PR.push({ midi, hz: midiToHz(midi), name: midiToName(midi), sharp: NOTE_NAMES[midi % 12].includes('#') });
}

export function setSynthMode(mode) {
  S.synthMode = mode;
  document.getElementById('keysView').style.display = mode === 'keys' ? '' : 'none';
  document.getElementById('rollView').style.display = mode === 'roll' ? '' : 'none';
  document.getElementById('keysModeBtn').classList.toggle('on', mode === 'keys');
  document.getElementById('rollModeBtn').classList.toggle('on', mode === 'roll');
  const seqOnly = mode === 'roll' ? '' : 'none';
  document.getElementById('pseqPlayBtn').style.display  = seqOnly;
  document.getElementById('pseqPushBtn').style.display  = seqOnly;
  document.getElementById('pseqResetBtn').style.display = seqOnly;
  if (mode === 'roll' && S.pseqCells.length === 0) buildPianoRoll();
}

export function buildPianoRoll() {
  const grid = document.getElementById('pianoRoll');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '46px repeat(' + STEPS + ',22px)';
  grid.style.gap = '1px';
  grid.innerHTML = '';
  S.pseqCells = [];
  PR.forEach((p, row) => {
    S.pseqCells.push([]);
    const lbl = document.createElement('div');
    lbl.className = 'proll-lbl' + (p.sharp ? ' sharp' : '');
    lbl.textContent = p.name;
    grid.appendChild(lbl);
    for (let s = 0; s < STEPS; s++) {
      const c = document.createElement('div');
      c.className = 'proll-cell' + (p.sharp ? ' sharp' : '') + (s % 4 === 0 && s > 0 ? ' proll-beat' : '');
      if (S.pseqPattern[row][s]) c.classList.add('on');
      c.addEventListener('pointerdown', e => {
        e.preventDefault();
        S.pseqPattern[row][s] = S.pseqPattern[row][s] ? 0 : 1;
        c.classList.toggle('on', !!S.pseqPattern[row][s]);
      });
      S.pseqCells[row].push(c);
      grid.appendChild(c);
    }
  });
}

export function clearPseq() {
  for (let r = 0; r < ROWS; r++)
    for (let s = 0; s < STEPS; s++) {
      S.pseqPattern[r][s] = 0;
      if (S.pseqCells.length) S.pseqCells[r][s].classList.remove('on');
    }
  setStatus('Piano roll cleared');
}

export function togglePseq() {
  ensureCtx();
  if (S.ctx.state === 'suspended') S.ctx.resume();
  S.pseqPlaying ? stopPseq() : startPseq();
}

export function startPseq() {
  S.pseqPlaying = true;
  const stepDur = (60 / S.bpm) / 4;
  // Share the transport grid with the drum sequencer if it's already running
  if (!S.seqPlaying || S.seqAnchor == null) S.seqAnchor = S.ctx.currentTime + 0.05;
  const stepsAhead = Math.max(0, Math.ceil((S.ctx.currentTime - S.seqAnchor) / stepDur));
  S.pseqNextTime = S.seqAnchor + stepsAhead * stepDur;
  S.pseqStep     = ((stepsAhead % STEPS) + STEPS) % STEPS;
  S.pseqTimerId  = setInterval(runPseq, 22);
  document.getElementById('pseqPlayBtn').textContent = '■ Stop';
  pseqVisLoop();
}

export function stopPseq() {
  S.pseqPlaying = false;
  clearInterval(S.pseqTimerId);
  document.getElementById('pseqPlayBtn').textContent = '▶ Play';
  S.pseqCells.forEach(row => row.forEach(c => c.classList.remove('cur')));
}

export function runPseq() {
  const stepDur = (60 / S.bpm) / 4;
  const gate = stepDur * 0.9;
  while (S.pseqNextTime < S.ctx.currentTime + 0.1) {
    const step = S.pseqStep;
    PR.forEach((p, row) => {
      if (S.pseqPattern[row][step]) spawnVoice(p.hz, { when: S.pseqNextTime, gate, vel: 0.85 });
    });
    S.pseqNextTime += stepDur;
    S.pseqStep = (S.pseqStep + 1) % STEPS;
  }
}

export function pseqVisLoop() {
  if (!S.pseqPlaying) return;
  const stepDur = (60 / S.bpm) / 4;
  const vis = Math.floor(Math.max(0, S.ctx.currentTime - S.seqAnchor) / stepDur) % STEPS;
  S.pseqCells.forEach(row => row.forEach((c, ci) => c.classList.toggle('cur', ci === vis)));
  requestAnimationFrame(pseqVisLoop);
}

// Render the pattern into the next empty loop slot — perfectly on the grid.
export async function pushPseqToLoop() {
  ensureCtx();
  if (S.ctx.state === 'suspended') S.ctx.resume();
  if (!S.pseqPattern.some(row => row.some(v => v))) {
    setStatus('Piano roll is empty — add some notes first'); return;
  }
  const id = S.slots.findIndex(s => s.state === 'empty' && !s.buffer);
  if (id < 0) { setStatus('No empty loop slot — clear one first'); return; }

  const sr      = S.ctx.sampleRate;
  const bar     = (60 / S.bpm) * 4;
  const stepDur = bar / STEPS;
  const gate    = stepDur * 0.9;
  const tail    = 1.5;
  const off     = new OfflineAudioContext(2, Math.ceil((bar + tail) * sr), sr);

  for (let step = 0; step < STEPS; step++) {
    const when = step * stepDur;
    PR.forEach((p, row) => {
      if (S.pseqPattern[row][step])
        spawnVoice(p.hz, { when, gate, vel: 0.85, actx: off, dest: off.destination });
    });
  }
  const rendered = await off.startRendering();

  // Fold the decay tail back onto the start for a seamless loop
  const barLen = Math.floor(bar * sr);
  const out = S.ctx.createBuffer(2, barLen, sr);
  for (let ch = 0; ch < 2; ch++) {
    const srcD = rendered.getChannelData(ch);
    const dstD = out.getChannelData(ch);
    for (let i = 0; i < barLen; i++) dstD[i] = srcD[i];
    for (let i = barLen; i < srcD.length; i++) dstD[i - barLen] += srcD[i];
  }

  const s = S.slots[id];
  s.buffer = out;
  document.getElementById('dur-' + id).textContent = fmtSec(out.duration);
  drawWave(id);
  if (S.masterLen === null) {
    S.masterLen = out.duration; S.masterAnchor = S.ctx.currentTime; S.masterSlot = id;
  }
  playSlot(id);
  setStatus('Piano roll pushed to Loop ' + (id + 1) + ' — perfectly timed');
}
