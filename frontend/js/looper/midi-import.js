// ── Import MIDI (.mid / .midi) → drum grid + piano roll ───────────────────────
// Channel 10 → drum sequencer (GM map, between-grid hits → ratchets), every other
// channel → piano roll (16th grid, octave-folded into the roll's two octaves).
// Bar 1 lands in the current bank. A longer file offers to spread bars 1–4 across
// banks A–D with a chain, so a 4-bar groove plays back as written.
import { S } from './state.js';
import { setStatus } from './util.js';
import { parseSMF, smfToPatterns } from './midi-file.js';
import { applySeqPattern, setDrumMode } from './drums.js';
import { applyPseqPattern, rollLowMidi, setSynthMode } from './pianoseq.js';
import { storeBank, setBanks, setChainStr, paintBanks } from './banks.js';
import { chBPM } from './transport.js';
import { BANK_LETTERS } from './chain.js';

export function importMidiDialog() {
  const inp = document.getElementById('midiFile');
  if (inp) { inp.value = ''; inp.click(); }
}

export async function importMidiFile(input) {
  const f = input?.files ? input.files[0] : input;       // <input> or a dropped File
  if (!f) return;
  await importMidiBytes(new Uint8Array(await f.arrayBuffer()), f.name);
  if (input?.files) input.value = '';
}

export async function importMidiBytes(bytes, fileName = 'file.mid') {
  let parsed, res;
  try {
    parsed = parseSMF(bytes);
    res = smfToPatterns(parsed, { lowMidi: rollLowMidi(), maxBars: 4 });
  } catch (e) {
    setStatus(`Couldn't read ${fileName}: ${e.message}`); return null;
  }
  if (!res.drumHits && !res.melodyNotes) { setStatus(`${fileName} has no notes to import`); return res; }

  // Tempo: offer to follow the file (never silently change the BPM)
  let bpmNote = '';
  if (res.bpm) {
    const fileBpm = Math.max(40, Math.min(240, Math.round(res.bpm)));
    if (fileBpm !== S.bpm && confirm(`${fileName} is at ${res.bpm} BPM (Looper is at ${S.bpm}).\nSwitch the Looper to ${fileBpm} BPM?`)) {
      chBPM(fileBpm - S.bpm);
      bpmNote = ` · BPM → ${fileBpm}`;
    }
  }

  const nb = res.bars.length;
  let spread = false;
  if (nb > 1) {
    spread = confirm(`${fileName} has ${res.totalBars} bars.\n\nOK = put bars 1–${nb} into banks A–${BANK_LETTERS[nb - 1]} and chain them (${BANK_LETTERS.slice(0, nb).join(' ')}).\nCancel = import bar 1 into the current bank only.`);
  }

  if (spread) {
    storeBank();
    const list = S.banks.map((b, i) => (i < nb ? res.bars[i] : b));
    setBanks(list, 0);
    setChainStr(BANK_LETTERS.slice(0, nb).join(' '));
    S.chainOn = true; S.chainPos = 0; S.bankQueued = null;
  } else {
    const b = res.bars[0];
    applySeqPattern(b.seq, b.prob, b.rat);
    applyPseqPattern(b.roll);
    storeBank();
  }
  paintBanks();
  if (res.drumHits) setDrumMode('seq');
  if (res.melodyNotes) setSynthMode('roll');

  const parts = [];
  if (res.drumHits) parts.push(`${res.drumHits} drum step${res.drumHits === 1 ? '' : 's'}`);
  if (res.melodyNotes) parts.push(`${res.melodyNotes} note${res.melodyNotes === 1 ? '' : 's'}`);
  const extras = [];
  if (res.folded) extras.push(`${res.folded} octave-folded into the roll`);
  if (!spread && res.totalBars > 1) extras.push(`bars 2–${res.totalBars} skipped`);
  else if (res.clippedBars) extras.push(`bars ${nb + 1}–${res.totalBars} skipped (4 banks max)`);
  setStatus(`Imported ${fileName}: ${parts.join(' + ')}` + (spread ? ` → banks A–${BANK_LETTERS[nb - 1]}, chain on` : '') +
            (extras.length ? ' · ' + extras.join(' · ') : '') + bpmNote);
  return res;
}
