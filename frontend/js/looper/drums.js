// ── Drum synth, pads, and step sequencer ──────────────────────────────────────
import { S } from './state.js';
import { ensureCtx } from './core.js';
import { fmtSec, setStatus } from './util.js';
import { drawWave, playSlot } from './loops.js';
import { swingOffset, stepSpan, humanizeTime, humanizeVel, ratchetHits, nextProb, nextRatchet, euclid } from './groove.js';

// ── Drum synth ────────────────────────────────────────────────────────────────
function gn(t, peak, decay) {
  const g = S.ctx.createGain();
  g.gain.setValueAtTime(peak, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
  return g;
}

export function playKick(when, vel) {
  const ctx = S.ctx;
  const t = when ?? ctx.currentTime, v = vel ?? 1;
  const osc = ctx.createOscillator();
  const g = gn(t, 1.3 * v, 0.44);
  osc.frequency.setValueAtTime(155, t);
  osc.frequency.exponentialRampToValueAtTime(0.001, t + 0.44);
  osc.connect(g); g.connect(S.inputBus);
  osc.start(t); osc.stop(t + 0.5);
}

export function playSnare(when, vel) {
  const ctx = S.ctx;
  const t = when ?? ctx.currentTime, sr = ctx.sampleRate, v = vel ?? 1;
  const nb = ctx.createBuffer(1, Math.floor(sr * 0.22), sr);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const ns = ctx.createBufferSource(); ns.buffer = nb;
  const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 2200; nf.Q.value = 0.6;
  const ng = gn(t, 0.7 * v, 0.22);
  ns.connect(nf); nf.connect(ng); ng.connect(S.inputBus);
  ns.start(t); ns.stop(t + 0.25);
  const osc = ctx.createOscillator();
  const og = gn(t, 0.5 * v, 0.08);
  osc.frequency.setValueAtTime(230, t);
  osc.frequency.exponentialRampToValueAtTime(160, t + 0.08);
  osc.connect(og); og.connect(S.inputBus);
  osc.start(t); osc.stop(t + 0.1);
}

export function playHiHat(when, vel) {
  const ctx = S.ctx;
  const t = when ?? ctx.currentTime, sr = ctx.sampleRate, v = vel ?? 1;
  const nb = ctx.createBuffer(1, Math.floor(sr * 0.05), sr);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const ns = ctx.createBufferSource(); ns.buffer = nb;
  const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 8000;
  const ng = gn(t, 0.44 * v, 0.055);
  ns.connect(nf); nf.connect(ng); ng.connect(S.inputBus);
  ns.start(t); ns.stop(t + 0.07);
}

export function playOpenHH(when, vel) {
  const ctx = S.ctx;
  const t = when ?? ctx.currentTime, sr = ctx.sampleRate, v = vel ?? 1;
  const nb = ctx.createBuffer(1, Math.floor(sr * 0.4), sr);
  const nd = nb.getChannelData(0);
  for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
  const ns = ctx.createBufferSource(); ns.buffer = nb;
  const nf = ctx.createBiquadFilter(); nf.type = 'highpass'; nf.frequency.value = 7000;
  const ng = gn(t, 0.36 * v, 0.4);
  ns.connect(nf); nf.connect(ng); ng.connect(S.inputBus);
  ns.start(t); ns.stop(t + 0.45);
}

export function playClap(when, vel) {
  const ctx = S.ctx;
  const base = when ?? ctx.currentTime, v = vel ?? 1;
  [0, 0.01, 0.022].forEach(delay => {
    const t = base + delay, sr = ctx.sampleRate;
    const nb = ctx.createBuffer(1, Math.floor(sr * 0.06), sr);
    const nd = nb.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const ns = ctx.createBufferSource(); ns.buffer = nb;
    const nf = ctx.createBiquadFilter(); nf.type = 'bandpass'; nf.frequency.value = 1800; nf.Q.value = 0.7;
    const ng = gn(t, 0.65 * v, 0.07);
    ns.connect(nf); nf.connect(ng); ng.connect(S.inputBus);
    ns.start(t); ns.stop(t + 0.1);
  });
}

export function playTom(when, vel) {
  const ctx = S.ctx;
  const t = when ?? ctx.currentTime, v = vel ?? 1;
  const osc = ctx.createOscillator();
  const g = gn(t, 0.9 * v, 0.3);
  osc.frequency.setValueAtTime(210, t);
  osc.frequency.exponentialRampToValueAtTime(55, t + 0.3);
  osc.connect(g); g.connect(S.inputBus);
  osc.start(t); osc.stop(t + 0.35);
}

export function play808(when, vel) {
  const ctx = S.ctx;
  const t = when ?? ctx.currentTime, v = vel ?? 1;
  const osc = ctx.createOscillator();
  const g = gn(t, 1.0 * v, 0.65);
  const dist = ctx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const x = i * 2 / 256 - 1; curve[i] = Math.tanh(x * 2.2); }
  dist.curve = curve;
  osc.frequency.setValueAtTime(90, t);
  osc.frequency.exponentialRampToValueAtTime(35, t + 0.65);
  osc.connect(dist); dist.connect(g); g.connect(S.inputBus);
  osc.start(t); osc.stop(t + 0.75);
}

