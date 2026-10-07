// ── Mashup Builder + "Sample this" + the beat-grid overlay ───────────────────────
//
// Two workflows, both of which are packaging over DSP WAIvePulse already owned:
// Demucs six-stem separation, a stem library spanning every separated song,
// server-side time-stretch with the pitch preserved, per-track key change, and the
// Looper's sampler. The only new idea is a BEAT GRID (backend/beatgrid.py +
// backend/routers/beatgrid.py): once the app knows where the bar lines are, both
// workflows are bookkeeping.
//
//   Mashup   "vocals from X, drums from Y" — POST /beatgrid/mashup/plan returns the
//            stretch factor, semitones and downbeat nudge per role; this module then
//            calls the EXISTING /timestretch and /pitchshift endpoints and drops each
//            stem on an ordinary import track. Nothing is a black box: every number is
//            printed, and every track can be re-mixed, re-stretched or deleted after.
//
//   Sample   The ruler selection (edit.js's S._loopStart/_loopEnd) rounded out to whole
//            bars by GET /beatgrid/sample/..., optionally with one stem isolated, then
//            handed to the Looper through the Looper's OWN public API in a window this
//            page opens — so the Looper comes up already at the clip's tempo and key.
//
// Markup: studio.html between <!-- mashup:start --> / <!-- mashup:end -->.
// Styles: the .mg-* rules at the end of css/studio.css.
// The two toolbar buttons and the two help sections are injected from here, so the whole
// feature is one HTML block + this file.
import { S, STEM_COLORS, STEM_ORDER } from './state.js';
import { addImportedBuffer, applyGains } from './tracks.js';
import { computePeaks, redrawAll } from './waveform.js';
import { getCanvasWidth } from './transport.js';
import { fmtTime } from './util.js';

const $ = id => document.getElementById(id);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#' };

let _status = null;      // GET /beatgrid/status — which tracker, and why
let _grid = null;        // the grid for the song open in the Studio
let _gridErr = null;
let _library = null;     // GET /stems/library, grouped by separation
let _plan = null;        // last mashup plan from the server
let _snap = null;        // last snap preview for the sample panel
let _busy = false;
let _looperWin = null;
let _barsChoice = 'sel'; // 'sel' | 1 | 2 | 4 | 8
let _stemChoice = 'mix';
let _linesOn = true;

// ── Small helpers ─────────────────────────────────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/[<>&"]/g, c =>
  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

function pitchClass(key) {
  if (!key) return null;
  let tok = String(key).trim().split(/\s+/)[0].replace('♯', '#').replace('♭', 'b');
  tok = FLATS[tok] || tok;
  const i = NOTES.indexOf(tok);
  return i < 0 ? null : i;
}

function setStatus(el, msg, cls) {
  const e = $(el);
  if (e) e.innerHTML = cls ? `<span class="${cls}">${esc(msg)}</span>` : esc(msg);
}

async function jsonOrThrow(res) {
  if (res.ok) return res.json();
  let msg = `HTTP ${res.status}`;
  try { msg = (await res.json()).detail || msg; } catch (_) {}
  throw new Error(msg);
}

// ── Toolbar + help injection ──────────────────────────────────────────────────
function injectToolbar() {
  const bar = $('transport');
  if (!bar || $('mashup-btn')) return;
  const anchor = [...bar.querySelectorAll('button')].find(b => /Stem Swap/i.test(b.textContent));
  const frag = document.createDocumentFragment();
  const div = document.createElement('div');
  div.className = 't-divider';
  frag.appendChild(div);

  const mash = document.createElement('button');
  mash.id = 'mashup-btn'; mash.className = 'mg-btn'; mash.textContent = '🎛 Mashup…';
  mash.title = 'Build a mashup: pick which song each instrument comes from. Tempo, key and '
    + 'downbeats are matched for you and every stem lands on its own ordinary track.';
  mash.addEventListener('click', openMashup);

  const samp = document.createElement('button');
  samp.id = 'sample-btn'; samp.className = 'mg-btn'; samp.textContent = '✂ Sample this…';
  samp.title = 'Take a bar-exact clip from the selected ruler region, isolate one stem, and '
    + 'send it to the Looper already in time and in key. Drag across the ruler first.';
  samp.addEventListener('click', openSample);

  const out = document.createElement('span');
  out.id = 'mg-readout';

  frag.append(mash, samp, out);
  if (anchor && anchor.parentNode === bar) anchor.after(frag);
  else bar.appendChild(frag);
}

