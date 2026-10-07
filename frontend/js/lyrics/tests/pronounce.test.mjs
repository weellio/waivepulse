// node --test frontend/js/lyrics/tests/pronounce.test.mjs
//
// The respelling is the product here: if it does not read like the word, the feature is
// worse than nothing because it tells people to paste something wrong into their lyrics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as P from '../prosody.js';
import {
  respell, syllabify, numberToWords, yearToWords, spellOutLetters,
  pronunciationRisks, respellWord, HETERONYMS,
} from '../pronounce.js';

const here = dirname(fileURLToPath(import.meta.url));
P.setDict(P.parseDict(readFileSync(join(here, '..', 'data', 'cmudict-common.txt'), 'utf8')));

test('dictionary loaded', () => {
  assert.ok(P.hasDict() && P.dictSize() > 20000);
});

test('syllabify puts one vowel in each syllable', () => {
  for (const w of ['minute', 'guitar', 'remember', 'strength', 'pronunciation']) {
    const phones = P.phonesFor(w);
    const sylls = syllabify(phones);
    assert.equal(sylls.length, P.syllables(w), `${w} syllable count`);
    assert.deepEqual(sylls.flat(), phones, `${w} keeps every phone`);
  }
});

test('respelling reads like the word', () => {
  const cases = {
    cat: 'kat', dog: 'dawg', night: 'nyt'.replace('ny', 'ney'),  // placeholder, checked loosely below
  };
  // exact spellings are a matter of taste, so assert the properties that must hold
  for (const w of ['cat', 'guitar', 'minute', 'remember', 'thunder']) {
    const r = respellWord(w);
    assert.ok(r.length > 0, `${w} got a respelling`);
    assert.ok(/^[a-zA-Z-]+$/.test(r), `${w} -> ${r} is plain letters and hyphens`);
    assert.equal(r.split('-').length, P.syllables(w), `${w} -> ${r} has one chunk per syllable`);
  }
  assert.equal(respellWord('cat'), 'kat');
  assert.equal(respellWord('see'), 'see');
});

test('the stressed syllable is the capitalised one', () => {
  const r = respellWord('guitar');                 // g-i-TAR
  assert.equal(r.split('-').length, 2);
  const [a, b] = r.split('-');
  assert.equal(b, b.toUpperCase(), `expected stress on the second syllable of ${r}`);
  assert.equal(a, a.toLowerCase());
});

test('single-syllable words are not shouted', () => {
  const r = respellWord('cat');
  assert.equal(r, r.toLowerCase());
});

test('unknown words get no respelling rather than a wrong one', () => {
  assert.equal(respellWord('zzzqqx'), '');
});

test('numbers become words', () => {
  assert.equal(numberToWords(0), 'zero');
  assert.equal(numberToWords(7), 'seven');
  assert.equal(numberToWords(13), 'thirteen');
  assert.equal(numberToWords(21), 'twenty-one');
  assert.equal(numberToWords(100), 'one hundred');
  assert.equal(numberToWords(342), 'three hundred forty-two');
  assert.equal(numberToWords(1000), 'one thousand');
  assert.equal(numberToWords(1999), 'one thousand nine hundred ninety-nine');
  assert.equal(numberToWords(-1), '');
  assert.equal(numberToWords(1.5), '');
});

test('years are sung the way people say them', () => {
  assert.equal(yearToWords(1999), 'nineteen ninety-nine');
  assert.equal(yearToWords(1985), 'nineteen eighty-five');
  assert.equal(yearToWords(1905), 'nineteen oh five');
  assert.equal(yearToWords(2003), 'two thousand three');
  assert.equal(yearToWords(1900), 'nineteen hundred');
  assert.equal(yearToWords(999), '');
});

test('letters spell out', () => {
  assert.equal(spellOutLetters('DJ'), 'dee-jay');
  assert.equal(spellOutLetters('LA'), 'ell-ay');
});

test('heteronyms are caught and offer both senses', () => {
  const risks = pronunciationRisks('I read the book\nShe will read it too');
  const r = risks.find(x => x.kind === 'heteronym');
  assert.ok(r, 'read was flagged');
  assert.equal(r.word.toLowerCase(), 'read');
  assert.equal(r.options.length, 2);
  assert.deepEqual(r.options.map(o => o.text), ['reed', 'red']);
  assert.equal(r.count, 2, 'both occurrences counted as one entry');
});

test('every heteronym entry has two distinct readings', () => {
  for (const [w, opts] of Object.entries(HETERONYMS)) {
    assert.equal(opts.length, 2, `${w} has two senses`);
    assert.notEqual(opts[0][1], opts[1][1], `${w} readings differ`);
    for (const [label, text] of opts) {
      assert.ok(label.length > 2, `${w} label is meaningful`);
      assert.ok(/^[a-zA-Z'’-]+$/.test(text), `${w} -> ${text} is a plain respelling`);
    }
  }
});

test('numbers in lyrics are flagged with year and plain readings', () => {
  const risks = pronunciationRisks('Back in 1999 we drove');
  const r = risks.find(x => x.kind === 'number');
  assert.ok(r);
  assert.equal(r.word, '1999');
  assert.ok(r.options.some(o => o.text === 'nineteen ninety-nine'));
});

test('unknown words are flagged, dictionary words are not', () => {
  // Aoife and quokka really are outside the 30k subset. Siobhan, BBC, DJ and NASA are all IN
  // it, which is the point of checking the dictionary rather than guessing from shape: a name
  // being unusual does not mean the singer cannot say it.
  const risks = pronunciationRisks('Aoife fed the quokka on the quiet street');
  const unknown = risks.filter(x => x.kind === 'unknown').map(x => x.word.toLowerCase());
  assert.ok(unknown.includes('aoife'), `expected aoife, got ${unknown}`);
  assert.ok(unknown.includes('quokka'), `expected quokka, got ${unknown}`);
  for (const common of ['fed', 'the', 'quiet', 'street']) {
    assert.ok(!unknown.includes(common), `${common} should not be flagged`);
  }
});

test('an acronym already in the dictionary is left alone', () => {
  // BBC is stored as B IY2 B IY0 S IY1 -- "bee bee see" -- so it is already sung correctly
  // and flagging it would be noise.
  const risks = pronunciationRisks('she heard it on the BBC with a DJ');
  assert.equal(risks.filter(x => x.kind === 'acronym').length, 0);
});

test('section markers are not scanned', () => {
  const risks = pronunciationRisks('[Verse 1]\nthe quiet street');
  assert.equal(risks.length, 0, `markers leaked: ${JSON.stringify(risks)}`);
});

test('clean everyday lyrics produce no noise', () => {
  const lyrics = [
    '[Verse]', 'Morning light across the kitchen floor',
    'Coffee going cold beside the door', '',
    '[Chorus]', 'And I will wait for you tonight',
    'Until the city turns to light',
  ].join('\n');
  assert.deepEqual(pronunciationRisks(lyrics), [],
    'a plain lyric should flag nothing at all');
});

test('risks are ordered actionable-first', () => {
  const risks = pronunciationRisks('Aoife read 1999 on KTLA');
  const kinds = risks.map(r => r.kind);
  assert.deepEqual(kinds, ['heteronym', 'number', 'acronym', 'unknown']);
});
