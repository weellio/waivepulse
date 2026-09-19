// ── captions.js — pure caption / timed-lyric formatters ───────────────────────
// No DOM, no state: everything here takes plain data and returns strings, so it
// runs in node for the unit tests (js/karaoke/tests/captions.test.mjs).
//
// Input words come from the backend's /transcribe/status/{sep}: one entry per
// lyric word ({word,start,end} seconds) in lyric order (LCS-aligned when the
// song has lyrics, raw Whisper words when it doesn't).

export const MAX_CHARS = 42;      // YouTube / broadcast line length
export const MAX_LINES = 2;       // lines per cue
export const MIN_CUE = 0.7;       // seconds
export const HOLD_AFTER = 1.5;    // seconds a cue may linger after its last word

const SECTION_RE = /^\[.*\]$/;

// ── Timestamp formatting ─────────────────────────────────────────────────────
const _cs = s => Math.max(0, Math.round((Number(s) || 0) * 100));   // centiseconds
const _ms = s => Math.max(0, Math.round((Number(s) || 0) * 1000));  // milliseconds
const p2 = n => String(n).padStart(2, '0');
const p3 = n => String(n).padStart(3, '0');

/** LRC time "mm:ss.xx". Minutes keep counting past 59 (61:05.00) — LRC has no hour field. */
export function fmtLrcTime(sec) {
  const cs = _cs(sec);
  const m = Math.floor(cs / 6000), s = Math.floor(cs / 100) % 60, c = cs % 100;
  return `${p2(m)}:${p2(s)}.${p2(c)}`;
}
function _hms(sec, sep) {
  const ms = _ms(sec);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60;
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${p3(ms % 1000)}`;
}
/** SRT time "HH:MM:SS,mmm". */
export const fmtSrtTime = sec => _hms(sec, ',');
/** WebVTT time "HH:MM:SS.mmm". */
export const fmtVttTime = sec => _hms(sec, '.');

// ── Lyrics → lines ───────────────────────────────────────────────────────────
/** Lyric lines as word arrays, skipping blank lines and [Section] markers
 *  (mirrors backend _extract_lyric_words so word counts line up). */
export function lyricLines(text) {
  const out = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || SECTION_RE.test(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    if (words.length) out.push(words);
  }
  return out;
}

/** Drop padding/blank words, coerce numbers, and force start times to be
 *  non-decreasing with end >= start (interpolated words can go backwards). */
export function cleanWords(words) {
  const out = [];
  let t = 0;
  for (const w of words || []) {
    if (!w || !String(w.word || '').trim()) continue;
    let start = Number(w.start), end = Number(w.end);
    if (!Number.isFinite(start)) start = t;
    if (!Number.isFinite(end)) end = start;
    start = Math.max(start, t);
    end = Math.max(end, start);
    out.push({ word: String(w.word).trim(), start, end });
    t = start;
  }
  return out;
}

/** True when the words carry real timings (not the all-zero fallback the
 *  backend writes when nothing matched). */
export function hasUsableTimings(words) {
  const w = cleanWords(words);
  if (!w.length) return false;
  return w[w.length - 1].end > 1 && new Set(w.map(x => x.start)).size > Math.min(3, w.length - 1);
}

/** Group timed words into lines. When the lyric text's word count equals the
 *  word list (the LCS-aligned case), each lyric line gets its own words. Other
 *  cases (no lyrics, raw transcript) fall back to phrase grouping on pauses. */
export function groupLines(words, lyricsText = '') {
  const w = cleanWords(words);
  const lines = lyricLines(lyricsText);
  const total = lines.reduce((n, l) => n + l.length, 0);
  if (lines.length && total === w.length) {
    let i = 0;
    return lines.map(l => {
      const lw = w.slice(i, i + l.length); i += l.length;
      return { text: lw.map(x => x.word).join(' '), words: lw, start: lw[0].start, end: lw[lw.length - 1].end };
    });
  }
  // Fallback: break on a gap > 0.9 s, or after sentence punctuation, or at 10 words.
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) out.push({ text: cur.map(x => x.word).join(' '), words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
    cur = [];
  };
  for (let i = 0; i < w.length; i++) {
    if (cur.length && (w[i].start - cur[cur.length - 1].end > 0.9 || cur.length >= 10)) flush();
    cur.push(w[i]);
    if (/[.!?]$/.test(w[i].word)) flush();
  }
  flush();
  return out;
}

// ── Line wrapping / splitting ────────────────────────────────────────────────
/** Greedy wrap of a word list into text lines of <= maxChars. Returns arrays of
 *  word indices so timings can follow. A single over-long word gets its own line. */
function _wrapIdx(words, maxChars) {
  const rows = [];
  let row = [], len = 0;
  words.forEach((w, i) => {
    const add = (row.length ? 1 : 0) + w.length;
    if (row.length && len + add > maxChars) { rows.push(row); row = []; len = 0; }
    len += (row.length ? 1 : 0) + w.length;
    row.push(i);
  });
  if (row.length) rows.push(row);
  return rows;
}

/** Balanced split of a word list into exactly 2 lines, each <= maxChars when
 *  possible (picks the break that minimises the longer line). */
function _balance2(words, maxChars) {
  let best = null;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(' '), b = words.slice(k).join(' ');
    const worst = Math.max(a.length, b.length);
    if (!best || worst < best.worst) best = { worst, a, b };
  }
  return best && best.worst <= maxChars ? [best.a, best.b] : null;
}

/** Split one timed line into cue-sized chunks: each chunk renders as <= maxLines
 *  lines of <= maxChars. Returns [{words:[...], lines:[text,...]}]. */
export function splitLine(lineWords, { maxChars = MAX_CHARS, maxLines = MAX_LINES } = {}) {
  const texts = lineWords.map(w => w.word);
  const full = texts.join(' ');
  if (full.length <= maxChars) return [{ words: lineWords, lines: [full] }];
  if (maxLines >= 2) {
    const two = _balance2(texts, maxChars);
    if (two) return [{ words: lineWords, lines: two }];
  }
  // Too long for one cue: wrap into rows, then pack rows into cues, balancing
  // so the last cue isn't a lonely word when we can avoid it.
  const rows = _wrapIdx(texts, maxChars);
  const nCues = Math.ceil(rows.length / maxLines);
  const perCue = Math.ceil(texts.length / nCues);
  if (perCue >= texts.length) {
    // Can't shrink further (an over-long single word): emit the greedy rows as-is.
    const out = [];
    for (let r = 0; r < rows.length; r += maxLines) {
      const grp = rows.slice(r, r + maxLines);
      out.push({ words: grp.flat().map(i => lineWords[i]), lines: grp.map(g => g.map(i => texts[i]).join(' ')) });
    }
    return out;
  }
  const out = [];
  for (let i = 0; i < texts.length; i += perCue) {
    const chunk = lineWords.slice(i, i + perCue);
    out.push(...splitLine(chunk, { maxChars, maxLines }));
  }
  return out;
}

// ── Cue timing ───────────────────────────────────────────────────────────────
/** Build caption cues from grouped lines.
 *  start = first word; end = min(next cue start, last word end + hold);
 *  cues never overlap and last >= minCue (pushing the next cue's start later
 *  when two land too close). */
export function buildCues(lines, { maxChars = MAX_CHARS, maxLines = MAX_LINES, minCue = MIN_CUE, hold = HOLD_AFTER, duration = 0 } = {}) {
  const raw = [];
  for (const ln of lines || []) {
    if (!ln.words || !ln.words.length) continue;
    for (const part of splitLine(ln.words, { maxChars, maxLines })) {
      raw.push({ start: part.words[0].start, lastEnd: part.words[part.words.length - 1].end, text: part.lines.join('\n') });
    }
  }
  const cues = [];
  let prevEnd = 0;
  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const start = Math.max(r.start, prevEnd);
    const nextStart = i + 1 < raw.length ? raw[i + 1].start : Infinity;
    let end = Math.min(nextStart, Math.max(r.lastEnd, start) + hold);
    if (duration > 0 && i === raw.length - 1) end = Math.min(end, Math.max(duration, start + minCue));
    end = Math.max(end, start + minCue);
    cues.push({ start: _r3(start), end: _r3(end), text: r.text });
    prevEnd = _r3(end);
  }
  return cues;
}
const _r3 = x => Math.round(x * 1000) / 1000;

// ── Output formats ───────────────────────────────────────────────────────────
/** SRT text (CRLF-free; YouTube and players accept LF). */
export function buildSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${fmtSrtTime(c.start)} --> ${fmtSrtTime(c.end)}\n${c.text}\n`).join('\n');
}
/** WebVTT text. */
export function buildVtt(cues) {
  return 'WEBVTT\n\n' + cues.map(c => `${fmtVttTime(c.start)} --> ${fmtVttTime(c.end)}\n${c.text}\n`).join('\n');
}
/** Enhanced LRC: header tags, one [mm:ss.xx] line per lyric line, and
 *  optional word-level <mm:ss.xx> tags. */
