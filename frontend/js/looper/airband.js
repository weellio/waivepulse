// ── Air Band: play the drums + keys with your hands in front of the webcam ────
// MediaPipe Hand Landmarker (runs on the GPU in the browser, nothing leaves the
// machine) tracks up to two hands. The camera view is split into a grid of zones,
// each assigned a drum pad or a note (airband-logic.js). Hits go through the SAME
// hitDrum / noteOn / noteOff path as the computer keys and MIDI input, so they are
// recorded into loops and honour scale lock, ADSR, filter, arp and instrument.
//   · drum zone: a quick downward strike of the hand = one hit, velocity from speed
//   · note zone: an OPEN hand inside the zone holds the note; fist / leaving releases
import { S } from './state.js';
import { setStatus } from './util.js';
import { ensureCtx } from './core.js';
import { noteOn, noteOff } from './synth.js';
import { DRUMS, hitDrum } from './drums.js';
import { midiNoteObj } from './midi-in.js';
import { NOTE_NAMES } from './scale.js';
import {
  PRESETS, GRID_SIZES, presetMapping, resizeMapping, serializeMapping, parseMapping,
  zoneRect, HandTracker, sensToThreshold, degreeToMidi, mirrorLandmarks, HAND_BONES, palmCenter, matchHands,
  DEFAULT_AREA, normArea,
} from './airband-logic.js';

const MP_VER    = '1.0.1';
const MP_BASE   = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const MODEL_URL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const LS_KEY    = 'wp.looper.airband';
const HOLD_VEL  = 0.9;
const DETECT_W  = 320;    // tracker input width: hands need no more, and it keeps the GPU path at 60 fps
const GRACE_MS  = 350;    // keep a hand (and its held note) through a short tracking dropout
const SLOW_FPS  = 12;     // below this on the GPU we try the CPU delegate, and keep whichever is faster

const A = {
  on: false, loading: false, stream: null, landmarker: null, lms: {}, delegate: 'GPU', det: null,
  bench: null,          // { phase: 'gpu'|'cpu'|'done', since, gpuFps } auto delegate pick
  lastFrameT: 0,
  mapping: presetMapping('drums'), preset: 'drums', sens: 0.65, mirror: true, big: false,
  trackers: [],         // [{ id, tr: HandTracker, label }] matched frame-to-frame by palm position
  seq: 0,               // tracker id counter
  heldNote: {},         // tracker id → note object currently held (for noteOff)
  lastHit: null,        // { name, vel, t } for the read-out
  audioWarned: false,
  flash: {},            // zone → ms until the hit flash fades
  raf: 0, lastVideoT: -1, frames: 0, fpsT: 0, fps: 0, handsNow: 0,
  labelKey: '',         // scale root+name the zone labels were built for
  log: [],              // recent events (page tests read this)
};

const $ = id => document.getElementById(id);

// ── Persistence ───────────────────────────────────────────────────────────────
function save() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ m: serializeMapping(A.mapping), preset: A.preset, sens: A.sens, mirror: A.mirror }));
  } catch (_) {}
}
function restore() {
  try {
    const o = JSON.parse(localStorage.getItem(LS_KEY) || 'null'); if (!o) return;
    const m = parseMapping(o.m); if (m) A.mapping = m;
    if (typeof o.preset === 'string') A.preset = o.preset;
    if (typeof o.sens === 'number') A.sens = Math.min(1, Math.max(0, o.sens));
    if (typeof o.mirror === 'boolean') A.mirror = o.mirror;
  } catch (_) {}
}

// ── Labels ────────────────────────────────────────────────────────────────────
function noteName(deg) {
  const m = degreeToMidi(deg, S.scaleRoot, S.scaleName);
  return NOTE_NAMES[m % 12] + (Math.floor(m / 12) - 1);
}
function cellLabel(c) {
  if (!c) return '·';
  if (c.t === 'd') return DRUMS[c.i] ? DRUMS[c.i].icon + ' ' + DRUMS[c.i].name : '?';
  return noteName(c.deg);
}
function cellValue(c) { return !c ? 'none' : c.t + ':' + (c.t === 'd' ? c.i : c.deg); }
function valueToCell(v) {
  if (!v || v === 'none') return null;
  const [t, n] = v.split(':'); const k = parseInt(n, 10);
  if (t === 'd' && DRUMS[k]) return { t: 'd', i: k };
  if (t === 'n' && k >= 0 && k < 24) return { t: 'n', deg: k };
  return null;
}
function scaleKey() { return S.scaleRoot + ':' + S.scaleName; }