export function playPerc(when, vel) {
  const ctx = S.ctx;
  const t = when ?? ctx.currentTime, v = vel ?? 1;
  const osc = ctx.createOscillator(); osc.type = 'triangle';
  const g = gn(t, 0.52 * v, 0.09);
  osc.frequency.setValueAtTime(680, t);
  osc.frequency.exponentialRampToValueAtTime(340, t + 0.09);
  osc.connect(g); g.connect(S.inputBus);
  osc.start(t); osc.stop(t + 0.12);
}

export const DRUMS = [
  {name:'Kick',   icon:'🥁', key:'1', play: playKick   },
  {name:'Snare',  icon:'🎯', key:'2', play: playSnare  },
  {name:'HiHat',  icon:'🔔', key:'3', play: playHiHat  },
  {name:'Open',   icon:'🎵', key:'4', play: playOpenHH },
  {name:'Clap',   icon:'👏', key:'5', play: playClap   },
  {name:'Tom',    icon:'🥁', key:'6', play: playTom    },
  {name:'808',    icon:'〰️', key:'7', play: play808    },
  {name:'Perc',   icon:'✨', key:'8', play: playPerc   },
];

// Global left-button state — drives the click-and-drag "slide" (glissando) effect
document.addEventListener('mousedown', e => { if (e.button === 0) S.isMouseDown = true; });
document.addEventListener('mouseup',   ()  => { S.isMouseDown = false; });

export function buildDrums() {
  const grid = document.getElementById('drumGrid');
  DRUMS.forEach(d => {
    const btn = document.createElement('button');
    btn.className = 'dpad'; btn.id = 'dp-' + d.key;
    btn.innerHTML = `<span class="di">${d.icon}</span>${d.name}<span class="dk">${d.key}</span>`;
    const trigger = e => { e.preventDefault(); hitDrum(d); };
    btn.addEventListener('mousedown', trigger);
    btn.addEventListener('touchstart', trigger, {passive: false});
    // Slide: dragging across pads with the button held re-triggers each one
    btn.addEventListener('mouseenter', () => { if (S.isMouseDown) hitDrum(d); });
    grid.appendChild(btn);
  });
}

export function hitDrum(d, vel) {
  ensureCtx();
  if (S.ctx.state === 'suspended') S.ctx.resume();
  d.play(undefined, vel);             // vel undefined = full (pads/keys); MIDI passes its velocity
  const el = document.getElementById('dp-' + d.key);
  if (el) { el.classList.add('hit'); setTimeout(() => el.classList.remove('hit'), 110); }
}

// ── Step sequencer ────────────────────────────────────────────────────────────
const SEQ_STEPS = 16;
const SEQ_COLORS = ['#f97316','#fbbf24','#60a5fa','#34d399','#f472b6','#a78bfa','#fb923c','#e879f9'];

export function setDrumMode(mode) {
  S.drumMode = mode;
  document.getElementById('padView').style.display  = mode === 'pads' ? '' : 'none';
  document.getElementById('seqView').style.display  = mode === 'seq'  ? '' : 'none';
  document.getElementById('padModeBtn').classList.toggle('on', mode === 'pads');
  document.getElementById('seqModeBtn').classList.toggle('on', mode === 'seq');
  const seqOnly = mode === 'seq' ? '' : 'none';
  document.getElementById('seqPlayBtn').style.display  = seqOnly;
  document.getElementById('seqPushBtn').style.display  = seqOnly;
  document.getElementById('seqResetBtn').style.display = seqOnly;
  if (mode === 'seq' && S.seqCells.length === 0) buildSeq();
}

