// ── Pattern banks A–D + chain ─────────────────────────────────────────────────
// Each bank = one drum pattern (velocity, probability, ratchet) + one piano-roll
// pattern. The live grids always show the current bank; switching stores the live
// grids back into their bank first, so edits are never lost.
//   · click a bank = switch (while playing, the switch waits for the next bar)
//   · ⧉ Copy, then click a bank = paste the current bank into it
//   · Chain ("A A B A C") + ⛓ Chain on = the sequencers follow it bar by bar,
//     and → Loop / ⬇ MIDI render the whole chain
import { S } from './state.js';
import { setStatus } from './util.js';
import { applySeqPattern } from './drums.js';
import { applyPseqPattern } from './pianoseq.js';
import { BANK_LETTERS, parseChain, formatChain, bankAtBar, chainFitsMaster } from './chain.js';

const grid = (r, c, v) => Array.from({ length: r }, () => new Array(c).fill(v));
const copyGrid = g => g.map(row => row.slice());
export const blankBank = () => ({ seq: grid(8, 16, 0), prob: grid(8, 16, 1), rat: grid(8, 16, 1), roll: grid(24, 16, 0) });
const cloneBank = b => ({ seq: copyGrid(b.seq), prob: copyGrid(b.prob), rat: copyGrid(b.rat), roll: copyGrid(b.roll) });
const hasContent = b => b.seq.some(r => r.some(Boolean)) || b.roll.some(r => r.some(Boolean));

let copyMode = false;
let lastBarTime = -1;          // grid time of the last bar line handled (drum + roll share it)

// ── State helpers ─────────────────────────────────────────────────────────────
export function ensureBanks() {
  if (!Array.isArray(S.banks) || S.banks.length !== 4) S.banks = [0, 1, 2, 3].map(blankBank);
}

// Copy the live grids into the current bank.
export function storeBank() {
  ensureBanks();
  S.banks[S.bankCur] = cloneBank({ seq: S.seqPattern, prob: S.seqProb, rat: S.seqRatchet, roll: S.pseqPattern });
}

function loadBank(i) {
  const b = S.banks[i];
  S.bankCur = i;
  applySeqPattern(b.seq, b.prob, b.rat);
  applyPseqPattern(b.roll, { keepTranspose: true });
}

export function switchBank(i, quiet) {
  if (i === S.bankCur) { paintBanks(); return; }
  storeBank();
  loadBank(i);
  paintBanks();
  if (!quiet) setStatus(`Bank ${BANK_LETTERS[i]}` + (hasContent(S.banks[i]) ? '' : ' (empty — build a pattern, it stays in this bank)'));
}

// Replace every bank at once (project open / favorites / MIDI import).
export function setBanks(list, cur = 0) {
  S.banks = [0, 1, 2, 3].map(i => list?.[i] ? sanitizeBank(list[i]) : blankBank());
  loadBank(Math.max(0, Math.min(3, cur | 0)));
  paintBanks();
}

export function sanitizeBank(b) {
  const g = (src, r, c, def, ok) => Array.from({ length: r }, (_, i) => Array.from({ length: c }, (_, j) => {
    const v = src?.[i]?.[j];
    return ok(v) ? v : def;
  }));
  return {
    seq:  g(b?.seq, 8, 16, 0, v => typeof v === 'number' && v >= 0 && v <= 1),
    prob: g(b?.prob, 8, 16, 1, v => [1, 0.75, 0.5, 0.25].includes(v)),
    rat:  g(b?.rat, 8, 16, 1, v => [1, 2, 3, 4].includes(v)),
    roll: g(b?.roll, 24, 16, 0, v => v === 1 || v === 0).map(r => r.map(v => (v ? 1 : 0))),
  };
}

// ── What → Loop / MIDI export render ──────────────────────────────────────────
// { ok, bars:[bank…], chain:bool, label } — one bar normally, the chain when on.
export function renderPlan() {
  if (!S.chainOn) {
    return { ok: true, chain: false, label: '', bars: [cloneBank({ seq: S.seqPattern, prob: S.seqProb, rat: S.seqRatchet, roll: S.pseqPattern })] };
  }
  const c = parseChain(S.chainStr);
  if (!c.ok) return { ok: false, error: 'Chain: ' + c.error };
  storeBank();
  const fit = chainFitsMaster(c.seq.length, (60 / S.bpm) * 4, S.masterLen);
  if (!fit.ok) return { ok: false, error: fit.error };
  return { ok: true, chain: true, label: formatChain(c.seq), bars: c.seq.map(i => cloneBank(S.banks[i])) };
}

// ── Bar-line hook (called by both sequencers on step 0) ───────────────────────
function onBarStart(gridTime, stepDur) {
  if (Math.abs(gridTime - lastBarTime) < stepDur / 2) return;     // the other sequencer already did this bar
  lastBarTime = gridTime;
  const c = S.chainOn ? parseChain(S.chainStr) : null;
  const r = bankAtBar({ chainOn: !!c?.ok, chainSeq: c?.seq, chainPos: S.chainPos, current: S.bankCur, queued: S.bankQueued });
  S.chainPos = r.chainPos; S.bankQueued = r.queued;
  if (r.bank !== S.bankCur) switchBank(r.bank, true);
  else paintBanks();
  S.bankPlayLog?.push(BANK_LETTERS[r.bank]);                       // test hook (set by the page test)
}

