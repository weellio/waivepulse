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

// ── Live notation (grand staff) read-out of the piano roll ────────────────────
// Treble (C4–B4) over bass (C3–B3), middle C on its ledger line between them — so
// it reads like real sheet music instead of a square grid.
const SM = { topY: 16, hg: 4.5, leftPad: 60, colW: 30 };   // hg = half a staff space (9px/line)
const PC_LETTER = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];     // pitch-class → diatonic letter index
const PC_SHARP  = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];     // …and whether it carries a sharp
const diaOf   = m => (Math.floor(m / 12) - 1) * 7 + PC_LETTER[m % 12];
const isSharp = m => PC_SHARP[m % 12] === 1;
const smY     = dia => SM.topY + (38 - dia) * SM.hg;        // F5(dia 38) sits at topY

// A run of contiguous filled cells in a row = one held note (start step + length in
// 16ths). This is the shared truth for both playback and notation.
function pseqRuns() {
  const runs = [];
  for (let row = 0; row < ROWS; row++) {
    let s = 0;
    while (s < STEPS) {
      if (!S.pseqPattern[row][s]) { s++; continue; }
      let len = 1;
      while (s + len < STEPS && S.pseqPattern[row][s + len]) len++;
      const midi = PR[row].midi;
      runs.push({ row, midi, hz: PR[row].hz, dia: diaOf(midi), sharp: isSharp(midi), start: s, len });
      s += len;
    }
  }
  return runs;
}

// Map a length (in 16ths) to a notation duration. beams≥1 = flagged (8th/16th);
// open = hollow notehead; dot = augmentation dot. Non-standard lengths snap to the
// nearest entry for display (playback still uses the exact length).
const DUR_TABLE = [
  { n: 16, open: true,  stem: false, beams: 0, dot: false },  // whole
  { n: 12, open: true,  stem: true,  beams: 0, dot: true  },  // dotted half
  { n: 8,  open: true,  stem: true,  beams: 0, dot: false },  // half
  { n: 6,  open: false, stem: true,  beams: 0, dot: true  },  // dotted quarter
  { n: 4,  open: false, stem: true,  beams: 0, dot: false },  // quarter
  { n: 3,  open: false, stem: true,  beams: 1, dot: true  },  // dotted eighth
  { n: 2,  open: false, stem: true,  beams: 1, dot: false },  // eighth
  { n: 1,  open: false, stem: true,  beams: 2, dot: false },  // sixteenth
];
function durSpec(len) {
  let best = DUR_TABLE[0], bd = Infinity;
  for (const d of DUR_TABLE) { const diff = Math.abs(d.n - len); if (diff < bd) { bd = diff; best = d; } }
  return best;
}

