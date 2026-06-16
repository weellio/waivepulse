// ── Loop slots: record, playback, waveform, progress rings ────────────────────
import { S } from './state.js';
import { ensureCtx } from './core.js';
import { fmtSec, setStatus } from './util.js';
import { quantizeLen, playClick } from './transport.js';
import { createEq7, resetEq } from '../shared/eq7.js';
import { studioOpen } from './bridge.js';

// ── Loop slots ────────────────────────────────────────────────────────────────
const N = 6;

S.slots = Array.from({length: N}, (_, i) => ({
  id: i, state: 'empty',
  buffer: null, srcNode: null, gainNode: null, eq: null,
  startedAt: null, stopTimer: null, armTimer: null,
  nudge: 0   // seconds; live phase shift to align the loop to the beat
}));

export function buildSlots() {
  const grid = document.getElementById('loopGrid');
  grid.innerHTML = '';
  S.slots.forEach(s => {
    s.state = 'empty'; s.buffer = null; s.srcNode = null; s.gainNode = null; s.eq = null; s.nudge = 0;
    const el = document.createElement('div');
    el.className = 'slot'; el.id = 'slot-' + s.id;
    el.innerHTML = `
      <div class="rec-bar"><div class="rec-bar-fill" id="recbarfill-${s.id}"></div></div>
      <div class="rec-count" id="reccount-${s.id}"></div>
      <div class="slot-hdr">
        <span class="slot-num">LOOP ${s.id + 1} <kbd class="slot-key">F${s.id + 1}</kbd></span>
        <span class="slot-dur" id="dur-${s.id}">—</span>
        <svg class="ring" id="ring-${s.id}" width="18" height="18" viewBox="0 0 18 18">
          <circle class="rbg" cx="9" cy="9" r="7.5"/>
          <circle class="rfg" id="rfg-${s.id}" cx="9" cy="9" r="7.5"/>
        </svg>
      </div>
      <canvas class="slot-canvas" id="cv-${s.id}"></canvas>
      <div class="slot-btns">
        <button class="slt-btn rec-btn" id="rb-${s.id}" onclick="tapRecord(${s.id})">● Record</button>
        <button class="slt-btn play-btn" id="pb-${s.id}" onclick="tapPlay(${s.id})" disabled>▶</button>
        <button class="slt-btn clr-btn"  id="cb-${s.id}" onclick="clearSlot(${s.id})" disabled>✕</button>
        <button class="slt-btn eq-btn"   id="eqb-${s.id}" onclick="openLoopEq(${s.id})" style="display:none;grid-column:1/-1">⚌ EQ</button>
        <button class="slt-btn trim-btn" id="trb-${s.id}" onclick="openLoopTrim(${s.id})" style="display:none;grid-column:1/-1" title="Trim leading dead air — set where the loop starts (first hit, or a chosen beat)">✂ Trim Start</button>
        <button class="slt-btn smpl-btn" id="sb-${s.id}" onclick="useAsSample(${s.id})" style="display:none;grid-column:1/-1">🎹 Use as Sample</button>
        <button class="slt-btn studio-btn" id="stu-${s.id}" onclick="sendLoopToStudio(${s.id})" style="display:none;grid-column:1/-1" title="Send this loop to an open Studio window as a new track">⇪ Send to Studio</button>
      </div>
      <div class="slot-vol">
        <span class="vol-lbl">VOL</span>
        <input type="range" class="vslider" min="0" max="1.5" step="0.01" value="1"
               oninput="setVol(${s.id}, this.value)">
      </div>
      <div class="slot-nudge">
        <span class="vol-lbl">SYNC</span>
        <button class="nudge-btn" id="nl-${s.id}" onclick="nudgeSlot(${s.id},-1)" disabled title="Shift earlier ½ beat">◀</button>
        <span class="nudge-val" id="nudge-${s.id}">0ms</span>
        <button class="nudge-btn" id="nr-${s.id}" onclick="nudgeSlot(${s.id},1)" disabled title="Shift later ½ beat">▶</button>
      </div>`;
    grid.appendChild(el);
  });
}

