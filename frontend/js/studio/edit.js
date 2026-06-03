// Destructive timeline editing: cut a region out of ALL tracks at once and ripple
// the rest left, so the song actually gets shorter (vs. mute, which leaves the gap).
// Cheap multi-level undo — AudioBuffers are immutable, so a snapshot just holds the
// old buffer references plus per-track positioning.
import { S } from './state.js';
import { computePeaks, redrawAll } from './waveform.js';
import { stopPlayback, updatePlayhead, buildRuler, updateLoopRegion } from './transport.js';
import { fmtTime } from './util.js';

// Return a new buffer with [cutStartSec, cutStartSec+cutLenSec) removed and the gap closed.
function spliceBuffer(buf, cutStartSec, cutLenSec) {
  const sr = buf.sampleRate, total = buf.length;
  const cs = Math.max(0, Math.floor(cutStartSec * sr));
  const ce = Math.min(total, Math.floor((cutStartSec + cutLenSec) * sr));
  if (ce <= cs) return buf;
  const out = S._actx.createBuffer(buf.numberOfChannels, Math.max(1, total - (ce - cs)), sr);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const src = buf.getChannelData(ch), dst = out.getChannelData(ch);
    dst.set(src.subarray(0, cs), 0);
    dst.set(src.subarray(ce), cs);
  }
  return out;
}

function snapshot() {
  return {
    dur: S._dur,
    startOff: S._startOff,
    tracks: Object.fromEntries(Object.entries(S.tracks).map(([k, t]) => [k, {
      buffer: t.buffer, startTime: t.startTime, muteRanges: (t.muteRanges || []).map(r => ({ ...r })),
    }])),
  };
}

function refreshTimeline() {
  document.getElementById('duration-display').textContent = '/ ' + fmtTime(S._dur);
  buildRuler();
  redrawAll();
  updateLoopRegion();
  updatePlayhead(S._startOff);
  document.getElementById('time-display').textContent = fmtTime(S._startOff);
  const ub = document.getElementById('uncut-btn');
  if (ub) ub.disabled = !(S._cutUndo && S._cutUndo.length);
}

export function cutRegion() {
  if (!S._actx || !Object.keys(S.tracks).length) return;
  if (S._loopStart === null || S._loopEnd === null) {
    alert('Select a region first: drag across the ruler (or press [ and ] at two playhead positions), then Cut.');
    return;
  }
  const a = Math.max(0, Math.min(S._loopStart, S._loopEnd));
  const b = Math.min(S._dur, Math.max(S._loopStart, S._loopEnd));
  const cutLen = b - a;
  if (cutLen < 0.02) { alert('That region is too short to cut — drag a wider selection.'); return; }
  if (!confirm(`Cut ${fmtTime(cutLen)} from every track (${fmtTime(a)}–${fmtTime(b)}) and close the gap?\n\nThe song will shorten to ${fmtTime(S._dur - cutLen)}. You can Uncut to undo.`)) return;

  if (S._playing) stopPlayback();
  (S._cutUndo = S._cutUndo || []).push(snapshot());

  const tx = x => x <= a ? x : (x >= b ? x - cutLen : a);   // ripple time-map
  for (const [, t] of Object.entries(S.tracks)) {
    if (t.isImport && t.loopTrack) {
      // "fill" clip — it re-tiles to fill whatever the song length is, so leave it
    } else if (t.isImport) {
      const st = t.startTime || 0, d = t.buffer.duration, end = st + d;
      if (end <= a) {
        // entirely before the cut — untouched
      } else if (st >= b) {
        t.startTime = st - cutLen;                          // entirely after — slide left
      } else {
        const ls = Math.max(0, a - st), le = Math.min(d, b - st);   // overlap → splice clip
        const nb = spliceBuffer(t.buffer, ls, le - ls);
        t.buffer = nb;
        if (st >= a) t.startTime = Math.max(0, a);          // clip started inside the cut
      }
    } else {
      t.buffer = spliceBuffer(t.buffer, a, cutLen);         // full-length stem — splice directly
    }
    if (t.muteRanges?.length) {
      t.muteRanges = t.muteRanges.map(r => ({ start: tx(r.start), end: tx(r.end) }))
                                 .filter(r => r.end - r.start > 0.03);
    }
    if (t.buffer) t.peaks = computePeaks(t.buffer);
  }

  S._startOff = Math.min(tx(S._startOff), S._dur - cutLen);
  S._dur = Math.max(0.05, S._dur - cutLen);
  S._loopStart = S._loopEnd = null;
  refreshTimeline();
}

export function undoCut() {
  const snap = (S._cutUndo || []).pop();
  if (!snap) return;
  if (S._playing) stopPlayback();
  S._dur = snap.dur;
  S._startOff = snap.startOff;
  for (const [k, s] of Object.entries(snap.tracks)) {
    const t = S.tracks[k];
    if (!t) continue;
    t.buffer = s.buffer; t.startTime = s.startTime; t.muteRanges = s.muteRanges;
    t.peaks = computePeaks(t.buffer);
  }
  S._loopStart = S._loopEnd = null;
  refreshTimeline();
}
