// Three Suno-style ways into a song, and one honest quality dial.
//
//   1. Sounds like this — drop a clip (or pick one of your own songs) and the
//      server measures BPM, key and timbre and scores CLAP against THIS page's
//      tag vocabulary. Nothing is applied until you click a chip.
//   2. From a picture — a local vision model describes the scene, the Lyrics
//      page's text model turns that description into tags + a lyric theme.
//      The description is shown, so a wrong tag is explainable.
//   3. Render tier — quick / balanced / deep / wild, with the measured seconds
//      next to each. Moving Temperature or CFG by hand switches to Custom and
//      the server stops overriding anything.
//
// This module is loaded by its own <script> tag inside the vibe block in
// index.html, so main.js (and the rest of the page) is untouched. It shares the
// same `S` object as the other modules, so applying a chip really does select
// the tag the generator will be sent.

import { S, TAG_CATEGORIES } from './state.js';
import { showToast } from './util.js';

const CATEGORIES = Object.fromEntries(TAG_CATEGORIES.map(c => [c.label, c.tags]));
const $ = id => document.getElementById(id);

let suggestions = [];          // [{category, tag, confidence, source, extra, applied}]
let pendingTheme = '';
let tiers = [];
let currentTier = 'balanced';
let busy = false;

// ── small helpers ─────────────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function setStatus(html, kind) {
  const el = $('vibeStatus');
  el.className = 'vibe-status' + (kind ? ' ' + kind : '');
  el.innerHTML = html || '';
}

function setBusy(on, label) {
  busy = on;
  ['vibeRefBtn', 'vibeImgBtn', 'vibeSongPick'].forEach(id => {
    const el = $(id);
    if (el) el.disabled = on;
  });
  if (on) setStatus(`<span class="vibe-spin"></span> ${esc(label || 'Working…')}`, 'work');
}

function tagButton(tag) {
  return [...document.querySelectorAll('.tag-btn')].find(b => b.textContent === tag);
}

function openCategoryOf(btn) {
  const body = btn.parentElement, hdr = body && body.previousElementSibling;
  if (body) body.classList.remove('collapsed');
  if (hdr) hdr.classList.add('open');
}

function selectedIn(category) {
  const own = CATEGORIES[category] || [];
  return [...S.selectedTags].filter(t => own.includes(t));
}

// ── chips: show, never silently apply ─────────────────────────────────────────
function renderChips() {
  const wrap = $('vibeChips');
  if (!suggestions.length) { wrap.innerHTML = ''; return; }
  wrap.innerHTML = suggestions.map((s, i) => {
    const clash = selectedIn(s.category).filter(t => t !== s.tag);
    const note = s.applied ? 'applied'
      : clash.length ? `replaces ${clash.join(', ')}`
        : s.extra ? 'also' : '';
    const pct = Number.isFinite(s.confidence) ? `<em>${s.confidence}%</em>` : '';
    return `<button type="button" class="vibe-chip${s.applied ? ' on' : ''}${clash.length && !s.applied ? ' clash' : ''}"
      data-i="${i}" title="${esc(s.source || '')}${clash.length ? ' — you already picked ' + esc(clash.join(', ')) + ' in ' + esc(s.category) : ''}">
      <span class="vibe-chip-cat">${esc(s.category)}</span>
      <span class="vibe-chip-tag">${esc(s.tag)}</span>${pct}
      ${note ? `<span class="vibe-chip-note">${esc(note)}</span>` : ''}</button>`;
  }).join('');
  wrap.querySelectorAll('.vibe-chip').forEach(b => {
    b.onclick = () => toggleChip(Number(b.dataset.i));
  });
  // "Apply" only ever means the main picks — the extras stay opt-in, one click each.
  const n = suggestions.filter(s => !s.applied && !s.extra).length;
  $('vibeApplyAll').textContent = n ? `Apply ${n} tag${n > 1 ? 's' : ''}` : 'Main picks applied';
  $('vibeApplyAll').disabled = !n;
}

function toggleChip(i) {
  const s = suggestions[i];
  if (!s) return;
  const btn = tagButton(s.tag);
  if (s.applied) {
    S.selectedTags.delete(s.tag);
    if (btn) btn.classList.remove('active', 'suggested');
    s.applied = false;
  } else {
    // one tag per category is the app's rule, so an explicit apply replaces the
    // tag that was in that slot — and the chip said so before it was clicked.
    selectedIn(s.category).forEach(t => {
      if (t === s.tag) return;
      S.selectedTags.delete(t);
      const b = tagButton(t);
      if (b) b.classList.remove('active');
      const other = suggestions.find(x => x.tag === t && x.applied);
      if (other) other.applied = false;
    });
    S.selectedTags.add(s.tag);
    if (btn) { btn.classList.add('active', 'suggested'); openCategoryOf(btn); }
    s.applied = true;
  }
  renderChips();
}