function ensureGain(s) {
  if (!s.gainNode) {
    s.gainNode = S.ctx.createGain();
    s.gainNode.connect(S.loopBus);
    s.eq = createEq7(S.ctx);          // 7-band parametric EQ in front of the gain
    s.eq.output.connect(s.gainNode);
  }
}

// ── Recording ─────────────────────────────────────────────────────────────────
export async function tapRecord(id) {
  ensureCtx();
  if (S.ctx.state === 'suspended') S.ctx.resume();
  const s = S.slots[id];
  if (s.state === 'recording') { stopRec(id);    return; }
  if (s.state === 'counting')  { cancelCount(id); return; }   // cancel count-in OR armed overdub
  S.slots.forEach((x, i) => {
    if (x.state === 'recording') stopRec(i);
    if (x.state === 'counting')  cancelCount(i);
  });
  if (S.masterLen !== null && id !== S.masterSlot) {
    armOverdub(id);                  // quantized: begin on the next downbeat, capture one full bar
  } else if (S.countIn > 0) {
    await doCountIn(id);             // first loop: count-in, then free-length recording
  } else {
    startRec(id);
  }
}

// Overdub: wait for the master loop to wrap, then record exactly one cycle — so the
// layer is always full-length and on the grid no matter when you hit Record.
export function armOverdub(id) {
  const s = S.slots[id];
  s.state = 'counting';              // reuse the amber "armed" visual + Cancel button
  slotUI(id);
  const elapsed = (S.ctx.currentTime - S.masterAnchor) % S.masterLen;
  const toDownbeat = S.masterLen - elapsed;
  const durEl = document.getElementById('dur-' + id);
  if (durEl) durEl.textContent = 'ARM';
  const rc = document.getElementById('reccount-' + id); if (rc) rc.textContent = '●';
  setStatus('Loop ' + (id + 1) + ' armed — recording starts on the downbeat');
  clearTimeout(s.armTimer);
  s.armTimer = setTimeout(() => {
    if (s.state !== 'counting') return;   // cancelled while waiting
    if (durEl) durEl.textContent = '—';
    startRec(id);
  }, Math.max(toDownbeat, 0.03) * 1000);
}

export async function doCountIn(id) {
  const s = S.slots[id];
  s.state = 'counting'; slotUI(id);
  const beatMs = 60000 / S.bpm;
  const rc = document.getElementById('reccount-' + id);
  for (let i = S.countIn; i > 0; i--) {
    if (s.state !== 'counting') return;
    document.getElementById('dur-' + id).textContent = i + '…';
    if (rc) rc.textContent = i;
    setStatus('Loop ' + (id + 1) + ' starts in ' + i + '…');
    playClick(i === S.countIn);
    await new Promise(r => setTimeout(r, beatMs));
  }
  if (s.state !== 'counting') return;
  document.getElementById('dur-' + id).textContent = '—';
  if (rc) rc.textContent = '';
  startRec(id);
}

export function cancelCount(id) {
  const s = S.slots[id]; if (s.state !== 'counting') return;
  clearTimeout(s.armTimer);
  s.state = 'empty';
  document.getElementById('dur-' + id).textContent = '—';
  const rc = document.getElementById('reccount-' + id); if (rc) rc.textContent = '';
  slotUI(id);
}

export function startRec(id) {
  const s = S.slots[id];
  s.state     = 'recording';
  s.startedAt = S.ctx.currentTime;
  S.captureChunks = {L: [], R: []};
  S.capturing = true;
  if (S.captureNode?.port) S.captureNode.port.postMessage(true);
  const rc = document.getElementById('reccount-' + id); if (rc) rc.textContent = '';

  // Overdub: armed to the downbeat, so capture exactly one full master cycle
  if (S.masterLen !== null && id !== S.masterSlot) {
    s.stopTimer = setTimeout(() => stopRec(id), S.masterLen * 1000);
    slotUI(id);
    setStatus('Recording loop ' + (id + 1) + ' — one bar, locked to the beat…');
    return;
  }

  slotUI(id);
  setStatus('Recording loop ' + (id + 1) + '… tap Record again to stop');
}

