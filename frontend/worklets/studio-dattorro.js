// Jon Dattorro plate reverb (1997) implemented as an AudioWorklet.
// Signal flow: predelay -> input bandwidth lowpass -> 4 input-diffusion
// allpasses -> figure-8 tank (two symmetric halves, each: modulated
// allpass + delay + damping lowpass + decay-diffusion allpass + delay).
// Output is fully wet; dry/wet blending is done in the node graph.
//
// Delay lengths are Dattorro's originals (samples @ 29761 Hz) scaled to the
// running sampleRate so the character holds across devices.
const DATTORRO_SR = 29761;

class SimpleDelay {
  constructor(maxLen) {
    this.buf = new Float32Array(maxLen);
    this.len = maxLen;
    this.idx = 0;
  }
  read(offset) {
    let i = this.idx - offset;
    while (i < 0) i += this.len;
    return this.buf[i % this.len];
  }
  // fractional read for modulated taps
  readFrac(offset) {
    const i0 = Math.floor(offset);
    const frac = offset - i0;
    const a = this.read(i0);
    const b = this.read(i0 + 1);
    return a + (b - a) * frac;
  }
  write(v) {
    this.buf[this.idx] = v;
    this.idx = (this.idx + 1) % this.len;
  }
}

class DattorroProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'decay', defaultValue: 0.5, minValue: 0, maxValue: 0.95, automationRate: 'k-rate' },
      { name: 'damping', defaultValue: 0.0005, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'predelay', defaultValue: 0, minValue: 0, maxValue: 0.2, automationRate: 'k-rate' },
      { name: 'bandwidth', defaultValue: 0.9995, minValue: 0.1, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    const sc = sampleRate / DATTORRO_SR;
    const s = (n) => Math.max(4, Math.round(n * sc));

    // Predelay buffer (up to 200ms).
    this.preDelay = new SimpleDelay(Math.ceil(sampleRate * 0.2) + 4);

    // Input diffusion allpasses.
    this.apIn = [s(142), s(107), s(379), s(277)].map((n) => new SimpleDelay(n + 4));
    this.apInLen = [s(142), s(107), s(379), s(277)];
    this.apInG = [0.75, 0.75, 0.625, 0.625];

    // Tank: two halves. Each has a modulated allpass, a delay, a damping
    // lowpass state, a decay-diffusion allpass, and a second delay.
    this.modAp = [new SimpleDelay(s(672) + 64), new SimpleDelay(s(908) + 64)];
    this.modApLen = [s(672), s(908)];
    this.delay1 = [new SimpleDelay(s(4453) + 4), new SimpleDelay(s(4217) + 4)];
    this.delay1Len = [s(4453), s(4217)];
    this.decayAp = [new SimpleDelay(s(1800) + 4), new SimpleDelay(s(2656) + 4)];
    this.decayApLen = [s(1800), s(2656)];
    this.delay2 = [new SimpleDelay(s(3720) + 4), new SimpleDelay(s(3163) + 4)];
    this.delay2Len = [s(3720), s(3163)];

    this.lpBand = 0;       // input bandwidth lowpass state
    this.dampState = [0, 0]; // damping lowpass state per half
    this.feed = [0, 0];    // cross-coupled feedback between halves

    this.lfoPhase = 0;
    this.lfoInc = (2 * Math.PI * 1.0) / sampleRate; // ~1 Hz modulation
    this.modDepth = Math.max(1, Math.round(8 * sc));

    // Output tap offsets (Dattorro's tap list), scaled.
    this.tapsL = [s(266), s(2974), s(1913), s(1996), s(1990), s(187), s(1066)];
    this.tapsR = [s(353), s(3627), s(1228), s(2673), s(2111), s(335), s(121)];
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const decay = params.decay[0];
    const damp = params.damping[0];
    const bw = params.bandwidth[0];
    const preSamples = Math.min(this.preDelay.len - 1, Math.round(params.predelay[0] * sampleRate));
    const decayDiff1 = 0.7;
    const decayDiff2 = Math.max(0.25, Math.min(0.5, decay - 0.15));

    const inL = input && input[0] ? input[0] : null;
    const inR = input && input[1] ? input[1] : inL;
    const frames = output[0].length;

    for (let i = 0; i < frames; i++) {
      const dry = ((inL ? inL[i] : 0) + (inR ? inR[i] : 0)) * 0.5;

      // Predelay.
      this.preDelay.write(dry);
      let x = preSamples > 0 ? this.preDelay.read(preSamples) : dry;

      // Input bandwidth lowpass.
      this.lpBand += bw * (x - this.lpBand);
      x = this.lpBand;

      // Input diffusion allpass chain.
      for (let a = 0; a < 4; a++) {
        const ap = this.apIn[a];
        const g = this.apInG[a];
        const z = ap.read(this.apInLen[a]);
        const v = x - g * z;
        ap.write(v);
        x = z + g * v;
      }

      this.lfoPhase += this.lfoInc;
      if (this.lfoPhase > Math.PI * 2) this.lfoPhase -= Math.PI * 2;
      const mod0 = this.modDepth * Math.sin(this.lfoPhase);
      const mod1 = this.modDepth * Math.sin(this.lfoPhase + 1.5);

      const outHalf = [0, 0];
      for (let h = 0; h < 2; h++) {
        // Input plus cross-coupled decayed feedback from the other half.
        let t = x + this.feed[1 - h] * decay;

        // Modulated input allpass.
        const map = this.modAp[h];
        const off = this.modApLen[h] + (h === 0 ? mod0 : mod1);
        const z0 = map.readFrac(off);
        const v0 = t - decayDiff1 * z0;
        map.write(v0);
        t = z0 + decayDiff1 * v0;

        // First delay.
        this.delay1[h].write(t);
        t = this.delay1[h].read(this.delay1Len[h]);

        // Damping lowpass.
        this.dampState[h] += (1 - damp) * (t - this.dampState[h]);
        t = this.dampState[h] * decay;

        // Decay-diffusion allpass.
        const dap = this.decayAp[h];
        const z1 = dap.read(this.decayApLen[h]);
        const v1 = t - decayDiff2 * z1;
        dap.write(v1);
        t = z1 + decayDiff2 * v1;

        // Second delay -> becomes feedback into the opposite half.
        this.delay2[h].write(t);
        this.feed[h] = this.delay2[h].read(this.delay2Len[h]);

        outHalf[h] = t;
      }

      // Output taps summed from the tank delays (network nodes).
      const L = (
        this.delay1[1].read(this.tapsL[0]) +
        this.delay1[1].read(this.tapsL[1]) -
        this.decayAp[1].read(this.tapsL[2]) +
        this.delay2[1].read(this.tapsL[3]) -
        this.delay1[0].read(this.tapsL[4]) -
        this.decayAp[0].read(this.tapsL[5]) -
        this.delay2[0].read(this.tapsL[6])
      ) * 0.6;
      const R = (
        this.delay1[0].read(this.tapsR[0]) +
        this.delay1[0].read(this.tapsR[1]) -
        this.decayAp[0].read(this.tapsR[2]) +
        this.delay2[0].read(this.tapsR[3]) -
        this.delay1[1].read(this.tapsR[4]) -
        this.decayAp[1].read(this.tapsR[5]) -
        this.delay2[1].read(this.tapsR[6])
      ) * 0.6;

      output[0][i] = L;
      if (output[1]) output[1][i] = R;
    }
    return true;
  }
}

registerProcessor('studio-dattorro', DattorroProcessor);