const HELP_MASHUP = `
<div class="help-section" id="help-mashup">
  <div class="help-section-title">🎛 Mashup Builder — one song per instrument</div>
  <p class="help-p">Vocals from one song over the drums of another, in this song's key and at its
    tempo. WAIvePulse already separates six stems per song and already stretches and re-pitches
    them on the server; what the <b>🎛 Mashup…</b> button adds is the bar grid that lines them up,
    and the bookkeeping.</p>
  <table class="help-table"><tbody>
    <tr><td>1. Separate the songs</td><td>Any song you want to borrow from has to have been
      separated once (Studio does that automatically when you open a song).</td></tr>
    <tr><td>2. Open 🎛 Mashup…</td><td>Pick the source song for each instrument — vocals, drums,
      bass, guitar, piano, other. "this song" leaves the stem you already have; "leave out" mutes it.</td></tr>
    <tr><td>3. Plan it</td><td>Shows exactly what would change per stem without touching the
      timeline: <i>128 → 124 BPM (stretch ×0.9688) · +3 semitones (A minor → C minor) · nudged 38 ms
      onto the downbeat</i>.</td></tr>
    <tr><td>4. Build mashup</td><td>Runs those steps through the same /timestretch and /pitchshift
      the STRETCH and KEY controls use, then lays each stem on its own track at the right offset.</td></tr>
    <tr><td>Build at … BPM / in …</td><td>Override the target tempo or key — build the whole mashup
      at 100 BPM in F minor instead of this song's own tempo and key.</td></tr>
    <tr><td>Half / double time</td><td>A 170 BPM song against an 85 BPM one is the <i>same</i> tempo,
      so it is counted at half time instead of being smeared 2×. The plan says when it did that.</td></tr>
    <tr><td>Afterwards</td><td>Every stem is a normal import track: mute, solo, volume, pan, EQ,
      STRETCH, KEY, drag it left or right, delete it, Export Mix. Nothing is locked.</td></tr>
  </tbody></table>
  <p class="help-p"><b>What still needs your ears.</b> The grid finds bar one, not the right bar —
    a chorus vocal over a verse drum loop lines up perfectly and still sounds wrong. Drag the clip
    a bar at a time until the phrasing lands. And where the grid is weak (live playing, rubato,
    tempo changes) the banner at the top of the panel says so.</p>
</div>`;

const HELP_SAMPLE = `
<div class="help-section" id="help-sample">
  <div class="help-section-title">✂ Sample this — a bar-exact clip for the Looper</div>
  <p class="help-p">"Sample the riff at 0:45, isolate the guitar, build a beat around it." Drag a
    region on the ruler, click <b>✂ Sample this…</b>, and the clip is trimmed out to whole bars on
    the grid so it loops cleanly.</p>
  <table class="help-table"><tbody>
    <tr><td>Select first</td><td>Drag across the ruler (or <kbd>[</kbd> and <kbd>]</kbd>) — the same
      selection Cut, Splice and Rewrite Section use.</td></tr>
    <tr><td>Snapped to bars</td><td>The panel shows what you dragged, where the bar lines moved it to,
      and how far each edge travelled in milliseconds. Nothing is rounded silently.</td></tr>
    <tr><td>Length</td><td>Keep the selection's own length, or force 1 / 2 / 4 / 8 bars from the
      snapped start.</td></tr>
    <tr><td>Isolate</td><td>Full mix, or any one of the six separated stems — the grid still comes
      from the full mix, so a vocal with no drums in it still snaps to the song's real bars.</td></tr>
    <tr><td>▶ Preview</td><td>Hear the clip before you commit.</td></tr>
    <tr><td>＋ Add as track</td><td>Drops the clip on the timeline at the bar it came from.</td></tr>
    <tr><td>🎹 Send to Looper</td><td>Opens the Looper, sets its BPM to the detected tempo and its
      scale lock to the detected key, and loads the clip as the sampler instrument — so the drum
      sequencer and the piano roll are already in time and in key with it. Click once in the Looper
      window to let the browser start its audio.</td></tr>
    <tr><td>⬇ WAV</td><td>The clip as a 16-bit WAV, with a 3 ms fade on each edge so a bar-exact cut
      cannot click.</td></tr>
    <tr><td><kbd>G</kbd></td><td>Show / hide the bar lines drawn over the timeline.</td></tr>
  </tbody></table>
  <p class="help-p"><b>Which beat tracker?</b> <span id="help-tracker-line">checking…</span></p>
</div>`;

function injectHelp() {
  const body = document.querySelector('#help-modal .help-body');
  if (!body || $('help-mashup')) return;
  body.insertAdjacentHTML('beforeend', HELP_MASHUP + HELP_SAMPLE);
}

function updateHelpTracker() {
  const el = $('help-tracker-line');
  if (!el || !_status) return;
  el.innerHTML = esc(`${_status.label} — ${_status.reason}.`) +
    (_status.downbeats === 'estimated'
      ? ' Downbeats are <b>estimated</b> from onset strength with 4/4 assumed, so check bar one by ear.'
      : ' Downbeats are detected by the model, not guessed.');
}

// ── Grid for the open song ────────────────────────────────────────────────────
async function loadStatus() {
  try { _status = await jsonOrThrow(await fetch('/beatgrid/status')); }
  catch (e) { _status = { available: false, label: 'beat grid unavailable', reason: e.message }; }
  updateHelpTracker();
  syncButtons();
}

async function loadGrid(force = false) {
  if (!S._sepId && !S._jobId) return null;
  const url = S._sepId ? `/beatgrid/sep/${S._sepId}` : `/beatgrid/song/${S._jobId}`;
  try {
    _grid = await jsonOrThrow(await fetch(url + (force ? '?force=true' : '')));
    _gridErr = null;
  } catch (e) {
    _grid = null; _gridErr = e.message;
  }
  renderReadout();
  renderLines();
  return _grid;
}

function gridBadgeClass(g) {
  if (!g) return 'mg-bad';
  return g.confidence >= 0.6 ? '' : 'mg-weak';
}

function renderReadout() {
  const el = $('mg-readout');
  if (!el) return;
  if (!_grid) {
    el.innerHTML = _gridErr ? '<span class="mg-bad">no grid</span>' : '';
    el.title = _gridErr || '';
    return;
  }
  const cls = gridBadgeClass(_grid);
  el.innerHTML = `grid <b>${_grid.bpm.toFixed(1)}</b> BPM · ${_grid.beats_per_bar}/4 · ` +
    `<span class="${cls}">${esc(_grid.confidence_label)}</span>`;
  el.title = [
    `${_grid.tracker_label}`,
    `${_grid.bpm.toFixed(2)} BPM, ${_grid.beats_per_bar}/4, bar = ${_grid.bar_sec.toFixed(3)} s`,
    `${_grid.downbeats.length} downbeats, ${_grid.beats.length} beats`,
    `key ${_grid.key || 'unknown'}`,
    `confidence ${_grid.confidence.toFixed(2)} (${_grid.confidence_label})`,
    _grid.downbeats_estimated ? 'downbeats ESTIMATED, 4/4 assumed' : 'downbeats detected by the model',
    ...(_grid.warnings || []),
    'Press G to show/hide the bar lines.',
  ].join('\n');
}

