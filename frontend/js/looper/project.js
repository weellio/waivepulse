// ── Project save / open (.wploop) ─────────────────────────────────────────────
// A .wploop is a plain STORE zip:
//   project.json          — every setting (see collectProject) + a version field
//   loops/loopN.wav       — each recorded loop, 32-bit float (the ORIGINAL take;
//                           a ✂ Trim Start is re-applied from trimOffset on open)
//   sample.wav            — the keyboard sample, if one is loaded
// Opening tolerates missing fields (older/newer files): anything absent keeps
// its default. "Unsaved work" = the project differs from the last save/open.
import { S } from './state.js';
import { ensureCtx, setGlobalFX, setMasterVol } from './core.js';
import { setStatus, fmtSec } from './util.js';
import { makeZip, readZip } from './zip.js';
import { encodeWavF32, decodeWav } from './wavio.js';
import { clearAll, ensureGain, drawWave, slotUI, setVol } from './loops.js';
import { rotateBuffer } from './looptrim.js';
import { setBand } from '../shared/eq7.js';
import { setDrumMode, setStepEdit, stopSeq, applySeqPattern } from './drums.js';
import { setSynthMode, stopPseq, applyPseqPattern, setScaleRoot, setScaleName, setRollTransposeReadout,
         exprState, setExprState } from './pianoseq.js';
import { chBPM, chCountIn, setSwing, setHumanize, toggleQuantize } from './transport.js';
import { setWave, toggleGuitar, setGuitarVol, setADSR, setFilter, setArpRate, setArpMode, toggleArp, chOctave } from './synth.js';
import { storeBank, setBanks, setChainStr, paintBanks } from './banks.js';
import { getSongState, setSongState } from './songbuilder.js';
import { safeName } from './loudexport.js';
import { spaceState, applySpaceState } from './space.js';

export const PROJECT_VERSION = 1;
const APP = 'WAIvePulse Looper';

// ── buffer identity (for the unsaved-work check) ──────────────────────────────
const bufIds = new WeakMap(); let nextBufId = 1;
const bufId = b => { if (!b) return 0; if (!bufIds.has(b)) bufIds.set(b, nextBufId++); return bufIds.get(b); };
let savedSig = null;

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const val = id => document.getElementById(id)?.value;

// ── Collect ───────────────────────────────────────────────────────────────────
export function collectProject() {
  storeBank();
  return {
    app: APP, version: PROJECT_VERSION, savedAt: new Date().toISOString(),
    name: S.projectName || '',
    transport: { bpm: S.bpm, countIn: S.countIn, swing: S.swing, humanize: S.humanize, quantize: S.quantize },
    scale: { root: S.scaleRoot, name: S.scaleName, transpose: S.rollTranspose },
    drums: { mode: S.drumMode, stepEdit: S.stepEdit, pattern: S.seqPattern, prob: S.seqProb, ratchet: S.seqRatchet },
    roll: { pattern: S.pseqPattern, expr: exprState() },   // + the expression (dynamics) lanes
    synth: {
      mode: S.synthMode, wave: S.wave, guitar: S.guitarMode, guitarVol: S.guitarVol, octave: S.octave,
      attackMs: S.attackMs, decayMs: S.decayMs, sustain: S.sustainLevel, releaseMs: S.releaseMs,
      cutoff: S.filterCutoff, reso: S.filterReso,
      arp: { on: S.arpOn, div: S.arpDiv, mode: S.arpMode },
      sample: S.sampleBuffer ? 'sample.wav' : null,
      sampleName: document.getElementById('sampleName')?.textContent || '',
      sampleMode: !!S.sampleMode,
    },
    banks: { current: S.bankCur, chain: S.chainStr, chainOn: S.chainOn, list: S.banks },
    loops: S.slots.filter(s => s.buffer).map(s => ({
      slot: s.id, file: `loops/loop${s.id + 1}.wav`,
      vol: num(s.vol, 1), nudge: num(s.nudge, 0), trimOffset: s._trimOrig ? (s.trimOffset | 0) : 0,
      eq: s.eq ? s.eq.bands.map(b => ({ id: b.id, freq: b.freq, gain: b.gain, q: b.q })) : null,
    })),
    master: {
      slot: S.masterSlot,
      reverb: parseFloat(val('revSlider') ?? 0), delay: parseFloat(val('dlySlider') ?? 0), volume: parseFloat(val('masterVolSlider') ?? 0.85),
    },
    // Space: which room, how wet, how deep, and where each loop sits in it.
    // master.reverb above is the SAME number as space.amount (the migrated
    // Reverb slider), kept so older readers of the format still work.
    space: spaceState(),
    song: getSongState(),
    export: { fmt: val('expFmt') || 'wav', target: val('expTarget') || 'off' },
  };
}

