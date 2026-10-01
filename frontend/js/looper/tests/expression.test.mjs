// Headless tests for the expression lane (the dynamics curve under the roll).
//   node frontend/js/looper/tests/expression.test.mjs
// Covers: storage + interpolation, shapes, grid snapping, ramp scheduling for
// held notes, the audio mapping (level/cutoff/drive all rise together), CC1 in
// the exported MIDI file, and the favourites / project round trip.
import assert from 'node:assert/strict';
import {
  STEPS, NODES, DEFAULT, blankLane, clamp01, sampleCurve, exprAt, setNode, drawSegment,
  resetRegion, beatRegion, shapeCurve, SHAPES, snapIndex, valueAtY, exprRampPlan,
  EXPR_DRIVE, EXPR_LEVEL, EXPR_CUT, EXPR_TARGET, exprCC1, exprState, setExprState,
  lanePts, exprLanes,
} from '../expression.js';
import { buildSMF } from '../midi-export.js';
import { parseSMF } from '../midi-file.js';

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ok  ' + name); };
const grid = (r, c, v = 0) => Array.from({ length: r }, () => new Array(c).fill(v));

// ── storage + interpolation ───────────────────────────────────────────────────
test('a blank lane is 17 nodes at the default dynamic', () => {
  const l = blankLane();
  assert.equal(l.length, NODES);
  assert.equal(NODES, STEPS + 1);
  assert.ok(l.every(v => v === DEFAULT));
});

test('clamp01 keeps every value in 0…1 and survives junk', () => {
  assert.equal(clamp01(-3), 0);
  assert.equal(clamp01(9), 1);
  assert.equal(clamp01(0.42), 0.42);
  assert.equal(clamp01('x'), DEFAULT);
  assert.equal(clamp01(NaN), DEFAULT);
  assert.equal(clamp01(undefined), DEFAULT);
});

test('the curve passes exactly through every stored node', () => {
  const pts = blankLane();
  for (let i = 0; i < NODES; i++) setNode(pts, i, (i * 7 % 11) / 10);
  for (let i = 0; i < NODES; i++) assert.ok(Math.abs(sampleCurve(pts, i) - pts[i]) < 1e-9, 'node ' + i);
});

test('between nodes the curve is smooth, monotone and never overshoots', () => {
  const pts = blankLane(0);
  for (let i = 0; i < NODES; i++) pts[i] = i / STEPS;          // a clean ramp
  let prev = -1;
  for (let t = 0; t <= STEPS; t += 0.05) {
    const v = sampleCurve(pts, t);
    assert.ok(v >= 0 && v <= 1, 'in range at ' + t);
    assert.ok(v >= prev - 1e-9, 'monotone at ' + t);
    prev = v;
  }
  // a step change must not ring above the plateau (monotone cubic, not Catmull-Rom)
  const spike = blankLane(0.2);
  for (let i = 8; i < NODES; i++) spike[i] = 0.9;
  for (let t = 0; t <= STEPS; t += 0.05) {
    const v = sampleCurve(spike, t);
    assert.ok(v <= 0.9 + 1e-9 && v >= 0.2 - 1e-9, 'no overshoot at ' + t);
  }
  // halfway between two nodes it is genuinely between them (a real curve, not steps)
  const half = sampleCurve(pts, 4.5);
  assert.ok(half > pts[4] && half < pts[5]);
});

test('out-of-range t clamps to the end nodes', () => {
  const pts = blankLane(); pts[0] = 0.1; pts[STEPS] = 0.9;
  assert.equal(sampleCurve(pts, -5), 0.1);
  assert.equal(sampleCurve(pts, 99), 0.9);
  assert.equal(exprAt(pts, 0), 0.1);
});

// ── editing ───────────────────────────────────────────────────────────────────
test('shift-drag writes a straight line between two nodes, either direction', () => {
  const pts = blankLane(0.5);
  drawSegment(pts, 4, 0.2, 12, 1.0);
  assert.ok(Math.abs(pts[4] - 0.2) < 1e-9);
  assert.ok(Math.abs(pts[12] - 1.0) < 1e-9);
  assert.ok(Math.abs(pts[8] - 0.6) < 1e-9, 'midpoint is the linear average');
  assert.equal(pts[0], 0.5, 'outside the drag is untouched');
  const back = blankLane(0.5);
  drawSegment(back, 12, 1.0, 4, 0.2);                 // dragged right-to-left
  for (let i = 4; i <= 12; i++) assert.ok(Math.abs(back[i] - pts[i]) < 1e-9);
});

