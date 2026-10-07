// Pronunciation panel: scan the lyrics for words the singer is likely to get wrong, and
// swap in a respelling on click.
//
// Replacement is whole-word and case-insensitive but only inside sung lines — a [Verse]
// marker must never be rewritten, and neither must a word inside one.

import * as P from './prosody.js';
import { pronunciationRisks, respellWord } from './pronounce.js';
import { scheduleRefresh } from './editor.js';

const KIND_LABEL = {
  heteronym: 'two ways to say it',
  number:    'digits',
  acronym:   'letters or a word?',
  unknown:   'not in the dictionary',
};

let ta, results, input;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function initPronounce() {
  ta = document.getElementById('output');
  results = document.getElementById('pronResults');
  input = document.getElementById('pronWord');
  if (!ta || !results) return;

  document.getElementById('btnPronounce').addEventListener('click', scanLyrics);
  document.getElementById('btnPronWord').addEventListener('click', () => lookup(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); lookup(input.value); }
  });
  results.addEventListener('click', e => {
    const b = e.target.closest('button[data-sub]');
    if (b) replaceWord(b.dataset.word, b.dataset.sub);
  });
}

function needDict() {
  if (P.hasDict()) return false;
  results.innerHTML = `<div class="rf-msg">The pronunciation dictionary is still loading.</div>`;
  return true;
}

function lookup(raw) {
  if (needDict()) return;
  const w = String(raw || '').trim();
  if (!w) { results.innerHTML = `<div class="rf-msg">Type a word first.</div>`; return; }
  const r = respellWord(w);
  results.innerHTML = r
    ? `<div class="pr-one"><b>${esc(w)}</b> is sung <span class="pr-say">${esc(r)}</span>
       <span class="pr-note">${P.syllables(w)} syllable${P.syllables(w) === 1 ? '' : 's'}; the
       capitalised part carries the stress.</span></div>`
    : `<div class="rf-msg"><b>${esc(w)}</b> is not in the dictionary, so the singer will guess
       from the spelling. If it comes out wrong, respell it the way it sounds and use that in
       the lyrics.</div>`;
}

function scanLyrics() {
  if (needDict()) return;
  const risks = pronunciationRisks(ta.value);
  if (!risks.length) {
    results.innerHTML = `<div class="rf-msg">Nothing here is likely to be mispronounced —
      no ambiguous spellings, no digits, and every word is in the dictionary.</div>`;
    return;
  }
  const rows = risks.map(r => {
    const opts = r.options.map(o =>
      `<button type="button" class="pr-opt" data-word="${esc(r.word)}" data-sub="${esc(o.text)}"
        title="Replace &quot;${esc(r.word)}&quot; in the lyrics with &quot;${esc(o.text)}&quot;"
      >${esc(o.text)}<em>${esc(o.label)}</em></button>`).join('');
    return `<div class="pr-row pr-${r.kind}">
      <div class="pr-word">${esc(r.word)}
        <span class="pr-kind">${esc(KIND_LABEL[r.kind] || r.kind)}</span>
        ${r.count > 1 ? `<span class="pr-count">${r.count}x</span>` : ''}
        <span class="pr-line">line ${r.line}</span></div>
      <div class="pr-why">${esc(r.why)}</div>
      ${opts ? `<div class="pr-opts">${opts}</div>` : ''}
    </div>`;
  }).join('');
  const n = risks.length;
  results.innerHTML = `<div class="pr-head">${n} word${n === 1 ? '' : 's'} worth a second look</div>${rows}`;
}

/** Replace every occurrence of `word` in sung lines with `sub`, preserving nothing clever:
 *  the respelling is deliberately lower-case unless it carries stress capitals. */
function replaceWord(word, sub) {
  const lines = ta.value.split('\n');
  const re = new RegExp(`(^|[^A-Za-z'’])(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![A-Za-z'’])`, 'gi');
  let hits = 0;
  const out = lines.map(ln => {
    if (/^\s*\[[^\]]{1,40}\]\s*$/.test(ln)) return ln;      // never rewrite a section marker
    return ln.replace(re, (_m, pre) => { hits++; return pre + sub; });
  });
  if (!hits) return;
  const start = ta.selectionStart;
  ta.value = out.join('\n');
  ta.selectionStart = ta.selectionEnd = Math.min(start, ta.value.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));   // stats + gutter follow
  scheduleRefresh();
  scanLyrics();                                              // the list reflects the new text
}
