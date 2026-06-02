// Runs on the dedicated audio rendering thread — no main-thread jank, no static.
class LooperCapture extends AudioWorkletProcessor {
  constructor() { super(); this._on = false; this.port.onmessage = e => { this._on = e.data; }; }
  process(inputs, outputs) {
    const i = inputs[0], o = outputs[0];
    for (let ch = 0; ch < o.length; ch++) { if (i[ch]) o[ch].set(i[ch]); }
    if (this._on && i[0]?.length) this.port.postMessage([i[0].slice(), (i[1] || i[0]).slice()]);
    return true;
  }
}
registerProcessor('looper-capture', LooperCapture);
