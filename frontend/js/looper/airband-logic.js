// ── Air Band: pure logic (no DOM, no camera) ─────────────────────────────────
// The camera view is split into a grid of ZONES. Every zone is assigned a sound:
//   { t: 'd', i }   → drum pad i (index into drums.DRUMS)
//   { t: 'n', deg } → scale degree `deg` above the root (0 = root, 7 = octave in a
//                     7-note scale); pitched through the current Scale Lock
//   null            → silent zone
// The grid sits inside the KIT AREA, a rectangle of the camera view (normalised x,y,w,h)
// the user drags into place — like a kit in front of you. Hands outside it play nothing.
// Drums fire on a STRIKE: a fast downward flick of the fingers/knuckles, measured in
// hand-lengths per second, so a wrist flick counts and distance from the camera doesn't.
// Notes HOLD while an open hand sits in the zone and release when it closes/leaves.
// airband.js owns the camera + drawing; everything here is unit-testable in node.

import { SCALES } from './scale.js';

// MediaPipe hand landmark indices
export const LM = { WRIST: 0, THUMB_TIP: 4, INDEX_MCP: 5, INDEX_PIP: 6, INDEX_TIP: 8,
  MIDDLE_MCP: 9, MIDDLE_PIP: 10, MIDDLE_TIP: 12, RING_MCP: 13, RING_PIP: 14, RING_TIP: 16,
  PINKY_MCP: 17, PINKY_PIP: 18, PINKY_TIP: 20 };

// Skeleton connections (for drawing)
export const HAND_BONES = [
  [0,1],[1,2],[2,3],[3,4], [0,5],[5,6],[6,7],[7,8], [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16], [13,17],[17,18],[18,19],[19,20], [0,17],
];

// ── Grid sizes + presets ──────────────────────────────────────────────────────
export const GRID_SIZES = { '1x4': [1, 4], '1x8': [1, 8], '2x2': [2, 2], '2x4': [2, 4], '3x4': [3, 4] };

export const DEFAULT_AREA = { x: 0, y: 0.45, w: 1, h: 0.55 };
const D = i => ({ t: 'd', i });
const N = deg => ({ t: 'n', deg });

// Row-major (top row first). Pad order: 0 Kick 1 Snare 2 HiHat 3 Open 4 Clap 5 Tom 6 808 7 Perc
export const PRESETS = {
  drums: { label: 'Drum kit', grid: '2x4',
    cells: [D(2), D(3), D(4), D(7),        // top (cymbals): HiHat Open Clap Perc
            D(1), D(0), D(6), D(5)] },     // bottom: Snare Kick 808 Tom — like a kit from the drummer's seat
  keys:  { label: 'Keys (8 notes)', grid: '1x8',
    cells: [N(0), N(1), N(2), N(3), N(4), N(5), N(6), N(7)] },
  band:  { label: 'Band (drums left · keys right)', grid: '2x4',
    cells: [D(2), D(4), N(4), N(7),        // top: HiHat Clap · 5th octave
            D(0), D(1), N(0), N(2)] },     // bottom: Kick Snare · root 3rd
  chords:{ label: 'Chord tones', grid: '2x2',
    cells: [N(4), N(7),
            N(0), N(2)] },
};

export function presetMapping(name, area = DEFAULT_AREA) {
  const p = PRESETS[name] || PRESETS.drums;
  const [rows, cols] = GRID_SIZES[p.grid];
  return { grid: p.grid, rows, cols, cells: p.cells.map(c => c ? { ...c } : null), area: normArea(area) };
}

// Clamp a kit area into the frame with a sane minimum size.
export function normArea(a) {
  const n = v => (typeof v === 'number' && isFinite(v) ? v : NaN);
  let { x, y, w, h } = a || {};
  x = n(x); y = n(y); w = n(w); h = n(h);
  if ([x, y, w, h].some(isNaN)) return { ...DEFAULT_AREA };
  w = Math.min(1, Math.max(0.2, w)); h = Math.min(1, Math.max(0.15, h));
  x = Math.min(1 - w, Math.max(0, x)); y = Math.min(1 - h, Math.max(0, y));
  const r = v => Math.round(v * 1000) / 1000;
  return { x: r(x), y: r(y), w: r(w), h: r(h) };
}

// Change the grid size, keeping assignments by index where they still fit.
export function resizeMapping(m, grid) {
  const size = GRID_SIZES[grid]; if (!size) return m;
  const [rows, cols] = size, n = rows * cols;
  const cells = Array.from({ length: n }, (_, i) => (m.cells[i] ? { ...m.cells[i] } : null));
  return { grid, rows, cols, cells, area: normArea(m.area) };
}