export function stopRec(id) {
  const s = S.slots[id];
  if (s.state !== 'recording') return;
  S.capturing = false;
  if (S.captureNode?.port) S.captureNode.port.postMessage(false);
  clearTimeout(s.stopTimer);
  const rbf = document.getElementById('recbarfill-' + id); if (rbf) rbf.style.width = '0%';

  const rawDur = S.ctx.currentTime - s.startedAt;
  if (rawDur < 0.15 || !S.captureChunks) {
    s.state = 'empty'; S.captureChunks = null; slotUI(id); return;
  }
  // Overdubs are exactly one master cycle (full-length, grid-aligned); the first
  // loop is free-length (optionally quantized to the nearest bar).
  const isOverdub = S.masterLen !== null && id !== S.masterSlot;
  const dur = isOverdub ? S.masterLen
            : (S.quantize ? quantizeLen(rawDur) : rawDur);

  s.buffer = buildBuf(S.captureChunks, dur);
  S.captureChunks = null;

  document.getElementById('dur-' + id).textContent = fmtSec(s.buffer.duration);
  drawWave(id);

  if (S.masterLen === null) {
    S.masterLen    = s.buffer.duration;
    S.masterAnchor = s.startedAt;
    S.masterSlot   = id;
  }

  playSlot(id);
  setStatus('Loop ' + (id + 1) + ' playing · hit Record on another slot to layer');
}

export function buildBuf(chunks, maxDur) {
  const sr  = S.ctx.sampleRate;
  const len = Math.floor(maxDur * sr);   // exact target length (pads with silence if short)
  const buf = S.ctx.createBuffer(2, len, sr);
  const Lch = buf.getChannelData(0);
  const Rch = buf.getChannelData(1);
  let off = 0;
  for (let i = 0; i < chunks.L.length && off < len; i++) {
    const n = Math.min(chunks.L[i].length, len - off);
    Lch.set(chunks.L[i].subarray(0, n), off);
    Rch.set(chunks.R[i].subarray(0, n), off);
    off += n;
  }
  return buf;
}

// ── Playback ──────────────────────────────────────────────────────────────────
export function playSlot(id) {
  const s = S.slots[id];
  if (!s.buffer) return;
  ensureCtx(); ensureGain(s);
  killSrc(id);

  const src = S.ctx.createBufferSource();
  src.buffer  = s.buffer;
  src.loop    = true;
  src.loopEnd = s.buffer.duration;
  src.connect(s.eq ? s.eq.input : s.gainNode);   // through the per-loop EQ

  const dur = s.buffer.duration;
  let offset = 0;
  if (S.masterLen && S.masterAnchor !== null) {
    offset = (S.ctx.currentTime - S.masterAnchor) % S.masterLen;
  }
  // Apply the per-loop nudge (live phase shift to align to the beat), wrapped into the buffer
  offset = (((offset + (s.nudge || 0)) % dur) + dur) % dur;
  offset = Math.min(offset, dur - 0.001);

  src.start(S.ctx.currentTime, offset);
  s.srcNode = src;
  s.state   = 'playing';
  slotUI(id);
}

export function tapPlay(id) {
  const s = S.slots[id];
  if (s.state === 'playing') { killSrc(id); s.state = 'stopped'; slotUI(id); }
  else if (s.buffer) playSlot(id);
}

function killSrc(id) {
  const s = S.slots[id];
  if (s.srcNode) {
    try { s.srcNode.stop(); } catch(_) {}
    s.srcNode.disconnect();
    s.srcNode = null;
  }
}

