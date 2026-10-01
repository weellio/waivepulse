// ── Ensemble voice builder ────────────────────────────────────────────────────
// Turns ONE note into a SECTION. Instead of the single oscillator + lowpass +
// gain that synth.js used to make per note, a voice here is 1–7 sub-voices, each
// with its own detune, stereo seat, onset stagger, attack time and slow pitch
// drift, behind a shared tone stage.
//
// The depth trick (the synthesis version of Aaron Venture's CC1 dynamics): ONE
// 0–1 "expression" value per voice drives level, filter cutoff, detune spread
// AND harmonic content together, and it is rampable while the note sustains. So
// louder is BRIGHTER and WIDER, not just louder — which is the whole difference
// between "a synth playing notes" and "players playing a phrase".
//
// Costs, deliberately: oscillators are the scarce resource (desktop Web Audio
// starts crackling past ~200 concurrent sources) so sub-voices each get exactly
// one source + one gain + one panner. Biquads are expensive, so sub-voices are
// bundled into at most 3 filter GROUPS per note (stereo biquads preserve each
// sub-voice's pan, so grouping costs nothing but a shared cutoff). Pitch drift
// is scheduled as AudioParam ramps rather than an LFO oscillator per sub-voice:
// zero extra nodes, and it renders identically in an OfflineAudioContext.
//
// Everything takes an explicit ctx/dest, so the exact same code runs live and in
// the OfflineAudioContext the Looper's → Loop / Song Builder exports use.

export const MAX_OSC  = 192;   // hard cap on simultaneous sources (voice stealing)
const GROUP_MAX       = 3;     // at most 3 biquads per note
const DRIFT_STEPS     = 22;    // ramp segments of the slow pitch walk (~10 s)

const clamp   = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
const clamp01 = v => clamp(v || 0, 0, 1);

// ── Named ensemble shapes ─────────────────────────────────────────────────────
// `solo` is the pre-ensemble engine, byte for byte: one sub-voice, no spread, no
// stagger, expression depth 0 — so there is always a way back to the old sound.
export const PRESETS = {
  solo:    { label: 'Solo (classic)',  size: 1, spread:  0, stagger:  0, depth: 0    },
  duo:     { label: 'Duo',             size: 2, spread:  7, stagger:  9, depth: 0.45 },
  trio:    { label: 'Trio',            size: 3, spread: 10, stagger: 13, depth: 0.60 },
  section: { label: 'Section',         size: 4, spread: 14, stagger: 18, depth: 0.70 },
  brass:   { label: 'Brass section',   size: 5, spread: 11, stagger: 14, depth: 0.90 },
  strings: { label: 'Strings',         size: 6, spread: 22, stagger: 26, depth: 0.65 },
  choir:   { label: 'Choir',           size: 7, spread: 30, stagger: 30, depth: 0.55 },
};

// ── Deterministic randomness ──────────────────────────────────────────────────
// Every sub-voice detail is random, but reproducibly so: setSeed() makes a whole
// render repeatable, which is what lets the headless tests compare two renders.
let _seed = (Math.random() * 1e9) | 0;
let _ctr  = 0;
export function setSeed(s) { _seed = s | 0; _ctr = 0; }
function nextSeed() { return (_seed + (++_ctr) * 2654435761) | 0; }
function makeRnd(seed) {
  let x = seed | 0; if (x === 0) x = 0x9e3779b9;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}

// ── The expression curve ──────────────────────────────────────────────────────
// One 0–1 value in, every timbre parameter out. Pure, so tests can assert it.
// depth 0 returns exact identities (1, 1, 1, no blend) — that is what keeps the
// `solo` preset bit-identical to the old engine.
export function exprCurve(expr, depth) {
  const e = clamp01(expr), d = clamp01(depth);
  const b = d * Math.pow(e, 1.8);                 // how much saturated/harmonic signal
  return {
    level:  1 + d * (0.30 + 0.70 * e - 1),        // quiet is quiet, loud is full
    cutoff: Math.max(0.25, 1 + d * (2.0 * e - 0.65)),  // loud is brighter
    spread: 1 + d * (0.60 * e - 0.20),            // loud is wider
    drive:  1 + 4.0 * b,                          // pushes the shaper harder
    // The two paths are correlated, so their amplitudes add. 0.55 + (1 - 0.45·b) summed to
    // 1.10 at full expression and hard-clipped the bus: a loud section held 26 samples at full
    // scale. Trade them exactly, so the blend can brighten without ever gaining level.
    bright: 0.55 * b,                             // level of the harmonic path
    dry:    1 - 0.55 * b,                         // …traded against the clean path
  };
}

