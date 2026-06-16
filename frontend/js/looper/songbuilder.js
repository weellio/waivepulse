// ── Song Builder: arrange recorded loops into a full, pro-grade track ──────────
// All loops run as ONE continuous looping source over the whole song (phase stays
// on the grid the whole time); each section just sets which loops are audible and
// at what level. A "break" is a section with every loop off — the groove drops to
// silence for a few beats, then the next section brings the loops back in, in time.
//
// Pro extras: per-section volume + labels, master fade in/out, normalize + soft
// limiter (stacked loops never clip), optional master Reverb/Delay baked in with a
// tail, 24-bit export, per-loop STEMS, and one-click send to the Studio.
import { S } from './state.js';
import { ensureCtx } from './core.js';
import { setStatus } from './util.js';
import { sendBufferToStudio, isStudioOpen } from './bridge.js';
import { stopAllPlayback } from './loops.js';
import { applyEqOffline, snapshotEq, eqIsFlat } from '../shared/eq7.js';

// arrangement = ordered list of sections: { on:[bool x6], beats:int, vol:0..1.5, label:str }
let arr = [];
// preview transport state
let previewSrc = null, previewBuf = null, previewState = 'stopped';
let previewOffset = 0, previewStartT = 0, previewRAF = 0;

const RAMP = 0.008;            // 8 ms gain ramp at section edges = no clicks
const beatDur = () => 60 / S.bpm;

function recordedSlots() { return S.slots.filter(s => s.buffer); }

// ── Open / close ──────────────────────────────────────────────────────────────
export function openSong() {
  if (!recordedSlots().length) { setStatus('Record at least one loop first'); return; }
  stopAllPlayback();                       // silence the live loop mix — the modal covers their controls
  if (!arr.length) autoArrange();          // first open → seed something playable
  buildArrangementUI();
  refreshSongStudioBtns();
  document.getElementById('song-modal').classList.add('open');
}
export function closeSong() {
  stopPreview();
  document.getElementById('song-modal').classList.remove('open');
}
export function songOpen() {
  return document.getElementById('song-modal').classList.contains('open');
}

// ── Auto-arrange: seed sections from the knobs ─────────────────────────────────
export function autoArrange() {
  const ids       = recordedSlots().map(s => s.id);
  const buildUp   = document.getElementById('sa-buildup')?.checked ?? true;
  const grooveBars= parseInt(document.getElementById('sa-bars')?.value)   || 8;
  const breakBeats= parseInt(document.getElementById('sa-break')?.value)  || 2;
  const repeats   = parseInt(document.getElementById('sa-reps')?.value)   || 2;

  const allOff = () => new Array(6).fill(false);
  const sec = (set, beats, vol, label) => ({ on: (() => { const o = allOff(); set.forEach(i => o[i] = true); return o; })(), beats, vol, label });
  arr = [];

  // Build-up: loops enter one at a time, 2 bars each (cumulative), easing in level
  if (buildUp && ids.length > 1) {
    const grow = [];
    ids.forEach((i, k) => { grow.push(i); arr.push(sec([...grow], 8, 0.7 + 0.3 * (k + 1) / ids.length, k === 0 ? 'Intro' : 'Build')); });
  }
  // groove → break → drop, repeated
  for (let r = 0; r < Math.max(1, repeats); r++) {
    arr.push(sec(ids, grooveBars * 4, 1.0, r === 0 ? 'Verse' : 'Groove'));
    if (breakBeats > 0) arr.push(sec([], breakBeats, 1.0, 'Break'));
    arr.push(sec(ids, grooveBars * 4, 1.1, 'Drop'));      // drop hits a touch louder
  }
  arr.push(sec(ids, grooveBars * 2, 1.0, 'Outro'));        // tail so it never ends on a break

  invalidatePreview(true);
  buildArrangementUI();
  setStatus('Auto-arranged ' + arr.length + ' sections — tweak the blocks, then render');
}

// ── Section editing ─────────────────────────────────────────────────────────────
function isBreak(sec) { return !sec.on.some(Boolean); }
function totalBeats()  { return arr.reduce((n, s) => n + s.beats, 0); }
function newSection(on, beats) { return { on, beats, vol: 1.0, label: '' }; }