function applyAll() {
  // Highest confidence first, so the per-category replacement lands on the best one.
  suggestions
    .map((s, i) => [s, i])
    .filter(([s]) => !s.applied && !s.extra)
    .sort((a, b) => (b[0].confidence || 0) - (a[0].confidence || 0))
    .forEach(([, i]) => { if (!suggestions[i].applied) toggleChip(i); });
  showToast('Tags applied — the extras are still there if you want them');
}

function showResult({ why, description, picks, extras, theme, because, footer }) {
  suggestions = [
    ...(picks || []).map(p => ({ ...p, applied: false })),
    ...(extras || []).map(p => ({ ...p, extra: true, applied: false })),
  ].filter(p => (CATEGORIES[p.category] || []).includes(p.tag));
  pendingTheme = theme || '';
  $('vibeWhy').innerHTML = why ? `<strong>Heard:</strong> ${esc(why)}` : '';
  $('vibeDesc').innerHTML = [
    description ? `<strong>Saw:</strong> ${esc(description)}` : '',
    because ? `<span class="vibe-because">${esc(because)}</span>` : '',
    theme ? `<span class="vibe-theme-line"><strong>Lyric theme:</strong> ${esc(theme)}</span>` : '',
    footer ? `<span class="vibe-footer">${esc(footer)}</span>` : '',
  ].filter(Boolean).join('');
  $('vibeThemeBtn').hidden = !theme;
  $('vibeResult').hidden = false;
  renderChips();
}

function dismiss() {
  suggestions = [];
  pendingTheme = '';
  $('vibeResult').hidden = true;
  $('vibeChips').innerHTML = '';
  setStatus('');
}

// ── status / model availability ───────────────────────────────────────────────
let status = null;

async function loadStatus() {
  try {
    const r = await fetch('/vibe/status');
    status = await r.json();
  } catch (_) { status = null; }
  if (!status) {
    setStatus('Backend not reachable — reload the page once the server is up.', 'warn');
    return;
  }
  if (status.tiers) {
    tiers = status.tiers.tiers || [];
    currentTier = status.tiers.current || 'balanced';
    renderTiers(status.tiers.note);
  }
  const bits = [];
  if (!status.clap.cached) bits.push(`the tag model (${status.clap.download_mb} MB, one-off)`);
  if (!status.vision.installed) bits.push(`${status.vision.model} (${Math.round(status.vision.download_mb / 100) / 10} GB, one-off)`);
  if (bits.length) setStatus(`First use downloads ${bits.join(' and ')}. You will be asked first.`, 'hint');
  else if (!status.librosa) setStatus('BPM and key are off in this interpreter (numba/numpy mismatch) — tags and timbre still work.', 'warn');
  else setStatus('');
}

async function confirmDownload(kind) {
  if (!status) return true;
  if (kind === 'clap' && !status.clap.cached) {
    if (!confirm(`"Sounds like this" needs the CLAP tag model: ${status.clap.model}`
      + `\n${status.clap.download_mb} MB, Apache-2.0, downloaded once to your Hugging Face cache (not C:).`
      + `\n\nDownload it now?`)) return false;
    setBusy(true, `Downloading CLAP (${status.clap.download_mb} MB)…`);
    const r = await fetch('/vibe/clap/download', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setStatus(esc(d.detail || 'Download failed'), 'warn'); return false; }
    status.clap.cached = true;
    showToast(`CLAP ready (${d.mb} MB)`);
    return true;
  }
  if (kind === 'vision' && !status.vision.installed) {
    if (!status.vision.ollama) {
      setStatus('Ollama is not running — start it (ollama serve) to read pictures.', 'warn');
      return false;
    }
    const alt = status.vision.alternatives?.[0];
    const msg = `"From a picture" uses the local vision model ${status.vision.model}`
      + `\n~3.3 GB, Apache-2.0, pulled once through Ollama.`
      + (alt ? `\n\n(You already have ${alt}; Cancel and it will use that instead.)` : '')
      + `\n\nPull ${status.vision.model} now?`;
    if (!confirm(msg)) return !!alt;
    setBusy(true, `Pulling ${status.vision.model} (~3.3 GB)… this takes a few minutes`);
    const r = await fetch('/vibe/vision/pull', { method: 'POST' });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setStatus(esc(d.detail || 'Pull failed'), 'warn'); return !!alt; }
    status.vision = d.status || status.vision;
    showToast(`${status.vision.model} ready`);
    return true;
  }
  return true;
}

