// ── Expression lane (the red dynamics curve under the piano roll) ─────────────
// The thing that makes an orchestral mockup sound alive isn't velocity per note —
// it's a continuous dynamics curve drawn under the notes, driving TIMBRE as well
// as level. This module owns that curve:
//
//   · storage      — one lane per part (roll / drums / mic) + a global lane,
//                    17 control nodes snapped to the 16-step grid, 0…1
//   · interpolation— monotone cubic Hermite between nodes (smooth, never overshoots)
//   · shapes       — swell / fall / arch / pulse-per-beat / flat
//   · scheduling   — exprRampPlan() turns a held note into N timed ramp points
//   · audio        — makeExprStage(): drive → shaper → lowpass → level, so a
//                    louder passage is also brighter and richer, not just bigger
//   · drawing      — the lane canvas + the faint curve behind the roll's notes
//   · MIDI         — exprCC1() → CC1 (mod wheel) events for the SMF writer
//
// Every pure function here is DOM-free and audio-free so node can unit-test it;
// the few DOM entry points bail out when there is no document.
import { S } from './state.js';

export const STEPS   = 16;              // pattern length (shared with the roll)
export const NODES   = STEPS + 1;       // control points: one per step line + the bar end
export const DEFAULT = 0.75;            // a flat lane sits at mf
export const PARTS   = ['roll', 'drums', 'mic'];
export const LANE_KEYS = [...PARTS, 'global'];

export const clamp01 = v => (typeof v === 'number' && isFinite(v) ? Math.max(0, Math.min(1, v)) : DEFAULT);

// ── Storage ───────────────────────────────────────────────────────────────────
export const blankLane = (v = DEFAULT) => new Array(NODES).fill(clamp01(v));

function freshLanes() {
  return {
    roll:   { pts: blankLane(), link: false },
    drums:  { pts: blankLane(), link: true  },
    mic:    { pts: blankLane(), link: true  },
    global: { pts: blankLane(), link: false },
  };
}

// Live state. Mirrored onto S so the project writer / other modules can read it
// without importing this file.
const E = {
  on: true,            // master switch for the whole feature
  part: 'roll',        // which lane the editor is showing
  lanes: freshLanes(),
};
S.expr = E;
S.exprLanes = E.lanes;
S.exprRampLog = [];    // debug/test hook: every ramp we scheduled (capped)

export const exprOn    = () => !!E.on;
export const exprPart  = () => E.part;
export const exprLanes = () => E.lanes;

// The curve a part actually plays: its own, or the global one when it's linked.
export function lanePts(part = 'roll') {
  const l = E.lanes[part] || E.lanes.roll;
  return (part !== 'global' && l.link) ? E.lanes.global.pts : l.pts;
}
// The curve the EDITOR should write to (a linked part edits the global lane).
export const editPts = (part = E.part) => lanePts(part);
export const isLinked = (part = E.part) => part !== 'global' && !!E.lanes[part]?.link;

// ── Interpolation: monotone cubic Hermite (Fritsch–Carlson) ───────────────────
// Smooth between the snapped nodes, and guaranteed never to overshoot — a lane
// that touches 1.0 never rings above it, a lane at 0 never dips negative.
function tangents(p) {
  const n = p.length, d = new Array(n - 1), m = new Array(n);
  for (let i = 0; i < n - 1; i++) d[i] = p[i + 1] - p[i];
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return m;
}

/** Value of the curve at `t` steps (0…16, fractional allowed). */
export function sampleCurve(pts, t) {
  if (!pts || pts.length < 2) return DEFAULT;
  const n = pts.length;
  if (!(t > 0)) return clamp01(pts[0]);
  if (t >= n - 1) return clamp01(pts[n - 1]);
  const i = Math.floor(t), s = t - i;
  const m = tangents(pts);
  const s2 = s * s, s3 = s2 * s;
  const v = (2 * s3 - 3 * s2 + 1) * pts[i] + (s3 - 2 * s2 + s) * m[i]
          + (-2 * s3 + 3 * s2) * pts[i + 1] + (s3 - s2) * m[i + 1];
  return clamp01(v);
}
export const exprAt = (pts, step) => sampleCurve(pts, step);