window.songToggleLoop = (si, li) => { arr[si].on[li] = !arr[si].on[li]; invalidatePreview(true); buildArrangementUI(); };
window.songChBeats    = (si, d)  => { arr[si].beats = Math.max(1, arr[si].beats + d); invalidatePreview(true); buildArrangementUI(); };
window.songSetVol     = (si, v)  => { arr[si].vol = parseFloat(v); invalidatePreview(false); const el = document.getElementById('ssvolsl-' + si); if (el) el.title = 'Volume ' + Math.round(arr[si].vol * 100) + '%'; };
window.songSetLabel   = (si, v)  => { arr[si].label = v; };
window.songMove       = (si, d)  => {
  const j = si + d; if (j < 0 || j >= arr.length) return;
  [arr[si], arr[j]] = [arr[j], arr[si]]; invalidatePreview(true); buildArrangementUI();
};
window.songRemove     = si => { arr.splice(si, 1); invalidatePreview(true); buildArrangementUI(); };
window.songAddGroove  = () => { arr.push(newSection(recordedSlots().map(s => s.id).reduce((o, i) => (o[i] = true, o), new Array(6).fill(false)), 32)); invalidatePreview(true); buildArrangementUI(); };
window.songAddBreak   = () => { arr.push(newSection(new Array(6).fill(false), 2)); invalidatePreview(true); buildArrangementUI(); };
window.songDup        = si => { arr.splice(si + 1, 0, { on: arr[si].on.slice(), beats: arr[si].beats, vol: arr[si].vol, label: arr[si].label }); invalidatePreview(true); buildArrangementUI(); };

function buildArrangementUI() {
  const wrap = document.getElementById('song-sections');
  if (!wrap) return;
  const ids = recordedSlots().map(s => s.id);
  wrap.innerHTML = '';
  arr.forEach((sec, si) => {
    const brk = isBreak(sec);
    const bars = sec.beats / 4;
    if (sec.vol === undefined) sec.vol = 1.0;
    const el = document.createElement('div');
    el.className = 'song-sec' + (brk ? ' brk' : '');
    const chips = ids.map(i =>
      `<button class="sl-chip${sec.on[i] ? ' on' : ''}" onclick="songToggleLoop(${si},${i})">${i + 1}</button>`
    ).join('');
    el.innerHTML = `
      <div class="ss-hdr">
        <input class="ss-label" value="${(sec.label || (brk ? 'Break' : 'Section ' + (si + 1))).replace(/"/g, '&quot;')}"
               onchange="songSetLabel(${si},this.value)" spellcheck="false">
        <span class="ss-move">
          <button onclick="songMove(${si},-1)" title="Move left">◀</button>
          <button onclick="songMove(${si},1)"  title="Move right">▶</button>
          <button onclick="songDup(${si})"     title="Duplicate">⧉</button>
          <button onclick="songRemove(${si})"  title="Remove" class="ss-x">×</button>
        </span>
      </div>
      <div class="ss-loops">${chips}</div>
      <div class="ss-len">
        <button onclick="songChBeats(${si},-1)">−</button>
        <span class="ss-beats">${sec.beats} <small>beat${sec.beats === 1 ? '' : 's'}</small></span>
        <button onclick="songChBeats(${si},1)">+</button>
        <span class="ss-bars">${Number.isInteger(bars) ? bars : bars.toFixed(2)} bar${bars === 1 ? '' : 's'}</span>
      </div>
      <div class="ss-vol">
        <input type="range" id="ssvolsl-${si}" min="0" max="1.5" step="0.01" value="${sec.vol}"
               title="Volume ${Math.round(sec.vol * 100)}%" oninput="songSetVol(${si},this.value)">
      </div>`;
    wrap.appendChild(el);
  });
  const beats = totalBeats(), secs = beats * beatDur();
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  const lenEl = document.getElementById('song-len');
  if (lenEl) lenEl.textContent =
    `${arr.length} sections · ${(beats / 4).toFixed(0)} bars · ${m}:${String(s).padStart(2, '0')} @ ${S.bpm} BPM`;
}