export function clearSlot(id) {
  killSrc(id);
  const s = S.slots[id];
  s.state = 'empty'; s.buffer = null; s.startedAt = null; s.nudge = 0;
  if (s.eq) resetEq(s.eq);          // flatten the per-loop EQ so a new recording starts clean
  if (id === S.masterSlot) rederiveMaster();
  document.getElementById('dur-' + id).textContent = '—';
  document.getElementById('nudge-' + id).textContent = '0ms';
  const cv = document.getElementById('cv-' + id);
  cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  slotUI(id);
  setStatus(S.masterLen ? 'Loop ' + (id + 1) + ' cleared' : 'All loops cleared — start fresh');
}

export function clearAll() {
  S.slots.forEach((_, i) => clearSlot(i));
}

// Silence every playing loop without clearing it (so the Song Builder can preview
// against silence instead of fighting the live loop mix). Buffers are kept.
export function stopAllPlayback() {
  S.slots.forEach((s, i) => {
    if (s.state === 'playing') { killSrc(i); s.state = 'stopped'; slotUI(i); }
  });
}

function rederiveMaster() {
  S.masterLen = null; S.masterAnchor = null; S.masterSlot = -1;
  S.slots.forEach((s, i) => {
    if (s.buffer && S.masterLen === null) {
      S.masterLen = s.buffer.duration; S.masterSlot = i;
    }
  });
}

export function setVol(id, v) {
  if (S.slots[id].gainNode) S.slots[id].gainNode.gain.value = parseFloat(v);
}

// ── Slot UI ───────────────────────────────────────────────────────────────────
export function slotUI(id) {
  const s  = S.slots[id];
  const el = document.getElementById('slot-' + id);
  el.className = 'slot ' + s.state;

  const rb = document.getElementById('rb-' + id);
  if (s.state === 'recording') {
    rb.className = 'slt-btn rec-btn active'; rb.textContent = '■ Stop';
  } else if (s.state === 'counting') {
    rb.className = 'slt-btn rec-btn active'; rb.textContent = '✕ Cancel';
  } else {
    rb.className = 'slt-btn rec-btn'; rb.textContent = '● Record';
  }

  const pb = document.getElementById('pb-' + id);
  pb.disabled    = !s.buffer;
  pb.textContent = s.state === 'playing' ? '⏸' : '▶';

  const cb = document.getElementById('cb-' + id);
  cb.disabled = !s.buffer && s.state !== 'recording';

  const sb = document.getElementById('sb-' + id);
  if (sb) sb.style.display = s.buffer ? '' : 'none';
  const eqb = document.getElementById('eqb-' + id);
  if (eqb) eqb.style.display = s.buffer ? '' : 'none';
  const trb = document.getElementById('trb-' + id);
  if (trb) trb.style.display = s.buffer ? '' : 'none';
  const stu = document.getElementById('stu-' + id);
  if (stu) { stu.style.display = s.buffer ? '' : 'none'; stu.disabled = !s.buffer || !studioOpen(); }

  const nl = document.getElementById('nl-' + id);
  const nr = document.getElementById('nr-' + id);
  if (nl) nl.disabled = !s.buffer;
  if (nr) nr.disabled = !s.buffer;
}

// Re-evaluate every "Send to Studio" button's enabled state — called by the bridge
// heartbeat whenever a Studio window opens or closes.
export function refreshStudioButtons() {
  const open = studioOpen();
  S.slots.forEach(s => {
    const stu = document.getElementById('stu-' + s.id);
    if (stu) stu.disabled = !s.buffer || !open;
  });
}

