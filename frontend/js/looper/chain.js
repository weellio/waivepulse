// ── Pattern-bank chain logic (pure; node-testable) ────────────────────────────
// A chain is a string of bank letters, e.g. "A A B A C" (spaces/commas optional,
// "AABAC" works too). The sequencer plays one bank per bar, in chain order,
// wrapping around. A bank picked by hand while playing waits for the next bar.

export const BANK_LETTERS = ['A', 'B', 'C', 'D'];
export const MAX_CHAIN = 16;              // bars — keeps "→ Loop" renders a sane size

// "A A b, D" → { ok:true, seq:[0,0,1,3] } · bad input → { ok:false, error }
export function parseChain(str) {
  const clean = String(str || '').toUpperCase().replace(/[\s,;|\-–>→]+/g, '');
  if (!clean) return { ok: false, error: 'Chain is empty — type bank letters like "A A B A"' };
  const seq = [];
  for (const ch of clean) {
    const i = BANK_LETTERS.indexOf(ch);
    if (i < 0) return { ok: false, error: `"${ch}" isn't a bank — use A, B, C or D` };
    seq.push(i);
  }
  if (seq.length > MAX_CHAIN) return { ok: false, error: `Chain is ${seq.length} bars — max ${MAX_CHAIN}` };
  return { ok: true, seq };
}

export function formatChain(seq) { return seq.map(i => BANK_LETTERS[i] || '?').join(' '); }

// Decide the bank for the bar that is about to start.
//   st = { chainOn, chainSeq, chainPos, current, queued }
// Returns { bank, chainPos, queued } — the new state after this bar boundary.
// Chain on: bank = chainSeq[chainPos % len], position advances by one.
// Chain off: a queued bank (picked while playing) takes over; else stay.
export function bankAtBar(st) {
  if (st.chainOn && st.chainSeq && st.chainSeq.length) {
    const len = st.chainSeq.length;
    const pos = ((st.chainPos % len) + len) % len;
    return { bank: st.chainSeq[pos], chainPos: pos + 1, queued: null };
  }
  if (st.queued != null) return { bank: st.queued, chainPos: st.chainPos, queued: null };
  return { bank: st.current, chainPos: st.chainPos, queued: null };
}

// Run the boundary logic for `bars` bars from a starting state — the order the
// sequencer will play (used by the tests and the → Loop chain render).
export function simulate(st, bars) {
  const out = [];
  let s = { ...st };
  for (let i = 0; i < bars; i++) {
    const r = bankAtBar(s);
    out.push(r.bank);
    s = { ...s, current: r.bank, chainPos: r.chainPos, queued: r.queued };
  }
  return out;
}

// Does a render of `bars` bars fit the loops already recorded? Loops must share
// one cycle: the chain has to be the master length or divide it evenly.
//   -> { ok:true } | { ok:false, error }
export function chainFitsMaster(bars, barSec, masterLen) {
  if (masterLen == null) return { ok: true };
  const dur = bars * barSec;
  const ratio = masterLen / dur;
  if (dur > masterLen + 0.002) {
    return { ok: false, error: `Chain is ${bars} bar${bars > 1 ? 's' : ''} (${dur.toFixed(2)}s) but your loops are ${masterLen.toFixed(2)}s — clear the loops or shorten the chain` };
  }
  if (Math.abs(ratio - Math.round(ratio)) > 0.002 * Math.max(1, ratio)) {
    return { ok: false, error: `Chain (${dur.toFixed(2)}s) doesn't divide the loop length (${masterLen.toFixed(2)}s) evenly — it would drift` };
  }
  return { ok: true };
}