// ── Zone editor (one <select> per zone, laid out like the camera grid) ────────
function buildZoneEditor() {
  const box = $('airZones'); if (!box) return;
  const m = A.mapping;
  box.style.gridTemplateColumns = `repeat(${m.cols}, 1fr)`;
  box.innerHTML = '';
  m.cells.forEach((c, i) => {
    const sel = document.createElement('select');
    sel.className = 'air-zone ' + (c ? c.t : 'x');
    sel.title = `Zone ${i + 1}: what this part of the camera view plays`;
    sel.appendChild(new Option('— none —', 'none'));
    const gd = document.createElement('optgroup'); gd.label = 'Drums (strike)';
    DRUMS.forEach((d, k) => gd.appendChild(new Option(d.icon + ' ' + d.name, 'd:' + k)));
    sel.appendChild(gd);
    const gn = document.createElement('optgroup'); gn.label = 'Notes (hold open hand)';
    for (let k = 0; k < 15; k++) gn.appendChild(new Option(`${k + 1} · ${noteName(k)}`, 'n:' + k));
    sel.appendChild(gn);
    sel.value = cellValue(c);
    sel.addEventListener('change', () => airAssign(i, sel.value));
    box.appendChild(sel);
  });
  A.labelKey = scaleKey();
}
// Note names depend on the scale lock: refresh the option labels when it changes.
function refreshLabels() {
  if (A.labelKey === scaleKey()) return;
  const box = $('airZones'); if (!box) return;
  [...box.querySelectorAll('select')].forEach(sel => {
    [...sel.options].forEach(o => { if (o.value.startsWith('n:')) { const k = +o.value.slice(2); o.textContent = `${k + 1} · ${noteName(k)}`; } });
  });
  A.labelKey = scaleKey();
}
function syncControls() {
  const p = $('airPreset'); if (p) p.value = A.preset;
  const g = $('airGrid');   if (g) g.value = A.mapping.grid;
  const s = $('airSens');   if (s) s.value = A.sens;
  $('airMirrorBtn')?.classList.toggle('on', A.mirror);
  $('airVideo')?.classList.toggle('mirror', A.mirror);
  A.trackers.forEach(t => t.tr.setThreshold(sensToThreshold(A.sens)));
}

