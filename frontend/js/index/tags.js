import { S, TAG_CATEGORIES } from './state.js';
import { escHtml } from './util.js';

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