test('double-click resets exactly the beat under the cursor', () => {
  const pts = blankLane(0.1);
  assert.deepEqual(beatRegion(0),  [0, 4]);
  assert.deepEqual(beatRegion(5),  [4, 8]);
  assert.deepEqual(beatRegion(15), [12, 16]);
  const [a, b] = beatRegion(6);
  resetRegion(pts, a, b, DEFAULT);
  for (let i = 0; i < NODES; i++)
    assert.equal(pts[i], i >= 4 && i <= 8 ? DEFAULT : 0.1, 'node ' + i);
});

test('edits clamp and never grow or shrink the lane', () => {
  const pts = blankLane();
  setNode(pts, -5, 2); setNode(pts, 99, -2);
  assert.equal(pts.length, NODES);
  assert.equal(pts[0], 1);
  assert.equal(pts[STEPS], 0);
});

// ── shapes ────────────────────────────────────────────────────────────────────
test('every shape produces a full lane inside 0…1', () => {
  for (const name of Object.keys(SHAPES)) {
    const pts = shapeCurve(name);
    assert.equal(pts.length, NODES, name);
    assert.ok(pts.every(v => v >= 0 && v <= 1), name + ' in range');
  }
});

test('swell rises, fall falls, arch peaks in the middle, pulse accents each beat', () => {
  const sw = shapeCurve('swell');
  assert.ok(sw[STEPS] - sw[0] > 0.6, 'swell spans a real dynamic range');
  for (let i = 1; i < NODES; i++) assert.ok(sw[i] > sw[i - 1], 'swell monotone up');

  const fa = shapeCurve('fall');
  for (let i = 1; i < NODES; i++) assert.ok(fa[i] < fa[i - 1], 'fall monotone down');

  const ar = shapeCurve('arch');
  assert.ok(ar[8] > ar[0] + 0.5 && ar[8] > ar[STEPS] + 0.5, 'arch peaks mid-bar');

  const pu = shapeCurve('pulse');
  for (const beat of [0, 4, 8, 12]) {
    assert.ok(pu[beat] > pu[beat + 1], 'accent on beat ' + (beat / 4 + 1));
    assert.ok(pu[beat] > pu[beat + 2], 'decays through beat ' + (beat / 4 + 1));
  }
  assert.ok(shapeCurve('flat').every(v => v === DEFAULT));
});

// ── snapping ──────────────────────────────────────────────────────────────────
test('pixels snap to the nearest step node and clamp at the ends', () => {
  const x0 = 47, w = 16 * 23;                        // the roll's real geometry
  assert.equal(snapIndex(x0, x0, w), 0);
  assert.equal(snapIndex(x0 + w, x0, w), STEPS);
  assert.equal(snapIndex(x0 + w / 2, x0, w), 8);
  assert.equal(snapIndex(x0 - 500, x0, w), 0, 'clamps left');
  assert.equal(snapIndex(x0 + w + 500, x0, w), STEPS, 'clamps right');
  // a pixel just past a node's half-way point lands on the next node
  const pitch = w / STEPS;
  assert.equal(snapIndex(x0 + pitch * 3 + pitch * 0.51, x0, w), 4);
  assert.equal(snapIndex(x0 + pitch * 3 + pitch * 0.49, x0, w), 3);
});

test('y maps top = loud, bottom = quiet, with the lane padding honoured', () => {
  assert.ok(Math.abs(valueAtY(8, 74, 8) - 1) < 1e-9, 'top of the plot = 1');
  assert.ok(Math.abs(valueAtY(66, 74, 8) - 0) < 1e-9, 'bottom of the plot = 0');
  assert.ok(Math.abs(valueAtY(37, 74, 8) - 0.5) < 0.02, 'middle ≈ 0.5');
  assert.equal(valueAtY(-40, 74, 8), 1);
  assert.equal(valueAtY(400, 74, 8), 0);
});

// ── playback scheduling ───────────────────────────────────────────────────────
test('a 4-step note gets >= 4 scheduled expression ramps across its length', () => {
  const pts = shapeCurve('swell');
  const stepDur = (60 / 120) / 4;                    // 120 BPM 16th = 0.125 s
  const plan = exprRampPlan({ pts, startStep: 0, lenSteps: 4, onTime: 10, stepDur });
  assert.ok(plan.length >= 4, 'got ' + plan.length + ' ramps');
  assert.equal(plan.length, 8, 'two ramps per step');
  // the ramps are in time order, inside the note, and the last lands at its end
  let prev = 10;
  for (const p of plan) { assert.ok(p.when > prev, 'ascending times'); prev = p.when; }
  assert.ok(Math.abs(plan[plan.length - 1].when - (10 + 4 * stepDur)) < 1e-9, 'last ramp = note end');
  // and the VALUE actually moves across those 4 steps (not one onset value)
  const first = plan[0].value, last = plan[plan.length - 1].value;
  assert.ok(last - first > 0.15, `curve moved ${first.toFixed(3)} → ${last.toFixed(3)}`);
  const vals = plan.map(p => p.value);
  assert.equal(new Set(vals.map(v => v.toFixed(3))).size, vals.length, 'every ramp a distinct value');
});