// ── Public controls (exposed on window by main.js) ────────────────────────────
export function setAirPreset(name) {
  if (!PRESETS[name]) return;
  A.preset = name; A.mapping = presetMapping(name, A.mapping.area);
  releaseAll(); buildZoneEditor(); syncControls(); save(); draw();
  setStatus('Air Band layout: ' + PRESETS[name].label);
}
export function setAirGrid(grid) {
  if (!GRID_SIZES[grid]) return;
  A.mapping = resizeMapping(A.mapping, grid); A.preset = 'custom';
  releaseAll(); buildZoneEditor(); syncControls(); save(); draw();
}
export function airAssign(zone, value) {
  if (zone < 0 || zone >= A.mapping.cells.length) return;
  A.mapping.cells[zone] = valueToCell(value); A.preset = 'custom';
  releaseAll();
  const sel = $('airZones')?.children[zone]; if (sel) sel.className = 'air-zone ' + (A.mapping.cells[zone] ? A.mapping.cells[zone].t : 'x');
  syncControls(); save(); draw();
}
export function setAirSens(v) {
  A.sens = Math.min(1, Math.max(0, parseFloat(v) || 0));
  A.trackers.forEach(t => t.tr.setThreshold(sensToThreshold(A.sens)));
  save();
}
export function toggleAirMirror() {
  A.mirror = !A.mirror; releaseAll(); syncControls(); save();
  setStatus(A.mirror ? 'Air Band: mirror on (selfie view)' : 'Air Band: mirror off');
}
// ── Kit area: drag to move, corners to resize, double-click to reset ─────────
let drag = null;
function canvasPoint(e) {
  const c = $('airCanvas'), r = c.getBoundingClientRect();
  const scale = Math.min(r.width / c.width, r.height / c.height);          // object-fit: contain
  const ox = (r.width - c.width * scale) / 2, oy = (r.height - c.height * scale) / 2;
  return { x: (e.clientX - r.left - ox) / (c.width * scale), y: (e.clientY - r.top - oy) / (c.height * scale) };
}
function areaHandle(p) {
  const a = A.mapping.area, tol = 0.045;
  const near = (x, y) => Math.abs(p.x - x) < tol && Math.abs(p.y - y) < tol;
  if (near(a.x, a.y)) return 'tl'; if (near(a.x + a.w, a.y)) return 'tr';
  if (near(a.x, a.y + a.h)) return 'bl'; if (near(a.x + a.w, a.y + a.h)) return 'br';
  if (p.x >= a.x && p.x <= a.x + a.w && p.y >= a.y && p.y <= a.y + a.h) return 'move';
  return null;
}
const CURSORS = { tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', move: 'move' };
function setArea(a) { A.mapping.area = normArea(a); releaseAll(); draw(); }
function initAreaEditor() {
  const c = $('airCanvas'); if (!c) return;
  c.addEventListener('pointerdown', e => {
    const p = canvasPoint(e), h = areaHandle(p); if (!h) return;
    drag = { h, p0: p, a0: { ...A.mapping.area } }; c.setPointerCapture(e.pointerId); e.preventDefault();
  });
  c.addEventListener('pointermove', e => {
    const p = canvasPoint(e);
    if (!drag) { c.style.cursor = CURSORS[areaHandle(p)] || 'default'; return; }
    const { h, p0, a0 } = drag, dx = p.x - p0.x, dy = p.y - p0.y, a = { ...a0 };
    if (h === 'move') { a.x += dx; a.y += dy; }
    else {
      if (h === 'tl' || h === 'bl') { a.x += dx; a.w -= dx; } else a.w += dx;
      if (h === 'tl' || h === 'tr') { a.y += dy; a.h -= dy; } else a.h += dy;
    }
    setArea(a);
  });
  const end = () => { if (!drag) return; drag = null; save(); setStatus('Air Band: kit area moved — hands outside it play nothing'); };
  c.addEventListener('pointerup', end); c.addEventListener('pointercancel', end);
  c.addEventListener('dblclick', () => { setArea(DEFAULT_AREA); save(); setStatus('Air Band: kit area reset'); });
}

export function toggleAirBig() {
  A.big = !A.big;
  $('airStage')?.classList.toggle('big', A.big);
  $('airBigBtn')?.classList.toggle('on', A.big);
  draw();
}
export async function toggleAirBand() {
  if (A.on || A.loading) { stop(); return; }
  await start();
}

// ── Camera + model ────────────────────────────────────────────────────────────
function setStat(msg, cls) {
  const el = $('airStat'); if (el) { el.textContent = msg; el.className = 'midi-stat' + (cls ? ' ' + cls : ''); }
}
function setBtn(on, label) {
  const b = $('airConnBtn'); if (b) { b.classList.toggle('on', on); b.textContent = label; }
}

let mpMod = null, mpFiles = null;
async function makeLandmarker(delegate) {
  if (A.lms[delegate]) return A.lms[delegate];
  if (!mpMod) {
    mpMod = await import(/* webpackIgnore: true */ `${MP_BASE}/vision_bundle.mjs`);
    mpFiles = await mpMod.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
  }
  const lm = await mpMod.HandLandmarker.createFromOptions(mpFiles, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate }, runningMode: 'VIDEO', numHands: 2,
    minHandDetectionConfidence: 0.5, minTrackingConfidence: 0.4,
  });
  // Warm-up: the GPU path compiles its shaders on the first frame (≈5 s of freeze on
  // this machine). Do that here, behind the status text, not on the user's first swing.
  setStat(`Warming up the ${delegate} tracker…`);
  try { const c = document.createElement('canvas'); c.width = DETECT_W; c.height = Math.round(DETECT_W * 0.75); c.getContext('2d').fillRect(0, 0, c.width, c.height); lm.detectForVideo(c, performance.now()); } catch (_) {}
  A.lms[delegate] = lm;
  return lm;
}
async function loadLandmarker() {
  if (A.landmarker) return A.landmarker;
  setStat('Loading hand tracker (first time ≈ 10 MB)…');
  try { A.landmarker = await makeLandmarker('GPU'); A.delegate = 'GPU'; }
  catch (e) { console.warn('Air Band: GPU delegate failed, using CPU', e); A.landmarker = await makeLandmarker('CPU'); A.delegate = 'CPU'; }
  return A.landmarker;
}
// The GPU path is fast on a real GPU but crawls when the browser has hardware
// acceleration off. After a few seconds on the GPU below SLOW_FPS, try the CPU
// delegate for a few seconds and keep whichever is faster; then say so if it's still slow.
// Which GPU the browser is really using for WebGL. "SwiftShader" = software rendering
// = the browser's graphics acceleration is off (Chrome: chrome://settings/system).
function webglRenderer() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2') || document.createElement('canvas').getContext('webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    return dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : (gl ? 'unknown' : 'no WebGL');
  } catch (_) { return 'unknown'; }
}
// Why the GPU tracker was slow, and what unlocks it. Shown whenever we end up on the
// CPU delegate (playable, but the GPU path does ~60 fps on a real GPU).
function gpuHint(fps, delegate) {
  const r = webglRenderer();
  const lead = delegate === 'CPU' ? `Tracking on the CPU (${fps} fps)` : `Slow tracking (${fps} fps)`;
  if (/swiftshader|software|llvmpipe|no webgl/i.test(r))
    return `${lead}: the browser's graphics acceleration is OFF, so the tracker can't use your GPU. Chrome: chrome://settings/system → "Use graphics acceleration when available" → Relaunch → ~60 fps.`;
  if (/intel|uhd|iris|radeon\(tm\) graphics/i.test(r))
    return `${lead}: the browser is running on the integrated GPU (${r}). Windows Settings → System → Display → Graphics → add the browser → High performance.`;
  return `${lead}: the GPU path was slow on ${r}. Close GPU-heavy apps (games, video generation) and restart the camera.`;
}
async function autoDelegate(now) {
  const b = A.bench; if (!b || b.phase === 'done') return;
  if (now - b.since < 3000) return;
  if (b.phase === 'gpu') {
    if (A.fps >= SLOW_FPS || A.delegate !== 'GPU') { b.phase = 'done'; return; }
    b.gpuFps = A.fps; b.phase = 'switching';
    try { const cpu = await makeLandmarker('CPU'); if (!A.on) return; A.landmarker = cpu; A.delegate = 'CPU'; b.phase = 'cpu'; b.since = performance.now(); setStat('Trying the CPU tracker…', 'ok'); }
    catch (e) { console.warn('CPU delegate failed', e); b.phase = 'done'; }
  } else if (b.phase === 'cpu') {
    if (A.fps < b.gpuFps) { A.landmarker = A.lms.GPU; A.delegate = 'GPU'; }
    b.phase = 'done';
    setStat(gpuHint(Math.max(A.fps, b.gpuFps), A.delegate), 'warn');   // we only get here because the GPU path was slow
  }
}

