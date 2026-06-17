// ── Studio entry point ────────────────────────────────────────────────────────
// Imports the modules, wires global keyboard/mouse/drag listeners, exposes every
// function referenced by an inline HTML handler on window, and runs boot.
import { S } from './state.js';
import { boot, toggleAutoTranscribe, openKaraoke } from './boot.js';
import {
  togglePlay, stopPlayback, toggleLoop, seekTo, currentPosition,
  zoomIn, zoomOut, zoomFit, applyZoom, updateLoopRegion, getCanvasWidth, _bindApplyRangedGains,
  setFadeIn, setFadeOut,
} from './transport.js';
import {
  handleImportFiles, resetAllTracks, applyRangedGains, toggleMute, toggleSolo,
  normalizeTrack, resetTrack, duplicateTrack, cycleTrack, stretchTrack,
} from './tracks.js';
import {
  applyPreset, applyMasterPreset, setMasterVolume, resetMix,
  saveMixPreset, loadMixPreset, loadGenreTemplate, deleteMixPreset, renderMixPresetBar,
} from './presets.js';
import {
  toggleCompressor, toggleClipper, toggleExciter,
  toggleGate, toggleGateDuck, toggleCrusher, setCrusherBits, setCrusherRate,
  toggleFolder, setFolderDrive, togglePlate, setPlateMix,
  toggleSidechain, setSidechainParam, populateSidechainDropdowns,
} from './audio-graph.js';
import { openTrackEQ, closeTrackEQ, resetTrackEQ } from './eq-modal.js';
import { exportMix, downloadZip } from './export.js';
import { cutRegion, undoCut, spliceRegion, generateVariation } from './edit.js';
import { openStemLibrary, closeStemLibrary } from './stem-library.js';
import { initStudioReceiver } from './bridge.js';
import { redrawAll, mergeRanges, toggleChords } from './waveform.js';

// transport.js calls applyRangedGains, which lives in tracks.js — inject it to
// break the circular import.
_bindApplyRangedGains(applyRangedGains);

// ── Help modal ────────────────────────────────────────────────────────────────
function showHelp() { document.getElementById('help-modal').classList.add('open'); }
function closeHelp() { document.getElementById('help-modal').classList.remove('open'); }

// ── Expose every inline-handler function on window ──────────────────────────────
Object.assign(window, {
  // transport
  togglePlay, stopPlayback, toggleLoop, zoomIn, zoomOut, zoomFit,
  // presets / master
  applyPreset, applyMasterPreset, setMasterVolume, resetAllTracks, resetMix,
  // mix presets
  saveMixPreset, loadMixPreset, loadGenreTemplate, deleteMixPreset,
  // master FX (existing)
  toggleCompressor, toggleClipper, toggleExciter,
  // master FX (new)
  toggleGate, toggleGateDuck, toggleCrusher, setCrusherBits, setCrusherRate,
  toggleFolder, setFolderDrive, togglePlate, setPlateMix,
  // sidechain ducking
  toggleSidechain, setSidechainParam, populateSidechainDropdowns,
  // EQ modal
  closeTrackEQ, resetTrackEQ,
  // export / import / stretch
  exportMix, downloadZip, handleImportFiles, stretchTrack,
  // timeline edit
  cutRegion, undoCut, spliceRegion, generateVariation,
  // master fades
  setFadeIn, setFadeOut,
  // help
  showHelp, closeHelp,
  // stem library
  openStemLibrary, closeStemLibrary,
  // chords
  toggleChords,
  // karaoke
  openKaraoke, toggleAutoTranscribe,
});

// ── Keyboard shortcuts ──────────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT') return;
  const ctrl = e.ctrlKey || e.metaKey;

  if (!ctrl && (e.key === '?' || e.key === 'h' || e.key === 'H')) {
    document.getElementById('help-modal').classList.contains('open') ? closeHelp() : showHelp(); return;
  }

  if (e.code === 'Escape') {
    if (document.getElementById('stem-library-modal').classList.contains('open')) { closeStemLibrary(); return; }
    if (document.getElementById('eq-modal').classList.contains('open')) { closeTrackEQ(); return; }
    if (document.getElementById('help-modal').classList.contains('open')) { closeHelp(); return; }
    S._loopStart = null; S._loopEnd = null; updateLoopRegion(); return;
  }

  if (ctrl) {
    if (e.key === 'e' || e.key === 'E') { e.preventDefault(); if (!document.getElementById('export-btn').disabled) exportMix(); return; }
    if ((e.key === 'm' || e.key === 'M') && e.shiftKey) { e.preventDefault(); applyMasterPreset(); return; }
    return;
  }

  if (e.code === 'Space') { e.preventDefault(); togglePlay(); return; }
  if (e.code === 'Home') { e.preventDefault(); seekTo(0); return; }
  if (e.code === 'Period') { e.preventDefault(); seekTo(S._dur); return; }
  if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(currentPosition() + (e.shiftKey ? 10 : 2)); return; }
  if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(currentPosition() - (e.shiftKey ? 10 : 2)); return; }

  if (e.key === 'l' || e.key === 'L') { toggleLoop(); return; }
  if (e.key === '[') { const p = currentPosition(); S._loopStart = p; if (S._loopEnd === null || S._loopEnd <= p) S._loopEnd = Math.min(S._dur, p + 5); updateLoopRegion(); return; }
  if (e.key === ']') { const p = currentPosition(); S._loopEnd = p; if (S._loopStart === null || S._loopStart >= p) S._loopStart = Math.max(0, p - 5); updateLoopRegion(); return; }

  if (e.key === '+' || e.key === '=') { zoomIn(); return; }
  if (e.key === '-') { zoomOut(); return; }
  if (e.key === 'f' || e.key === 'F') { zoomFit(); return; }

  if (e.code === 'Tab') { e.preventDefault(); cycleTrack(e.shiftKey ? -1 : 1); return; }

  const t = S._selectedTrack && S.tracks[S._selectedTrack];
  if (!t) return;
  if (e.key === 'm' || e.key === 'M') { toggleMute(S._selectedTrack); return; }
  if (e.key === 's' || e.key === 'S') { toggleSolo(S._selectedTrack); return; }
  if (e.key === 'n' || e.key === 'N') { normalizeTrack(S._selectedTrack); return; }
  if (e.key === 'r' || e.key === 'R') { resetTrack(S._selectedTrack); return; }
  if (e.key === 'd' || e.key === 'D') { if (!t.isDuplicate && !t.isImport) duplicateTrack(S._selectedTrack); return; }
  if (e.code === 'Delete' || e.code === 'Backspace') { e.preventDefault(); t.muteRanges = []; redrawAll(); return; }
});