// Bar lines over the timeline, redrawn when zoom changes the ruler width.
function renderLines() {
  const sc = $('scroll-content');
  if (!sc) return;
  let box = $('mg-lines');
  if (!box) {
    box = document.createElement('div');
    box.id = 'mg-lines';
    sc.insertBefore(box, $('playhead') || null);
  }
  box.classList.toggle('on', _linesOn && !!_grid);
  box.innerHTML = '';
  if (!_grid || !_linesOn || !S._dur) return;
  const w = getCanvasWidth();
  box.style.width = w + 'px';
  box.style.height = Math.max(sc.scrollHeight, sc.clientHeight) + 'px';
  const lines = _grid.downbeats || [];
  const bar = _grid.bar_sec || 0;
  if (!lines.length || bar <= 0) return;
  // Thin the lines out when zoomed out, so 200 bars do not become a grey wash.
  const pxPerBar = (bar / S._dur) * w;
  const every = pxPerBar < 10 ? Math.ceil(10 / Math.max(1, pxPerBar)) : 1;
  const html = [];
  for (let i = 0; i < lines.length; i++) {
    if (i % every) continue;
    const x = (lines[i] / S._dur) * w;
    if (x < -2 || x > w + 2) continue;
    const four = i % 4 === 0;
    html.push(`<div class="mg-bar${four ? ' mg-four' : ''}" style="left:${x.toFixed(1)}px"></div>`);
    if (four && pxPerBar * 4 > 34) html.push(`<div class="mg-num" style="left:${x.toFixed(1)}px">${i + 1}</div>`);
  }
  box.innerHTML = html.join('');
}

function toggleGridLines() {
  _linesOn = !_linesOn;
  renderLines();
}

// ── Stem library (grouped per separation) ─────────────────────────────────────
async function loadLibrary(force = false) {
  if (_library && !force) return _library;
  const data = await jsonOrThrow(await fetch('/stems/library'));
  const groups = new Map();
  for (const s of (data.stems || [])) {
    if (!groups.has(s.sep_id)) {
      groups.set(s.sep_id, { sepId: s.sep_id, jobId: s.job_id, title: s.title, bpm: s.bpm, key: s.key, stems: [] });
    }
    groups.get(s.sep_id).stems.push(s.stem);
  }
  _library = [...groups.values()];
  return _library;
}

// ── Mashup modal ──────────────────────────────────────────────────────────────
function renderBanner(id, extra) {
  const el = $(id);
  if (!el) return;
  if (!_status || !_status.available) {
    el.className = 'mg-banner mg-none';
    el.innerHTML = `<div><b>No beat tracker available.</b> ${esc(_status ? _status.reason : '')}`
      + ' Tempo and key matching still work; downbeat alignment does not.</div>';
    return;
  }
  if (!_grid) {
    el.className = 'mg-banner mg-none';
    el.innerHTML = `<div><b>No grid for this song.</b> ${esc(_gridErr || 'still analysing…')}</div>`;
    return;
  }
  const weak = _grid.confidence < 0.6;
  el.className = 'mg-banner' + (weak ? ' mg-shaky' : '');
  el.innerHTML = `<div><b>${esc(_grid.tracker_label)}</b> · this song: `
    + `<b>${_grid.bpm.toFixed(1)} BPM</b>, ${_grid.beats_per_bar}/4, key <b>${esc(_grid.key || '?')}</b>, `
    + `${_grid.downbeats.length} downbeats · tracking <b>${esc(_grid.confidence_label)}</b> `
    + `(${_grid.confidence.toFixed(2)})`
    + (_grid.warnings || []).map(w => `<span class="mg-warn">⚠ ${esc(w)}</span>`).join('')
    + (extra ? `<span class="mg-warn">${extra}</span>` : '')
    + '</div>';
}

function currentStems() {
  // Stems the open song actually has, in canonical order.
  const have = new Set();
  for (const k of Object.keys(S.tracks)) {
    const base = k.replace(/_\d+$/, '');
    if (STEM_ORDER.includes(base)) have.add(base);
  }
  const lib = (_library || []).find(g => g.sepId === S._sepId);
  if (lib) lib.stems.forEach(s => have.add(s));
  return STEM_ORDER.filter(s => have.has(s));
}

function renderRoles() {
  const body = $('mg-roles-body');
  if (!body) return;
  const mine = currentStems();
  const others = (_library || []).filter(g => g.sepId !== S._sepId);
  body.innerHTML = '';
  for (const role of STEM_ORDER) {
    const tr = document.createElement('tr');
    const color = STEM_COLORS[role] || '#888';

    const td1 = document.createElement('td');
    td1.innerHTML = `<span class="mg-role-name" style="color:${color}">${role}</span>`;

    const td2 = document.createElement('td');
    const sel = document.createElement('select');
    sel.className = 'mg-sel';
    sel.id = 'mg-src-' + role;
    const add = (v, label, disabled) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label; o.disabled = !!disabled;
      sel.appendChild(o);
    };
    add('', '— leave out —');
    if (mine.includes(role)) add('self', 'this song' + (S._title ? ` (${S._title})` : ''));
    for (const g of others) {
      if (!g.stems.includes(role)) continue;
      add(g.sepId, `${g.title}${g.bpm ? ` · ${g.bpm} BPM` : ''}`);
    }
    sel.value = mine.includes(role) ? 'self' : '';
    sel.addEventListener('change', () => { clearPlanCell(role); });
    td2.appendChild(sel);

    const td3 = document.createElement('td');
    td3.className = 'mg-plan';
    td3.id = 'mg-plan-' + role;
    td3.innerHTML = '<span class="mg-skip">—</span>';

    tr.append(td1, td2, td3);
    body.appendChild(tr);
  }
}

