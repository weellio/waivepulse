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
    lBtn.className = 'tb'; lBtn.textContent = '⟳ FILL';
    lBtn.title = 'Fill: loop this clip across the whole song (then shift-drag the waveform to mute sections)';
    lBtn.id = 'lp-' + stemKey;
    lBtn.classList.toggle('active', !!t.loopTrack);
    lBtn.onclick = () => {
      t.loopTrack = !t.loopTrack;
      lBtn.classList.toggle('active', t.loopTrack);
      if (t.source) t.source.loop = t.loopTrack;
      redrawAll();                         // tile (or un-tile) the clip across the timeline
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

  // Row 2: 5 knobs — VOL, PAN, REV, DLY, OFS (tone is handled by the 7-band EQ modal)
  const r2 = document.createElement('div'); r2.className = 'ctrl-row2';
  const x = S._actx;
  t.knobs.vol = new Knob(r2, { label: 'VOL', min: 0, max: 1.5, value: t.volume, def: 1, color, bipolar: false,
    onChange: v => { t.volume = v; applyGains(); } });
  t.knobs.pan = new Knob(r2, { label: 'PAN', min: -1, max: 1, value: t.pan, def: 0, color, bipolar: true,
    onChange: v => { t.pan = v; t.panNode.pan.setTargetAtTime(v, x.currentTime, 0.01); } });
  // Per-track EQ now lives entirely in the 7-band parametric EQ (the "EQ" button) —
  // the old SUB/BASS/MID/TREB shelf knobs were removed to avoid two redundant EQs.
  t.knobs.rev = new Knob(r2, { label: 'REV', min: 0, max: 1, value: t.revAmt, def: 0, color, bipolar: false,
    onChange: v => { t.revAmt = v; t.reverbSend.gain.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.dly = new Knob(r2, { label: 'DLY', min: 0, max: 1, value: t.dlyAmt, def: 0, color, bipolar: false,
    onChange: v => { t.dlyAmt = v; t.delaySend.gain.setTargetAtTime(v, x.currentTime, 0.01); } });
  t.knobs.ofs = new Knob(r2, { label: 'OFS', min: 0, max: 50, value: t.offset * 1000, def: 0, color, bipolar: false,
    onChange: v => { t.offset = v / 1000; if (t.offsetNode) t.offsetNode.delayTime.setTargetAtTime(v / 1000, x.currentTime, 0.005); } });

  strip.append(r1, r2);

  // Row 3 (import tracks only): BPM + time-stretch controls
  if (isImport) {
    const r3 = document.createElement('div');
    r3.className = 'ctrl-row3';
    r3.style.cssText = 'display:flex;align-items:center;gap:4px;margin-top:2px;font-size:10px';
    const bpmLbl = document.createElement('span');
    bpmLbl.id = 'bpm-label-' + stemKey;
    bpmLbl.style.cssText = 'color:#999;min-width:50px';
    bpmLbl.textContent = t.sourceBpm ? `${t.sourceBpm} BPM` : '? BPM';
    const arrow = document.createElement('span');
    arrow.textContent = '→'; arrow.style.color = '#555';
    const tgtInput = document.createElement('input');
    tgtInput.type = 'number'; tgtInput.id = 'stretch-target-' + stemKey;
    tgtInput.placeholder = S._jobMeta?.bpm || 'BPM';
    tgtInput.value = S._jobMeta?.bpm || '';
    tgtInput.min = 20; tgtInput.max = 999; tgtInput.step = 1;
    tgtInput.style.cssText = 'width:48px;background:#1a1a1a;border:1px solid #333;color:#ddd;border-radius:3px;padding:1px 3px;font-size:10px;text-align:center';
    const strBtn = document.createElement('button');
    strBtn.className = 'tb tb-norm'; strBtn.textContent = 'STRETCH';
    strBtn.id = 'stretch-btn-' + stemKey;
    strBtn.title = 'Time-stretch to match target BPM (preserves pitch)';
    strBtn.style.cssText = 'font-size:9px;padding:1px 4px;color:#4ae8d4';
    strBtn.onclick = e => {
      e.stopPropagation();
      const srcBpm = t.sourceBpm;
      const tgtBpm = parseInt(tgtInput.value);
      if (!srcBpm) { alert('Source BPM unknown. Drag-drop an audio file — BPM will be auto-detected.'); return; }
      if (!tgtBpm || tgtBpm < 20) { alert('Enter a valid target BPM.'); return; }
      const factor = srcBpm / tgtBpm;
      stretchTrack(stemKey, factor);
    };
    r3.append(bpmLbl, arrow, tgtInput, strBtn);
    strip.appendChild(r3);
  }

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
    // content-x from the row's left edge (robust if the click lands on a child element;
    // the row scrolls with the content so its rect already accounts for scroll/zoom)
    const pos = ((e.clientX - row.getBoundingClientRect().left) / getCanvasWidth()) * S._dur;
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
    if (t.eq) t.eq.output.disconnect();
    t.reverbSend.disconnect(); t.delaySend.disconnect();
  } catch {}
  document.querySelector(`#sidebar-tracks .ctrl-strip[data-stem="${stemKey}"]`)?.remove();
  document.querySelector(`#scroll-content .track-row[data-stem="${stemKey}"]`)?.remove();
  delete S.tracks[stemKey];
}

// ── Time-stretch ──────────────────────────────────────────────────────────
export async function stretchTrack(stemKey, factor) {
  const t = S.tracks[stemKey];
  if (!t || !t.buffer) return;
  if (factor < 0.25 || factor > 4.0) { alert('Stretch factor must be between 0.25 and 4.0'); return; }
  if (Math.abs(factor - 1.0) < 0.005) return;   // no-op

  // Keep original buffer for re-stretching without quality loss
  if (!t._originalBuffer) t._originalBuffer = t.buffer;

  const btn = document.getElementById('stretch-btn-' + stemKey);
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }

  try {
    let res;
    if (t._stemRef) {
      // Server-side stem — use the efficient path
      res = await fetch(`/timestretch/${t._stemRef.sepId}/${t._stemRef.stemName}?factor=${factor}`, { method: 'POST' });
    } else {
      // Upload the original buffer as WAV
      const wav = _bufferToWav(t._originalBuffer);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'track.wav');
      res = await fetch(`/timestretch?factor=${factor}`, { method: 'POST', body: form });
    }
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(e.detail || `Server error ${res.status}`); }
    const ab = await res.arrayBuffer();
    const abuf = await S._actx.decodeAudioData(ab);
    t.buffer = abuf;
    t.stretchFactor = factor;
    t.peaks = computePeaks(abuf);
    redrawAll();

    // Update BPM label if we know the source BPM
    const bpmEl = document.getElementById('bpm-label-' + stemKey);
    if (bpmEl && t.sourceBpm) {
      const newBpm = Math.round(t.sourceBpm * factor);
      bpmEl.textContent = `${newBpm} BPM`;
    }
  } catch (err) {
    console.warn('Time-stretch failed:', err);
    alert('Time-stretch failed: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'STRETCH'; }
  }
}

