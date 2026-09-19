// ITU-R BS.1770-4 loudness + true-peak measurement, plus a gain/limiter helper
// for hitting a loudness target (streaming-style normalization).
//
// Works on a real AudioBuffer OR any duck-typed object exposing
// { numberOfChannels, sampleRate, length, getChannelData(c) } — so the same
// code runs (and is unit-checked) under node as well as in the browser.
//
//   measureLoudness(buf)          -> { lufs, truePeakDb, samplePeakDb }
//   kWeightCoeffs(sampleRate)     -> [shelf, highpass] biquad coefficient sets
//   truePeakDb(buf)               -> 4x-oversampled true-peak estimate (dBTP)
//   normalizeToTarget(buf, lufs, { ceilingDb }) -> mutates buf in place
//
// Filter design follows the BS.1770 reference (as used by libebur128 /
// pyloudnorm): the two K-weighting stages are re-derived for ANY sample rate,
// so 44.1 kHz renders are measured exactly, not with the 48 kHz table.

const LOG10 = Math.log10;
const dbFromLin = (v) => (v > 0 ? 20 * LOG10(v) : -Infinity);

/** K-weighting pre-filter (high shelf) + RLB high-pass, bilinear-transformed at fs. */
export function kWeightCoeffs(fs) {
  // Stage 1: high shelf (+~4 dB above ~1.7 kHz — head acoustics)
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const shelf = {
    b0: (Vh + Vb * K / Q + K * K) / a0,
    b1: 2 * (K * K - Vh) / a0,
    b2: (Vh - Vb * K / Q + K * K) / a0,
    a1: 2 * (K * K - 1) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
  // Stage 2: RLB high-pass (~38 Hz)
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / fs);
  a0 = 1 + K / Q + K * K;
  const hp = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [shelf, hp];
}

// Channel weights per BS.1770 (L, R, C = 1.0; Ls, Rs = 1.41; LFE excluded for 5.1).
function channelWeight(c, nc) {
  if (nc === 6 && c === 3) return 0;          // LFE
  if (nc >= 5 && (c === 4 || c === 5 || (nc === 5 && c === 3))) return 1.41;
  return 1;
}

/**
 * Sum of squared K-weighted samples per 100 ms hop (all channels, weighted).
 * Returns { hops: Float64Array, hopLen } — 400 ms blocks = 4 consecutive hops.
 */
function kWeightedHopEnergy(buf) {
  const fs = buf.sampleRate, n = buf.length, nc = buf.numberOfChannels;
  const hopLen = Math.max(1, Math.round(fs * 0.1));
  const nHops = Math.floor(n / hopLen);
  const hops = new Float64Array(nHops);
  const [s, h] = kWeightCoeffs(fs);
  for (let c = 0; c < nc; c++) {
    const w = channelWeight(c, nc); if (!w) continue;
    const x = buf.getChannelData(c);
    // Two cascaded biquads (direct form I), accumulated per hop.
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
    for (let k = 0; k < nHops; k++) {
      let acc = 0;
      const end = (k + 1) * hopLen;
      for (let i = k * hopLen; i < end; i++) {
        const xi = x[i];
        const y = s.b0 * xi + s.b1 * x1 + s.b2 * x2 - s.a1 * y1 - s.a2 * y2;
        x2 = x1; x1 = xi;
        const z = y - 2 * y1 + y2 - h.a1 * z1 - h.a2 * z2;  // hp: b = [1,-2,1]
        y2 = y1; y1 = y;
        z2 = z1; z1 = z;
        acc += z * z;
      }
      hops[k] += w * acc;
    }
  }
  return { hops, hopLen };
}

/** Gated integrated loudness (LUFS) from per-hop energies. */
function integratedFromHops(hops, hopLen) {
  const blockLen = 4 * hopLen;
  const nBlocks = hops.length - 3;
  if (nBlocks < 1) {
    // Shorter than one 400 ms block — fall back to ungated mean over what exists.
    let e = 0; for (const v of hops) e += v;
    const ms = e / Math.max(1, hops.length * hopLen);
    return ms > 0 ? -0.691 + 10 * LOG10(ms) : -Infinity;
  }
  const z = new Float64Array(nBlocks);
  for (let j = 0; j < nBlocks; j++) z[j] = (hops[j] + hops[j + 1] + hops[j + 2] + hops[j + 3]) / blockLen;
  const L = (ms) => -0.691 + 10 * LOG10(ms);
  // Absolute gate: -70 LUFS
  let sum = 0, cnt = 0;
  for (let j = 0; j < nBlocks; j++) if (z[j] > 0 && L(z[j]) > -70) { sum += z[j]; cnt++; }
  if (!cnt) return -Infinity;
  // Relative gate: -10 LU below the abs-gated loudness
  const relGate = L(sum / cnt) - 10;
  let sum2 = 0, cnt2 = 0;
  for (let j = 0; j < nBlocks; j++) if (z[j] > 0 && L(z[j]) > -70 && L(z[j]) > relGate) { sum2 += z[j]; cnt2++; }
  return cnt2 ? L(sum2 / cnt2) : -Infinity;
}

