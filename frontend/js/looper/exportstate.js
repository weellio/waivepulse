// ── Export-button enablement ──────────────────────────────────────────────────
// Greys out the toolbar export actions when there's nothing for them to produce:
//   ⬇ Export / 🎼 Song  → need at least one recorded loop
//   ⬇ MIDI              → needs notes in the drum sequencer or piano roll
// Polled on a light interval from main.js so it tracks every state change (record,
// clear, sequencer/piano-roll edits) without wiring into each editor. Reads only
// shared state (S) so it has no module dependencies beyond state.js.
import { S } from './state.js';

const anyLoops = () => S.slots.some(s => s.buffer);
const hasCells = p => Array.isArray(p) && p.some(row => row.some(Boolean));
const anyMidi  = () => hasCells(S.seqPattern) || hasCells(S.pseqPattern);

function setDisabled(id, off) {
  const b = document.getElementById(id);
  if (b && b.disabled !== off) b.disabled = off;
}

export function refreshExportButtons() {
  const loops = anyLoops();
  setDisabled('exportBtn', !loops);
  setDisabled('songBtn',   !loops);
  setDisabled('midiBtn',   !anyMidi());
}
