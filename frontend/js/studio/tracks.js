// Track model + per-track UI (sidebar strip + waveform row), duplicate/remove,
// import, selection, and the mix controls (mute/solo/normalize/reset/gains).
import { S, STEM_COLORS, IMPORT_COLOR } from './state.js';
import { Knob } from './knob.js';
import { wireTrack } from './audio-graph.js';
import { computePeaks, drawWaveform, drawPositionedWaveform, redrawAll, mergeRanges, soloCount } from './waveform.js';
import { applyZoom, seekTo, getCanvasWidth } from './transport.js';
import { openTrackEQ } from './eq-modal.js';

// ── Track helpers ──────────────────────────────────────────────────────────
export function baseStemOf(key) { const m = key.match(/^(.+?)_\d+$/); return m ? m[1] : key; }
export function nextDupKey(base) { let n = 2; while (S.tracks[`${base}_${n}`]) n++; return `${base}_${n}`; }

// ── Add a single track's UI (sidebar strip + waveform row) ──────────────────
export function addTrackToUI(stemKey) {
  const t = S.tracks[stemKey];
  const base = t.baseStem || stemKey;
  const color = t.isImport ? IMPORT_COLOR : (STEM_COLORS[base] || '#888');
  const sidebarTracks = document.getElementById('sidebar-tracks');
  const scrollContent = document.getElementById('scroll-content');

  // ── Control strip ──
  const strip = document.createElement('div');
  const isImport = t.isImport || false;
  strip.className = 'ctrl-strip' + (t.isDuplicate ? ' is-dup' : '') + (isImport ? ' is-import' : '');
  strip.dataset.stem = stemKey;

  // Row 1
  const r1 = document.createElement('div'); r1.className = 'ctrl-row1';
  const nameEl = document.createElement('span');
  nameEl.className = 'track-name'; nameEl.style.color = color;
  nameEl.textContent = isImport ? (t.importName || stemKey) :
    t.isDuplicate ? `${base} ×${stemKey.split('_')[1]}` : stemKey;
  const mBtn = document.createElement('button');
  mBtn.className = 'tb'; mBtn.textContent = 'M'; mBtn.title = 'Mute';
  mBtn.id = 'm-' + stemKey; mBtn.onclick = () => toggleMute(stemKey);
  const sBtn = document.createElement('button');
  sBtn.className = 'tb'; sBtn.textContent = 'S'; sBtn.title = 'Solo';
  sBtn.id = 's-' + stemKey; sBtn.onclick = () => toggleSolo(stemKey);
  const nBtn = document.createElement('button');
  nBtn.className = 'tb tb-norm'; nBtn.textContent = 'NRM'; nBtn.title = 'Normalize';
  nBtn.onclick = () => normalizeTrack(stemKey);
  const rBtn = document.createElement('button');
  rBtn.className = 'tb tb-norm'; rBtn.textContent = 'RST'; rBtn.title = 'Reset knobs';
  rBtn.style.color = '#666'; rBtn.onclick = () => resetTrack(stemKey);
  const eqBtn = document.createElement('button');
  eqBtn.className = 'tb tb-norm'; eqBtn.textContent = 'EQ'; eqBtn.title = 'Open visual EQ editor';
  eqBtn.style.color = '#ffe066'; eqBtn.onclick = e => { e.stopPropagation(); openTrackEQ(stemKey); };

  if (isImport) {
    const lBtn = document.createElement('button');
    lBtn.className = 'tb'; lBtn.textContent = '⟳'; lBtn.title = 'Loop this track';
    lBtn.id = 'lp-' + stemKey;
    lBtn.classList.toggle('active', !!t.loopTrack);
    lBtn.onclick = () => {
      t.loopTrack = !t.loopTrack;
      lBtn.classList.toggle('active', t.loopTrack);
      if (t.source) t.source.loop = t.loopTrack;
    };
    const xBtn = document.createElement('button');
    xBtn.className = 'tb'; xBtn.textContent = '×'; xBtn.title = 'Remove track';
    xBtn.style.color = '#e05555'; xBtn.onclick = () => removeTrack(stemKey);
    r1.append(nameEl, mBtn, sBtn, nBtn, rBtn, eqBtn, lBtn, xBtn);
  } else {
    const dBtn = document.createElement('button');
    if (t.isDuplicate) {
      dBtn.className = 'tb'; dBtn.textContent = '×'; dBtn.title = 'Remove this duplicate';
      dBtn.style.color = '#e05555'; dBtn.onclick = () => removeTrack(stemKey);
    } else {
      dBtn.className = 'tb tb-norm'; dBtn.textContent = 'DUP'; dBtn.title = 'Duplicate this track';
      dBtn.style.color = '#6af'; dBtn.onclick = () => duplicateTrack(stemKey);
    }
    r1.append(nameEl, mBtn, sBtn, nBtn, rBtn, eqBtn, dBtn);
  }

  // Row 2: 9 knobs — VOL, PAN, SUB, BASS, MID, TREB, REV, DLY, OFS
  const r2 = document.createElement('div'); r2.className = 'ctrl-row2';
  const x = S._actx;
  t.knobs.vol = new Knob(r2, { label: 'VOL', min: 0, max: 1.5, value: t.volume, def: 1, color, bipolar: false,
    onChange: v => { t.volume = v; applyGains(); } });
  t.knobs.pan = new Knob(r2, { label: 'PAN', min: -1, max: 1, value: t.pan, def: 0, color, bipolar: true,
    onChange: v => { t.pan = v; t.panNode.pan.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.sub = new Knob(r2, { label: 'SUB', min: -12, max: 12, value: t.eqS || 0, def: 0, color, bipolar: true,
    onChange: v => { t.eqS = v; if (t.eqSub) t.eqSub.gain.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.bass = new Knob(r2, { label: 'BASS', min: -12, max: 12, value: t.eqB, def: 0, color, bipolar: true,
    onChange: v => { t.eqB = v; t.eqBass.gain.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.mid = new Knob(r2, { label: 'MID', min: -12, max: 12, value: t.eqM, def: 0, color, bipolar: true,
    onChange: v => { t.eqM = v; t.eqMid.gain.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.treb = new Knob(r2, { label: 'TREB', min: -12, max: 12, value: t.eqT, def: 0, color, bipolar: true,
    onChange: v => { t.eqT = v; t.eqTreble.gain.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.rev = new Knob(r2, { label: 'REV', min: 0, max: 1, value: t.revAmt, def: 0, color, bipolar: false,
    onChange: v => { t.revAmt = v; t.reverbSend.gain.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.dly = new Knob(r2, { label: 'DLY', min: 0, max: 1, value: t.dlyAmt, def: 0, color, bipolar: false,
    onChange: v => { t.dlyAmt = v; t.delaySend.gain.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.ofs = new Knob(r2, { label: 'OFS', min: 0, max: 50, value: t.offset * 1000, def: 0, color, bipolar: false,
    onChange: v => { t.offset = v / 1000; if (t.offsetNode) t.offsetNode.delayTime.setTargetAtTime(v / 1000, x.currentTime, 0.005); } });

  strip.append(r1, r2);
  strip.addEventListener('mousedown', () => selectTrack(stemKey));

  // Insert strip after last sibling with same baseStem, otherwise append
  const strips = [...sidebarTracks.querySelectorAll('.ctrl-strip')];
  const lastSib = strips.filter(s => baseStemOf(s.dataset.stem) === base).pop();
  if (lastSib) lastSib.after(strip); else sidebarTracks.appendChild(strip);

  // ── Waveform row ──
  const row = document.createElement('div');
  row.className = 'track-row'; row.dataset.stem = stemKey;
  if (t.isDuplicate) row.style.opacity = '0.75';
  row.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    selectTrack(stemKey);
    const pos = (e.offsetX / getCanvasWidth()) * S._dur;
    const tk = S.tracks[stemKey];
    if (e.shiftKey) {
      e.preventDefault();
      S._rangeDrawing = { stemKey, startPos: pos, currentPos: pos };
    } else if (tk?.isImport && !tk.loopTrack) {
      const muteIdx = (tk?.muteRanges || []).findIndex(r => pos >= r.start && pos <= r.end);
      if (muteIdx >= 0) { tk.muteRanges.splice(muteIdx, 1); redrawAll(); }
      else {
        const st = tk.startTime || 0, end = st + (tk.buffer?.duration || 0);
        if (pos >= st && pos <= end) {
          e.preventDefault();
          S._trackPosDrag = { stemKey, songX0: e.clientX, startTime0: st, muteRanges0: (tk.muteRanges || []).map(r => ({ ...r })) };
          row.style.cursor = 'grabbing';
        } else { seekTo(pos); }
      }
    } else {
      const idx = (tk?.muteRanges || []).findIndex(r => pos >= r.start && pos <= r.end);
      if (idx >= 0) { tk.muteRanges.splice(idx, 1); redrawAll(); }
      else seekTo(pos);
    }
  });
  row.addEventListener('mousemove', e => {
    const tk = S.tracks[stemKey];
    const pos = (e.offsetX / getCanvasWidth()) * S._dur;
    if (tk?.isImport && !tk.loopTrack) {
      const inR = (tk?.muteRanges || []).some(r => pos >= r.start && pos <= r.end);
      const st = tk.startTime || 0, end = st + (tk.buffer?.duration || 0);
      row.style.cursor = e.shiftKey ? 'crosshair' : inR ? 'pointer' : (pos >= st && pos <= end) ? 'grab' : 'default';
    } else {
      const inR = (tk?.muteRanges || []).some(r => pos >= r.start && pos <= r.end);
      row.style.cursor = e.shiftKey ? 'crosshair' : inR ? 'pointer' : 'default';
    }
  });
  const canvas = document.createElement('canvas');
  canvas.className = 'waveform';
  row.appendChild(canvas);

  // Insert after last sibling row with same baseStem, otherwise before playhead
  const rows = [...scrollContent.querySelectorAll('.track-row')];
  const lastRow = rows.filter(r => baseStemOf(r.dataset.stem) === base).pop();
  const playhead = document.getElementById('playhead');
  if (lastRow) lastRow.after(row); else scrollContent.insertBefore(row, playhead);
  t.canvas = canvas;

  requestAnimationFrame(() => {
    if (!t.peaks) t.peaks = computePeaks(t.buffer);
    if (t.isImport) drawPositionedWaveform(canvas, t.peaks, IMPORT_COLOR, false, t.startTime || 0, t.buffer.duration, S._dur);
    else drawWaveform(canvas, t.peaks, color, false);
  });
}

// ── Duplicate / remove tracks ───────────────────────────────────────────────
export function duplicateTrack(stemKey) {
  const base = baseStemOf(stemKey);
  const orig = S.tracks[base] || S.tracks[stemKey];
  if (!orig) return;
  const newKey = nextDupKey(base);
  const gainNode = S._actx.createGain();
  S.tracks[newKey] = {
    buffer: orig.buffer, source: null, gainNode,
    muted: false, solo: false,
    volume: 1, pan: 0, eqS: 0, eqB: 0, eqM: 0, eqT: 0, revAmt: 0, dlyAmt: 0,
    offset: 0,
    isDuplicate: true, isImport: false, baseStem: base,
    peaks: orig.peaks, canvas: null, knobs: {}, muteRanges: [],
  };
  wireTrack(newKey);
  addTrackToUI(newKey);
  applyZoom();
}

export function removeTrack(stemKey) {
  const t = S.tracks[stemKey];
  if (!t || (!t.isDuplicate && !t.isImport)) return;
  if (t.source) { try { t.source.stop(); } catch {} t.source = null; }
  try {
    if (t.offsetNode) t.offsetNode.disconnect();
    t.gainNode.disconnect(); t.panNode.disconnect();
    t.eqBass.disconnect(); t.eqMid.disconnect(); t.eqTreble.disconnect();
    t.reverbSend.disconnect(); t.delaySend.disconnect();
  } catch {}
  document.querySelector(`#sidebar-tracks .ctrl-strip[data-stem="${stemKey}"]`)?.remove();
  document.querySelector(`#scroll-content .track-row[data-stem="${stemKey}"]`)?.remove();
  delete S.tracks[stemKey];
}

// ── Import ──────────────────────────────────────────────────────────────────
export async function handleImportFiles(files) {
  if (!files || !files.length) return;
  if (!S._actx) { alert('Please load a song first before importing tracks.'); return; }
  for (const file of files) {
    try {
      const ab = await file.arrayBuffer();
      const abuf = await S._actx.decodeAudioData(ab);
      S._importCounter++;
      const key = 'import_' + S._importCounter;
      const gainNode = S._actx.createGain();
      S.tracks[key] = {
        buffer: abuf, source: null, gainNode,
        muted: false, solo: false,
        volume: 1, pan: 0, eqB: 0, eqM: 0, eqT: 0, revAmt: 0, dlyAmt: 0,
        offset: 0,
        isDuplicate: false, isImport: true, baseStem: key,
        importName: file.name.replace(/\.[^.]+$/, ''), loopTrack: false, startTime: 0,
        eqS: 0, peaks: null, canvas: null, knobs: {}, muteRanges: [], _inMuteRange: false,
      };
      wireTrack(key);
      addTrackToUI(key);
      applyZoom();
    } catch (err) {
      console.warn('Could not import ' + file.name + ':', err);
      alert('Could not import ' + file.name + ':\n' + err.message);
    }
  }
}

// ── Mix controls ────────────────────────────────────────────────────────────
export function applyGains() {
  const sc = soloCount();
  for (const [, t] of Object.entries(S.tracks)) {
    let g = t.volume;
    if (t.muted || (sc > 0 && !t.solo) || t._inMuteRange) g = 0;
    t.gainNode.gain.setTargetAtTime(g, S._actx ? S._actx.currentTime : 0, 0.015);
  }
  redrawAll();
}

export function applyRangedGains(pos) {
  const sc = soloCount();
  for (const [, t] of Object.entries(S.tracks)) {
    const inRange = !!(t.muteRanges && t.muteRanges.some(r => pos >= r.start && pos <= r.end));
    if (inRange === t._inMuteRange) continue;
    t._inMuteRange = inRange;
    let g = t.volume;
    if (t.muted || (sc > 0 && !t.solo) || inRange) g = 0;
    t.gainNode.gain.setTargetAtTime(g, S._actx.currentTime, 0.005);
  }
}

export function toggleMute(stem) {
  const t = S.tracks[stem]; t.muted = !t.muted;
  document.getElementById('m-' + stem).classList.toggle('mute-on', t.muted); applyGains();
}

export function toggleSolo(stem) {
  const t = S.tracks[stem]; t.solo = !t.solo;
  document.getElementById('s-' + stem).classList.toggle('solo-on', t.solo); applyGains();
}

export function normalizeTrack(stem) {
  const t = S.tracks[stem];
  const data = t.buffer.getChannelData(0);
  let peak = 0; for (let i = 0; i < data.length; i++) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
  if (peak < .001) return;
  t.knobs.vol.set(Math.min(1.5, .95 / peak));
}

export function resetTrack(stem) {
  const t = S.tracks[stem];
  Object.values(t.knobs).forEach(k => k.set(k.def));
}

export function resetAllTracks() {
  Object.keys(S.tracks).forEach(resetTrack);
}

// ── Track selection ──────────────────────────────────────────────────────────
export function selectTrack(key) {
  S._selectedTrack = key;
  document.querySelectorAll('.ctrl-strip,.track-row').forEach(el => el.classList.remove('selected'));
  document.querySelector(`#sidebar-tracks .ctrl-strip[data-stem="${key}"]`)?.classList.add('selected');
  document.querySelector(`#scroll-content .track-row[data-stem="${key}"]`)?.classList.add('selected');
}

export function cycleTrack(dir) {
  const keys = Object.keys(S.tracks); if (!keys.length) return;
  const idx = S._selectedTrack ? keys.indexOf(S._selectedTrack) : -1;
  selectTrack(keys[(idx + dir + keys.length) % keys.length]);
}
