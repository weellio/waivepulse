// Bitcrusher + sample-rate reducer AudioWorklet.
// Quantizes bit depth and decimates the sample rate (sample-and-hold),
// then blends against the dry signal via the `wet` param.
class BitcrusherProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'bits', defaultValue: 8, minValue: 1, maxValue: 16, automationRate: 'k-rate' },
      { name: 'rate', defaultValue: 0.5, minValue: 0.02, maxValue: 1, automationRate: 'k-rate' },
      { name: 'wet', defaultValue: 1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._hold = [];   // sample-and-hold value per channel
    this._phase = [];  // decimation phase accumulator per channel
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0) return true;

    const bits = Math.max(1, Math.min(16, params.bits[0]));
    const rate = Math.max(0.02, Math.min(1, params.rate[0]));
    const wet = Math.max(0, Math.min(1, params.wet[0]));
    const steps = Math.pow(2, bits);

    for (let ch = 0; ch < input.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (this._hold[ch] === undefined) { this._hold[ch] = 0; this._phase[ch] = 0; }
      let hold = this._hold[ch];
      let phase = this._phase[ch];
      for (let i = 0; i < inCh.length; i++) {
        phase += rate;
        if (phase >= 1) {
          phase -= 1;
          // quantize the freshly sampled value
          hold = Math.round(inCh[i] * steps) / steps;
        }
        outCh[i] = inCh[i] * (1 - wet) + hold * wet;
      }
      this._hold[ch] = hold;
      this._phase[ch] = phase;
    }
    return true;
  }
}

registerProcessor('studio-bitcrusher', BitcrusherProcessor);