// Clear every step (start a fresh pattern)
export function clearSeq() {
  for (let row = 0; row < S.seqPattern.length; row++) {
    for (let s = 0; s < SEQ_STEPS; s++) {
      S.seqPattern[row][s] = 0;
      S.seqProb[row][s] = 1;
      S.seqRatchet[row][s] = 1;
      if (S.seqCells.length) paintSeqCell(row, s);
    }
  }
  setStatus('Sequencer cleared');
}

// Render the current pattern to an empty loop slot — perfectly on-grid, no live recording.
export async function pushSeqToLoop() {
  ensureCtx();
  if (S.ctx.state === 'suspended') S.ctx.resume();
  if (!S.seqPattern.some(row => row.some(v => v))) {
    setStatus('Sequencer is empty — add some steps first'); return;
  }
  const id = S.slots.findIndex(s => s.state === 'empty' && !s.buffer);
  if (id < 0) { setStatus('No empty loop slot — clear one first'); return; }

  const sr      = S.ctx.sampleRate;
  const bar     = (60 / S.bpm) * 4;          // 16 sixteenth-notes = one 4/4 bar
  const stepDur = bar / SEQ_STEPS;
  const tail    = 1.0;                         // let decays ring out, then wrap them
  const off     = new OfflineAudioContext(2, Math.ceil((bar + tail) * sr), sr);

  // Temporarily point the drum synths at the offline graph, schedule, then restore.
  const savedCtx = S.ctx, savedBus = S.inputBus;
  S.ctx = off; S.inputBus = off.destination;
  try {
    // same swing / probability / ratchet / humanize path as live playback
    for (let step = 0; step < SEQ_STEPS; step++) scheduleDrumStep(step, step * stepDur, stepDur, 0);
  } finally {
    S.ctx = savedCtx; S.inputBus = savedBus;
  }
  const rendered = await off.startRendering();

  // Fold the decay tail (past the bar end) back onto the start so the loop joins seamlessly.
  const barLen = Math.floor(bar * sr);
  const out = savedCtx.createBuffer(2, barLen, sr);
  for (let ch = 0; ch < 2; ch++) {
    const src = rendered.getChannelData(ch);
    const dst = out.getChannelData(ch);
    for (let i = 0; i < barLen; i++) dst[i] = src[i];
    for (let i = barLen; i < src.length; i++) dst[i - barLen] += src[i];
  }

  // Load it into the slot like a finished recording.
  const s = S.slots[id];
  s.buffer = out;
  document.getElementById('dur-' + id).textContent = fmtSec(out.duration);
  drawWave(id);
  if (S.masterLen === null) {
    S.masterLen    = out.duration;
    S.masterAnchor = savedCtx.currentTime;
    S.masterSlot   = id;
  }
  playSlot(id);
  setStatus('Beat pushed to Loop ' + (id + 1) + (S.swing ? ' — swung ' + Math.round(S.swing * 100) + '%' : ' — perfectly timed'));
}

