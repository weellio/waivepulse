import { S, TEMPLATES } from './state.js';
import { showToast } from './util.js';

// ── Sidebar / accordion ───────────────────────────────────────────────────────
export function toggleSidebar() {
  document.getElementById('panelCreate').classList.toggle('collapsed');
}

export function toggleCard(jobId) {
  const body  = document.getElementById(`body-${jobId}`);
  const arrow = document.getElementById(`arrow-${jobId}`);
  if (!body) return;
  if (S.openCards.has(jobId)) {
    S.openCards.delete(jobId);
    body.classList.remove('open');
    if (arrow) arrow.textContent = '▶';
  } else {
    S.openCards.add(jobId);
    body.classList.add('open');
    if (arrow) arrow.textContent = '▼';
  }
}

export function toggleAdvanced() {
  const sec   = document.getElementById("advancedSection");
  const arrow = document.getElementById("advToggleArrow");
  if (sec.classList.contains("open")) { sec.classList.remove("open"); arrow.textContent = "▶"; }
  else { sec.classList.add("open"); arrow.textContent = "▼"; }
}

export function updateDurLabel() {
  const v = parseInt(document.getElementById("maxDur").value);
  const m = Math.floor(v / 60), s = v % 60;
  document.getElementById("durLabel").textContent = `${m}:${s.toString().padStart(2,"0")}`;
}

// ── Duration estimate ─────────────────────────────────────────────────────────
// ~2.2 sung words/sec + 8 s per section break + ~12 s intro/outro, snapped to the
// slider's 10 s steps and clamped to its 30-300 s range. Returns null when there
// are no sung words to estimate from.
export function estimateDurationSec(lyrics) {
  let words = 0, sections = 0;
  for (const raw of (lyrics || '').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    if (/^\[.*\]$/.test(t)) { sections++; continue; }
    words += t.split(/\s+/).length;
  }
  if (!words) return null;
  const sec = words / 2.2 + Math.max(0, sections - 1) * 8 + 12;
  return Math.min(300, Math.max(30, Math.round(sec / 10) * 10));
}

const fmtMMSS = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function updateDurHint() {
  const el = document.getElementById('durHint');
  if (!el) return;
  if (document.getElementById('instrumental')?.checked) {
    el.textContent = 'Instrumental — pick any length.';
    return;
  }
  const est = estimateDurationSec(document.getElementById('lyrics').value);
  el.innerHTML = est
    ? `≈ ${fmtMMSS(est)} for these lyrics<a onclick="useDurEstimate()" title="Set Max duration to this estimate">use</a>`
    : '';
}

export function useDurEstimate() {
  const est = estimateDurationSec(document.getElementById('lyrics').value);
  if (!est) return;
  document.getElementById('maxDur').value = est;
  updateDurLabel();
}

// ── Instrumental toggle ───────────────────────────────────────────────────────
export function onInstrumentalToggle() {
  const on = document.getElementById('instrumental').checked;
  document.getElementById('lyrics').classList.toggle('instrumental-on', on);
  updateDurHint();
}

// ── Seed ──────────────────────────────────────────────────────────────────────
export function setSeedLocked(locked) {
  S.seedLocked = !!locked;
  const btn = document.getElementById('seedLock');
  btn.textContent = S.seedLocked ? '🔒' : '🔓';
  btn.classList.toggle('locked', S.seedLocked);
  document.getElementById('seedHelp').textContent = S.seedLocked
    ? 'Locked — this seed is reused, so the same settings reproduce the same song.'
    : 'Unlocked — a new random seed is picked each time.';
  updateTakesHelp();
}

export function toggleSeedLock() {
  const el = document.getElementById('seed');
  if (!S.seedLocked && el.value === '') randomizeSeed(false);
  setSeedLocked(!S.seedLocked);
}

export function randomizeSeed(lock = true) {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  document.getElementById('seed').value = buf[0];
  if (lock) setSeedLocked(true);   // rolling a seed means "use this one"
}

export function onSeedInput() {
  // Typing a seed means you want it used — lock automatically.
  if (document.getElementById('seed').value !== '' && !S.seedLocked) setSeedLocked(true);
}

