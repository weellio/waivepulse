// Boot/lifecycle: read URL params, run separation, load stems, build the UI,
// and the Karaoke hand-off. This is the studio's bootstrap entry logic.
import { S, STEM_ORDER } from './state.js';
import { getParam, fmtTime, setOverlay, showError, hideOverlay } from './util.js';
import { setupGlobalFX, wireTrack, loadWorklets, populateSidechainDropdowns } from './audio-graph.js';
import { addTrackToUI } from './tracks.js';
import { applyZoom, buildRuler, startRAF, getCanvasWidth } from './transport.js';
import { renderMixPresetBar } from './presets.js';
import { snapshotEq } from '../shared/eq7.js';

// ── Boot ────────────────────────────────────────────────────────────────────
export async function boot() {
  S._jobId = getParam('job'); S._sepId = getParam('sep');
  if (!S._jobId && !S._sepId) { showError('No job ID provided. Open this page from a completed song card.'); return; }
  initKaraokeButtons();
  if (S._jobId && S._jobId.startsWith('local_')) {
    showError('This Studio link points to an in-browser file reference that\'s no longer available.\n\nImported songs DO work in Studio — go back to the main page, drag your MP3 in (or use ▶ Load MP3), then click 🎛 Studio on the card. The file will upload automatically and Demucs will run on it just like a generated song.');
    return;
  }
  S._sepId ? await checkSepStatus() : await fetchJobAndSeparate();
}

async function fetchJobAndSeparate() {
  try {
    setOverlay('Checking song…', '');
    const res = await fetch(`/status/${S._jobId}`);
    if (!res.ok) throw new Error(`Job not found (${res.status})`);
    const job = await res.json();
    S._title = job.title || 'Untitled';
    S._jobMeta = job;
    document.getElementById('song-title').textContent = S._title;

    const dres = await fetch('/demucs-status');
    const dstat = await dres.json();
    if (!dstat.available) { showError('Demucs is not installed.\n\nRun: pip install demucs\n\nThen restart the server.'); return; }

    setOverlay('Starting stem separation…', 'This runs Demucs on your GPU and takes a few minutes.', true);
    const sres = await fetch(`/separate/${S._jobId}`, { method: 'POST' });
    if (!sres.ok) { const e = await sres.json(); throw new Error(e.detail || 'Separation failed to start'); }
    const sdata = await sres.json();
    S._sepId = sdata.sep_id;
    window.history.replaceState({}, '', `?job=${S._jobId}&sep=${S._sepId}`);
    await checkSepStatus();
  } catch (e) { showError(e.message); }
}

async function checkSepStatus() {
  try {
    const res = await fetch(`/separate/status/${S._sepId}`);
    if (!res.ok) throw new Error(`Separation not found (${res.status})`);
    const sep = await res.json();
    S._title = sep.title || S._title;
    document.getElementById('song-title').textContent = S._title;
    if (sep.status === 'done') {
      document.getElementById('karaoke-btn').disabled = false;
      maybeAutoTranscribe();
      // If opened via ?sep= without ?job=, resolve the parent job for BPM/key metadata
      if (!S._jobMeta && sep.job_id) {
        try {
          const jr = await fetch(`/status/${sep.job_id}`);
          if (jr.ok) { S._jobMeta = await jr.json(); S._jobId = sep.job_id; }
        } catch {}
      }
      await loadStems(sep.stems); return;
    }
    if (sep.status === 'error') { showError(sep.message || 'Separation failed'); return; }
    setOverlay('Separating stems…', 'Demucs is running. This may take several minutes.', true);
    streamSepProgress();
  } catch (e) { showError(e.message); }
}

function streamSepProgress() {
  if (S._sseConn) S._sseConn.close();
  const logEl = document.getElementById('overlay-log');
  logEl.style.display = 'block';
  S._sseConn = new EventSource(`/separate/progress/${S._sepId}`);
  S._sseConn.onmessage = e => {
    if (e.data === '__done__') { S._sseConn.close(); checkSepStatus(); return; }
    try {
      const line = JSON.parse(e.data);
      logEl.textContent += line + '\n'; logEl.scrollTop = logEl.scrollHeight;
      const m = line.match(/(\d+)%/);
      if (m) document.getElementById('overlay-bar').style.width = m[1] + '%';
    } catch {}
  };
  S._sseConn.onerror = () => { S._sseConn.close(); setTimeout(checkSepStatus, 1500); };
}

