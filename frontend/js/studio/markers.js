// Song markers / sections: flags on the ruler (Intro, Verse, Chorus…), a faint line
// through every track, click = seek, drag = move, double-click = rename,
// right-click = delete. "YT Chapters" turns them into a YouTube chapter list.
//
// State: S._markers = [{ id, t, name }] (song seconds). Persisted per separation in
// localStorage (per-browser convenience) and inside .wpproj project files.
// Ripple Cut shifts them via shiftMarkersForCut() (called from edit.js).
import { S } from './state.js';
import { getCanvasWidth, seekTo, currentPosition } from './transport.js';
import { fmtTime } from './util.js';

export const QUICK_NAMES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Solo', 'Breakdown', 'Drop', 'Hook', 'Outro'];
const NUMBERED = new Set(['Verse', 'Pre-Chorus', 'Chorus', 'Hook', 'Drop']);
const COLORS = { Intro: '#8cffff', Verse: '#4a9ee8', 'Pre-Chorus': '#b48cff', Chorus: '#e87c4a', Bridge: '#5cbe6a',
  Solo: '#e8cc4a', Breakdown: '#888', Drop: '#ff5a8c', Hook: '#e87c4a', Outro: '#8cffff' };
const colorOf = name => COLORS[String(name).replace(/\s+\d+$/, '')] || '#c8a832';

let _nextId = 1;
function markers() { if (!S._markers) S._markers = []; return S._markers; }
function sortMarkers() { markers().sort((a, b) => a.t - b.t); }

const lsKey = () => S._sepId ? 'wp.studio.markers.' + S._sepId : null;
export function persistMarkers() {
  const k = lsKey(); if (!k) return;
  try { localStorage.setItem(k, JSON.stringify(markers().map(m => ({ t: m.t, name: m.name })))); } catch (_) {}
}
export function restoreMarkersLocal() {
  const k = lsKey(); if (!k) return;
  try {
    const arr = JSON.parse(localStorage.getItem(k) || '[]');
    if (Array.isArray(arr)) setMarkers(arr, false);
  } catch (_) {}
}

export function getMarkers() { return markers().map(m => ({ t: m.t, name: m.name })); }
export function setMarkers(arr, persist = true) {
  S._markers = (arr || []).filter(m => m && isFinite(m.t)).map(m => ({ id: _nextId++, t: Math.max(0, +m.t), name: String(m.name || 'Marker') }));
  sortMarkers(); renderMarkers();
  if (persist) persistMarkers();
}

// Next auto-numbered name for a quick pick ("Verse" → "Verse 2" if one exists).
function autoName(base, exceptId = null) {
  if (!NUMBERED.has(base)) return base;
  const n = markers().filter(m => m.id !== exceptId && (m.name === base || new RegExp('^' + base + ' \\d+$').test(m.name))).length;
  return `${base} ${n + 1}`;
}

export function addMarkerAtPlayhead() {
  if (!S._dur) return;
  const t = Math.max(0, Math.min(S._dur, currentPosition()));
  // don't stack two markers on the same spot
  const near = markers().find(m => Math.abs(m.t - t) < 0.25);
  if (near) { openMarkerPopover(near.id); return; }
  const guess = !markers().length && t < 1 ? 'Intro' : 'Marker';
  const m = { id: _nextId++, t, name: guess };
  markers().push(m); sortMarkers(); renderMarkers(); persistMarkers();
  openMarkerPopover(m.id, true);
}

export function deleteMarker(id) {
  S._markers = markers().filter(m => m.id !== id);
  closeMarkerPopover(); renderMarkers(); persistMarkers();
}

export function renameMarker(id, name) {
  const m = markers().find(x => x.id === id); if (!m) return;
  m.name = (name || '').trim() || m.name;
  renderMarkers(); persistMarkers();
}

// Ripple cut [a, b): markers inside the cut collapse to a (duplicates dropped), later ones slide left.
export function shiftMarkersForCut(a, b) {
  const len = b - a, out = [];
  for (const m of markers()) {
    let t = m.t;
    if (t >= b) t -= len; else if (t > a) t = a;
    if (out.some(o => Math.abs(o.t - t) < 0.05 && m.t > a && m.t < b)) continue;
    out.push({ ...m, t });
  }
  S._markers = out; sortMarkers();
}

