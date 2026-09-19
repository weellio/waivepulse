// ── General MIDI drum map (pure) ──────────────────────────────────────────────
// Pad rows: 0 Kick · 1 Snare · 2 HiHat · 3 Open · 4 Clap · 5 Tom · 6 808 · 7 Perc
// PAD_TO_GM is what MIDI export writes; gmToPad is its inverse (plus the common
// neighbours) and is used by live MIDI input and MIDI file import alike.

export const PAD_TO_GM = [36, 38, 42, 46, 39, 45, 35, 56];

export function gmToPad(note) {
  switch (note) {
    case 36: return 0;                               // bass drum 1
    case 35: return 6;                               // acoustic bass drum → 808
    case 38: case 40: return 1;                      // snares
    case 42: case 44: return 2;                      // closed / pedal hat
    case 46: return 3;                               // open hat
    case 39: return 4;                               // hand clap
    case 41: case 43: case 45: case 47: case 48: case 50: return 5;   // toms
    default: return 7;                               // everything else → perc
  }
}
