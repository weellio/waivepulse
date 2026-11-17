// ── Master exciter ───────────────────────────────────────────────────────────
// Shared by the Studio and the Karaoke page, which each build their own master chain.
// Both used to carry a private copy of this and they drifted; keep it here.

// Where the exciter starts listening. Below this the vocal body lives, and saturating
// that just makes the mix muddy.
export const EXCITER_HP_HZ = 3000;

// How hard the saturator is driven.
//
// The curve is f(x) = (pi + k)x / (pi + k|x|), which reaches full scale at x = 1 for any
// k, but whose gain on the QUIETEST signal is (pi + k)/pi. That second number is the one
// that matters here:
//
//     k = 200  ->  64.6x   (+36 dB) on near-silence
//     k = 6    ->   2.9x   (+9.3 dB)
//
// At k = 200 the exciter dragged up the hiss, breath and stem-separation artifacts that
// sit under a vocal, which is heard as static. k = 6 still saturates and still adds
// harmonics to loud content -- it just stops amplifying the noise floor.
export const EXCITER_DRIVE = 6;

// 4096 points, matching the clipper. A WaveShaper interpolates between curve points, so
// a coarse table on a sharply bent function adds grit of its own.
export function makeSatCurve(k = EXCITER_DRIVE, n = 4096) {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i * 2 / (n - 1)) - 1;
    c[i] = ((Math.PI + k) * x) / (Math.PI + k * Math.abs(x));
  }
  return c;
}
