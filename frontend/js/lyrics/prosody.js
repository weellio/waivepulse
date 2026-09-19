// Prosody engine for the Lyric Helper: syllables, rhyme keys, rhyme finder,
// and whole-lyric analysis. Pure functions, no DOM — also imported by the
// node unit tests (tests/prosody.test.mjs; run: node --test frontend/js/lyrics/tests/prosody.test.mjs).
//
// Pronunciations come from a vendored CMU-dict subset (data/cmudict-common.txt,
// built by scripts/build_lyrics_dict.py). Anything not in the dictionary falls
// back to a spelling heuristic, so everything still works before/without it.

let DICT = null;          // Map word -> phones array (e.g. ['N','AY1','T'])
let WORDS = null;         // words in frequency order (most common first)
let RHYME_INDEX = null;   // lazily built: vowel-signature -> [{w, tail, syl, rank}]
let PROPER = null;        // Set of names/brands: used for syllables, never suggested as rhymes

const VOWEL_RE = /^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)[012]$/;
const isVowel = p => VOWEL_RE.test(p);

// ---------------------------------------------------------------- dictionary
export function parseDict(text) {
  const lines = text.split('\n');
  const head = lines[0];
  // WPDICT2 = WPDICT1 + a Capitalised word marks a proper noun / brand.
  if (!/^#WPDICT[12] /.test(head)) throw new Error('bad dictionary header');
  const table = head.slice(9).trim().split(' ');
  const map = new Map();
  const words = [];
  const proper = new Set();
  for (let i = 1; i < lines.length; i++) {
    const ln = lines[i];
    const tab = ln.indexOf('\t');
    if (tab < 1) continue;
    let w = ln.slice(0, tab);
    if (w[0] >= 'A' && w[0] <= 'Z') { w = w.toLowerCase(); proper.add(w); }
    const enc = ln.slice(tab + 1);
    const phones = new Array(enc.length);
    for (let j = 0; j < enc.length; j++) phones[j] = table[enc.charCodeAt(j) - 0x30];
    map.set(w, phones);
    words.push(w);
  }
  return { map, words, proper };
}

export function setDict(d) {
  DICT = d ? d.map : null; WORDS = d ? d.words : null; PROPER = d ? (d.proper || new Set()) : null; RHYME_INDEX = null;
}
export function isProperNoun(raw) { return !!PROPER && PROPER.has(cleanWord(raw)); }
export function hasDict() { return !!DICT; }
export function dictSize() { return DICT ? DICT.size : 0; }

// Normalise a raw token from lyrics: lowercase, curly quotes, trim punctuation.
export function cleanWord(raw) {
  return String(raw || '').toLowerCase()
    .replace(/[‘’ʼ`]/g, "'")
    .replace(/^[^a-z']+|[^a-z']+$/g, '')
    .replace(/^'+/, '');
}

// Look up phones, with a few lyric-friendly fallbacks (dreamin' -> dreaming,
// plurals / possessives built from the base word).
export function phonesFor(raw) {
  if (!DICT) return null;
  let w = cleanWord(raw);
  if (!w) return null;
  const direct = DICT.get(w) || DICT.get(w.replace(/'$/, ''));
  if (direct) return direct;
  if (/in'?$/.test(w)) { const g = DICT.get(w.replace(/'$/, '') + 'g'); if (g) return g; }   // dreamin' / blazin
  if (/'s$/.test(w)) { const b = DICT.get(w.slice(0, -2)); if (b) return withS(b); }
  if (/[^s]s$/.test(w)) { const b = DICT.get(w.slice(0, -1)); if (b) return withS(b); }
  if (/ed$/.test(w)) {
    const b = DICT.get(w.slice(0, -2)) || DICT.get(w.slice(0, -1));
    if (b) { const last = b[b.length - 1]; return (last === 'T' || last === 'D') ? [...b, 'IH0', 'D'] : [...b, 'D']; }
  }
  if (/ing$/.test(w)) {
    const b = DICT.get(w.slice(0, -3)) || DICT.get(w.slice(0, -3) + 'e');
    if (b) return [...b, 'IH0', 'NG'];
  }
  return null;
}
function withS(b) {
  const last = b[b.length - 1];
  if (['S', 'Z', 'SH', 'ZH', 'CH', 'JH'].includes(last)) return [...b, 'IH0', 'Z'];
  if (['P', 'T', 'K', 'F', 'TH'].includes(last)) return [...b, 'S'];
  return [...b, 'Z'];
}

// ---------------------------------------------------------- syllable counter
// Common words the spelling rules get wrong (counts follow the CMU dictionary).
const SYL_EXCEPTIONS = {
  every: 3, several: 2, family: 3, business: 2, chocolate: 2, camera: 3, people: 2,
  fire: 2, hour: 2, our: 2, flour: 2, hire: 2, tired: 2, choir: 2, liar: 2, poem: 2, poet: 2,
  quiet: 2, idea: 3, area: 3, real: 1, really: 2, being: 2, seeing: 2, video: 3, radio: 3,
  piano: 3, cruel: 2, fuel: 2, jewel: 2, ocean: 2, maybe: 2, whatever: 3, wherever: 3,
  whoever: 3, forever: 3, wednesday: 2, colonel: 2, recipe: 3, apostrophe: 4, catastrophe: 4,
  coyote: 3, karaoke: 4, heaven: 2, seven: 2, eleven: 3, even: 2, given: 2, toward: 2,
  towards: 2, gonna: 2, wanna: 2, gotta: 2, gimme: 2, whole: 1, where: 1, there: 1, here: 1,
  were: 1, more: 1, before: 2, sure: 1, eyes: 1, naked: 2, wicked: 2, sacred: 2, hatred: 2,
  rhythm: 2, diamond: 2, desperate: 3, temperature: 4, cafe: 2, recovery: 4, opera: 3,
  alien: 3, create: 2, react: 2, theory: 2, chaos: 2, doesn: 2, dying: 2, lying: 2, lion: 2,
  violent: 3, violin: 3, someone: 2, anyone: 3, everyone: 3, noone: 2, science: 2, society: 4, anxiety: 4, variety: 4, beautiful: 3,
};

const COMPOUND_HEADS = /(some|where|there|base|home|ware|fore|safe|care|fare|awe|police|life|time|love|hope|house|place|wise|like|lone|nine|five|state|make|side|smoke|fire|name|game|space|note|stone|whole|note|bone|face|race|grave|lake|wife|shoe|eye)(?!(ly|ment|ful|ness|less)$)(?=[bcdfghjklmnpqrstvwxz][a-z]*[aeiouy])/g;

export function heuristicSyllables(raw) {
  let w = cleanWord(raw);
  if (!w) return 0;
  const exc = lookupException(w);
  if (exc) return exc;
  // contractions: "n't" after a consonant adds a syllable (couldn't, didn't, wasn't)
  let extra = 0;
  if (/[^aeiou']n't$/.test(w)) { extra++; w = w.slice(0, -3); }
  else if (/n't$/.test(w)) w = w.slice(0, -3);
  const droppedG = /in'$/.test(w);
  w = w.replace(/'(s|d|ll|ve|re|m)$/, '').replace(/'/g, '');
  if (droppedG) w += 'g';
  if (!w) return Math.max(1, extra);
  if (!/[aeiouy]/.test(w)) {                       // hmm, shh, mr, tv
    return (/^(h?m+|sh+|hm+|brr+|pf+t?|psst|tsk)$/.test(w) ? 1 : w.length) + extra;
  }
  if (w.length <= 2) return 1 + extra;
  return Math.max(1, heuristicCore(w) + extra);
}

function lookupException(w) {
  if (SYL_EXCEPTIONS[w]) return SYL_EXCEPTIONS[w];
  const m = w.match(/^(.*?)(s|es|ed|d)$/);
  if (m && SYL_EXCEPTIONS[m[1]] && m[1].length > 3) {
    const b = SYL_EXCEPTIONS[m[1]];
    return (m[2] === 'es' && /(s|x|z|ch|sh|ce|ge)$/.test(m[1])) || (m[2] === 'ed' && /[td]$/.test(m[1])) ? b + 1 : b;
  }
  return 0;
}

function heuristicCore(w) {
  let s = w;
  // spelling normalisations that make the vowel-group count work
  s = s.replace(/^every(?=[a-z])/, 'evry').replace(/^interest/, 'intrest');
  s = s.replace(/^y/, 'j');                                   // you, yes, year
  s = s.replace(/([aeiou])y(?=[aeiou])/g, '$1j');             // player, annoying, beyond
  s = s.replace(/([^r])([gq])ue(s|d)?$/, '$1$2');               // league, unique, tongue (not argue)
  let n = 0;
  // compounds whose first half ends in a silent e (somehow, baseball, awesome)
  if (!/^(wherever|whatever|whoever)$/.test(s)) {
    const matches = s.match(COMPOUND_HEADS);
    if (matches) n -= matches.length;
  }
  // silent endings
  if (/[^aeiouy]e$/.test(s) && !/[^aeiouyl]le$/.test(s) && /[aeiouy].*[^aeiouy]e$/.test(s)) n--;      // make, time (not table)
  else if (/[^aeiouy]es$/.test(s) && !/[^aeiouy]les$/.test(s) && !/(s|x|z|ch|sh|c|g)es$/.test(s) && /[aeiouy].*[^aeiouy]es$/.test(s)) n--; // makes, times
  else if (/[^aeiouy]ed$/.test(s) && !/[td]ed$/.test(s) && !/[^aeiouyl]led$/.test(s) && !/[^aeiouyr]red$/.test(s) && /[aeiouy].*[^aeiouy]ed$/.test(s)) n--; // walked (not settled, hundred)
  if (/[^aeiouy]e(ly|ment|ful|ness|less)$/.test(s) && s.length > 5) n--;   // lately, movement, hopeful
  if (/[ct]ially$|ically$/.test(s)) n--;                                  // especially, basically
  // -ire / -our are two syllables in CMU (fire, desire, hour, ours)
  if (/[^aeiou]ire[ds]?$/.test(s)) n++;
  if (/^(h?ours?|ourselves)$/.test(s)) n++;
  if (/[^aeiouy]ism$|thms?$/.test(s)) n++;                // prism, rhythm
  if (/[^aeiou]yings?$/.test(s)) n++;                     // trying, carrying
  if (/[aeiou]ings?$/.test(s) && !/[qg]uings?$/.test(s)) n++; // going, doing, seeing
  // "-ea-" split in a few common shapes (idea, area, create, reality, theater)
  if (/[^aeiou]ea[s]?$/.test(s) && s.length > 4) n++;
  if (/^(re|cre|the|pre)a(li|liz|lis|ct|te|ti|to|ter|tre)/.test(s)) n++;
  const groups = [...s.matchAll(/[aeiouy]+/g)];
  n += groups.length;
  for (const m of groups) n += splitsIn(m[0], s, m.index);
  return Math.max(1, n);
}

// Extra syllables a multi-letter vowel group contributes (0 or 1).
function splitsIn(g, word, idx) {
  if (g.length < 2) return 0;
  const before = word.slice(0, idx);
  const after = word.slice(idx + g.length);
  const b1 = before.slice(-1), b2 = before.slice(-2, -1);
  if (/^(eou|iou)$/.test(g)) return /[ctgx]$/.test(before) ? 0 : 1;          // precious vs curious
  if (g === 'ie' || g === 'ies') {
    if (word.length <= 4) return 0;                                           // pier, tie
    if (!/^(nce|nces|nt|nts|t|ts|r|rs|st|ty|ties)$/.test(after)) return 0;    // friend, piece, cities
    if (after === 'st' && word.length < 7) return 0;                          // priest
    if (/[tcs]$/.test(before) && before.length > 2) return 0;                // ancient, patient
    return 1;                                                                 // science, client, diet, happier
  }
  if (g === 'ui') {
    if (/[qg]$/.test(before)) return 0;
    return /^(n|d$|ds$|c[ia]|ne)/.test(after) ? 1 : 0;                        // ruin, fluid vs build, fruit
  }
  if (g === 'eo') return /[gc]$/.test(before) ? 0 : 1;                        // surgeon vs video
  if (g === 'ao') return 1;                                                   // chaos
  if (/^(ia|io|iu)/.test(g) || /(ia|io|iu)$/.test(g)) {
    if (/^(ia|io|iu)$/.test(g)) {
      if (before.length === 1) return 1;                                      // giant, piano, lion
      if (/(t|s|c|x|g|sh|ss)$/.test(before) && /^(n|l|s|r|nce|nt|ge)/.test(after)) return 0; // nation, special, region
      if (/[lnv]$/.test(b1) && /[aeioul]/.test(b2) && !/^(ble|sm)/.test(after)) return 0;    // million, opinion, behavior
      if (/r$/.test(before) && /^ge/.test(after)) return 0;                  // marriage
    }
    return 1;
  }
  if (/^(ua|uo)$/.test(g)) return /[qg]$/.test(before) ? 0 : 1;             // actual vs quality
  return 0;
}

export function syllables(raw) {
  const p = phonesFor(raw);
  if (p) return p.filter(isVowel).length || 1;
  return heuristicSyllables(raw);
}

export function lineWords(line) {
  return (line.match(/[A-Za-z’'][A-Za-z’'-]*/g) || [])
    .flatMap(t => t.split('-')).filter(t => /[A-Za-z]/.test(t));
}
export function lineSyllables(line) {
  return lineWords(line).reduce((a, w) => a + syllables(w), 0);
}

// ------------------------------------------------------------------ rhymes
// Tail = last stressed vowel onward, stress digits stripped (e.g. night -> AY T).
export function phoneTail(phones) {
  let at = -1;
  for (let i = phones.length - 1; i >= 0; i--) {
    if (/[12]$/.test(phones[i])) { at = i; break; }
  }
  if (at < 0) for (let i = phones.length - 1; i >= 0; i--) if (isVowel(phones[i])) { at = i; break; }
  if (at < 0) return phones.join(' ');
  return phones.slice(at).map(p => p.replace(/\d/, '')).join(' ');
}

// Spelling-based tail for words not in the dictionary.
export function spellTail(raw) {
  let w = cleanWord(raw).replace(/'/g, '');
  if (/in$/.test(w) && /in'$/.test(cleanWord(raw))) w += 'g';
  let e = '';
  if (/[^aeiouy]e$/.test(w) && w.length > 3) { e = 'e'; w = w.slice(0, -1); }
  const m = w.match(/[aeiouy]+[^aeiouy]*$/);
  let t = (m ? m[0] : w) + e;
  // normalise a few spellings that sound the same
  t = t.replace(/^igh/, 'ie').replace(/^ie$/, 'y').replace(/^y$/, 'ie')
       .replace(/ck$/, 'k').replace(/ph/, 'f');
  return 'sp:' + t;
}

export function rhymeKeyOf(raw) {
  const p = phonesFor(raw);
  if (p) return { key: phoneTail(p), dict: true };
  return { key: spellTail(raw), dict: false };
}

const CLASS = {
  M: 'N', N: 'N', NG: 'N', B: 'Bv', D: 'Bv', G: 'Bv', P: 'Pv', T: 'Pv', K: 'Pv',
  F: 'F', V: 'F', TH: 'F', DH: 'F', S: 'S', Z: 'S', SH: 'S', ZH: 'S', CH: 'C', JH: 'C',
  L: 'L', R: 'R', W: 'W', Y: 'W', HH: 'W',
};
const VOWEL_BARE = /^(AA|AE|AH|AO|AW|AY|EH|ER|EY|IH|IY|OW|OY|UH|UW)$/;
function tailSig(tail) {
  return tail.split(' ').map(p => VOWEL_BARE.test(p) ? p : (CLASS[p] || p)).join(' ');
}
function stripFinal(tail) { return tail.replace(/( (S|Z|T|D))+$/, ''); }
function vowelsOf(tail) { return tail.split(' ').filter(p => VOWEL_BARE.test(p)).join(' '); }

// 'perfect' | 'near' | null
export function rhymeKind(a, b) {
  if (!a || !b) return null;
  if (a.key === b.key) return 'perfect';
  if (a.dict && b.dict) {
    if (tailSig(a.key) === tailSig(b.key)) return 'near';
    if (stripFinal(a.key) === stripFinal(b.key)) return 'near';
    const va = vowelsOf(a.key), vb = vowelsOf(b.key);
    // same vowels, codas both end in the same consonant class (time / mind)
    if (va && va === vb) {
      const ca = a.key.split(' ').filter(p => !VOWEL_BARE.test(p));
      const cb = b.key.split(' ').filter(p => !VOWEL_BARE.test(p));
      if (ca.length && cb.length && CLASS[ca[0]] === CLASS[cb[0]]) return 'near';
      if (!ca.length && !cb.length) return 'perfect';
    }
    return null;
  }
  // at least one side spelled: compare spelling tails
  const sa = a.dict ? null : a.key.slice(3), sb = b.dict ? null : b.key.slice(3);
  if (sa && sb) {
    if (sa.replace(/s$/, '') === sb.replace(/s$/, '')) return 'near';
    return null;
  }
  return null;
}
export function wordsRhyme(w1, w2) { return rhymeKind(rhymeKeyOf(w1), rhymeKeyOf(w2)); }

function buildIndex() {
  RHYME_INDEX = new Map();
  WORDS.forEach((w, rank) => {
    if (PROPER && PROPER.has(w)) return;      // names / brands are never suggested
    const phones = DICT.get(w);
    const tail = phoneTail(phones);
    const entry = { w, tail, syl: phones.filter(isVowel).length, rank };
    const k = vowelsOf(tail);
    if (!RHYME_INDEX.has(k)) RHYME_INDEX.set(k, []);
    RHYME_INDEX.get(k).push(entry);
  });
}

// Rhyme finder. Returns {word, known, perfect:{syl:[words]}, near:{syl:[words]}}
export function findRhymes(raw, limitPerGroup = 40) {
  const word = cleanWord(raw).replace(/'$/, '');
  const out = { word, known: false, perfect: {}, near: {} };
  if (!word || !DICT) return out;
  const phones = phonesFor(word);
  if (!phones) return out;
  out.known = true;
  if (!RHYME_INDEX) buildIndex();
  const tail = phoneTail(phones);
  const me = { key: tail, dict: true };
  const bucket = RHYME_INDEX.get(vowelsOf(tail)) || [];
  const base = word.replace(/(s|es|ed|ing|'s)$/, '');
  for (const e of bucket) {
    if (e.w === word) continue;
    if (e.w.startsWith(base) && base.length > 2 && e.w.length - base.length <= 3) continue; // same stem (night/nights)
    const kind = rhymeKind(me, { key: e.tail, dict: true });
    if (!kind) continue;
    // identical sound before the tail too (e.g. "write"/"right") is still a rhyme; keep it
    const g = out[kind];
    const s = Math.min(e.syl, 4);
    (g[s] = g[s] || []);
    if (g[s].length < limitPerGroup) g[s].push(e.w);
  }
  return out;
}

// ----------------------------------------------------------------- analysis
export const SECTION_RE = /^\s*\[([^\]]{1,40})\]\s*$/;
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function lastWord(line) {
  const ws = lineWords(line);
  return ws.length ? ws[ws.length - 1] : '';
}

// Analyse the whole lyric. Returns { lines:[...], sections:[...], stats }
// line: {type:'section'|'blank'|'lyric', text, syl, endWord, letter, group,
//        groupSize, kind, deviant, diff, sectionIdx}
export function analyzeLyrics(text) {
  const raw = String(text || '').split('\n');
  const lines = [];
  const sections = [];
  let cur = null;
  const newSection = (name) => { cur = { name, lines: [], avg: 0, median: 0 }; sections.push(cur); };
  for (const t of raw) {
    const m = t.match(SECTION_RE);
    if (m) {
      newSection(m[1].trim());
      lines.push({ type: 'section', text: t, sectionIdx: sections.length - 1 });
      continue;
    }
    if (!t.trim()) { lines.push({ type: 'blank', text: t }); continue; }
    if (!cur) newSection('');
    const L = { type: 'lyric', text: t, syl: lineSyllables(t), endWord: lastWord(t), sectionIdx: sections.length - 1 };
    cur.lines.push(L);
    lines.push(L);
  }
  let words = 0;
  for (const sec of sections) {
    const syls = sec.lines.map(l => l.syl);
    sec.avg = syls.length ? syls.reduce((a, b) => a + b, 0) / syls.length : 0;
    const sorted = [...syls].sort((a, b) => a - b);
    sec.median = sorted.length ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2) : 0;
    // flag lines far from the section's usual count (only meaningful with 3+ lines)
    for (const l of sec.lines) {
      l.diff = l.syl - sec.median;
      const tol = Math.max(3, Math.round(sec.median * 0.35));
      l.deviant = sec.lines.length >= 3 && Math.abs(l.diff) >= tol;
      words += lineWords(l.text).length;
    }
    // rhyme scheme within the section
    const keys = sec.lines.map(l => l.endWord ? rhymeKeyOf(l.endWord) : null);
    const groups = [];            // {letter, members:[idx]}
    sec.lines.forEach((l, i) => {
      l.kind = null;
      let found = null;
      for (let j = 0; j < i && !found; j++) {
        const kind = rhymeKind(keys[i], keys[j]);
        if (kind) { found = sec.lines[j].group; l.kind = kind; }
      }
      if (found == null) { found = groups.length; groups.push({ letter: LETTERS[found % 26], members: [] }); }
      l.group = found;
      l.letter = groups[found].letter;
      groups[found].members.push(i);
    });
    sec.lines.forEach(l => { l.groupSize = groups[l.group].members.length; });
    sec.scheme = sec.lines.map(l => l.letter).join('');
  }
  const lyricLines = lines.filter(l => l.type === 'lyric').length;
  const named = sections.filter(s => s.name).length;
  const secCount = Math.max(named, sections.length ? 1 : 0);
  const seconds = words / 2.2 + Math.max(0, secCount - 1) * 4;
  return { lines, sections, stats: { words, lines: lyricLines, sections: secCount, seconds } };
}

export function fmtDuration(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