// ── Editing (pure) ────────────────────────────────────────────────────────────
export function setNode(pts, i, v) {
  const k = Math.max(0, Math.min(pts.length - 1, i | 0));
  pts[k] = clamp01(v);
  return pts;
}

/** Straight line from node i0 (v0) to node i1 (v1) — shift-drag and drag gap-fill. */
export function drawSegment(pts, i0, v0, i1, v1) {
  let a = Math.max(0, Math.min(pts.length - 1, i0 | 0)), b = Math.max(0, Math.min(pts.length - 1, i1 | 0));
  let va = clamp01(v0), vb = clamp01(v1);
  if (a > b) { [a, b] = [b, a]; [va, vb] = [vb, va]; }
  if (a === b) { pts[a] = vb; return pts; }
  for (let i = a; i <= b; i++) pts[i] = clamp01(va + (vb - va) * (i - a) / (b - a));
  return pts;
}

/** Double-click reset: flatten nodes i0…i1 inclusive back to `v`. */
export function resetRegion(pts, i0, i1, v = DEFAULT) {
  const a = Math.max(0, Math.min(pts.length - 1, Math.min(i0, i1) | 0));
  const b = Math.max(0, Math.min(pts.length - 1, Math.max(i0, i1) | 0));
  for (let i = a; i <= b; i++) pts[i] = clamp01(v);
  return pts;
}

/** The beat (4 steps) a node belongs to → [firstNode, lastNode]. */
export function beatRegion(node) {
  const beat = Math.max(0, Math.min(3, Math.floor(Math.max(0, Math.min(STEPS - 1, node | 0)) / 4)));
  return [beat * 4, beat * 4 + 4];
}

// ── One-click shapes ──────────────────────────────────────────────────────────
export const SHAPES = {
  swell: { label: 'Swell', fn: u => 0.15 + 0.85 * u },
  fall:  { label: 'Fall',  fn: u => 1.00 - 0.85 * u },
  arch:  { label: 'Arch',  fn: u => 0.18 + 0.82 * Math.sin(Math.PI * u) },
  pulse: { label: 'Pulse', fn: u => { const f = (u * STEPS / 4) % 1; return 0.35 + 0.65 * Math.pow(1 - f, 1.6); } },
  flat:  { label: 'Flat',  fn: () => DEFAULT },
};

export function shapeCurve(name) {
  const sh = SHAPES[name] || SHAPES.flat;
  const out = new Array(NODES);
  for (let i = 0; i < NODES; i++) out[i] = clamp01(sh.fn(i / STEPS));
  if (name === 'pulse') out[STEPS] = 1;       // the bar line is an accent too
  return out;
}

// ── Pixel ↔ node mapping (snap to the step grid) ──────────────────────────────
/** Nearest control node for a pixel x, where the grid spans [x0, x0+w]. */
export function snapIndex(x, x0, w) {
  if (!(w > 0)) return 0;
  const t = (x - x0) / w * STEPS;
  return Math.max(0, Math.min(STEPS, Math.round(t)));
}
/** Value 0…1 for a pixel y inside a lane of height h (top = 1). */
export const valueAtY = (y, h, pad = 0) => {
  const inner = Math.max(1, h - pad * 2);
  return clamp01(1 - (y - pad) / inner);
};

// ── Playback scheduling ───────────────────────────────────────────────────────
// A held note must HEAR the curve move across its whole length, so one onset
// value is not enough: we hand the synth `lenSteps × perStep` timed ramp points.
// `perStep` 2 means a ramp every 8th-note-triplet-ish slice (≈60 ms at 120 BPM),
// smooth enough for a crescendo and cheap enough to schedule 0.1 s ahead.
export function exprRampPlan({ pts, startStep, lenSteps, onTime, stepDur, perStep = 2 }) {
  const n = Math.max(1, Math.round(lenSteps * perStep));
  const out = [];
  for (let k = 1; k <= n; k++) {
    const dt = k / perStep;                                  // in steps
    out.push({ when: onTime + dt * stepDur, value: sampleCurve(pts, startStep + dt), step: startStep + dt });
  }
  return out;
}

