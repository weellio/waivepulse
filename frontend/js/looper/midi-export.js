// ── MIDI Export ───────────────────────────────────────────────────────────────
// Exports the piano roll + drum sequencer pattern as a Standard MIDI File
// (Format 1, 480 PPQN). Pure vanilla JS — no dependencies.
//
// buildSMF() is pure (no DOM, no audio) so MIDI import can be round-trip tested
// against it under node; exportMIDI() is the button wrapper that downloads it.
// With Chain on, every bar of the chain is written in order (bank by bank).
import { S } from './state.js';
import { setStatus } from './util.js';
import { PAD_TO_GM } from './gm.js';

export const PPQN = 480;       // ticks per quarter note
const STEP_TICKS = 120;        // 16th note = PPQN / 4
const BAR_TICKS  = STEP_TICKS * 16;

// GM drum map: row index → MIDI note (kept as an export for older imports)
export const DRUM_MAP = PAD_TO_GM;

// Marker the importer reads back so a round trip lands on the exact swung grid.
export const SWING_MARKER = 'WAIvePulse swing=';

// Swing in ticks: odd 16ths are pushed late by swing × ⅓ step (same as playback).
// Humanize is a live-feel effect and is NOT written to the file; probability steps
// are exported as always-on (a DAW has no per-note chance), ratchets as real hits.
const swingTicksFor = (swing, step) => (step % 2 === 1) ? Math.round((swing || 0) * STEP_TICKS / 3) : 0;

// ── Binary helpers ────────────────────────────────────────────────────────────

/** Variable-length quantity encoding (MIDI standard) */
function vlq(value) {
  if (value < 0) value = 0;
  const bytes = [];
  bytes.push(value & 0x7F);
  value >>>= 7;
  while (value > 0) {
    bytes.push((value & 0x7F) | 0x80);
    value >>>= 7;
  }
  bytes.reverse();
  return bytes;
}

function u16(v) { return [(v >>> 8) & 0xFF, v & 0xFF]; }
function u32(v) { return [(v >>> 24) & 0xFF, (v >>> 16) & 0xFF, (v >>> 8) & 0xFF, v & 0xFF]; }
function str(s) { return Array.from(s).map(c => c.charCodeAt(0)); }

/** Build one MIDI track chunk (MTrk) from an array of raw event bytes. */
function buildTrack(events) {
  let len = 0;
  for (const e of events) len += e.length;
  const header = [...str('MTrk'), ...u32(len)];
  const chunk = new Uint8Array(header.length + len);
  chunk.set(header, 0);
  let off = header.length;
  for (const e of events) { chunk.set(e, off); off += e.length; }
  return chunk;
}

/** Create a delta-time + event byte sequence */
function evt(delta, ...bytes) { return [...vlq(delta), ...bytes]; }

function noteEventsToTrack(name, noteEvents, onStatus, offStatus) {
  const events = [];
  const nm = str(name);
  events.push(evt(0, 0xFF, 0x03, nm.length, ...nm));
  // Sort by tick; note-offs before note-ons at the same tick to avoid overlaps
  noteEvents.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));
  let lastTick = 0;
  for (const ne of noteEvents) {
    const delta = ne.tick - lastTick;
    events.push(ne.type === 'on' ? evt(delta, onStatus, ne.midi, ne.vel) : evt(delta, offStatus, ne.midi, 0));
    lastTick = ne.tick;
  }
  events.push(evt(0, 0xFF, 0x2F, 0x00));
  return buildTrack(events);
}

