// Headless tests for the Looper's pure modules:
//   zip writer/reader · WAV float I/O · MIDI export → import round trip · chain logic
// Run:  node frontend/js/looper/tests/pure.test.mjs
//       python frontend/js/looper/tests/zip_check.py   (verifies the zip with Python's zipfile)
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip, readZip, crc32 } from '../zip.js';
import { encodeWavF32, decodeWav } from '../wavio.js';
import { buildSMF } from '../midi-export.js';
import { parseSMF, smfToPatterns } from '../midi-file.js';
import { parseChain, formatChain, bankAtBar, simulate, chainFitsMaster } from '../chain.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log('  ok  ' + name); };

// ── helpers mirroring pianoseq.pseqRuns (row → midi = lowMidi + 23 - row) ──
function runsOf(grid, lowMidi = 48) {
  const runs = [];
  for (let row = 0; row < 24; row++) {
    let s = 0;
    while (s < 16) {
      if (!grid[row][s]) { s++; continue; }
      let len = 1; while (s + len < 16 && grid[row][s + len]) len++;
      runs.push({ midi: lowMidi + 23 - row, start: s, len }); s += len;
    }
  }
  return runs;
}
const grid = (r, c, v = 0) => Array.from({ length: r }, () => new Array(c).fill(v));
let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
function randomBar() {
  const seq = grid(8, 16), rat = grid(8, 16, 1), roll = grid(24, 16);
  for (let r = 0; r < 8; r++) for (let s = 0; s < 16; s++) if (rnd() < 0.3) {
    seq[r][s] = Math.round((0.1 + rnd() * 0.9) * 100) / 100;
    rat[r][s] = 1 + Math.floor(rnd() * 4);
  }
  for (let n = 0; n < 10; n++) {
    const row = Math.floor(rnd() * 24), st = Math.floor(rnd() * 16), len = 1 + Math.floor(rnd() * 4);
    for (let i = 0; i < len && st + i < 16; i++) roll[row][st + i] = 1;
  }
  return { seq, rat, roll };
}
const velClose = (a, b) => Math.abs(a - b) <= 1 / 127 + 0.005;

// ─────────────────────────────────────────────────────────────────────────────
await test('crc32 matches the zip reference value', () => {
  assert.equal(crc32(new TextEncoder().encode('The quick brown fox jumps over the lazy dog')), 0x414FA339);
});

await test('zip: write → read round trip (text + binary)', async () => {
  const bin = new Uint8Array(1000).map((_, i) => (i * 37) & 255);
  const z = makeZip([{ name: 'project.json', data: '{"a":1}' }, { name: 'loops/loop1.wav', data: bin }]);
  const m = await readZip(z);
  assert.equal(new TextDecoder().decode(m.get('project.json')), '{"a":1}');
  assert.deepEqual([...m.get('loops/loop1.wav')], [...bin]);
  mkdirSync(join(HERE, 'out'), { recursive: true });
  writeFileSync(join(HERE, 'out', 'sample.zip'), z);   // python zipfile verifies this one
});

await test('wav: float32 encode → decode is bit-exact', () => {
  const L = new Float32Array(4410).map((_, i) => Math.sin(i / 7) * 0.9);
  const R = new Float32Array(4410).map((_, i) => Math.cos(i / 11) * 0.5);
  const d = decodeWav(encodeWavF32([L, R], 44100));
  assert.equal(d.sampleRate, 44100);
  assert.deepEqual([...d.channels[0]], [...L]);
  assert.deepEqual([...d.channels[1]], [...R]);
});

for (const swing of [0, 0.35, 1]) {
  await test(`MIDI round trip (swing ${swing}): drum velocity + ratchets and roll notes survive`, () => {
    const bars = [randomBar(), randomBar(), randomBar()];
    const bytes = buildSMF({ bpm: 97, swing, bars: bars.map(b => ({ runs: runsOf(b.roll), seqPattern: b.seq, seqRatchet: b.rat })) });
    const parsed = parseSMF(bytes);
    assert.equal(parsed.bpm, 97);
    const res = smfToPatterns(parsed, { lowMidi: 48, maxBars: 4 });
    assert.equal(res.bars.length, 3);
    bars.forEach((b, bi) => {
      const got = res.bars[bi];
      for (let r = 0; r < 8; r++) for (let s = 0; s < 16; s++) {
        assert.equal(!!got.seq[r][s], !!b.seq[r][s], `bar ${bi} drum ${r}/${s} on/off`);
        if (b.seq[r][s]) {
          assert.ok(velClose(got.seq[r][s], b.seq[r][s]), `vel ${got.seq[r][s]} vs ${b.seq[r][s]}`);
          assert.equal(got.rat[r][s], b.rat[r][s], `bar ${bi} ratchet ${r}/${s}`);
        }
      }
      assert.deepEqual(got.roll, b.roll, `bar ${bi} roll`);
    });
  });
}