// ── Audio: the expression stage ───────────────────────────────────────────────
// drive → tanh shaper → lowpass → level. Pushing `drive` up adds harmonics,
// opening the lowpass lets them through, and `level` sets the loudness — so one
// 0…1 number moves loudness, brightness and harmonic content together.
const SK = 2.2;                                              // shaper knee
const F  = x => Math.tanh(SK * x) / Math.tanh(SK);
export const EXPR_DRIVE = e => 0.55 + 1.25 * clamp01(e);     // 0.55 → 1.80
export const EXPR_TARGET = e => 0.5 * (0.14 + 0.86 * clamp01(e));   // peak amplitude we want
/** Post-shaper gain that lands the voice on EXPR_TARGET (the shaper compresses). */
export const EXPR_LEVEL = e => EXPR_TARGET(e) / Math.max(0.05, F(0.5 * EXPR_DRIVE(e)));
/** Cutoff: always passes the note's own fundamental, fully open at e = 1. */
export function EXPR_CUT(e, hz = 440) {
  const lo = Math.max(900, (hz || 440) * 1.6), hi = 16000;
  if (lo >= hi) return hi;
  return lo * Math.pow(hi / lo, clamp01(e));
}

const shaperCache = new WeakMap();
function shaperCurveFor(actx) {
  let c = shaperCache.get(actx);
  if (c) return c;
  const n = 1024; c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = F(i / (n - 1) * 2 - 1);
  shaperCache.set(actx, c);
  return c;
}

/**
 * Per-voice expression chain. Feed the voice into `.input`, call `.ramp(v, when)`
 * to move expression while it sustains. Used as the fallback when synth.js has
 * no setExpr yet — the two are interchangeable from the sequencer's point of view.
 */
export function makeExprStage(actx, dest, e0, when, { hz = 440, until = null, live = true } = {}) {
  const pre = actx.createGain();
  const sh  = actx.createWaveShaper();
  const lp  = actx.createBiquadFilter();
  const out = actx.createGain();
  sh.curve = shaperCurveFor(actx);
  try { sh.oversample = '2x'; } catch (_) {}
  lp.type = 'lowpass'; lp.Q.value = 0.7;
  pre.connect(sh); sh.connect(lp); lp.connect(out); out.connect(dest);
  const e = clamp01(e0);
  pre.gain.setValueAtTime(EXPR_DRIVE(e), when);
  lp.frequency.setValueAtTime(EXPR_CUT(e, hz), when);
  out.gain.setValueAtTime(EXPR_LEVEL(e), when);
  if (live && until != null) {
    const ms = Math.max(0, (until - actx.currentTime)) * 1000 + 300;
    setTimeout(() => { try { out.disconnect(); } catch (_) {} }, Math.min(ms, 120000));
  }
  return {
    input: pre,
    ramp(v, t) {
      const x = clamp01(v);
      pre.gain.linearRampToValueAtTime(EXPR_DRIVE(x), t);
      lp.frequency.exponentialRampToValueAtTime(Math.max(40, EXPR_CUT(x, hz)), t);
      out.gain.linearRampToValueAtTime(Math.max(0.0001, EXPR_LEVEL(x)), t);
    },
  };
}

/**
 * Spawn one voice that can be expressed. Prefers the synth's own API
 *   spawnVoice(hz, { …, expr, seat }) -> voiceId   +   setExpr(voiceId, v, when)
 * and falls back to wrapping the existing spawnVoice in an expression stage, so
 * this module works whether or not the synth side has landed yet.
 */
export function exprVoice(synth, hz, { when, gate, vel = 1, expr = DEFAULT, seat = 0, actx, dest, live = true }) {
  if (typeof synth?.setExpr === 'function') {
    const id = synth.spawnVoice(hz, { when, gate, vel, expr, seat, actx, dest });
    if (id != null && id !== false) {
      S.exprNative = true;                       // the synth's own expression API is driving it
      return { ramp: (v, t) => synth.setExpr(id, clamp01(v), t), native: true };
    }
  }
  S.exprNative = false;                          // parallel-development fallback (see makeExprStage)
  const stage = makeExprStage(actx, dest, expr, when, { hz, until: when + gate + 2, live });
  synth.spawnVoice(hz, { when, gate, vel, actx, dest: stage.input });
  return { ramp: stage.ramp, native: false };
}