async function start() {
  const video = $('airVideo'); if (!video) return;
  if (!navigator.mediaDevices?.getUserMedia) { setStat('Camera not available here — needs https or localhost in Chrome / Edge', 'err'); return; }
  wakeAudio();                                              // inside the click: the browser lets audio start here
  A.loading = true; setBtn(true, '⏳ Starting…');
  try {
    setStat('Asking for the camera…');
    A.stream = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' }, audio: false });
    video.srcObject = A.stream;
    await new Promise(res => { if (video.readyState >= 1) res(); else video.onloadedmetadata = () => res(); });
    await video.play().catch(() => {});
    const c = $('airCanvas'); if (c && video.videoWidth) { c.width = video.videoWidth; c.height = video.videoHeight; }
    await loadLandmarker();
    if (!A.stream) return;                                  // stopped while loading
    A.on = true; A.loading = false; A.frames = 0; A.fpsT = performance.now(); A.lastVideoT = -1; A.lastFrameT = 0;
    A.bench = { phase: A.delegate === 'GPU' ? 'gpu' : 'done', since: performance.now(), gpuFps: 0 };
    if (!A.det) A.det = document.createElement('canvas');
    A.det.width = DETECT_W; A.det.height = Math.round(DETECT_W * (video.videoHeight || 480) / (video.videoWidth || 640));
    setBtn(true, '🎥 Camera on');
    setStat('Tracking — strike down for drums, hold an open hand for notes', 'ok');
    setStatus('Air Band on: play the zones with your hands');
    A.raf = requestAnimationFrame(loop);
  } catch (err) {
    console.warn('Air Band start failed', err);
    A.loading = false; stop();
    const name = err?.name || '';
    if (name === 'NotAllowedError')      setStat('Camera blocked — allow the camera for this site in the browser address bar', 'err');
    else if (name === 'NotFoundError')   setStat('No camera found — plug one in and try again', 'err');
    else if (name === 'NotReadableError')setStat('Camera is busy in another app — close it and try again', 'err');
    else if (/import|fetch|network|wasm/i.test(String(err))) setStat('Could not download the hand tracker — check the internet connection', 'err');
    else setStat('Air Band failed: ' + (err?.message || err), 'err');
  }
}

