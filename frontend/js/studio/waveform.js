// Waveform peak computation + canvas rendering, plus mute-region overlays.
import { S, STEM_COLORS, IMPORT_COLOR, PEAK_BINS } from './state.js';
import { baseStemOf } from './tracks.js';

export function computePeaks(buf) {
  const data = buf.getChannelData(0), step = Math.ceil(data.length / PEAK_BINS);
  const peaks = new Float32Array(PEAK_BINS);
  for (let i = 0; i < PEAK_BINS; i++) {
    let max = 0; const s = i * step;
    for (let j = 0; j < step && s + j < data.length; j++) { const v = Math.abs(data[s + j]); if (v > max) max = v; }
    peaks[i] = max;
  }
  return peaks;
}

export function drawWaveform(canvas, peaks, color, dimmed) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800, h = canvas.clientHeight || 72;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const mid = h / 2;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, dimmed ? '#2a2a2a' : color + 'cc');
  grad.addColorStop(.5, dimmed ? '#1a1a1a' : color + '55');
  grad.addColorStop(1, dimmed ? '#2a2a2a' : color + 'cc');
  ctx.fillStyle = grad;
  const bw = Math.max(1, w / peaks.length);
  for (let i = 0; i < peaks.length; i++) { const amp = peaks[i] * mid * .9; ctx.fillRect(i * bw, mid - amp, bw * .75, amp * 2); }
}

export function drawPositionedWaveform(canvas, peaks, color, dimmed, startTime, bufDur, songDur) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800, h = canvas.clientHeight || 72;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  // dark void background
  ctx.fillStyle = '#080808'; ctx.fillRect(0, 0, w, h);
  if (!songDur) return;
  const xS = Math.round((startTime / songDur) * w);
  const cw = Math.max(2, Math.round((bufDur / songDur) * w));
  // clip region background
  ctx.fillStyle = dimmed ? '#161616' : '#111';
  ctx.fillRect(xS, 0, cw, h);
  // waveform bars — subsample peaks to fit within clip pixels
  const mid = h / 2;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, dimmed ? '#2a2a2a' : color + 'cc');
  grad.addColorStop(.5, dimmed ? '#1a1a1a' : color + '55');
  grad.addColorStop(1, dimmed ? '#2a2a2a' : color + 'cc');
  ctx.fillStyle = grad;
  const numBars = Math.max(1, Math.floor(cw));
  const step = peaks.length / numBars;
  const bw = cw / numBars;
  for (let i = 0; i < numBars; i++) {
    const amp = peaks[Math.floor(i * step)] * mid * .9;
    ctx.fillRect(xS + i * bw, mid - amp, Math.max(0.5, bw * .75), amp * 2);
  }
  // border + edge handles
  ctx.strokeStyle = dimmed ? '#2a2a2a' : color + '88';
  ctx.lineWidth = 1; ctx.strokeRect(xS + .5, 1, cw - 1, h - 2);
  ctx.strokeStyle = dimmed ? '#444' : color;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(xS + 1, 4); ctx.lineTo(xS + 1, h - 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(xS + cw - 1, 4); ctx.lineTo(xS + cw - 1, h - 4); ctx.stroke();
}

export function redrawAll() {
  const sc = soloCount();
  for (const [key, t] of Object.entries(S.tracks)) {
    if (t.canvas && t.peaks) {
      const dimmed = t.muted || (sc > 0 && !t.solo);
      if (t.isImport) {
        drawPositionedWaveform(t.canvas, t.peaks, IMPORT_COLOR, dimmed, t.startTime || 0, t.buffer.duration, S._dur);
      } else {
        drawWaveform(t.canvas, t.peaks, STEM_COLORS[baseStemOf(key)] || IMPORT_COLOR, dimmed);
      }
      const ranges = [...(t.muteRanges || [])];
      if (S._rangeDrawing && S._rangeDrawing.stemKey === key)
        ranges.push({ start: Math.min(S._rangeDrawing.startPos, S._rangeDrawing.currentPos), end: Math.max(S._rangeDrawing.startPos, S._rangeDrawing.currentPos) });
      drawMuteRanges(t.canvas, ranges, S._dur);
    }
  }
}

export function drawMuteRanges(canvas, ranges, dur) {
  if (!ranges || !ranges.length || !dur) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width / dpr, h = canvas.height / dpr;
  const ctx = canvas.getContext('2d');
  ctx.save(); ctx.fillStyle = 'rgba(220,50,50,0.38)';
  for (const r of ranges) {
    if (r.end <= r.start) continue;
    ctx.fillRect((r.start / dur) * w, 0, ((r.end - r.start) / dur) * w, h);
  }
  ctx.restore();
}

export function mergeRanges(ranges) {
  if (!ranges || ranges.length <= 1) return ranges || [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end + 0.05) last.end = Math.max(last.end, sorted[i].end);
    else merged.push({ ...sorted[i] });
  }
  return merged;
}

export function soloCount() { return Object.values(S.tracks).filter(t => t.solo).length; }
