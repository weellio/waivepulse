// ── Standard MIDI File reader + grid mapping (pure; node-testable) ────────────
//   parseSMF(bytes)  -> { format, ppqn, bpm, swing, timeSig, notes:[{tick,off,ch,note,vel}], trackNames }
//   smfToPatterns(parsed, { lowMidi, rows, steps, maxBars })
//                    -> { bpm, bars:[{ seq, prob, rat, roll }], totalBars, drumHits, melodyNotes, folded, clippedBars }
//
// Parser: format 0/1 (format 2 is read like 1), running status, sysex skip,
// meta tempo / time signature / text. Channel 10 (index 9) = drums.
// Mapping: every note snaps to the nearest 16th (on the swung grid if the file
// carries a WAIvePulse swing marker). Drum hits that fall BETWEEN grid lines,
// inside the previous hit's step, become ratchets (2–4 hits per step). Melody
// notes fold by octaves into the roll's range; each 16-step slice = one bar.
import { gmToPad } from './gm.js';

const SWING_MARKER = 'WAIvePulse swing=';

function readVlq(b, p) {
  let v = 0, c;
  do { c = b[p++]; v = (v << 7) | (c & 0x7F); } while (c & 0x80 && p < b.length);
  return [v >>> 0, p];
}

export function parseSMF(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const tag = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const u32 = o => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const u16 = o => (b[o] << 8) | b[o + 1];
  // RIFF-wrapped MIDI (.rmi) → skip to the MThd chunk
  let p = 0;
  if (tag(0) === 'RIFF') { const i = findTag(b, 'MThd'); if (i < 0) throw new Error('No MIDI data in RIFF file'); p = i; }
  if (tag(p) !== 'MThd') throw new Error('Not a MIDI file (no MThd header)');
  const hlen = u32(p + 4);
  const format = u16(p + 8), ntrks = u16(p + 10), div = u16(p + 12);
  let ppqn;
  if (div & 0x8000) {                        // SMPTE: ticks/second → treat as 120 BPM quarters
    const fps = 256 - (div >> 8), tpf = div & 0xFF;
    ppqn = Math.max(1, Math.round(fps * tpf / 2));
  } else ppqn = div || 480;
  p += 8 + hlen;

  const notes = [], tempos = [], trackNames = [];
  let timeSig = null, swing = null;
  for (let t = 0; t < ntrks && p + 8 <= b.length; t++) {
    // skip unknown chunks
    while (p + 8 <= b.length && tag(p) !== 'MTrk') p += 8 + u32(p + 4);
    if (p + 8 > b.length) break;
    const len = u32(p + 4), end = Math.min(b.length, p + 8 + len);
    let q = p + 8, tick = 0, status = 0;
    const open = new Map();                  // (ch<<7|note) → [noteObj…] FIFO
    while (q < end) {
      let d; [d, q] = readVlq(b, q); tick += d;
      let s = b[q];
      if (s & 0x80) { q++; if (s < 0xF0) status = s; }
      else s = status;                        // running status: reuse, data byte not consumed
      if (s === 0xFF) {                       // meta
        const type = b[q++]; let ml; [ml, q] = readVlq(b, q);
        const data = b.subarray(q, q + ml); q += ml;
        if (type === 0x51 && ml >= 3) tempos.push({ tick, uspqn: (data[0] << 16) | (data[1] << 8) | data[2] });
        else if (type === 0x58 && ml >= 2 && !timeSig) timeSig = { num: data[0], den: 1 << data[1] };
        else if (type >= 0x01 && type <= 0x07) {
          const txt = String.fromCharCode(...data);
          if (type === 0x03) trackNames.push(txt);
          if (txt.startsWith(SWING_MARKER)) { const v = parseFloat(txt.slice(SWING_MARKER.length)); if (isFinite(v)) swing = Math.max(0, Math.min(1, v)); }
        } else if (type === 0x2F) break;
        continue;
      }
      if (s === 0xF0 || s === 0xF7) { let sl; [sl, q] = readVlq(b, q); q += sl; continue; }
      if (!(s & 0x80)) { q++; continue; }     // garbage before any status byte
      const type = s & 0xF0, ch = s & 0x0F;
      const one = type === 0xC0 || type === 0xD0;
      const d1 = b[q++], d2 = one ? 0 : b[q++];
      const key = (ch << 7) | d1;
      if (type === 0x90 && d2 > 0) {
        const n = { tick, off: null, ch, note: d1, vel: d2 };
        notes.push(n);
        if (!open.has(key)) open.set(key, []);
        open.get(key).push(n);
      } else if (type === 0x80 || (type === 0x90 && d2 === 0)) {
        const list = open.get(key);
        if (list && list.length) list.shift().off = tick;
      }
    }
    for (const list of open.values()) for (const n of list) if (n.off == null) n.off = tick;   // unterminated → track end
    p = end;
  }
  notes.sort((a, b2) => a.tick - b2.tick || a.note - b2.note);
  tempos.sort((a, b2) => a.tick - b2.tick);
  const bpm = tempos.length ? Math.round(60000000 / tempos[0].uspqn * 100) / 100 : null;
  return { format, ntrks, ppqn, bpm, tempos, timeSig, swing, notes, trackNames };
}