/** Record a scheduled ramp so page tests can prove the synth really heard it. */
export function logRamp(part, p) {
  const log = S.exprRampLog;
  log.push({ part, value: +p.value.toFixed(4), when: +p.when.toFixed(4), step: +p.step.toFixed(3) });
  if (log.length > 4000) log.splice(0, log.length - 2000);
}

// ── MIDI: CC1 (mod wheel) ─────────────────────────────────────────────────────
/**
 * CC1 events for one bar of the lane. `stepTicks` = ticks per 16th, `per` = points
 * per step. Consecutive duplicates are dropped so the file stays small.
 */
export function exprCC1(pts, { stepTicks = 120, per = 2, steps = STEPS, baseTick = 0 } = {}) {
  const out = [];
  let last = -1;
  const n = steps * per;
  for (let k = 0; k <= n; k++) {
    const t = k / per;
    const val = Math.max(0, Math.min(127, Math.round(sampleCurve(pts, t) * 127)));
    if (val === last && k !== n) continue;
    last = val;
    out.push({ tick: Math.round(baseTick + t * stepTicks), val });
  }
  return out;
}

// ── Save / restore ────────────────────────────────────────────────────────────
const sanePts = src => {
  const out = blankLane();
  for (let i = 0; i < NODES; i++) out[i] = clamp01(Array.isArray(src) ? src[i] : undefined);
  return out;
};

/** Serialisable snapshot — the shape melodies/project store alongside the pattern. */
export function exprState() {
  const lanes = {};
  for (const k of LANE_KEYS) lanes[k] = { pts: E.lanes[k].pts.slice(), link: !!E.lanes[k].link };
  return { on: !!E.on, part: E.part, lanes };
}

export function setExprState(st) {
  if (!st || typeof st !== 'object') return false;
  if (typeof st.on === 'boolean') E.on = st.on;
  if (LANE_KEYS.includes(st.part)) E.part = st.part;
  const src = st.lanes || {};
  for (const k of LANE_KEYS) {
    const l = src[k];
    E.lanes[k].pts  = sanePts(l?.pts ?? (Array.isArray(l) ? l : undefined));
    E.lanes[k].link = k === 'global' ? false : !!l?.link;
  }
  S.exprLanes = E.lanes;
  saveLocal();
  syncExprUI();
  drawExprLane();
  return true;
}

export function clearExpr() {
  E.lanes = freshLanes();
  S.exprLanes = E.lanes;
  saveLocal(); syncExprUI(); drawExprLane();
}

