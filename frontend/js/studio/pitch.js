// Per-track key change (pitch shift, tempo preserved) + "Key ±" for all tracks.
//
// Backend contract:
//   POST /pitchshift/{sep_id}/{stem_name}?semitones=N   → audio/wav (server-side stem)
//   POST /pitchshift?semitones=N  (multipart field "file") → audio/wav (any audio)
//
// Mirrors tracks.stretchTrack: loading state on the control, decode the returned WAV,
// replace the track buffer, recompute peaks. Semitones are ABSOLUTE per track
// (t.pitchSemis): the pre-pitch buffer is kept (t._prePitchBuffer) so re-pitching
// never compounds quality loss, and 0 restores the original instantly.
import { S } from './state.js';
import { computePeaks, redrawAll } from './waveform.js';
import { baseStemOf } from './tracks.js';
import { spliceBuffer } from './edit.js';
import { audioBufferToWav } from './export.js';
import { seekTo, currentPosition } from './transport.js';

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLATS = { Db: 'C#', Eb: 'D#', Gb: 'F#', Ab: 'G#', Bb: 'A#', 'D♭': 'C#', 'E♭': 'D#', 'G♭': 'F#', 'A♭': 'G#', 'B♭': 'A#' };
const fmtSemis = n => n === 0 ? '0' : (n > 0 ? '+' + n : '−' + Math.abs(n));