// ── Master option reads ─────────────────────────────────────────────────────────
function masterOpts() {
  const num = (id, dflt) => { const v = parseFloat(document.getElementById(id)?.value); return isNaN(v) ? dflt : v; };
  const chk = (id, dflt) => document.getElementById(id)?.checked ?? dflt;
  return {
    fadeIn:  Math.max(0, num('mo-fadein', 0)),
    fadeOut: Math.max(0, num('mo-fadeout', 0)),
    normalize: chk('mo-norm', true),
    normTarget: num('mo-target', -1),
    limiter: chk('mo-limit', true),
    fx: chk('mo-fx', false),
    tail: Math.max(0, num('mo-tail', 2)),
    bits: document.getElementById('mo-24')?.checked ? 24 : 16,
  };
}

// ── Offline render of the whole arrangement (full mix) ──────────────────────────
async function renderMix() {
  const active = recordedSlots();
  if (!active.length || !arr.length) return null;
  ensureCtx();
  const o = masterOpts();
  const bd  = beatDur();
  const dur = totalBeats() * bd + (o.fx ? o.tail : 0);
  const sr  = S.ctx.sampleRate;
  const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);

  // master bus → (dry) + optional reverb/delay sends
  const master = off.createGain();
  if (o.fx) {
    master.connect(off.destination);
    const rev = parseFloat(document.getElementById('revSlider')?.value || 0);
    const dly = parseFloat(document.getElementById('dlySlider')?.value || 0);
    if (rev > 0) {
      const conv = off.createConvolver(); conv.buffer = makeIR(off);
      const rg = off.createGain(); rg.gain.value = rev;
      master.connect(conv); conv.connect(rg); rg.connect(off.destination);
    }
    if (dly > 0) {
      const d = off.createDelay(1.0); d.delayTime.value = bd / 2;
      const fb = off.createGain(); fb.gain.value = 0.38;
      const dg = off.createGain(); dg.gain.value = dly * 0.45;
      master.connect(d); d.connect(fb); fb.connect(d); d.connect(dg); dg.connect(off.destination);
    }
  } else {
    master.connect(off.destination);
  }

  active.forEach(s => connectLoop(off, s, bd, true, master));

  setStatus('Rendering full track…');
  const buf = await off.startRendering();
  postProcess(buf, o);
  return buf;
}

// One loop → its section-automated gain → a destination node (master bus or ctx).
function connectLoop(off, s, bd, withSectionVol, dest) {
  const src = off.createBufferSource();
  src.buffer = s.buffer; src.loop = true; src.loopEnd = s.buffer.duration;
  const g = off.createGain();
  const vol = s.gainNode ? s.gainNode.gain.value : 1;
  let t = 0, prev = null;
  arr.forEach(sec => {
    const sv = withSectionVol ? (sec.vol ?? 1) : 1;
    const target = sec.on[s.id] ? vol * sv : 0;
    if (prev === null) { g.gain.setValueAtTime(target, 0); prev = target; }
    else if (target !== prev) {
      g.gain.setValueAtTime(prev, t);
      g.gain.linearRampToValueAtTime(target, t + RAMP);
      prev = target;
    }
    t += sec.beats * bd;
  });
  if (s.eq && !eqIsFlat(s.eq)) {
    const oeq = applyEqOffline(off, snapshotEq(s.eq));
    src.connect(oeq.input); oeq.output.connect(g);
  } else {
    src.connect(g);
  }
  g.connect(dest); src.start(0);
}

// ── Per-loop stems (each loop, full length, arrangement applied) ────────────────
async function renderStems() {
  const active = recordedSlots();
  if (!active.length || !arr.length) return [];
  ensureCtx();
  const o = masterOpts();
  const bd = beatDur(), sr = S.ctx.sampleRate;
  const dur = totalBeats() * bd;                    // stems are dry — no FX tail
  const out = [];
  for (const s of active) {
    const off = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    connectLoop(off, s, bd, true, off.destination);
    setStatus('Rendering stem ' + (s.id + 1) + '…');
    const buf = await off.startRendering();
    if (o.fadeIn || o.fadeOut) applyFades(buf, o.fadeIn, o.fadeOut);  // stems stay un-normalized so they sum cleanly
    out.push({ name: 'Loop ' + (s.id + 1) + ' (stem)', buf });
  }
  return out;
}