// ── Local autosave (so a reload keeps the curve even before project.js wires in) ─
const LS_KEY = 'wp.looper.expr';
function saveLocal() {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(LS_KEY, JSON.stringify(exprState())); } catch (_) {}
}
function loadLocal() {
  if (typeof localStorage === 'undefined') return;
  try { const raw = localStorage.getItem(LS_KEY); if (raw) setExprStateQuiet(JSON.parse(raw)); } catch (_) {}
}
function setExprStateQuiet(st) {
  if (!st || typeof st !== 'object') return;
  if (typeof st.on === 'boolean') E.on = st.on;
  if (LANE_KEYS.includes(st.part)) E.part = st.part;
  const src = st.lanes || {};
  for (const k of LANE_KEYS) {
    const l = src[k];
    E.lanes[k].pts  = sanePts(l?.pts);
    E.lanes[k].link = k === 'global' ? false : !!l?.link;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DOM side — the lane editor. Everything below no-ops without a document, so
// node can import this module for the pure tests.
// ═════════════════════════════════════════════════════════════════════════════
const hasDOM = () => typeof document !== 'undefined' && !!document.getElementById;
const el = id => (hasDOM() ? document.getElementById(id) : null);
function status(msg) { const s = el('statusMsg'); if (s) s.textContent = msg; }

const PAD_T = 8, PAD_B = 8;          // vertical padding inside the lane plot
const LANE_H = 74;                   // lane height in CSS px (canvas logical height)
const GUT   = 46;                    // label gutter — matches the roll's row-label column

// Pixel geometry of the roll's step columns, so the lane lines up with the grid.
function rollGeom() {
  const roll = el('pianoRoll');
  const c0 = S.pseqCells?.[0]?.[0];
  if (roll && c0 && c0.offsetWidth) {
    const cw = c0.offsetWidth;
    const c1 = S.pseqCells[0][1];
    const pitch = c1 ? (c1.offsetLeft - c0.offsetLeft) : cw + 1;
    return { x0: c0.offsetLeft, pitch, w: pitch * STEPS - (pitch - cw), total: roll.offsetWidth || GUT + pitch * STEPS };
  }
  const pitch = 23;
  return { x0: GUT + 1, pitch, w: pitch * STEPS - 1, total: GUT + pitch * STEPS };
}

export function drawExprLane() {
  if (!hasDOM()) return;
  const cv = el('exprCanvas');
  if (!cv || !cv.getContext) return;
  const g = rollGeom();
  const cssW = Math.max(220, g.total);
  const cssH = LANE_H;
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  cv.style.width = cssW + 'px';
  cv.style.height = cssH + 'px';
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr);
  }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cssW, cssH);

  const x0 = g.x0, w = g.w, h = cssH, innerH = h - PAD_T - PAD_B;
  const yOf = v => PAD_T + (1 - clamp01(v)) * innerH;
  const xOf = t => x0 + (t / STEPS) * w;

  // plot bed
  c.fillStyle = '#0c0c11';
  c.fillRect(x0 - 1, 0, w + 2, h);

  // horizontal guides (0 / ¼ / ½ / ¾ / 1) + gutter labels
  c.font = '8px "Segoe UI",system-ui,sans-serif';
  c.textAlign = 'right'; c.textBaseline = 'middle';
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    const y = yOf(v);
    const mid = v === 0.5;
    c.strokeStyle = mid ? 'rgba(120,120,140,.34)' : 'rgba(90,90,110,.18)';
    c.lineWidth = 1;
    c.beginPath(); c.moveTo(x0, y + 0.5); c.lineTo(x0 + w, y + 0.5); c.stroke();
    if (v === 0 || v === 0.5 || v === 1) {
      c.fillStyle = '#707078';
      c.fillText(v === 1 ? 'ff' : v === 0.5 ? 'mf' : 'pp', x0 - 6, y);
    }
  }
  // vertical step lines, beats brighter
  for (let s = 0; s <= STEPS; s++) {
    const x = Math.round(xOf(s)) + 0.5;
    const beat = s % 4 === 0;
    c.strokeStyle = beat ? 'rgba(130,130,155,.42)' : 'rgba(80,80,100,.18)';
    c.beginPath(); c.moveTo(x, 1); c.lineTo(x, h - 1); c.stroke();
    if (beat && s < STEPS) {
      c.fillStyle = '#4a4a56'; c.textAlign = 'left';
      c.fillText(String(s / 4 + 1), x + 3, PAD_T + 4);
      c.textAlign = 'right';
    }
  }

  const pts = editPts();
  const linked = isLinked();

  // curve: filled area + stroke (the red dynamics line from the reference mockups)
  const path = new Path2D();
  const N = Math.max(64, w | 0);
  for (let i = 0; i <= N; i++) {
    const t = i / N * STEPS, x = xOf(t), y = yOf(sampleCurve(pts, t));
    i === 0 ? path.moveTo(x, y) : path.lineTo(x, y);
  }
  const fill = new Path2D(path);
  fill.lineTo(xOf(STEPS), h - PAD_B); fill.lineTo(xOf(0), h - PAD_B); fill.closePath();
  const grad = c.createLinearGradient(0, PAD_T, 0, h - PAD_B);
  grad.addColorStop(0, linked ? 'rgba(251,191,36,.30)' : 'rgba(248,113,113,.32)');
  grad.addColorStop(1, linked ? 'rgba(251,191,36,.03)' : 'rgba(248,113,113,.03)');
  c.fillStyle = grad; c.fill(fill);
  c.strokeStyle = linked ? '#fbbf24' : '#f87171';
  c.lineWidth = 2; c.lineJoin = 'round';
  c.stroke(path);

  // the snapped control nodes, so it's obvious the curve is editable
  c.fillStyle = linked ? '#fbbf24' : '#f87171';
  for (let i = 0; i <= STEPS; i++) {
    const x = xOf(i), y = yOf(pts[i]);
    c.beginPath(); c.arc(x, y, i % 4 === 0 ? 2.6 : 1.7, 0, Math.PI * 2); c.fill();
  }

  // playhead
  if (S.pseqPlaying && S.ctx && S.seqAnchor != null) {
    const stepDur = (60 / S.bpm) / 4;
    const t = ((Math.max(0, S.ctx.currentTime - S.seqAnchor) / stepDur) % STEPS);
    const x = xOf(t);
    c.strokeStyle = 'rgba(34,197,94,.85)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke();
    const rd = el('exprVal');
    if (rd) rd.textContent = sampleCurve(pts, t).toFixed(2);
  }

  drawRollExprBg();
}