// Create / resume the Web Audio graph. Browsers only allow this after a user gesture;
// the Camera click is one, and any later click / key press unblocks it too.
function wakeAudio() {
  try { ensureCtx(); if (S.ctx.state === 'suspended') S.ctx.resume(); } catch (e) { console.warn('audio', e); }
}
function audioRunning() { return !!S.ctx && S.ctx.state === 'running'; }
function checkAudio() {
  if (audioRunning()) { if (A.audioWarned) { A.audioWarned = false; setStat('Tracking — strike down for drums, hold an open hand for notes', 'ok'); } return; }
  if (A.audioWarned) return;
  A.audioWarned = true;
  setStat('No sound yet — click anywhere on the page (or press a key) to unblock audio', 'warn');
  const once = () => { wakeAudio(); document.removeEventListener('pointerdown', once); document.removeEventListener('keydown', once); };
  document.addEventListener('pointerdown', once); document.addEventListener('keydown', once);
}

function stop() {
  cancelAnimationFrame(A.raf); A.raf = 0;
  releaseAll();
  A.trackers = []; A.handsNow = 0; A.fps = 0; A.lastHit = null; A.audioWarned = false; A.bench = null;
  if (A.stream) { A.stream.getTracks().forEach(t => t.stop()); A.stream = null; }
  const v = $('airVideo'); if (v) v.srcObject = null;
  const wasOn = A.on; A.on = false; A.loading = false;
  setBtn(false, '🎥 Camera');
  setStat('Click Camera to play drums & keys in the air · needs the browser's graphics acceleration ON (see ? help)');
  if (wasOn) setStatus('Air Band off');
  draw();
}

// Release every held note (layout change, stop, mirror flip…)
function releaseAll() {
  for (const id of Object.keys(A.heldNote)) { try { noteOff(A.heldNote[id]); } catch (_) {} delete A.heldNote[id]; }
  A.trackers.forEach(t => t.tr.lost());
}

// ── Frame loop ────────────────────────────────────────────────────────────────
function loop() {
  if (!A.on) return;
  const video = $('airVideo');
  if (video && video.readyState >= 2 && video.currentTime !== A.lastVideoT) {
    A.lastVideoT = video.currentTime;
    const now = performance.now();
    let res = null;
    try {
      A.det.getContext('2d').drawImage(video, 0, 0, A.det.width, A.det.height);
      res = A.landmarker.detectForVideo(A.det, now);
    } catch (e) { console.warn('detect', e); }
    if (res) {
      const hands = (res.landmarks || []).map((lm, i) => ({ label: res.handedness?.[i]?.[0]?.categoryName || ('H' + i), landmarks: lm }));
      const dtS = A.lastFrameT ? Math.min(0.5, (now - A.lastFrameT) / 1000) : 0.033;
      A.lastFrameT = now;
      processHands(hands, now, dtS);
    }
    A.frames++;
    if (now - A.fpsT >= 1000) { A.fps = Math.round(A.frames * 1000 / (now - A.fpsT)); A.frames = 0; A.fpsT = now; checkAudio(); autoDelegate(now); }
  }
  draw();
  A.raf = requestAnimationFrame(loop);
}

// Turn one frame of detected hands into sounds. Exposed for tests via window.__airband.feed.
function processHands(hands, tMs, dtS = 0.033) {
  refreshLabels();
  const m = A.mapping;
  A.handsNow = hands.length;
  const lms = hands.map(h => (A.mirror ? mirrorLandmarks(h.landmarks) : h.landmarks));
  // a fast chop moves far between frames — allow a bigger jump the longer the frame gap
  const maxJump = Math.min(1.2, 0.2 + 4 * dtS);
  const match = matchHands(A.trackers.map(t => t.tr.palm), lms.map(palmCenter), maxJump);
  const next = [], used = new Set();
  lms.forEach((lm, j) => {
    let t;
    if (match[j] >= 0) { t = A.trackers[match[j]]; used.add(match[j]); }
    else t = { id: ++A.seq, tr: new HandTracker({ threshold: sensToThreshold(A.sens) }) };
    t.label = hands[j].label || ''; t.lastSeen = tMs;
    apply(t.id, t.tr.update(m, lm, tMs), tMs);
    next.push(t);
  });
  A.trackers.forEach((t, i) => {
    if (used.has(i)) return;
    if (tMs - t.lastSeen <= GRACE_MS) next.push(t);          // blurred / dropped for a frame: keep it
    else apply(t.id, t.tr.lost(), tMs);
  });
  A.trackers = next;
}

function apply(label, events, tMs) {
  for (const ev of events) {
    const cell = A.mapping.cells[ev.zone];
    if (ev.type === 'hit' && cell?.t === 'd') {
      hitDrum(DRUMS[cell.i], ev.vel);
      A.flash[ev.zone] = performance.now() + 160; blink();     // wall clock: draw() compares against performance.now()
      A.lastHit = { name: DRUMS[cell.i].name, vel: ev.vel, t: performance.now() };
      pushLog({ type: 'hit', zone: ev.zone, name: DRUMS[cell.i].name, vel: ev.vel, t: tMs });
    } else if (ev.type === 'hold' && cell?.t === 'n') {
      if (A.heldNote[label]) { noteOff(A.heldNote[label]); delete A.heldNote[label]; }
      const midi = degreeToMidi(cell.deg, S.scaleRoot, S.scaleName);
      const n = midiNoteObj(midi, HOLD_VEL); n.uid = 'air_' + label + '_' + midi;
      A.heldNote[label] = n; noteOn(n); blink();
      A.lastHit = { name: NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1), vel: HOLD_VEL, t: performance.now() };
      pushLog({ type: 'hold', zone: ev.zone, midi, t: tMs });
    } else if (ev.type === 'release') {
      if (A.heldNote[label]) { noteOff(A.heldNote[label]); delete A.heldNote[label]; }
      pushLog({ type: 'release', zone: ev.zone, t: tMs });
    }
  }
}
function pushLog(e) { A.log.push(e); if (A.log.length > 200) A.log.shift(); }