export function buildLrc(lines, { title = '', artist = '', duration = 0, wordTags = true } = {}) {
  const head = [];
  const tag = s => String(s).replace(/[\[\]\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  if (title) head.push(`[ti:${tag(title)}]`);
  if (artist) head.push(`[ar:${tag(artist)}]`);
  if (duration > 0) {
    const s = Math.round(duration);
    head.push(`[length:${p2(Math.floor(s / 60))}:${p2(s % 60)}]`);
  }
  head.push('[re:WAIvePulse]');
  const body = (lines || []).filter(l => l.words && l.words.length).map(l => {
    const t = `[${fmtLrcTime(l.words[0].start)}]`;
    if (!wordTags) return t + l.text;
    return t + l.words.map(w => `<${fmtLrcTime(w.start)}>${w.word}`).join(' ') + ` <${fmtLrcTime(l.words[l.words.length - 1].end)}>`;
  });
  return head.concat(body).join('\n') + '\n';
}
/** Plain timed lyrics for the clipboard: "[m:ss] line". */
export function buildTimedText(lines) {
  return (lines || []).filter(l => l.words && l.words.length).map(l => {
    const s = Math.floor(l.words[0].start);
    const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, ss = s % 60;
    return `[${h ? h + ':' + p2(m) : m}:${p2(ss)}] ${l.text}`;
  }).join('\n') + '\n';
}

/** Safe file stem from a song title. */
export function fileStem(title) {
  return (String(title || 'lyrics').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim() || 'lyrics').slice(0, 80);
}