// ── The faint curve behind the roll's notes ───────────────────────────────────
// Same curve, drawn across the pitch grid, so dynamics read against pitch exactly
// like the reference screencasts. Overlay canvas, pointer-events: none.
function ensureRollBg() {
  const roll = el('pianoRoll');
  if (!roll) return null;
  let cv = el('rollExprBg');
  if (!cv) {
    cv = document.createElement('canvas');
    cv.id = 'rollExprBg';
    roll.style.position = 'relative';
    roll.appendChild(cv);
  }
  return cv;
}

export function drawRollExprBg() {
  if (!hasDOM()) return;
  const roll = el('pianoRoll');
  const cv = ensureRollBg();
  if (!roll || !cv || !cv.getContext) return;
  const g = rollGeom();
  const h = roll.clientHeight || roll.offsetHeight;
  if (!h || !g.w) return;
  const dpr = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  cv.style.left = g.x0 + 'px';
  cv.style.width = g.w + 'px';
  cv.style.height = h + 'px';
  if (cv.width !== Math.round(g.w * dpr) || cv.height !== Math.round(h * dpr)) {
    cv.width = Math.round(g.w * dpr); cv.height = Math.round(h * dpr);
  }
  const c = cv.getContext('2d');
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, g.w, h);
  if (!E.on) return;
  const pts = lanePts('roll');
  const N = Math.max(48, g.w | 0);
  const path = new Path2D();
  for (let i = 0; i <= N; i++) {
    const t = i / N * STEPS, x = t / STEPS * g.w, y = (1 - sampleCurve(pts, t)) * (h - 4) + 2;
    i === 0 ? path.moveTo(x, y) : path.lineTo(x, y);
  }
  c.strokeStyle = 'rgba(248,113,113,.30)';   // faint: readable against the grid, never louder than the notes
  c.lineWidth = 1.5; c.lineJoin = 'round';
  c.stroke(path);
}

// ── Pointer editing ───────────────────────────────────────────────────────────
let drag = null;        // { shift, anchorI, anchorV, lastI, lastV }

function laneHit(ev) {
  const cv = el('exprCanvas'); if (!cv) return null;
  const r = cv.getBoundingClientRect();
  const g = rollGeom();
  const sx = g.total / (r.width  || g.total);                   // CSS-scaled canvases
  const sy = LANE_H  / (r.height || LANE_H);
  const i = snapIndex((ev.clientX - r.left) * sx, g.x0, g.w);
  const v = valueAtY((ev.clientY - r.top) * sy, LANE_H, PAD_T);
  return { i, v };
}

function applyDrag(hit, shift) {
  const pts = editPts();
  if (shift) {
    if (drag.base) for (let i = 0; i < NODES; i++) pts[i] = drag.base[i];   // redraw from the snapshot
    drawSegment(pts, drag.anchorI, drag.anchorV, hit.i, hit.v);
  } else {
    setNode(pts, hit.i, hit.v);
    if (drag.lastI != null && Math.abs(hit.i - drag.lastI) > 1) drawSegment(pts, drag.lastI, drag.lastV, hit.i, hit.v);
  }
  drag.lastI = hit.i; drag.lastV = hit.v;
  const rd = el('exprVal'); if (rd) rd.textContent = hit.v.toFixed(2);
  drawExprLane();
}