export function buildSeq() {
  const grid = document.getElementById('seqGrid');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = '40px 16px repeat(' + SEQ_STEPS + ',19px)';
  grid.style.gap = '2px';
  grid.innerHTML = '';
  S.seqCells = [];
  DRUMS.forEach((d, row) => {
    S.seqCells.push([]);
    const lbl = document.createElement('div');
    lbl.className = 'seq-lbl';
    lbl.textContent = d.name;
    lbl.style.color = SEQ_COLORS[row];
    grid.appendChild(lbl);
    // "E" = Euclidean fill for this row
    const eb = document.createElement('button');
    eb.className = 'seq-euclid';
    eb.textContent = 'E';
    eb.title = 'Euclidean fill — spread N hits evenly across the 16 steps (with rotation)';
    eb.addEventListener('click', () => euclidFill(row));
    grid.appendChild(eb);
    for (let s = 0; s < SEQ_STEPS; s++) {
      const c = document.createElement('div');
      c.className = 'seq-step' + (s % 4 === 0 && s > 0 ? ' seq-beat-line' : '');
      c.style.setProperty('--spc', SEQ_COLORS[row]);
      const fill = document.createElement('div');
      fill.className = 'seq-fill';
      c.appendChild(fill);
      const badge = document.createElement('span');     // probability % (e.g. "50")
      badge.className = 'seq-badge';
      c.appendChild(badge);
      S.seqCells[row].push({ el: c, fill, badge });

      // Click toggles on/off; vertical drag (or wheel) sets velocity like a fader.
      // Prob / Ratchet edit modes (or Alt / Shift + click) cycle the step's modifiers.
      let dragging = false, moved = false, startY = 0, startVel = 0;
      c.addEventListener('pointerdown', e => {
        e.preventDefault();
        const kind = e.altKey ? 'prob' : e.shiftKey ? 'ratchet' : (S.stepEdit !== 'steps' ? S.stepEdit : null);
        if (kind) { cycleStep(row, s, kind); return; }
        dragging = true; moved = false; startY = e.clientY;
        startVel = S.seqPattern[row][s] || 0.8;
        c.setPointerCapture(e.pointerId);
      });
      c.addEventListener('pointermove', e => {
        if (!dragging) return;
        if (Math.abs(e.clientY - startY) > 2) moved = true;
        if (moved) {
          S.seqPattern[row][s] = Math.max(0.1, Math.min(1, startVel + (startY - e.clientY) / 70));
          paintSeqCell(row, s);
        }
      });
      c.addEventListener('pointerup', () => {
        if (!dragging) return;
        dragging = false;
        if (!moved) {                                  // a tap = toggle
          S.seqPattern[row][s] = S.seqPattern[row][s] ? 0 : 0.8;
          if (!S.seqPattern[row][s]) { S.seqProb[row][s] = 1; S.seqRatchet[row][s] = 1; }   // off = forget modifiers
          paintSeqCell(row, s);
        }
      });
      c.addEventListener('wheel', e => {               // wheel = fine velocity
        if (!S.seqPattern[row][s]) return;
        e.preventDefault();
        S.seqPattern[row][s] = Math.max(0.1, Math.min(1, S.seqPattern[row][s] - Math.sign(e.deltaY) * 0.08));
        paintSeqCell(row, s);
      }, { passive: false });

      grid.appendChild(c);
    }
  });
  DRUMS.forEach((d, row) => { for (let s = 0; s < SEQ_STEPS; s++) paintSeqCell(row, s); });
}

export function paintSeqCell(row, s) {
  const cell = S.seqCells[row][s];
  const v = S.seqPattern[row][s] || 0;
  const p = S.seqProb[row][s] ?? 1, r = S.seqRatchet[row][s] ?? 1;
  cell.el.classList.toggle('on', v > 0);
  cell.el.classList.toggle('prob', v > 0 && p < 1);
  cell.fill.style.height = (v * 100) + '%';
  // probability → fainter fill + a tiny % badge; ratchet → the fill splits into N slices
  cell.fill.style.opacity = v > 0 && p < 1 ? (0.3 + 0.55 * p).toFixed(2) : '';
  cell.fill.style.backgroundImage = v > 0 && r > 1
    ? `repeating-linear-gradient(90deg, transparent 0 calc(${100 / r}% - 1.5px), rgba(0,0,0,.75) calc(${100 / r}% - 1.5px) ${100 / r}%)`
    : '';
  cell.badge.textContent = v > 0 && p < 1 ? String(Math.round(p * 100)) : '';
  cell.el.title = v > 0 ? `vel ${Math.round(v * 100)}% · chance ${Math.round(p * 100)}% · ${r} hit${r > 1 ? 's' : ''}` : '';
}

export function toggleSeq() {
  ensureCtx();
  if (S.ctx.state === 'suspended') S.ctx.resume();
  S.seqPlaying ? stopSeq() : startSeq();
}

export function startSeq() {
  S.seqPlaying = true;
  const stepDur = (60 / S.bpm) / 4;
  // Share the transport grid with the piano roll if it's already running
  if (!S.pseqPlaying || S.seqAnchor == null) S.seqAnchor = S.ctx.currentTime + 0.05;
  const stepsAhead = Math.max(0, Math.ceil((S.ctx.currentTime - S.seqAnchor) / stepDur));
  S.seqNextTime = S.seqAnchor + stepsAhead * stepDur;
  S.seqStep     = ((stepsAhead % SEQ_STEPS) + SEQ_STEPS) % SEQ_STEPS;
  S.seqTimerId  = setInterval(runSeq, 22);
  document.getElementById('seqPlayBtn').textContent = '■ Stop';
  seqVisLoop();
}

export function stopSeq() {
  S.seqPlaying = false;
  clearInterval(S.seqTimerId);
  document.getElementById('seqPlayBtn').textContent = '▶ Play';
  S.seqCells.forEach(row => row.forEach(c => c.el.classList.remove('cur')));
}

