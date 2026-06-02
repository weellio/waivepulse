import { S, TEMPLATES } from './state.js';

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

// ── Load settings from a card back into the form ──────────────────────────────
export function loadJobToForm(jobId) {
  const s = S.jobSettings[jobId];
  if (!s) return;

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

  const panel = document.getElementById('panelCreate');
  if (panel.classList.contains('collapsed')) toggleSidebar();
  panel.querySelector('.panel-create-inner').scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Template loader ───────────────────────────────────────────────────────────
export function loadTemplate(name) {
  document.getElementById("lyrics").value = TEMPLATES[name] || "";
}