function clearPlanCell(role) {
  const c = $('mg-plan-' + role);
  if (c) c.innerHTML = '<span class="mg-skip">—</span>';
  _plan = null;
}

function renderKeyOptions() {
  const sel = $('mg-target-key');
  if (!sel) return;
  const cur = _grid?.key || S._jobMeta?.key || '';
  sel.innerHTML = '';
  const add = (v, label) => { const o = document.createElement('option'); o.value = v; o.textContent = label; sel.appendChild(o); };
  add('', 'this song’s key' + (cur ? ` (${cur})` : ''));
  for (const q of ['major', 'minor']) for (const n of NOTES) add(`${n} ${q}`, `${n} ${q}`);
  sel.value = '';
}

export function openMashup() {
  $('mashup-modal').classList.add('open');
  setStatus('mg-status', '');
  $('mg-build-log').innerHTML = '';
  (async () => {
    try { await loadLibrary(true); } catch (e) { /* shown in the banner */ }
    if (!_grid) await loadGrid();
    renderBanner('mg-grid-banner');
    renderRoles();
    renderKeyOptions();
    const bpmIn = $('mg-target-bpm');
    if (bpmIn && !bpmIn.value) bpmIn.value = _grid ? _grid.bpm.toFixed(2) : (S._jobMeta?.bpm || '');
    const others = (_library || []).filter(g => g.sepId !== S._sepId);
    if (!others.length) {
      setStatus('mg-status', 'No other separated songs yet — separate a second song and come back.');
    }
  })();
}

export function closeMashup() { $('mashup-modal').classList.remove('open'); }

function collectRoles() {
  const roles = [];
  for (const role of STEM_ORDER) {
    const v = $('mg-src-' + role)?.value || '';
    if (!v) continue;
    const sepId = v === 'self' ? S._sepId : v;
    const g = (_library || []).find(x => x.sepId === sepId);
    roles.push({ role, sep_id: sepId, stem: role, title: g ? g.title : null });
  }
  return roles;
}

async function requestPlan() {
  const roles = collectRoles();
  if (!roles.length) throw new Error('Pick a source for at least one instrument.');
  const bpmIn = parseFloat($('mg-target-bpm').value);
  const body = {
    target_sep_id: S._sepId || null,
    target_job_id: S._jobId || null,
    target_bpm: Number.isFinite(bpmIn) && bpmIn >= 40 && bpmIn <= 240 ? bpmIn : null,
    target_key: $('mg-target-key').value || null,
    roles,
    match_tempo: $('mg-opt-tempo').checked,
    match_key: $('mg-opt-key').checked,
    align_downbeats: $('mg-opt-align').checked,
  };
  const res = await fetch('/beatgrid/mashup/plan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  _plan = await jsonOrThrow(res);
  return _plan;
}

function paintPlan(plan) {
  for (const role of STEM_ORDER) {
    const cell = $('mg-plan-' + role);
    if (!cell) continue;
    const p = plan.roles.find(r => r.role === role);
    if (!p) { cell.innerHTML = '<span class="mg-skip">left out — the stem you have is muted</span>'; continue; }
    if (!p.ok) { cell.innerHTML = `<span class="mg-err">✗ ${esc(p.error)}</span>`; continue; }
    cell.innerHTML = `<span class="mg-num2">${esc(p.title)}</span> — ${esc(p.summary)}`
      + (p.warnings || []).map(w => `<br><span class="mg-pend">⚠ ${esc(w)}</span>`).join('');
  }
}

export async function planMashup() {
  if (_busy) return;
  _busy = true;
  setStatus('mg-status', 'planning…');
  $('mg-plan-btn').disabled = $('mg-build-btn').disabled = true;
  try {
    const plan = await requestPlan();
    paintPlan(plan);
    const n = plan.roles.filter(r => r.ok).length;
    setStatus('mg-status', `${n} stem${n === 1 ? '' : 's'} planned at ${plan.target.bpm} BPM`
      + (plan.target.key ? ` in ${plan.target.key}` : '') + ' — nothing applied yet.');
  } catch (e) {
    setStatus('mg-status', 'plan failed: ' + e.message, 'mg-bad');
  } finally {
    _busy = false;
    $('mg-plan-btn').disabled = $('mg-build-btn').disabled = false;
  }
}

function setTrackMute(key, on) {
  const t = S.tracks[key];
  if (!t) return;
  t.muted = !!on;
  const b = $('m-' + key);
  if (b) b.classList.toggle('mute-on', !!on);
}

// Fetch one planned stem through the endpoints that already exist, in the order the plan
// lists them, and return a decoded AudioBuffer.
async function fetchPlannedStem(p, onStep) {
  const factor = p.stretch_factor;
  const semis = p.semitones;
  let bytes = null;
  let mime = 'audio/wav';
  let fname = 'stem.wav';

  if (factor !== 1) {
    onStep(`stretching ×${factor.toFixed(4)}…`);
    const r = await fetch(`/timestretch/${p.sep_id}/${encodeURIComponent(p.stem)}?factor=${factor}`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `time-stretch failed (${r.status})`);
    bytes = await r.arrayBuffer();
  } else if (semis) {
    // No stretch needed → pitch straight off the server stem, no upload at all.
    onStep(`shifting ${semis > 0 ? '+' : ''}${semis} semitones…`);
    const r = await fetch(`/pitchshift/${p.sep_id}/${encodeURIComponent(p.stem)}?semitones=${semis}`, { method: 'POST' });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `key change failed (${r.status})`);
    return S._actx.decodeAudioData(await r.arrayBuffer());
  } else {
    onStep('loading…');
    const r = await fetch(p.stem_url);
    if (!r.ok) throw new Error(`could not load the stem (${r.status})`);
    bytes = await r.arrayBuffer();
    mime = 'audio/mpeg'; fname = 'stem.mp3';
  }

  if (semis) {
    onStep(`shifting ${semis > 0 ? '+' : ''}${semis} semitones…`);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mime }), fname);
    const r = await fetch(`/pitchshift?semitones=${semis}`, { method: 'POST', body: form });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || `key change failed (${r.status})`);
    bytes = await r.arrayBuffer();
  }
  onStep('decoding…');
  return S._actx.decodeAudioData(bytes);
}

