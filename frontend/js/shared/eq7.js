// ── Shared 7-band parametric EQ ───────────────────────────────────────────────
// HPF · low-shelf · 3 bells · high-shelf · LPF — each with freq / gain / Q.
// Used by both the Looper (per-loop) and the Studio (per-track). One source of
// truth for the biquad chain, the response curve, the visual UI, and the
// offline rebuild used when baking an export.

// Band templates. `gain:true` = the band's vertical drag sets gain (shelves/bells).
export const EQ_BANDS = [
  { id: 'hpf',  type: 'highpass',  freq: 30,    gain: 0, q: 0.7, hasGain: false, color: '#f87171' },
  { id: 'low',  type: 'lowshelf',  freq: 120,   gain: 0, q: 0.7, hasGain: true,  color: '#fb923c' },
  { id: 'b1',   type: 'peaking',   freq: 350,   gain: 0, q: 1.0, hasGain: true,  color: '#fbbf24' },
  { id: 'b2',   type: 'peaking',   freq: 1000,  gain: 0, q: 1.0, hasGain: true,  color: '#4ade80' },
  { id: 'b3',   type: 'peaking',   freq: 3500,  gain: 0, q: 1.0, hasGain: true,  color: '#60a5fa' },
  { id: 'high', type: 'highshelf', freq: 8000,  gain: 0, q: 0.7, hasGain: true,  color: '#a78bfa' },
  { id: 'lpf',  type: 'lowpass',   freq: 18000, gain: 0, q: 0.7, hasGain: false, color: '#f472b6' },
];

const FMIN = 20, FMAX = 20000, GMAX = 24;   // display range

// Fresh default band settings (deep copy)
export function defaultBands() {
  return EQ_BANDS.map(b => ({ id: b.id, type: b.type, freq: b.freq, gain: b.gain, q: b.q, hasGain: b.hasGain, color: b.color }));
}

// Build the biquad chain in `ctx` from a settings array. Returns { input, output, filters, bands }.
// `input`/`output` are the chain ends; connect your source → input, output → destination.
export function createEq7(ctx, bands = defaultBands()) {
  const filters = bands.map(b => {
    const f = ctx.createBiquadFilter();
    f.type = b.type;
    f.frequency.value = b.freq;
    f.Q.value = b.q;
    f.gain.value = b.hasGain ? b.gain : 0;
    return f;
  });
  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
  return { input: filters[0], output: filters[filters.length - 1], filters, bands };
}

export function setBand(eq, i, { freq, gain, q }) {
  const b = eq.bands[i], f = eq.filters[i], t = eq.input.context.currentTime;
  if (freq != null) { b.freq = clamp(freq, FMIN, FMAX); f.frequency.setTargetAtTime(b.freq, t, 0.01); }
  if (q != null)    { b.q = clamp(q, 0.1, 18);          f.Q.setTargetAtTime(b.q, t, 0.01); }
  if (gain != null && b.hasGain) { b.gain = clamp(gain, -GMAX, GMAX); f.gain.setTargetAtTime(b.gain, t, 0.01); }
}

export function resetEq(eq) {
  defaultBands().forEach((d, i) => {
    Object.assign(eq.bands[i], d);
    const f = eq.filters[i];
    f.frequency.value = d.freq; f.Q.value = d.q; f.gain.value = d.hasGain ? d.gain : 0;
  });
}

// Snapshot the settings (for persistence / export rebuild)
export function snapshotEq(eq) {
  return eq.bands.map(b => ({ id: b.id, type: b.type, freq: b.freq, gain: b.gain, q: b.q, hasGain: b.hasGain }));
}

// Is this EQ doing anything? (lets callers skip the chain when flat)
export function eqIsFlat(eq) {
  return eq.bands.every(b =>
    (b.id === 'hpf'  && b.freq <= FMIN + 1) ||
    (b.id === 'lpf'  && b.freq >= FMAX - 1) ||
    (b.hasGain && Math.abs(b.gain) < 0.1));
}

// Combined magnitude response (dB) at the given frequencies.
export function responseDb(eq, freqs) {
  const mag = new Float32Array(freqs.length);
  const phase = new Float32Array(freqs.length);
  const total = new Float32Array(freqs.length).fill(1);
  eq.filters.forEach(f => {
    f.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < total.length; i++) total[i] *= mag[i];
  });
  return total.map(m => 20 * Math.log10(m || 1e-6));
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const freqToX = (f, W) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * W;
export const xToFreq = (x, W) => FMIN * Math.pow(FMAX / FMIN, x / W);
export const gainToY = (g, H) => H / 2 - (g / GMAX) * (H / 2 - 10);
export const yToGain = (y, H) => clamp((H / 2 - y) / (H / 2 - 10) * GMAX, -GMAX, GMAX);

