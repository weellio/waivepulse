// Song "Details" modal — view all stored settings (read-only) and edit title/artist.
import { S } from './state.js';
import { escHtml, formatSize, showToast } from './util.js';
import { updateJobCard } from './jobs.js';

let curId = null;

const mmss = s => {
  s = parseInt(s, 10); if (!s && s !== 0) return '';
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function openDetails(jobId) {
  const j = S.jobFull[jobId];
  if (!j) { showToast('No details stored for this song'); return; }
  curId = jobId;

  document.getElementById('dm-title').value  = j.title  || '';
  document.getElementById('dm-artist').value = j.artist || '';

  const rows = [
    ['Tags',         j.tags],
    ['BPM',          j.bpm],
    ['Key',          j.key],
    ['Temperature',  j.temperature],
    ['CFG scale',    j.cfg_scale],
    ['Max duration', j.max_duration_sec ? mmss(j.max_duration_sec) : ''],
    ['File',         j.file ? j.file.replace('/outputs/', '') : ''],
    ['Size',         j.file_size ? formatSize(j.file_size) : ''],
    ['Created',      j.created_at ? new Date(j.created_at).toLocaleString() : ''],
    ['Status',       j.status],
  ].filter(([, v]) => v !== undefined && v !== null && v !== '');

  document.getElementById('dm-settings').innerHTML = rows
    .map(([k, v]) => `<span class="k">${k}</span><span class="v">${escHtml(String(v))}</span>`)
    .join('');

  document.getElementById('dm-lyrics').textContent = j.lyrics || '(no lyrics stored)';
  document.getElementById('details-modal').style.display = 'flex';
}

export function closeDetails() {
  document.getElementById('details-modal').style.display = 'none';
  curId = null;
}

export async function saveDetails() {
  if (!curId) return;
  const title  = document.getElementById('dm-title').value.trim() || 'Untitled';
  const artist = document.getElementById('dm-artist').value.trim();
  try {
    const res = await fetch(`/history/${curId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, artist }),
    });
    if (!res.ok) throw new Error('save failed');
    const data = await res.json();
    if (S.jobFull[curId])     { S.jobFull[curId].title = data.title; S.jobFull[curId].artist = data.artist; }
    if (S.jobSettings[curId]) { S.jobSettings[curId].title = data.title; }
    updateJobCard(curId, S.jobFull[curId]);   // re-render the card with the new name
    showToast('Title & artist saved');
    closeDetails();
  } catch (e) {
    showToast('Could not save — is the server running?');
  }
}
