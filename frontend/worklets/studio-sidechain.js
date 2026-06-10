// Sidechain compressor AudioWorklet.
// Input 0: target audio to be compressed.
// Input 1: key/sidechain signal that drives compression.
// Uses peak detection on the key signal, an envelope follower, and
// gain reduction based on threshold/ratio with attack/release smoothing.
class SidechainProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: -20, minValue: -60, maxValue: 0, automationRate: 'k-rate' },
      { name: 'ratio',     defaultValue: 4,   minValue: 1,   maxValue: 20, automationRate: 'k-rate' },
      { name: 'attack',    defaultValue: 0.005, minValue: 0.001, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release',   defaultValue: 0.15,  minValue: 0.01,  maxValue: 2.0, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._env = 0;      // envelope follower (linear)
    this._gain = 1;     // current applied gain (smoothed)
  }

  process(inputs, outputs, params) {
    const target = inputs[0];
    const key    = inputs[1];
    const output = outputs[0];

    // If no target audio, nothing to do.
    if (!target || target.length === 0 || target[0].length === 0) return true;

    const frames = target[0].length;
    const nCh    = target.length;
    const sr     = sampleRate;

    // Convert threshold from dB to linear.
    const threshLin = Math.pow(10, params.threshold[0] / 20);
    const threshDB  = params.threshold[0];
    const ratio     = params.ratio[0];

    // Per-sample smoothing coefficients.
    const atkCoef = Math.exp(-1 / (Math.max(0.001, params.attack[0]) * sr));
    const relCoef = Math.exp(-1 / (Math.max(0.01, params.release[0]) * sr));

    // Gain smoothing coefficient to avoid clicks (fast ~1ms).
    const gainSmooth = Math.exp(-1 / (0.001 * sr));

    const hasKey = key && key.length > 0 && key[0] && key[0].length > 0;

    for (let i = 0; i < frames; i++) {
      // 1. Peak-detect on key signal (all channels): find max absolute value.
      let peak = 0;
      if (hasKey) {
        const keyCh = key.length;
        for (let ch = 0; ch < keyCh; ch++) {
          const a = Math.abs(key[ch][i]);
          if (a > peak) peak = a;
        }
      }

      // 2. Envelope follower: env = env + coef * (peak - env).
      //    Fast attack when peak rises, slow release when it falls.
      const coef = peak > this._env ? (1 - atkCoef) : (1 - relCoef);
      this._env = this._env + coef * (peak - this._env);

      // 3. Compute gain reduction.
      let targetGain = 1;
      if (this._env > threshLin && threshLin > 0) {
        // Convert envelope to dB.
        const envDB = 20 * Math.log10(this._env);
        // How far over threshold in dB.
        const overDB = envDB - threshDB;
        // Desired reduction in dB based on ratio.
        const reduceDB = overDB - (overDB / ratio);
        // Convert to linear gain.
        targetGain = Math.pow(10, -reduceDB / 20);
      }

      // 4. Smooth gain changes to avoid clicks.
      this._gain = targetGain + (this._gain - targetGain) * gainSmooth;

      // 5. Apply gain to audio input, write to output.
      for (let ch = 0; ch < nCh; ch++) {
        output[ch][i] = target[ch][i] * this._gain;
      }
    }
    return true;
  }
}

registerProcessor('studio-sidechain', SidechainProcessor);