/** Integrated loudness only (fast — no true-peak pass). */
export function integratedLufs(buf) {
  const { hops, hopLen } = kWeightedHopEnergy(buf);
  return integratedFromHops(hops, hopLen);
}

// 4x polyphase interpolator: 12 taps per phase (48-tap total, like the BS.1770
// Annex 2 example), Kaiser-windowed sinc. Phases 1..3 are the in-between points.
const TP_TAPS = 12, TP_HALF = TP_TAPS / 2;
const TP_PHASES = (() => {
  const beta = 5.0;
  const i0 = (x) => { let s = 1, t = 1; for (let k = 1; k < 30; k++) { t *= (x / (2 * k)) ** 2; s += t; } return s; };
  const out = [];
  for (let p = 1; p < 4; p++) {
    const frac = p / 4, taps = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let k = 0; k < TP_TAPS; k++) {
      const t = (k - (TP_HALF - 1)) - frac;          // tap offsets -5..6 relative to n, minus frac
      const sinc = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
      const r = t / (TP_HALF + 0.5);
      const win = Math.abs(r) >= 1 ? 0 : i0(beta * Math.sqrt(1 - r * r)) / i0(beta);
      taps[k] = sinc * win; sum += taps[k];
    }
    for (let k = 0; k < TP_TAPS; k++) taps[k] /= sum;   // unity DC gain
    out.push(taps);
  }
  return out;
})();

/** Peak |sample| across channels (linear). */
export function samplePeak(buf) {
  let pk = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < x.length; i++) { const a = x[i] < 0 ? -x[i] : x[i]; if (a > pk) pk = a; }
  }
  return pk;
}

/** 4x-oversampled true-peak estimate, linear. */
export function truePeakLin(buf) {
  let pk = 0;
  const [h1, h2, h3] = TP_PHASES;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c), n = x.length;
    for (let i = 0; i < n; i++) {
      const a = x[i] < 0 ? -x[i] : x[i]; if (a > pk) pk = a;
    }
    // Inter-sample points. Skip positions whose neighbourhood is far below the
    // running peak — an inter-sample overshoot can't exceed ~2x the local max.
    for (let i = TP_HALF - 1; i < n - TP_HALF; i++) {
      const a0 = x[i] < 0 ? -x[i] : x[i], a1 = x[i + 1] < 0 ? -x[i + 1] : x[i + 1];
      if ((a0 > a1 ? a0 : a1) * 2 < pk) continue;
      const base = i - (TP_HALF - 1);
      let s1 = 0, s2 = 0, s3 = 0;
      for (let k = 0; k < TP_TAPS; k++) { const v = x[base + k]; s1 += v * h1[k]; s2 += v * h2[k]; s3 += v * h3[k]; }
      if (s1 < 0) s1 = -s1; if (s2 < 0) s2 = -s2; if (s3 < 0) s3 = -s3;
      if (s1 > pk) pk = s1; if (s2 > pk) pk = s2; if (s3 > pk) pk = s3;
    }
  }
  return pk;
}

export function truePeakDb(buf) { return dbFromLin(truePeakLin(buf)); }

/** Full measurement: integrated LUFS, true peak (dBTP), sample peak (dBFS). */
export function measureLoudness(buf) {
  return {
    lufs: integratedLufs(buf),
    truePeakDb: truePeakDb(buf),
    samplePeakDb: dbFromLin(samplePeak(buf)),
  };
}

function scaleBuffer(buf, g) {
  if (g === 1) return;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < x.length; i++) x[i] *= g;
  }
}

/**
 * Lookahead peak limiter (offline, in place). Linked across channels.
 * Gain never exceeds what is required at any sample (sliding-min over the
 * lookahead window, then a box-average of the same length), attack = lookahead,
 * exponential release.
 */
