// Vocal Harmonizer — pitch-detect (autocorrelation) + dual-grain pitch shift
// to fixed semitone intervals.  Creates 1–2 harmony voices from the mic input.
class Harmonizer extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name:'mix',       defaultValue:0,   minValue:0,   maxValue:1 },
      { name:'voice1Semi',defaultValue:4,   minValue:-12, maxValue:12 },
      { name:'voice2Semi',defaultValue:7,   minValue:-12, maxValue:12 },
      { name:'voice1Vol', defaultValue:0.5, minValue:0,   maxValue:1 },
      { name:'voice2Vol', defaultValue:0.5, minValue:0,   maxValue:1 },
      { name:'voice2On',  defaultValue:0,   minValue:0,   maxValue:1 },
    ];
  }
  constructor() {
    super();
    this.sr   = sampleRate;
    this.buf  = new Float32Array(16384);
    this.blen = this.buf.length;
    this.wp   = 0;

    // Pitch detection state
    this.win  = 1024;
    this.ana  = new Float32Array(this.win);
    this.fill = 0;
    this.detectedF0 = 0;

    // Dual-grain pitch shifter state — one set per voice
    this.grain = Math.floor(0.030 * this.sr);   // ~30 ms grains
    this.phase1 = 0;
    this.phase2 = 0;
  }

  /* ── Autocorrelation pitch detection (same technique as autotune) ── */
  detect() {
    const a = this.ana, n = this.win;
    let rms = 0;
    for (let i = 0; i < n; i++) rms += a[i] * a[i];
    if (Math.sqrt(rms / n) < 0.01) return 0;          // gate silence

    const minLag = Math.floor(this.sr / 600);
    const maxLag = Math.floor(this.sr / 70);
    let bestLag = -1, best = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let c = 0;
      for (let i = 0; i < n - lag; i++) c += a[i] * a[i + lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    return bestLag > 0 ? this.sr / bestLag : 0;
  }

  /* ── Linear interpolation from the circular buffer ── */
  lerp(pos) {
    const i0 = Math.floor(pos), f = pos - i0;
    const a = this.buf[((i0 % this.blen) + this.blen) % this.blen];
    const b = this.buf[(((i0 + 1) % this.blen) + this.blen) % this.blen];
    return a + (b - a) * f;
  }

  /* ── Dual-grain pitch-shift one voice ── */
  shiftGrain(phase, ratio) {
    // Advance the grain phase
    phase += (ratio - 1) / this.grain;
    phase -= Math.floor(phase);
    const ph2 = (phase + 0.5) % 1;
    const s1 = this.lerp(this.wp - phase * this.grain);
    const s2 = this.lerp(this.wp - ph2 * this.grain);
    const w1 = Math.sin(Math.PI * phase), w2 = Math.sin(Math.PI * ph2);
    const sample = (s1 * w1 + s2 * w2) / ((w1 + w2) || 1);
    return { sample, phase };
  }

  process(inputs, outputs, p) {
    const inp = inputs[0][0], out = outputs[0][0];
    if (!inp || !out) return true;

    const mix      = p.mix[0];
    const v1Semi   = p.voice1Semi[0];
    const v2Semi   = p.voice2Semi[0];
    const v1Vol    = p.voice1Vol[0];
    const v2Vol    = p.voice2Vol[0];
    const v2On     = p.voice2On[0] >= 0.5;

    const ratio1   = Math.pow(2, v1Semi / 12);
    const ratio2   = Math.pow(2, v2Semi / 12);

    for (let i = 0; i < inp.length; i++) {
      const x = inp[i];

      // Write into circular buffer
      this.buf[this.wp] = x;

      // Accumulate analysis window
      this.ana[this.fill++] = x;
      if (this.fill >= this.win) {
        this.detectedF0 = this.detect();
        this.fill = 0;
      }

      // If no pitch or mix is zero, pass through dry
      if (this.detectedF0 <= 0 || mix <= 0) {
        out[i] = x;
        this.wp = (this.wp + 1) % this.blen;
        continue;
      }

      // Voice 1 — always active when mix > 0
      const g1 = this.shiftGrain(this.phase1, ratio1);
      this.phase1 = g1.phase;
      let harmony = g1.sample * v1Vol;

      // Voice 2 — optional
      if (v2On) {
        const g2 = this.shiftGrain(this.phase2, ratio2);
        this.phase2 = g2.phase;
        harmony += g2.sample * v2Vol;
      }

      out[i] = x + harmony * mix;
      this.wp = (this.wp + 1) % this.blen;
    }
    return true;
  }
}
registerProcessor('harmonizer', Harmonizer);
