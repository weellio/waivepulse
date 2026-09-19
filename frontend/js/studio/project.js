// Project save / open (.wpproj).
//
// A .wpproj is a plain ZIP (STORE, no compression — written by the tiny writer
// below, no library/CDN) containing:
//   project.json        — the whole studio state (see buildProjectJson)
//   audio/<track>.wav   — audio that can't be rebuilt from the server: imported,
//                         spliced, stretched and key-shifted tracks
// Untouched separated stems are NOT embedded: they're referenced by sep_id + stem
// name and re-fetched from the server; ripple cuts are stored as a cut log and
// replayed on them. If the separation is gone from the server, the user is told
// which tracks can't be restored and everything embedded still opens.
import { S } from './state.js';
import { snapshotEq, setBand } from '../shared/eq7.js';
import { wireTrack, applySidechain, removeSidechain, populateSidechainDropdowns, setSidechainParam } from './audio-graph.js';
import { addTrackToUI, applyGains, baseStemOf } from './tracks.js';
import { snapshotMix, restoreMix } from './presets.js';
import { audioBufferToWav } from './export.js';
import { spliceBuffer } from './edit.js';
import { getMarkers, setMarkers } from './markers.js';
import { cloneAuto, scheduleAutomation, drawAllLanes } from './automation.js';
import { stopPlayback, applyZoom, buildRuler, updateLoopRegion, updatePlayhead } from './transport.js';
import { updateAudioInfo } from './pitch.js';
import { refreshSpecButton } from './spectrogram.js';
import { fmtTime, setOverlay, hideOverlay } from './util.js';
import { ensureAudioEngine, finishUI } from './boot.js';

export const PROJECT_VERSION = 1;

// ── Minimal ZIP (STORE) writer / reader ─────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// files: [{ name, data: Uint8Array }] → Blob (application/zip)
export function makeZip(files) {
  const enc = new TextEncoder(), parts = [], central = [];
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name), data = f.data, crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);
    offset += 30 + name.length + data.length;
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const eo = new DataView(new ArrayBuffer(22));
  eo.setUint32(0, 0x06054b50, true); eo.setUint16(8, files.length, true); eo.setUint16(10, files.length, true);
  eo.setUint32(12, cdSize, true); eo.setUint32(16, offset, true);
  return new Blob([...parts, ...central, eo.buffer], { type: 'application/zip' });
}

// ArrayBuffer → Map(name → Uint8Array). Handles STORE and (via DecompressionStream) DEFLATE.
export async function readZip(ab) {
  const u8 = new Uint8Array(ab), dv = new DataView(ab);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('not a .wpproj / zip file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder(), out = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip directory');
    const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lo = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
    const dataStart = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    let data = u8.subarray(dataStart, dataStart + csize);
    if (method === 8) {
      const ds = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      data = new Uint8Array(await new Response(ds).arrayBuffer());
    } else if (method !== 0) throw new Error(`unsupported zip compression (${method}) for ${name}`);
    out.set(name, data);
    p += 46 + nlen + elen + clen;
  }
  return out;
}

// ── Capture ───────────────────────────────────────────────────────────────
const r4 = v => (typeof v === 'number' && isFinite(v)) ? Math.round(v * 1e4) / 1e4 : v;
const roundDeep = o => JSON.parse(JSON.stringify(o, (k, v) => r4(v)));
const safeName = k => String(k).replace(/[^\w.-]+/g, '_');

function trackKind(t) { return t.isImport ? 'import' : (t.isDuplicate ? 'dup' : 'stem'); }