function findTag(b, t) {
  outer: for (let i = 0; i + 4 <= b.length; i++) {
    for (let k = 0; k < 4; k++) if (b[i + k] !== t.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}

const empty = (r, c, v) => Array.from({ length: r }, () => new Array(c).fill(v));

export function smfToPatterns(parsed, { lowMidi = 48, rows = 24, steps = 16, maxBars = 4 } = {}) {
  const stepT = parsed.ppqn / 4;
  const swing = parsed.swing || 0;
  const swingT = Math.round(swing * stepT / 3);
  const gridTick = k => k * stepT + (k % 2 === 1 ? swingT : 0);
  const nearest = tick => {
    const k0 = Math.round(tick / stepT);
    let best = Math.max(0, k0 - 1), bd = Infinity;
    for (let k = Math.max(0, k0 - 1); k <= k0 + 1; k++) {
      const d = Math.abs(tick - gridTick(k));
      if (d < bd) { bd = d; best = k; }
    }
    return { k: best, d: bd };
  };
  // exact grid when the file came from WAIvePulse (swing marker), else a little slack
  const tol = parsed.swing != null ? 3 : stepT / 8;

  const drums = parsed.notes.filter(n => n.ch === 9);
  const mel   = parsed.notes.filter(n => n.ch !== 9);

  // ── drums: group hits per pad row; between-grid hits = ratchets ──
  const drumGroups = [];                     // { row, k, count, vel }
  const byRow = Array.from({ length: 8 }, () => []);
  for (const n of drums) byRow[gmToPad(n.note)].push(n);
  byRow.forEach((hits, row) => {
    hits.sort((a, b) => a.tick - b.tick);
    const groups = new Map();                // k → { tick, span, count }
    let prev = null;
    for (const h of hits) {
      const { k, d } = nearest(h.tick);
      let g = null;
      if (d <= tol) g = groups.get(k) || null;                                      // same step again
      else if (prev && h.tick < prev.tick + prev.span) g = prev;                    // inside the previous step
      else g = groups.get(k) || null;
      if (g) { g.count = Math.min(4, g.count + 1); continue; }
      g = { row, k, tick: gridTick(k), span: gridTick(k + 1) - gridTick(k), count: 1, vel: h.vel };
      groups.set(k, g); prev = g;
    }
    drumGroups.push(...groups.values());
  });
  const melK = mel.map(n => ({ n, k: nearest(n.tick).k }));

  let lastK = -1;
  for (const g of drumGroups) lastK = Math.max(lastK, g.k);
  for (const m of melK) lastK = Math.max(lastK, m.k);
  const totalBars = lastK < 0 ? 0 : Math.floor(lastK / steps) + 1;
  const nBars = Math.max(1, Math.min(maxBars, totalBars));
  const bars = Array.from({ length: nBars }, () => ({
    seq: empty(8, steps, 0), prob: empty(8, steps, 1), rat: empty(8, steps, 1), roll: empty(rows, steps, 0),
  }));

  let drumHits = 0;
  for (const g of drumGroups) {
    const bar = Math.floor(g.k / steps), step = g.k % steps;
    if (bar >= nBars) continue;
    bars[bar].seq[g.row][step] = Math.max(0.1, Math.round(g.vel / 127 * 100) / 100);
    bars[bar].rat[g.row][step] = g.count;
    drumHits++;
  }

  // ── melody: nearest 16th, octave-fold into the roll's range, clip at the bar ──
  const hiMidi = lowMidi + rows - 1;
  let melodyNotes = 0, folded = 0;
  for (const { n, k } of melK) {
    const bar = Math.floor(k / steps), step = k % steps;
    if (bar >= nBars) continue;
    let kEnd = nearest(n.off ?? n.tick).k;
    let len = Math.max(1, kEnd - k);
    len = Math.min(len, steps - step);
    let m = n.note;
    if (m < lowMidi || m > hiMidi) folded++;
    while (m < lowMidi) m += 12;
    while (m > hiMidi) m -= 12;
    const r = hiMidi - m;
    for (let i = 0; i < len; i++) bars[bar].roll[r][step + i] = 1;
    melodyNotes++;
  }

  return { bpm: parsed.bpm, swing: parsed.swing, bars, totalBars, drumHits, melodyNotes, folded, clippedBars: Math.max(0, totalBars - nBars) };
}