export async function buildMashup() {
  if (_busy) return;
  if (!S._actx) { alert('The song has not finished loading yet.'); return; }
  _busy = true;
  const log = $('mg-build-log');
  log.innerHTML = '';
  $('mg-plan-btn').disabled = $('mg-build-btn').disabled = true;
  const done = [];
  try {
    setStatus('mg-status', 'planning…');
    const plan = await requestPlan();
    paintPlan(plan);

    const chosen = new Set(plan.roles.map(r => r.role));
    // Instruments nobody asked for: mute this song's own stem so the mashup is what you picked.
    for (const role of STEM_ORDER) {
      if (chosen.has(role)) continue;
      for (const k of Object.keys(S.tracks)) {
        if (k.replace(/_\d+$/, '') === role && !S.tracks[k].isImport) setTrackMute(k, true);
      }
    }

    for (const p of plan.roles) {
      const cell = $('mg-plan-' + p.role);
      const step = msg => { if (cell) cell.innerHTML = `<span class="mg-pend">⏳ ${esc(msg)}</span>`; };
      if (!p.ok) continue;
      if (p.same_song) {
        for (const k of Object.keys(S.tracks)) {
          if (k.replace(/_\d+$/, '') === p.role && !S.tracks[k].isImport) setTrackMute(k, false);
        }
        if (cell) cell.innerHTML = `<span class="mg-ok">✓</span> ${esc(p.title)} — kept as it is`;
        continue;
      }
      setStatus('mg-status', `${p.role}: working…`);
      try {
        const buf = await fetchPlannedStem(p, step);
        // This song's own version of the instrument steps aside for the borrowed one.
        for (const k of Object.keys(S.tracks)) {
          if (k.replace(/_\d+$/, '') === p.role && !S.tracks[k].isImport) setTrackMute(k, true);
        }
        const name = `${p.role} · ${p.title}`;
        const key = addImportedBuffer(buf, name);
        const t = key && S.tracks[key];
        if (t) {
          t.startTime = clamp(p.nudge_sec || 0, 0, Math.max(0, S._dur - 0.01));
          t.sourceBpm = p.result_bpm || p.target_bpm;
          t.stretchFactor = p.stretch_factor;
          t.pitchSemis = p.semitones || 0;
          t._editedAudio = true;             // stretched/pitched audio is embedded in projects
          t._prePitchBuffer = null;
          t._mashup = {
            role: p.role, from: p.title, sepId: p.sep_id, stem: p.stem,
            sourceBpm: p.source_bpm, targetBpm: p.target_bpm, factor: p.stretch_factor,
            semitones: p.semitones, sourceKey: p.source_key, resultKey: p.result_key,
            nudgeMs: p.nudge_ms, summary: p.summary,
          };
          t.peaks = computePeaks(buf);
          const lbl = $('bpm-label-' + key);
          if (lbl && t.sourceBpm) lbl.textContent = Math.round(t.sourceBpm) + ' BPM';
          const sel = $('pitch-' + key);
          if (sel) sel.value = String(t.pitchSemis || 0);
          const row = document.querySelector(`#scroll-content .track-row[data-stem="${key}"]`);
          if (row) row.title = `${name}\n${p.summary}`;
        }
        if (cell) cell.innerHTML = `<span class="mg-ok">✓</span> <span class="mg-num2">${esc(p.title)}</span> — ${esc(p.summary)}`;
        done.push(p);
      } catch (e) {
        if (cell) cell.innerHTML = `<span class="mg-err">✗ ${esc(e.message)}</span>`;
      }
    }

    applyGains();
    redrawAll();
    renderLines();
    const lines = done.map(p => `<div>• <b>${esc(p.role)}</b> from <b>${esc(p.title)}</b> — ${esc(p.summary)}</div>`);
    log.innerHTML = done.length
      ? `<div style="color:#6ce8a8;margin-bottom:4px">Laid ${done.length} borrowed stem${done.length === 1 ? '' : 's'} on the timeline as ordinary tracks:</div>`
        + lines.join('')
        + '<div style="margin-top:6px;color:#666">Your ear decides the rest: the grid finds bar one, not the right bar. '
        + 'Drag a clip sideways a bar at a time if the phrasing fights.</div>'
      : '<div style="color:#e8cc4a">Nothing was borrowed — every instrument came from this song.</div>';
    setStatus('mg-status', done.length ? `built ${done.length} stem${done.length === 1 ? '' : 's'}` : 'nothing to build');
    const ro = $('mg-readout');
    if (ro && done.length) ro.title = ro.title + '\n\nLast mashup:\n' + done.map(p => `${p.role}: ${p.summary}`).join('\n');
    window.WPMashup.lastBuild = done;
  } catch (e) {
    setStatus('mg-status', 'build failed: ' + e.message, 'mg-bad');
  } finally {
    _busy = false;
    $('mg-plan-btn').disabled = $('mg-build-btn').disabled = false;
  }
}

