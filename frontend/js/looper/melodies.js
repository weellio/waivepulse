// Premade chord progressions + melodies for the piano roll, plus saveable favorites.
// Click one → it fills the roll (and the live notation panel below the keyboard shows
// it as sheet music); switch to Roll to play or → Loop it.
import { S } from './state.js';
import { applyPseqPattern } from './pianoseq.js';
import { setStatus } from './util.js';

const ROWS = 24, STEPS = 16;                 // roll is C3–B4 × 16 steps
const rowOf = midi => 71 - midi;             // row 0 = B4 (71) … row 23 = C3 (48)

// note = [midi, startStep, lengthInSteps]; chords are just several notes sharing a start
const chord = (mids, start, len) => mids.map(m => [m, start, len]);

const PRESETS = [
  { name: 'Pop I–V–vi–IV',     notes: [...chord([60,64,67],0,4), ...chord([55,59,62],4,4), ...chord([57,60,64],8,4), ...chord([53,57,60],12,4)] },
  { name: '50s I–vi–IV–V',     notes: [...chord([60,64,67],0,4), ...chord([57,60,64],4,4), ...chord([53,57,60],8,4), ...chord([55,59,62],12,4)] },
  { name: '6-4-1-5',           notes: [...chord([57,60,64],0,4), ...chord([53,57,60],4,4), ...chord([60,64,67],8,4), ...chord([55,59,62],12,4)] }, // vi–IV–I–V (Am F C G)
  { name: 'Jazz ii7–V7–I',     notes: [...chord([50,53,57,60],0,4), ...chord([55,59,62,65],4,4), ...chord([60,64,67,71],8,8)] },               // Dm7 G7 Cmaj7
  { name: 'Arp Up',            notes: [[60,0,2],[64,2,2],[67,4,2],[71,6,2],[67,8,2],[64,10,2],[60,12,2],[64,14,2]] },
  { name: 'Scale Run',         notes: [[60,0,2],[62,2,2],[64,4,2],[65,6,2],[67,8,2],[69,10,2],[71,12,2],[69,14,2]] },
  { name: 'Pentatonic',        notes: [[60,0,2],[64,2,2],[67,4,2],[69,6,2],[67,8,2],[64,10,2],[60,12,2],[57,14,2]] },
  { name: 'Oct Bass',          notes: [[48,0,2],[60,2,2],[48,4,2],[60,6,2],[48,8,2],[60,10,2],[48,12,2],[60,14,2]] },
  // Bach Prelude in C (BWV 846) — the flowing C–E–G–C–E broken-chord figure, ×2
  { name: 'Bach Prelude',      notes: [[48,0,1],[52,1,1],[55,2,1],[60,3,1],[64,4,1],[55,5,1],[60,6,1],[64,7,1],[48,8,1],[52,9,1],[55,10,1],[60,11,1],[64,12,1],[55,13,1],[60,14,1],[64,15,1]] },
  // Mozart-style Alberti bass (low–high–mid–high, à la Sonata K545) under a held melody
  { name: 'Mozart Alberti',    notes: [[48,0,2],[55,2,2],[52,4,2],[55,6,2],[48,8,2],[55,10,2],[52,12,2],[55,14,2],[67,0,8],[64,8,8]] },
];

const FAV_KEY = 'waivepulse_melodies';

function gridFromNotes(notes) {
  const g = Array.from({ length: ROWS }, () => new Array(STEPS).fill(0));
  for (const [midi, start, len] of notes) {
    const row = rowOf(midi);
    if (row < 0 || row > ROWS - 1) continue;
    for (let i = 0; i < len && start + i < STEPS; i++) g[row][start + i] = 1;
  }
  return g;
}

function loadMelody(i) {
  const p = PRESETS[i]; if (!p) return;
  applyPseqPattern(gridFromNotes(p.notes));
  setStatus(`Loaded "${p.name}" into the roll — open Roll to play or → Loop it`);
}

// ── Favorites (localStorage) ──────────────────────────────────────────────────
function getFavs() { try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; } }
function setFavs(list) { try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch {} }

function saveMelody() {
  if (!S.pseqPattern.some(row => row.some(v => v))) { setStatus('Nothing to save — add notes in the roll first'); return; }
  const name = (prompt('Name this melody:', 'My melody') || '').trim();
  if (!name) return;
  const grid = S.pseqPattern.map(row => row.map(v => (v ? 1 : 0)));
  const favs = getFavs(); favs.push({ name, grid }); setFavs(favs);
  renderMelodyBar();
  setStatus(`Saved "${name}" to your favorites`);
}

function loadFav(i) { const f = getFavs()[i]; if (!f) return; applyPseqPattern(f.grid); setStatus(`Loaded "${f.name}"`); }
function deleteFav(i) { const favs = getFavs(); if (!favs[i]) return; favs.splice(i, 1); setFavs(favs); renderMelodyBar(); }

// ── UI (reuses the .beat-* styles) ────────────────────────────────────────────
export function renderMelodyBar() {
  const bar = document.getElementById('rollPresets');
  if (!bar) return;
  bar.innerHTML = '';
  const mkBtn = (label, cls, onClick, title) => {
    const b = document.createElement('button');
    b.className = 'beat-btn' + (cls ? ' ' + cls : '');
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
  };
  bar.appendChild(Object.assign(document.createElement('span'), { className: 'beat-lbl', textContent: 'MELODIES' }));
  PRESETS.forEach((p, i) => bar.appendChild(mkBtn(p.name, 'preset', () => loadMelody(i), 'Load ' + p.name + ' into the roll')));
  bar.appendChild(Object.assign(document.createElement('span'), { className: 'beat-sep' }));
  bar.appendChild(mkBtn('★ Save', 'save', saveMelody, 'Save the current roll pattern to your favorites'));
  getFavs().forEach((f, i) => {
    const wrap = document.createElement('span'); wrap.className = 'beat-fav';
    wrap.appendChild(mkBtn(f.name, 'fav', () => loadFav(i), 'Load your saved melody'));
    wrap.appendChild(mkBtn('✕', 'fav-x', () => deleteFav(i), 'Delete this favorite'));
    bar.appendChild(wrap);
  });
}
