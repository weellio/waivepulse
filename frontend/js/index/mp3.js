import { S } from './state.js';
import { showToast } from './util.js';
import { jobCardHTML } from './jobs.js';
import { attachVizListeners, attachMetaListeners } from './viz.js';

// ── Load local MP3 files ──────────────────────────────────────────────────────
export function loadFilesAsCards(files) {
  const list  = document.getElementById("historyList");
  const empty = list.querySelector(".empty-state");
  const dupes = [];

  files.forEach(file => {
    const key = `${file.name}|${file.size}`;
    if (S.loadedLocalFiles.has(key)) { dupes.push(file.name); return; }
    S.loadedLocalFiles.add(key);

    if (empty) empty.remove();

    const blobUrl   = URL.createObjectURL(file);
    const jobId     = "local_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6);
    S._localFileObjects.set(jobId, file);
    const title     = file.name.replace(/\.[^.]+$/, "");
    const createdAt = new Date().toISOString();

    const card = document.createElement("div");
    card.className = "job-card";
    card.id = `job-${jobId}`;
    card.innerHTML = jobCardHTML(jobId, title, "local file", "done", "Local file", blobUrl, file.size, createdAt);
    list.insertBefore(card, list.firstChild);
    setTimeout(() => { attachVizListeners(jobId); attachMetaListeners(jobId); }, 0);
  });

  if (dupes.length) {
    const msg = dupes.length === 1
      ? `Already loaded: ${dupes[0]}`
      : `${dupes.length} files already loaded`;
    showToast(msg);
  }
}

export async function openStudioForLocal(jobId) {
  const file = S._localFileObjects.get(jobId);
  if (!file) { alert('File reference lost — please reload the MP3 and try again.'); return; }
  const btn = document.getElementById('studio-btn-' + jobId);
  if (btn) { btn.textContent = '⏳ Uploading…'; btn.disabled = true; }
  // Open tab immediately while we still have the user gesture — browsers block
  // window.open() called after an await as a popup
  const win = window.open('', '_blank');
  try {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/upload', { method: 'POST', body: form });
    if (!res.ok) { const e = await res.json().catch(()=>({detail:'Upload failed'})); throw new Error(e.detail||'Upload failed'); }
    const { job_id } = await res.json();
    win.location.href = `/studio?job=${job_id}`;
    if (btn) { btn.textContent = '🎛 Studio'; btn.disabled = false; }
  } catch(e) {
    win.close();
    alert('Could not open Studio: ' + e.message);
    if (btn) { btn.textContent = '🎛 Studio'; btn.disabled = false; }
  }
}

export function loadLocalMP3(input) {
  const files = [...input.files];
  input.value = "";
  if (files.length) loadFilesAsCards(files);
}

// ── Drag and drop ─────────────────────────────────────────────────────────────
export function setupDragDrop() {
  const panel = document.getElementById('historyPanel');
  panel.addEventListener('dragover', e => { e.preventDefault(); panel.classList.add('drag-over'); });
  panel.addEventListener('dragleave', e => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('drag-over'); });
  panel.addEventListener('drop', e => {
    e.preventDefault();
    panel.classList.remove('drag-over');
    const files = [...e.dataTransfer.files].filter(f =>
      f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a)$/i.test(f.name)
    );
    if (files.length) loadFilesAsCards(files);
  });
}