// Build project.json (audio=true also returns the WAV files to embed).
export function buildProjectJson({ withAudio = false } = {}) {
  const files = [], bufPath = new Map();
  const tracks = [];
  // UI order (sidebar), falls back to insertion order
  const uiOrder = [...document.querySelectorAll('#sidebar-tracks .ctrl-strip')].map(s => s.dataset.stem).filter(k => S.tracks[k]);
  const keys = uiOrder.length === Object.keys(S.tracks).length ? uiOrder : Object.keys(S.tracks);
  for (const key of keys) {
    const t = S.tracks[key];
    const kind = trackKind(t);
    let audio;
    if (kind !== 'import' && !t._editedAudio && !t.pitchSemis && S._sepId) {
      audio = { type: 'sep', sepId: S._sepId, stem: t.baseStem || baseStemOf(key) };
    } else if (bufPath.has(t.buffer)) {
      audio = { type: 'file', path: bufPath.get(t.buffer) };
    } else {
      const path = `audio/${safeName(key)}.wav`;
      bufPath.set(t.buffer, path);
      audio = { type: 'file', path };
      if (withAudio) files.push({ name: path, buffer: t.buffer });
    }
    tracks.push({
      key, kind, baseStem: t.baseStem || baseStemOf(key),
      name: t.importName || null,
      volume: t.volume, pan: t.pan, revAmt: t.revAmt || 0, dlyAmt: t.dlyAmt || 0, offset: t.offset || 0,
      eq7: t.eq ? snapshotEq(t.eq).map(b => ({ id: b.id, freq: b.freq, gain: b.gain, q: b.q })) : null,
      muted: !!t.muted, solo: !!t.solo,
      muteRanges: (t.muteRanges || []).map(r => ({ start: r.start, end: r.end })),
      auto: cloneAuto(t.auto), autoShow: !!t.autoShow, autoMode: t.autoMode || 'vol', showSpec: !!t.showSpec,
      startTime: t.startTime || 0, loopTrack: !!t.loopTrack,
      sourceBpm: t.sourceBpm || null, stretchFactor: t.stretchFactor || null,
      pitchSemis: t.pitchSemis || 0, editedAudio: !!t._editedAudio,
      stemRef: t._stemRef ? { sepId: t._stemRef.sepId, stemName: t._stemRef.stemName } : null,
      duration: t.buffer ? t.buffer.duration : 0,
      audio,
    });
  }
  const mix = snapshotMix();
  const master = mix.master;
  // read exact UI values rather than possibly-still-ramping AudioParams
  const mv = document.getElementById('master-vol'); if (mv) master.volume = (+mv.value) / 100;
  const scT = document.getElementById('sc-thresh'), scR = document.getElementById('sc-ratio');
  const json = roundDeep({
    app: 'WAIvePulse Studio', version: PROJECT_VERSION,
    title: S._title || '', sepId: S._sepId || null, jobId: S._jobId || null,
    jobMeta: S._jobMeta ? { bpm: S._jobMeta.bpm ?? null, key: S._jobMeta.key ?? null, title: S._jobMeta.title ?? null } : null,
    dur: S._dur,
    cutLog: (S._cutLog || []).map(c => ({ a: c.a, len: c.len })),
    zoom: S._zoom, loop: { start: S._loopStart, end: S._loopEnd, on: !!S._looping },
    activePreset: S._activePreset || 'full',
    markers: getMarkers(),
    master,
    sidechain: {
      enabled: !!S._sidechainEnabled, key: S._sidechainKeyTrack, target: S._sidechainTargetTrack,
      threshold: scT ? +scT.value : -20, ratio: scR ? +scR.value : 4,
    },
    showChords: !!S._showChords,
    tracks,
  });
  return withAudio ? { json, files } : json;
}

// Comparable state (drops volatile fields) — used by the round-trip self-test.
export function projectState() { return buildProjectJson(); }

// ── Save ──────────────────────────────────────────────────────────────────
export async function saveProject() {
  if (!S._actx || !Object.keys(S.tracks).length) { alert('Load a song first.'); return; }
  const btn = document.getElementById('proj-save-btn');
  const label = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Saving…'; }
  try {
    const { json, files } = buildProjectJson({ withAudio: true });
    json.savedAt = new Date().toISOString();
    const zipFiles = [{ name: 'project.json', data: new TextEncoder().encode(JSON.stringify(json, null, 1)) }];
    for (const f of files) {
      await new Promise(r => setTimeout(r, 0));
      zipFiles.push({ name: f.name, data: new Uint8Array(audioBufferToWav(f.buffer)) });
    }
    const blob = makeZip(zipFiles);
    S._lastProjectBytes = blob.size;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url;
    a.download = (S._title || 'project').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') + '.wpproj';
    a.click(); setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`Project saved (${(blob.size / 1048576).toFixed(1)} MB, ${files.length} embedded track${files.length === 1 ? '' : 's'})`);
  } catch (e) { alert('Save Project failed: ' + e.message); }
  finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
}