// ── Rendering ─────────────────────────────────────────────────────────────
export function renderMarkers() {
  const ruler = document.getElementById('ruler-inner');
  const sc = document.getElementById('scroll-content');
  if (!ruler || !sc) return;
  ruler.querySelectorAll('.mk-flag').forEach(e => e.remove());
  sc.querySelectorAll('.mk-line').forEach(e => e.remove());
  const cnt = document.getElementById('marker-count');
  if (cnt) cnt.textContent = markers().length ? String(markers().length) : '';
  if (!S._dur) return;
  const w = getCanvasWidth();
  for (const m of markers()) {
    const x = (m.t / S._dur) * w, col = colorOf(m.name);
    const flag = document.createElement('div');
    flag.className = 'mk-flag'; flag.dataset.id = m.id;
    flag.style.left = x + 'px'; flag.style.setProperty('--mk', col);
    flag.innerHTML = '<span class="mk-name"></span>';
    flag.querySelector('.mk-name').textContent = m.name;
    flag.title = `${m.name} · ${fmtTime(m.t)}\nclick = seek · drag = move · double-click = rename · right-click = delete`;
    wireFlag(flag, m);
    ruler.appendChild(flag);
    const line = document.createElement('div');
    line.className = 'mk-line'; line.dataset.id = m.id; line.style.left = x + 'px'; line.style.setProperty('--mk', col);
    sc.appendChild(line);
  }
}

function wireFlag(flag, m) {
  flag.addEventListener('mousedown', e => {
    e.stopPropagation(); e.preventDefault();          // don't start a ruler loop-drag
    if (e.button !== 0) return;
    const x0 = e.clientX, t0 = m.t;
    let moved = false;
    const onMove = e2 => {
      const dx = e2.clientX - x0;
      if (Math.abs(dx) > 3) moved = true;
      if (!moved) return;
      m.t = Math.max(0, Math.min(S._dur, t0 + (dx / getCanvasWidth()) * S._dur));
      const x = (m.t / S._dur) * getCanvasWidth();
      flag.style.left = x + 'px';
      const line = [...document.querySelectorAll('.mk-line')].find(l => l.dataset.id === String(m.id));
      if (line) line.style.left = x + 'px';
      flag.title = `${m.name} · ${fmtTime(m.t)}`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
      if (moved) { sortMarkers(); renderMarkers(); persistMarkers(); }
      else seekTo(m.t);
    };
    document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
  });
  flag.addEventListener('dblclick', e => { e.stopPropagation(); openMarkerPopover(m.id); });
  flag.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); deleteMarker(m.id); });
}

// ── Name popover (quick picks + custom) ─────────────────────────────────────
let _popId = null;
export function openMarkerPopover(id, isNew = false) {
  const m = markers().find(x => x.id === id); if (!m) return;
  _popId = id;
  let pop = document.getElementById('marker-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'marker-pop';
    document.body.appendChild(pop);
    document.addEventListener('mousedown', e => {
      if (pop.classList.contains('open') && !pop.contains(e.target) && !e.target.closest('.mk-flag')) closeMarkerPopover();
    });
  }
  pop.innerHTML = '';
  const hdr = document.createElement('div'); hdr.className = 'mp-hdr';
  hdr.textContent = (isNew ? 'New marker' : 'Marker') + ' at ' + fmtTime(m.t);
  const picks = document.createElement('div'); picks.className = 'mp-picks';
  for (const q of QUICK_NAMES) {
    const b = document.createElement('button');
    b.className = 'mp-pick'; b.textContent = q; b.style.setProperty('--mk', colorOf(q));
    b.onclick = () => { renameMarker(id, autoName(q, id)); closeMarkerPopover(); };
    picks.appendChild(b);
  }
  const row = document.createElement('div'); row.className = 'mp-row';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.value = m.name; inp.placeholder = 'Custom name'; inp.maxLength = 60;
  inp.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') { renameMarker(id, inp.value); closeMarkerPopover(); }
    if (e.key === 'Escape') closeMarkerPopover();
  });
  const ok = document.createElement('button'); ok.className = 'mp-ok'; ok.textContent = 'OK';
  ok.onclick = () => { renameMarker(id, inp.value); closeMarkerPopover(); };
  const del = document.createElement('button'); del.className = 'mp-del-btn'; del.textContent = 'Delete';
  del.onclick = () => deleteMarker(id);
  row.append(inp, ok, del);
  pop.append(hdr, picks, row);

  // position under the flag (or centred under the ruler if not visible)
  const flag = document.querySelector(`.mk-flag[data-id="${id}"]`);
  const r = flag ? flag.getBoundingClientRect() : document.getElementById('ruler-inner').getBoundingClientRect();
  pop.classList.add('open');
  const pw = pop.offsetWidth || 300;
  pop.style.left = Math.max(8, Math.min(window.innerWidth - pw - 8, r.left - 10)) + 'px';
  pop.style.top = (r.bottom + 6) + 'px';
  setTimeout(() => { inp.focus(); inp.select(); }, 0);
}

