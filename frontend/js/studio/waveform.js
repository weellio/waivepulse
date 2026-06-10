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

export function drawPositionedWaveform(canvas, peaks, color, dimmed, startTime, bufDur, songDur, loop = false) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800, h = canvas.clientHeight || 72;
  canvas.width = w * dpr; canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#080808'; ctx.fillRect(0, 0, w, h);   // dark void background
  if (!songDur) return;

  const xS  = Math.round((startTime / songDur) * w);
  const cw  = Math.max(2, Math.round((bufDur / songDur) * w));
  const endX = loop ? w : xS + cw;                        // fill to song end when looping
  const mid = h / 2;
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, dimmed ? '#2a2a2a' : color + 'cc');
  grad.addColorStop(.5, dimmed ? '#1a1a1a' : color + '55');
  grad.addColorStop(1, dimmed ? '#2a2a2a' : color + 'cc');

  // region background
  ctx.fillStyle = dimmed ? '#161616' : '#111';
  ctx.fillRect(xS, 0, endX - xS, h);

  // waveform bars, tiled across each repeat
  const numBars = Math.max(1, Math.floor(cw));
  const stepP = peaks.length / numBars;
  const bw = cw / numBars;
  ctx.fillStyle = grad;
  for (let tileX = xS; tileX < endX - 0.5; tileX += cw) {
    for (let i = 0; i < numBars; i++) {
      const x = tileX + i * bw;
      if (x >= endX) break;
      const amp = peaks[Math.floor(i * stepP)] * mid * .9;
      ctx.fillRect(x, mid - amp, Math.max(0.5, bw * .75), amp * 2);
    }
    // faint divider at each loop boundary (skip the very first)
    if (loop && tileX > xS) {
      ctx.strokeStyle = dimmed ? '#262626' : color + '33'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(tileX + .5, 2); ctx.lineTo(tileX + .5, h - 2); ctx.stroke();
    }
  }

  // outer border + edge handles
  ctx.strokeStyle = dimmed ? '#2a2a2a' : color + '88';
  ctx.lineWidth = 1; ctx.strokeRect(xS + .5, 1, (endX - xS) - 1, h - 2);
  ctx.strokeStyle = dimmed ? '#444' : color;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(xS + 1, 4); ctx.lineTo(xS + 1, h - 4); ctx.stroke();
  if (!loop) { ctx.beginPath(); ctx.moveTo(xS + cw - 1, 4); ctx.lineTo(xS + cw - 1, h - 4); ctx.stroke(); }
}

export function redrawAll() {
  const sc = soloCount();
  for (const [key, t] of Object.entries(S.tracks)) {
    if (t.canvas && t.peaks) {
      const dimmed = t.muted || (sc > 0 && !t.solo);
      if (t.isImport) {
        drawPositionedWaveform(t.canvas, t.peaks, IMPORT_COLOR, dimmed, t.startTime || 0, t.buffer.duration, S._dur, !!t.loopTrack);
      } else {
        drawWaveform(t.canvas, t.peaks, STEM_COLORS[baseStemOf(key)] || IMPORT_COLOR, dimmed);
      }
      const ranges = [...(t.muteRanges || [])];
      if (S._rangeDrawing && S._rangeDrawing.stemKey === key)
        ranges.push({ start: Math.min(S._rangeDrawing.startPos, S._rangeDrawing.currentPos), end: Math.max(S._rangeDrawing.startPos, S._rangeDrawing.currentPos) });
      drawMuteRanges(t.canvas, ranges, S._dur);
    }
  }
  drawChords();
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

// ── Chord overlay ─────────────────────────────────────────────────────────────
export function drawChords() {
  let row = document.getElementById('chord-row');
  if (!row) {
    row = document.createElement('div');
    row.id = 'chord-row';
    row.style.cssText = 'position:relative;height:20px;width:100%;pointer-events:none;overflow:hidden;flex-shrink:0';
    // Insert between ruler-inner and the first track-row
    const sc = document.getElementById('scroll-content');
    const firstTrack = sc.querySelector('.track-row');
    if (firstTrack) sc.insertBefore(row, firstTrack);
    else sc.appendChild(row);
  }
  row.innerHTML = '';
  row.style.display = S._showChords && S._chords?.length ? '' : 'none';
  if (!S._showChords || !S._chords?.length || !S._dur) return;

  const cw = document.getElementById('content-area').clientWidth * S._zoom;
  for (const c of S._chords) {
    const lbl = document.createElement('span');
    lbl.textContent = c.chord;
    const x = (c.start / S._dur) * cw;
    const w = ((c.end - c.start) / S._dur) * cw;
    lbl.style.cssText =
      `position:absolute;left:${x}px;width:${Math.max(w, 20)}px;top:1px;` +
      'font-size:10px;color:#e8cc4a;font-weight:700;text-align:center;' +
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
      'font-family:"Courier New",monospace;letter-spacing:.3px';
    row.appendChild(lbl);
  }
}

export function toggleChords() {
  S._showChords = !S._showChords;
  const btn = document.getElementById('chord-btn');
  if (btn) {
    btn.classList.toggle('active', S._showChords);
    btn.textContent = S._showChords ? 'CHORDS ON' : 'CHORDS';
  }
  drawChords();
}
