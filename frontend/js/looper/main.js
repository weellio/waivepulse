// ── Looper entry point ────────────────────────────────────────────────────────
// Imports the modules, wires keyboard input, exposes inline-handler functions on
// window (so the HTML onclick/oninput/onchange attributes keep working), and runs
// the init sequence.
import { S } from './state.js';
import { toggleBypass, setGlobalFX, setMasterVol, exportMix } from './core.js';
import { DRUMS, buildDrums, hitDrum, setDrumMode, toggleSeq, clearSeq, pushSeqToLoop, setStepEdit } from './drums.js';
import { renderBeatBar } from './beats.js';
import { renderMelodyBar } from './melodies.js';
import { buildSlots, tapRecord, tapPlay, clearSlot, clearAll, setVol, nudgeSlot, animRings, refreshStudioButtons } from './loops.js';
import { initStudioBridge, sendLoopToStudio } from './bridge.js';
import {
  keyMap, buildKbd, noteOn, noteOff, setWave, setGuitarVol, setFilter,
  toggleArp, setArpRate, setArpMode, toggleGuitar, setADSR, chOctave,
  loadSample, toggleSampleMode, useAsSample,
} from './synth.js';
import { chBPM, toggleMetro, chCountIn, tapTempo, toggleQuantize, setSwing, setHumanize } from './transport.js';
import { toggleMic, toggleAutotune, setAtKey, setAtScaleSel, setAtSpeed, toggleHarmonizer, setHarmInterval, toggleHarmVoice2 } from './mic.js';
import { setSynthMode, togglePseq, pushPseqToLoop, clearPseq, renderSheet, setScaleRoot, setScaleName, transposeRoll, pseqRuns } from './pianoseq.js';
import { initMidi, connectMidi, setMidiDevice, toggleMidiDrums } from './midi-in.js';
import { exportMIDI, setMidiBarsProvider } from './midi-export.js';
import { importMidiDialog, importMidiFile } from './midi-import.js';
import { initBanks, clickBank, toggleBankCopy, setChainStr, toggleChain, renderPlan } from './banks.js';
import { initProject, saveProject, openProjectDialog, openProjectFile, setProjectName, clearAllConfirm, collectProject } from './project.js';
import { setStatus } from './util.js';
import { openLoopEq, closeLoopEq, resetLoopEq, loopEqOpen } from './loopeq.js';
import { openLoopTrim, closeLoopTrim, applyTrim, resetTrim, snapTrimToSound, loopTrimOpen } from './looptrim.js';
import { openSong, closeSong, autoArrange, downloadSong, songOpen, refreshSongStudioBtns } from './songbuilder.js';
import { refreshExportButtons } from './exportstate.js';

// ── Help modal ──────────────────────────────────────────────────────────────────
function showHelp()   { document.getElementById('help-modal').classList.add('open'); }
function closeHelp()  { document.getElementById('help-modal').classList.remove('open'); }
function toggleHelp() { document.getElementById('help-modal').classList.toggle('open'); }

// ── Expose every function referenced by an inline HTML handler on window ────────
Object.assign(window, {
  // help
  showHelp, closeHelp,
  // transport
  chBPM, tapTempo, toggleMetro, chCountIn, toggleQuantize, toggleBypass, exportMix, clearAll: clearAllConfirm,
  // project save / open + MIDI file import
  saveProject, openProjectDialog, openProjectFile, setProjectName, importMidiDialog, importMidiFile,
  // pattern banks A–D + chain
  clickBank, toggleBankCopy, setChainStr, toggleChain,
  // groove (swing + humanize)
  setSwing, setHumanize,
  // drums
  setDrumMode, toggleSeq, clearSeq, pushSeqToLoop, setStepEdit,
  // synth
  setWave, toggleGuitar, setGuitarVol, chOctave, setADSR, setFilter,
  toggleArp, setArpRate, setArpMode, loadSample, toggleSampleMode, useAsSample,
  // piano roll
  setSynthMode, togglePseq, pushPseqToLoop, clearPseq, exportMIDI,
  // scale lock + transpose
  setScaleRoot, setScaleName, transposeRoll,
  // MIDI input
  connectMidi, setMidiDevice, toggleMidiDrums,
  // per-loop EQ
  openLoopEq, closeLoopEq, resetLoopEq,
  // per-loop trim
  openLoopTrim, closeLoopTrim, applyTrim, resetTrim, snapTrimToSound,
  // song builder
  openSong, closeSong, autoArrange, downloadSong,
  // loops
  tapRecord, tapPlay, clearSlot, setVol, nudgeSlot, sendLoopToStudio,
  // master fx
  setGlobalFX, setMasterVol,
  // mic + autotune + harmonizer
  toggleMic, toggleAutotune, setAtKey, setAtScaleSel, setAtSpeed,
  toggleHarmonizer, setHarmInterval, toggleHarmVoice2,
});