async function loadStems(stems) {
  setOverlay('Loading audio…', 'Decoding stems into memory.', true);
  S._actx = new AudioContext();
  await loadWorklets(S._actx);
  setupGlobalFX();

  const stemNames = STEM_ORDER.filter(s => stems[s]);
  let loaded = 0;
  for (const stem of stemNames) {
    try {
      const res = await fetch(stems[stem]);
      const buf = await res.arrayBuffer();
      const abuf = await S._actx.decodeAudioData(buf);
      if (abuf.duration > S._dur) S._dur = abuf.duration;
      const gainNode = S._actx.createGain();
      S.tracks[stem] = {
        buffer: abuf, source: null, gainNode,
        muted: false, solo: false,
        volume: 1, pan: 0, eqS: 0, eqB: 0, eqM: 0, eqT: 0, revAmt: 0, dlyAmt: 0,
        offset: 0,
        isDuplicate: false, isImport: false, baseStem: stem,
        peaks: null, canvas: null, knobs: {}, muteRanges: [],
      };
      wireTrack(stem);
    } catch (err) { console.warn(`Could not load stem ${stem}:`, err); }
    loaded++;
    document.getElementById('overlay-bar').style.width = Math.round(loaded / stemNames.length * 100) + '%';
  }

  if (!Object.keys(S.tracks).length) { showError('No stems could be loaded.'); return; }

  const first = Object.values(S.tracks)[0].buffer;
  const lat = Math.round((S._actx.baseLatency || 0) * 1000);
  const bpmStr = S._jobMeta?.bpm ? ` · ${S._jobMeta.bpm} BPM` : '';
  const keyStr = S._jobMeta?.key ? ` · ${S._jobMeta.key}` : '';
  document.getElementById('audio-info').textContent =
    `${(first.sampleRate / 1000).toFixed(1)} kHz · ${first.numberOfChannels === 2 ? 'stereo' : 'mono'}` +
    (lat ? ` · latency ${lat} ms` : '') + bpmStr + keyStr;

  buildUI();
  hideOverlay();

  // Fetch chord data in background (non-blocking)
  if (S._jobId) {
    fetch(`/chords/${S._jobId}`).then(r => r.ok ? r.json() : null)
      .then(d => { if (d?.chords) { S._chords = d.chords; import('./waveform.js').then(m => m.drawChords()); } })
      .catch(() => {});
  }
}

// ── Build UI ──────────────────────────────────────────────────────────────
function buildUI() {
  document.getElementById('song-title').textContent = S._title;
  document.getElementById('duration-display').textContent = '/ ' + fmtTime(S._dur);
  document.getElementById('export-btn').disabled = false;
  document.getElementById('zip-btn').disabled = false;

  document.getElementById('sidebar-tracks').innerHTML = '';
  document.getElementById('scroll-content').querySelectorAll('.track-row').forEach(e => e.remove());

  for (const stem of STEM_ORDER) {
    if (!S.tracks[stem]) continue;
    addTrackToUI(stem);
  }

  // Scroll sync: waveform area Y → sidebar
  const sc = document.getElementById('scroll-content');
  const st = document.getElementById('sidebar-tracks');
  sc.addEventListener('scroll', () => { st.scrollTop = sc.scrollTop; });

  // Horizontal scroll when zoomed: convert vertical wheel → horizontal pan
  sc.addEventListener('wheel', e => {
    if (S._zoom <= 1) return;
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    e.preventDefault();
    sc.scrollLeft += e.deltaY;
  }, { passive: false });

  // Ruler: click = seek, drag = set A-B loop region
  document.getElementById('ruler-inner').addEventListener('mousedown', e => {
    e.preventDefault();
    // content-x = pointer relative to the (scrolling) ruler's left edge — matches the
    // move handler; do NOT add scrollLeft (the rect already reflects the scroll position)
    const rect = e.currentTarget.getBoundingClientRect();
    const x = Math.max(0, Math.min(getCanvasWidth(), e.clientX - rect.left));
    S._rulerDrag = { startAbs: x, moved: false };
  });

  applyZoom();
  buildRuler();
  startRAF();
  renderMixPresetBar();
  populateSidechainDropdowns();
}

// ── Karaoke ───────────────────────────────────────────────────────────────
export async function initKaraokeButtons() {
  try {
    const r = await fetch('/whisper-status');
    const d = await r.json();
    if (d.available) {
      const ab = document.getElementById('autotx-btn');
      ab.style.display = '';
      ab.classList.toggle('active', S._autoTranscribe);
      ab.textContent = S._autoTranscribe ? 'AUTO TX ON' : 'AUTO TX';
    }
  } catch {}
}

export function toggleAutoTranscribe() {
  S._autoTranscribe = !S._autoTranscribe;
  localStorage.setItem('waivepulse_autotx', S._autoTranscribe ? '1' : '0');
  const btn = document.getElementById('autotx-btn');
  btn.classList.toggle('active', S._autoTranscribe);
  btn.textContent = S._autoTranscribe ? 'AUTO TX ON' : 'AUTO TX';
}

async function maybeAutoTranscribe() {
  if (!S._autoTranscribe || !S._sepId) return;
  try {
    const r = await fetch(`/transcribe/status/${S._sepId}`);
    const d = await r.json();
    if (d.status === 'none') await fetch(`/transcribe/${S._sepId}`, { method: 'POST' });
  } catch {}
}

export function openKaraoke() {
  if (!S._sepId) return;
  const stemNames = ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other'];
  const soloActive = Object.values(S.tracks).some(t => t.solo && !t.isDuplicate && !t.isImport);
  const stemState = {};
  for (const name of stemNames) {
    const t = S.tracks[name];
    if (!t) continue;
    stemState[name] = {
      volume: t.volume, pan: t.pan,
      eq7: t.eq ? snapshotEq(t.eq) : null,   // 7-band per-track EQ (Karaoke rebuilds it)
      revAmt: t.revAmt || 0, dlyAmt: t.dlyAmt || 0, offset: t.offset || 0,
      muted: t.muted || (soloActive && !t.solo),
      muteRanges: t.muteRanges || [],
    };
  }
  localStorage.setItem('waivepulse_mixer', JSON.stringify({
    stems: stemState,
    master: {
      volume: S._masterBus ? S._masterBus.gain.value : 1,
      subEQ: S._masterSubEQ ? S._masterSubEQ.gain.value : 0,
      airEQ: S._masterAirEQ ? S._masterAirEQ.gain.value : 0,
      exciter: S._exciterEnabled,
      comp: S._compEnabled,
      clip: S._clipEnabled,
    },
  }));
  window.open(`/karaoke?sep=${S._sepId}`, '_blank');
}
