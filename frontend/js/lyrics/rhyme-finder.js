// Rhyme finder: type a word, double-click a word in the lyrics, press
// "Rhymes for selected word", or click a gutter row. Results are grouped
// perfect / near and by syllable count; clicking one puts it into the lyrics
// at the cursor (replacing the selected word) and copies it to the clipboard.
import * as P from './prosody.js';
import { scheduleRefresh } from './editor.js';

const PERFECT_MAX = 40, NEAR_MAX = 24;
let ta, input, results;

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function initRhymeFinder() {
  ta = document.getElementById('output');
  input = document.getElementById('rhymeWord');
  results = document.getElementById('rhymeResults');

  document.getElementById('btnRhyme').addEventListener('click', () => showRhymes(input.value));
  document.getElementById('btnRhymeSel').addEventListener('click', () => {
    const w = selectedWord();
    if (w) showRhymes(w);
    else results.innerHTML = '<div class="rf-msg">Select or double-click a word in the lyrics first, then press this button.</div>';
  });
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); showRhymes(input.value); } });
  ta.addEventListener('dblclick', () => { const w = selectedWord(); if (w) showRhymes(w); });
  results.addEventListener('click', e => {
    const b = e.target.closest('button[data-w]');
    if (b) insertWord(b.dataset.w);
  });
}

function selectedWord() {
  const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd).trim();
  const m = sel.match(/[A-Za-z’'][A-Za-z’']*/);
  return m ? m[0] : '';
}

export function showRhymes(raw) {
  const word = P.cleanWord(raw);
  input.value = word;
  if (!word) { results.innerHTML = '<div class="rf-msg">Type a word first.</div>'; return; }
  if (!P.hasDict()) {
    results.innerHTML = '<div class="rf-msg">The rhyme dictionary is still loading — try again in a second.</div>';
    return;
  }
  const r = P.findRhymes(word, PERFECT_MAX);
  if (!r.known) {
    results.innerHTML = `<div class="rf-msg">“${esc(word)}” isn't in the ${P.dictSize().toLocaleString()}-word dictionary. Try a simpler form of the word (e.g. “run” instead of “runnin'”).</div>`;
    return;
  }
  const block = (title, groups, max, cls) => {
    const keys = Object.keys(groups).map(Number).sort((a, b) => a - b);
    const total = keys.reduce((n, k) => n + groups[k].length, 0);
    if (!total) return `<div class="rf-block"><div class="rf-title">${title}</div><div class="rf-none">none found</div></div>`;
    return `<div class="rf-block"><div class="rf-title">${title} <span>${total}</span></div>` +
      keys.map(k => `<div class="rf-group"><div class="rf-syl">${k >= 4 ? '4+' : k} syllable${k === 1 ? '' : 's'}</div>
        <div class="rf-words">${groups[k].slice(0, max).map(w =>
          `<button type="button" class="rf-word ${cls}" data-w="${esc(w)}" title="Put “${esc(w)}” into the lyrics at the cursor (also copies it)">${esc(w)}</button>`).join('')}</div></div>`).join('') +
      '</div>';
  };
  results.innerHTML =
    `<div class="rf-head">Rhymes for <b>“${esc(r.word)}”</b> · ${P.syllables(r.word)} syllable${P.syllables(r.word) === 1 ? '' : 's'}</div>` +
    block('Perfect rhymes', r.perfect, PERFECT_MAX, 'perfect') +
    block('Near rhymes', r.near, NEAR_MAX, 'near');
}

function insertWord(w) {
  ta.focus();
  const s = ta.selectionStart, e = ta.selectionEnd;
  const old = ta.value.slice(s, e);
  // keep capitalisation of the word being replaced
  if (old && /^[A-Z]/.test(old.trim())) w = w[0].toUpperCase() + w.slice(1);
  // add a space when dropping a word right after another word with only a caret
  if (s === e && s > 0 && /[A-Za-z]/.test(ta.value[s - 1])) w = ' ' + w;
  let ok = false;
  try { ok = document.execCommand('insertText', false, w); } catch {}
  if (!ok) { ta.setRangeText(w, s, e, 'end'); ta.dispatchEvent(new Event('input')); }
  scheduleRefresh();
  navigator.clipboard?.writeText(w.trim()).catch(() => {});
  const t = document.getElementById('copyToast');
  t.textContent = `Added “${w.trim()}” to your lyrics (also copied)`;
  t.classList.add('show');
  setTimeout(() => { t.classList.remove('show'); t.textContent = 'Copied to clipboard'; }, 1600);
}