// ── Pure builder ──────────────────────────────────────────────────────────────
// bars: [{ runs:[{midi,start,len}], seqPattern:8×16 vel, seqRatchet:8×16 }] — one
// entry per bar (a single bar normally, the whole chain when Chain is on).
export function buildSMF({ bpm, swing = 0, bars }) {
  const stepTick = (bar, step) => bar * BAR_TICKS + step * STEP_TICKS + swingTicksFor(swing, step);

  // tempo track
  const t = [];
  const uspqn = Math.round(60000000 / bpm);
  t.push(evt(0, 0xFF, 0x51, 0x03, (uspqn >>> 16) & 0xFF, (uspqn >>> 8) & 0xFF, uspqn & 0xFF));
  t.push(evt(0, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08));   // 4/4
  const nm = str('Tempo');
  t.push(evt(0, 0xFF, 0x03, nm.length, ...nm));
  if (swing) { const mk = str(SWING_MARKER + (+swing).toFixed(3)); t.push(evt(0, 0xFF, 0x01, mk.length, ...mk)); }
  t.push(evt(0, 0xFF, 0x2F, 0x00));
  const tempoTrack = buildTrack(t);

  // melody (channel 1)
  const mel = [];
  bars.forEach((b, bi) => {
    for (const r of b.runs || []) {
      mel.push({ tick: stepTick(bi, r.start), type: 'on', midi: r.midi, vel: 100 });
      mel.push({ tick: stepTick(bi, r.start + r.len), type: 'off', midi: r.midi, vel: 0 });
    }
  });

  // drums (channel 10)
  const drm = [];
  bars.forEach((b, bi) => {
    const pat = b.seqPattern || [];
    for (let row = 0; row < 8; row++) {
      const midiNote = PAD_TO_GM[row];
      for (let step = 0; step < 16; step++) {
        const vel = pat[row]?.[step];
        if (!vel) continue;
        const t0   = stepTick(bi, step);
        const span = stepTick(bi, step + 1) - t0;          // swung step length
        const rat  = Math.max(1, Math.min(4, b.seqRatchet?.[row]?.[step] ?? 1));
        for (let h = 0; h < rat; h++) {                    // ratchet = N evenly split hits
          const onTick  = t0 + Math.round(h * span / rat);
          const offTick = t0 + Math.round((h + 1) * span / rat);
          const midiVel = Math.max(1, Math.min(127, Math.round(vel * (h ? 0.8 : 1) * 127)));
          drm.push({ tick: onTick, type: 'on', midi: midiNote, vel: midiVel });
          drm.push({ tick: offTick, type: 'off', midi: midiNote, vel: 0 });
        }
      }
    }
  });

  const tracks = [tempoTrack];
  if (mel.length) tracks.push(noteEventsToTrack('Piano Roll', mel, 0x90, 0x80));
  if (drm.length) tracks.push(noteEventsToTrack('Drums', drm, 0x99, 0x89));
  if (tracks.length === 1) return null;

  const header = [...str('MThd'), ...u32(6), ...u16(1), ...u16(tracks.length), ...u16(PPQN)];
  let total = header.length;
  for (const tr of tracks) total += tr.length;
  const out = new Uint8Array(total);
  out.set(header, 0);
  let off = header.length;
  for (const tr of tracks) { out.set(tr, off); off += tr.length; }
  out.hasMelody = mel.length > 0;
  out.hasDrums  = drm.length > 0;
  return out;
}

// ── Public export (button) ────────────────────────────────────────────────────
// getBars() is supplied by main.js (current pattern, or the chain's bars) so this
// module stays free of DOM/audio imports.
let barsProvider = null;
export function setMidiBarsProvider(fn) { barsProvider = fn; }

export function exportMIDI() {
  const bars = barsProvider ? barsProvider() : [];
  if (!bars.length) return;                         // provider already said why (e.g. a bad chain)
  const bytes = buildSMF({ bpm: S.bpm, swing: S.swing, bars });
  if (!bytes) { setStatus('Nothing to export — add notes to the piano roll or drum sequencer'); return; }

  const blob = new Blob([bytes], { type: 'audio/midi' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = (S.projectName || 'waivepulse_loop').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') + '.mid';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 30000);

  const parts = [];
  if (bytes.hasMelody) parts.push('piano roll');
  if (bytes.hasDrums)  parts.push('drums');
  setStatus('Exported MIDI (' + parts.join(' + ') + (bars.length > 1 ? `, ${bars.length}-bar chain` : '') + ') at ' + S.bpm + ' BPM');
}
