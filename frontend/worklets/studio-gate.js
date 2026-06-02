// Noise gate AudioWorklet with dual-threshold hysteresis.
// Opens when the detected level rises above the high threshold and only
// closes once it falls below the low threshold (prevents chattering).
// Attack/hold/release envelope smooths the gain. `duck` inverts the action
// (gate closes the LOUD parts instead of the quiet ones).
class GateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Thresholds in dBFS.
      { name: 'highThresh', defaultValue: -40, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'lowThresh', defaultValue: -50, minValue: -100, maxValue: 0, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.002, minValue: 0.0001, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 0.05, minValue: 0, maxValue: 2, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.1, minValue: 0.001, maxValue: 2, automationRate: 'k-rate' },
      // 0 = normal gate, >=0.5 = duck/inverse mode.
      { name: 'duck', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._open = false;     // hysteresis latch
    this._env = 0;          // smoothed detector level (linear)
    this._gain = 0;         // current applied gain
    this._holdRemaining = 0; // seconds left in hold
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const hi = Math.pow(10, params.highThresh[0] / 20);
    const lo = Math.pow(10, params.lowThresh[0] / 20);
    const duck = params.duck[0] >= 0.5;
    const sr = sampleRate;
    // Per-sample smoothing coefficients.
    const atkCoef = Math.exp(-1 / (Math.max(0.0001, params.attack[0]) * sr));
    const relCoef = Math.exp(-1 / (Math.max(0.001, params.release[0]) * sr));
    const holdTime = Math.max(0, params.hold[0]);
    // Detector follows the loudest channel.
    const envCoef = Math.exp(-1 / (0.005 * sr));

    const frames = input[0].length;
    const nCh = input.length;

    for (let i = 0; i < frames; i++) {
      let peak = 0;
      for (let ch = 0; ch < nCh; ch++) {
        const a = Math.abs(input[ch][i]);
        if (a > peak) peak = a;
      }
      // Envelope follower on the rectified signal.
      this._env = peak > this._env ? peak : (this._env * envCoef + peak * (1 - envCoef));

      // Dual-threshold hysteresis latch.
      if (!this._open && this._env >= hi) {
        this._open = true;
        this._holdRemaining = holdTime;
      } else if (this._open && this._env < lo) {
        if (this._holdRemaining > 0) {
          this._holdRemaining -= 1 / sr;
        } else {
          this._open = false;
        }
      } else if (this._open && this._env >= lo) {
        this._holdRemaining = holdTime;
      }

      // Target gain. Normal: open->1, closed->0. Duck: open->0, closed->1.
      let target;
      if (duck) target = this._open ? 0 : 1;
      else target = this._open ? 1 : 0;

      const coef = target > this._gain ? atkCoef : relCoef;
      this._gain = target + (this._gain - target) * coef;

      for (let ch = 0; ch < nCh; ch++) {
        output[ch][i] = input[ch][i] * this._gain;
      }
    }
    return true;
  }
}

registerProcessor('studio-gate', GateProcessor);
