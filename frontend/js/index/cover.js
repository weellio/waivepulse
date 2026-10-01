// Cover-art controls: the style picker in Advanced settings, and the
// per-song cover panel (preview + Regenerate) on a finished card.
import { showToast } from './util.js';

let STYLES = null;          // [{id,label}]
let AI_OK = false;
let AI_REASON = 'Not installed';

const KEY = 'waivepulse_cover_style';

export async function loadCoverStyles(force = false) {
  if (STYLES && !force) return STYLES;
  try {
    const res = await fetch('/cover/styles');
    const data = await res.json();
    STYLES = data.styles || [];
    AI_OK = !!data.ai_available;
    AI_REASON = data.ai_reason || 'Not installed';
  } catch (e) {
    STYLES = STYLES || [];
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
  const link = document.getElementById('coverAiLink');
  if (link) {
    link.hidden = false;
    link.textContent = AI_OK ? 'AI covers are set up — change or test' : 'Set up AI covers';
  }
}

// ── "Set up AI covers": everything a downloader needs, in the app ─────────────
// No config file to edit by hand: this panel writes data/cover_ai.json.

let SETUP = null;          // last /cover/ai/setup payload

const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function toggleCoverAiSetup(ev) {
  if (ev) ev.preventDefault();
  const panel = document.getElementById('coverAiPanel');
  if (!panel) return;
  if (!panel.hidden) { panel.hidden = true; return; }
  panel.hidden = false;
  panel.innerHTML = `<h4>AI cover art (optional)</h4><span class="cover-ai-status">Looking for ComfyUI…</span>`;
  await refreshCoverAiSetup(false);
}

export async function refreshCoverAiSetup(rescan = false) {
  const panel = document.getElementById('coverAiPanel');
  if (!panel) return;
  if (rescan) {
    const s = panel.querySelector('.cover-ai-status');
    if (s) s.textContent = 'Looking through your drives…';
  }
  try {
    const res = await fetch(`/cover/ai/setup${rescan ? '?rescan=1' : ''}`);
    SETUP = await res.json();
  } catch (e) {
    SETUP = { ok: false, reason: `Could not reach the server: ${e.message}`, needs: [], comfy: {}, gpu: {}, checkpoints: [], effective: {}, config: {}, sources: {} };
  }
  renderCoverAiSetup();
}

function renderCoverAiSetup() {
  const panel = document.getElementById('coverAiPanel');
  if (!panel || !SETUP) return;
  const d = SETUP;
  const comfy = d.comfy || {}, gpu = d.gpu || {}, eff = d.effective || {}, cfg = d.config || {};
  const ckpts = d.checkpoints || [];
  const noGpu = !gpu.present;
  const cls = d.available ? '' : (noGpu || !comfy.found || !ckpts.length ? 'bad' : 'warn');

  const vram = gpu.present
    ? `${gpu.name || 'GPU'} — ${gpu.free_mb} MB free of ${gpu.total_mb} MB`
    : 'No NVIDIA GPU answered. AI covers need one; the 12 designed sleeves do not.';

  const ckptOpts = ckpts.length
    ? ckpts.map(c => `<option value="${esc(c.name)}"${c.selected ? ' selected' : ''}>` +
        `${esc(c.name)} — ${c.size_gb} GB${c.sdxl ? '' : ' (not SDXL-sized)'}</option>`).join('')
    : `<option value="">none found</option>`;

  // A setting pinned by an environment variable cannot be changed here, so the
  // field is shown read-only rather than pretending Save would do something.
  const envLocked = d.env_locked || [];
  const lock = name => (envLocked.includes(name) ? ' disabled' : '');
  const locked = envLocked.length
    ? `<p class="cover-ai-found">Set by environment variable, so this panel cannot change it:
         <code>${envLocked.map(esc).join('</code> <code>')}</code></p>` : '';

  panel.innerHTML = `
    <h4>AI cover art (optional)</h4>
    <span class="cover-ai-status ${cls}">${esc(d.reason || '')}</span>
    ${(d.needs || []).length ? `<ul class="cover-ai-todo">${(d.needs || []).map(n => `<li>${linkify(n)}</li>`).join('')}</ul>` : ''}
    <p class="cover-ai-found">
      ComfyUI: ${comfy.found ? `<code>${esc(comfy.root)}</code> (${esc(comfy.kind)}, ${esc(comfy.python_source)})`
                             : `not found — <a href="${esc(comfy.repo_url || '')}" target="_blank" rel="noopener">install ComfyUI</a>, then press Rescan`}<br>
      Checkpoints: ${ckpts.length ? `${ckpts.length} found` : 'none found'} ·
      GPU: ${esc(vram)}
    </p>
    ${locked}
    <div class="cover-ai-row">
      <label for="aiComfyRoot">ComfyUI folder</label>
      <input type="text" id="aiComfyRoot" spellcheck="false"
             placeholder="${esc(eff.comfy_root || 'e.g. C:\\ComfyUI_windows_portable  or  /opt/ComfyUI')}"
             value="${esc(cfg.comfy_root || '')}"${lock('WAIVEPULSE_COMFY_ROOT')}>
    </div>
    <div class="cover-ai-row">
      <label for="aiCheckpoint">Checkpoint (SDXL)</label>
      <select id="aiCheckpoint"${ckpts.length && !envLocked.includes('WAIVEPULSE_COVER_AI_MODEL') ? '' : ' disabled'}>${ckptOpts}</select>
    </div>
    <div class="cover-ai-row">
      <label for="aiCheckpointDir">Extra checkpoint folder (optional)</label>
      <input type="text" id="aiCheckpointDir" spellcheck="false"
             placeholder="a folder of .safetensors files"
             value="${esc(cfg.checkpoint_dir || '')}"${lock('WAIVEPULSE_COVER_AI_MODEL_DIR')}>
    </div>
    <div class="cover-ai-two">
      <div class="cover-ai-row">
        <label for="aiPort">ComfyUI port</label>
        <input type="number" id="aiPort" min="1024" max="65535" value="${esc(eff.port || 8188)}"${lock('WAIVEPULSE_COVER_AI_PORT')}>
      </div>
      <div class="cover-ai-row">
        <label for="aiMinVram">Min free VRAM (MB)</label>
        <input type="number" id="aiMinVram" min="6000" max="48000" step="100" value="${esc(eff.min_free_mb || 8200)}"${lock('WAIVEPULSE_COVER_AI_MIN_VRAM')}>
      </div>
    </div>
    <label class="cover-ai-switch">
      <input type="checkbox" id="aiEnabled"${d.enabled ? ' checked' : ''}${noGpu || envLocked.includes('WAIVEPULSE_COVER_AI') ? ' disabled' : ''}>
      Use AI art under the typography${noGpu ? ' — needs an NVIDIA GPU' : ''}
    </label>
    <div class="cover-ai-actions">
      <button type="button" class="btn-action" id="aiSave" onclick="saveCoverAiSetup()">Save</button>
      <button type="button" class="btn-action" id="aiRescan" onclick="rescanCoverAi()">Rescan</button>
      <button type="button" class="btn-action" id="aiTest" onclick="testCoverAi()"
              ${d.available ? '' : 'disabled'} title="Paints one real 512px image and reports how long it took">Test</button>
    </div>
    <div class="cover-ai-result" id="aiResult"></div>
    <p class="cover-ai-credit">
      Art is painted by Stable Diffusion XL on your own GPU. The default checkpoint is
      <a href="https://civitai.com/models/133005" target="_blank" rel="noopener">Juggernaut XL</a>
      by RunDiffusion, which asks to be credited; SDXL is Stability AI's, under CreativeML Open
      RAIL++-M. Images you make are yours.
    </p>`;
}

function linkify(text) {
  return esc(text).replace(/(https?:\/\/[^\s)]+)/g,
    '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

export async function rescanCoverAi() {
  const btn = document.getElementById('aiRescan');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); }
  await refreshCoverAiSetup(true);
  await refreshCoverStyleOption();
}