// ── Mouse: ruler-drag loop, mute-region paint, import-clip reposition ────────────
document.addEventListener('mousemove', e => {
  if (S._rulerDrag) {
    const ruler = document.getElementById('ruler-inner');
    const rect = ruler.getBoundingClientRect();
    // ruler-inner scrolls with the content, so its rect.left already accounts for the
    // scroll — adding scrollLeft on top double-counts it (broke selection when zoomed in)
    const absX = Math.max(0, Math.min(getCanvasWidth(), e.clientX - rect.left));
    if (Math.abs(absX - S._rulerDrag.startAbs) > 5) S._rulerDrag.moved = true;
    if (S._rulerDrag.moved) {
      const cw = getCanvasWidth();
      S._loopStart = (Math.min(S._rulerDrag.startAbs, absX) / cw) * S._dur;
      S._loopEnd = (Math.max(S._rulerDrag.startAbs, absX) / cw) * S._dur;
      updateLoopRegion();
    }
  }
  if (S._rangeDrawing) {
    const row = document.querySelector(`#scroll-content .track-row[data-stem="${S._rangeDrawing.stemKey}"]`);
    if (row) {
      const rect = row.getBoundingClientRect();
      const relX = e.clientX - rect.left;
      S._rangeDrawing.currentPos = Math.max(0, Math.min(S._dur, (relX / getCanvasWidth()) * S._dur));
      redrawAll();
    }
  }
  if (S._trackPosDrag) {
    const { stemKey, songX0, startTime0, muteRanges0 } = S._trackPosDrag;
    const t = S.tracks[stemKey];
    if (t) {
      const dx = e.clientX - songX0;
      const dt = (dx / getCanvasWidth()) * S._dur;
      const bufDur = t.buffer?.duration || 0;
      const newStart = Math.max(0, Math.min(S._dur - bufDur, startTime0 + dt));
      const clampedDt = newStart - startTime0;
      t.startTime = newStart;
      if (muteRanges0.length) t.muteRanges = muteRanges0.map(r => ({ start: r.start + clampedDt, end: r.end + clampedDt }));
      redrawAll();
    }
  }
});

document.addEventListener('mouseup', () => {
  if (S._rulerDrag) {
    if (!S._rulerDrag.moved) {
      const cw = getCanvasWidth();
      seekTo((S._rulerDrag.startAbs / cw) * S._dur);
    }
    S._rulerDrag = null;
  }
  if (S._rangeDrawing) {
    const { stemKey, startPos, currentPos } = S._rangeDrawing;
    S._rangeDrawing = null;
    const lo = Math.min(startPos, currentPos), hi = Math.max(startPos, currentPos);
    if (hi - lo > 0.1 && S.tracks[stemKey]) {
      S.tracks[stemKey].muteRanges.push({ start: lo, end: hi });
      S.tracks[stemKey].muteRanges = mergeRanges(S.tracks[stemKey].muteRanges);
    }
    redrawAll();
  }
  if (S._trackPosDrag) {
    const { stemKey } = S._trackPosDrag;
    S._trackPosDrag = null;
    const row = document.querySelector(`#scroll-content .track-row[data-stem="${stemKey}"]`);
    if (row) row.style.cursor = 'grab';
  }
});

window.addEventListener('resize', () => { if (Object.keys(S.tracks).length) applyZoom(); });

// ── Drag & drop import ──────────────────────────────────────────────────────────
document.addEventListener('dragenter', e => {
  e.preventDefault(); S._dragDepth++;
  document.getElementById('drop-overlay').classList.add('active');
});
document.addEventListener('dragleave', () => {
  if (--S._dragDepth <= 0) { S._dragDepth = 0; document.getElementById('drop-overlay').classList.remove('active'); }
});
document.addEventListener('dragover', e => e.preventDefault());
document.addEventListener('drop', e => {
  e.preventDefault(); S._dragDepth = 0;
  document.getElementById('drop-overlay').classList.remove('active');
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('audio/') || /\.(mp3|wav|flac|ogg|m4a|aac)$/i.test(f.name));
  if (files.length) handleImportFiles(files);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', async () => {
  await boot();
  initStudioReceiver();   // announce presence + listen for loops once the audio context exists
});
