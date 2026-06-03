// Premade drum patterns for the step sequencer + saveable favorites (localStorage).
// Click a preset → it fills the 16-step grid; tweak it, save it, or push it to a loop.
import { S } from './state.js';
import { setDrumMode, buildSeq, paintSeqCell } from './drums.js';
import { setStatus } from './util.js';

// Per-row default velocity (rows: 0 Kick · 1 Snare · 2 HiHat · 3 Open · 4 Clap · 5 Tom · 6 808 · 7 Perc)
const V = [1.0, 0.9, 0.62, 0.68, 0.9, 0.85, 0.95, 0.68];

// Each preset lists, per drum row, the step indices that fire (0–15, four steps = one beat).
const PRESETS = [
  { name: 'Four-Floor', rows: { 0: [0, 4, 8, 12], 2: [2, 6, 10, 14], 4: [4, 12] } },
  { name: 'House',      rows: { 0: [0, 4, 8, 12], 3: [2, 6, 10, 14], 4: [4, 12], 2: [0, 2, 4, 6, 8, 10, 12, 14] } },
  { name: 'Boom Bap',   rows: { 0: [0, 10], 1: [4, 12], 2: [0, 2, 4, 6, 8, 10, 12, 14] } },
  { name: 'Trap',       rows: { 0: [0, 6, 10], 1: [8], 2: [0, 2, 4, 6, 8, 10, 12, 13, 14, 15], 6: [0, 6, 10] } },
  { name: 'Rock',       rows: { 0: [0, 8, 10], 1: [4, 12], 2: [0, 2, 4, 6, 8, 10, 12, 14] } },
  { name: 'Funk',       rows: { 0: [0, 3, 7, 10], 1: [4, 12], 2: [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15], 7: [6, 14] } },
  { name: 'Breakbeat',  rows: { 0: [0, 2, 10], 1: [4, 12, 14], 2: [0, 2, 4, 6, 8, 10, 12, 14] } },
  { name: 'Half-Time',  rows: { 0: [0, 6], 1: [8], 2: [0, 2, 4, 6, 8, 10, 12, 14] } },
  { name: 'Bossa',      rows: { 0: [0, 8], 7: [0, 3, 6, 10, 12], 2: [0, 2, 4, 6, 8, 10, 12, 14] } },
  { name: 'Reggaeton',  rows: { 0: [0, 8], 4: [3, 6, 10, 14], 2: [0, 2, 4, 6, 8, 10, 12, 14] } },
];

const FAV_KEY = 'waivepulse_beats';

function ensureSeqReady() {
  if (S.drumMode !== 'seq') setDrumMode('seq');   // also builds the grid if needed
  if (S.seqCells.length === 0) buildSeq();
}

function applyGrid(grid) {
  ensureSeqReady();
  for (let r = 0; r < S.seqPattern.length; r++)
    for (let s = 0; s < 16; s++) {
      S.seqPattern[r][s] = grid[r] ? (grid[r][s] || 0) : 0;
      paintSeqCell(r, s);
    }
}

// Build an 8×16 grid from a preset's compact { row: [steps] } form.
function gridFromPreset(p) {
  const grid = Array.from({ length: 8 }, () => new Array(16).fill(0));
  for (const r in p.rows) for (const s of p.rows[r]) grid[+r][s] = V[+r];
  return grid;
}

function loadBeat(i) {
  const p = PRESETS[i]; if (!p) return;
  applyGrid(gridFromPreset(p));
  setStatus(`Loaded "${p.name}" — tweak it, then → Loop`);
}

// ── Favorites (localStorage) ──────────────────────────────────────────────────
function getFavs() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; }
}
function setFavs(list) {
  try { localStorage.setItem(FAV_KEY, JSON.stringify(list)); } catch {}
}

function saveBeat() {
  if (!S.seqPattern.some(row => row.some(v => v))) { setStatus('Nothing to save — build a beat first'); return; }
  const name = (prompt('Name this beat:', 'My beat') || '').trim();
  if (!name) return;
  const grid = S.seqPattern.map(row => row.map(v => +v.toFixed(2)));
  const favs = getFavs();
  favs.push({ name, grid });
  setFavs(favs);
  renderBeatBar();
  setStatus(`Saved "${name}" to your favorites`);
}

function loadFav(i) {
  const f = getFavs()[i]; if (!f) return;
  applyGrid(f.grid);
  setStatus(`Loaded "${f.name}"`);
}

function deleteFav(i) {
  const favs = getFavs();
  if (!favs[i]) return;
  favs.splice(i, 1);
  setFavs(favs);
  renderBeatBar();
}

// ── UI ──────────────────────────────────────────────────────────────────────
export function renderBeatBar() {
  const bar = document.getElementById('beatPresets');
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

  bar.appendChild(Object.assign(document.createElement('span'), { className: 'beat-lbl', textContent: 'BEATS' }));
  PRESETS.forEach((p, i) => bar.appendChild(mkBtn(p.name, 'preset', () => loadBeat(i), 'Load the ' + p.name + ' pattern')));

  bar.appendChild(Object.assign(document.createElement('span'), { className: 'beat-sep' }));
  bar.appendChild(mkBtn('★ Save', 'save', saveBeat, 'Save the current grid to your favorites'));

  const favs = getFavs();
  favs.forEach((f, i) => {
    const wrap = document.createElement('span');
    wrap.className = 'beat-fav';
    wrap.appendChild(mkBtn(f.name, 'fav', () => loadFav(i), 'Load your saved beat'));
    wrap.appendChild(mkBtn('✕', 'fav-x', () => deleteFav(i), 'Delete this favorite'));
    bar.appendChild(wrap);
  });
}
