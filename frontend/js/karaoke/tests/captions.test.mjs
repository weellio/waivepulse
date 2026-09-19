// Unit tests for the Karaoke caption exporters.
// Run from the repo root:  node --test frontend/js/karaoke/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../captions.js';

const W = (word, start, end) => ({ word, start, end });

test('LRC timestamps: rounding, carry, over an hour', () => {
  assert.equal(C.fmtLrcTime(0), '00:00.00');
  assert.equal(C.fmtLrcTime(2.334), '00:02.33');
  assert.equal(C.fmtLrcTime(2.335 + 1e-9), '00:02.34');
  assert.equal(C.fmtLrcTime(59.996), '01:00.00');      // rounds up and carries into minutes
  assert.equal(C.fmtLrcTime(3665.5), '61:05.50');      // LRC minutes keep counting past 59
  assert.equal(C.fmtLrcTime(-3), '00:00.00');
  assert.equal(C.fmtLrcTime(NaN), '00:00.00');
});

test('SRT / VTT timestamps: rounding, carry, over an hour', () => {
  assert.equal(C.fmtSrtTime(0), '00:00:00,000');
  assert.equal(C.fmtSrtTime(1.0005), '00:00:01,001');
  assert.equal(C.fmtSrtTime(59.9996), '00:01:00,000');
  assert.equal(C.fmtSrtTime(3599.9999), '01:00:00,000');
  assert.equal(C.fmtSrtTime(3725.25), '01:02:05,250');
  assert.equal(C.fmtVttTime(3725.25), '01:02:05.250');
  assert.equal(C.fmtVttTime(36000), '10:00:00.000');
});

test('lyricLines skips section markers and blank lines', () => {
  const l = C.lyricLines('[Verse]\nHello  there\n\n[Chorus 2]\n  Oh yeah  \n');
  assert.deepEqual(l, [['Hello', 'there'], ['Oh', 'yeah']]);
});

test('cleanWords drops padding and makes starts monotonic', () => {
  const w = C.cleanWords([W('', 0, 0.5), W('a', 5, 5.5), W('b', 4, 4.2), W('c', 6, null)]);
  assert.deepEqual(w.map(x => x.word), ['a', 'b', 'c']);
  assert.deepEqual(w.map(x => x.start), [5, 5, 6]);
  assert.ok(w.every(x => x.end >= x.start));
});

test('groupLines maps aligned words onto lyric lines; falls back to pauses', () => {
  const words = [W('Hello', 1, 1.4), W('there', 1.4, 2), W('Oh', 4, 4.3), W('yeah', 4.3, 5)];
  const g = C.groupLines(words, '[Verse]\nHello there\n[Chorus]\nOh yeah');
  assert.deepEqual(g.map(l => l.text), ['Hello there', 'Oh yeah']);
  const f = C.groupLines(words, '');
  assert.deepEqual(f.map(l => l.text), ['Hello there', 'Oh yeah']);   // 2 s gap splits
  assert.equal(C.hasUsableTimings(words), true);
  assert.equal(C.hasUsableTimings([W('a', 0, 0.25), W('b', 0, 0.25)]), false);
});

test('splitLine: short stays one line, medium becomes 2 balanced lines, long splits into cues', () => {
  const mk = s => s.split(' ').map((w, i) => W(w, i, i + 0.5));
  assert.deepEqual(C.splitLine(mk('short line here')).map(p => p.lines), [['short line here']]);
  const med = C.splitLine(mk('this lyric line is a little bit too long for a single caption row'));
  assert.equal(med.length, 1);
  assert.equal(med[0].lines.length, 2);
  assert.ok(med[0].lines.every(l => l.length <= 42));
  const longTxt = Array.from({ length: 30 }, (_, i) => 'word' + i).join(' ');
  const parts = C.splitLine(mk(longTxt));
  assert.ok(parts.length >= 2);
  for (const p of parts) {
    assert.ok(p.lines.length <= 2);
    assert.ok(p.lines.every(l => l.length <= 42), JSON.stringify(p.lines));
  }
  assert.equal(parts.flatMap(p => p.words).length, 30);   // no word lost or duplicated
  // an unbreakable monster word doesn't recurse forever
  const mono = C.splitLine([W('x'.repeat(60), 0, 1)]);
  assert.equal(mono.length, 1);
});

test('buildCues: end = min(next start, last end + 1.5), no overlaps, min 0.7 s', () => {
  const lines = [
    { words: [W('one', 1, 1.5), W('two', 1.5, 2)] },        // next starts at 10 -> end 2 + 1.5 = 3.5
    { words: [W('three', 10, 10.2)] },                        // next starts 10.3 -> would be 0.3 s -> 0.7 min
    { words: [W('four', 10.3, 11)] },                         // pushed to start 10.7 (no overlap)
    { words: [W('five', 11.2, 11.6)] },
  ];
  const cues = C.buildCues(lines);
  assert.equal(cues[0].start, 1);
  assert.equal(cues[0].end, 3.5);
  assert.equal(cues[1].end - cues[1].start >= 0.7 - 1e-9, true);
  for (let i = 0; i < cues.length; i++) {
    assert.ok(cues[i].end - cues[i].start >= 0.7 - 1e-9, `cue ${i} too short`);
    if (i) assert.ok(cues[i].start >= cues[i - 1].end - 1e-9, `cue ${i} overlaps`);
  }
  assert.equal(cues[2].start, 10.7);
  assert.equal(cues[3].end, 11.6 + 1.5);
});

test('SRT, VTT and LRC output shape', () => {
  const words = [W('Hello', 1, 1.4), W('there', 1.4, 2), W('Oh', 4, 4.3), W('yeah', 4.3, 5)];
  const lines = C.groupLines(words, '[Verse]\nHello there\nOh yeah');
  const cues = C.buildCues(lines);
  const srt = C.buildSrt(cues);
  assert.match(srt, /^1\n00:00:01,000 --> 00:00:03,500\nHello there\n\n2\n00:00:04,000 --> 00:00:06,500\nOh yeah\n$/);
  const vtt = C.buildVtt(cues);
  assert.ok(vtt.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello there\n'));
  const lrc = C.buildLrc(lines, { title: 'Song [x]', artist: 'Me', duration: 125.4 });
  assert.match(lrc, /^\[ti:Song x\]\n\[ar:Me\]\n\[length:02:05\]\n/);
  assert.ok(lrc.includes('[00:01.00]<00:01.00>Hello <00:01.40>there <00:02.00>'));
  assert.ok(!lrc.includes('Verse'));
  const plain = C.buildLrc(lines, { wordTags: false });
  assert.ok(plain.includes('[00:04.00]Oh yeah'));
  assert.equal(C.buildTimedText(lines), '[0:01] Hello there\n[0:04] Oh yeah\n');
  assert.equal(C.fileStem('A/B: "c"?'), 'AB c');
});