test('a 1-step note still gets ramps, and a 16-step note gets 32', () => {
  const pts = shapeCurve('arch'), stepDur = 0.125;
  assert.ok(exprRampPlan({ pts, startStep: 0, lenSteps: 1, onTime: 0, stepDur }).length >= 2);
  assert.equal(exprRampPlan({ pts, startStep: 0, lenSteps: 16, onTime: 0, stepDur }).length, 32);
});

test('ramps sample the curve at the note\'s own position in the bar', () => {
  const pts = shapeCurve('fall'), stepDur = 0.125;
  const early = exprRampPlan({ pts, startStep: 0,  lenSteps: 2, onTime: 0, stepDur });
  const late  = exprRampPlan({ pts, startStep: 12, lenSteps: 2, onTime: 0, stepDur });
  assert.ok(early[0].value > late[0].value + 0.4, 'a fall is quieter by bar end');
});

// ── the audio mapping: louder = brighter = richer ─────────────────────────────
test('level, cutoff and drive all rise together with expression', () => {
  let pl = -1, pc = -1, pd = -1;
  for (let e = 0; e <= 1.0001; e += 0.05) {
    const l = EXPR_LEVEL(e), c = EXPR_CUT(e, 440), d = EXPR_DRIVE(e);
    assert.ok(l > pl, 'level rises at ' + e.toFixed(2));
    assert.ok(c > pc, 'cutoff rises at ' + e.toFixed(2));
    assert.ok(d > pd, 'drive rises at ' + e.toFixed(2));
    pl = l; pc = c; pd = d;
  }
  // at full expression the voice lands on the same peak the synth used before
  assert.ok(Math.abs(EXPR_TARGET(1) - 0.5) < 1e-9);
  assert.ok(Math.abs(EXPR_CUT(1, 440) - 16000) < 1, 'fully open at 1');
  assert.ok(EXPR_TARGET(1) / EXPR_TARGET(0) > 5, 'a real dynamic range');
});

test('the cutoff floor always passes the note\'s own fundamental', () => {
  for (const hz of [65, 261.63, 440, 1046.5, 4186]) {
    assert.ok(EXPR_CUT(0, hz) >= hz, `${hz} Hz passes at pp`);
    assert.ok(Math.abs(EXPR_CUT(1, hz) - 16000) < 1, `${hz} Hz fully open at ff`);
  }
});

// ── MIDI CC1 ──────────────────────────────────────────────────────────────────
test('exprCC1 emits sane, deduped, time-ordered controller values', () => {
  const cc = exprCC1(shapeCurve('swell'), { stepTicks: 120 });
  assert.ok(cc.length >= 8, 'got ' + cc.length + ' points');
  let prev = -1;
  for (const e of cc) {
    assert.ok(Number.isInteger(e.val) && e.val >= 0 && e.val <= 127, 'value ' + e.val);
    assert.ok(Number.isInteger(e.tick) && e.tick >= prev, 'tick order');
    prev = e.tick;
  }
  assert.ok(cc[cc.length - 1].val - cc[0].val > 80, 'a swell spans most of the CC range');
  // a flat lane collapses to a single point
  assert.equal(exprCC1(blankLane(0.5), { stepTicks: 120 }).length, 2);   // first + final
});

test('the exported MIDI file carries CC1 next to the notes and still parses', () => {
  const roll = grid(24, 16);
  for (let s = 0; s < 16; s++) roll[12][s] = 1;              // one held whole note
  const runs = [{ midi: 59, start: 0, len: 16 }];
  const bars = [{ runs, seqPattern: grid(8, 16), seqRatchet: grid(8, 16, 1), expr: shapeCurve('swell') }];
  const bytes = buildSMF({ bpm: 120, swing: 0, bars });
  assert.ok(bytes, 'file written');
  assert.ok(bytes.ccCount > 8, 'wrote ' + bytes.ccCount + ' CC events');

  // find the raw CC1 bytes (0xB0 0x01 val) and check they rise
  const vals = [];
  for (let i = 0; i + 2 < bytes.length; i++)
    if (bytes[i] === 0xB0 && bytes[i + 1] === 0x01 && bytes[i + 2] <= 127) vals.push(bytes[i + 2]);
  assert.ok(vals.length > 8, 'CC1 bytes present: ' + vals.length);
  assert.ok(vals[vals.length - 1] > vals[0] + 80, `CC1 rises ${vals[0]} → ${vals[vals.length - 1]}`);

  // the existing reader still handles the file, notes intact
  const p = parseSMF(bytes);
  assert.equal(p.bpm, 120);
  const mel = p.notes.filter(n => n.ch !== 9);
  assert.equal(mel.length, 1);
  assert.equal(mel[0].note, 59);
  assert.equal(mel[0].off - mel[0].tick, 480 * 4);
});