// ── Post-process: normalize → soft limiter → fades ──────────────────────────────
function postProcess(buf, o) {
  if (o.normalize) {
    const peak = peakOf(buf);
    if (peak > 1e-6) {
      const t = Math.pow(10, o.normTarget / 20);
      scale(buf, t / peak);
    }
  }
  if (o.limiter) softLimit(buf);
  if (o.fadeIn || o.fadeOut) applyFades(buf, o.fadeIn, o.fadeOut);
}
function peakOf(buf) {
  let p = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > p) p = a; }
  }
  return p;
}
function scale(buf, g) {
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) d[i] *= g;
  }
}
function softLimit(buf) {                          // tanh soft clip above 0.9 → guaranteed |x|<1
  const thr = 0.9;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const x = d[i], ax = Math.abs(x);
      if (ax > thr) d[i] = Math.sign(x) * (thr + (1 - thr) * Math.tanh((ax - thr) / (1 - thr)));
    }
  }
}
function applyFades(buf, fin, fout) {
  const sr = buf.sampleRate, L = buf.length;
  const nin = Math.min(L, Math.floor(fin * sr));
  const nout = Math.min(L, Math.floor(fout * sr));
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < nin; i++)  d[i] *= i / nin;
    for (let i = 0; i < nout; i++) d[L - 1 - i] *= i / nout;
  }
}
function makeIR(off) {                              // ~1.6 s synthetic reverb tail
  const len = Math.floor(off.sampleRate * 1.6);
  const ir = off.createBuffer(2, len, off.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = ir.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 1.8);
  }
  return ir;
}

// ── WAV encode (16- or 24-bit PCM) ──────────────────────────────────────────────
function encodeWav(buf, bits) {
  const nc = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const bps = bits / 8;
  const ab = new ArrayBuffer(44 + len * nc * bps);
  const v = new DataView(ab);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); v.setUint32(4, 36 + len * nc * bps, true); ws(8, 'WAVE');
  ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, nc, true); v.setUint32(24, sr, true);
  v.setUint32(28, sr * nc * bps, true); v.setUint16(32, nc * bps, true); v.setUint16(34, bits, true);
  ws(36, 'data'); v.setUint32(40, len * nc * bps, true);
  let off = 44;
  const chans = Array.from({ length: nc }, (_, c) => buf.getChannelData(c));
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nc; c++) {
      let x = Math.max(-1, Math.min(1, chans[c][i]));
      if (bits === 16) {
        v.setInt16(off, x < 0 ? x * 0x8000 : x * 0x7FFF, true); off += 2;
      } else {                                     // 24-bit little-endian
        const s = Math.round(x < 0 ? x * 0x800000 : x * 0x7FFFFF);
        v.setUint8(off, s & 0xFF); v.setUint8(off + 1, (s >> 8) & 0xFF); v.setUint8(off + 2, (s >> 16) & 0xFF);
        off += 3;
      }
    }
  }
  return ab;
}
function download(buf, name, bits) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([encodeWav(buf, bits)], { type: 'audio/wav' }));
  a.download = name; a.click();
  URL.revokeObjectURL(a.href);
}

// ── Preview transport: play · pause/resume · stop, with live section highlight ──
function invalidatePreview(hard) {
  previewBuf = null;                       // arrangement/level changed → re-render next play
  if (hard && previewState !== 'stopped') stopPreview();
}
function killPreviewSrc() {
  if (previewSrc) { previewSrc.onended = null; try { previewSrc.stop(); } catch (_) {} try { previewSrc.disconnect(); } catch (_) {} previewSrc = null; }
}