function signature() {
  const p = collectProject();
  delete p.savedAt;
  return JSON.stringify(p) + '|' + S.slots.map(s => bufId(s._trimOrig || s.buffer)).join(',') + '|' + bufId(S.sampleBuffer);
}
export function markSaved() { savedSig = signature(); }

// Something worth keeping that isn't saved yet?
export function hasUnsavedWork() {
  const any = S.slots.some(s => s.buffer) || S.seqPattern.some(r => r.some(Boolean)) || S.pseqPattern.some(r => r.some(Boolean))
    || (S.banks || []).some(b => b.seq.some(r => r.some(Boolean)) || b.roll.some(r => r.some(Boolean)));
  if (!any) return false;
  return signature() !== savedSig;
}

// ── Save ──────────────────────────────────────────────────────────────────────
const bufToWavBytes = buf => encodeWavF32(Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c)), buf.sampleRate);

export async function buildProjectZip() {
  const proj = collectProject();
  const files = [{ name: 'project.json', data: JSON.stringify(proj, null, 1) }];
  for (const s of S.slots) {
    if (!s.buffer) continue;
    files.push({ name: `loops/loop${s.id + 1}.wav`, data: bufToWavBytes(s._trimOrig || s.buffer) });
  }
  if (S.sampleBuffer) files.push({ name: 'sample.wav', data: bufToWavBytes(S.sampleBuffer) });
  return { bytes: makeZip(files), proj };
}

export async function saveProject() {
  try {
    const { bytes, proj } = await buildProjectZip();
    const name = (safeName(S.projectName) || 'untitled') + '.wploop';
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    markSaved();
    setStatus(`Saved ${name} — ${proj.loops.length} loop${proj.loops.length === 1 ? '' : 's'}, banks A–D, song arrangement (${(bytes.length / 1048576).toFixed(1)} MB)`);
  } catch (e) {
    console.warn('Save failed:', e);
    setStatus('Save failed: ' + e.message);
  }
}

// ── Open ──────────────────────────────────────────────────────────────────────
export function openProjectDialog() {
  if (hasUnsavedWork() && !confirm('Open another project? Your unsaved loops and patterns here will be replaced.\n\n(Cancel, then 💾 Save first to keep them.)')) return;
  const inp = document.getElementById('projFile');
  if (inp) { inp.value = ''; inp.click(); }
}

export async function openProjectFile(input) {
  const f = input?.files?.[0]; if (!f) return;
  await openProjectBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  input.value = '';
}

export async function openProjectBytes(bytes, fileName = 'project') {
  let files, proj;
  try {
    files = await readZip(bytes);
    const pj = files.get('project.json');
    if (!pj) throw new Error('no project.json inside');
    proj = JSON.parse(new TextDecoder().decode(pj));
  } catch (e) {
    setStatus(`Couldn't open ${fileName}: ${e.message}`); return false;
  }
  if (proj.app && proj.app !== APP) setStatus(`${fileName} was made by "${proj.app}" — trying anyway`);
  const newer = num(proj.version, 1) > PROJECT_VERSION;
  try {
    await applyProject(proj, files);
  } catch (e) {
    console.warn('Open failed:', e);
    setStatus(`Opened ${fileName} with errors: ${e.message}`); return false;
  }
  markSaved();
  const nl = S.slots.filter(s => s.buffer).length;
  setStatus(`Opened ${fileName} — ${nl} loop${nl === 1 ? '' : 's'}, ${S.bpm} BPM` + (newer ? ' (made by a newer version — some settings may be skipped)' : ''));
  return true;
}

const setSlider = (id, v) => { const el = document.getElementById(id); if (el != null && v != null && isFinite(v)) el.value = v; };

function bufferFromWav(bytes) {
  const d = decodeWav(bytes);
  const nc = Math.max(1, Math.min(2, d.channels.length));
  const buf = S.ctx.createBuffer(nc, Math.max(1, d.channels[0].length), d.sampleRate);
  for (let c = 0; c < nc; c++) buf.getChannelData(c).set(d.channels[c]);
  return buf;
}