export function closeMarkerPopover() {
  const pop = document.getElementById('marker-pop');
  if (pop) pop.classList.remove('open');
  _popId = null;
}
export function markerPopoverOpen() { return !!_popId; }

// ── YouTube chapters ────────────────────────────────────────────────────────
// Rules (YouTube): first chapter at 0:00, at least 3 chapters, each ≥ 10 s long.
export function fmtChapterTime(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

export function buildChapters(list = getMarkers(), dur = S._dur) {
  const warnings = [];
  let ms = [...list].sort((a, b) => a.t - b.t).map(m => ({ t: m.t, name: m.name }));
  if (!ms.length) return { text: '', chapters: [], warnings: ['No markers yet — add some with ⚑ Marker (or Shift+M) at each section.'], ok: false };
  // 1. first chapter at 0:00
  if (ms[0].t >= 1) {
    if (ms[0].t < 10) { warnings.push(`"${ms[0].name}" moved from ${fmtChapterTime(ms[0].t)} to 0:00 (YouTube's first chapter must start at 0:00).`); ms[0].t = 0; }
    else { ms.unshift({ t: 0, name: 'Intro' }); warnings.push('Added "0:00 Intro" — YouTube\'s first chapter must start at 0:00.'); }
  } else ms[0].t = 0;
  // 2. each chapter ≥ 10 s: drop markers closer than 10 s to the previous kept one
  const kept = [ms[0]];
  for (let i = 1; i < ms.length; i++) {
    if (ms[i].t - kept[kept.length - 1].t < 10) warnings.push(`Skipped "${ms[i].name}" at ${fmtChapterTime(ms[i].t)} — less than 10 s after "${kept[kept.length - 1].name}".`);
    else kept.push(ms[i]);
  }
  // the last chapter needs 10 s before the end of the song too
  if (kept.length > 1 && dur && dur - kept[kept.length - 1].t < 10) {
    const last = kept.pop();
    warnings.push(`Skipped "${last.name}" at ${fmtChapterTime(last.t)} — less than 10 s before the song ends.`);
  }
  // 3. at least 3 chapters
  const ok = kept.length >= 3;
  if (!ok) warnings.push(`YouTube needs at least 3 chapters — you have ${kept.length}. Add more markers.`);
  const text = kept.map(c => `${fmtChapterTime(c.t)} ${c.name}`).join('\n');
  return { text, chapters: kept, warnings, ok };
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (_) {
    try {
      const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (_) { return false; }
  }
}

export async function copyYouTubeChapters() {
  const res = buildChapters();
  const modal = document.getElementById('chapters-modal');
  const ta = document.getElementById('chapters-text');
  const warn = document.getElementById('chapters-warn');
  const status = document.getElementById('chapters-status');
  if (ta) ta.value = res.text;
  if (warn) {
    warn.innerHTML = '';
    for (const w of res.warnings) { const li = document.createElement('li'); li.textContent = w; warn.appendChild(li); }
    warn.style.display = res.warnings.length ? '' : 'none';
  }
  let copied = false;
  if (res.text) copied = await copyText(res.text);
  if (status) {
    status.textContent = !res.text ? '' : copied ? (res.ok ? '✓ Copied to clipboard — paste into your YouTube description.' : '✓ Copied, but fix the warnings above before YouTube will show chapters.') : 'Select the text and copy it (clipboard blocked).';
    status.style.color = res.ok && copied ? '#6be87c' : '#e8c84a';
  }
  S._lastChapters = res;
  modal?.classList.add('open');
  return res;
}

export async function recopyChapters() {
  const ta = document.getElementById('chapters-text');
  if (ta && ta.value) {
    const ok = await copyText(ta.value);
    const st = document.getElementById('chapters-status');
    if (st) st.textContent = ok ? '✓ Copied again.' : 'Clipboard blocked — select and copy manually.';
  }
}

export function closeChapters() { document.getElementById('chapters-modal')?.classList.remove('open'); }