// ── Voice registry + stealing ─────────────────────────────────────────────────
// One registry PER AudioContext: an offline render must not see (or steal) the
// live graph's voices, and the live graph must not be throttled by whatever an
// export is doing. Time-aware on purpose too — offline renders create every
// voice up front with future start times, so "how many are sounding" has to
// mean "at time t", not "now".
const books = new WeakMap();   // ctx -> [{ oscs, start, end, level, voice }]
let _lastCtx = null;
function bookFor(ctx) {
  let b = books.get(ctx);
  if (!b) { b = []; books.set(ctx, b); }
  _lastCtx = ctx;
  return b;
}

export function oscCount(at = null, ctx = _lastCtx) {
  const live = ctx ? (books.get(ctx) || []) : [];
  let n = 0;
  for (const v of live) {
    if (v.dead) continue;
    if (at != null && (v.start > at || (v.end != null && v.end <= at))) continue;
    n += v.oscs;
  }
  return n;
}
export function voiceCount(ctx = _lastCtx) {
  const live = ctx ? (books.get(ctx) || []) : [];
  return live.filter(v => !v.dead).length;
}
export function resetRegistry(ctx = _lastCtx) {
  if (ctx) books.set(ctx, []);
}

function prune(live, at) {
  for (let i = live.length - 1; i >= 0; i--) {
    const v = live[i];
    if (v.dead || (v.end != null && v.end < at - 0.25)) live.splice(i, 1);
  }
}

// Make room for `need` oscillators at time `at`: steal the quietest, then the
// oldest, of whatever is still sounding. Already-released voices go first.
function steal(live, ctx, need, at) {
  prune(live, at);
  let have = oscCount(at, ctx);
  if (have + need <= MAX_OSC) return;
  const sounding = live
    .filter(v => !v.dead && v.start <= at + 0.001 && (v.end == null || v.end > at))
    .sort((a, b) => (a.end != null) - (b.end != null) ||   // releasing first
                    a.level - b.level ||                   // then quietest
                    a.start - b.start);                    // then oldest
  for (const v of sounding) {
    if (have + need <= MAX_OSC) break;
    try { v.voice.stop(at, 0.03); } catch (_) {}
    v.dead = true; have -= v.oscs;
  }
}

// ── Source helpers ────────────────────────────────────────────────────────────
// `wave` may be an oscillator type string, { periodic:[harmonics] }, or
// { buffer, rootHz } for the sampler. All three expose .detune in cents, so the
// drift / spread scheduler below is identical for every instrument.
function makeSource(ctx, wave, freq) {
  if (wave && wave.buffer) {
    const s = ctx.createBufferSource();
    s.buffer = wave.buffer;
    s.playbackRate.value = freq / (wave.rootHz || 261.63);
    return s;
  }
  const o = ctx.createOscillator();
  if (wave && wave.periodic) {
    const h = wave.periodic;
    o.setPeriodicWave(ctx.createPeriodicWave(new Float32Array(h), new Float32Array(h.length)));
  } else {
    o.type = typeof wave === 'string' ? wave : 'sine';
  }
  o.frequency.value = freq;
  return o;
}

let _curveCache = null;
function shaperCurve(ctx) {
  if (_curveCache) return _curveCache;
  const n = 2048, c = new Float32Array(n), norm = Math.tanh(2.2 + 0.35);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // odd harmonics from tanh + a touch of even from the quadratic term: the
    // "more air / more edge" that a brass player adds by blowing harder.
    c[i] = Math.tanh(2.2 * x + 0.35 * x * x) / norm;
  }
  _curveCache = c;
  return c;
}

