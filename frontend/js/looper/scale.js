// ── Scale lock ────────────────────────────────────────────────────────────────
// Pure music-theory helpers (no DOM) shared by the piano roll, the synth keyboard
// and MIDI input. "chromatic" = lock off.

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Pitch classes relative to the root.
export const SCALES = {
  chromatic:  { label: 'Off (chromatic)', pcs: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  major:      { label: 'Major',           pcs: [0, 2, 4, 5, 7, 9, 11] },
  minor:      { label: 'Minor',           pcs: [0, 2, 3, 5, 7, 8, 10] },
  dorian:     { label: 'Dorian',          pcs: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { label: 'Mixolydian',      pcs: [0, 2, 4, 5, 7, 9, 10] },
  pentMaj:    { label: 'Pentatonic maj',  pcs: [0, 2, 4, 7, 9] },
  pentMin:    { label: 'Pentatonic min',  pcs: [0, 3, 5, 7, 10] },
  blues:      { label: 'Blues',           pcs: [0, 3, 5, 6, 7, 10] },
};

export function isLocked(scaleName) {
  return !!SCALES[scaleName] && scaleName !== 'chromatic';
}

export function inScale(midi, root, scaleName) {
  const sc = SCALES[scaleName];
  if (!sc || scaleName === 'chromatic') return true;
  const pc = (((midi - root) % 12) + 12) % 12;
  return sc.pcs.includes(pc);
}

// Nearest in-scale MIDI note. Ties (equidistant) snap DOWN. Optional [lo, hi]
// bounds keep the result inside a range (e.g. the visible piano-roll rows).
export function snapMidi(midi, root, scaleName, lo = -Infinity, hi = Infinity) {
  if (inScale(midi, root, scaleName)) return midi;
  for (let d = 1; d <= 12; d++) {
    if (midi - d >= lo && inScale(midi - d, root, scaleName)) return midi - d;
    if (midi + d <= hi && inScale(midi + d, root, scaleName)) return midi + d;
  }
  return midi;
}
