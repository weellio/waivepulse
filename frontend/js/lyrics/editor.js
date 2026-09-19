// Editable lyrics box with a live "prosody gutter":
//   * syllable count per line (amber ⚠ when far off the section's usual count)
//   * rhyme-scheme letter per line, colour-matched to a highlight behind the end word
//   * per-section average + scheme, and a stats bar (words / lines / sections / sung length)
//
// The <textarea id="output"> stays the source of truth (streaming, copy and
// Send to Generator keep working unchanged). A backdrop div sits behind the
// transparent textarea with the same font + wrapping; we render highlights
// into it and measure its line boxes to position the gutter rows.
import * as P from './prosody.js';

const DICT_URL = '/js/lyrics/data/cmudict-common.txt';
const N_COLORS = 8;

let ta, backdrop, gutter, gutterInner, statsEl, wrap;
let pending = false;
let helpersOn = true;
let onRowPick = null;   // callback(word) — set by the rhyme finder

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function initEditor({ onPickWord } = {}) {
  ta = document.getElementById('output');
  backdrop = document.getElementById('lyrBackdrop');
  gutter = document.getElementById('lyrGutter');
  gutterInner = document.getElementById('lyrGutterInner');
  statsEl = document.getElementById('lyrStats');
  wrap = document.getElementById('lyrEditor');
  onRowPick = onPickWord || null;

  ta.addEventListener('input', scheduleRefresh);
  ta.addEventListener('scroll', syncScroll);
  new ResizeObserver(scheduleRefresh).observe(ta);
  window.addEventListener('resize', scheduleRefresh);

  gutterInner.addEventListener('click', e => {
    const row = e.target.closest('[data-word]');
    if (row && onRowPick) onRowPick(row.dataset.word);
  });

  const btn = document.getElementById('btnHelpers');
  try { helpersOn = localStorage.getItem('waivepulse_lyric_helpers') !== 'off'; } catch {}
  const applyHelpers = () => {
    wrap.classList.toggle('helpers-off', !helpersOn);
    btn.textContent = helpersOn ? 'Hide syllables & rhymes' : 'Show syllables & rhymes';
    btn.setAttribute('aria-pressed', String(helpersOn));
    scheduleRefresh();
  };
  btn.addEventListener('click', () => {
    helpersOn = !helpersOn;
    try { localStorage.setItem('waivepulse_lyric_helpers', helpersOn ? 'on' : 'off'); } catch {}
    applyHelpers();
  });
  applyHelpers();
  render();
}

export async function loadDictionary() {
  const note = document.getElementById('dictState');
  try {
    const r = await fetch(DICT_URL);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const d = P.parseDict(await r.text());
    P.setDict(d);
    if (note) { note.textContent = `${d.words.length.toLocaleString()}-word pronunciation dictionary loaded`; note.className = 'dict-state ok'; }
    scheduleRefresh();
    // warm the rhyme index while the user is reading
    (window.requestIdleCallback || setTimeout)(() => P.findRhymes('love'));
  } catch (e) {
    if (note) { note.textContent = 'Dictionary unavailable — using spelling rules only'; note.className = 'dict-state err'; }
  }
}

export function scheduleRefresh() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => { pending = false; render(); });
}

function syncScroll() {
  backdrop.scrollTop = ta.scrollTop;
  gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
}