await test('MIDI import: octave folding, bar clipping, tempo', () => {
  const kick = grid(8, 16); kick[0][0] = 1;
  const bars = [{ runs: [{ midi: 84, start: 0, len: 4 }, { midi: 30, start: 4, len: 2 }], seqPattern: kick }];
  for (let i = 0; i < 5; i++) bars.push({ runs: [{ midi: 60, start: 0, len: 16 }] });
  const parsed = parseSMF(buildSMF({ bpm: 90, bars }));
  const res = smfToPatterns(parsed, { lowMidi: 48, maxBars: 4 });
  assert.equal(parsed.bpm, 90);
  assert.equal(res.totalBars, 6);
  assert.equal(res.bars.length, 4);
  assert.equal(res.clippedBars, 2);
  assert.equal(res.folded, 2);
  // 84 (C6) folds to 60 (C4) → row 71-60 = 11 ; 30 (F#1) folds to 54 (F#3) → row 17
  assert.equal(res.bars[0].roll[11][0], 1); assert.equal(res.bars[0].roll[11][3], 1);
  assert.equal(res.bars[0].roll[17][4], 1);
  assert.equal(res.bars[0].seq[0][0], 1);
});

await test('MIDI parser: running status + note-on vel 0 as note-off', () => {
  // MThd fmt0, 1 track, 96 ppq. Track: 90 3C 64 | running 3C 00 (+24) | 3E 64 | 3E 00 (+48) | FF 2F 00
  const trk = [0x00, 0x90, 0x3C, 0x64, 0x18, 0x3C, 0x00, 0x00, 0x3E, 0x64, 0x30, 0x3E, 0x00, 0x00, 0xFF, 0x2F, 0x00];
  const f = new Uint8Array([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0, 96,
    0x4D, 0x54, 0x72, 0x6B, 0, 0, 0, trk.length, ...trk]);
  const p = parseSMF(f);
  assert.equal(p.ppqn, 96);
  assert.deepEqual(p.notes.map(n => [n.tick, n.off, n.note]), [[0, 24, 60], [24, 72, 62]]);
  const r = smfToPatterns(p, { lowMidi: 48 });
  assert.equal(r.bars[0].roll[11][0], 1);          // C4, 1 step (24 ticks = a 16th at 96 ppq)
  assert.equal(r.bars[0].roll[11][1], 0);
  assert.equal(r.bars[0].roll[9][1], 1);           // D4, 2 steps
  assert.equal(r.bars[0].roll[9][2], 1);
  assert.equal(r.bpm, null);
});

await test('chain: parse + format', () => {
  assert.deepEqual(parseChain('A A B A C').seq, [0, 0, 1, 0, 2]);
  assert.deepEqual(parseChain('aabd').seq, [0, 0, 1, 3]);
  assert.deepEqual(parseChain('A, B → C').seq, [0, 1, 2]);
  assert.equal(parseChain('A E').ok, false);
  assert.equal(parseChain('').ok, false);
  assert.equal(parseChain('A'.repeat(17)).ok, false);
  assert.equal(formatChain([0, 0, 1, 0]), 'A A B A');
});

await test('chain: sequencer follows the chain bar by bar, wrapping', () => {
  const st = { chainOn: true, chainSeq: parseChain('A A B A C').seq, chainPos: 0, current: 3, queued: null };
  assert.deepEqual(simulate(st, 12), [0, 0, 1, 0, 2, 0, 0, 1, 0, 2, 0, 0]);
});

await test('chain off: queued bank switches on the next bar, then stays', () => {
  let st = { chainOn: false, chainSeq: [0, 1], chainPos: 0, current: 0, queued: null };
  assert.deepEqual(simulate(st, 2), [0, 0]);
  st = { ...st, queued: 2 };
  assert.deepEqual(simulate(st, 3), [2, 2, 2]);
  const r = bankAtBar({ ...st, chainOn: true, chainSeq: [1, 3], chainPos: 1 });
  assert.equal(r.bank, 3); assert.equal(r.chainPos, 2);
});

await test('chain render must fit the loop length', () => {
  const bar = 2;                                     // 120 BPM
  assert.equal(chainFitsMaster(4, bar, null).ok, true);
  assert.equal(chainFitsMaster(4, bar, 8).ok, true);
  assert.equal(chainFitsMaster(2, bar, 8).ok, true);   // divides evenly
  assert.equal(chainFitsMaster(3, bar, 8).ok, false);  // 6 s into 8 s drifts
  assert.equal(chainFitsMaster(8, bar, 8).ok, false);  // longer than the loops
});

console.log(`\n${passed} tests passed`);