export async function saveCoverAiSetup() {
  const val = id => (document.getElementById(id) || {}).value;
  const body = {
    enabled: !!(document.getElementById('aiEnabled') || {}).checked,
    comfy_root: (val('aiComfyRoot') || '').trim(),
    checkpoint: (val('aiCheckpoint') || '').trim(),
    checkpoint_dir: (val('aiCheckpointDir') || '').trim(),
    port: parseInt(val('aiPort'), 10) || 8188,
    min_free_mb: parseInt(val('aiMinVram'), 10) || 8200,
  };
  const btn = document.getElementById('aiSave');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.textContent = 'Saving…'; }
  try {
    const res = await fetch('/cover/ai/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    SETUP = await res.json();
    renderCoverAiSetup();
    showToast(SETUP.saved === false ? 'Could not save the AI cover settings'
                                    : (SETUP.available ? 'AI covers ready' : `Saved — ${SETUP.reason}`));
  } catch (e) {
    showToast(`Could not save: ${e.message}`);
  }
  await refreshCoverStyleOption();
}

export async function testCoverAi() {
  const btn = document.getElementById('aiTest');
  const out = document.getElementById('aiResult');
  if (btn) { btn.disabled = true; btn.classList.add('busy'); btn.textContent = 'Painting…'; }
  if (out) out.innerHTML = `<span>Starting ComfyUI and painting a 512px test image. First run takes about a minute.</span>`;
  try {
    const res = await fetch('/cover/ai/test?size=512', { method: 'POST' });
    const r = await res.json();
    const vram = (r.vram_before_mb != null)
      ? ` VRAM ${r.vram_before_mb} MB free before, ${r.vram_after_mb} MB after.` : '';
    if (out) {
      out.innerHTML = (r.png ? `<img src="${r.png}" alt="test image">` : '') +
        `<span>${r.ok ? '✓' : '✗'} ${esc(r.note || '')}${esc(vram)}</span>`;
    }
    showToast(r.ok ? `AI cover test: ${r.seconds}s` : `AI cover test failed: ${r.note || 'no image'}`);
  } catch (e) {
    if (out) out.innerHTML = `<span>✗ ${esc(e.message)}</span>`;
  }
  if (btn) { btn.disabled = false; btn.classList.remove('busy'); btn.textContent = 'Test'; }
  await refreshCoverStyleOption();
}

/** Re-ask the server whether AI art is usable and re-enable the menu option. */
async function refreshCoverStyleOption() {
  await loadCoverStyles(true);
  const sel = document.getElementById('coverStyle');
  if (sel) {
    const opt = [...sel.options].find(o => o.value === 'ai');
    if (opt) {
      opt.disabled = !AI_OK;
      opt.textContent = `AI art layer${AI_OK ? '' : ' — unavailable'}`;
      opt.title = AI_OK ? '' : AI_REASON;
    }
  }
  const help = document.getElementById('coverStyleHelp');
  if (help) {
    help.textContent = AI_OK
      ? 'Auto picks a sleeve design from the song’s genre and mood. AI art is used underneath the typography.'
      : `Auto picks a sleeve design from the song’s genre and mood. AI art layer unavailable: ${AI_REASON}`;
  }
  const link = document.getElementById('coverAiLink');
  if (link) link.textContent = AI_OK ? 'AI covers are set up — change or test' : 'Set up AI covers';
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
