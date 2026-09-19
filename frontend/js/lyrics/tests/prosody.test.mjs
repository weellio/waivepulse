// Unit tests for the Lyric Helper prosody engine.
// Run from the repo root:  node --test frontend/js/lyrics/tests/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../prosody.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dict = P.parseDict(fs.readFileSync(path.join(here, '..', 'data', 'cmudict-common.txt'), 'utf8'));
const cmuSyl = w => dict.map.get(w).filter(p => /\d$/.test(p)).length;

test('dictionary loads and decodes', () => {
  assert.ok(dict.words.length >= 20000, 'expected 20k+ words');
  assert.deepEqual(dict.map.get('night'), ['N', 'AY1', 'T']);
});

test('heuristic syllable counter: >= 90% agreement with CMU on 200 common words', () => {
  // deterministic sample: every 25th word of the 5,000 most common words
  const sample = dict.words.slice(0, 5000).filter((_, i) => i % 25 === 0);
  assert.equal(sample.length, 200);
  const misses = sample.filter(w => P.heuristicSyllables(w) !== cmuSyl(w));
  const pct = 100 * (sample.length - misses.length) / sample.length;
  console.log(`  heuristic agreement (200-word sample): ${pct.toFixed(1)}%  misses: ${misses.join(', ')}`);
  assert.ok(pct >= 90, `only ${pct}%`);
});

test('heuristic syllable counter: broad check on top 5,000 words', () => {
  const words = dict.words.slice(0, 5000);
  const ok = words.filter(w => P.heuristicSyllables(w) === cmuSyl(w)).length;
  const pct = 100 * ok / words.length;
  console.log(`  heuristic agreement (top 5,000): ${pct.toFixed(1)}%`);
  assert.ok(pct >= 90);
});

test('heuristic handles lyric spellings without the dictionary', () => {
  P.setDict(null);
  const cases = { table: 2, walked: 1, wanted: 2, makes: 1, beautiful: 3, "couldn't": 2,
    "dreamin'": 2, tonight: 2, fire: 2, player: 2, trying: 2, somehow: 2, lovely: 2, the: 1 };
  for (const [w, n] of Object.entries(cases)) assert.equal(P.heuristicSyllables(w), n, w);
});

test('dictionary lookups win, with lyric fallbacks', () => {
  P.setDict(dict);
  assert.equal(P.syllables('every'), cmuSyl('every'));
  assert.equal(P.syllables("runnin'"), 2);
  assert.equal(P.syllables('Heartbreak,'), 2);
  assert.equal(P.lineSyllables('I was driving through the city light'), 9);
});

test('rhyme detection on known pairs', () => {
  P.setDict(dict);
  const perfect = [['night', 'light'], ['love', 'above'], ['fire', 'desire'], ['heart', 'apart'],
    ['rain', 'pain'], ['stay', 'away'], ["dreamin'", 'screaming']];
  for (const [a, b] of perfect) assert.equal(P.wordsRhyme(a, b), 'perfect', `${a}/${b}`);
  const near = [['time', 'mind'], ['home', 'alone'], ['dream', 'dreams']];
  for (const [a, b] of near) assert.equal(P.wordsRhyme(a, b), 'near', `${a}/${b}`);
  const none = [['night', 'day'], ['love', 'move'], ['cat', 'dog'], ['heart', 'soul']];
  for (const [a, b] of none) assert.equal(P.wordsRhyme(a, b), null, `${a}/${b}`);
});

test('rhyme finder groups by kind and syllable count', () => {
  P.setDict(dict);
  const r = P.findRhymes('night');
  assert.ok(r.known);
  assert.ok(r.perfect[1].includes('light') && r.perfect[1].includes('fight'));
  assert.ok(r.perfect[2].includes('tonight'));
  assert.ok(!Object.values(r.perfect).flat().includes('night'));
  assert.equal(P.findRhymes('qwzxv').known, false);
});

test('analysis: sections, scheme, averages, deviation, stats', () => {
  P.setDict(dict);
  const a = P.analyzeLyrics(`[Verse 1]
I was driving through the city light
Every window burning in the night
Nothing left to lose but time
Holding on to what was never mine
And I kept on walking down the empty road that never ever seemed to end at all

[Chorus]
Oh we run away tonight
Till the morning makes it right`);
  assert.equal(a.sections.length, 2);
  assert.equal(a.sections[0].scheme, 'AABBC');
  assert.equal(a.sections[1].scheme, 'AA');
  const long = a.lines.find(l => l.type === 'lyric' && l.text.startsWith('And I kept'));
  assert.ok(long.deviant, 'long line should be flagged');
  assert.ok(!a.lines.filter(l => l.type === 'lyric' && l !== long).some(l => l.deviant));
  assert.equal(a.stats.sections, 2);
  assert.equal(a.stats.lines, 7);
  assert.ok(Math.abs(a.stats.seconds - (a.stats.words / 2.2 + 4)) < 1e-9);
  assert.equal(P.fmtDuration(83), '1:23');
});

test('rhyme finder never suggests proper names or brands', () => {
  P.setDict(dict);
  const all = r => [...Object.values(r.perfect).flat(), ...Object.values(r.near).flat()];
  const light = all(P.findRhymes('light'));
  for (const bad of ['dwight', 'wright', 'albright', 'mike']) assert.ok(!light.includes(bad), bad);
  assert.ok(light.includes('night') && light.includes('bright'));
  assert.ok(!all(P.findRhymes('smart')).includes('walmart'));
  assert.ok(!all(P.findRhymes('rain')).includes('jane'));
  // ordinary words that double as names stay: rose / will / mark / bill
  assert.ok(all(P.findRhymes('nose')).includes('rose'));
  assert.ok(all(P.findRhymes('still')).includes('will'));
  assert.ok(all(P.findRhymes('dark')).includes('mark'));
  // names still count syllables from the dictionary
  assert.equal(P.syllables('Michael'), 2);
  assert.ok(P.isProperNoun('Dwight') && !P.isProperNoun('light'));
});