function render() {
  if (!ta) return;
  const a = P.analyzeLyrics(ta.value);
  renderStats(a);
  if (!helpersOn) { backdrop.innerHTML = ''; gutterInner.innerHTML = ''; return; }

  // colour index per (section, group) — only groups that actually rhyme get a colour
  const colourOf = new Map();
  a.sections.forEach((sec, si) => {
    let next = 0;
    sec.lines.forEach(l => {
      const k = si + ':' + l.group;
      if (l.groupSize >= 2 && !colourOf.has(k)) colourOf.set(k, next++ % N_COLORS);
    });
  });

  // 1) backdrop: same text, end words highlighted
  const html = a.lines.map(l => {
    if (l.type === 'section') {
      const sec = a.sections[l.sectionIdx];
      const meta = sec.lines.length
        ? `<span class="bd-meta">rhyme ${esc(sec.scheme.length > 12 ? sec.scheme.slice(0, 12) + '…' : sec.scheme)}</span>` : '';
      return `<div class="bl bl-sec">${esc(l.text) || '​'}${meta}</div>`;
    }
    if (l.type === 'blank') return `<div class="bl">${esc(l.text) || '​'}</div>`;
    const c = colourOf.get(l.sectionIdx + ':' + l.group);
    let body = esc(l.text);
    if (c != null && l.endWord) {
      const at = l.text.lastIndexOf(l.endWord);
      if (at >= 0) {
        body = esc(l.text.slice(0, at)) + `<mark class="rh c${c}">${esc(l.endWord)}</mark>` + esc(l.text.slice(at + l.endWord.length));
      }
    }
    return `<div class="bl${l.deviant ? ' bl-dev' : ''}">${body || '​'}</div>`;
  }).join('');
  backdrop.innerHTML = html;

  // keep the backdrop box identical to the textarea's content box (minus scrollbar)
  backdrop.style.width = ta.clientWidth + 'px';
  backdrop.style.height = ta.clientHeight + 'px';
  gutter.style.height = ta.offsetHeight + 'px';

  // 2) gutter rows positioned from the backdrop's measured line boxes
  const boxes = backdrop.children;
  const rows = [];
  a.lines.forEach((l, i) => {
    const box = boxes[i];
    if (!box || l.type === 'blank') return;
    const top = box.offsetTop;
    const h = parseFloat(getComputedStyle(ta).lineHeight) || 21;
    if (l.type === 'section') {
      const sec = a.sections[l.sectionIdx];
      if (!sec.lines.length) return;
      rows.push(`<div class="g-row g-sec" style="top:${top}px;height:${h}px"
        title="${esc(sec.name || 'Section')}: ${sec.lines.length} lines, average ${sec.avg.toFixed(1)} syllables per line, rhyme scheme ${esc(sec.scheme)}">avg ${sec.avg.toFixed(1)}</div>`);
      return;
    }
    const c = colourOf.get(l.sectionIdx + ':' + l.group);
    const sec = a.sections[l.sectionIdx];
    let tip = `${l.syl} syllable${l.syl === 1 ? '' : 's'}`;
    if (l.deviant) tip += ` — ${Math.abs(l.diff)} ${l.diff > 0 ? 'more' : 'fewer'} than this section's usual ${sec.median}`;
    tip += c != null
      ? ` · rhyme ${l.letter}${l.kind === 'near' ? ' (near rhyme)' : ''}`
      : ` · rhyme ${l.letter} (no partner in this section)`;
    if (l.endWord) tip += ` · click for rhymes on “${l.endWord}”`;
    rows.push(`<div class="g-row${l.endWord ? ' g-click' : ''}" style="top:${top}px;height:${h}px"
      ${l.endWord ? `data-word="${esc(l.endWord)}"` : ''} title="${esc(tip)}">
      <span class="g-syl${l.deviant ? ' dev' : ''}">${l.deviant ? '⚠' : ''}${l.syl}</span>
      <span class="g-rh ${c != null ? 'c' + c : 'solo'}">${l.letter}${l.kind === 'near' ? '<small>~</small>' : ''}</span>
    </div>`);
  });
  gutterInner.innerHTML = rows.join('');
  syncScroll();
}

function renderStats(a) {
  const s = a.stats;
  if (!s.words) {
    statsEl.innerHTML = '<span class="st-empty">Word, line and section counts appear here once there are lyrics.</span>';
    return;
  }
  statsEl.innerHTML = `
    <span><b>${s.words}</b> words</span>
    <span><b>${s.lines}</b> lines</span>
    <span><b>${s.sections}</b> section${s.sections === 1 ? '' : 's'}</span>
    <span title="Rough estimate: words ÷ 2.2 per second, plus ~4 s between sections">
      ≈ <b>${P.fmtDuration(s.seconds)}</b> sung</span>`;
}

export function getTextarea() { return ta; }
