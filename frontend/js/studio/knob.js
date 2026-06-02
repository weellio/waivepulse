// SVG rotary knob component. Drag up/down to change, scroll for fine steps,
// double-click to reset to default. A tooltip (#knob-tip) follows the drag.
export class Knob {
  constructor(container, opts) {
    this.min = opts.min ?? 0; this.max = opts.max ?? 1; this.val = opts.value ?? 0; this.def = opts.def ?? this.val;
    this.color = opts.color ?? '#8cffff'; this.lbl = opts.label ?? ''; this.bipolar = opts.bipolar ?? false;
    this.size = opts.size ?? 28; this.onChange = opts.onChange ?? (() => {});
    this._drag = null; this._build(container);
  }
  _angle(v) { return -135 + ((v - this.min) / (this.max - this.min)) * 270; }
  _pt(deg, r) { const rad = (deg - 90) * Math.PI / 180; return [r * Math.cos(rad), r * Math.sin(rad)]; }
  _arc(a1, a2, r) {
    if (Math.abs(a2 - a1) < 0.5) return '';
    const [x1, y1] = this._pt(a1, r), [x2, y2] = this._pt(a2, r);
    const large = Math.abs(a2 - a1) > 180 ? 1 : 0, sweep = a2 > a1 ? 1 : 0;
    return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`;
  }
  _build(container) {
    const s = this.size, h = s / 2, r = s * .36, ri = s * .27;
    const NS = 'http://www.w3.org/2000/svg';
    const wrap = document.createElement('div'); wrap.className = 'knob-group';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', s); svg.setAttribute('height', s);
    svg.setAttribute('viewBox', `${-h} ${-h} ${s} ${s}`);
    svg.style.cursor = 'ns-resize'; svg.style.display = 'block'; svg.style.flexShrink = '0';
    const track = document.createElementNS(NS, 'path');
    track.setAttribute('d', this._arc(-135, 135, r)); track.setAttribute('stroke', '#2a2a3a');
    track.setAttribute('stroke-width', '3'); track.setAttribute('fill', 'none'); track.setAttribute('stroke-linecap', 'round');
    this._arcEl = document.createElementNS(NS, 'path');
    this._arcEl.setAttribute('stroke', this.color); this._arcEl.setAttribute('stroke-width', '3');
    this._arcEl.setAttribute('fill', 'none'); this._arcEl.setAttribute('stroke-linecap', 'round');
    const body = document.createElementNS(NS, 'circle');
    body.setAttribute('r', s * .22); body.setAttribute('fill', '#081515');
    body.setAttribute('stroke', '#2a3a3a'); body.setAttribute('stroke-width', '1.5');
    this._dot = document.createElementNS(NS, 'circle');
    this._dot.setAttribute('r', '2'); this._dot.setAttribute('fill', this.color);
    svg.append(track, this._arcEl, body, this._dot);
    const lbl = document.createElement('div');
    lbl.className = 'knob-label'; lbl.textContent = this.lbl;
    wrap.append(svg, lbl); container.appendChild(wrap);
    this._redraw();

    svg.addEventListener('mousedown', e => {
      e.preventDefault();
      this._drag = { y: e.clientY, v0: this.val };
      const tip = document.getElementById('knob-tip');
      const onMove = e2 => {
        const dy = this._drag.y - e2.clientY;
        this.set(this._drag.v0 + (dy / 120) * (this.max - this.min));
        const rc = svg.getBoundingClientRect();
        tip.style.left = (rc.right + 6) + 'px'; tip.style.top = (rc.top + rc.height / 2 - 10) + 'px';
        tip.style.opacity = '1'; tip.textContent = this._disp();
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp);
        this._drag = null; tip.style.opacity = '0';
      };
      document.addEventListener('mousemove', onMove); document.addEventListener('mouseup', onUp);
    });
    svg.addEventListener('dblclick', e => { e.preventDefault(); this.set(this.def); });
    svg.addEventListener('wheel', e => { e.preventDefault(); this.set(this.val + (e.deltaY < 0 ? 1 : -1) * (this.max - this.min) / 100); }, { passive: false });
  }
  _disp() {
    if (this.lbl === 'PAN') { if (Math.abs(this.val) < .01) return 'C'; return (this.val < 0 ? 'L' : 'R') + Math.abs(this.val * 100).toFixed(0); }
    if (this.lbl === 'VOL') return (this.val * 100).toFixed(0) + '%';
    if (this.lbl === 'OFS') return this.val === 0 ? '0 ms' : this.val.toFixed(1) + ' ms';
    if (['BASS', 'MID', 'TREB'].includes(this.lbl)) return (this.val >= 0 ? '+' : '') + this.val.toFixed(1) + 'dB';
    return (this.val * 100).toFixed(0) + '%';
  }
  set(v) { this.val = Math.max(this.min, Math.min(this.max, v)); this._redraw(); this.onChange(this.val); }
  _redraw() {
    const s = this.size, r = s * .36, ri = s * .27;
    const angle = this._angle(this.val);
    const arcStart = this.bipolar ? this._angle(0) : -135;
    const a1 = Math.min(arcStart, angle), a2 = Math.max(arcStart, angle);
    this._arcEl.setAttribute('d', Math.abs(a2 - a1) > .5 ? this._arc(a1, a2, r) : '');
    const [ix, iy] = this._pt(angle, ri);
    this._dot.setAttribute('cx', ix.toFixed(2)); this._dot.setAttribute('cy', iy.toFixed(2));
  }
}
