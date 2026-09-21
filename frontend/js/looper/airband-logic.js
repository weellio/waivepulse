// ── Air Band: pure logic (no DOM, no camera) ─────────────────────────────────
// The camera view is split into a grid of ZONES. Every zone is assigned a sound:
//   { t: 'd', i }   → drum pad i (index into drums.DRUMS)
//   { t: 'n', deg } → scale degree `deg` above the root (0 = root, 7 = octave in a
//                     7-note scale); pitched through the current Scale Lock
//   null            → silent zone
// Drums fire on a STRIKE (a fast downward hand motion that stops / reverses).
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

const D = i => ({ t: 'd', i });
const N = deg => ({ t: 'n', deg });

// Row-major (top row first). Pad order: 0 Kick 1 Snare 2 HiHat 3 Open 4 Clap 5 Tom 6 808 7 Perc
export const PRESETS = {
  drums: { label: 'Drum kit', grid: '2x4',
    cells: [D(2), D(3), D(4), D(7),        // top: HiHat Open Clap Perc
            D(0), D(1), D(5), D(6)] },     // bottom: Kick Snare Tom 808
  keys:  { label: 'Keys (8 notes)', grid: '1x8',
    cells: [N(0), N(1), N(2), N(3), N(4), N(5), N(6), N(7)] },
  band:  { label: 'Band (drums left · keys right)', grid: '2x4',
    cells: [D(2), D(4), N(4), N(7),        // top: HiHat Clap · 5th octave
            D(0), D(1), N(0), N(2)] },     // bottom: Kick Snare · root 3rd
  chords:{ label: 'Chord tones', grid: '2x2',
    cells: [N(4), N(7),
            N(0), N(2)] },
};

export function presetMapping(name) {
  const p = PRESETS[name] || PRESETS.drums;
  const [rows, cols] = GRID_SIZES[p.grid];
  return { grid: p.grid, rows, cols, cells: p.cells.map(c => c ? { ...c } : null) };
}

// Change the grid size, keeping assignments by index where they still fit.
export function resizeMapping(m, grid) {
  const size = GRID_SIZES[grid]; if (!size) return m;
  const [rows, cols] = size, n = rows * cols;
  const cells = Array.from({ length: n }, (_, i) => (m.cells[i] ? { ...m.cells[i] } : null));
  return { grid, rows, cols, cells };
}

// Serialise / restore (localStorage). Unknown or corrupt input → null.
export function serializeMapping(m) { return JSON.stringify({ grid: m.grid, cells: m.cells }); }
export function parseMapping(str) {
  try {
    const o = JSON.parse(str);
    const size = GRID_SIZES[o?.grid]; if (!size || !Array.isArray(o.cells)) return null;
    const m = { grid: o.grid, rows: size[0], cols: size[1], cells: [] };
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
// Zone index for a normalised point (0–1, y down). Points outside → clamped edge zone.
export function zoneAt(m, x, y) {
  const col = Math.min(m.cols - 1, Math.max(0, Math.floor(x * m.cols)));
  const row = Math.min(m.rows - 1, Math.max(0, Math.floor(y * m.rows)));
  return row * m.cols + col;
}
export function zoneRect(m, idx) {
  const row = Math.floor(idx / m.cols), col = idx % m.cols;
  return { x: col / m.cols, y: row / m.rows, w: 1 / m.cols, h: 1 / m.rows };
}

// Palm centre: mean of wrist + the four finger knuckles (steadier than the wrist alone).
export function palmCenter(lm) {
  const ids = [LM.WRIST, LM.INDEX_MCP, LM.MIDDLE_MCP, LM.RING_MCP, LM.PINKY_MCP];
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
// Feed the palm y (0 top … 1 bottom) every frame. A strike = the hand moved DOWN
// faster than `threshold` (frame-heights per second) and then slowed below 40% of
// its peak speed (the "hit the drum" stop). Returns {vel} on the frame the strike
// lands, else null. Velocity 0.35–1 scales with how hard the hand came down.
export class StrikeDetector {
  constructor({ threshold = 1.4, cooldownMs = 120, maxVel = 4.5 } = {}) {
    this.threshold = threshold; this.cooldownMs = cooldownMs; this.maxVel = maxVel;
    this.reset();
  }
  reset() { this.prevY = null; this.prevT = null; this.armed = false; this.peak = 0; this.lastHit = -1e9; this.vy = 0; }
  setThreshold(t) { this.threshold = t; }
  update(y, tMs) {
    if (this.prevY == null) { this.prevY = y; this.prevT = tMs; return null; }
    const dt = (tMs - this.prevT) / 1000;
    if (dt <= 0) return null;
    if (dt > 0.25) { this.prevY = y; this.prevT = tMs; this.armed = false; return null; }   // hand was lost: don't fake a strike
    const vy = (y - this.prevY) / dt;                   // + = moving down
    this.prevY = y; this.prevT = tMs; this.vy = vy;
    let hit = null;
    if (vy > this.threshold) {
      this.armed = true; this.peak = Math.max(this.peak, vy);
    } else if (this.armed && vy < this.peak * 0.4) {
      this.armed = false;
      if (tMs - this.lastHit >= this.cooldownMs) {
        this.lastHit = tMs;
        const vel = Math.min(1, 0.35 + 0.65 * (this.peak - this.threshold) / Math.max(0.1, this.maxVel - this.threshold));
        hit = { vel: +vel.toFixed(3), peak: this.peak };
      }
      this.peak = 0;
    }
    if (!this.armed) this.peak = 0;
    return hit;
  }
}

// Sensitivity 0–1 → strike threshold (frame-heights / second). 0 = needs a big whack, 1 = hair trigger.
export function sensToThreshold(s) { const k = Math.min(1, Math.max(0, +s || 0)); return +(2.2 - 1.7 * k).toFixed(3); }

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
  constructor(opts) { this.strike = new StrikeDetector(opts); this.held = -1; this.zone = -1; this.open = false; }
  setThreshold(t) { this.strike.setThreshold(t); }
  // lm = 21 landmarks (already mirrored if desired); returns the events for this frame
  update(mapping, lm, tMs) {
    const ev = [];
    const p = palmCenter(lm);
    const zone = zoneAt(mapping, p.x, p.y);
    const cell = mapping.cells[zone];
    this.zone = zone; this.open = isOpenHand(lm); this.palm = p;
    const hit = this.strike.update(p.y, tMs);
    if (hit && cell && cell.t === 'd') ev.push({ type: 'hit', zone, vel: hit.vel });
    // notes: hold while open-handed inside a note zone
    const wantHold = this.open && cell && cell.t === 'n';
    if (wantHold) {
      if (this.held !== zone) { if (this.held >= 0) ev.push({ type: 'release', zone: this.held }); ev.push({ type: 'hold', zone }); this.held = zone; }
    } else if (this.held >= 0) { ev.push({ type: 'release', zone: this.held }); this.held = -1; }
    return ev;
  }
  lost() { const ev = []; if (this.held >= 0) { ev.push({ type: 'release', zone: this.held }); this.held = -1; } this.strike.reset(); this.zone = -1; return ev; }
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
