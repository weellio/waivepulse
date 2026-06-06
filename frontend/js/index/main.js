import { showToast } from './util.js';
import {
  buildTagGrid, clearTags, randomizeTags, getTagsString,
  saveTagPreset, applyPreset, deletePreset, renderPresets,
} from './tags.js';
import {
  toggleSidebar, toggleCard, toggleAdvanced, updateDurLabel,
  loadJobToForm, loadTemplate,
} from './ui.js';
import { generate, cancelJob, checkModelStatus } from './generate.js';
import {
  jobCardHTML, getLMProgress, getCodecProgress,
  connectSSE, disconnectSSE, handleLogLine, parseLogProgress,
  addJobCard, updateJobCard, deleteJob, pollJob, loadHistory,
} from './jobs.js';
import {
  loadFilesAsCards, openStudioForLocal, loadLocalMP3, setupDragDrop,
} from './mp3.js';
import { openDetails, closeDetails, saveDetails } from './details.js';
import {
  getACtx, getAnalyser, cycleVizStyle, startViz, stopViz,
  attachVizListeners, attachMetaListeners,
  drawRing, drawBars, drawWave, drawGalaxy, drawAurora, drawParticles, drawScope,
  launchFullscreen, toggleFsPlay, startFsViz, exitFs, cycleFsStyle,
} from './viz.js';

// ── Expose every function referenced by an inline HTML handler on window ────────
Object.assign(window, {
  // tags
  buildTagGrid, clearTags, randomizeTags, getTagsString,
  saveTagPreset, applyPreset, deletePreset, renderPresets,
  // ui
  toggleSidebar, toggleCard, toggleAdvanced, updateDurLabel,
  loadJobToForm, loadTemplate,
  // generate
  generate, cancelJob, checkModelStatus,
  // jobs
  jobCardHTML, getLMProgress, getCodecProgress,
  connectSSE, disconnectSSE, handleLogLine, parseLogProgress,
  addJobCard, updateJobCard, deleteJob, pollJob, loadHistory,
  // mp3
  loadFilesAsCards, openStudioForLocal, loadLocalMP3,
  // details modal
  openDetails, closeDetails, saveDetails,
  // util
  showToast,
  // viz
  getACtx, getAnalyser, cycleVizStyle, startViz, stopViz,
  attachVizListeners, attachMetaListeners,
  drawRing, drawBars, drawWave, drawGalaxy, drawAurora, drawParticles, drawScope,
  launchFullscreen, toggleFsPlay, startFsViz, exitFs, cycleFsStyle,
});

// ── Document-level listeners ────────────────────────────────────────────────────
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) exitFs();
});

document.addEventListener('keydown', e => {
  if (document.fullscreenElement && e.code === 'Space') {
    e.preventDefault();
    toggleFsPlay();
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────
setupDragDrop();
buildTagGrid();
renderPresets();
loadHistory();
checkModelStatus();

// Pick up lyrics handed off from /lyrics page
(function consumePendingLyrics() {
  try {
    const pending = localStorage.getItem('waivepulse_pending_lyrics');
    if (!pending) return;
    localStorage.removeItem('waivepulse_pending_lyrics');
    const ta = document.getElementById('lyrics');
    if (ta) {
      ta.value = pending;
      ta.focus();
      showToast('Lyrics loaded from Lyric Helper');
    }
  } catch (_) {}
})();
