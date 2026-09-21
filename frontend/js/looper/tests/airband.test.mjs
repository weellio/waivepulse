// Headless tests for the Air Band's pure logic (zones, gestures, strike detector, tracker).
// Run:  node frontend/js/looper/tests/airband.test.mjs
import assert from 'node:assert/strict';
import {
  PRESETS, GRID_SIZES, presetMapping, resizeMapping, serializeMapping, parseMapping,
  zoneAt, zoneRect, palmCenter, fingersExtended, isOpenHand, isPinch,
  StrikeDetector, sensToThreshold, degreeToMidi, HandTracker, mirrorLandmarks, matchHands, strikePoint,
} from '../airband-logic.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };

// Synthetic 21-point hand. Palm centre ≈ (cx, cy + size/5). open → finger tips far
// from the wrist; fist → tips curled back toward the wrist (closer than the PIPs).
function hand({ cx = 0.5, cy = 0.5, size = 0.1, open = true, pinch = false } = {}) {
  const lm = Array.from({ length: 21 }, () => ({ x: cx, y: cy, z: 0 }));
  lm[0] = { x: cx, y: cy + size, z: 0 };                                     // wrist
  const mcpX = [cx - 0.45 * size, cx - 0.15 * size, cx + 0.15 * size, cx + 0.45 * size];
  [5, 9, 13, 17].forEach((i, k) => { lm[i] = { x: mcpX[k], y: cy, z: 0 }; });
  [[6, 7, 8], [10, 11, 12], [14, 15, 16], [18, 19, 20]].forEach(([pip, dip, tip], k) => {
    lm[pip] = { x: mcpX[k], y: cy - 0.5 * size, z: 0 };
    if (open) { lm[dip] = { x: mcpX[k], y: cy - 0.8 * size, z: 0 }; lm[tip] = { x: mcpX[k], y: cy - 1.1 * size, z: 0 }; }
    else      { lm[dip] = { x: mcpX[k], y: cy - 0.2 * size, z: 0 }; lm[tip] = { x: mcpX[k], y: cy + 0.3 * size, z: 0 }; }
  });
  lm[1] = { x: cx - 0.6 * size, y: cy + 0.6 * size, z: 0 };
  lm[2] = { x: cx - 0.8 * size, y: cy + 0.3 * size, z: 0 };
  lm[3] = { x: cx - 0.9 * size, y: cy, z: 0 };
  lm[4] = pinch ? { x: lm[8].x - 0.02 * size, y: lm[8].y, z: 0 } : { x: cx - 1.0 * size, y: cy - 0.3 * size, z: 0 };
  return lm;
}
// Wrist flick as the camera sees it: the hand pitches forward about the wrist, so every
// point's height above the wrist shrinks by cos(pitch) (foreshortening) — the knuckles
// and fingertips drop, the wrist stays put.
function flick(h, pitch) {
  const w = h[0], c = Math.cos(pitch);
  return h.map((p, i) => i === 0 ? { ...p } : { x: p.x, y: w.y + (p.y - w.y) * c, z: 0 });
}

await test('presets are complete and valid', () => {
  for (const [k, p] of Object.entries(PRESETS)) {
    const [r, c] = GRID_SIZES[p.grid];
    assert.equal(p.cells.length, r * c, k + ' cell count');
    const m = presetMapping(k);
    assert.equal(m.rows, r); assert.equal(m.cols, c);
    for (const cell of m.cells) if (cell) assert.ok(cell.t === 'd' ? cell.i >= 0 && cell.i < 8 : cell.deg >= 0);
  }
  const d = presetMapping('drums');
  assert.deepEqual(new Set(d.cells.map(c => c.i)).size, 8, 'drum kit uses all 8 pads once');
});

await test('zoneAt / zoneRect map the frame correctly (row-major, clamped)', () => {
  const m = presetMapping('drums');                       // 2×4
  assert.equal(zoneAt(m, 0.05, 0.1), 0);
  assert.equal(zoneAt(m, 0.95, 0.1), 3);
  assert.equal(zoneAt(m, 0.05, 0.9), 4);
  assert.equal(zoneAt(m, 0.6, 0.6), 6);
  assert.equal(zoneAt(m, -1, -1), 0); assert.equal(zoneAt(m, 2, 2), 7);
  assert.deepEqual(zoneRect(m, 5), { x: 0.25, y: 0.5, w: 0.25, h: 0.5 });
});

await test('resize keeps assignments by index; serialize/parse round-trips; garbage rejected', () => {
  const m = presetMapping('band');
  const r = resizeMapping(m, '1x4');
  assert.equal(r.cells.length, 4); assert.deepEqual(r.cells[0], m.cells[0]);
  const big = resizeMapping(m, '3x4'); assert.equal(big.cells.length, 12); assert.equal(big.cells[11], null);
  const back = parseMapping(serializeMapping(m));
  assert.deepEqual(back, m);
  assert.equal(parseMapping('nope'), null);
  assert.equal(parseMapping(JSON.stringify({ grid: '9x9', cells: [] })), null);
  const dirty = parseMapping(JSON.stringify({ grid: '1x4', cells: [{ t: 'd', i: 99 }, { t: 'n', deg: -1 }, 'x', { t: 'n', deg: 3 }] }));
  assert.deepEqual(dirty.cells, [null, null, null, { t: 'n', deg: 3 }]);
});

