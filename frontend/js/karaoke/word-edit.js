// ── Correcting the words ──────────────────────────────────────────────────────
// Two ways to fix what the screen says, for two different problems.
//
//   One wrong word  ->  pause, click it, type, Enter. The timing is kept; only the
//                       text changes. This is the common case: Whisper is a speech
//                       model reading sung, separated vocals, so "sanctuary" coming
//                       back as "a stage to worry" is its normal failure mode.
//
//   All of them     ->  paste the real lyrics. The backend then stops using Whisper's
//                       words entirely: it LCS-aligns them against the lyrics and emits
//                       the LYRIC words carrying Whisper's timings, so a mishearing
//                       cannot reach the screen, because the misheard word was never a
//                       candidate. It reports how much of the lyrics it matched.
//
// Re-sync is neither of these. It re-runs Whisper, which fixes a dropout and does not
// fix a mishearing -- a larger model mishears differently, not less.
import { S, currentPos } from './state.js';
import { updateLyrics } from './lyric-sync.js';
import { retranscribe, _updateResyncBtn } from './transcription.js';

// padLyrics puts 3 blank entries at the head, so the page's index into S._words is 3
// ahead of the server's index into the stored list.
const HEAD_PAD = 3;

// The window shows S._lastWordIdx-2 .. +2 in slots kw0..kw4.
const pageIdxForSlot = si => S._lastWordIdx - 2 + si;

function isRealWord(pageIdx) {
  return pageIdx >= 0 && pageIdx < S._words.length
    && !!(S._words[pageIdx] && S._words[pageIdx].word || '').trim()
    && pageIdx >= HEAD_PAD;
}

// ── one word, in place ───────────────────────────────────────────────────────

let editing = null;   // page index being edited, or null

const input = () => document.getElementById('word-edit');

export function closeWordEdit() {
  // Clear the claim BEFORE hiding. Hiding a focused input fires blur synchronously, the
  // blur handler commits, and if `editing` were still set that commit would be a second
  // identical request -- harmless for a rename, but it deletes two words for a delete.
  editing = null;
  const el = input();
  if (el) { el.hidden = true; }
}

function repaint() {
  S._lastWordIdx = -1;      // force updateLyrics past its "nothing moved" guard
  updateLyrics(currentPos());
}

async function commitWordEdit() {
  const el = input();
  if (!el || editing === null) return;
  const pageIdx = editing;
  editing = null;            // claim it immediately, so nothing can re-enter
  const next = el.value.trim();
  const prev = S._words[pageIdx] ? S._words[pageIdx].word : '';
  const at = S._lastWordIdx;
  closeWordEdit();
  if (next === prev) return;

  // Show it immediately; the save is a background confirmation, not a gate.
  // An emptied box means delete: one sung word can come back as three, so finishing a
  // correction often means removing what is left over.
  const removing = !next;
  const removed = removing ? S._words[pageIdx] : null;
  if (removing) S._words.splice(pageIdx, 1);
  else S._words[pageIdx].word = next;
  S._lastWordIdx = Math.min(at, S._words.length - 1);
  repaint();

  try {
    const r = await fetch(`/words/${S._sepId}/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index: pageIdx - HEAD_PAD, word: next }),
    });
    if (!r.ok) throw new Error((await r.text()) || r.status);
    S._matchPct = null;      // that number described the automatic alignment
    _updateResyncBtn();
    window.dispatchEvent(new Event('karaoke-words'));
  } catch (e) {
    console.error('word edit failed:', e);
    // Put it back rather than lie about having saved.
    if (removing) S._words.splice(pageIdx, 0, removed);
    else S._words[pageIdx].word = prev;
    S._lastWordIdx = Math.min(at, S._words.length - 1);
    repaint();
  }
}

function openWordEdit(si) {
  const pageIdx = pageIdxForSlot(si);
  if (S._recording || !isRealWord(pageIdx)) return;
  const span = document.getElementById('kw' + si);
  const el = input();
  if (!el || !span) return;

  const r = span.getBoundingClientRect();
  if (!r.width) return;
  const w = Math.max(140, r.width + 44);
  editing = pageIdx;
  el.value = S._words[pageIdx].word;
  el.hidden = false;
  el.style.minWidth = w + 'px';
  el.style.left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2),
                           window.innerWidth - w - 8) + 'px';
  el.style.top = Math.max(8, r.top - 8) + 'px';
  el.select();
  el.focus();
}

export function initWordEdit() {
  const el = input();
  if (!el) return;
  el.title = 'Enter saves · clear it and press Enter to delete the word · Esc cancels';

  for (let si = 0; si < 5; si++) {
    const span = document.getElementById('kw' + si);
    if (span) span.addEventListener('click', () => { if (!S._playing) openWordEdit(si); });
  }

  el.addEventListener('keydown', e => {
    e.stopPropagation();                 // the page's own single-key shortcuts must not fire
    if (e.key === 'Enter') { e.preventDefault(); commitWordEdit(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeWordEdit(); }
  });
  el.addEventListener('blur', () => commitWordEdit());
}

// Only show the words as clickable when they actually are. Called every frame, so it
// only touches the DOM when the state changed.
let wasPlaying = null;
export function reflectPausedState() {
  if (S._playing === wasPlaying) return;
  wasPlaying = S._playing;
  document.body.classList.toggle('paused', !S._playing);
  if (S._playing) closeWordEdit();
}

// ── all of them, from the real lyrics ────────────────────────────────────────

export async function openLyrics() {
  const sheet = document.getElementById('lyrics-sheet');
  const box = document.getElementById('ly-text');
  const note = document.getElementById('ly-note');
  if (!sheet || !box) return;
  note.textContent = 'Loading…';
  sheet.hidden = false;
  box.focus();
  try {
    const d = await (await fetch('/lyrics/' + S._sepId)).json();
    box.value = d.lyrics || '';
    note.textContent = d.words
      ? `${d.words} words attached to this song`
      : 'Nothing attached yet — the screen is showing what Whisper heard';
  } catch (e) {
    note.textContent = 'Could not load the saved lyrics';
  }
}

export function closeLyrics() {
  const sheet = document.getElementById('lyrics-sheet');
  if (sheet) sheet.hidden = true;
}

export async function saveLyrics() {
  const box = document.getElementById('ly-text');
  const note = document.getElementById('ly-note');
  const save = document.getElementById('ly-save');
  if (!box) return;
  save.disabled = true;
  note.textContent = 'Saving…';
  try {
    const r = await fetch('/lyrics/' + S._sepId, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lyrics: box.value }),
    });
    if (!r.ok) throw new Error((await r.text()) || r.status);
    const d = await r.json();
    note.textContent = `${d.words} words saved — reading the vocals again…`;
    closeLyrics();
    // Saved lyrics only reach the screen through a transcription pass: that is where
    // the alignment runs.
    await retranscribe();
  } catch (e) {
    console.error(e);
    note.textContent = 'Could not save: ' + e.message;
    save.disabled = false;
    return;
  }
  save.disabled = false;
}
