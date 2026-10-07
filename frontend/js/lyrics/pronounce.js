// Pronunciation check for the Lyric Helper.
//
// The most repeated complaint about AI singers is that they say words wrong — names, numbers
// and words that are spelled one way and said two. You cannot tell the model "say it like
// this", but you CAN spell it the way you want it sung, which is what people already do by
// hand. This module finds the words worth respelling and writes the respelling for you.
//
// Four kinds of risk, in the order they actually bite:
//   heteronym — one spelling, two real pronunciations (read, live, bass). The model picks one
//               and has no way to know which you meant. Respelling is the only fix.
//   number    — digits are read inconsistently: 1999, 3:15, 1st. Spell them as words.
//   acronym   — NASA is a word, DJ is two letters, and nothing in the spelling says which.
//   unknown   — not in the 30k dictionary, so the model is guessing from spelling alone.
//               Usually names and invented words.
//
// Pure functions, no DOM: also imported by tests/pronounce.test.mjs
//   (run: node --test frontend/js/lyrics/tests/pronounce.test.mjs)

import * as P from './prosody.js';

// ── ARPAbet -> something a person can read ──────────────────────────────────
// Deliberately plain English spellings, not IPA: the point is to paste it into lyrics and
// have the model read it the obvious way.
const VOWEL_SPELL = {
  AA: 'ah', AE: 'a', AH: 'uh', AO: 'aw', AW: 'ow', AY: 'eye',
  EH: 'eh', ER: 'ur', EY: 'ay', IH: 'ih', IY: 'ee',
  OW: 'oh', OY: 'oy', UH: 'uu', UW: 'oo',
};
const CONS_SPELL = {
  B: 'b', CH: 'ch', D: 'd', DH: 'th', F: 'f', G: 'g', HH: 'h', JH: 'j', K: 'k',
  L: 'l', M: 'm', N: 'n', NG: 'ng', P: 'p', R: 'r', S: 's', SH: 'sh', T: 't',
  TH: 'th', V: 'v', W: 'w', Y: 'y', Z: 'z', ZH: 'zh',
};

const baseOf = p => String(p).replace(/[012]$/, '');
const stressOf = p => { const m = /([012])$/.exec(String(p)); return m ? +m[1] : -1; };
const isVowelPhone = p => Object.prototype.hasOwnProperty.call(VOWEL_SPELL, baseOf(p));

/** Split phones into syllables, one vowel each.
 *  The consonant immediately before a vowel starts the next syllable ("on-set first"), which
 *  is wrong for a few clusters but reads correctly for the overwhelming majority of words. */