test('MIDI export without an expression lane is byte-identical to before', () => {
  const runs = [{ midi: 60, start: 0, len: 4 }, { midi: 64, start: 4, len: 4 }];
  const seqPattern = grid(8, 16); seqPattern[0][0] = 1;
  const a = buildSMF({ bpm: 128, swing: 0.3, bars: [{ runs, seqPattern, seqRatchet: grid(8, 16, 1) }] });
  const b = buildSMF({ bpm: 128, swing: 0.3, bars: [{ runs, seqPattern, seqRatchet: grid(8, 16, 1), expr: null }] });
  assert.deepEqual([...a], [...b]);
  assert.equal(a.ccCount, 0);
  const p = parseSMF(a);
  assert.equal(p.notes.filter(n => n.ch !== 9).length, 2);
  assert.equal(p.notes.filter(n => n.ch === 9).length, 1);
});

test('CC1 is written per bar across a chain', () => {
  const runs = [{ midi: 60, start: 0, len: 8 }];
  const bar = () => ({ runs, seqPattern: grid(8, 16), seqRatchet: grid(8, 16, 1), expr: shapeCurve('arch') });
  const one = buildSMF({ bpm: 120, swing: 0, bars: [bar()] });
  const three = buildSMF({ bpm: 120, swing: 0, bars: [bar(), bar(), bar()] });
  assert.ok(three.ccCount > one.ccCount * 2.5, `${one.ccCount} → ${three.ccCount}`);
});

// ── save / restore round trip (favourites + project shape) ────────────────────
test('exprState → JSON → setExprState restores every lane exactly', () => {
  const drawn = shapeCurve('arch');
  const lanes = exprLanes();
  lanes.roll.pts = drawn.slice();
  lanes.roll.link = false;
  lanes.global.pts = shapeCurve('swell');
  lanes.drums.link = true;
  lanes.mic.link = false;
  lanes.mic.pts = shapeCurve('pulse');

  const json = JSON.stringify({ name: 'My melody', grid: grid(24, 16), expr: exprState() });
  // wipe everything, then restore from the serialised form
  lanes.roll.pts = blankLane(0); lanes.global.pts = blankLane(0);
  lanes.mic.pts = blankLane(0); lanes.drums.link = false; lanes.mic.link = true;

  const fav = JSON.parse(json);
  assert.ok(setExprState(fav.expr));
  assert.deepEqual(exprLanes().roll.pts, drawn);
  assert.deepEqual(exprLanes().global.pts, shapeCurve('swell'));
  assert.deepEqual(exprLanes().mic.pts, shapeCurve('pulse'));
  assert.equal(exprLanes().drums.link, true);
  assert.equal(exprLanes().mic.link, false);
  // a linked part plays the global curve, an unlinked one plays its own
  assert.deepEqual(lanePts('drums'), shapeCurve('swell'));
  assert.deepEqual(lanePts('mic'), shapeCurve('pulse'));
  assert.deepEqual(lanePts('roll'), drawn);
});

test('setExprState survives missing, short and corrupt data', () => {
  assert.equal(setExprState(null), false);
  assert.equal(setExprState('nope'), false);
  assert.ok(setExprState({ lanes: { roll: { pts: [0.5, 'x', null, 99, -4] } } }));
  const p = exprLanes().roll.pts;
  assert.equal(p.length, NODES);
  assert.equal(p[0], 0.5);
  assert.equal(p[1], DEFAULT);          // junk falls back to the default
  assert.equal(p[3], 1);                // 99 clamps
  assert.equal(p[4], 0);                // -4 clamps
  assert.ok(p.every(v => v >= 0 && v <= 1));
  assert.ok(setExprState({ on: false, part: 'global', lanes: {} }));
  assert.ok(exprLanes().roll.pts.every(v => v === DEFAULT));
  assert.ok(setExprState({ on: true, part: 'roll', lanes: {} }));
});

test('the project shape is plain JSON (no functions, no typed arrays)', () => {
  setExprState({ on: true, part: 'roll', lanes: { roll: { pts: shapeCurve('swell'), link: false } } });
  const st = exprState();
  const round = JSON.parse(JSON.stringify(st));
  assert.deepEqual(round, st);
  assert.ok(Array.isArray(round.lanes.roll.pts));
  assert.deepEqual(Object.keys(round).sort(), ['lanes', 'on', 'part']);
  assert.deepEqual(Object.keys(round.lanes).sort(), ['drums', 'global', 'mic', 'roll']);
});

console.log(`\n${passed} expression tests passed`);