let blinkT = 0;
function blink() {
  const dot = $('airDot'); if (!dot) return;
  dot.classList.add('hit'); clearTimeout(blinkT); blinkT = setTimeout(() => dot.classList.remove('hit'), 90);
}

// ── Overlay drawing ───────────────────────────────────────────────────────────
function draw() {
  const c = $('airCanvas'); if (!c) return;
  const g = c.getContext('2d'), W = c.width, H = c.height, m = A.mapping, now = performance.now();
  g.clearRect(0, 0, W, H);
  if (!A.on) { g.fillStyle = '#0b0b0e'; g.fillRect(0, 0, W, H); }
  const heldZones = new Set(A.trackers.map(t => t.tr.held).filter(z => z >= 0));
  const ar = m.area || DEFAULT_AREA, ax = ar.x * W, ay = ar.y * H, aw = ar.w * W, ah = ar.h * H;
  // outside the kit area: dimmed (hands there play nothing)
  g.fillStyle = 'rgba(0,0,0,.42)';
  g.fillRect(0, 0, W, ay); g.fillRect(0, ay + ah, W, H - ay - ah); g.fillRect(0, ay, ax, ah); g.fillRect(ax + aw, ay, W - ax - aw, ah);
  const font = Math.round(Math.min(W / m.cols, H / m.rows) * 0.16);
  g.lineWidth = Math.max(1, W / 640);
  for (let i = 0; i < m.cells.length; i++) {
    const r = zoneRect(m, i), x = r.x * W, y = r.y * H, w = r.w * W, h = r.h * H, cell = m.cells[i];
    const fl = A.flash[i] && A.flash[i] > now ? (A.flash[i] - now) / 160 : 0;
    if (fl > 0)               { g.fillStyle = `rgba(251,191,36,${0.45 * fl})`; g.fillRect(x, y, w, h); }
    else if (heldZones.has(i)){ g.fillStyle = 'rgba(74,222,128,.28)';        g.fillRect(x, y, w, h); }
    else if (cell)            { g.fillStyle = cell.t === 'd' ? 'rgba(251,191,36,.06)' : 'rgba(74,222,128,.06)'; g.fillRect(x, y, w, h); }
    g.strokeStyle = 'rgba(140,255,255,.35)'; g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.font = `700 ${font}px 'Segoe UI',system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = cell ? (cell.t === 'd' ? 'rgba(251,191,36,.95)' : 'rgba(74,222,128,.95)') : 'rgba(112,112,120,.6)';
    g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 4;
    g.fillText(cellLabel(cell), x + w / 2, y + h / 2);
    g.shadowBlur = 0;
  }
  // hands
  for (const { tr } of A.trackers) {
    if (!tr.lm) continue;
    g.strokeStyle = 'rgba(140,255,255,.5)'; g.lineWidth = Math.max(1, W / 520);
    g.beginPath();
    for (const [a, b] of HAND_BONES) { g.moveTo(tr.lm[a].x * W, tr.lm[a].y * H); g.lineTo(tr.lm[b].x * W, tr.lm[b].y * H); }
    g.stroke();
    g.fillStyle = 'rgba(140,255,255,.7)';
    for (const p of tr.lm) { g.beginPath(); g.arc(p.x * W, p.y * H, Math.max(1.5, W / 320), 0, Math.PI * 2); g.fill(); }
    if (tr.palm) {
      g.fillStyle = tr.open ? '#4ade80' : '#fbbf24';
      g.beginPath(); g.arc(tr.palm.x * W, tr.palm.y * H, Math.max(5, W / 90), 0, Math.PI * 2); g.fill();
    }
  }
  // kit area frame + corner handles + hint
  g.setLineDash([6, 4]); g.strokeStyle = 'rgba(140,255,255,.8)'; g.lineWidth = Math.max(1.5, W / 400);
  g.strokeRect(ax + 0.5, ay + 0.5, aw - 1, ah - 1); g.setLineDash([]);
  const hs = Math.max(6, W / 70);
  g.fillStyle = '#8cffff';
  for (const [hx, hy] of [[ax, ay], [ax + aw, ay], [ax, ay + ah], [ax + aw, ay + ah]]) g.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
  g.font = `600 ${Math.round(W / 52)}px 'Segoe UI',system-ui,sans-serif`; g.textAlign = 'right'; g.textBaseline = 'bottom';
  g.fillStyle = 'rgba(140,255,255,.75)'; g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 3;
  g.fillText('kit area · drag to move · corners resize · double-click resets', ax + aw - hs, ay - 3 < 12 ? ay + ah + Math.round(W / 40) : ay - 3);
  g.shadowBlur = 0;
  // strike meters: one bar on the right edge of the zone each hand is in. It fills
  // downward with the hand's speed; reaching the white tick = a hit fires.
  A.trackers.forEach(({ tr }, k) => {
    if (!tr.palm || tr.zone < 0) return;
    const cell = m.cells[tr.zone]; if (!cell || cell.t !== 'd') return;
    const r = zoneRect(m, tr.zone), pad = Math.max(4, W / 160), bw = Math.max(6, W / 90);
    const x0 = (r.x + r.w) * W - pad - bw - k * (bw + 3), y0 = r.y * H + pad, bh = r.h * H - 2 * pad, tick = y0 + bh * 0.7;
    const ratio = Math.max(0, Math.min(1.4, tr.strike.vy / tr.strike.threshold));
    g.fillStyle = 'rgba(0,0,0,.5)'; g.fillRect(x0 - 1, y0 - 1, bw + 2, bh + 2);
    g.fillStyle = ratio >= 1 ? '#fbbf24' : 'rgba(140,255,255,.9)';
    g.fillRect(x0, y0, bw, bh * 0.7 * ratio);
    g.fillStyle = '#fff'; g.fillRect(x0 - 2, tick - 1, bw + 4, 2);
  });
  // corner read-out
  g.font = `600 ${Math.round(W / 46)}px 'Segoe UI',system-ui,sans-serif`; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillStyle = 'rgba(210,210,216,.85)'; g.shadowColor = 'rgba(0,0,0,.9)'; g.shadowBlur = 4;
  if (A.on) {
    const hit = A.lastHit && now - A.lastHit.t < 2500 ? ` · ${A.lastHit.name} ${Math.round(A.lastHit.vel * 100)}%` : '';
    g.fillText(`${A.fps} fps ${A.delegate.toLowerCase()} · ${A.handsNow} hand${A.handsNow === 1 ? '' : 's'}${hit}`, 8, 6);
    if (!audioRunning()) { g.fillStyle = '#fbbf24'; g.fillText('🔇 click the page to unblock sound', 8, 6 + Math.round(W / 36)); }
  }
  else if (!A.loading) { g.textAlign = 'center'; g.textBaseline = 'middle'; g.font = `600 ${Math.round(W / 30)}px 'Segoe UI',system-ui,sans-serif`; g.fillStyle = 'rgba(210,210,216,.7)'; g.fillText('🎥 Camera off — click Camera', W / 2, H / 2); }
  g.shadowBlur = 0;
}

// HandTracker keeps its last landmarks for drawing
const _update = HandTracker.prototype.update;
HandTracker.prototype.update = function (m, lm, t) { this.lm = lm; return _update.call(this, m, lm, t); };
const _lost = HandTracker.prototype.lost;
HandTracker.prototype.lost = function () { this.lm = null; this.palm = null; return _lost.call(this); };

// ── Init ──────────────────────────────────────────────────────────────────────
export function initAirBand() {
  restore();
  const p = $('airPreset');
  if (p) { p.innerHTML = ''; Object.entries(PRESETS).forEach(([k, v]) => p.appendChild(new Option(v.label, k))); p.appendChild(new Option('Custom', 'custom')); }
  const gsel = $('airGrid');
  if (gsel) { gsel.innerHTML = ''; Object.keys(GRID_SIZES).forEach(k => gsel.appendChild(new Option(k.replace('x', '×'), k))); }
  buildZoneEditor(); syncControls(); initAreaEditor(); draw();
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && A.big) toggleAirBig(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });
  // test / automation hook
  window.__airband = { A, feed: (hands, t, dt) => processHands(hands, t ?? performance.now(), dt ?? 0.033), mapping: () => A.mapping, draw };
}
