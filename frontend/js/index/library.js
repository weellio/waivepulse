// Song library: search / ★ favorites filter / sort over the history list, the per-card
// star toggle (persisted server-side via PATCH /history/{id}), and the seed chip.
import { S } from './state.js';
import { showToast } from './util.js';
import { setSeedLocked, toggleAdvanced } from './ui.js';

const cardId = card => card.id.replace(/^job-/, '');

function cardTitle(card) {
  const j = S.jobFull[cardId(card)];
  return (j?.title || card.querySelector('.job-title')?.firstChild?.textContent || '').trim();
}

// ── Filter + sort ───────────────────────────────────────────────────────────────
export function applyLibraryFilter() {
  const list = document.getElementById('historyList');
  if (!list) return;
  const q    = (document.getElementById('libSearch')?.value || '').trim().toLowerCase();
  const sort = document.getElementById('libSort')?.value || 'newest';
  const cards = [...list.querySelectorAll(':scope > .job-card')];

  let shown = 0;
  cards.forEach(card => {
    const id = cardId(card);
    const j  = S.jobFull[id] || {};
    const hay = [cardTitle(card), j.artist, j.tags, j.lyrics,
                 card.querySelector('.job-tags')?.textContent].filter(Boolean).join('\n').toLowerCase();
    const active = S.activeJobs.has(id);          // in-flight jobs always stay visible
    const show = active || ((!q || hay.includes(q)) && (!S.favOnly || !!j.favorite));
    card.style.display = show ? '' : 'none';
    if (show) shown++;
  });

  // Sort: in-flight jobs pinned on top, then by the chosen key.
  const created = c => S.jobFull[cardId(c)]?.created_at || '';
  const cmp = {
    newest: (a, b) => created(b).localeCompare(created(a)),
    oldest: (a, b) => created(a).localeCompare(created(b)),
    title:  (a, b) => cardTitle(a).localeCompare(cardTitle(b), undefined, { sensitivity: 'base' }),
  }[sort];
  const sorted = [...cards].sort((a, b) => {
    const pa = S.activeJobs.has(cardId(a)) ? 0 : 1, pb = S.activeJobs.has(cardId(b)) ? 0 : 1;
    return pa - pb || cmp(a, b) || cards.indexOf(a) - cards.indexOf(b);
  });
  // Only touch the DOM if the order actually changed (moving nodes can hiccup playing audio).
  if (sorted.some((c, i) => c !== cards[i])) sorted.forEach(c => list.appendChild(c));

  let empty = list.querySelector('.lib-empty');
  if (cards.length && !shown) {
    if (!empty) {
      empty = document.createElement('div');
      empty.className = 'lib-empty';
      list.appendChild(empty);
    }
    empty.textContent = S.favOnly && !q ? 'No starred songs yet — click ☆ on a song to star it.'
                                        : 'No songs match your search.';
  } else if (empty) empty.remove();

  const countEl = document.getElementById('libCount');
  if (countEl) countEl.textContent = (q || S.favOnly) && cards.length ? `${shown} of ${cards.length}` : '';
}

export function toggleFavOnly() {
  S.favOnly = !S.favOnly;
  document.getElementById('libFavOnly').classList.toggle('active', S.favOnly);
  applyLibraryFilter();
}

// ── Star toggle ───────────────────────────────────────────────────────────────
function paintStar(jobId) {
  const btn = document.querySelector(`#job-${jobId} .btn-star`);
  if (!btn) return;
  const on = !!S.jobFull[jobId]?.favorite;
  btn.classList.toggle('on', on);
  btn.textContent = on ? '★' : '☆';
  btn.title = on ? 'Unstar' : 'Star as favorite';
}

export async function toggleFavorite(jobId) {
  const j = S.jobFull[jobId] || (S.jobFull[jobId] = { job_id: jobId });
  const next = !j.favorite;
  j.favorite = next;                 // optimistic
  paintStar(jobId);
  try {
    const res = await fetch(`/history/${jobId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ favorite: next }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    j.favorite = !!(await res.json()).favorite;
  } catch (e) {
    j.favorite = !next;
    showToast('Could not save the star — is the server running?');
  }
  paintStar(jobId);
  applyLibraryFilter();
}

// ── Seed chip → load + lock that seed in the form ───────────────────────────────
export function useSeed(seed) {
  document.getElementById('seed').value = seed;
  setSeedLocked(true);
  const adv = document.getElementById('advancedSection');
  if (adv && !adv.classList.contains('open')) toggleAdvanced();
  showToast(`Seed ${seed} locked in the form`);
}