export function initExpr() {
  if (!hasDOM()) return;
  loadLocal();
  const cv = el('exprCanvas');
  if (cv) {
    cv.addEventListener('pointerdown', ev => {
      ev.preventDefault();
      if (ev.detail >= 2) return;                   // dblclick handles its own thing
      const hit = laneHit(ev); if (!hit) return;
      drag = { shift: ev.shiftKey, anchorI: hit.i, anchorV: hit.v, lastI: null, lastV: null, base: editPts().slice() };
      try { cv.setPointerCapture(ev.pointerId); } catch (_) {}
      applyDrag(hit, false);
      if (ev.shiftKey) status('Shift-drag: straight line from step ' + hit.i);
    });
    cv.addEventListener('pointermove', ev => {
      if (!drag) {
        const hit = laneHit(ev); const rd = el('exprVal');
        if (hit && rd && !S.pseqPlaying) rd.textContent = hit.v.toFixed(2);
        return;
      }
      const hit = laneHit(ev); if (!hit) return;
      applyDrag(hit, drag.shift || ev.shiftKey);
    });
    const end = () => {
      if (!drag) return;
      drag = null;
      saveLocal();
      status('Expression: ' + laneLabel() + ' curve updated');
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => { if (drag) { drag = null; saveLocal(); } });
    cv.addEventListener('dblclick', ev => {
      ev.preventDefault();
      const hit = laneHit(ev); if (!hit) return;
      const [a, b] = beatRegion(hit.i);
      resetRegion(editPts(), a, b, DEFAULT);
      drag = null; saveLocal(); drawExprLane();
      status(`Expression: beat ${Math.floor(a / 4) + 1} reset to mf`);
    });
    cv.addEventListener('contextmenu', ev => ev.preventDefault());
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', () => drawExprLane());
    // Test / automation hook: the lane state + every ramp we actually scheduled.
    window.__expr = {
      state: exprState, setState: setExprState, lanePts, sampleCurve, shapeCurve,
      ramps: () => S.exprRampLog, clearRamps: () => { S.exprRampLog.length = 0; },
      setLane: (part, pts) => { E.lanes[part].pts = sanePts(pts); E.lanes[part].link = false; saveLocal(); syncExprUI(); drawExprLane(); },
      shape: applyExprShape, part: setExprPart, on: () => E.on, toggle: toggleExpr,
    };
  }
  syncExprUI();
  drawExprLane();
}

const laneLabel = () => (isLinked() ? 'Global (' + E.part + ' follows it)' : E.part === 'global' ? 'Global' : E.part);

export function syncExprUI() {
  if (!hasDOM()) return;
  const wrap = el('exprLane');
  if (wrap) wrap.classList.toggle('expr-off', !E.on);
  const b = el('exprOnBtn');
  if (b) { b.classList.toggle('on', !!E.on); b.textContent = E.on ? 'On' : 'Off'; }
  document.querySelectorAll('.expr-tab').forEach(t => t.classList.toggle('on', t.dataset.part === E.part));
  const chk = el('exprLinkChk');
  if (chk) { chk.checked = isLinked(); chk.disabled = E.part === 'global'; }
  const lw = el('exprLinkWrap');
  if (lw) lw.style.visibility = E.part === 'global' ? 'hidden' : '';
  const nm = el('exprLaneName');
  if (nm) nm.textContent = laneLabel();
}

// ── Public UI actions (wired from looper.html) ────────────────────────────────
export function toggleExpr() {
  E.on = !E.on;
  saveLocal(); syncExprUI(); drawExprLane();
  status(E.on ? 'Expression on — the curve drives level, brightness and harmonics'
              : 'Expression off — notes play at a flat dynamic');
}

export function setExprPart(part) {
  if (!LANE_KEYS.includes(part)) return;
  E.part = part;
  saveLocal(); syncExprUI(); drawExprLane();
  status('Expression lane: ' + laneLabel());
}

export function toggleExprLink() {
  if (E.part === 'global') return;
  const l = E.lanes[E.part];
  l.link = !l.link;
  if (!l.link) l.pts = E.lanes.global.pts.slice();     // unlink keeps what you were hearing
  saveLocal(); syncExprUI(); drawExprLane();
  status(l.link ? `${E.part} follows the Global curve` : `${E.part} has its own curve now`);
}

export function applyExprShape(name) {
  const pts = shapeCurve(name);
  const tgt = editPts();
  for (let i = 0; i < NODES; i++) tgt[i] = pts[i];
  saveLocal(); drawExprLane();
  status(`Expression: ${(SHAPES[name] || SHAPES.flat).label} drawn on the ${laneLabel()} lane`);
}