// Fresh play from the top (always re-renders so it reflects the current settings).
export async function previewSong() {
  previewBuf = null;
  await startPreviewAt(0);
}
async function startPreviewAt(offset) {
  if (!previewBuf) { setStatus('Rendering preview…'); previewBuf = await renderMix(); }
  if (!previewBuf) { setStatus('Nothing to render'); return; }
  killPreviewSrc();
  const src = S.ctx.createBufferSource();
  src.buffer = previewBuf; src.connect(S.ctx.destination);
  if (S.ctx.state === 'suspended') S.ctx.resume();
  src.onended = () => { if (previewState === 'playing') stopPreview(); };   // natural end
  src.start(0, Math.min(Math.max(0, offset), previewBuf.duration - 0.01));
  previewSrc = src; previewOffset = offset; previewStartT = S.ctx.currentTime;
  previewState = 'playing'; updatePreviewBtns();
  cancelAnimationFrame(previewRAF); previewRAF = requestAnimationFrame(highlightLoop);
  setStatus('Previewing full track…');
}
export function pausePreview() {
  if (previewState !== 'playing') return;
  previewOffset += S.ctx.currentTime - previewStartT;   // remember where we are
  killPreviewSrc();
  previewState = 'paused';
  cancelAnimationFrame(previewRAF);
  updatePreviewBtns(); setStatus('Preview paused');
}
export function stopPreview() {
  killPreviewSrc();
  previewState = 'stopped'; previewOffset = 0;
  cancelAnimationFrame(previewRAF);
  clearHighlight(); updatePreviewBtns();
}
window.songTogglePreview = () => {
  if (previewState === 'playing') pausePreview();
  else if (previewState === 'paused') startPreviewAt(previewOffset);
  else previewSong();
};
window.songStopPreview = () => stopPreview();

function highlightLoop() {
  const cards = document.getElementById('song-sections')?.children;
  if (!cards) return;
  const bd = beatDur();
  const pos = previewOffset + (previewState === 'playing' ? (S.ctx.currentTime - previewStartT) : 0);
  let t = 0, idx = -1;
  for (let i = 0; i < arr.length; i++) { const e = t + arr[i].beats * bd; if (pos >= t && pos < e) { idx = i; break; } t = e; }
  for (let i = 0; i < cards.length; i++) cards[i].classList.toggle('playing', i === idx);
  if (previewState === 'playing') previewRAF = requestAnimationFrame(highlightLoop);
}
function clearHighlight() {
  const cards = document.getElementById('song-sections')?.children;
  if (cards) for (let i = 0; i < cards.length; i++) cards[i].classList.remove('playing');
}
function updatePreviewBtns() {
  const b = document.getElementById('song-preview-btn');
  if (b) b.textContent = previewState === 'playing' ? '⏸ Pause' : previewState === 'paused' ? '▶ Resume' : '▶ Preview';
  const st = document.getElementById('song-stop-btn');
  if (st) st.disabled = previewState === 'stopped';
}

// ── Render / export actions ─────────────────────────────────────────────────────
export async function downloadSong() {
  const buf = await renderMix();
  if (!buf) { setStatus('Nothing to render'); return; }
  download(buf, 'looper-song.wav', masterOpts().bits);
  setStatus('Exported looper-song.wav (' + masterOpts().bits + '-bit)');
}
window.songDownloadStems = async () => {
  const stems = await renderStems();
  if (!stems.length) { setStatus('Nothing to render'); return; }
  const bits = masterOpts().bits;
  stems.forEach((st, i) => setTimeout(() => download(st.buf, 'looper-stem-' + (i + 1) + '.wav', bits), i * 350));
  setStatus('Exported ' + stems.length + ' stems (' + bits + '-bit)');
};
window.songToStudio = async () => {
  if (!isStudioOpen()) { setStatus('Open the Studio in another window first'); return; }
  const buf = await renderMix();
  if (buf) sendBufferToStudio(buf, 'Looper Song');
};
window.songStemsToStudio = async () => {
  if (!isStudioOpen()) { setStatus('Open the Studio in another window first'); return; }
  const stems = await renderStems();
  for (const st of stems) sendBufferToStudio(st.buf, st.name);
  setStatus('Sent ' + stems.length + ' stems to the Studio →');
};

// Keep the Studio buttons greyed out when no Studio is listening.
export function refreshSongStudioBtns() {
  const open = isStudioOpen();
  ['song-studio-btn', 'song-stemstudio-btn'].forEach(id => {
    const b = document.getElementById(id); if (b) b.disabled = !open;
  });
}
