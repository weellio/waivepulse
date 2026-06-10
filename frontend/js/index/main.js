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

// Pre-fill from URL params (used by Studio "Variation" button)
(function prefillFromParams() {
  const params = new URLSearchParams(window.location.search);
  if (!params.has('lyrics') && !params.has('tags')) return;

  if (params.has('lyrics')) document.getElementById('lyrics').value = params.get('lyrics');
  if (params.has('title'))  document.getElementById('title').value = params.get('title');
  if (params.has('artist')) document.getElementById('artist').value = params.get('artist');

  if (params.has('tags'))   applyPreset(params.get('tags'));

  if (params.has('max_duration_sec')) {
    const el = document.getElementById('maxDur');
    el.value = params.get('max_duration_sec');
    updateDurLabel();
  }
  if (params.has('temperature')) {
    const el = document.getElementById('temperature');
    el.value = params.get('temperature');
    document.getElementById('tempVal').textContent = parseFloat(el.value).toFixed(2);
  }
  if (params.has('cfg_scale')) {
    const el = document.getElementById('cfgScale');
    el.value = params.get('cfg_scale');
    document.getElementById('cfgVal').textContent = parseFloat(el.value).toFixed(1);
  }

  // Store variation_of so the generate request includes it
  if (params.has('variation_of')) {
    window._variationOf = params.get('variation_of');
  }

  // Open the advanced section if any advanced params were set
  if (params.has('temperature') || params.has('cfg_scale') || params.has('max_duration_sec')) {
    const adv = document.getElementById('advancedSection');
    if (adv && !adv.classList.contains('open')) toggleAdvanced();
  }

  showToast('Settings pre-filled from variation');
})();