// ── Keyboard input ──────────────────────────────────────────────────────────────
const drumKeyMap = Object.fromEntries(DRUMS.map(d => [d.key, d]));

document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveProject(); return; }   // Ctrl+S = save project
  if (e.repeat || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  // Help: ? toggles, Esc closes (not bound to a piano key)
  if (e.key === '?')      { e.preventDefault(); toggleHelp(); return; }
  if (e.key === 'Escape') { loopEqOpen() ? closeLoopEq() : loopTrimOpen() ? closeLoopTrim() : songOpen() ? closeSong() : closeHelp(); return; }
  // F1–F6 toggle record on loop slots
  if (e.key >= 'F1' && e.key <= 'F6') {
    e.preventDefault();
    tapRecord(parseInt(e.key.slice(1)) - 1);
    return;
  }
  const k = e.key.toLowerCase();
  if (keyMap[k])         { noteOn(keyMap[k]);          return; }
  if (S.upperKeyMap[k])  { noteOn(S.upperKeyMap[k]);   return; }
  if (drumKeyMap[e.key]) { hitDrum(drumKeyMap[e.key]); return; }
});

document.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (keyMap[k])        noteOff(keyMap[k]);
  if (S.upperKeyMap[k]) noteOff(S.upperKeyMap[k]);
});

// ── Init ──────────────────────────────────────────────────────────────────────
buildSlots();
buildDrums();
buildKbd();
animRings();
setDrumMode('pads');
setSynthMode('keys');
renderSheet();
renderBeatBar();   // premade-beat buttons + saved favorites under the sequencer
renderMelodyBar(); // premade chord/melody buttons + favorites under the keyboard
initBanks();       // pattern banks A–D + chain (status-bar strip)
setMidiBarsProvider(() => {                       // ⬇ MIDI writes the current bank, or the whole chain when on
  const plan = renderPlan();
  if (!plan.ok) { setStatus(plan.error); return []; }
  return plan.bars.map(b => ({ runs: pseqRuns(b.roll), seqPattern: b.seq, seqRatchet: b.rat }));
});
initProject({ onMidiFile: f => importMidiFile(f) });   // unsaved-work guard + drag-drop .wploop / .mid
// remember the viewer's export format / loudness choice (per-browser convenience)
for (const id of ['expFmt', 'expTarget']) {
  const el = document.getElementById(id); if (!el) continue;
  try { const v = localStorage.getItem('wp.looper.' + id); if (v && [...el.options].some(o => o.value === v)) el.value = v; } catch (_) {}
  el.addEventListener('change', () => { try { localStorage.setItem('wp.looper.' + id, el.value); } catch (_) {} });
}
initMidi();        // Web MIDI: auto-reconnects if already granted, else shows the Connect button
initStudioBridge(() => { refreshStudioButtons(); refreshSongStudioBtns(); });   // heartbeat: greys the "Send to Studio" buttons (loops + song builder) when no Studio is open
refreshExportButtons();                                   // grey ⬇Export / 🎼Song / ⬇MIDI until there's something to export…
setInterval(refreshExportButtons, 350);                   // …and keep them in sync as loops/sequencer/piano-roll change

// Read-only handle for automated page tests (state snapshot + project collector).
window.__looper = { S, collectProject };