// ── Sample this ───────────────────────────────────────────────────────────────
function selection() {
  if (S._loopStart === null || S._loopEnd === null) return null;
  const a = Math.max(0, Math.min(S._loopStart, S._loopEnd));
  const b = Math.min(S._dur, Math.max(S._loopStart, S._loopEnd));
  return b - a > 0.02 ? { a, b } : null;
}

function renderBarsRow() {
  const row = $('mg-bars-row');
  if (!row) return;
  row.innerHTML = '';
  const opts = [['sel', 'as selected'], [1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars']];
  for (const [v, label] of opts) {
    const b = document.createElement('button');
    b.className = 'mg-bar-btn' + (String(_barsChoice) === String(v) ? ' on' : '');
    b.textContent = label;
    b.addEventListener('click', () => { _barsChoice = v; renderBarsRow(); refreshSnap(); });
    row.appendChild(b);
  }
}

function renderStemPick() {
  const row = $('mg-stem-pick');
  if (!row) return;
  row.innerHTML = '';
  const stems = ['mix', ...currentStems()];
  if (!stems.includes(_stemChoice)) _stemChoice = 'mix';
  for (const s of stems) {
    const b = document.createElement('button');
    b.className = 'mg-stem-btn' + (s === _stemChoice ? ' on' : '');
    const color = s === 'mix' ? '#8cd8ff' : (STEM_COLORS[s] || '#888');
    b.style.color = color; b.style.borderColor = color;
    b.textContent = s === 'mix' ? 'full mix' : s;
    b.addEventListener('click', () => { _stemChoice = s; renderStemPick(); refreshSnap(); });
    row.appendChild(b);
  }
}

async function refreshSnap() {
  const sel = selection();
  const rawEl = $('mg-sel-raw'), snapEl = $('mg-sel-snap'), shiftEl = $('mg-sel-shift'), metaEl = $('mg-sel-meta');
  const buttons = ['mg-prev-btn', 'mg-track-btn', 'mg-dl-btn', 'mg-looper-btn'];
  if (!sel) {
    rawEl.textContent = 'nothing selected';
    snapEl.textContent = '—'; shiftEl.textContent = '—'; metaEl.textContent = '—';
    setStatus('mg-sample-status', 'Drag across the ruler to select a region first.');
    buttons.forEach(b => { const e = $(b); if (e) e.disabled = true; });
    _snap = null;
    return;
  }
  rawEl.textContent = `${fmtTime(sel.a)} → ${fmtTime(sel.b)}  (${(sel.b - sel.a).toFixed(2)} s)`;
  if (!_grid) {
    snapEl.textContent = 'no grid — the clip is cut exactly where you dragged';
    shiftEl.textContent = '0 ms / 0 ms';
    metaEl.textContent = (S._jobMeta?.bpm ? S._jobMeta.bpm + ' BPM' : 'tempo unknown');
    _snap = { start: sel.a, end: sel.b, bars: 0, snapped: false, raw: sel };
    buttons.forEach(b => { const e = $(b); if (e) e.disabled = false; });
    return;
  }
  const bar = _grid.bar_sec || 0;
  let end = sel.b;
  let minBars = 1;
  if (_barsChoice !== 'sel' && bar > 0) { minBars = Number(_barsChoice); end = sel.a + bar * minBars; }
  try {
    const q = new URLSearchParams({ start: sel.a.toFixed(4), end: Math.max(sel.a + 0.05, end).toFixed(4), min_bars: String(minBars) });
    if (S._sepId) q.set('sep_id', S._sepId); else q.set('job_id', S._jobId);
    const snap = await jsonOrThrow(await fetch('/beatgrid/snap?' + q.toString()));
    if (_barsChoice !== 'sel' && bar > 0) {
      let bars = minBars;
      const dur = _grid.duration || S._dur;
      while (bars > 1 && snap.start + bar * bars > dur) bars--;   // never run off the end
      snap.end = Math.min(dur, snap.start + bar * bars);
      snap.bars = bars;
      snap.end_shift_ms = Math.round((snap.end - sel.b) * 1000 * 10) / 10;
      if (bars < minBars) setStatus('mg-sample-status',
        `only ${bars} bar${bars === 1 ? '' : 's'} fit before the end of the song`);
    }
    _snap = { ...snap, raw: sel };
    snapEl.textContent = `${fmtTime(snap.start)} → ${fmtTime(snap.end)}  (${snap.bars} bar${snap.bars === 1 ? '' : 's'}, ${(snap.end - snap.start).toFixed(2)} s)`;
    shiftEl.textContent = `start ${snap.start_shift_ms >= 0 ? '+' : ''}${snap.start_shift_ms} ms · end ${snap.end_shift_ms >= 0 ? '+' : ''}${snap.end_shift_ms} ms`;
    const bpm = looperBpm(_grid.bpm);
    metaEl.textContent = `${bpm} BPM · ${_grid.key || 'key unknown'} · ${_stemChoice === 'mix' ? 'full mix' : _stemChoice}`;
    setStatus('mg-sample-status', '');
    buttons.forEach(b => { const e = $(b); if (e) e.disabled = false; });
  } catch (e) {
    setStatus('mg-sample-status', 'snap failed: ' + e.message, 'mg-bad');
  }
}

export function openSample() {
  $('sample-modal').classList.add('open');
  (async () => {
    try { await loadLibrary(); } catch (_) {}
    if (!_grid) await loadGrid();
    renderBanner('mg-sample-banner');
    renderBarsRow();
    renderStemPick();
    $('mg-sample-hint').innerHTML = _grid
      ? 'The clip is cut on the server with a 3 ms fade at each edge, so a bar-exact loop cannot click. '
        + 'Send to Looper opens the Looper, sets its BPM and scale lock, and loads the clip as the sampler '
        + 'instrument — click once in that window to let the browser start its audio.'
      : 'Without a grid the clip is cut exactly where you dragged, so it may not loop in time.';
    await refreshSnap();
  })();
}

export function closeSample() { $('sample-modal').classList.remove('open'); }

function sampleUrl(extra = {}) {
  if (!_snap) return null;
  const q = new URLSearchParams({
    start: Number(_snap.start).toFixed(4),
    end: Number(_snap.end).toFixed(4),
    snap: 'none',                     // already snapped by /beatgrid/snap — do not move it twice
    ...extra,
  });
  const jobId = S._jobId || _grid?.job_id;
  return _stemChoice === 'mix'
    ? `/beatgrid/sample/song/${jobId}?${q}`
    : `/beatgrid/sample/stem/${S._sepId}/${encodeURIComponent(_stemChoice)}?${q}`;
}

async function fetchSample() {
  const url = sampleUrl();
  if (!url) throw new Error('nothing selected');
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { msg = (await res.json()).detail || msg; } catch (_) {}
    throw new Error(msg);
  }
  const h = res.headers;
  return {
    bytes: await res.arrayBuffer(),
    name: h.get('X-Sample-Name') || 'sample',
    bpm: parseFloat(h.get('X-Sample-Bpm')) || (_grid ? _grid.bpm : 0),
    key: h.get('X-Sample-Key') || (_grid ? _grid.key : ''),
    bars: h.get('X-Sample-Bars'),
    start: parseFloat(h.get('X-Sample-Start')),
    end: parseFloat(h.get('X-Sample-End')),
  };
}

export async function previewSample() {
  if (_busy) return;
  _busy = true;
  setStatus('mg-sample-status', 'cutting…');
  try {
    const s = await fetchSample();
    const buf = await S._actx.decodeAudioData(s.bytes);
    const src = S._actx.createBufferSource();
    src.buffer = buf;
    src.connect(S._actx.destination);
    src.start();
    setStatus('mg-sample-status', `${s.bars} bar${s.bars === '1' ? '' : 's'} · ${buf.duration.toFixed(2)} s · playing`);
  } catch (e) {
    setStatus('mg-sample-status', 'preview failed: ' + e.message, 'mg-bad');
  } finally { _busy = false; }
}

export async function sampleToTrack() {
  if (_busy) return;
  _busy = true;
  setStatus('mg-sample-status', 'cutting…');
  try {
    const s = await fetchSample();
    const buf = await S._actx.decodeAudioData(s.bytes);
    const key = addImportedBuffer(buf, `${_stemChoice} ${s.bars}-bar @ ${fmtTime(s.start)}`);
    const t = key && S.tracks[key];
    if (t) {
      t.startTime = clamp(s.start, 0, Math.max(0, S._dur - 0.01));
      t.sourceBpm = Math.round(s.bpm);
      t._sample = { stem: _stemChoice, bars: s.bars, start: s.start, end: s.end, bpm: s.bpm, key: s.key };
      t.peaks = computePeaks(buf);
      const lbl = $('bpm-label-' + key);
      if (lbl) lbl.textContent = Math.round(s.bpm) + ' BPM';
    }
    redrawAll();
    setStatus('mg-sample-status', `added as a track at ${fmtTime(s.start)}`);
  } catch (e) {
    setStatus('mg-sample-status', 'add failed: ' + e.message, 'mg-bad');
  } finally { _busy = false; }
}

export async function downloadSample() {
  if (_busy) return;
  _busy = true;
  setStatus('mg-sample-status', 'cutting…');
  try {
    const s = await fetchSample();
    const url = URL.createObjectURL(new Blob([s.bytes], { type: 'audio/wav' }));
    const a = document.createElement('a');
    a.href = url; a.download = s.name + '.wav';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    setStatus('mg-sample-status', `downloaded ${s.name}.wav`);
  } catch (e) {
    setStatus('mg-sample-status', 'download failed: ' + e.message, 'mg-bad');
  } finally { _busy = false; }
}

// ── Studio → Looper handoff ───────────────────────────────────────────────────
// The Looper exposes its own controls on `window` (loadSample, chBPM, setScaleRoot,
// setScaleName) plus a `window.__looper` state handle. Both pages are same-origin, so a
// window this page opens can be driven through that public surface — no changes to any
// Looper file, and the Looper's own code does the loading.
const BRIDGE = ('BroadcastChannel' in window) ? new BroadcastChannel('waivepulse-bridge') : null;
let _looperSeen = 0;
if (BRIDGE) {
  BRIDGE.addEventListener('message', e => { if (e.data && e.data.type === 'ping') _looperSeen = Date.now(); });
}
const looperElsewhere = () => (Date.now() - _looperSeen) < 7000;

// The Looper's BPM control is 40–240, and a half/double-time count is the same tempo.
function looperBpm(bpm) {
  let b = Math.round(bpm || 0) || 120;
  while (b > 240) b = Math.round(b / 2);
  while (b < 40) b = Math.round(b * 2);
  return b;
}

function waitFor(test, ms = 20000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    (function tick() {
      let ok = false;
      try { ok = test(); } catch (_) { ok = false; }
      if (ok) return resolve(true);
      if (Date.now() - t0 > ms) return reject(new Error('the Looper window did not finish loading'));
      setTimeout(tick, 120);
    })();
  });
}

