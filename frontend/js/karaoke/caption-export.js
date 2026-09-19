// ── caption-export.js — LRC / SRT / VTT download + "Copy timed lyrics" ───────
// Wires the caption buttons in the controls bar. Formatting lives in the pure
// captions.js; this file only gathers S._words + the song's lyrics, handles the
// "no timings yet" state (runs the same Whisper path the page uses on load) and
// triggers the downloads.
import { S } from './state.js';
import * as C from './captions.js';
import { waitForTranscription, _updateResyncBtn } from './transcription.js';

const IDS = ['cap-lrc', 'cap-srt', 'cap-vtt', 'cap-copy'];
let _busy = false;
let _whisper = null;   // null = unknown, true/false after /whisper-status

// A 0% lyric match means every time was guessed (evenly spaced from 0:00) - not usable.
const _ready = () => C.hasUsableTimings(S._words) && S._matchPct !== 0;

function _btns() { return IDS.map(id => document.getElementById(id)).filter(Boolean); }

function _toast(msg, bad = false) {
  let t = document.getElementById('cap-toast');
  if (!t) { t = document.createElement('div'); t.id = 'cap-toast'; document.body.appendChild(t); }
  t.textContent = msg;
  t.classList.toggle('bad', bad);
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2600);
}

/** Refresh enabled/disabled state + tooltips. Call after words change. */
export async function updateCaptionButtons() {
  const ready = _ready();
  if (!ready && _whisper === null) {
    try { _whisper = !!(await (await fetch('/whisper-status')).json()).available; } catch { _whisper = false; }
  }
  const tips = {
    'cap-lrc': 'Download synced lyrics (.lrc) — line times plus word-by-word tags, for music players and karaoke apps',
    'cap-srt': 'Download YouTube-ready captions (.srt) — one caption per lyric line',
    'cap-vtt': 'Download web captions (.vtt) — same captions in WebVTT format',
    'cap-copy': 'Copy the lyrics with a [m:ss] time in front of each line',
  };
  for (const b of _btns()) {
    if (ready) { b.disabled = false; b.title = tips[b.id]; continue; }
    if (_whisper) {
      b.disabled = false;
      b.title = (S._matchPct === 0 ? 'The last timing run matched 0% of the lyrics' : 'Lyrics are not timed yet') + ' — click to read the vocals with Whisper first (30–60 s), then ' +
        tips[b.id][0].toLowerCase() + tips[b.id].slice(1);
    } else {
      b.disabled = true;
      b.title = 'No lyric timings for this song, and Whisper (faster-whisper) is not installed on the server, so captions cannot be made.';
    }
  }
}

async function _ensureTimings() {
  if (_ready()) return true;
  if (!_whisper) return false;
  _toast('Timing the lyrics with Whisper… (30–60 s)');
  // force=true when words exist but are unusable (e.g. a 0% match left all-zero times)
  const force = S._words.length ? '?force=true' : '';
  const r = await fetch('/transcribe/' + S._sepId + force, { method: 'POST' });
  if (!r.ok) { _toast('Could not start transcription (' + r.status + ')', true); return false; }
  await waitForTranscription();
  S._lastWordIdx = -1;
  _updateResyncBtn();
  await updateCaptionButtons();
  return _ready();
}

function _lines() { return C.groupLines(S._words, S._lyrics || ''); }

function _download(text, name, mime) {
  const blob = new Blob([text], { type: mime + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function _run(btn, fn) {
  if (_busy) return;
  _busy = true;
  const label = btn.textContent;
  try {
    if (!_ready()) btn.textContent = '⏳';
    const ok = await _ensureTimings();
    if (!ok) { _toast('No lyric timings available — try 🔄 Re-sync', true); return; }
    await fn(_lines());
  } catch (e) {
    console.error(e);
    _toast('Export failed: ' + e.message, true);
  } finally {
    btn.textContent = label;
    _busy = false;
  }
}

function _matchNote() {
  return S._matchPct !== null && S._matchPct < 80 ? ` · only ${S._matchPct}% of words matched — check timings, or 🔄 Re-sync` : '';
}

export function initCaptionButtons() {
  const stem = () => C.fileStem(S._title);
  const on = (id, fn) => { const b = document.getElementById(id); if (b) b.onclick = () => _run(b, fn); };
  on('cap-lrc', lines => {
    _download(C.buildLrc(lines, { title: S._title, artist: S._artist, duration: S._dur }), stem() + '.lrc', 'text/plain');
    _toast('Saved ' + stem() + '.lrc' + _matchNote());
  });
  on('cap-srt', lines => {
    _download(C.buildSrt(C.buildCues(lines, { duration: S._dur })), stem() + '.srt', 'application/x-subrip');
    _toast('Saved ' + stem() + '.srt — upload it in YouTube Studio → Subtitles' + _matchNote());
  });
  on('cap-vtt', lines => {
    _download(C.buildVtt(C.buildCues(lines, { duration: S._dur })), stem() + '.vtt', 'text/vtt');
    _toast('Saved ' + stem() + '.vtt' + _matchNote());
  });
  on('cap-copy', async lines => {
    const txt = C.buildTimedText(lines);
    try { await navigator.clipboard.writeText(txt); _toast('Timed lyrics copied (' + lines.length + ' lines)'); }
    catch { _download(txt, stem() + ' (timed).txt', 'text/plain'); _toast('Clipboard blocked — saved as a .txt instead'); }
  });
  updateCaptionButtons();
}
