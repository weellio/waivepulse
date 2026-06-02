// ── Looper entry point ────────────────────────────────────────────────────────
// Imports the modules, wires keyboard input, exposes inline-handler functions on
// window (so the HTML onclick/oninput/onchange attributes keep working), and runs
// the init sequence.
import { S } from './state.js';
import { toggleBypass, setGlobalFX, setMasterVol, exportMix } from './core.js';
import { DRUMS, buildDrums, hitDrum, setDrumMode, toggleSeq, clearSeq, pushSeqToLoop } from './drums.js';
import { buildSlots, tapRecord, tapPlay, clearSlot, clearAll, setVol, nudgeSlot, animRings } from './loops.js';
import {
  keyMap, buildKbd, noteOn, noteOff, setWave, setGuitarVol, setFilter,
  toggleArp, setArpRate, setArpMode, toggleGuitar, setADSR, chOctave,
  loadSample, toggleSampleMode, useAsSample,
} from './synth.js';
import { chBPM, toggleMetro, chCountIn, tapTempo, toggleQuantize } from './transport.js';
import { toggleMic, toggleAutotune, setAtKey, setAtScaleSel, setAtSpeed } from './mic.js';

// ── Help modal ──────────────────────────────────────────────────────────────────
function showHelp()   { document.getElementById('help-modal').classList.add('open'); }
function closeHelp()  { document.getElementById('help-modal').classList.remove('open'); }
function toggleHelp() { document.getElementById('help-modal').classList.toggle('open'); }

// ── Expose every function referenced by an inline HTML handler on window ────────
Object.assign(window, {
  // help
  showHelp, closeHelp,
  // transport
  chBPM, tapTempo, toggleMetro, chCountIn, toggleQuantize, toggleBypass, exportMix, clearAll,
  // drums
  setDrumMode, toggleSeq, clearSeq, pushSeqToLoop,
  // synth
  setWave, toggleGuitar, setGuitarVol, chOctave, setADSR, setFilter,
  toggleArp, setArpRate, setArpMode, loadSample, toggleSampleMode, useAsSample,
  // loops
  tapRecord, tapPlay, clearSlot, setVol, nudgeSlot,
  // master fx
  setGlobalFX, setMasterVol,
  // mic + autotune
  toggleMic, toggleAutotune, setAtKey, setAtScaleSel, setAtSpeed,
});

// ── Keyboard input ──────────────────────────────────────────────────────────────
const drumKeyMap = Object.fromEntries(DRUMS.map(d => [d.key, d]));

document.addEventListener('keydown', e => {
  if (e.repeat || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  // Help: ? toggles, Esc closes (not bound to a piano key)
  if (e.key === '?')      { e.preventDefault(); toggleHelp(); return; }
  if (e.key === 'Escape') { closeHelp(); return; }
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