// Serialise / restore (localStorage). Unknown or corrupt input → null.
export function serializeMapping(m) { return JSON.stringify({ grid: m.grid, cells: m.cells, area: m.area }); }
export function parseMapping(str) {
  try {
    const o = JSON.parse(str);
    const size = GRID_SIZES[o?.grid]; if (!size || !Array.isArray(o.cells)) return null;
    const m = { grid: o.grid, rows: size[0], cols: size[1], cells: [], area: normArea(o.area) };
    for (let i = 0; i < size[0] * size[1]; i++) {
      const c = o.cells[i];
      if (c && c.t === 'd' && Number.isInteger(c.i) && c.i >= 0 && c.i < 8) m.cells.push({ t: 'd', i: c.i });
      else if (c && c.t === 'n' && Number.isInteger(c.deg) && c.deg >= 0 && c.deg < 24) m.cells.push({ t: 'n', deg: c.deg });
      else m.cells.push(null);
    }
    return m;
  } catch (_) { return null; }
}

// ── Geometry ──────────────────────────────────────────────────────────────────
// Zone index for a normalised point (0–1, y down), or −1 outside the kit area.
export function zoneAt(m, x, y) {
  const a = m.area || DEFAULT_AREA;
  const u = (x - a.x) / a.w, v = (y - a.y) / a.h;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return -1;
  return Math.floor(v * m.rows) * m.cols + Math.floor(u * m.cols);
}
// Zone rectangle in frame coordinates (inside the kit area).
export function zoneRect(m, idx) {
  const a = m.area || DEFAULT_AREA;
  const row = Math.floor(idx / m.cols), col = idx % m.cols;
  return { x: a.x + a.w * col / m.cols, y: a.y + a.h * row / m.rows, w: a.w / m.cols, h: a.h / m.rows };
}