export async function applyProject(p, files) {
  ensureCtx();
  if (S.seqPlaying) stopSeq();
  if (S.pseqPlaying) stopPseq();
  clearAll();

  S.projectName = typeof p.name === 'string' ? p.name.slice(0, 80) : '';
  const pn = document.getElementById('projName'); if (pn) pn.value = S.projectName;

  // transport
  const t = p.transport || {};
  const bpm = clamp(Math.round(num(t.bpm, S.bpm)), 40, 240);
  if (bpm !== S.bpm) chBPM(bpm - S.bpm);
  S.countIn = clamp(num(t.countIn, S.countIn) | 0, 0, 4); chCountIn(0);
  setSwing(clamp(num(t.swing, 0), 0, 1) * 100);
  setHumanize(clamp(num(t.humanize, 0), 0, 1) * 100); setSlider('humanSlider', Math.round(S.humanize * 100));
  if (typeof t.quantize === 'boolean' && t.quantize !== S.quantize) toggleQuantize();

  // synth (octave first: it re-labels the roll)
  const sy = p.synth || {};
  const oct = clamp(num(sy.octave, S.octave) | 0, 1, 6);
  if (oct !== S.octave) chOctave(oct - S.octave);
  if (sy.guitar) { if (!S.guitarMode) toggleGuitar(); }
  else {
    const wb = document.querySelector(`.ibtn[data-w="${['sine', 'triangle', 'sawtooth', 'square'].includes(sy.wave) ? sy.wave : 'sine'}"]`);
    if (wb) setWave(wb);
  }
  if (sy.guitarVol != null) { setSlider('guitarVolSlider', clamp(num(sy.guitarVol, 0.28), 0, 1)); setGuitarVol(val('guitarVolSlider')); }
  setSlider('atkSlider', num(sy.attackMs, S.attackMs)); setSlider('decSlider', num(sy.decayMs, S.decayMs));
  setSlider('susSlider', Math.round(num(sy.sustain, S.sustainLevel) * 100)); setSlider('relSlider', num(sy.releaseMs, S.releaseMs));
  setADSR();
  setSlider('cutSlider', num(sy.cutoff, S.filterCutoff)); setSlider('resSlider', num(sy.reso, S.filterReso));
  setFilter();
  const arp = sy.arp || {};
  const rateBtn = [...document.querySelectorAll('.arp-rate')].find(b => (b.getAttribute('onclick') || '').includes('(' + num(arp.div, S.arpDiv) + ','));
  if (rateBtn) setArpRate(num(arp.div, S.arpDiv), rateBtn);
  const modeBtn = [...document.querySelectorAll('.arp-mode')].find(b => (b.getAttribute('onclick') || '').includes(`'${arp.mode || S.arpMode}'`));
  if (modeBtn) setArpMode(arp.mode || S.arpMode, modeBtn);
  if (typeof arp.on === 'boolean' && arp.on !== S.arpOn) toggleArp();
  if (sy.sample && files.get(sy.sample)) {
    try {
      S.sampleBuffer = bufferFromWav(files.get(sy.sample));
      S.sampleMode = sy.sampleMode !== false;
      if (S.sampleMode) S.guitarMode = false;
      document.getElementById('guitarBtn')?.classList.toggle('on', S.guitarMode);
      const nm = document.getElementById('sampleName'); if (nm) nm.textContent = sy.sampleName || 'sample';
      const mb = document.getElementById('synthModeBtn');
      if (mb) { mb.style.display = ''; mb.textContent = S.sampleMode ? '🎹 Sample' : '🎹 Synth'; mb.classList.toggle('on', S.sampleMode); }
    } catch (e) { console.warn('sample.wav unreadable:', e); }
  }

  // patterns: banks first, then the live grids (= the current bank) on top
  const bk = p.banks || {};
  setBanks(Array.isArray(bk.list) ? bk.list : [], num(bk.current, 0));
  if (p.drums?.pattern) applySeqPattern(p.drums.pattern, p.drums.prob, p.drums.ratchet);
  if (p.roll?.pattern) applyPseqPattern(p.roll.pattern);
  if (p.roll?.expr) setExprState(p.roll.expr);          // expression lanes (older files just keep theirs)
  storeBank();
  S.chainOn = !!bk.chainOn; S.chainPos = 0; S.bankQueued = null;
  setChainStr(typeof bk.chain === 'string' ? bk.chain : S.chainStr);

  // scale lock + transpose read-out
  const sc = p.scale || {};
  setScaleName(typeof sc.name === 'string' ? sc.name : 'chromatic');
  setScaleRoot(num(sc.root, 0));
  setRollTransposeReadout(num(sc.transpose, 0));

  // views
  setDrumMode(p.drums?.mode === 'seq' ? 'seq' : 'pads');
  setSynthMode(sy.mode === 'roll' ? 'roll' : 'keys');
  if (['steps', 'prob', 'ratchet'].includes(p.drums?.stepEdit)) setStepEdit(p.drums.stepEdit);

  // space (rooms + depth) — a project saved before Space existed has no `space`
  // block, so every field falls back to its default: close seats, one lightly-wet
  // studio chamber. Its master.reverb still drives the wet amount below.
  applySpaceState(p.space ? { ...p.space, amount: num(p.master?.reverb, p.space.amount) } : null);

  // master FX
  const m = p.master || {};
  setSlider('revSlider', clamp(num(m.reverb, 0), 0, 1)); setSlider('dlySlider', clamp(num(m.delay, 0), 0, 1));
  setGlobalFX();
  setSlider('masterVolSlider', clamp(num(m.volume, 0.85), 0, 1.5)); setMasterVol(val('masterVolSlider'));

  // loops
  for (const L of Array.isArray(p.loops) ? p.loops : []) {
    const id = L?.slot | 0;
    const s = S.slots[id]; if (!s || id < 0 || id > 5) continue;
    const bytes = files.get(L.file || `loops/loop${id + 1}.wav`);
    if (!bytes) continue;
    let orig;
    try { orig = bufferFromWav(bytes); } catch (e) { console.warn('loop unreadable:', e); continue; }
    const off = clamp(num(L.trimOffset, 0) | 0, 0, orig.length - 1);
    s._trimOrig = off > 0 ? orig : null;
    s.trimOffset = off;
    s.buffer = off > 0 ? rotateBuffer(orig, off) : orig;
    setVol(id, clamp(num(L.vol, 1), 0, 1.5));
    ensureGain(s);
    if (Array.isArray(L.eq)) L.eq.forEach((b, i) => { if (s.eq.bands[i]) setBand(s.eq, i, { freq: num(b?.freq, null), gain: num(b?.gain, null), q: num(b?.q, null) }); });
    s.nudge = num(L.nudge, 0);
    const ms = Math.round(s.nudge * 1000);
    const nv = document.getElementById('nudge-' + id); if (nv) nv.textContent = (ms > 0 ? '+' : '') + ms + 'ms';
    s.state = 'stopped';
    document.getElementById('dur-' + id).textContent = fmtSec(s.buffer.duration);
    drawWave(id);
    slotUI(id);
  }
  const ms = num(m.slot, -1);
  const master = S.slots[ms]?.buffer ? S.slots[ms] : S.slots.find(s => s.buffer);
  if (master) { S.masterSlot = master.id; S.masterLen = master.buffer.duration; S.masterAnchor = S.ctx.currentTime; }

  // song builder + export prefs
  if (p.song) setSongState(p.song);
  const ex = p.export || {};
  const fs = document.getElementById('expFmt'); if (fs && ['wav', 'mp3'].includes(ex.fmt)) fs.value = ex.fmt;
  const ts = document.getElementById('expTarget'); if (ts && ['off', '-14', '-16', '-9'].includes(String(ex.target))) ts.value = String(ex.target);
  paintBanks();
}