// Shift a loop's timing by ±half a beat (live) so an off-the-beat take snaps into place.
export function nudgeSlot(id, dir) {
  const s = S.slots[id];
  if (!s.buffer) return;
  const dur  = s.buffer.duration;
  const step = (60 / S.bpm) / 2;            // an 8th note = half a beat
  s.nudge += dir * step;
  // keep it within ±half the loop so the readout stays sane
  while (s.nudge >  dur / 2) s.nudge -= dur;
  while (s.nudge < -dur / 2) s.nudge += dur;
  const ms = Math.round(s.nudge * 1000);
  const el = document.getElementById('nudge-' + id);
  if (el) el.textContent = (ms > 0 ? '+' : '') + ms + 'ms';
  if (s.state === 'playing') playSlot(id);   // re-anchor at the new phase immediately
  setStatus('Loop ' + (id + 1) + ' nudged ' + (ms > 0 ? '+' : '') + ms + 'ms');
}

// ── Waveform ──────────────────────────────────────────────────────────────────
export function drawWave(id) {
  const s = S.slots[id];
  if (!s.buffer) return;
  const cv  = document.getElementById('cv-' + id);
  const dpr = window.devicePixelRatio || 1;
  cv.width  = cv.offsetWidth  * dpr;
  cv.height = cv.offsetHeight * dpr;
  const c = cv.getContext('2d');
  const W = cv.offsetWidth, H = cv.offsetHeight;
  c.scale(dpr, dpr);

  const data = s.buffer.getChannelData(0);
  const step = Math.max(1, Math.ceil(data.length / W));
  const g = c.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, '#1ab8b8');
  g.addColorStop(1, '#22c55e');
  c.strokeStyle = g; c.lineWidth = 1.2;
  c.beginPath();
  for (let x = 0; x < W; x++) {
    let mn = 1, mx = -1;
    for (let j = 0; j < step; j++) {
      const v = data[x * step + j] || 0;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const y1 = ((1 - mx) / 2) * H;
    const y2 = ((1 - mn) / 2) * H;
    if (x === 0) c.moveTo(0, (y1 + y2) / 2);
    c.lineTo(x, y1);
    c.lineTo(x, y2);
  }
  c.stroke();
}

// ── Loop progress ring + recording bar ────────────────────────────────────────
export function animRings() {
  const circ = 47.1;
  const playT = (S.ctx && S.masterLen && S.masterAnchor !== null)
    ? ((S.ctx.currentTime - S.masterAnchor) % S.masterLen) / S.masterLen : 0;

  S.slots.forEach((s, i) => {
    // playback ring
    const ring = document.getElementById('ring-' + i);
    const rfg  = document.getElementById('rfg-' + i);
    if (ring) {
      if (s.state === 'playing' && S.masterLen) { ring.classList.add('vis'); rfg.style.strokeDashoffset = circ * (1 - playT); }
      else ring.classList.remove('vis');
    }
    // recording sweep bar + downbeat flash
    const rbf = document.getElementById('recbarfill-' + i);
    const el  = document.getElementById('slot-' + i);
    if (s.state === 'recording' && S.ctx) {
      const since = S.ctx.currentTime - s.startedAt;
      let frac;
      if (S.masterLen !== null && i !== S.masterSlot) {
        frac = Math.min(1, since / S.masterLen);              // overdub: fills once
      } else {
        const barLen = (60 / S.bpm) * 4;                      // first loop: sweeps each bar
        frac = (since % barLen) / barLen;
      }
      if (rbf) rbf.style.width = (frac * 100) + '%';
      // pulse the card border on every beat, brighter on the downbeat
      const beatLen = 60 / S.bpm;
      const pulse = Math.pow(1 - (since % beatLen) / beatLen, 3);
      const v = pulse * (Math.floor(since / beatLen) % 4 === 0 ? 1 : 0.5);
      if (el) el.style.boxShadow = `0 0 ${4 + v * 18}px rgba(248,113,113,${0.12 + v * 0.6})`;
    } else if (el && el.style.boxShadow) {
      el.style.boxShadow = '';                                // restore the CSS state shadow
    }
  });
  requestAnimationFrame(animRings);
}
