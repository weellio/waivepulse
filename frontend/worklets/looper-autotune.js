// Autotune — pitch-detect (autocorrelation) + snap to scale + granular shift.
// Stylized "hard tune": the fast retune + shift artifacts ARE the sound.
class AutoTune extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name:'mix',   defaultValue:0,   minValue:0, maxValue:1 },
      { name:'speed', defaultValue:0.92,minValue:0, maxValue:1 },
    ];
  }
  constructor() {
    super();
    this.sr = sampleRate;
    this.buf = new Float32Array(16384); this.blen = this.buf.length; this.wp = 0;
    this.win = 1024; this.ana = new Float32Array(this.win); this.fill = 0;
    this.targetRatio = 1; this.ratio = 1;
    this.phase = 0; this.grain = Math.floor(0.030 * this.sr); // ~30ms grains
    this.scale = [0,2,4,5,7,9,11]; this.root = 0;
    this.port.onmessage = e => {
      if (e.data.scale) this.scale = e.data.scale;
      if (e.data.root != null) this.root = e.data.root;
    };
  }
  nearestRatio(f0) {
    if (f0 <= 0) return 1;
    const midi = 69 + 12 * Math.log2(f0 / 440);
    let best = Math.round(midi), bd = 1e9;
    for (let m = Math.floor(midi)-2; m <= Math.ceil(midi)+2; m++) {
      const pc = ((m - this.root) % 12 + 12) % 12;
      if (this.scale.indexOf(pc) >= 0) { const d = Math.abs(m - midi); if (d < bd){bd=d;best=m;} }
    }
    return (440 * Math.pow(2,(best-69)/12)) / f0;
  }
  detect() {
    const a = this.ana, n = this.win;
    let rms = 0; for (let i=0;i<n;i++) rms += a[i]*a[i];
    if (Math.sqrt(rms/n) < 0.01) return 0;            // gate silence
    const minLag = Math.floor(this.sr/600), maxLag = Math.floor(this.sr/70);
    let bestLag = -1, best = 0;
    for (let lag=minLag; lag<=maxLag; lag++) {
      let c = 0; for (let i=0;i<n-lag;i++) c += a[i]*a[i+lag];
      if (c > best) { best = c; bestLag = lag; }
    }
    return bestLag > 0 ? this.sr / bestLag : 0;
  }
  lerp(pos) {
    const i0 = Math.floor(pos), f = pos - i0;
    const a = this.buf[((i0 % this.blen)+this.blen)%this.blen];
    const b = this.buf[(((i0+1) % this.blen)+this.blen)%this.blen];
    return a + (b-a)*f;
  }
  process(inputs, outputs, p) {
    const inp = inputs[0][0], out = outputs[0][0];
    if (!inp || !out) return true;
    const speed = p.speed[0];
    const sm = 0.0006 + speed*speed*0.28;             // retune smoothing
    for (let i=0;i<inp.length;i++) {
      const x = inp[i];
      this.buf[this.wp] = x;
      this.ana[this.fill++] = x;
      if (this.fill >= this.win) {
        const f0 = this.detect();
        this.targetRatio = f0 > 0 ? this.nearestRatio(f0) : 1;
        this.fill = 0;
      }
      this.ratio += (this.targetRatio - this.ratio) * sm;
      // dual-grain pitch shifter (two heads half a grain apart, windowed)
      this.phase += (this.ratio - 1) / this.grain;
      this.phase -= Math.floor(this.phase);
      const ph2 = (this.phase + 0.5) % 1;
      const s1 = this.lerp(this.wp - this.phase*this.grain);
      const s2 = this.lerp(this.wp - ph2*this.grain);
      const w1 = Math.sin(Math.PI*this.phase), w2 = Math.sin(Math.PI*ph2);
      const shifted = (s1*w1 + s2*w2) / ((w1+w2) || 1);
      const m = p.mix.length > 1 ? p.mix[i] : p.mix[0];
      out[i] = shifted*m + x*(1-m);
      this.wp = (this.wp+1) % this.blen;
    }
    return true;
  }
}
registerProcessor('autotune', AutoTune);