export async function sampleToLooper() {
  if (_busy) return;
  _busy = true;
  setStatus('mg-sample-status', 'cutting…');
  try {
    const s = await fetchSample();
    // Announce it on the existing bridge channel too, so any future Looper-side receiver
    // picks it up without this page having to drive the window.
    if (BRIDGE) {
      try {
        BRIDGE.postMessage({ type: 'studio-sample', name: s.name, bpm: s.bpm, key: s.key,
                             bars: s.bars, url: location.origin + sampleUrl() });
      } catch (_) {}
    }

    const foreign = looperElsewhere() && (!_looperWin || _looperWin.closed);
    setStatus('mg-sample-status', 'opening the Looper…');
    if (!_looperWin || _looperWin.closed) _looperWin = window.open('/looper', 'wp-looper');
    const w = _looperWin;
    if (!w) throw new Error('the browser blocked the Looper window — allow pop-ups for this page');
    try { w.focus(); } catch (_) {}
    await waitFor(() => w.__looper && typeof w.loadSample === 'function' && typeof w.chBPM === 'function');

    const bpm = looperBpm(s.bpm);
    const cur = Number(w.__looper.S.bpm) || 120;
    if (bpm !== cur) w.chBPM(bpm - cur);

    const pc = pitchClass(s.key);
    if (pc !== null && typeof w.setScaleRoot === 'function' && typeof w.setScaleName === 'function') {
      w.setScaleRoot(pc);
      w.setScaleName(/minor/i.test(s.key) ? 'minor' : 'major');
    }

    // loadSample(input) only ever touches input.files[0].arrayBuffer()/.name and clears
    // input.value — a plain object is a valid stand-in, and avoids handing a Blob across realms.
    const copy = s.bytes.slice(0);
    await w.loadSample({
      value: '',
      files: [{ name: s.name + '.wav', arrayBuffer: () => Promise.resolve(copy) }],
    });

    setStatus('mg-sample-status',
      `sent to the Looper · ${bpm} BPM · ${s.key || 'key unknown'} · ${s.bars} bar${s.bars === '1' ? '' : 's'}`
      + (foreign ? ' (a second Looper window was already open — this went to the one the Studio opened)' : ''));
  } catch (e) {
    setStatus('mg-sample-status', 'send failed: ' + e.message, 'mg-bad');
  } finally { _busy = false; }
}