// ── 1. sounds like this ───────────────────────────────────────────────────────
async function analyseClip(file) {
  if (busy) return;
  if (!await confirmDownload('clap')) return;
  setBusy(true, `Listening to ${file.name}…`);
  const body = new FormData();
  body.append('file', file);
  body.append('categories', JSON.stringify(CATEGORIES));
  try {
    const r = await fetch('/vibe/reference', { method: 'POST', body });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    presentReference(d, file.name);
  } catch (e) {
    setStatus(esc('Could not read that clip: ' + e.message), 'warn');
  } finally { setBusy(false); }
}

async function analyseSong(jobId, label) {
  if (busy || !jobId) return;
  if (!await confirmDownload('clap')) return;
  setBusy(true, `Listening to ${label}…`);
  try {
    const r = await fetch(`/vibe/reference/${encodeURIComponent(jobId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categories: CATEGORIES }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    presentReference(d, label);
  } catch (e) {
    setStatus(esc('Could not read that song: ' + e.message), 'warn');
  } finally { setBusy(false); $('vibeSongPick').value = ''; }
}

function presentReference(d, label) {
  const skipped = (d.skipped || []).join(', ');
  showResult({
    why: d.why,
    picks: d.picks, extras: d.extras,
    footer: [
      `From ${label}.`,
      d.clap_model ? `Genre / mood / instrument / vocals scored with ${d.clap_model}; timbre measured from the spectrum.`
        : 'CLAP was unavailable, so only the measured values are shown.',
      skipped ? `${skipped} cannot be heard in audio, so they are left alone.` : '',
      'Trust them in this order: BPM, key and timbre are measured, so they are solid. '
      + 'Vocals and the acoustic/electronic read are usually right. '
      + 'Genre, mood and instrument are a guess — run over this library, CLAP agreed with '
      + 'the tag the song was generated from 1 time in 17 for genre, 1 in 15 for mood and '
      + '1 in 10 for instrument. Click only the chips that sound right.',
      d.clap_error ? `CLAP error: ${d.clap_error}` : '',
    ].filter(Boolean).join(' '),
  });
  if (!d.bpm) setStatus('Tags are in. BPM and key were unavailable for this file.', 'hint');
  else setStatus('');
}

// ── 2. from a picture ─────────────────────────────────────────────────────────
async function analyseImage(file) {
  if (busy) return;
  if (!await confirmDownload('vision')) return;
  setBusy(true, `Looking at ${file.name}… (the vision model loads on first use)`);
  const body = new FormData();
  body.append('file', file);
  body.append('categories', JSON.stringify(CATEGORIES));
  try {
    const r = await fetch('/vibe/image', { method: 'POST', body });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    showResult({
      description: d.description,
      because: d.because,
      theme: d.theme,
      picks: d.picks,
      footer: `${file.name} described by ${d.vision_model}, turned into tags by ${d.text_model}. `
        + 'The vision model is never asked for musical tags directly — it describes the scene and the text model maps it.',
    });
    setStatus('');
  } catch (e) {
    setStatus(esc('Could not read that picture: ' + e.message), 'warn');
  } finally { setBusy(false); }
}

// ── 3. tiers ──────────────────────────────────────────────────────────────────
function renderTiers(note) {
  const seg = $('vibeTierSeg');
  seg.innerHTML = tiers.map(t => {
    const secs = t.seconds ? `${Math.round(t.seconds)}s` : '—';   // 248s, not 248.3s
    return `<button type="button" data-tier="${t.id}" class="${t.id === currentTier ? 'active' : ''}"
      title="${esc(t.blurb)}"><span>${esc(t.label)}</span><em>${secs}</em></button>`;
  }).join('') + `<button type="button" data-tier="custom" class="${currentTier === 'custom' ? 'active' : ''}"
      title="Your own Temperature / CFG from Advanced settings — the server overrides nothing"><span>Custom</span><em>—</em></button>`;
  seg.querySelectorAll('button').forEach(b => { b.onclick = () => chooseTier(b.dataset.tier, true); });
  describeTier(note);
}

function describeTier(note) {
  const t = tiers.find(x => x.id === currentTier);
  const help = $('vibeTierHelp');
  if (!t) {
    help.textContent = 'Custom — whatever Temperature and CFG Scale say in Advanced settings.';
    return;
  }
  const m = t.measured || {};
  // Three short lines, not one long paragraph: what it is, what it sends, what it measured.
  // The caveat note is long and the same for every tier, so it goes behind a disclosure
  // instead of burying the numbers under eight lines of grey prose.
  const knobs = `temp ${t.temperature} · CFG ${t.cfg_scale} · top-k ${t.topk} · vocoder ${t.num_steps} steps @ ${t.guidance_scale}`;
  let timing;
  if (!t.seconds) {
    timing = 'not measured on this machine yet';
  } else if (m.verdict) {
    // the verdict already reads "248 s for 8 s of audio, ... across N runs"
    timing = m.verdict;
  } else {
    timing = `${t.seconds}s measured${m.audio_s ? ` for ${m.audio_s}s of audio` : ''}`;
  }
  help.innerHTML =
    `<div>${esc(t.blurb)}</div>` +
    `<div class="vibe-tier-knobs">${esc(knobs)}</div>` +
    `<div class="vibe-tier-timing">${esc(timing)}</div>` +
    (note ? `<details class="vibe-tier-note"><summary>Why the seconds move</summary>${esc(note)}</details>` : '');
}

async function chooseTier(id, fromClick) {
  currentTier = id;
  $('vibeTierSeg').querySelectorAll('button').forEach(b =>
    b.classList.toggle('active', b.dataset.tier === id));
  const t = tiers.find(x => x.id === id);
  if (t) {
    // mirror the tier into the Advanced sliders so what the model gets is visible
    setSlider('temperature', 'tempVal', t.temperature, 2);
    setSlider('cfgScale', 'cfgVal', t.cfg_scale, 1);
  }
  describeTier(status?.tiers?.note);
  try {
    const r = await fetch('/vibe/tier', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tier: id }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    if (fromClick && d.hooks && !d.hooks.codec && id !== 'custom') {
      // the vocoder knobs only bind once heartlib has been imported, which happens
      // on the first generation — say so rather than implying they are live
      describeTier(status?.tiers?.note);
    }
  } catch (e) {
    setStatus('Tier not saved: ' + esc(e.message), 'warn');
  }
}

let mirroring = false;

function setSlider(id, labelId, value, digits) {
  const el = $(id);
  if (!el) return;
  mirroring = true;
  el.value = value;
  const lab = $(labelId);
  if (lab) lab.textContent = parseFloat(value).toFixed(digits);
  setTimeout(() => { mirroring = false; }, 0);
}

function watchManualKnobs() {
  ['temperature', 'cfgScale'].forEach(id => {
    const el = $(id);
    if (!el) return;
    el.addEventListener('input', () => {
      if (mirroring || currentTier === 'custom') return;
      chooseTier('custom', false);
      showToast('Switched to Custom — your sliders are being used as-is');
    });
  });
}

// ── song picker ───────────────────────────────────────────────────────────────
async function fillSongPicker() {
  const sel = $('vibeSongPick');
  try {
    const r = await fetch('/history');
    const rows = await r.json();
    const done = rows.filter(j => j.status === 'done' && j.file);
    sel.innerHTML = '<option value="">…or one of your own songs</option>'
      + done.slice(0, 60).map(j =>
        `<option value="${esc(j.job_id)}">${esc(j.title || j.job_id)}${j.bpm ? ` · ${j.bpm} BPM` : ''}</option>`).join('');
    sel.disabled = !done.length;
  } catch (_) {
    sel.innerHTML = '<option value="">(library unavailable)</option>';
  }
}

// ── wiring ────────────────────────────────────────────────────────────────────
function initDrop() {
  const zone = $('vibeDrop');
  ['dragenter', 'dragover'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); zone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach(ev => zone.addEventListener(ev, e => {
    e.preventDefault(); e.stopPropagation(); zone.classList.remove('over');
  }));
  zone.addEventListener('drop', e => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    if (/^image\//.test(f.type)) analyseImage(f);
    else analyseClip(f);
  });
  zone.addEventListener('click', () => $('vibeRefFile').click());
}

function init() {
  $('vibeRefBtn').onclick = () => $('vibeRefFile').click();
  $('vibeImgBtn').onclick = () => $('vibeImgFile').click();
  $('vibeRefFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) analyseClip(f); };
  $('vibeImgFile').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) analyseImage(f); };
  $('vibeSongPick').onchange = e => {
    const o = e.target.selectedOptions[0];
    if (e.target.value) analyseSong(e.target.value, o ? o.textContent : e.target.value);
  };
  $('vibeApplyAll').onclick = applyAll;
  $('vibeDismiss').onclick = dismiss;
  $('vibeThemeBtn').onclick = async () => {
    if (!pendingTheme) return;
    try { await navigator.clipboard.writeText(pendingTheme); showToast('Theme copied — paste it into Theme on the Lyrics page'); }
    catch (_) { showToast('Copy failed — the theme is shown above, select it by hand'); }
  };
  initDrop();
  watchManualKnobs();
  loadStatus();
  fillSongPicker();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();

// handy from the console, and what the Playwright check drives
Object.assign(window, { vibe: { analyseClip, analyseSong, analyseImage, chooseTier, applyAll, dismiss,
                                get suggestions() { return suggestions; },
                                get tier() { return currentTier; } } });
