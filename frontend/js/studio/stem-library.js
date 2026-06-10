// Stem Library modal — lets users import stems from other separated songs.
import { S, STEM_COLORS } from './state.js';
import { addImportedBuffer, stretchTrack } from './tracks.js';

let _cache = null;   // cached library response
let _loading = false;

export function openStemLibrary() {
  const modal = document.getElementById('stem-library-modal');
  modal.classList.add('open');
  _renderLibrary();
}

export function closeStemLibrary() {
  document.getElementById('stem-library-modal').classList.remove('open');
}

async function _fetchLibrary() {
  if (_cache) return _cache;
  const res = await fetch('/stems/library');
  if (!res.ok) throw new Error('Failed to fetch stem library');
  const data = await res.json();
  _cache = data.stems || [];
  return _cache;
}

/** Invalidate the cache so the next open re-fetches. */
export function invalidateStemLibraryCache() { _cache = null; }

async function _renderLibrary() {
  const body = document.getElementById('stem-library-body');
  body.innerHTML = '<div class="sl-loading">Loading stems...</div>';

  let stems;
  try {
    stems = await _fetchLibrary();
  } catch (err) {
    body.innerHTML = '<div class="sl-loading" style="color:#f87171">Could not load stem library.</div>';
    return;
  }

  // Filter out stems belonging to the currently loaded song
  const currentSep = S._sepId;
  const filtered = stems.filter(s => s.sep_id !== currentSep);

  if (!filtered.length) {
    body.innerHTML = '<div class="sl-loading">No other separated songs available.<br><span style="font-size:11px;color:#555">Separate another song first, then come back here to swap stems.</span></div>';
    return;
  }

  // Group by sep_id
  const groups = {};
  for (const s of filtered) {
    if (!groups[s.sep_id]) groups[s.sep_id] = { title: s.title, bpm: s.bpm, key: s.key, stems: [] };
    groups[s.sep_id].stems.push(s);
  }

  body.innerHTML = '';
  for (const [sepId, group] of Object.entries(groups)) {
    const card = document.createElement('div');
    card.className = 'sl-song-card';

    const hdr = document.createElement('div');
    hdr.className = 'sl-song-hdr';
    const titleEl = document.createElement('span');
    titleEl.className = 'sl-song-title';
    titleEl.textContent = group.title;
    hdr.appendChild(titleEl);
    const meta = document.createElement('span');
    meta.className = 'sl-song-meta';
    const parts = [];
    if (group.bpm) parts.push(group.bpm + ' BPM');
    if (group.key) parts.push('Key: ' + group.key);
    meta.textContent = parts.join('  ·  ');
    hdr.appendChild(meta);
    card.appendChild(hdr);

    const row = document.createElement('div');
    row.className = 'sl-stem-row';
    for (const st of group.stems) {
      const btn = document.createElement('button');
      btn.className = 'sl-stem-btn';
      const color = STEM_COLORS[st.stem] || '#888';
      btn.style.borderColor = color;
      btn.style.color = color;
      btn.textContent = st.stem;
      btn.title = `Import "${st.stem}" from "${group.title}"`;
      btn.onclick = () => _importStem(st, btn);
      row.appendChild(btn);
    }
    card.appendChild(row);
    body.appendChild(card);
  }
}

async function _importStem(stemInfo, btn) {
  if (_loading) return;
  _loading = true;
  const origText = btn.textContent;
  btn.textContent = '...';
  btn.disabled = true;
  try {
    const res = await fetch(stemInfo.url);
    if (!res.ok) throw new Error('Download failed');
    const ab = await res.arrayBuffer();
    const abuf = await S._actx.decodeAudioData(ab);
    const name = `${stemInfo.title} — ${stemInfo.stem}`;
    const key = addImportedBuffer(abuf, name);

    // Store source metadata for time-stretch
    if (key && S.tracks[key]) {
      S.tracks[key].sourceBpm = stemInfo.bpm || null;
      S.tracks[key]._stemRef = { sepId: stemInfo.sep_id, stemName: stemInfo.stem };
      // Update BPM label
      const lbl = document.getElementById('bpm-label-' + key);
      if (lbl && stemInfo.bpm) lbl.textContent = stemInfo.bpm + ' BPM';

      // Auto-stretch prompt if BPMs differ
      const srcBpm = stemInfo.bpm;
      const tgtBpm = S._jobMeta?.bpm;
      if (srcBpm && tgtBpm && Math.abs(srcBpm - tgtBpm) > 2) {
        const doStretch = confirm(
          `This stem is ${srcBpm} BPM but the current song is ${tgtBpm} BPM.\n\n` +
          `Time-stretch to match? (pitch is preserved)`
        );
        if (doStretch) {
          const factor = srcBpm / tgtBpm;
          stretchTrack(key, factor);
        }
      }
    }

    btn.textContent = 'added';
    btn.style.opacity = '0.5';
    setTimeout(() => { btn.textContent = origText; btn.style.opacity = '1'; btn.disabled = false; }, 1500);
  } catch (err) {
    console.warn('Stem import failed:', err);
    btn.textContent = 'error';
    btn.style.color = '#f87171';
    setTimeout(() => { btn.textContent = origText; btn.style.color = ''; btn.disabled = false; }, 2000);
  } finally {
    _loading = false;
  }
}
