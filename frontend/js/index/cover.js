// Cover-art controls: the style picker in Advanced settings, and the
// per-song cover panel (preview + Regenerate) on a finished card.
import { showToast } from './util.js';

let STYLES = null;          // [{id,label}]
let AI_OK = false;
let AI_REASON = 'Not installed';

const KEY = 'waivepulse_cover_style';

export async function loadCoverStyles() {
  if (STYLES) return STYLES;
  try {
    const res = await fetch('/cover/styles');
    const data = await res.json();
    STYLES = data.styles || [];
    AI_OK = !!data.ai_available;
    AI_REASON = data.ai_reason || 'Not installed';
  } catch (e) {
    STYLES = [];
  }
  return STYLES;
}

// ── Generate page: the style picker ───────────────────────────────────────────
export async function buildCoverStylePicker() {
  const sel = document.getElementById('coverStyle');
  if (!sel) return;
  await loadCoverStyles();
  const saved = localStorage.getItem(KEY) || 'auto';
  sel.innerHTML =
    `<option value="auto">Auto — chosen from your tags</option>` +
    STYLES.map(s => `<option value="${s.id}">${s.label}</option>`).join('') +
    `<option value="ai"${AI_OK ? '' : ' disabled'}>AI art layer${AI_OK ? '' : ' — unavailable'}</option>`;
  sel.value = [...sel.options].some(o => o.value === saved) ? saved : 'auto';
  const aiOpt = [...sel.options].find(o => o.value === 'ai');
  if (aiOpt && !AI_OK) aiOpt.title = AI_REASON;
  const help = document.getElementById('coverStyleHelp');
  if (help) {
    help.textContent = AI_OK
      ? 'Auto picks a sleeve design from the song’s genre and mood. AI art is used underneath the typography.'
      : `Auto picks a sleeve design from the song’s genre and mood. AI art layer unavailable: ${AI_REASON}`;
  }
  sel.onchange = () => {
    try { localStorage.setItem(KEY, sel.value); } catch (_) {}
  };
}

export function getCoverStyle() {
  const sel = document.getElementById('coverStyle');
  return sel ? sel.value : 'auto';
}

// ── Song card: preview + regenerate ───────────────────────────────────────────
export function coverPanelHTML(jobId) {
  return `
    <div class="cover-panel" id="cover-panel-${jobId}">
      <img class="cover-thumb" id="cover-img-${jobId}" alt="Cover art"
           src="/cover/${jobId}.png?size=320" loading="lazy"
           onclick="window.open('/cover/${jobId}.png','_blank')"
           title="Click to open the full 1200×1200 cover">
      <div class="cover-panel-side">
        <label class="cover-label" for="cover-sel-${jobId}">Cover art</label>
        <select class="cover-select" id="cover-sel-${jobId}"
                onchange="setCoverStyle('${jobId}', this.value)"
                title="Pick an art direction for this song's sleeve"></select>
        <button class="btn-action" onclick="regenerateCover('${jobId}')"
                id="cover-regen-${jobId}"
                title="Roll a new seed: same art direction rules, a different sleeve. Updates the card and the MP3 cover.">↻ Regenerate cover</button>
        <span class="cover-note" id="cover-note-${jobId}"></span>
      </div>
    </div>`;
}

export async function initCoverPanel(jobId, currentStyle) {
  const sel = document.getElementById(`cover-sel-${jobId}`);
  if (!sel || sel.dataset.built) return;
  await loadCoverStyles();
  sel.dataset.built = '1';
  sel.innerHTML =
    `<option value="auto">Auto (from tags)</option>` +
    STYLES.map(s => `<option value="${s.id}">${s.label}</option>`).join('') +
    `<option value="ai"${AI_OK ? '' : ' disabled'}>AI art layer${AI_OK ? '' : ' — unavailable'}</option>`;
  const want = currentStyle || 'auto';
  sel.value = [...sel.options].some(o => o.value === want) ? want : 'auto';
}

function bustCover(jobId) {
  const img = document.getElementById(`cover-img-${jobId}`);
  if (img) img.src = `/cover/${jobId}.png?size=320&t=${Date.now()}`;
}

async function postCover(jobId, body, note) {
  const noteEl = document.getElementById(`cover-note-${jobId}`);
  if (noteEl) noteEl.textContent = 'Working…';
  try {
    const res = await fetch(`/cover/${jobId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    const label = (STYLES.find(s => s.id === data.direction) || {}).label || data.direction;
    if (noteEl) {
      noteEl.textContent = data.cover_embedded
        ? `${label} — saved into the MP3`
        : `${label}`;
    }
    bustCover(jobId);
    if (window.S && window.S.jobFull && window.S.jobFull[jobId]) {
      window.S.jobFull[jobId].cover_style = data.style;
    }
    showToast(note.replace('%s', label));
    return data;
  } catch (e) {
    if (noteEl) noteEl.textContent = '';
    showToast(`Cover failed: ${e.message}`);
  }
}

export async function setCoverStyle(jobId, style) {
  await postCover(jobId, { style }, 'Cover style: %s');
}

export async function regenerateCover(jobId) {
  const btn = document.getElementById(`cover-regen-${jobId}`);
  if (btn) { btn.disabled = true; btn.textContent = '↻ Regenerating…'; }
  await postCover(jobId, { regenerate: true }, 'New cover: %s');
  if (btn) { btn.disabled = false; btn.textContent = '↻ Regenerate cover'; }
}