export function renderSheet() {
  const svg = document.getElementById('sheetMusic');
  if (!svg) return;
  const x0 = SM.leftPad, xN = SM.leftPad + SM.colW * STEPS, p = [];

  // staff lines — treble E4..F5 (30,32,34,36,38), bass G2..A3 (18,20,22,24,26)
  for (const d of [30, 32, 34, 36, 38, 18, 20, 22, 24, 26])
    p.push(`<line class="sm-line" x1="${x0}" y1="${smY(d)}" x2="${xN}" y2="${smY(d)}"/>`);

  // left brace + a barline every beat (4 steps) + a heavier final bar
  p.push(`<path class="sm-brace" d="M${x0 - 7} ${smY(38)} q-6 ${(smY(18) - smY(38)) / 2} 0 ${smY(18) - smY(38)}"/>`);
  for (let b = 0; b <= 4; b++) {
    const x = x0 + b * 4 * SM.colW;
    p.push(`<line class="sm-bar${b === 4 ? ' end' : ''}" x1="${x}" y1="${smY(38)}" x2="${x}" y2="${smY(18)}"/>`);
  }

  // clefs (Segoe UI Symbol covers the Musical Symbols block on Windows), tempo, 4/4
  p.push(`<text class="sm-clef" x="6" y="${smY(30) + 2}" font-size="36">𝄞</text>`);   // 𝄞
  p.push(`<text class="sm-clef" x="8" y="${smY(25)}" font-size="27">𝄢</text>`);        // 𝄢
  p.push(`<text class="sm-text" x="2" y="11">♩ = ${S.bpm}</text>`);
  p.push(`<text class="sm-clef" x="${x0 - 17}" y="${smY(35)}" font-size="15">4</text>`);
  p.push(`<text class="sm-clef" x="${x0 - 17}" y="${smY(31)}" font-size="15">4</text>`);

  // playback cursor (positioned live by pseqVisLoop)
  p.push(`<line id="sheetCursor" class="sm-cursor" x1="0" y1="${smY(38) + 2}" x2="0" y2="${smY(18) - 2}"/>`);

  // ── notes ──────────────────────────────────────────────────────────────────
  const STEM = 26;                                   // stem length (px)
  const noteX = step => x0 + step * SM.colW + SM.colW / 2;
  const down  = dia => dia >= 28;                    // ≥ middle C → stem down, else up
  const runs  = pseqRuns();

  // Stems first, then beams/flags, then noteheads on top — so heads aren't covered.
  // (1) plain stems for un-flagged notes (quarter / half / dotted-half)
  for (const n of runs) {
    const d = durSpec(n.len);
    if (d.beams >= 1 || !d.stem) continue;
    const y = smY(n.dia), x = noteX(n.start), dn = down(n.dia), sx = x + (dn ? -5 : 5);
    p.push(`<line class="sm-stem" x1="${sx}" y1="${y}" x2="${sx}" y2="${y + (dn ? STEM : -STEM)}"/>`);
  }

  // (2) beam groups: flagged notes (8th/16th) grouped by the beat of their onset
  const beats = {};
  for (const n of runs) {
    if (durSpec(n.len).beams < 1) continue;
    const beat = Math.floor(n.start / 4);
    ((beats[beat] = beats[beat] || {})[n.start] = beats[beat][n.start] || []).push(n);
  }
  for (const beat in beats) {
    const stepMap = beats[beat];
    const steps = Object.keys(stepMap).map(Number).sort((a, b) => a - b);
    // direction by the group's average pitch
    let sum = 0, cnt = 0;
    for (const s of steps) for (const n of stepMap[s]) { sum += n.dia; cnt++; }
    const dn = (sum / cnt) >= 28, dir = dn ? 1 : -1;
    // extreme notehead per onset (stem attaches there) + its pre-slope stem end
    const ext = {}, endY = {};
    for (const s of steps) {
      const dias = stepMap[s].map(n => n.dia);
      ext[s]  = dn ? Math.min(...dias) : Math.max(...dias);
      endY[s] = smY(ext[s]) + dir * STEM;
    }
    const sF = steps[0], sL = steps[steps.length - 1];
    const xF = noteX(sF), xL = noteX(sL);
    let yF = endY[sF], yL = endY[sL];
    // slope follows the run's contour (up/down a scale), gently clamped
    const MAXSL = 16;
    if (yL - yF >  MAXSL) yL = yF + MAXSL;
    if (yL - yF < -MAXSL) yL = yF - MAXSL;
    const beamY = x => (xL === xF) ? yF : yF + (yL - yF) * (x - xF) / (xL - xF);
    const sxOf  = x => x + (dn ? -5 : 5);

    if (steps.length === 1) {
      // isolated 8th/16th → flag(s), not a beam
      const s = steps[0], x = noteX(s), ay = smY(ext[s]), by = ay + dir * STEM, sx = sxOf(x);
      p.push(`<line class="sm-stem" x1="${sx}" y1="${ay}" x2="${sx}" y2="${by}"/>`);
      const nb = Math.max(...stepMap[s].map(n => durSpec(n.len).beams));
      for (let f = 0; f < nb; f++) {
        const fy = by - dir * f * 6;
        p.push(`<path class="sm-flag" d="M${sx} ${fy} q9 ${dir * 4} 7 ${dir * 13}"/>`);
      }
    } else {
      // stems to the beam line
      for (const s of steps) {
        const x = noteX(s), sx = sxOf(x);
        p.push(`<line class="sm-stem" x1="${sx}" y1="${smY(ext[s])}" x2="${sx}" y2="${beamY(x)}"/>`);
      }
      // primary beam (one continuous slanted bar)
      p.push(`<line class="sm-beam" x1="${sxOf(xF)}" y1="${beamY(xF)}" x2="${sxOf(xL)}" y2="${beamY(xL)}"/>`);
      // secondary beam for 16ths: full segment between adjacent 16ths, stub otherwise
      const is16 = s => stepMap[s].some(n => durSpec(n.len).beams >= 2);
      const off  = dn ? -4 : 4;          // sits between the primary beam and the noteheads
      for (let i = 0; i < steps.length; i++) {
        const s = steps[i]; if (!is16(s)) continue;
        const x = noteX(s), sx = sxOf(x);
        const next = steps[i + 1], prev = steps[i - 1];
        if (next != null && is16(next)) {
          const x2 = noteX(next);
          p.push(`<line class="sm-beam2" x1="${sx}" y1="${beamY(x) + off}" x2="${sxOf(x2)}" y2="${beamY(x2) + off}"/>`);
        } else if (!(prev != null && is16(prev))) {
          const dirStub = next != null ? 1 : -1, xs = x + dirStub * 9;
          p.push(`<line class="sm-beam2" x1="${sx}" y1="${beamY(x) + off}" x2="${sxOf(xs)}" y2="${beamY(xs) + off}"/>`);
        }
      }
    }
  }

  // (3) noteheads (+ ledger, accidental, dot) — drawn last, on top
  for (const n of runs) {
    const d = durSpec(n.len), y = smY(n.dia), x = noteX(n.start);
    if (n.dia === 28) p.push(`<line class="sm-ledger" x1="${x - 8}" y1="${y}" x2="${x + 8}" y2="${y}"/>`);
    if (n.sharp) p.push(`<text class="sm-acc" x="${x - 15}" y="${y + 5}">♯</text>`);
    p.push(`<ellipse class="sm-note${d.open ? ' open' : ''}" cx="${x}" cy="${y}" rx="${d.open ? 5.4 : 5.2}" ry="3.9" transform="rotate(-20 ${x} ${y})"/>`);
    if (d.dot) { const dy = (n.dia % 2 === 0) ? y - SM.hg : y; p.push(`<circle class="sm-note" cx="${x + 9}" cy="${dy}" r="1.6"/>`); }
  }

  svg.innerHTML = p.join('');
}