// ── Name, clear-all guard, leave-page guard, drag & drop ──────────────────────
export function setProjectName(v) { S.projectName = String(v || '').slice(0, 80); }

export function clearAllConfirm() {
  const n = S.slots.filter(s => s.buffer).length;
  if (!n) { clearAll(); return; }
  const msg = hasUnsavedWork()
    ? `Clear all ${n} loop${n === 1 ? '' : 's'}? They aren't saved — this can't be undone.\n\n(Cancel, then 💾 Save to keep a copy.)`
    : `Clear all ${n} loop${n === 1 ? '' : 's'}?`;
  if (confirm(msg)) clearAll();
}

export function initProject({ onMidiFile }) {
  markSaved();
  window.addEventListener('beforeunload', e => {
    if (!hasUnsavedWork()) return;
    e.preventDefault(); e.returnValue = '';
  });
  // drop a .wploop to open it, a .mid to import it
  const hint = document.getElementById('dropHint');
  let depth = 0;
  const isFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  document.addEventListener('dragenter', e => { if (!isFiles(e)) return; depth++; hint?.classList.add('show'); });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) hint?.classList.remove('show'); });
  document.addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', async e => {
    if (!isFiles(e)) return;
    e.preventDefault(); depth = 0; hint?.classList.remove('show');
    const f = e.dataTransfer.files[0]; if (!f) return;
    const name = f.name.toLowerCase();
    if (/\.(mid|midi|rmi)$/.test(name)) { onMidiFile(f); return; }
    if (/\.(wploop|zip)$/.test(name)) {
      if (hasUnsavedWork() && !confirm(`Open ${f.name}? Your unsaved loops and patterns here will be replaced.`)) return;
      await openProjectBytes(new Uint8Array(await f.arrayBuffer()), f.name);
      return;
    }
    setStatus(`Drop a .wploop project or a .mid file (not ${f.name})`);
  });
}
