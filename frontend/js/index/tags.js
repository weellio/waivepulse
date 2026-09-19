import { S, TAG_CATEGORIES } from './state.js';
import { escHtml, showToast } from './util.js';

// ── Tag grid ──────────────────────────────────────────────────────────────────
export function buildTagGrid() {
  const grid = document.getElementById("tagGrid");
  grid.innerHTML = '';
  TAG_CATEGORIES.forEach(cat => {
    const section = document.createElement('div');
    section.className = 'tag-category';

    const header = document.createElement('div');
    header.className = 'tag-cat-header' + (cat.open ? ' open' : '');
    header.innerHTML = `<span class="cat-name">${cat.label}</span><span class="cat-desc">${cat.desc || ''}</span><span class="cat-pct pct-${cat.importance || 'optional'}">${cat.importance || ''}</span><span class="cat-arrow">▶</span>`;
    header.onclick = () => {
      const isOpen = header.classList.toggle('open');
      body.classList.toggle('collapsed', !isOpen);
    };

    const body = document.createElement('div');
    body.className = 'tag-cat-body' + (cat.open ? '' : ' collapsed');

    cat.tags.forEach(tag => {
      const btn = document.createElement('div');
      btn.className = 'tag-btn';
      btn.textContent = tag;
      btn.onclick = () => {
        if (S.selectedTags.has(tag)) { S.selectedTags.delete(tag); btn.classList.remove('active'); }
        else { S.selectedTags.add(tag); btn.classList.add('active'); }
      };
      body.appendChild(btn);
    });

    section.appendChild(header);
    section.appendChild(body);
    grid.appendChild(section);
  });
}

export function clearTags() {
  S.selectedTags.clear();
  document.getElementById('customTags').value = '';
  document.querySelectorAll('.tag-btn.active').forEach(b => b.classList.remove('active'));
}

export function randomizeTags() {
  clearTags();
  const chances = { required: 1, recommended: 0.75, optional: 0.4 };
  TAG_CATEGORIES.forEach(cat => {
    const roll = Math.random();
    if (roll > (chances[cat.importance] ?? 0.4)) return;
    const tag = cat.tags[Math.floor(Math.random() * cat.tags.length)];
    S.selectedTags.add(tag);
    const btn = [...document.querySelectorAll('.tag-btn')].find(b => b.textContent === tag);
    if (btn) btn.classList.add('active');
  });
}

export function getTagsString() {
  const custom = document.getElementById("customTags").value.trim();
  const all = [...S.selectedTags];
  if (custom) all.push(...custom.split(",").map(t => t.trim()).filter(Boolean));
  return all.join(",");
}

// ── ✨ Suggest tags (local Ollama, constrained to TAG_CATEGORIES) ────────────────
export async function suggestTags() {
  const lyrics = document.getElementById('lyrics').value.trim();
  const title  = document.getElementById('title').value.trim();
  let idea = '';
  if (!lyrics) {
    idea = (prompt('Describe the song in a few words (e.g. "rainy late-night breakup, slow"):') || '').trim();
    if (!idea) return;
  }
  const categories = Object.fromEntries(TAG_CATEGORIES.map(c => [c.label, c.tags]));
  const btn = document.getElementById('btnSuggestTags');
  btn.disabled = true; btn.textContent = '✨ Thinking…';
  try {
    const res = await fetch('/tags/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idea, lyrics, title: title === 'Untitled' ? '' : title, categories }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);

    S.selectedTags.clear();
    document.querySelectorAll('.tag-btn').forEach(b => b.classList.remove('active', 'suggested'));
    data.tags.forEach(t => {
      const b = [...document.querySelectorAll('.tag-btn')].find(x => x.textContent === t);
      if (!b) return;
      S.selectedTags.add(t);
      b.classList.add('active', 'suggested');
      // open the category so the pick is visible
      const body = b.parentElement, hdr = body.previousElementSibling;
      body.classList.remove('collapsed'); hdr.classList.add('open');
    });
    setTimeout(() => document.querySelectorAll('.tag-btn.suggested').forEach(b => b.classList.remove('suggested')), 4000);
    showToast(`✨ ${data.tags.join(', ')}  (${data.model})`);
  } catch (e) {
    const msg = /not reachable|Failed to fetch/i.test(e.message)
      ? 'Ollama isn’t running — start it (ollama serve) to use ✨ Suggest tags'
      : 'Suggest tags failed: ' + e.message;
    showToast(msg);
  } finally {
    btn.disabled = false; btn.textContent = '✨ Suggest tags';
  }
}

// ── Tag presets ───────────────────────────────────────────────────────────────
export function getPresets() {
  try { return JSON.parse(localStorage.getItem('wvTagPresets') || '{}'); }
  catch { return {}; }
}

export function saveTagPreset() {
  const tags = getTagsString();
  if (!tags) { alert("Select some tags first."); return; }
  const name = prompt("Preset name:");
  if (!name || !name.trim()) return;
  const presets = getPresets();
  presets[name.trim()] = tags;
  localStorage.setItem('wvTagPresets', JSON.stringify(presets));
  renderPresets();
}

export function applyPreset(tags) {
  S.selectedTags.clear();
  document.querySelectorAll('.tag-btn.active').forEach(b => b.classList.remove('active'));
  const list = tags.split(',').map(t => t.trim()).filter(Boolean);
  const custom = [];
  list.forEach(t => {
    const btn = [...document.querySelectorAll('.tag-btn')].find(b => b.textContent === t);
    if (btn) { S.selectedTags.add(t); btn.classList.add('active'); }
    else custom.push(t);
  });
  document.getElementById('customTags').value = custom.join(',');
}

export function deletePreset(name) {
  const presets = getPresets();
  delete presets[name];
  localStorage.setItem('wvTagPresets', JSON.stringify(presets));
  renderPresets();
}

export function renderPresets() {
  const el = document.getElementById('presetChips');
  if (!el) return;
  const presets = getPresets();
  const entries = Object.entries(presets);
  if (!entries.length) {
    el.innerHTML = '<span class="presets-empty">None saved — select tags and click + Save current</span>';
    return;
  }
  el.innerHTML = entries.map(([name, tags]) => `
    <div class="preset-chip">
      <span onclick="applyPreset(${JSON.stringify(tags)})" title="${escHtml(tags)}">${escHtml(name)}</span>
      <button onclick="deletePreset(${JSON.stringify(name)})" title="Delete">×</button>
    </div>`).join('');
}