// "C major" + 2 → "D major"; unknown formats are returned unchanged.
export function shiftKeyName(key, semis) {
  if (!key || !semis) return key;
  const m = String(key).trim().match(/^([A-G])([#b♯♭]?)(.*)$/);
  if (!m) return key;
  let root = m[1] + (m[2] === '♯' ? '#' : m[2]);
  root = FLATS[root] || root;
  const i = NOTES.indexOf(root); if (i < 0) return key;
  return NOTES[(((i + semis) % 12) + 12) % 12] + m[3];
}

// Global key shift if every track carries the same shift, else null (mixed).
export function commonShift() {
  const vals = Object.values(S.tracks).map(t => t.pitchSemis || 0);
  if (!vals.length) return 0;
  return vals.every(v => v === vals[0]) ? vals[0] : null;
}

// Rebuild the top-bar audio info (sample rate · channels · latency · BPM · key).
export function updateAudioInfo() {
  const el = document.getElementById('audio-info');
  const first = Object.values(S.tracks)[0]?.buffer;
  if (!el || !first || !S._actx) return;
  const lat = Math.round((S._actx.baseLatency || 0) * 1000);
  const bpmStr = S._jobMeta?.bpm ? ` · ${S._jobMeta.bpm} BPM` : '';
  let keyStr = '';
  if (S._jobMeta?.key) {
    const cs = commonShift();
    keyStr = cs === null ? ` · ${S._jobMeta.key} (mixed key shifts)`
      : cs ? ` · ${shiftKeyName(S._jobMeta.key, cs)} (${fmtSemis(cs)} from ${S._jobMeta.key})` : ` · ${S._jobMeta.key}`;
  }
  el.textContent = `${(first.sampleRate / 1000).toFixed(1)} kHz · ${first.numberOfChannels === 2 ? 'stereo' : 'mono'}` +
    (lat ? ` · latency ${lat} ms` : '') + bpmStr + keyStr;
  const gk = document.getElementById('key-all-val');
  if (gk) { const c = commonShift(); gk.textContent = c === null ? 'mix' : fmtSemis(c); }
}

// The per-track KEY control (sits in the knob row, next to OFS / the stretch row).
export function buildPitchControl(container, key) {
  const t = S.tracks[key];
  const wrap = document.createElement('div');
  wrap.className = 'knob-group pitch-group';
  const sel = document.createElement('select');
  sel.className = 'pitch-sel'; sel.id = 'pitch-' + key;
  sel.title = 'Key change — shift this track up/down in semitones (tempo preserved, done on the server)';
  for (let n = 12; n >= -12; n--) {
    const o = document.createElement('option'); o.value = n; o.textContent = fmtSemis(n); sel.appendChild(o);
  }
  sel.value = String(t.pitchSemis || 0);
  sel.addEventListener('mousedown', e => e.stopPropagation());
  sel.addEventListener('change', () => pitchTrack(key, parseInt(sel.value, 10)));
  const lbl = document.createElement('div'); lbl.className = 'knob-label'; lbl.textContent = 'KEY';
  wrap.append(sel, lbl);
  container.appendChild(wrap);
}

function setBusy(key, busy) {
  const sel = document.getElementById('pitch-' + key);
  if (!sel) return;
  sel.disabled = busy;
  sel.classList.toggle('busy', busy);
  if (!busy) sel.value = String(S.tracks[key]?.pitchSemis || 0);
}

// Replay the ripple-cut log on a full-length (uncut) server stem.
function replayCuts(buf) {
  for (const c of (S._cutLog || [])) buf = spliceBuffer(buf, c.a, c.len);
  return buf;
}

// Shift one track to `semis` (absolute, −12…+12). Returns true on success.
export async function pitchTrack(key, semis, { quiet = false } = {}) {
  const t = S.tracks[key];
  if (!t || !t.buffer) return false;
  semis = Math.max(-12, Math.min(12, Math.round(semis || 0)));
  const cur = t.pitchSemis || 0;
  if (semis === cur) { setBusy(key, false); return true; }

  // Back to 0 with the original kept → instant, no server trip
  if (semis === 0 && t._prePitchBuffer) {
    applyBuffer(t, t._prePitchBuffer, 0); t._prePitchBuffer = null; setBusy(key, false);
    return true;
  }

  setBusy(key, true);
  try {
    let res, fromOriginal = true;
    const ref = !t._editedAudio && (t.isImport ? t._stemRef : (S._sepId ? { sepId: S._sepId, stemName: baseStemOf(key) } : null));
    if (ref && !t.isImport) {
      // Untouched separated stem (cuts are replayed locally) — efficient server path
      res = await fetch(`/pitchshift/${ref.sepId}/${encodeURIComponent(ref.stemName)}?semitones=${semis}`, { method: 'POST' });
    } else {
      // Imported / edited audio — upload the pre-pitch buffer as WAV
      const src = t._prePitchBuffer || t.buffer;
      fromOriginal = !!t._prePitchBuffer || cur === 0;
      const n = fromOriginal ? semis : semis - cur;
      const form = new FormData();
      form.append('file', new Blob([audioBufferToWav(src)], { type: 'audio/wav' }), 'track.wav');
      res = await fetch(`/pitchshift?semitones=${n}`, { method: 'POST', body: form });
    }
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(res.status === 404 && !e.detail ? 'the pitch-shift endpoint is not available on this server' : (e.detail || `Server error ${res.status}`));
    }
    let abuf = await S._actx.decodeAudioData(await res.arrayBuffer());
    if (ref && !t.isImport) abuf = replayCuts(abuf);
    if (!t._prePitchBuffer && cur === 0) t._prePitchBuffer = t.buffer;
    applyBuffer(t, abuf, semis);
    return true;
  } catch (err) {
    console.warn('Pitch shift failed:', err);
    if (!quiet) alert('Key change failed: ' + err.message);
    return false;
  } finally {
    setBusy(key, false);
  }
}

function applyBuffer(t, abuf, semis) {
  t.buffer = abuf;
  t.pitchSemis = semis;
  t.peaks = computePeaks(abuf);
  t._specCache = null;
  redrawAll();
  updateAudioInfo();
  if (S._playing) seekTo(currentPosition());   // restart sources on the new buffer
}

// "Key ±": shift every track to the same absolute key offset, one after another.
export async function shiftAllKeys(delta) {
  if (!S._actx || !Object.keys(S.tracks).length) return;
  const base = commonShift() ?? 0;
  const target = Math.max(-12, Math.min(12, base + delta));
  const keys = Object.keys(S.tracks);
  const lbl = document.getElementById('key-all-val');
  const btns = document.querySelectorAll('.key-all-btn');
  btns.forEach(b => { b.disabled = true; });
  let ok = 0, failed = [];
  try {
    for (let i = 0; i < keys.length; i++) {
      if (lbl) lbl.textContent = `⏳${i + 1}/${keys.length}`;
      // duplicates that still share their base stem's buffer are processed like any other track
      if (await pitchTrack(keys[i], target, { quiet: true })) ok++; else failed.push(keys[i]);
    }
  } finally {
    btns.forEach(b => { b.disabled = false; });
    updateAudioInfo();
  }
  if (failed.length) alert(`Key change failed on ${failed.length} track(s): ${failed.join(', ')}.\n\nIs the server's /pitchshift endpoint available?`);
  return { ok, failed, target };
}