// ── buildVoice ────────────────────────────────────────────────────────────────
// opts = { freq, vel, expr, wave, adsr:{a,d,s,r}, filter:{cutoff,reso},
//          size, spread, stagger, seat:{pan,distance},
//          when, gate, peak, depth, swellMs, steal }
// Returns { stop(when, fade), setExpr(v, when), setFreq(hz, when, glideMs), nodes, … }
export function buildVoice(ctx, dest, opts = {}) {
  const t0    = opts.when != null ? opts.when : ctx.currentTime;
  const freq  = Math.max(1, opts.freq || 440);
  const vel   = opts.vel != null ? clamp01(opts.vel) : 1;
  const depth = clamp01(opts.depth);
  const adsr  = opts.adsr   || {};
  const flt   = opts.filter || {};
  const seat  = opts.seat   || {};
  const n       = clamp(Math.round(opts.size || 1), 1, 7);
  const spread  = Math.max(0, opts.spread  || 0);
  const stagMs  = Math.max(0, opts.stagger || 0);
  const pan0    = clamp(seat.pan == null ? 0 : seat.pan, -1, 1);
  const dist    = Math.max(0.2, seat.distance == null ? 1 : seat.distance);
  const gate    = opts.gate;                       // seconds, or undefined = sustain
  const atk     = Math.max(0.004, (adsr.a != null ? adsr.a : 8) / 1000);
  const dec     = Math.max(0,     (adsr.d != null ? adsr.d : 150) / 1000);
  const susL    = adsr.s != null ? clamp01(adsr.s) : 0.7;
  const rel     = Math.max(0.01,  (adsr.r != null ? adsr.r : 200) / 1000);
  const peak    = (opts.peak != null ? opts.peak : 0.65) * vel;
  const cutoff  = clamp(flt.cutoff || 16000, 60, 20000);
  const reso    = flt.reso != null ? flt.reso : 0.7;

  // The "nothing fancy" case: one sub-voice, dead centre, no spread, depth 0.
  // Node-for-node the pre-ensemble graph (source → gain → lowpass → dest).
  const trivial = (n === 1 && spread === 0 && depth === 0 && pan0 === 0 && dist === 1);

  const live = bookFor(ctx);
  if (opts.steal !== false) steal(live, ctx, n, t0);

  let expr = opts.expr != null ? clamp01(opts.expr) : vel;
  let curve = exprCurve(expr, depth);

  // ── Shared tone stage ──
  // In the trivial case there is no tone stage at all: the lowpass connects
  // straight to dest, exactly as the pre-ensemble engine did, so the render is
  // sample-for-sample identical rather than merely inaudibly close.
  const out = trivial ? null : ctx.createGain();
  if (out) { out.gain.value = curve.level; out.connect(dest); }   // exactly 1 when depth === 0

  let shaper = null, driveG = null, dryG = null, brightG = null, mix = null;
  let tone = out || dest;                      // where the filter groups land
  if (depth > 0) {
    mix = ctx.createGain(); mix.gain.value = 1;
    dryG = ctx.createGain(); dryG.gain.value = curve.dry;
    driveG = ctx.createGain(); driveG.gain.value = curve.drive;
    brightG = ctx.createGain(); brightG.gain.value = curve.bright;
    shaper = ctx.createWaveShaper();
    shaper.curve = shaperCurve(ctx);
    shaper.oversample = '2x';
    mix.connect(dryG); dryG.connect(out);
    mix.connect(driveG); driveG.connect(shaper); shaper.connect(brightG); brightG.connect(out);
    tone = mix;
  }

  // ── Filter groups (1–3 biquads, cutoffs slightly apart) ──
  const groups = [];
  const gN = Math.min(n, GROUP_MAX);
  const gRnd = makeRnd(nextSeed());
  for (let g = 0; g < gN; g++) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    // spread the group cutoffs ±18% around the user's setting, darker further away
    const k = trivial ? 1 : (gN === 1 ? 1 : 0.82 + 0.36 * (g / (gN - 1))) *
                            (0.96 + 0.08 * gRnd()) / (1 + 0.22 * (dist - 1));
    f.frequency.value = clamp(cutoff * k * curve.cutoff, 60, 20000);
    f.Q.value = reso;
    f.connect(tone);
    groups.push({ f, k });
  }

  // ── Sub-voices ──
  const subs = [];
  const sprBase = n === 1 ? [0] : Array.from({ length: n }, (_, i) => (i / (n - 1)) * 2 - 1);
  // interleave so neighbouring detunes do not end up as neighbouring pan seats
  const seats = sprBase.map((_, i) => (i % 2 ? n - 1 - ((i - 1) >> 1) : i >> 1));
  const panW  = Math.min(0.95, 0.34 + 0.09 * n) * (1 - Math.abs(pan0) * 0.5);
  // 1/sqrt(n) is the incoherent-sum answer, but detuned sub-voices DO line up
  // on the onset, so a slightly steeper trim keeps a section's peak level
  // within a couple of percent of the same chord played solo.
  const trim  = n === 1 ? 1 : 1 / Math.pow(n, 0.58);

  for (let i = 0; i < n; i++) {
    const rnd = makeRnd(nextSeed());
    const g = groups[i % gN];

    // detune: symmetric across ±spread, then jittered so no two are identical
    const cents = n === 1 ? 0
      : sprBase[i] * spread + (rnd() * 2 - 1) * spread * 0.22 + (rnd() - 0.5) * 0.9;

    const src = makeSource(ctx, opts.wave, freq);

    // own attack (±25%) and own level (±8%) — nobody starts a note together
    const sAtk = trivial ? atk : atk * (0.86 + 0.42 * rnd());
    const lvl  = (trivial ? 1 : trim * (0.93 + 0.14 * rnd())) / (1 + 0.45 * (dist - 1));
    const env  = ctx.createGain();

    // onset stagger: sub-voice 0 is always on time so the note never feels late
    const delay = i === 0 ? 0 : (stagMs / 1000) * rnd();
    const t = t0 + delay;
    const pk = Math.max(0.0002, peak * lvl);
    const sus = pk * susL;

    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(pk, t + sAtk);
    if (gate == null) {
      // live / held: attack → decay → sustain, released by stop()
      env.gain.linearRampToValueAtTime(sus, t + sAtk + dec);
    } else {
      const relStart = t0 + Math.max(gate, atk + 0.01) + delay;
      const decEnd = t + sAtk + dec;
      if (decEnd < relStart) {
        env.gain.linearRampToValueAtTime(sus, decEnd);
        env.gain.setValueAtTime(Math.max(sus, 0.0001), relStart);
      } else {
        env.gain.linearRampToValueAtTime(Math.max(sus, 0.0001), relStart);
      }
      env.gain.exponentialRampToValueAtTime(0.0001, relStart + rel);
    }

    // env BEFORE the filter (as the old engine did, for the same reason): a saw
    // or square switches on at a non-zero value and the biquad would ring on
    // that step — the fixed-pitch "clap" on every note. Ramping first kills it.
    src.connect(env);
    let node = env;
    if (!trivial) {
      const p = ctx.createStereoPanner();
      p.pan.value = clamp(pan0 + (n === 1 ? 0 : (seats[i] / Math.max(1, n - 1) * 2 - 1)) * panW
                               + (rnd() - 0.5) * 0.08, -1, 1);
      env.connect(p);
      node = p;
    }
    node.connect(g.f);

    const sv = {
      src, env, out: node, cents, rnd: makeRnd(nextSeed()),
      driftAmt: 0.7 + 1.1 * rnd(), driftMax: Math.min(8, 1.4 + 0.42 * spread),
      step: 0.26 + 0.24 * rnd(), delay, atk: sAtk, pk, sus,
    };
    subs.push(sv);

    src.start(t);
    if (gate != null) { try { src.stop(t0 + Math.max(gate, atk + 0.01) + delay + rel + 0.05); } catch (_) {} }
  }

  // ── Slow independent drift (pitch walk via ramps — no LFO nodes) ──
  // Also carries the expression-driven spread: widening when loud is just the
  // same walk re-scheduled around a wider centre.
  const drifts = !(n === 1 && spread === 0);
  function scheduleDrift(from, scale) {
    if (!drifts) return;
    for (const sv of subs) {
      const p = sv.src.detune;
      if (!p) continue;
      try { p.cancelScheduledValues(from); } catch (_) {}
      const base = sv.cents * scale;
      let v = base, t = from;
      p.setValueAtTime(v, from);
      for (let k = 0; k < DRIFT_STEPS; k++) {
        t += sv.step * (0.7 + 0.6 * sv.rnd());
        v = base + clamp(v - base + (sv.rnd() * 2 - 1) * sv.driftAmt, -sv.driftMax, sv.driftMax);
        p.linearRampToValueAtTime(v, t);
      }
    }
  }
  scheduleDrift(t0, curve.spread);

  // ── Expression ────────────────────────────────────────────────────────────
  // Rampable while the note sustains, because the piano roll draws curves into
  // it: setExpr(v, when) means "arrive at v at time `when`", interpolating from
  // whatever was last scheduled. The previous values are tracked in JS, not read
  // back off the AudioParams — param.value is meaningless for future times and
  // always 0 in an OfflineAudioContext, so a read-back would break exports.
  let lastT = t0, lastC = curve, lastSpread = curve.spread;
  function setExpr(v, when) {
    const nv = clamp01(v);
    if (depth === 0) { expr = nv; return; }       // solo/classic: expression is off
    const at   = Math.max(when != null ? when : ctx.currentTime, t0);
    const from = Math.min(lastT, at);
    const c    = exprCurve(nv, depth);
    const seg = (p, a, b) => {
      try { p.cancelScheduledValues(from); } catch (_) {}
      p.setValueAtTime(a, from);
      if (at > from + 0.0005) p.linearRampToValueAtTime(b, at);
      else p.setValueAtTime(b, at);
    };
    // level, cutoff, harmonic blend and drive all move together — that is the
    // point: a crescendo opens the timbre, it does not just raise the fader.
    seg(out.gain,     lastC.level,  c.level);
    seg(dryG.gain,    lastC.dry,    c.dry);
    seg(brightG.gain, lastC.bright, c.bright);
    seg(driveG.gain,  lastC.drive,  c.drive);
    for (const g of groups) {
      seg(g.f.frequency, clamp(cutoff * g.k * lastC.cutoff, 60, 20000),
                         clamp(cutoff * g.k * c.cutoff,     60, 20000));
    }
    // re-scheduling the whole drift walk is not free, so only widen when the
    // move is big enough to hear (the roll can draw hundreds of tiny steps)
    if (Math.abs(c.spread - lastSpread) > 0.05) { scheduleDrift(at, c.spread); lastSpread = c.spread; }
    expr = nv; curve = c; lastC = c; lastT = at;
    const reg = live.find(x => x.voice === api);
    if (reg) reg.level = vel * (0.25 + 0.75 * nv);
  }

  // ── Legato glide (scripted legato, synthesis version) ──
  // Fast attack = short glide; slow = long. Infinite Brass models 1700 ms down
  // to 50 ms, so that is the range here.
  let curFreq = freq;
  function setFreq(hz, when, glideMs) {
    const at = Math.max(when != null ? when : ctx.currentTime, t0);
    const gl = Math.max(0, (glideMs == null ? 60 : glideMs)) / 1000;
    for (const sv of subs) {
      const p = sv.src.frequency || sv.src.playbackRate;
      if (!p) continue;
      const target = sv.src.frequency ? hz : hz / ((opts.wave && opts.wave.rootHz) || 261.63);
      try { p.cancelScheduledValues(at); } catch (_) {}
      p.setValueAtTime(p.value, at);
      if (gl > 0.001) p.exponentialRampToValueAtTime(Math.max(0.0001, target), at + gl);
      else p.setValueAtTime(target, at);
    }
    curFreq = hz;
  }

  function stop(when, fade) {
    const at = Math.max(when != null ? when : ctx.currentTime, t0);
    const r = fade != null ? fade : rel;
    for (const sv of subs) {
      try {
        sv.env.gain.cancelScheduledValues(at);
        sv.env.gain.setValueAtTime(Math.max(sv.env.gain.value, 0.0001), at);
        sv.env.gain.exponentialRampToValueAtTime(0.0001, at + r);
      } catch (_) {}
      try { sv.src.stop(at + r + 0.02); } catch (_) {}
    }
    const reg = live.find(x => x.voice === api);
    if (reg && reg.end == null) reg.end = at + r;
  }

  const api = {
    stop, setExpr, setFreq,
    get expr() { return expr; },
    get freq() { return curFreq; },
    size: n, oscs: n,
    nodes: { out, mix, groups: groups.map(g => g.f), subs, shaper, dry: dryG, bright: brightG, drive: driveG },
  };

  live.push({
    oscs: n, start: t0, level: vel * (0.25 + 0.75 * expr), voice: api,
    end: gate == null ? null : t0 + Math.max(gate, atk + 0.01) + rel,
  });
  if (live.length > 512) prune(live, t0);

  // A gentle onset swell, so even a key press has a shape instead of a step.
  if (depth > 0 && opts.swellMs) {
    const tgt = clamp01(expr + 0.22 * depth);
    if (tgt > expr + 0.005) setExpr(tgt, t0 + opts.swellMs / 1000);
  }
  return api;
}

// Velocity → legato transition time, per the Infinite Brass range.
export function glideMsFor(vel) {
  const v = clamp01(vel);
  return 50 + Math.pow(1 - v, 2) * 1650;
}