// ── Open ──────────────────────────────────────────────────────────────────
export function pickProjectFile() {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = '.wpproj,application/zip';
  inp.onchange = () => { if (inp.files[0]) openProjectFile(inp.files[0]); };
  inp.click();
}

function teardownTracks() {
  if (S._sidechainEnabled) removeSidechain();
  for (const [k, t] of Object.entries(S.tracks)) {
    if (t.source) { try { t.source.stop(); } catch {} t.source = null; }
    for (const n of [t.offsetNode, t.gainNode, t.autoGain, t.autoPan, t.panNode, t.eq?.output, t.reverbSend, t.delaySend]) {
      try { n && n.disconnect(); } catch {}
    }
    delete S.tracks[k];
  }
  document.getElementById('sidebar-tracks').innerHTML = '';
  document.querySelectorAll('#scroll-content .track-row').forEach(e => e.remove());
}

export async function openProjectFile(file) {
  let proj, entries;
  try {
    entries = await readZip(await file.arrayBuffer());
    const pj = entries.get('project.json');
    if (!pj) throw new Error('project.json is missing — this is not a WAIvePulse project');
    proj = JSON.parse(new TextDecoder().decode(pj));
  } catch (e) { alert('Could not open project: ' + e.message); return false; }
  if ((proj.version || 1) > PROJECT_VERSION) {
    if (!confirm(`This project was saved by a newer Studio (v${proj.version}). Try to open it anyway?`)) return false;
  }
  const ptracks = Array.isArray(proj.tracks) ? proj.tracks : [];

  // Which separations do we need, and are they still on this server?
  const sepIds = [...new Set(ptracks.filter(t => t.audio?.type === 'sep').map(t => t.audio.sepId))];
  const sepInfo = {};
  for (const id of sepIds) {
    try {
      const r = await fetch(`/separate/status/${id}`);
      const j = r.ok ? await r.json() : null;
      sepInfo[id] = j && j.status === 'done' && j.stems ? j : null;
    } catch { sepInfo[id] = null; }
  }
  const missing = ptracks.filter(t => t.audio?.type === 'sep' && (!sepInfo[t.audio.sepId] || !sepInfo[t.audio.sepId].stems[t.audio.stem]));
  const missingFiles = ptracks.filter(t => t.audio?.type === 'file' && !entries.has(t.audio.path));
  const loadable = ptracks.length - missing.length - missingFiles.length;
  if (missing.length) {
    const ids = [...new Set(missing.map(t => t.audio.sepId))].join(', ');
    const msg = `This project's separated stems (sep_id ${ids}) are no longer on this server, so ${missing.length} track(s) can't be restored: ${missing.map(t => t.key).join(', ')}.\n\n` +
      (loadable > 0 ? `The ${loadable} embedded track(s) will still open. Re-separate the original song to get the stems back.` : 'Nothing else in the project can be opened. Re-separate the original song, then open the project again.');
    if (loadable <= 0) { alert(msg); return false; }
    if (!confirm(msg + '\n\nOpen the rest anyway?')) return false;
  }
  if (!loadable) { alert('This project contains no loadable tracks.'); return false; }

  try {
    setOverlay('Opening project…', proj.title || file.name, true);
    await ensureAudioEngine();
    if (S._playing) stopPlayback();
    teardownTracks();

    // ── Decode audio ──
    const cutLog = Array.isArray(proj.cutLog) ? proj.cutLog : [];
    const sepBufs = new Map(), fileBufs = new Map();
    let done = 0;
    const bar = () => { const b = document.getElementById('overlay-bar'); if (b) b.style.width = Math.round(++done / ptracks.length * 100) + '%'; };
    const bufFor = async pt => {
      const a = pt.audio || {};
      if (a.type === 'sep') {
        const k = a.sepId + '/' + a.stem;
        if (!sepBufs.has(k)) {
          const info = sepInfo[a.sepId]; if (!info || !info.stems[a.stem]) return null;
          const res = await fetch(info.stems[a.stem]);
          if (!res.ok) return null;
          let b = await S._actx.decodeAudioData(await res.arrayBuffer());
          for (const c of cutLog) b = spliceBuffer(b, c.a, c.len);   // replay ripple cuts
          sepBufs.set(k, b);
        }
        return sepBufs.get(k);
      }
      if (a.type === 'file') {
        if (!fileBufs.has(a.path)) {
          const u8 = entries.get(a.path); if (!u8) return null;
          const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
          fileBufs.set(a.path, await S._actx.decodeAudioData(ab));
        }
        return fileBufs.get(a.path);
      }
      return null;
    };

    // ── Song-level state ──
    if (proj.sepId && sepInfo[proj.sepId] !== null) S._sepId = proj.sepId;
    else if (proj.sepId && !sepIds.includes(proj.sepId)) S._sepId = proj.sepId;   // nothing referenced it
    S._jobId = proj.jobId || S._jobId;
    S._title = proj.title || S._title || 'Untitled';
    if (proj.jobMeta && (!S._jobMeta || S._jobMeta.bpm !== proj.jobMeta.bpm || S._jobMeta.key !== proj.jobMeta.key))
      S._jobMeta = { ...(S._jobMeta || {}), ...proj.jobMeta };
    S._cutLog = cutLog.map(c => ({ ...c }));
    S._cutUndo = [];
    S._dur = 0; S._startOff = 0;

    let maxImport = 0;
    for (const pt of ptracks) {
      const buf = await bufFor(pt); bar();
      if (!buf) continue;
      const key = pt.key || (pt.kind === 'import' ? 'import_' + (++maxImport) : pt.baseStem);
      if (S.tracks[key]) continue;
      const m = /^import_(\d+)$/.exec(key); if (m) maxImport = Math.max(maxImport, +m[1]);
      const gainNode = S._actx.createGain();
      S.tracks[key] = {
        buffer: buf, source: null, gainNode,
        muted: false, solo: false,
        volume: 1, pan: 0, eqS: 0, eqB: 0, eqM: 0, eqT: 0, revAmt: 0, dlyAmt: 0, offset: 0,
        isDuplicate: pt.kind === 'dup', isImport: pt.kind === 'import', baseStem: pt.baseStem || baseStemOf(key),
        importName: pt.name || undefined, loopTrack: !!pt.loopTrack, startTime: pt.startTime || 0,
        peaks: null, canvas: null, knobs: {}, muteRanges: (pt.muteRanges || []).map(r => ({ start: r.start, end: r.end })),
        _inMuteRange: false,
        auto: cloneAuto(pt.auto), autoShow: !!pt.autoShow, autoMode: pt.autoMode || 'vol', showSpec: !!pt.showSpec,
        sourceBpm: pt.sourceBpm || null, stretchFactor: pt.stretchFactor || undefined,
        pitchSemis: pt.pitchSemis || 0, _editedAudio: !!pt.editedAudio,
        _stemRef: pt.stemRef || undefined,
      };
      if (!S.tracks[key].stretchFactor) delete S.tracks[key].stretchFactor;
      if (!S.tracks[key]._stemRef) delete S.tracks[key]._stemRef;
      if (!pt.name) delete S.tracks[key].importName;
      const end = (pt.kind === 'import' && !pt.loopTrack ? (pt.startTime || 0) : 0) + buf.duration;
      if (pt.kind !== 'import' && end > S._dur) S._dur = end;
      wireTrack(key);
    }
    if (!S._dur) S._dur = proj.dur || Math.max(...Object.values(S.tracks).map(t => (t.startTime || 0) + t.buffer.duration));
    if (proj.dur && Math.abs(proj.dur - S._dur) < 0.05) S._dur = proj.dur;
    S._importCounter = Math.max(S._importCounter || 0, maxImport);

    // Build the UI (stems in canonical order first, then dups/imports in saved order)
    finishUI();
    for (const pt of ptracks) {
      const key = pt.key; const t = S.tracks[key]; if (!t) continue;
      t.knobs.vol?.set(pt.volume ?? 1);
      t.knobs.pan?.set(pt.pan ?? 0);
      t.knobs.rev?.set(pt.revAmt ?? 0);
      t.knobs.dly?.set(pt.dlyAmt ?? 0);
      t.knobs.ofs?.set((pt.offset ?? 0) * 1000);
      if (Array.isArray(pt.eq7) && t.eq) pt.eq7.forEach((b, i) => {
        const idx = b.id ? t.eq.bands.findIndex(x => x.id === b.id) : i;
        if (idx >= 0) setBand(t.eq, idx, { freq: b.freq, gain: b.gain, q: b.q });
      });
      t.muted = !!pt.muted; t.solo = !!pt.solo;
      document.getElementById('m-' + key)?.classList.toggle('mute-on', t.muted);
      document.getElementById('s-' + key)?.classList.toggle('solo-on', t.solo);
      document.getElementById('lp-' + key)?.classList.toggle('active', !!t.loopTrack);
      const bl = document.getElementById('bpm-label-' + key);
      if (bl && t.sourceBpm) bl.textContent = (t.stretchFactor ? Math.round(t.sourceBpm / t.stretchFactor) : t.sourceBpm) + ' BPM';
      const ps = document.getElementById('pitch-' + key); if (ps) ps.value = String(t.pitchSemis || 0);
    }

    // Master chain + sidechain
    if (proj.master) {
      restoreMix({ stems: {}, master: proj.master });
      const m = proj.master, now = S._actx.currentTime;
      const setExact = (p, v) => { if (p && v != null) { p.cancelScheduledValues(0); p.setValueAtTime(v, now); p.value = v; } };
      setExact(S._masterBus?.gain, m.volume); setExact(S._masterSubEQ?.gain, m.subEQ); setExact(S._masterAirEQ?.gain, m.airEQ);
      if (m.exciterWet != null) setExact(S._exciterWet?.gain, m.exciterWet);
    }
    populateSidechainDropdowns();
    const sc = proj.sidechain;
    if (sc) {
      const th = document.getElementById('sc-thresh'), ra = document.getElementById('sc-ratio');
      if (th && sc.threshold != null) { th.value = sc.threshold; document.getElementById('sc-thresh-label').textContent = sc.threshold + 'dB'; }
      if (ra && sc.ratio != null) { ra.value = sc.ratio; document.getElementById('sc-ratio-label').textContent = sc.ratio + ':1'; }
      if (sc.enabled && S.tracks[sc.key] && S.tracks[sc.target]) {
        document.getElementById('sc-key-sel').value = sc.key; document.getElementById('sc-tgt-sel').value = sc.target;
        applySidechain(sc.key, sc.target);
        setSidechainParam('threshold', sc.threshold ?? -20); setSidechainParam('ratio', sc.ratio ?? 4);
      }
    }

    // Timeline state
    S._zoom = proj.zoom || 1;
    S._loopStart = proj.loop?.start ?? null; S._loopEnd = proj.loop?.end ?? null;
    if (!!proj.loop?.on !== !!S._looping) { S._looping = !!proj.loop?.on; document.getElementById('loop-btn')?.classList.toggle('active', S._looping); }
    S._activePreset = proj.activePreset || 'full';
    document.querySelectorAll('#preset-bar .preset-btn').forEach(b => b.classList.toggle('active', b.id === 'pb-' + S._activePreset));
    if (proj.showChords != null) S._showChords = !!proj.showChords;
    setMarkers(proj.markers || []);
    document.getElementById('duration-display').textContent = '/ ' + fmtTime(S._dur);
    document.getElementById('time-display').textContent = '0:00';
    if (S._sepId || S._jobId) {
      const q = new URLSearchParams(); if (S._jobId) q.set('job', S._jobId); if (S._sepId) q.set('sep', S._sepId);
      window.history.replaceState({}, '', '?' + q.toString());
    }
    applyZoom(); buildRuler(); updateLoopRegion(); updatePlayhead(0);
    applyGains(); scheduleAutomation(); drawAllLanes(); refreshSpecButton(); updateAudioInfo();
    const ub = document.getElementById('uncut-btn'); if (ub) ub.disabled = true;
    hideOverlay();
    const skipped = ptracks.length - Object.keys(S.tracks).length;
    toast(`Opened "${S._title}" — ${Object.keys(S.tracks).length} track(s)` + (skipped ? `, ${skipped} missing` : ''));
    S._lastOpen = { tracks: Object.keys(S.tracks).length, skipped, missing: missing.map(t => t.key) };
    return true;
  } catch (e) {
    console.error('Open project failed:', e);
    hideOverlay();
    alert('Open Project failed: ' + e.message);
    return false;
  }
}

export function isProjectFile(f) { return /\.wpproj$/i.test(f?.name || ''); }

function toast(msg) {
  let el = document.getElementById('proj-toast');
  if (!el) {
    el = document.createElement('div'); el.id = 'proj-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg; el.classList.add('show');
  clearTimeout(el._t); el._t = setTimeout(() => el.classList.remove('show'), 3200);
}

