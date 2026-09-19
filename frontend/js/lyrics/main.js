// Entry point for the Lyric Helper page.
// Wires up DOM listeners, exposes inline-handler functions on window,
// and runs the initial Ollama status check.
import { S } from './state.js';
import { checkOllama } from './ollama-detect.js';
import { generateLyrics } from './generate-stream.js';
import { copyOutput, sendToGenerator } from './handoff.js';
import { initEditor, loadDictionary } from './editor.js';
import { initRhymeFinder, showRhymes } from './rhyme-finder.js';

// Tone chips — single-select toggle.
document.querySelectorAll('#toneChips .chip').forEach(c => {
  c.addEventListener('click', () => {
    if (c.classList.contains('active')) { c.classList.remove('active'); S.selectedTone = ''; return; }
    document.querySelectorAll('#toneChips .chip').forEach(o => o.classList.remove('active'));
    c.classList.add('active'); S.selectedTone = c.dataset.tone;
  });
});

// Creativity slider readout.
document.getElementById('temp').addEventListener('input', e => {
  document.getElementById('tempVal').textContent = parseFloat(e.target.value).toFixed(2);
});

// Expose functions referenced by inline HTML handlers (onclick=...).
Object.assign(window, {
  generateLyrics,
  copyOutput,
  sendToGenerator,
});

// Editable lyrics box with syllable/rhyme gutter + rhyme finder.
initEditor({ onPickWord: showRhymes });
initRhymeFinder();
loadDictionary();

// Initial detection on load.
checkOllama();
