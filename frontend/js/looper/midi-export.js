// ── MIDI Export ───────────────────────────────────────────────────────────────
// Exports the piano roll + drum sequencer pattern as a Standard MIDI File
// (Format 1, 480 PPQN). Pure vanilla JS — no dependencies.
import { S } from './state.js';
import { setStatus } from './util.js';
import { pseqRuns } from './pianoseq.js';

const PPQN = 480;              // ticks per quarter note
const STEP_TICKS = 120;        // 16th note = PPQN / 4

// GM drum map: row index → MIDI note
const DRUM_MAP = [36, 38, 42, 46, 39, 45, 35, 56];

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

/** Build one MIDI track chunk (MTrk) from an array of raw event bytes. */
function buildTrack(events) {
  // events is an array of Uint8Arrays or plain arrays
  let len = 0;
  for (const e of events) len += e.length;
  const header = [...str('MTrk'), ...u32(len)];
  const chunk = new Uint8Array(header.length + len);
  chunk.set(header, 0);
  let off = header.length;
  for (const e of events) {
    chunk.set(e, off);
    off += e.length;
  }
  return chunk;
}

function str(s) { return Array.from(s).map(c => c.charCodeAt(0)); }

/** Create a delta-time + event byte sequence */
function evt(delta, ...bytes) {
  return [...vlq(delta), ...bytes];
}

// ── Track builders ────────────────────────────────────────────────────────────

function buildTempoTrack() {
  const events = [];
  // Tempo meta-event: FF 51 03 tt tt tt (microseconds per quarter note)
  const uspqn = Math.round(60000000 / S.bpm);
  events.push(evt(0, 0xFF, 0x51, 0x03,
    (uspqn >>> 16) & 0xFF, (uspqn >>> 8) & 0xFF, uspqn & 0xFF));
  // Time signature: 4/4, 24 MIDI clocks per metronome tick, 8 32nds per quarter
  events.push(evt(0, 0xFF, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08));
  // Track name
  const name = str('Tempo');
  events.push(evt(0, 0xFF, 0x03, name.length, ...name));
  // End of track
  events.push(evt(0, 0xFF, 0x2F, 0x00));
  return buildTrack(events);
}

function buildMelodyTrack() {
  const events = [];
  const name = str('Piano Roll');
  events.push(evt(0, 0xFF, 0x03, name.length, ...name));

  const runs = pseqRuns();
  if (runs.length === 0) return null;

  // Collect note-on and note-off events, then sort by absolute tick
  const noteEvents = [];
  for (const r of runs) {
    const onTick  = r.start * STEP_TICKS;
    const offTick = onTick + r.len * STEP_TICKS;
    noteEvents.push({ tick: onTick,  type: 'on',  midi: r.midi, vel: 100 });
    noteEvents.push({ tick: offTick, type: 'off', midi: r.midi, vel: 0 });
  }
  // Sort by tick; note-offs before note-ons at the same tick to avoid overlaps
  noteEvents.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  let lastTick = 0;
  for (const ne of noteEvents) {
    const delta = ne.tick - lastTick;
    if (ne.type === 'on') {
      events.push(evt(delta, 0x90, ne.midi, ne.vel));   // channel 0 note-on
    } else {
      events.push(evt(delta, 0x80, ne.midi, 0));        // channel 0 note-off
    }
    lastTick = ne.tick;
  }

  events.push(evt(0, 0xFF, 0x2F, 0x00));
  return buildTrack(events);
}

function buildDrumTrack() {
  const events = [];
  const name = str('Drums');
  events.push(evt(0, 0xFF, 0x03, name.length, ...name));

  let hasNotes = false;

  // Collect note-on / note-off for every active drum step
  const noteEvents = [];
  for (let row = 0; row < 8; row++) {
    const midiNote = DRUM_MAP[row];
    for (let step = 0; step < 16; step++) {
      const vel = S.seqPattern[row][step];
      if (!vel) continue;
      hasNotes = true;
      const onTick  = step * STEP_TICKS;
      const offTick = onTick + STEP_TICKS;            // one 16th note duration
      const midiVel = Math.max(1, Math.min(127, Math.round(vel * 127)));
      noteEvents.push({ tick: onTick,  type: 'on',  midi: midiNote, vel: midiVel });
      noteEvents.push({ tick: offTick, type: 'off', midi: midiNote, vel: 0 });
    }
  }
  if (!hasNotes) return null;

  noteEvents.sort((a, b) => a.tick - b.tick || (a.type === 'off' ? -1 : 1));

  let lastTick = 0;
  for (const ne of noteEvents) {
    const delta = ne.tick - lastTick;
    if (ne.type === 'on') {
      events.push(evt(delta, 0x99, ne.midi, ne.vel));   // channel 9 note-on
    } else {
      events.push(evt(delta, 0x89, ne.midi, 0));        // channel 9 note-off
    }
    lastTick = ne.tick;
  }

  events.push(evt(0, 0xFF, 0x2F, 0x00));
  return buildTrack(events);
}

// ── Public export ─────────────────────────────────────────────────────────────

export function exportMIDI() {
  const tempoTrack  = buildTempoTrack();
  const melodyTrack = buildMelodyTrack();
  const drumTrack   = buildDrumTrack();

  const tracks = [tempoTrack];
  if (melodyTrack) tracks.push(melodyTrack);
  if (drumTrack)   tracks.push(drumTrack);

  if (tracks.length === 1) {
    setStatus('Nothing to export — add notes to the piano roll or drum sequencer');
    return;
  }

  // SMF header: MThd, length 6, format 1, nTracks, PPQN
  const header = new Uint8Array([
    ...str('MThd'), ...u32(6),
    ...u16(1),                   // format 1
    ...u16(tracks.length),
    ...u16(PPQN),
  ]);

  // Total size
  let totalLen = header.length;
  for (const t of tracks) totalLen += t.length;

  const out = new Uint8Array(totalLen);
  let off = 0;
  out.set(header, off); off += header.length;
  for (const t of tracks) { out.set(t, off); off += t.length; }

  // Trigger download
  const blob = new Blob([out], { type: 'audio/midi' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'waivepulse_loop.mid';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  const parts = [];
  if (melodyTrack) parts.push('piano roll');
  if (drumTrack)   parts.push('drums');
  setStatus('Exported MIDI (' + parts.join(' + ') + ') at ' + S.bpm + ' BPM');
}
