// ── Groove: swing, humanize, probability/ratchet cycles, Euclidean rhythms ─────
// Pure functions (no DOM, no audio) so they can be unit-tested headless in node.
//
// SWING convention: amount 0–1 (UI shows 0–100%).
//   0   = straight 16ths.
//   1   = full triplet shuffle: every odd 16th (the "e" and "a") is delayed by
//         1/3 of a 16th, so each 8th splits 2:1 like a triplet.
//   The offset is linear in between: delay = amount × stepDur / 3.
// HUMANIZE: amount 0–1 → random timing up to ±HUMANIZE_MS ms and velocity up to
//   ±HUMANIZE_VEL (fraction) per hit.

export const HUMANIZE_MS  = 15;     // max timing jitter at 100% (ms, ±)
export const HUMANIZE_VEL = 0.2;    // max velocity jitter at 100% (fraction, ±)

// Delay (seconds) added to a step's grid time by swing. Only odd steps move.
export function swingOffset(step, stepDur, swing) {
  return (step % 2 === 1) ? (swing || 0) * stepDur / 3 : 0;
}

// Actual length of a step after swing (even steps stretch, odd steps shrink), so
// ratchets divide the time the step really has.
export function stepSpan(step, stepDur, swing) {
  const d = (swing || 0) * stepDur / 3;
  return step % 2 === 0 ? stepDur + d : stepDur - d;
}

// Random timing jitter in seconds (rand injectable for tests).
export function humanizeTime(amount, rand = Math.random) {
  if (!amount) return 0;
  return (rand() * 2 - 1) * amount * HUMANIZE_MS / 1000;
}

// Velocity with random jitter, clamped to a sane range.
export function humanizeVel(vel, amount, rand = Math.random) {
  if (!amount) return vel;
  const v = vel * (1 + (rand() * 2 - 1) * amount * HUMANIZE_VEL);
  return Math.max(0.05, Math.min(1.2, v));
}

// ── Per-step probability + ratchet ────────────────────────────────────────────
export const PROB_CYCLE    = [1, 0.75, 0.5, 0.25];
export const RATCHET_CYCLE = [1, 2, 3, 4];

export function nextProb(p) {
  const i = PROB_CYCLE.indexOf(p);
  return PROB_CYCLE[(i + 1) % PROB_CYCLE.length];        // unknown value → 1 → …
}
export function nextRatchet(r) {
  const i = RATCHET_CYCLE.indexOf(r);
  return RATCHET_CYCLE[(i + 1) % RATCHET_CYCLE.length];
}

// Times (relative to the swung step start) + velocities for a step's ratchet hits.
// Later hits fall off slightly so a roll sounds like a roll, not a machine gun.
export function ratchetHits(n, span, vel) {
  const out = [];
  const k = Math.max(1, Math.min(4, n | 0));
  for (let i = 0; i < k; i++) out.push({ dt: i * span / k, vel: vel * (i === 0 ? 1 : 0.8) });
  return out;
}

// ── Euclidean rhythm (Bjorklund) ──────────────────────────────────────────────
// Spread `hits` onsets as evenly as possible over `steps`, then rotate the result
// `rotation` steps LATER (to the right). Returns an array of 0/1.
export function euclid(hits, steps = 16, rotation = 0) {
  steps = Math.max(1, steps | 0);
  hits  = Math.max(0, Math.min(steps, hits | 0));
  let base;
  if (hits === 0)          base = new Array(steps).fill(0);
  else if (hits === steps) base = new Array(steps).fill(1);
  else {
    let a = Array.from({ length: hits }, () => [1]);
    let b = Array.from({ length: steps - hits }, () => [0]);
    while (b.length > 1) {
      const m = Math.min(a.length, b.length);
      const na = [];
      for (let i = 0; i < m; i++) na.push(a[i].concat(b[i]));
      const rest = a.length > m ? a.slice(m) : b.slice(m);
      a = na; b = rest;
    }
    base = [...a.flat(), ...b.flat()];
  }
  const r = ((rotation | 0) % steps + steps) % steps;
  const out = new Array(steps);
  for (let i = 0; i < steps; i++) out[(i + r) % steps] = base[i];
  return out;
}