await test('degreeToMidi follows the scale lock (major when unlocked)', () => {
  assert.equal(degreeToMidi(0), 60); assert.equal(degreeToMidi(2), 64); assert.equal(degreeToMidi(7), 72); assert.equal(degreeToMidi(9), 76);
  assert.equal(degreeToMidi(0, 9, 'minor'), 69); assert.equal(degreeToMidi(2, 9, 'minor'), 72);
  assert.equal(degreeToMidi(5, 0, 'pentMaj'), 72);         // 5-note scale: degree 5 = octave
  assert.equal(degreeToMidi(1, 0, 'chromatic'), 62);       // chromatic → major steps, not semitones
});

await test('gestures: open hand vs fist, pinch, palm centre, mirror', () => {
  assert.equal(fingersExtended(hand({ open: true })), 4);
  assert.equal(fingersExtended(hand({ open: false })), 0);
  assert.ok(isOpenHand(hand({ open: true }))); assert.ok(!isOpenHand(hand({ open: false })));
  assert.ok(isPinch(hand({ pinch: true }))); assert.ok(!isPinch(hand({ pinch: false })));
  const p = palmCenter(hand({ cx: 0.3, cy: 0.4, size: 0.1 }));
  assert.ok(Math.abs(p.x - 0.3) < 1e-9 && Math.abs(p.y - 0.42) < 1e-9);
  const mp = palmCenter(mirrorLandmarks(hand({ cx: 0.3, cy: 0.4 })));
  assert.ok(Math.abs(mp.x - 0.7) < 1e-9);
});

await test('strike detector: fires once per downward whack, not on slow drift, honours cooldown', () => {
  const sd = new StrikeDetector({ threshold: 1.4, cooldownMs: 120 });
  let hits = [];
  // slow drift down over 1 s (0.3 frame-heights/s) → nothing
  for (let i = 0; i <= 30; i++) { const h = sd.update(0.2 + 0.01 * i, i * 33); if (h) hits.push(h); }
  assert.equal(hits.length, 0, 'slow drift');
  // fast whack: 0.3 → 0.7 in 4 frames (≈3 fh/s) then stop
  let t = 2000; const ys = [0.3, 0.4, 0.5, 0.6, 0.7, 0.71, 0.71, 0.71];
  for (const y of ys) { const h = sd.update(y, t); t += 33; if (h) hits.push(h); }
  assert.equal(hits.length, 1, 'one hit'); assert.ok(hits[0].vel > 0.35 && hits[0].vel <= 1);
  // same whack seen by a 5 fps camera (one 200 ms frame of motion) still fires exactly once
  const slow = new StrikeDetector({ threshold: 1.4 }); let n5 = 0; t = 0;
  for (const y of [0.3, 0.3, 0.7, 0.71, 0.71]) { if (slow.update(y, t)) n5++; t += 200; }
  assert.equal(n5, 1, 'fires at 5 fps');
  // a harder whack is louder
  const sd2 = new StrikeDetector({ threshold: 1.4 }); let hard = null; t = 0;
  for (const y of [0.1, 0.3, 0.5, 0.7, 0.9, 0.9, 0.9]) { const h = sd2.update(y, t); t += 33; if (h) hard = h; }
  assert.ok(hard && hard.vel > hits[0].vel, 'harder = louder');
  // moving UP fast → nothing
  const sd3 = new StrikeDetector(); t = 0; let up = 0;
  for (const y of [0.9, 0.7, 0.5, 0.3, 0.1, 0.1]) { if (sd3.update(y, t)) up++; t += 33; }
  assert.equal(up, 0);
  // gap > 250 ms (hand lost) doesn't fake a strike
  const sd4 = new StrikeDetector(); sd4.update(0.1, 0); assert.equal(sd4.update(0.9, 400), null); assert.equal(sd4.update(0.9, 433), null);
  assert.ok(sensToThreshold(0) > sensToThreshold(1)); assert.equal(sensToThreshold(0.5), 4.25);
  // unit scaling: the same pixels count for more when the hand is small (far away)
  const sdU = new StrikeDetector({ threshold: 4 }); sdU.update(0.5, 0); assert.ok(sdU.update(0.54, 100, 0.08), '0.04 fh in 100 ms = 5 hand-lengths/s at hand size 0.08');
  const sdV = new StrikeDetector({ threshold: 4 }); sdV.update(0.5, 0); assert.equal(sdV.update(0.54, 100, 0.2), null, 'same pixels, big hand = 2 hand-lengths/s: no hit');
});