function onTransportStart() { lastBarTime = -1; S.chainPos = 0; }

const playing = () => S.seqPlaying || S.pseqPlaying;

// ── UI actions ────────────────────────────────────────────────────────────────
export function clickBank(i) {
  ensureBanks();
  if (copyMode) {
    copyMode = false;
    if (i === S.bankCur) { paintBanks(); setStatus('Copy cancelled'); return; }
    storeBank();
    S.banks[i] = cloneBank(S.banks[S.bankCur]);
    paintBanks();
    setStatus(`Bank ${BANK_LETTERS[S.bankCur]} copied → ${BANK_LETTERS[i]}`);
    return;
  }
  if (playing()) {
    if (S.chainOn) { setStatus('Chain is picking the bank each bar — turn ⛓ Chain off to switch by hand'); return; }
    S.bankQueued = i === S.bankCur ? null : i;
    paintBanks();
    if (S.bankQueued != null) setStatus(`Bank ${BANK_LETTERS[i]} queued — switches on the next bar`);
    return;
  }
  switchBank(i);
}

export function toggleBankCopy() {
  copyMode = !copyMode;
  paintBanks();
  setStatus(copyMode ? `Copy: click the bank to paste ${BANK_LETTERS[S.bankCur]} into (click ⧉ again to cancel)` : 'Copy cancelled');
}

export function setChainStr(v) {
  S.chainStr = String(v || '');
  const c = parseChain(S.chainStr);
  const el = document.getElementById('chainInput');
  if (el) { el.classList.toggle('bad', !c.ok); el.title = c.ok ? `${c.seq.length} bar${c.seq.length > 1 ? 's' : ''}: ${formatChain(c.seq)}` : c.error; }
  if (!c.ok && S.chainOn) setStatus(c.error);
  paintBanks();
}

export function toggleChain() {
  const c = parseChain(S.chainStr);
  if (!S.chainOn && !c.ok) { setStatus(c.error); return; }
  S.chainOn = !S.chainOn;
  S.chainPos = 0; S.bankQueued = null;
  if (S.chainOn && !playing()) switchBank(c.seq[0], true);          // show the chain's first bar
  paintBanks();
  setStatus(S.chainOn
    ? `Chain on: ${formatChain(c.seq)} — ${c.seq.length} bar${c.seq.length > 1 ? 's' : ''}; → Loop and ⬇ MIDI render the whole chain`
    : 'Chain off — the sequencers loop the current bank');
}

export function paintBanks() {
  ensureBanks();
  document.querySelectorAll('.bank-btn').forEach(b => {
    const i = +b.dataset.b;
    const bank = i === S.bankCur ? { seq: S.seqPattern, roll: S.pseqPattern } : S.banks[i];
    b.classList.toggle('on', i === S.bankCur);
    b.classList.toggle('queued', i === S.bankQueued);
    b.classList.toggle('has', hasContent(bank));
    b.classList.toggle('paste', copyMode && i !== S.bankCur);
  });
  document.getElementById('bankCopyBtn')?.classList.toggle('on', copyMode);
  document.getElementById('chainBtn')?.classList.toggle('on', S.chainOn);
  const pos = document.getElementById('chainPosVal');
  if (pos) {
    const c = S.chainOn ? parseChain(S.chainStr) : null;
    pos.textContent = c?.ok && playing() && S.chainPos > 0 ? `bar ${((S.chainPos - 1) % c.seq.length) + 1}/${c.seq.length}` : '';
  }
  const inp = document.getElementById('chainInput');
  if (inp && document.activeElement !== inp && inp.value !== S.chainStr) inp.value = S.chainStr;
}

// ── Favorites: when Chain is on, a saved beat/melody carries all 4 banks' parts ──
export function bankFavExtras(kind) {
  if (!S.chainOn) return null;
  storeBank();
  const banks = S.banks.map(b => kind === 'drums'
    ? { grid: copyGrid(b.seq), prob: copyGrid(b.prob), rat: copyGrid(b.rat) }
    : { grid: copyGrid(b.roll) });
  return { banks, chain: S.chainStr };
}

export function applyBankFav(kind, fav) {
  if (!Array.isArray(fav?.banks)) return false;
  storeBank();
  fav.banks.slice(0, 4).forEach((fb, i) => {
    if (kind === 'drums') Object.assign(S.banks[i], sanitizeBank({ seq: fb.grid, prob: fb.prob, rat: fb.rat, roll: S.banks[i].roll }));
    else S.banks[i].roll = sanitizeBank({ roll: fb.grid }).roll;
  });
  if (typeof fav.chain === 'string') setChainStr(fav.chain);
  S.chainOn = parseChain(S.chainStr).ok;
  S.chainPos = 0;
  loadBank(S.chainOn ? parseChain(S.chainStr).seq[0] : S.bankCur);
  paintBanks();
  return true;
}

export function initBanks() {
  ensureBanks();
  storeBank();
  S.onBarStart = onBarStart;
  S.onTransportStart = onTransportStart;
  setChainStr(S.chainStr);
  paintBanks();
  // keep the "has content" dots honest as the grids get edited
  setInterval(paintBanks, 600);
}
