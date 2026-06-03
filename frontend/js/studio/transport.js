// Transport: playback engine, seek, RAF playhead loop, zoom, ruler, loop region.
import { S } from './state.js';
import { fmtTime } from './util.js';
import { redrawAll, soloCount } from './waveform.js';

export function getCanvasWidth() { return document.getElementById('content-area').clientWidth * S._zoom; }

// ── Playback ───────────────────────────────────────────────────────────────
export function togglePlay() { S._playing ? pausePlayback() : startPlayback(); }

export function startPlayback() {
  if (!S._actx) return;
  if (S._actx.state === 'suspended') S._actx.resume();
  S._startTime = S._actx.currentTime;
  const offset = Math.max(0, Math.min(S._dur, S._startOff));
  for (const [, t] of Object.entries(S.tracks)) {
    const src = S._actx.createBufferSource();
    src.buffer = t.buffer;
    src.connect(t.offsetNode || t.gainNode);
    src.onended = () => { if (t.source === src) t.source = null; };
    t.source = src;
    t._inMuteRange = false;
    if (t.isImport && t.loopTrack) {
      src.loop = true;
      src.start(S._actx.currentTime + 0.05, offset % t.buffer.duration);
    } else if (t.isImport) {
      const clipStart = t.startTime || 0;
      const clipEnd = clipStart + t.buffer.duration;
      if (offset >= clipEnd) { try { src.disconnect(); } catch {} t.source = null; continue; }
      if (offset >= clipStart) {
        src.start(S._actx.currentTime + 0.05, offset - clipStart);
      } else {
        src.start(S._actx.currentTime + 0.05 + (clipStart - offset), 0);
      }
    } else {
      src.start(S._actx.currentTime + 0.05, offset);
    }
  }
  scheduleMasterFade(offset);
  S._playing = true;
  const btn = document.getElementById('play-btn');
  btn.classList.add('active'); btn.textContent = '⏸';
}

// ── Master fade in/out ───────────────────────────────────────────────────────
// Schedules the fade envelope on the final _fadeGain node (sample-accurate, on the
// audio clock) for a playback starting at song position `offset`.
export function scheduleMasterFade(offset) {
  const fg = S._fadeGain; if (!fg) return;
  const x = S._actx, T0 = x.currentTime + 0.05, fi = S._fadeIn || 0, fo = S._fadeOut || 0, dur = S._dur;
  const gAt = s => {
    let g = 1;
    if (fi > 0 && s < fi) g = Math.max(0, s / fi);
    if (fo > 0 && s > dur - fo) g = Math.min(g, Math.max(0, (dur - s) / fo));
    return Math.max(0.0001, g);
  };
  fg.gain.cancelScheduledValues(x.currentTime);
  fg.gain.setValueAtTime(gAt(offset), T0);
  if (fi > 0 && offset < fi) fg.gain.linearRampToValueAtTime(1, T0 + (fi - offset));
  if (fo > 0) {
    const fStart = dur - fo;
    if (offset < fStart) fg.gain.setValueAtTime(1, T0 + (fStart - offset));
    fg.gain.linearRampToValueAtTime(0.0001, T0 + Math.max(0, dur - offset));
  }
}

export function setFadeIn(v) {
  S._fadeIn = Math.max(0, parseFloat(v) || 0);
  document.getElementById('fade-in-label').textContent = S._fadeIn ? S._fadeIn.toFixed(1) + 's' : 'off';
  if (S._playing) scheduleMasterFade(currentPosition());
  else if (S._fadeGain) S._fadeGain.gain.setValueAtTime(1, S._actx.currentTime);
}

export function setFadeOut(v) {
  S._fadeOut = Math.max(0, parseFloat(v) || 0);
  document.getElementById('fade-out-label').textContent = S._fadeOut ? S._fadeOut.toFixed(1) + 's' : 'off';
  if (S._playing) scheduleMasterFade(currentPosition());
  else if (S._fadeGain) S._fadeGain.gain.setValueAtTime(1, S._actx.currentTime);
}

export function pausePlayback() {
  S._startOff = currentPosition(); stopSources(); S._playing = false;
  const btn = document.getElementById('play-btn');
  btn.classList.remove('active'); btn.textContent = '▶';
}

export function stopPlayback() {
  S._startOff = 0; stopSources(); S._playing = false;
  if (S._fadeGain) { S._fadeGain.gain.cancelScheduledValues(S._actx.currentTime); S._fadeGain.gain.setValueAtTime(1, S._actx.currentTime); }
  const btn = document.getElementById('play-btn');
  btn.classList.remove('active'); btn.textContent = '▶';
  updatePlayhead(0); document.getElementById('time-display').textContent = '0:00';
}