// ── Wiring ────────────────────────────────────────────────────────────────────
function syncButtons() {
  const ready = !!(S._actx && Object.keys(S.tracks).length);
  const mb = $('mashup-btn'), sb = $('sample-btn');
  if (mb) {
    mb.disabled = !ready;
    if (!ready) mb.title = 'Wait for the song to finish loading.';
  }
  if (sb) sb.disabled = !ready;
}

function init() {
  injectToolbar();
  injectHelp();
  loadStatus();

  // Esc closes my modals before main.js's handler clears the ruler selection.
  document.addEventListener('keydown', e => {
    if (e.code === 'Escape') {
      if ($('mashup-modal')?.classList.contains('open')) { e.stopPropagation(); closeMashup(); return; }
      if ($('sample-modal')?.classList.contains('open')) { e.stopPropagation(); closeSample(); return; }
    }
    if ((e.key === 'g' || e.key === 'G') && !e.ctrlKey && !e.metaKey && !e.altKey
        && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) {
      toggleGridLines();
    }
  }, true);

  // Keep the sample panel honest while the selection is dragged.
  document.addEventListener('mouseup', () => {
    if ($('sample-modal')?.classList.contains('open')) refreshSnap();
  });

  // Zoom changes #ruler-inner's width → redraw the bar lines on the same geometry.
  const ruler = $('ruler-inner');
  if (ruler && 'ResizeObserver' in window) new ResizeObserver(() => renderLines()).observe(ruler);

  // The song is ready when Export Mix is enabled (boot.js does that last).
  const exp = $('export-btn');
  const ready = () => {
    syncButtons();
    if (S._actx && Object.keys(S.tracks).length && !_grid && !_gridErr) loadGrid();
  };
  if (exp) new MutationObserver(ready).observe(exp, { attributes: true, attributeFilter: ['disabled'] });
  ready();
  setTimeout(ready, 1500);
}

Object.assign(window, {
  openMashup, closeMashup, planMashup, buildMashup,
  openSample, closeSample, previewSample, sampleToTrack, downloadSample, sampleToLooper,
  toggleGridLines,
});

// Scripting surface for the automated browser checks.
window.WPMashup = {
  get grid() { return _grid; },
  get status() { return _status; },
  get plan() { return _plan; },
  get snap() { return _snap; },
  get library() { return _library; },
  loadGrid, loadLibrary, requestPlan, fetchSample, sampleUrl, refreshSnap,
  selection, looperBpm, setStem: s => { _stemChoice = s; renderStemPick(); return refreshSnap(); },
  setBars: b => { _barsChoice = b; renderBarsRow(); return refreshSnap(); },
  setRole: (role, v) => { const s = $('mg-src-' + role); if (s) { s.value = v; return true; } return false; },
  lastBuild: null,
};

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
