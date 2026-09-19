// 🎬 YouTube video: POST /video/{id} renders a 1920×1080 H.264/AAC MP4 from the song's
// generated cover art (server-side ffmpeg, cached in outputs/videos). We poll
// GET /video/{id} for progress, then hand the file to the browser as a download.
import { S } from './state.js';
import { showToast } from './util.js';

const busy = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));

function setBtn(jobId, text, disabled) {
  const b = document.getElementById(`video-btn-${jobId}`);   // re-query: cards re-render
  if (!b) return;
  b.textContent = text;
  b.disabled = !!disabled;
  b.classList.toggle('working', !!disabled);
}

function download(url, jobId) {
  const title = (S.jobFull[jobId]?.title || 'song').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'song';
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title}.mp4`;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export async function makeVideo(jobId) {
  if (busy.has(jobId)) return;
  busy.add(jobId);
  setBtn(jobId, '⏳ Starting…', true);
  try {
    let res = await fetch(`/video/${jobId}`, { method: 'POST' });
    let st = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(st.detail || `HTTP ${res.status}`);
    const t0 = Date.now();
    while (st.status === 'rendering') {
      setBtn(jobId, `⏳ Video ${st.progress || 0}%`, true);
      if (Date.now() - t0 > 15 * 60 * 1000) throw new Error('timed out');
      await sleep(900);
      res = await fetch(`/video/${jobId}`);
      st = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(st.detail || `HTTP ${res.status}`);
    }
    if (st.status !== 'done' || !st.file) throw new Error(st.message || 'render failed');
    download(st.file, jobId);
    showToast('Video ready — 1920×1080 MP4 downloading');
  } catch (e) {
    showToast(`Video failed: ${e.message}`);
  } finally {
    busy.delete(jobId);
    setBtn(jobId, '🎬 Video', false);
  }
}