export function syllabify(phones) {
  if (!phones || !phones.length) return [];
  const out = [];
  let cur = [];
  let seenVowel = false;
  for (let i = 0; i < phones.length; i++) {
    const p = phones[i];
    if (isVowelPhone(p)) {
      if (seenVowel) {
        // the last consonant we buffered belongs to this new syllable, not the previous one
        const carry = cur.length && !isVowelPhone(cur[cur.length - 1]) ? cur.pop() : null;
        out.push(cur);
        cur = carry ? [carry] : [];
      }
      seenVowel = true;
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out.filter(s => s.length);
}

/** A readable respelling, e.g. ['M','IH1','N','AH0','T'] -> "MIN-ut".
 *  The stressed syllable is capitalised, which is how people write pronunciations and how
 *  the model is most likely to place the emphasis. */
export function respell(phones) {
  const sylls = syllabify(phones);
  if (!sylls.length) return '';
  const parts = sylls.map(syl => {
    const vi = syl.findIndex(isVowelPhone);
    const nucleus = vi >= 0 ? baseOf(syl[vi]) : null;
    const hasOnset = vi > 0;
    const hasCoda = vi >= 0 && vi < syl.length - 1;
    let out = '';
    syl.forEach((p, i) => {
      const b = baseOf(p);
      if (i === vi) {
        // "eye" only reads right when the vowel opens the syllable: EYE-luhnd is clear but
        // knight came out "neyet". After a consonant it has to be "y", with a silent e to
        // keep it long when something follows it: nyte, not nyt.
        if (b === 'AY') out += hasOnset ? 'y' : 'eye';
        else out += VOWEL_SPELL[b] || '';
      } else {
        out += CONS_SPELL[b] || '';
      }
    });
    if (hasCoda && (nucleus === 'AY' || nucleus === 'EY') && hasOnset) out += 'e';
    return out;
  });
  const stressed = sylls.findIndex(s => s.some(p => stressOf(p) === 1));
  const at = stressed >= 0 ? stressed : 0;
  if (parts.length === 1) return parts[0];
  return parts.map((p, i) => (i === at ? p.toUpperCase() : p)).join('-');
}

// ── heteronyms: one spelling, two readings ──────────────────────────────────
// Curated on purpose. The bundled dictionary keeps a single pronunciation per word, so it
// cannot tell us a word is ambiguous — only a list can.
export const HETERONYMS = {
  read:    [['present tense', 'reed'], ['past tense', 'red']],
  lead:    [['to guide', 'leed'], ['the metal', 'led']],
  live:    [['to be alive', 'liv'], ['live on stage', 'lyve']],
  lives:   [['he lives here', 'livz'], ['their lives', 'lyvez']],
  bass:    [['low sound', 'bayss'], ['the fish', 'bass']],
  tear:    [['from crying', 'teer'], ['to rip', 'tair']],
  tears:   [['from crying', 'teerz'], ['it rips', 'tairz']],
  wind:    [['moving air', 'wind'], ['to wind up', 'wynd']],
  winds:   [['the air', 'windz'], ['it winds', 'wyndz']],
  bow:     [['a knot, or the weapon', 'boh'], ['to bend forward', 'bow']],
  row:     [['a line, or to paddle', 'roh'], ['an argument', 'row']],
  close:   [['near', 'klohss'], ['to shut', 'klohz']],
  dove:    [['the bird', 'duv'], ['dived', 'dohv']],
  does:    [['he does', 'duz'], ['female deer', 'dohz']],
  wound:   [['an injury', 'woond'], ['wrapped around', 'wownd']],
  sow:     [['to plant', 'soh'], ['a female pig', 'sow']],
  minute:  [['sixty seconds', 'MIN-it'], ['tiny', 'my-NYOOT']],
  object:  [['a thing', 'OB-jekt'], ['to protest', 'ob-JEKT']],
  present: [['a gift, or now', 'PREZ-ent'], ['to hand over', 'pre-ZENT']],
  record:  [['a disc', 'REK-ord'], ['to tape', 're-KORD']],
  records: [['the discs', 'REK-ordz'], ['he records', 're-KORDZ']],
  desert:  [['sand', 'DEZ-urt'], ['to abandon', 'de-ZURT']],
  content: [['what is inside', 'KON-tent'], ['satisfied', 'kon-TENT']],
  contest: [['a competition', 'KON-test'], ['to dispute', 'kon-TEST']],
  refuse:  [['rubbish', 'REF-yooss'], ['to decline', 're-FYOOZ']],
  produce: [['vegetables', 'PROH-dooss'], ['to make', 'pro-DOOSS']],
  invalid: [['someone ill', 'IN-vuh-lid'], ['not valid', 'in-VAL-id']],
  polish:  [['to shine', 'POL-ish'], ['from Poland', 'POH-lish']],
  use:     [['a purpose', 'yooss'], ['to use it', 'yooz']],
  uses:    [['the purposes', 'YOO-siz'], ['she uses', 'YOO-ziz']],
  house:   [['a building', 'howss'], ['to house them', 'howz']],
  abuse:   [['the harm', 'uh-BYOOSS'], ['to abuse', 'uh-BYOOZ']],
  excuse:  [['a reason', 'ek-SKYOOSS'], ['to excuse', 'ek-SKYOOZ']],
  separate: [['apart (describing)', 'SEP-ruht'], ['to separate', 'SEP-uh-rayt']],
  moderate: [['not extreme', 'MOD-uh-rut'], ['to moderate', 'MOD-uh-rayt']],
  deliberate: [['on purpose', 'duh-LIB-uh-rut'], ['to think it over', 'duh-LIB-uh-rayt']],
  estimate: [['the figure', 'ES-tuh-mut'], ['to estimate', 'ES-tuh-mayt']],
  graduate: [['the person', 'GRAJ-oo-ut'], ['to graduate', 'GRAJ-oo-ayt']],
  entrance: [['a doorway', 'EN-trunss'], ['to enchant', 'en-TRANSS']],
  console: [['a panel', 'KON-sohl'], ['to comfort', 'kon-SOHL']],
  number:  [['a quantity', 'NUM-ber'], ['more numb', 'NUM-er']],
  tier:    [['a level', 'teer'], ['one who ties', 'TY-er']],
  axes:    [['more than one axe', 'AK-siz'], ['more than one axis', 'AK-seez']],
  bases:   [['more than one base', 'BAY-siz'], ['more than one basis', 'BAY-seez']],
};

// ── numbers -> words ────────────────────────────────────────────────────────
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine',
  'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen',
  'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** 0..999999 as words. Returns '' for anything outside that. */
export function numberToWords(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0 || n > 999999 || Math.floor(n) !== n) return '';
  if (n < 20) return ONES[n];
  if (n < 100) {
    const t = TENS[Math.floor(n / 10)];
    const r = n % 10;
    return r ? `${t}-${ONES[r]}` : t;
  }
  if (n < 1000) {
    const h = `${ONES[Math.floor(n / 100)]} hundred`;
    const r = n % 100;
    return r ? `${h} ${numberToWords(r)}` : h;
  }
  const th = `${numberToWords(Math.floor(n / 1000))} thousand`;
  const r = n % 1000;
  return r ? `${th} ${numberToWords(r)}` : th;
}

/** How a 4-digit year is actually sung: 1999 -> "nineteen ninety-nine", 2003 -> "two thousand three". */
export function yearToWords(n) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 1000 || n > 2999) return '';
  const hi = Math.floor(n / 100), lo = n % 100;
  if (lo === 0) return `${numberToWords(hi)} hundred`;
  if (hi % 10 === 0 && lo < 10) return numberToWords(n);          // 2003 -> two thousand three
  if (lo < 10) return `${numberToWords(hi)} oh ${numberToWords(lo)}`;   // 1905 -> nineteen oh five
  return `${numberToWords(hi)} ${numberToWords(lo)}`;
}