// ── Takes ─────────────────────────────────────────────────────────────────────
export function setTakes(n) {
  S.takes = Math.max(1, Math.min(4, n | 0));
  document.querySelectorAll('#takesSeg button').forEach((b, i) => b.classList.toggle('active', i + 1 === S.takes));
  const btn = document.getElementById('btnGenerate');
  if (!btn.disabled) btn.textContent = S.takes > 1 ? `Generate ${S.takes} Takes` : 'Generate Song';
  updateTakesHelp();
}

export function updateTakesHelp() {
  const el = document.getElementById('takesHelp');
  if (!el) return;
  if (S.takes > 1 && S.seedLocked) {
    el.textContent = S.takes === 2
      ? 'Seed locked — takes use seed and seed+1'
      : `Seed locked — takes use seed, seed+1 … seed+${S.takes - 1}`;
    el.classList.add('warn');
  } else {
    el.textContent = S.takes > 1 ? 'each take gets its own random seed' : '';
    el.classList.remove('warn');
  }
}

// ── Load settings from a card back into the form ("↺ Reuse") ───────────────────
// Uses the full server record (S.jobFull) first, falling back to S.jobSettings.
// Older history entries may lack artist / topk / seed — those fields are skipped.
export function loadJobToForm(jobId) {
  const full = S.jobFull[jobId] || {};
  const legacy = S.jobSettings[jobId] || {};
  const s = {
    title: full.title ?? legacy.title, artist: full.artist ?? legacy.artist,
    lyrics: full.lyrics ?? legacy.lyrics, tags: full.tags ?? legacy.tags,
    maxDurationSec: full.max_duration_sec ?? legacy.maxDurationSec,
    temperature: full.temperature ?? legacy.temperature,
    cfgScale: full.cfg_scale ?? legacy.cfgScale,
    seed: full.seed, instrumental: !!full.instrumental,
  };
  if (!s.lyrics && !s.tags) return;

  const inst = document.getElementById('instrumental');
  if (inst) { inst.checked = s.instrumental; onInstrumentalToggle(); }

  document.getElementById('lyrics').value  = s.lyrics  || '';
  document.getElementById('title').value   = s.title   || '';
  document.getElementById('artist').value  = s.artist  || '';

  S.selectedTags.clear();
  document.querySelectorAll('.tag-btn.active').forEach(b => b.classList.remove('active'));
  const tagList = (s.tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const custom  = [];
  tagList.forEach(t => {
    const btn = [...document.querySelectorAll('.tag-btn')].find(b => b.textContent === t);
    if (btn) { S.selectedTags.add(t); btn.classList.add('active'); }
    else custom.push(t);
  });
  document.getElementById('customTags').value = custom.join(',');

  if (s.maxDurationSec) {
    document.getElementById('maxDur').value = s.maxDurationSec;
    updateDurLabel();
  }
  if (s.temperature != null) {
    document.getElementById('temperature').value = s.temperature;
    document.getElementById('tempVal').textContent = parseFloat(s.temperature).toFixed(2);
  }
  if (s.cfgScale != null) {
    document.getElementById('cfgScale').value = s.cfgScale;
    document.getElementById('cfgVal').textContent = parseFloat(s.cfgScale).toFixed(1);
  }

  // Seed: an exact reuse needs the same seed, so lock it. Older songs have none.
  if (s.seed != null) {
    document.getElementById('seed').value = s.seed;
    setSeedLocked(true);
    const adv = document.getElementById('advancedSection');
    if (adv && !adv.classList.contains('open')) toggleAdvanced();
  }
  updateDurHint();
  showToast(s.seed != null
    ? `Settings reused — seed ${s.seed} locked`
    : 'Settings reused (older song — no seed stored)');

  const panel = document.getElementById('panelCreate');
  if (panel.classList.contains('collapsed')) toggleSidebar();
  panel.querySelector('.panel-create-inner').scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Template loader ───────────────────────────────────────────────────────────
export function loadTemplate(name) {
  document.getElementById("lyrics").value = TEMPLATES[name] || "";
  updateDurHint();
}