export function stopSources() {
  for (const t of Object.values(S.tracks)) { if (t.source) { try { t.source.stop(); } catch {} t.source = null; } }
}

export function seekTo(pos) {
  const was = S._playing;
  if (was) stopSources();
  S._startOff = Math.max(0, Math.min(S._dur, pos));
  S._startTime = S._actx ? S._actx.currentTime : 0;
  if (was) startPlayback();
  else { updatePlayhead(S._startOff); document.getElementById('time-display').textContent = fmtTime(S._startOff); }
}

export function currentPosition() {
  if (!S._actx || !S._playing) return S._startOff;
  return S._startOff + (S._actx.currentTime - S._startTime);
}

// ── RAF loop ───────────────────────────────────────────────────────────────
export function startRAF() {
  function tick() {
    S._rafId = requestAnimationFrame(tick);
    if (!S._playing) return;
    const pos = currentPosition();
    const loopEnd = (S._looping && S._loopEnd !== null) ? S._loopEnd : S._dur;
    const loopStart = (S._looping && S._loopStart !== null) ? S._loopStart : 0;
    if (pos >= loopEnd) { S._looping ? seekTo(loopStart) : stopPlayback(); return; }
    updatePlayhead(pos);
    document.getElementById('time-display').textContent = fmtTime(pos);
    autoScrollToPlayhead(pos);
    applyRangedGains(pos);
  }
  S._rafId = requestAnimationFrame(tick);
}

export function updatePlayhead(pos) {
  const cw = getCanvasWidth();
  document.getElementById('playhead').style.left = ((pos / S._dur) * cw) + 'px';
}

export function autoScrollToPlayhead(pos) {
  if (S._zoom <= 1) return;
  const sc = document.getElementById('scroll-content');
  const x = (pos / S._dur) * getCanvasWidth();
  const vw = sc.clientWidth;
  if (x < sc.scrollLeft + vw * .05 || x > sc.scrollLeft + vw * .85) {
    sc.scrollLeft = Math.max(0, x - vw * .2);
  }
}

// applyRangedGains lives in tracks.js (mix logic); imported lazily to avoid a
// circular import at module-eval time.
let _applyRangedGains = () => {};
export function _bindApplyRangedGains(fn) { _applyRangedGains = fn; }
function applyRangedGains(pos) { _applyRangedGains(pos); }

// ── Zoom ───────────────────────────────────────────────────────────────────
export function applyZoom() {
  document.getElementById('zoom-display').textContent = S._zoom + '×';
  const cw = getCanvasWidth();
  document.querySelectorAll('#scroll-content .track-row').forEach(r => {
    r.style.width = cw + 'px'; r.style.minWidth = cw + 'px';
  });
  document.getElementById('ruler-inner').style.width = cw + 'px';
  redrawAll();
  buildRuler();
  updateLoopRegion();
}

export function zoomIn() { S._zoom = Math.min(16, S._zoom * 2); applyZoom(); }
export function zoomOut() { S._zoom = Math.max(1, S._zoom / 2); applyZoom(); }
export function zoomFit() { S._zoom = 1; applyZoom(); }

// ── Ruler ──────────────────────────────────────────────────────────────────
export function buildRuler() {
  const ruler = document.getElementById('ruler-inner');
  ruler.innerHTML = '';
  const w = getCanvasWidth();
  const stp = niceStep(S._dur, w);
  for (let t = 0; t <= S._dur; t += stp) {
    const x = (t / S._dur) * w;
    const tick = document.createElement('div');
    tick.style.cssText = `position:absolute;left:${x}px;top:5px;font-size:10px;color:#555;transform:translateX(-50%);pointer-events:none;white-space:nowrap`;
    tick.textContent = fmtTime(t);
    ruler.appendChild(tick);
  }
}

export function niceStep(dur, px) {
  for (const s of [1, 2, 5, 10, 15, 30, 60, 120, 300]) { if (px / (dur / s) > 55) return s; }
  return 300;
}

// ── Loop region ────────────────────────────────────────────────────────────
export function toggleLoop() {
  S._looping = !S._looping;
  document.getElementById('loop-btn').classList.toggle('active', S._looping);
}

export function updateLoopRegion() {
  const el = document.getElementById('loop-region');
  if (!el) return;
  if (S._loopStart === null || S._loopEnd === null || S._dur === 0) { el.style.display = 'none'; return; }
  const cw = getCanvasWidth();
  el.style.left = ((S._loopStart / S._dur) * cw) + 'px';
  el.style.width = (((S._loopEnd - S._loopStart) / S._dur) * cw) + 'px';
  el.style.display = 'block';
}