await test('hand tracker: hold / slide / release notes, strike hits drums, lost() releases', () => {
  const m = presetMapping('band');                        // 2×4: drums in cols 0–1, notes in cols 2–3
  const tr = new HandTracker({ threshold: 1.4 });
  // open hand in zone 6 (bottom, col 2 = root) → hold
  let ev = tr.update(m, hand({ cx: 0.62, cy: 0.7, open: true }), 0);
  assert.deepEqual(ev, [{ type: 'hold', zone: 6 }]);
  ev = tr.update(m, hand({ cx: 0.62, cy: 0.7, open: true }), 33);
  assert.deepEqual(ev, [], 'still holding: no repeat');
  // slide to zone 7 → release 6, hold 7
  ev = tr.update(m, hand({ cx: 0.9, cy: 0.7, open: true }), 66);
  assert.deepEqual(ev, [{ type: 'release', zone: 6 }, { type: 'hold', zone: 7 }]);
  // close the fist → release
  ev = tr.update(m, hand({ cx: 0.9, cy: 0.7, open: false }), 99);
  assert.deepEqual(ev, [{ type: 'release', zone: 7 }]);
  // open hand over a DRUM zone must not hold
  ev = tr.update(m, hand({ cx: 0.1, cy: 0.7, open: true }), 132);
  assert.deepEqual(ev, []);
  // strike down inside zone 4 (bottom-left = Kick): quick descent then stop
  const tr2 = new HandTracker({ threshold: 1.4 }); let t = 0, hits = [];
  for (const cy of [0.55, 0.62, 0.69, 0.76, 0.83, 0.84, 0.84]) { for (const e of tr2.update(m, hand({ cx: 0.1, cy, open: false }), t)) if (e.type === 'hit') hits.push(e); t += 33; }
  assert.equal(hits.length, 1); assert.equal(hits[0].zone, 4);
  // a WRIST FLICK (wrist still, fingers swing down) fires at the default sensitivity, at 12 fps
  const trF = new HandTracker({ threshold: sensToThreshold(0.65) }); t = 0; hits = [];
  const base = hand({ cx: 0.1, cy: 0.7, open: false, size: 0.12 });
  for (const a of [0, 0, 0, 1.0, 1.1, 1.1]) { for (const e of trF.update(m, flick(base, a), t)) if (e.type === 'hit') hits.push(e); t += 83; }
  assert.equal(hits.length, 1, 'wrist flick = one hit');
  const ob = hand({ cx: 0.1, cy: 0.7, open: true, size: 0.12 });
  const pStill = palmCenter(ob), pDown = palmCenter(flick(ob, 1.0));
  assert.ok(Math.abs(pDown.y - pStill.y) < 0.6 * Math.abs(strikePoint(flick(ob, 1.0)).y - strikePoint(ob).y), 'palm moves much less than the fingers');
  // a strike that carries the hand across a zone border lands in the zone it STARTED in
  const trZ = new HandTracker({ threshold: 4 }); t = 0; hits = [];
  for (const cy of [0.30, 0.30, 0.30, 0.55, 0.60, 0.60]) { for (const e of trZ.update(m, hand({ cx: 0.1, cy, open: false }), t)) if (e.type === 'hit') hits.push(e); t += 83; }
  assert.equal(hits.length, 1); assert.equal(hits[0].zone, 0, 'started in the top-left zone → HiHat, not Kick');
  // same strike over a NOTE zone → no hit event
  const tr3 = new HandTracker({ threshold: 1.4 }); t = 0; hits = [];
  for (const cy of [0.55, 0.62, 0.69, 0.76, 0.83, 0.84, 0.84]) { for (const e of tr3.update(m, hand({ cx: 0.62, cy, open: false }), t)) if (e.type === 'hit') hits.push(e); t += 33; }
  assert.equal(hits.length, 0);
  // lost() releases a held note
  const tr4 = new HandTracker(); tr4.update(m, hand({ cx: 0.62, cy: 0.7, open: true }), 0);
  assert.deepEqual(tr4.lost(), [{ type: 'release', zone: 6 }]);
  assert.deepEqual(tr4.lost(), []);
});

await test('matchHands keeps hand identity by position, ignoring label flicker', () => {
  const prev = [{ x: 0.2, y: 0.5 }, { x: 0.8, y: 0.5 }];
  assert.deepEqual(matchHands(prev, [{ x: 0.82, y: 0.52 }, { x: 0.18, y: 0.49 }]), [1, 0], 'swapped order still matches');
  assert.deepEqual(matchHands(prev, [{ x: 0.5, y: 0.9 }]), [-1], 'too far = new hand');
  assert.deepEqual(matchHands(prev, [{ x: 0.21, y: 0.5 }, { x: 0.23, y: 0.5 }]), [0, -1], 'one tracker can only match one hand');
  assert.deepEqual(matchHands([], [{ x: 0.5, y: 0.5 }]), [-1]);
  assert.deepEqual(matchHands([null, { x: 0.8, y: 0.5 }], [{ x: 0.8, y: 0.5 }]), [1], 'trackers without a palm yet are skipped');
});

console.log(`\n${passed} tests passed`);