export function runSeq() {
  const stepDur = (60 / S.bpm) / 4;
  while (S.seqNextTime < S.ctx.currentTime + 0.1) {
    scheduleDrumStep(S.seqStep, S.seqNextTime, stepDur, S.ctx.currentTime);
    S.seqNextTime += stepDur;
    S.seqStep = (S.seqStep + 1) % SEQ_STEPS;
  }
}

export function seqVisLoop() {
  if (!S.seqPlaying) return;
  const stepDur = (60 / S.bpm) / 4;
  const vis = Math.floor(Math.max(0, S.ctx.currentTime - S.seqAnchor) / stepDur) % SEQ_STEPS;
  S.seqCells.forEach((row) => row.forEach((c, ci) => c.el.classList.toggle('cur', ci === vis)));
  requestAnimationFrame(seqVisLoop);
}

// ── Step scheduling (shared by live playback and → Loop render) ───────────────
// gridTime = the step's straight-grid time; swing, probability, ratchets and
// humanize are all applied here so every path sounds the same. `floor` keeps
// humanized hits from landing in the past (live) or before 0 (render).
export function scheduleDrumStep(step, gridTime, stepDur, floor) {
  const t0   = gridTime + swingOffset(step, stepDur, S.swing);
  const span = stepSpan(step, stepDur, S.swing);
  DRUMS.forEach((d, row) => {
    const v = S.seqPattern[row][step];
    if (!v) return;
    const p = S.seqProb[row][step] ?? 1;
    if (p < 1 && Math.random() >= p) return;                 // probability roll
    for (const h of ratchetHits(S.seqRatchet[row][step] ?? 1, span, v)) {
      const when = Math.max(floor, t0 + h.dt + humanizeTime(S.humanize));
      d.play(when, humanizeVel(h.vel, S.humanize));
    }
  });
}

// ── Step edit mode: what a plain click on a step does ─────────────────────────
// steps = toggle on/off (+ drag for velocity) · prob = cycle 100/75/50/25% ·
// ratchet = cycle 1/2/3/4 hits. Alt-click = prob and Shift-click = ratchet in any mode.
export function setStepEdit(mode) {
  S.stepEdit = mode;
  document.querySelectorAll('.stepedit-btn').forEach(b => b.classList.toggle('on', b.dataset.mode === mode));
  setStatus({ steps: 'Click toggles steps · drag = velocity',
              prob: 'Click an ON step to cycle its chance: 100 → 75 → 50 → 25%',
              ratchet: 'Click an ON step to cycle its ratchet: 1 → 2 → 3 → 4 hits' }[mode] || '');
}

function cycleStep(row, s, kind) {
  if (!S.seqPattern[row][s]) { S.seqPattern[row][s] = 0.8; paintSeqCell(row, s); return; }   // off → just turn it on
  if (kind === 'prob') S.seqProb[row][s]    = nextProb(S.seqProb[row][s]);
  else                 S.seqRatchet[row][s] = nextRatchet(S.seqRatchet[row][s]);
  paintSeqCell(row, s);
}

// ── Euclidean fill for one drum row ───────────────────────────────────────────
export function euclidFill(row) {
  const d = DRUMS[row];
  const cur = S.seqPattern[row].filter(v => v).length || 4;
  const ans = prompt(`Euclidean fill — ${d.name}\nHits (1–16), rotation (0–15). e.g. "5, 2"`, cur + ', 0');
  if (ans == null) return;
  const nums = ans.split(/[^0-9-]+/).filter(Boolean).map(Number);
  const hits = Math.max(1, Math.min(SEQ_STEPS, nums[0] || 0));
  if (!nums.length || !Number.isFinite(nums[0])) { setStatus('Euclid: enter a hit count 1–16'); return; }
  const rot = nums[1] || 0;
  const pat = euclid(hits, SEQ_STEPS, rot);
  const vel = S.seqPattern[row].find(v => v) || 0.8;
  for (let s = 0; s < SEQ_STEPS; s++) {
    S.seqPattern[row][s] = pat[s] ? vel : 0;
    S.seqProb[row][s] = 1; S.seqRatchet[row][s] = 1;
    if (S.seqCells.length) paintSeqCell(row, s);
  }
  setStatus(`${d.name}: Euclid E(${hits},${SEQ_STEPS})${rot ? ' rotated ' + rot : ''}`);
}