// Palm centre: mean of wrist + the four finger knuckles (steadier than the wrist alone).
export function palmCenter(lm) {
  const ids = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

// Strike point: mean of the four knuckles + four fingertips. It swings a full hand-length
// on a wrist flick while the palm centre barely moves — that's what makes drumming a
// flick instead of an arm movement. Works for a fist too (tips sit on the knuckles).
export function strikePoint(lm) {
  const ids = [LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let x = 0, y = 0;
  for (const i of ids) { x += lm[i].x; y += lm[i].y; }
  return { x: x / ids.length, y: y / ids.length };
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// Hand size (wrist → middle knuckle) normalises gesture thresholds against distance from the camera.
export function handSize(lm) { return Math.max(1e-4, dist(lm[LM.WRIST], lm[LM.MIDDLE_MCP])); }

// How many of index/middle/ring/pinky are extended (tip further from the wrist than its PIP joint).
export function fingersExtended(lm) {
  const w = lm[LM.WRIST];
  const pairs = [[LM.INDEX_TIP, LM.INDEX_PIP], [LM.MIDDLE_TIP, LM.MIDDLE_PIP], [LM.RING_TIP, LM.RING_PIP], [LM.PINKY_TIP, LM.PINKY_PIP]];
  let n = 0;
  for (const [tip, pip] of pairs) if (dist(lm[tip], w) > dist(lm[pip], w) * 1.08) n++;
  return n;
}
export function isOpenHand(lm) { return fingersExtended(lm) >= 3; }
export function isPinch(lm)    { return dist(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP]) < handSize(lm) * 0.35; }

// ── Strike detector (one per hand) ────────────────────────────────────────────
// Feed the strike-point y (0 top … 1 bottom) every frame, plus `unit` = hand size so
// speed is in hand-lengths per second. Speed is measured over the last ~100 ms (or the
// previous frame when the camera is slower than that), so the detector behaves the
// same at 5 fps and at 60 fps. A strike fires the moment the downward speed crosses
// `threshold` — lowest latency — and reports `refT`, the time the swing was measured
// from, so the caller can use where the hand WAS when the swing began.
// and re-arms once the hand slows below half of it, so one swing = one hit.
// Velocity 0.4–1 scales with how fast the hand came down.
export class StrikeDetector {
  constructor({ threshold = 4, cooldownMs = 140, maxVel = 14, windowMs = 100, maxGapMs = 350 } = {}) {
    Object.assign(this, { threshold, cooldownMs, maxVel, windowMs, maxGapMs });
    this.reset();
  }
  reset() { this.hist = []; this.armed = true; this.lastHit = -1e9; this.vy = 0; }
  setThreshold(t) { this.threshold = t; }
  update(y, tMs, unit = 1) {
    const h = this.hist;
    if (h.length && tMs - h[h.length - 1].t > this.maxGapMs) { h.length = 0; this.armed = true; }   // hand was gone: fresh start
    if (h.length && tMs <= h[h.length - 1].t) return null;
    h.push({ y, t: tMs });
    while (h.length > 2 && tMs - h[1].t >= this.windowMs) h.shift();   // h[0] = newest sample ≥ windowMs old
    if (h.length < 2) { this.vy = 0; return null; }
    const ref = h[0];
    const vy = (y - ref.y) / Math.max(1e-3, unit) / ((tMs - ref.t) / 1000);      // + = moving down, hand-lengths/s
    this.vy = vy;
    let hit = null;
    if (this.armed) {
      if (vy > this.threshold && tMs - this.lastHit >= this.cooldownMs) {
        this.armed = false; this.lastHit = tMs;
        const vel = Math.min(1, 0.4 + 0.6 * (vy - this.threshold) / Math.max(0.1, this.maxVel - this.threshold));
        hit = { vel: +vel.toFixed(3), peak: vy, refT: ref.t };
      }
    } else if (vy < this.threshold * 0.5) this.armed = true;
    return hit;
  }
}

// Sensitivity 0–1 → strike threshold (hand-lengths / second). 0 = needs a big whack, 1 = hair trigger.
// A relaxed wrist flick measures ≈ 6–14, slow arm drift ≈ 1–3.
export function sensToThreshold(s) { const k = Math.min(1, Math.max(0, +s || 0)); return +(6.5 - 4.5 * k).toFixed(3); }

// ── Notes ─────────────────────────────────────────────────────────────────────
// Scale degree → MIDI note. Unlocked (chromatic) plays a major scale so the zones
// always sound musical; a locked scale uses its own steps. Degree 7 of a 7-note
// scale = the octave; degrees wrap upward.
export function degreeToMidi(deg, root = 0, scaleName = 'chromatic') {
  const sc = (scaleName && scaleName !== 'chromatic' && SCALES[scaleName]) ? SCALES[scaleName] : SCALES.major;
  const n = sc.pcs.length, d = Math.max(0, deg | 0);
  return 60 + ((root % 12) + 12) % 12 + sc.pcs[d % n] + 12 * Math.floor(d / n);
}

// ── Per-hand tracker: turns landmark frames into hit / hold / release events ──
// events: { type:'hit', zone, vel } · { type:'hold', zone } · { type:'release' }
export class HandTracker {
  constructor(opts) { this.strike = new StrikeDetector(opts); this.held = -1; this.zone = -1; this.open = false; this.size = 0; this.palms = []; }
  setThreshold(t) { this.strike.setThreshold(t); }
  // lm = 21 landmarks (already mirrored if desired); returns the events for this frame
  update(mapping, lm, tMs) {
    const ev = [];
    const p = palmCenter(lm);
    const zone = zoneAt(mapping, p.x, p.y);
    const cell = zone >= 0 ? mapping.cells[zone] : null;
    this.zone = zone; this.open = isOpenHand(lm); this.palm = p;
    // smoothed hand size (2-D wrist→knuckle shrinks when the hand turns edge-on)
    const hs = handSize(lm); this.size = this.size ? this.size * 0.7 + hs * 0.3 : hs;
    this.palms.push({ t: tMs, x: p.x, y: p.y });
    while (this.palms.length > 1 && tMs - this.palms[0].t > 600) this.palms.shift();
    const hit = this.strike.update(strikePoint(lm).y, tMs, Math.max(0.03, this.size));
    if (hit) {
      // the zone is where the hand WAS when the swing began (not where the flick carried it)
      let ref = this.palms[0];
      for (const s of this.palms) if (s.t <= hit.refT) ref = s;
      const hz = zoneAt(mapping, ref.x, ref.y), hc = hz >= 0 ? mapping.cells[hz] : null;
      if (hc && hc.t === 'd') ev.push({ type: 'hit', zone: hz, vel: hit.vel });
    }
    // notes: hold while open-handed inside a note zone
    const wantHold = this.open && cell && cell.t === 'n';
    if (wantHold) {
      if (this.held !== zone) { if (this.held >= 0) ev.push({ type: 'release', zone: this.held }); ev.push({ type: 'hold', zone }); this.held = zone; }
    } else if (this.held >= 0) { ev.push({ type: 'release', zone: this.held }); this.held = -1; }
    return ev;
  }
  lost() { const ev = []; if (this.held >= 0) { ev.push({ type: 'release', zone: this.held }); this.held = -1; } this.strike.reset(); this.zone = -1; this.palms = []; this.size = 0; return ev; }
}

// Match this frame's hands to last frame's trackers by palm position (greedy
// nearest pair, max jump `maxDist`). MediaPipe's Left/Right label flickers on fast
// motion, which would reset a strike mid-swing if hands were keyed by label.
// Returns, per detected hand, the index of its previous tracker or −1 (new hand).
export function matchHands(prevPalms, palms, maxDist = 0.3) {
  const pairs = [];
  prevPalms.forEach((p, i) => { if (!p) return; palms.forEach((q, j) => pairs.push([Math.hypot(p.x - q.x, p.y - q.y), i, j])); });
  pairs.sort((a, b) => a[0] - b[0]);
  const usedP = new Set(), usedQ = new Set(), out = new Array(palms.length).fill(-1);
  for (const [d, i, j] of pairs) {
    if (d > maxDist || usedP.has(i) || usedQ.has(j)) continue;
    out[j] = i; usedP.add(i); usedQ.add(j);
  }
  return out;
}

// Mirror landmarks horizontally (selfie view): x → 1 − x.
export function mirrorLandmarks(lm) { return lm.map(p => ({ x: 1 - p.x, y: p.y, z: p.z })); }