// Small filter-type glyph (openDAW-style) per band, stroked in the band colour.
const GLYPH = {
  highpass:  'M1,13 C6,13 8,3 15,3',
  lowshelf:  'M1,4 C6,4 7,8 15,8',
  peaking:   'M1,10 C5,10 6,3 8,3 C10,3 11,10 15,10',
  highshelf: 'M1,8 C9,8 10,4 15,4',
  lowpass:   'M1,3 C8,3 10,13 15,13',
};
const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const fmtFreq = f => f >= 1000 ? (f / 1000).toFixed(f >= 10000 ? 0 : 1) + 'k' : Math.round(f);

// Mounts the openDAW-style EQ: live spectrum, per-band colour fills, combined curve,
// draggable handles, plus an optional readout row (type icon + Freq/dB/Q per band).
// Returns a controller with start()/stop()/resize()/destroy().
export function mountEq7UI(canvas, eq, { analyser = null, onChange = () => {}, readoutEl = null } = {}) {
  const ctx2d = canvas.getContext('2d');
  let raf = null, dragging = -1;
  const N = 256;
  const freqs = new Float32Array(N);
  const mag = new Float32Array(N), phase = new Float32Array(N);
  const specData = analyser ? new Uint8Array(analyser.frequencyBinCount) : null;

  const dpr = () => window.devicePixelRatio || 1;
  const canvasW = () => canvas.width / dpr();
  const canvasH = () => canvas.height / dpr();

  function resize() {
    const d = dpr();
    canvas.width = canvas.offsetWidth * d;
    canvas.height = canvas.offsetHeight * d;
    ctx2d.setTransform(d, 0, 0, d, 0, 0);
    const W = canvasW();
    for (let i = 0; i < N; i++) freqs[i] = xToFreq((i / (N - 1)) * W, W);
  }

  // ── readout row ──
  let readoutCols = [];
  function buildReadout() {
    if (!readoutEl) return;
    readoutEl.innerHTML = '';
    readoutCols = eq.bands.map(b => {
      const col = document.createElement('div');
      col.className = 'eqr-col';
      col.style.color = b.color;
      col.innerHTML =
        `<svg viewBox="0 0 16 16" class="eqr-ic"><path d="${GLYPH[b.type]}" fill="none" stroke="${b.color}" stroke-width="1.5"/></svg>` +
        `<span class="eqr-f"></span><span class="eqr-g"></span><span class="eqr-q"></span>`;
      readoutEl.appendChild(col);
      return { f: col.querySelector('.eqr-f'), g: col.querySelector('.eqr-g'), q: col.querySelector('.eqr-q') };
    });
  }
  function updateReadout() {
    if (!readoutEl) return;
    eq.bands.forEach((b, i) => {
      const c = readoutCols[i]; if (!c) return;
      c.f.textContent = fmtFreq(b.freq) + ' Hz';
      c.g.textContent = b.hasGain ? (b.gain >= 0 ? '+' : '') + b.gain.toFixed(1) + ' dB' : '';
      c.q.textContent = b.q.toFixed(2);
    });
  }

  function nearestBand(px) {
    let best = -1, bd = 1e9;
    eq.bands.forEach((b, i) => { const d = Math.abs(freqToX(b.freq, canvasW()) - px); if (d < bd) { bd = d; best = i; } });
    return bd < 28 ? best : -1;
  }
  const pointerXY = e => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function onDown(e) { dragging = nearestBand(pointerXY(e).x); if (dragging >= 0) { canvas.setPointerCapture(e.pointerId); onMove(e); } }
  function onMove(e) {
    if (dragging < 0) return;
    const { x, y } = pointerXY(e), b = eq.bands[dragging];
    setBand(eq, dragging, { freq: xToFreq(clamp(x, 0, canvasW()), canvasW()), gain: b.hasGain ? yToGain(y, canvasH()) : undefined });
    onChange();
  }
  const onUp = () => { dragging = -1; };
  function onWheel(e) {
    const i = nearestBand(pointerXY(e).x); if (i < 0) return;
    e.preventDefault();
    setBand(eq, i, { q: eq.bands[i].q * (e.deltaY < 0 ? 1.18 : 0.85) });
    onChange();
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointerleave', onUp);
  canvas.addEventListener('wheel', onWheel, { passive: false });

  function draw() {
    const W = canvasW(), H = canvasH(), zero = gainToY(0, H);
    ctx2d.clearRect(0, 0, W, H);

    // grid + axis labels
    ctx2d.font = '9px system-ui'; ctx2d.textBaseline = 'top';
    ctx2d.strokeStyle = 'rgba(255,255,255,.05)'; ctx2d.fillStyle = 'rgba(255,255,255,.28)'; ctx2d.lineWidth = 1;
    FREQ_TICKS.forEach(f => { const gx = freqToX(f, W);
      ctx2d.beginPath(); ctx2d.moveTo(gx, 0); ctx2d.lineTo(gx, H); ctx2d.stroke();
      ctx2d.fillText(fmtFreq(f), gx + 2, 2); });
    [-24, -12, 12, 24].forEach(g => { const gy = gainToY(g, H);
      ctx2d.strokeStyle = 'rgba(255,255,255,.045)'; ctx2d.beginPath(); ctx2d.moveTo(0, gy); ctx2d.lineTo(W, gy); ctx2d.stroke();
      ctx2d.fillText((g > 0 ? '+' : '') + g, 2, gy + 1); });
    ctx2d.strokeStyle = 'rgba(255,255,255,.16)'; ctx2d.beginPath(); ctx2d.moveTo(0, zero); ctx2d.lineTo(W, zero); ctx2d.stroke();

    // live spectrum (post-EQ)
    if (analyser) {
      analyser.getByteFrequencyData(specData);
      const sr = analyser.context.sampleRate, bins = specData.length;
      ctx2d.beginPath(); ctx2d.moveTo(0, H);
      for (let x = 0; x <= W; x += 2) {
        const bin = Math.min(bins - 1, Math.round(xToFreq(x, W) / (sr / 2) * bins));
        ctx2d.lineTo(x, H - (specData[bin] / 255) * H * 0.92);
      }
      ctx2d.lineTo(W, H); ctx2d.closePath();
      ctx2d.fillStyle = 'rgba(140,255,255,.08)'; ctx2d.fill();
    }

    // per-band colour fills (each band's individual contribution)
    eq.filters.forEach((f, bi) => {
      f.getFrequencyResponse(freqs, mag, phase);
      ctx2d.beginPath(); ctx2d.moveTo(0, zero);
      for (let i = 0; i < N; i++) ctx2d.lineTo((i / (N - 1)) * W, gainToY(20 * Math.log10(mag[i] || 1e-6), H));
      ctx2d.lineTo(W, zero); ctx2d.closePath();
      ctx2d.fillStyle = hexA(eq.bands[bi].color, 0.16); ctx2d.fill();
    });

    // combined response curve
    const db = responseDb(eq, freqs);
    ctx2d.beginPath();
    for (let i = 0; i < N; i++) { const x = (i / (N - 1)) * W, y = gainToY(db[i], H); i ? ctx2d.lineTo(x, y) : ctx2d.moveTo(x, y); }
    ctx2d.strokeStyle = '#e8e8ee'; ctx2d.lineWidth = 2; ctx2d.stroke();

    // draggable handles
    eq.bands.forEach(b => {
      const x = freqToX(b.freq, W), y = b.hasGain ? gainToY(b.gain, H) : zero;
      ctx2d.beginPath(); ctx2d.arc(x, y, 5.5, 0, Math.PI * 2);
      ctx2d.fillStyle = b.color; ctx2d.fill();
      ctx2d.strokeStyle = 'rgba(0,0,0,.5)'; ctx2d.lineWidth = 1; ctx2d.stroke();
    });

    updateReadout();
    raf = requestAnimationFrame(draw);
  }

  const ctrl = {
    start() { resize(); buildReadout(); if (!raf) draw(); },
    stop()  { if (raf) cancelAnimationFrame(raf); raf = null; },
    resize,
    destroy() {
      ctrl.stop();
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerleave', onUp);
      canvas.removeEventListener('wheel', onWheel);
    },
  };
  return ctrl;
}

// "#rrggbb" + alpha → rgba()
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Rebuild the chain in an OfflineAudioContext from a snapshot (for Export Mix).
export function applyEqOffline(offctx, snapshot) {
  const filters = snapshot.map(b => {
    const f = offctx.createBiquadFilter();
    f.type = b.type; f.frequency.value = b.freq; f.Q.value = b.q;
    f.gain.value = b.hasGain ? b.gain : 0;
    return f;
  });
  for (let i = 0; i < filters.length - 1; i++) filters[i].connect(filters[i + 1]);
  return { input: filters[0], output: filters[filters.length - 1] };
}