function _bufferToWav(buffer) {
  const nc = buffer.numberOfChannels, sr = buffer.sampleRate, ns = buffer.length;
  const dl = ns * nc * 2;
  const view = new DataView(new ArrayBuffer(44 + dl));
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); view.setUint32(4, 36 + dl, true); ws(8, 'WAVE');
  ws(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, nc, true);
  view.setUint32(24, sr, true); view.setUint32(28, sr * nc * 2, true); view.setUint16(32, nc * 2, true); view.setUint16(34, 16, true);
  ws(36, 'data'); view.setUint32(40, dl, true);
  let o = 44;
  const ch = []; for (let c = 0; c < nc; c++) ch.push(buffer.getChannelData(c));
  for (let i = 0; i < ns; i++) for (let c = 0; c < nc; c++) {
    const s = Math.max(-1, Math.min(1, ch[c][i]));
    view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
  }
  return view.buffer;
}

// ── Import ──────────────────────────────────────────────────────────────────
export async function handleImportFiles(files) {
  if (!files || !files.length) return;
  if (!S._actx) { alert('Please load a song first before importing tracks.'); return; }
  for (const file of files) {
    try {
      const ab = await file.arrayBuffer();
      const abuf = await S._actx.decodeAudioData(ab);
      const key = addImportedBuffer(abuf, file.name.replace(/\.[^.]+$/, ''));
      // Detect BPM in background (non-blocking)
      if (key) {
        const form = new FormData();
        form.append('file', file);
        fetch('/detect-bpm', { method: 'POST', body: form })
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (d?.bpm && S.tracks[key]) {
              S.tracks[key].sourceBpm = d.bpm;
              const lbl = document.getElementById('bpm-label-' + key);
              if (lbl) lbl.textContent = d.bpm + ' BPM';
            }
          }).catch(() => {});
      }
    } catch (err) {
      console.warn('Could not import ' + file.name + ':', err);
      alert('Could not import ' + file.name + ':\n' + err.message);
    }
  }
}

// Create an import track straight from a decoded AudioBuffer (shared by file import
// and the Looper → Studio bridge). Returns the new track key.
export function addImportedBuffer(abuf, name) {
  if (!S._actx) return null;
  S._importCounter++;
  const key = 'import_' + S._importCounter;
  const gainNode = S._actx.createGain();
  S.tracks[key] = {
    buffer: abuf, source: null, gainNode,
    muted: false, solo: false,
    volume: 1, pan: 0, eqB: 0, eqM: 0, eqT: 0, revAmt: 0, dlyAmt: 0,
    offset: 0,
    isDuplicate: false, isImport: true, baseStem: key,
    importName: name || ('import ' + S._importCounter), loopTrack: false, startTime: 0,
    eqS: 0, peaks: null, canvas: null, knobs: {}, muteRanges: [], _inMuteRange: false,
  };
  wireTrack(key);
  addTrackToUI(key);
  applyZoom();
  return key;
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