export function setSynthMode(mode) {
  S.synthMode = mode;
  document.getElementById('keysView').style.display = mode === 'keys' ? '' : 'none';
  document.getElementById('rollView').style.display = mode === 'roll' ? '' : 'none';
  // Roll mode: card becomes two columns (roll left at full height, controls right) so
  // the 24-row grid never needs to scroll. Keys mode stays a single full-width column.
  document.getElementById('keysView').closest('.rcard').classList.toggle('roll-layout', mode === 'roll');
  document.getElementById('keysModeBtn').classList.toggle('on', mode === 'keys');
  document.getElementById('rollModeBtn').classList.toggle('on', mode === 'roll');
  const seqOnly = mode === 'roll' ? '' : 'none';
  document.getElementById('pseqPlayBtn').style.display  = seqOnly;
  document.getElementById('pseqPushBtn').style.display  = seqOnly;
  document.getElementById('pseqResetBtn').style.display = seqOnly;
  if (mode === 'roll' && S.pseqCells.length === 0) buildPianoRoll();
  renderSheet();
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
        renderSheet();                  // keep the notation in sync with the grid
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
  renderSheet();
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
  const cur = document.getElementById('sheetCursor'); if (cur) cur.style.opacity = 0;
}

export function runPseq() {
  const stepDur = (60 / S.bpm) / 4;
  const runs = pseqRuns();
  while (S.pseqNextTime < S.ctx.currentTime + 0.1) {
    const step = S.pseqStep;
    // spawn one sustained voice per run that STARTS on this step (held = its length)
    for (const r of runs) {
      if (r.start !== step) continue;
      spawnVoice(r.hz, { when: S.pseqNextTime, gate: r.len * stepDur * 0.92, vel: 0.85 });
    }
    S.pseqNextTime += stepDur;
    S.pseqStep = (S.pseqStep + 1) % STEPS;
  }
}

export function pseqVisLoop() {
  if (!S.pseqPlaying) return;
  const stepDur = (60 / S.bpm) / 4;
  const vis = Math.floor(Math.max(0, S.ctx.currentTime - S.seqAnchor) / stepDur) % STEPS;
  S.pseqCells.forEach(row => row.forEach((c, ci) => c.classList.toggle('cur', ci === vis)));
  const cur = document.getElementById('sheetCursor');
  if (cur) { const x = SM.leftPad + vis * SM.colW + SM.colW / 2; cur.setAttribute('x1', x); cur.setAttribute('x2', x); cur.style.opacity = 0.9; }
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
  const tail    = 1.5;
  const off     = new OfflineAudioContext(2, Math.ceil((bar + tail) * sr), sr);

  // one sustained voice per run (held note), so the render matches what you hear/see
  for (const r of pseqRuns()) {
    spawnVoice(r.hz, { when: r.start * stepDur, gate: r.len * stepDur * 0.95, vel: 0.85, actx: off, dest: off.destination });
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