export function limitBuffer(buf, ceilingLin, lookaheadMs = 1.5, releaseMs = 80) {
  const n = buf.length, nc = buf.numberOfChannels, fs = buf.sampleRate;
  const L = Math.max(1, Math.round(fs * lookaheadMs / 1000));
  const ch = []; for (let c = 0; c < nc; c++) ch.push(buf.getChannelData(c));
  // Required gain per sample.
  const req = new Float32Array(n);
  let any = false;
  for (let i = 0; i < n; i++) {
    let a = 0; for (let c = 0; c < nc; c++) { const v = ch[c][i] < 0 ? -ch[c][i] : ch[c][i]; if (v > a) a = v; }
    req[i] = a > ceilingLin ? ceilingLin / a : 1;
    if (req[i] < 1) any = true;
  }
  if (!any) return 0;
  // m[j] = min(req[j .. j+L-1]) via monotonic deque.
  const m = new Float32Array(n);
  const dq = new Int32Array(n); let head = 0, tail = 0;
  for (let i = n - 1; i >= 0; i--) {
    while (tail > head && req[dq[tail - 1]] >= req[i]) tail--;
    dq[tail++] = i;
    while (dq[head] > i + L - 1) head++;
    m[i] = req[dq[head]];
  }
  // Release: gain may drop instantly, recovers exponentially (r <= m always).
  const rel = 1 - Math.exp(-1 / (fs * releaseMs / 1000));
  let r = 1;
  for (let i = 0; i < n; i++) { r = r + (1 - r) * rel; if (m[i] < r) r = m[i]; m[i] = r; }
  // Box average over the last L values of r -> smooth attack, still <= req.
  let acc = 0, minG = 1;
  for (let i = 0; i < n; i++) {
    acc += m[i]; if (i >= L) acc -= m[i - L];
    const g = i >= L - 1 ? acc / L : Math.min(acc / (i + 1), m[i]);
    for (let c = 0; c < nc; c++) ch[c][i] *= g;
    if (g < minG) minG = g;
  }
  return -dbFromLin(minG);   // max gain reduction in dB
}

/**
 * Bring `buf` to `targetLufs` in place, keeping true peak <= ceilingDb (dBTP).
 * Gain first; if that would push past the ceiling, a lookahead limiter catches
 * the peaks and the gain is re-trimmed (a few passes) so loudness still lands.
 * Returns { lufs, truePeakDb, samplePeakDb, gainDb, limitedDb, before }.
 */
export function normalizeToTarget(buf, targetLufs, { ceilingDb = -1, maxPasses = 8 } = {}) {
  const before = measureLoudness(buf);
  if (!isFinite(before.lufs)) return { ...before, gainDb: 0, limitedDb: 0, before };
  const ceil = Math.pow(10, ceilingDb / 20);
  let gainDb = targetLufs - before.lufs;
  let limitedDb = 0;
  let tpLin = Math.pow(10, before.truePeakDb / 20);

  if (before.truePeakDb + gainDb <= ceilingDb) {
    scaleBuffer(buf, Math.pow(10, gainDb / 20));          // clean gain, no limiting needed
  } else {
    // Keep an untouched copy so every pass limits the ORIGINAL (no stacking).
    const orig = []; for (let c = 0; c < buf.numberOfChannels; c++) orig.push(Float32Array.from(buf.getChannelData(c)));
    // Sample-domain ceiling a touch under the TP ceiling for inter-sample overs;
    // tightened each pass by however far the measured true peak still overshoots.
    let sampleCeil = ceil * Math.pow(10, -0.3 / 20);
    let g = gainDb, prev = null;
    for (let pass = 0; pass < maxPasses; pass++) {
      const lin = Math.pow(10, g / 20);
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const x = buf.getChannelData(c), o = orig[c];
        for (let i = 0; i < x.length; i++) x[i] = o[i] * lin;
      }
      limitedDb = limitBuffer(buf, sampleCeil);
      const l = integratedLufs(buf);
      tpLin = truePeakLin(buf);
      const miss = targetLufs - l;
      const tpOk = tpLin <= ceil * 1.0001;
      if ((Math.abs(miss) < 0.1 && tpOk) || g > 24) break;
      if (!tpOk) sampleCeil *= ceil / tpLin;               // inter-sample overs: pull the ceiling in
      // Limiter ate some loudness; push more in. Under heavy limiting +1 dB of
      // gain buys < 1 LU, so step by the measured slope (secant), not 1:1.
      let slope = 1;
      if (prev) { const dg = g - prev.g; if (Math.abs(dg) > 1e-3) slope = Math.min(1, Math.max(0.25, (l - prev.l) / dg)); }
      prev = { g, l };
      g += miss / slope;
    }
    gainDb = g;
    tpLin = truePeakLin(buf);
    if (tpLin > ceil) { scaleBuffer(buf, ceil / tpLin); gainDb += dbFromLin(ceil / tpLin); } // final safety clamp
  }
  const after = measureLoudness(buf);
  if (after.truePeakDb > ceilingDb) {                     // clean-gain path overshoot guard
    const t = Math.pow(10, (ceilingDb - after.truePeakDb) / 20);
    scaleBuffer(buf, t); gainDb += dbFromLin(t);
    return { ...measureLoudness(buf), gainDb, limitedDb, before };
  }
  return { ...after, gainDb, limitedDb, before };
}

// Live meter helpers: momentary (400 ms) / short-term (3 s) from 100 ms hops.
export function lufsFromMeanSquare(ms) { return ms > 0 ? -0.691 + 10 * LOG10(ms) : -Infinity; }