const LETTER = {
  a: 'ay', b: 'bee', c: 'see', d: 'dee', e: 'ee', f: 'eff', g: 'gee', h: 'aitch', i: 'eye',
  j: 'jay', k: 'kay', l: 'ell', m: 'em', n: 'en', o: 'oh', p: 'pee', q: 'cue', r: 'ar',
  s: 'ess', t: 'tee', u: 'you', v: 'vee', w: 'double-you', x: 'ex', y: 'why', z: 'zee',
};
export function spellOutLetters(word) {
  return String(word).toLowerCase().split('')
    .filter(c => LETTER[c]).map(c => LETTER[c]).join('-');
}

// ── the scan ────────────────────────────────────────────────────────────────
const SECTION_RE = /^\s*\[[^\]]{1,40}\]\s*$/;
// words we never flag as unknown: too short to mispronounce, or deliberate lyric spellings
const SAFE_SHORT = new Set(['a', 'i', 'o', 'oh', 'ah', 'uh', 'mm', 'hm', 'la', 'na', 'da',
  'yeah', 'yea', 'ooh', 'woo', 'hey', 'ay', 'ya', 'em', 'im', 'ol', 'lil']);

/** Every token in the text, with the line it came from. */
function tokens(text) {
  const out = [];
  String(text || '').split('\n').forEach((line, li) => {
    if (SECTION_RE.test(line)) return;                       // [Verse] is a marker, not sung
    const re = /[A-Za-z][A-Za-z'’]*|\d[\d:.,]*\d|\d/g;
    let m;
    while ((m = re.exec(line)) !== null) out.push({ raw: m[0], line: li + 1, at: m.index });
  });
  return out;
}

/**
 * Words in `text` that are worth respelling, most useful first.
 * Each risk: {word, kind, why, options:[{label, text}], line, count}
 */
export function pronunciationRisks(text) {
  const found = new Map();                 // key -> risk (one entry per distinct word)
  for (const t of tokens(text)) {
    const rawLower = t.raw.toLowerCase();
    const w = P.cleanWord(t.raw);

    // numbers first: they are tokens, not dictionary words
    if (/^\d/.test(t.raw)) {
      const key = `num:${t.raw}`;
      if (found.has(key)) { found.get(key).count++; continue; }
      const opts = [];
      const plain = t.raw.replace(/[^\d]/g, '');
      if (/^\d{4}$/.test(t.raw)) {
        const y = yearToWords(+t.raw);
        if (y) opts.push({ label: 'as a year', text: y });
      }
      const asNum = numberToWords(+plain);
      if (asNum) opts.push({ label: 'as a number', text: asNum });
      if (/^\d+:\d+$/.test(t.raw)) {
        const [h, mn] = t.raw.split(':').map(Number);
        const mw = mn === 0 ? "o'clock" : (mn < 10 ? `oh ${numberToWords(mn)}` : numberToWords(mn));
        if (numberToWords(h)) opts.push({ label: 'as a time', text: `${numberToWords(h)} ${mw}` });
      }
      if (!opts.length) continue;
      found.set(key, {
        word: t.raw, kind: 'number', line: t.line, count: 1,
        why: 'Digits get read inconsistently — spell them the way you want them sung.',
        options: opts,
      });
      continue;
    }

    if (!w) continue;

    // heteronym: the model cannot know which one you meant
    if (HETERONYMS[w]) {
      const key = `het:${w}`;
      if (found.has(key)) { found.get(key).count++; continue; }
      found.set(key, {
        word: t.raw, kind: 'heteronym', line: t.line, count: 1,
        why: 'Two real pronunciations share this spelling. Respell the one you mean.',
        options: HETERONYMS[w].map(([label, text]) => ({ label, text })),
      });
      continue;
    }

    // acronym: original casing matters, so test the raw token
    if (/^[A-Z]{2,5}$/.test(t.raw) && !P.phonesFor(t.raw)) {
      const key = `acr:${rawLower}`;
      if (found.has(key)) { found.get(key).count++; continue; }
      found.set(key, {
        word: t.raw, kind: 'acronym', line: t.line, count: 1,
        why: 'Nothing in the spelling says whether this is said as letters or as a word.',
        options: [{ label: 'as letters', text: spellOutLetters(t.raw) }],
      });
      continue;
    }

    // unknown: not in the dictionary, so the model is guessing from spelling
    if (!P.hasDict()) continue;
    if (w.length < 3 || SAFE_SHORT.has(w)) continue;
    if (!P.phonesFor(t.raw)) {
      const key = `unk:${w}`;
      if (found.has(key)) { found.get(key).count++; continue; }
      found.set(key, {
        word: t.raw, kind: 'unknown', line: t.line, count: 1,
        why: 'Not in the pronunciation dictionary, so the singer is guessing from the '
           + 'spelling. Names and invented words land here.',
        options: [],              // nothing honest to suggest; the writer knows how it sounds
      });
    }
  }

  // heteronyms and numbers are actionable, unknowns are only a warning, so sort that way
  const rank = { heteronym: 0, number: 1, acronym: 2, unknown: 3 };
  return [...found.values()].sort((a, b) =>
    (rank[a.kind] - rank[b.kind]) || (b.count - a.count) || (a.line - b.line));
}

/** The respelling we would suggest for a word we DO know, for the "how will this be sung?"
 *  lookup. Returns '' when the word is not in the dictionary. */
export function respellWord(raw) {
  const phones = P.phonesFor(raw);
  return phones ? respell(phones) : '';
}
