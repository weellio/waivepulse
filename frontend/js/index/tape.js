// Multitrack tape sessions — get a reel off the machine, check it, repair it, preserve it.
//
// WHY A FOLDER AND NOT AN UPLOAD
// ------------------------------
// Eight tracks of a five-minute song at 24-bit/96k is about 700 MB. The server runs on this
// same machine, so it reads the files where they already sit. That is why this panel asks
// for a path instead of showing a file picker: the browser will not tell a web page where a
// chosen file lives on disk, and copying 700 MB through an HTTP form to reach a folder two
// directories away would be daft.
//
// WHAT IT NEVER DOES
// ------------------
// It never writes to a transfer. A flat transfer off the tape is the preservation master and
// may be the only surviving copy of the performance — the tape itself may not survive another
// pass. Every repair writes a new file beside the original, and the panel says which is which.
//
// The audio you hear in the browser is a 320 kbps preview, because eight full-resolution
// tracks decoded into memory is most of a gigabyte. Every measurement, repair and export
// still runs on the original file at full resolution.

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const RECENT_KEY = 'wv_tape_recent';
const DETAILS_KEY = 'wv_tape_details';

let T = {
  folder: '',
  tracks: [],
  notes: [],
  repairs: [],
  hasManifest: false,
  check: null,
  tab: 'tracks',
  selected: '',
  busy: false,
  audio: null,
  playing: '',
};

// ── small helpers ────────────────────────────────────────────────────────────
function recent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function remember(folder) {
  const list = [folder, ...recent().filter(f => f !== folder)].slice(0, 6);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch {}
}
function savedDetails() {
  try { return JSON.parse(localStorage.getItem(DETAILS_KEY) || '{}'); } catch { return {}; }
}

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `server said ${r.status}`);
  return d;
}

async function get(path) {
  const r = await fetch(path);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.detail || `server said ${r.status}`);
  return d;
}

// Remembered, not just written to the DOM. render() rebuilds the whole pane, including the
// status line, so a message set before a re-render used to vanish — the manifest was written
// and the panel then said nothing at all about it.
let lastStatus = { msg: '', kind: '' };

function setStatus(msg, kind) {
  lastStatus = { msg: msg || '', kind: kind || '' };
  paintStatus();
}

function paintStatus() {
  const el = $('tape-status');
  if (!el) return;
  el.textContent = lastStatus.msg;
  el.style.color = lastStatus.kind === 'err' ? '#e8a04a'
    : lastStatus.kind === 'ok' ? '#5cbe6a' : '#8a8a96';
}

function log(line) {
  const el = $('tape-log');
  if (!el) return;
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

/** Run a server job and stream its log into the panel. */
async function runJob(path, body, label) {
  if (T.busy) return null;
  T.busy = true;
  setStatus(label + '…');
  const logEl = $('tape-log');
  if (logEl) logEl.textContent = '';
  try {
    const { job_id } = await post(path, body);
    const es = new EventSource(`/tape/progress/${job_id}`);
    es.onmessage = e => { if (e.data !== '__done__') log(e.data); };
    for (;;) {
      await new Promise(r => setTimeout(r, 900));
      const j = await get(`/tape/job/${job_id}`);
      if (j.status !== 'running') {
        es.close();
        if (j.status === 'error') throw new Error(j.message || 'the job failed');
        setStatus(label + ' — done', 'ok');
        return j.result || {};
      }
      setStatus(j.message || label);
    }
  } catch (e) {
    setStatus(e.message, 'err');
    return null;
  } finally {
    T.busy = false;
  }
}

function fmtSec(s) {
  const n = Number(s || 0);
  return `${Math.floor(n / 60)}:${String(Math.round(n % 60)).padStart(2, '0')}`;
}

// ── playback ─────────────────────────────────────────────────────────────────
async function play(path, name) {
  if (T.audio && T.playing === path) { stopPlay(); return; }
  stopPlay();
  try {
    setStatus(`Making a preview of ${name}…`);
    const pv = await get(`/tape/preview?path=${encodeURIComponent(path)}`);
    T.audio = new Audio(pv.url);
    T.playing = path;
    T.audio.onended = () => { stopPlay(); render(); };
    await T.audio.play();
    setStatus(`Playing ${name}. This is a 320 kbps preview; repairs use the original.`);
  } catch (e) {
    setStatus(e.message, 'err');
  }
  render();
}

function stopPlay() {
  if (T.audio) { try { T.audio.pause(); } catch {} }
  T.audio = null;
  T.playing = '';
}

// ── the session ──────────────────────────────────────────────────────────────
async function openFolder(folder) {
  setStatus('Reading the folder…');
  try {
    const d = await post('/tape/open', { folder });
    T.folder = d.folder;
    T.tracks = d.tracks || [];
    T.notes = d.notes || [];
    T.repairs = d.repairs || [];
    T.hasManifest = !!d.manifest;
    T.check = null;
    T.tab = 'tracks';
    T.selected = T.tracks[0]?.path || '';
    remember(T.folder);
    setStatus(`${T.tracks.length} track(s) found.`, 'ok');
  } catch (e) {
    setStatus(e.message, 'err');
  }
  render();
}

async function runCheck() {
  const res = await runJob('/tape/check', { folder: T.folder }, 'Checking every track');
  if (res) {
    T.check = res;
    T.tab = 'check';
    render();
  }
}

function findingsFor(path) {
  const name = path.split(/[\\/]/).pop();
  return ((T.check?.findings) || []).filter(f => (f.title || '').startsWith(name));
}

function trackStats(path) {
  const name = path.split(/[\\/]/).pop();
  return ((T.check?.tracks) || []).find(t => t.name === name) || null;
}

// ── render ───────────────────────────────────────────────────────────────────
function render() {
  const body = $('tape-body');
  if (!body) return;

  if (!T.folder) { body.innerHTML = folderStep(); wire(); paintStatus(); return; }

  const tabs = [
    ['tracks', `Tracks (${T.tracks.length})`],
    ['check', T.check ? `Check (${(T.check.findings || []).length})` : 'Check'],
    ['clean', 'Clean up'],
    ['preserve', 'Preserve'],
    ['help', 'What this is'],
  ];

  body.innerHTML = `
    <div class="tape-bar">
      <span class="tape-folder" title="${esc(T.folder)}">📼 ${esc(T.folder)}</span>
      <button type="button" class="ace-btn tape-small" data-act="reopen">Change folder</button>
      <button type="button" class="ace-btn tape-small" data-act="studio">🎛 Open in Studio</button>
    </div>
    ${T.notes.map(n => `<p class="ace-note ace-warn">${esc(n)}</p>`).join('')}
    <div class="tape-tabs">
      ${tabs.map(([k, label]) => `<button type="button" class="tape-tab${T.tab === k ? ' on' : ''}"
        data-tab="${k}">${esc(label)}</button>`).join('')}
    </div>
    <div class="tape-pane">${
      T.tab === 'tracks' ? tracksPane()
      : T.tab === 'check' ? checkPane()
      : T.tab === 'clean' ? cleanPane()
      : T.tab === 'preserve' ? preservePane()
      : helpPane()}</div>
    <div class="tape-foot">
      <span class="ace-status" id="tape-status"></span>
    </div>
    <pre id="tape-log"></pre>`;
  wire();
  paintStatus();
}

function folderStep() {
  const list = recent();
  return `
    <p class="ace-note"><b>Point this at the folder your transfer landed in.</b> One file per
      tape track, captured from the machine's outputs into whatever you record with. This
      panel does not capture audio — that needs your interface's own driver — it takes over
      from the moment the files exist.</p>
    <p class="ace-note">Nothing here is ever written to your transfers. Every repair writes a
      new file beside the original.</p>
    <div class="lokr-row">
      <label for="tape-folder-in">Folder</label>
      <input type="text" id="tape-folder-in" style="flex:1;min-width:260px"
        placeholder="D:\\transfers\\demo-reel-3" autocomplete="off" spellcheck="false">
      <button type="button" class="ace-btn ace-go" data-act="open">Open session</button>
    </div>
    ${list.length ? `<div class="tape-recent">Recent:
      ${list.map(f => `<button type="button" class="tape-chip" data-folder="${esc(f)}">${esc(f)}</button>`).join('')}
    </div>` : ''}
    <div class="tape-foot"><span class="ace-status" id="tape-status"></span></div>`;
}

function tracksPane() {
  if (!T.tracks.length) return `<p class="ace-note">No audio files in that folder.</p>`;
  return `
    <table class="tape-table">
      <thead><tr><th></th><th>Track</th><th>Length</th><th>Format</th><th></th></tr></thead>
      <tbody>
      ${T.tracks.map(t => `
        <tr>
          <td><button type="button" class="tape-play" data-play="${esc(t.path)}"
            title="Play a preview">${T.playing === t.path ? '⏸' : '▶'}</button></td>
          <td class="tape-name">${esc(t.name)}</td>
          <td>${fmtSec(t.seconds)}</td>
          <td class="tape-dim">${t.samplerate} Hz · ${esc(String(t.subtype || ''))} ·
            ${t.channels === 1 ? 'mono' : t.channels === 2 ? 'stereo' : t.channels + ' ch'}</td>
          <td><a class="tape-dl" href="/tape/download?path=${encodeURIComponent(t.path)}"
            title="Save the original file">💾</a></td>
        </tr>`).join('')}
      </tbody>
    </table>
    ${T.repairs.length ? `<div class="tape-repairs">
      <div class="lokr-adapters-h">Repaired copies already in this folder</div>
      ${T.repairs.map(n => `<div class="tape-dim">· ${esc(n)}</div>`).join('')}
    </div>` : ''}
    <div class="lokr-row">
      <button type="button" class="ace-btn ace-go" data-act="check">🩺 Check this tape</button>
      <span class="lokr-hint">Reads every track for hum, hiss, dropouts, clicks, clipping,
        DC offset, a dull track from head azimuth, and tracks that do not line up.</span>
    </div>`;
}

function checkPane() {
  if (!T.check) {
    return `<p class="ace-note">Nothing measured yet.</p>
      <div class="lokr-row"><button type="button" class="ace-btn ace-go" data-act="check">
        🩺 Check this tape</button></div>`;
  }
  const fs = T.check.findings || [];
  if (!fs.length) {
    return `<p class="ace-note" style="border-left-color:#3a6a5a"><b>Nothing wrong with this
      transfer.</b> No hum, no dropouts, no clicks, every track lines up. Go and mix it.</p>`;
  }
  const sev = { high: '🔴', medium: '🟡', note: '·' };
  return `
    <p class="ace-note">Each finding says what it is, what it costs you, and what to do about
      it. Where re-transferring is the honest answer, it says that rather than offering a
      plugin that cannot really fix it.</p>
    ${fs.map(f => `
      <div class="tape-find tape-${esc(f.severity)}">
        <div class="tape-find-h">${sev[f.severity] || '·'} ${esc(f.title)}</div>
        <div class="tape-find-d">${esc(f.detail)}</div>
        <div class="tape-find-f"><b>What to do:</b> ${esc(f.fix)}</div>
        ${f.where ? `<div class="sc-where">${esc(f.where)}</div>` : ''}
      </div>`).join('')}
    <div class="lokr-row">
      <button type="button" class="ace-btn" data-act="check">Check again</button>
      <button type="button" class="ace-btn ace-go" data-tab="clean">Go to Clean up</button>
    </div>`;
}

function cleanPane() {
  if (!T.tracks.length) return `<p class="ace-note">No tracks.</p>`;
  const sel = T.selected || T.tracks[0].path;
  const stats = trackStats(sel);
  const finds = findingsFor(sel);
  const hum = stats?.hum || {};
  const clicks = stats?.clicks || {};
  return `
    <div class="lokr-row">
      <label for="tape-pick">Track</label>
      <select id="tape-pick" class="tape-select">
        ${T.tracks.map(t => `<option value="${esc(t.path)}"${t.path === sel ? ' selected' : ''}>
          ${esc(t.name)}</option>`).join('')}
      </select>
      <button type="button" class="tape-play" data-play="${esc(sel)}">${T.playing === sel ? '⏸' : '▶'}</button>
    </div>

    ${!T.check ? `<p class="ace-note">Run <b>Check this tape</b> first and this panel will
      know what is actually wrong with each track. You can use it without, but then you are
      guessing.</p>` : finds.length
      ? `<div class="tape-whats">${finds.map(f => `· ${esc(f.title)}`).join('<br>')}</div>`
      : `<div class="tape-whats">Nothing was found wrong with this track.</div>`}

    <div class="tape-group">
      <div class="tape-group-h">Noise and offset</div>
      <label class="tape-check"><input type="checkbox" id="tape-hum"
        ${hum.present ? 'checked' : ''}> Remove mains hum
        <span class="tape-dim">${hum.present
          ? `found at ${Number(hum.hz || 0).toFixed(0)} Hz, ${hum.level_dbfs} dBFS`
          : 'none found'}</span></label>
      <label class="tape-check"><input type="checkbox" id="tape-dc"
        ${stats && Math.abs(stats.dc_offset || 0) > 0.002 ? 'checked' : ''}> Remove DC offset
        <span class="tape-dim">${stats ? `measured ${(stats.dc_offset ?? 0).toFixed(5)}` : ''}</span></label>
      <label class="tape-check"><input type="checkbox" id="tape-hiss"> Subtract tape hiss
        <span class="tape-dim">${stats ? `noise floor ${stats.noise_rms_dbfs} dBFS` : ''}</span></label>
      <div class="lokr-row tape-sub">
        <label for="tape-hiss-strength">How hard</label>
        <input type="range" id="tape-hiss-strength" min="0.3" max="2" step="0.1" value="1">
        <span class="lokr-hint">Gentle on purpose. Push hiss removal and cymbals turn to
          chirping, which on a 40-year-old demo is worse than the hiss.</span>
      </div>
      <div class="lokr-row">
        <button type="button" class="ace-btn ace-go" data-act="clean">Repair, to a new file</button>
      </div>
    </div>

    <div class="tape-group">
      <div class="tape-group-h">Clicks and clipped peaks</div>
      <label class="tape-check"><input type="checkbox" id="tape-clicks"
        ${clicks.count ? 'checked' : ''}> Repair clicks
        <span class="tape-dim">${clicks.count
          ? `${clicks.count} found`
          : clicks.suppressed ? 'too dense to call — this is the playing' : 'none found'}</span></label>
      <label class="tape-check"><input type="checkbox" id="tape-clips"
        ${stats && stats.clipped > 200 ? 'checked' : ''}> Rebuild clipped peaks
        <span class="tape-dim">${stats ? `${(stats.clipped || 0).toLocaleString()} samples at full scale` : ''}</span></label>
      <div class="lokr-row tape-sub">
        <label for="tape-strength">Strength</label>
        <select id="tape-strength" class="tape-select">
          <option value="gentle">gentle</option>
          <option value="normal" selected>normal</option>
          <option value="strong">strong</option>
        </select>
        <span class="lokr-hint">Measured here: ffmpeg's own default behaves like <b>strong</b>
          and alters a dense mix by −49 dBFS. <b>Normal</b> alters it by −72 dBFS and repairs
          slightly better.</span>
      </div>
      <div class="lokr-row">
        <button type="button" class="ace-btn ace-go" data-act="declick">Repair, to a new file</button>
      </div>
    </div>

    <div class="tape-group">
      <div class="tape-group-h">Tape speed, wow and flutter</div>
      <p class="ace-note">Mains hum is a physical constant: it left the wall at exactly 50 or
        60 Hz. So wherever the hum on the tape is <i>not</i> 50 or 60, the tape was running at
        the wrong speed — and tracking that frequency second by second measures the wobble
        too. It only works on a transfer that picked up some hum.</p>
      <label class="tape-check"><input type="checkbox" id="tape-abs" checked>
        Correct the overall speed <span class="tape-dim">pulls the whole track back to pitch</span></label>
      <label class="tape-check"><input type="checkbox" id="tape-flutter" checked>
        Straighten wow and flutter <span class="tape-dim">the wobble within it</span></label>
      <div class="lokr-row">
        <label for="tape-mains">Mains</label>
        <select id="tape-mains" class="tape-select">
          <option value="">detect it</option>
          <option value="50">50 Hz (Europe, most of the world)</option>
          <option value="60">60 Hz (North America, Japan)</option>
        </select>
        <button type="button" class="ace-btn" data-act="curve">Measure, change nothing</button>
        <button type="button" class="ace-btn ace-go" data-act="speed">Correct, to a new file</button>
      </div>
      <div id="tape-curve"></div>
    </div>`;
}

function preservePane() {
  const d = savedDetails();
  // Prefixed "tape-f-" rather than "tape-": the modal's heading is already #tape-title, and
  // a second element with that id meant document.getElementById found the <h3> instead of
  // the input — the form looked fine and silently submitted an empty title.
  const f = (k, label, ph) => `
    <div class="lokr-row">
      <label for="tape-f-${k}">${label}</label>
      <input type="text" id="tape-f-${k}" value="${esc(d[k] || '')}" placeholder="${esc(ph)}"
        autocomplete="off" spellcheck="false" style="flex:1;min-width:200px">
    </div>`;
  return `
    <p class="ace-note"><b>A transfer is only a preservation master if you can prove, years
      from now, that it is still what came off the tape.</b> This writes a manifest with a
      checksum per track — and the checksum covers the <i>audio samples only</i>, not the
      whole file, so adding titles, dates or a coding history later does not invalidate it.
      That is the trick the archival tools use, and the reason a mismatch means something
      real.</p>
    ${f('title', 'This reel is', 'Demo reel 3, spring 1987')}
    ${f('operator', 'Transferred by', 'your name')}
    ${f('machine', 'Machine', 'Tascam 38')}
    ${f('width', 'Tape width', '1/2 inch')}
    ${f('speed', 'Speed', '15 ips')}
    ${f('noise_reduction', 'Noise reduction', 'dbx Type I, or none')}
    ${f('stock', 'Tape stock', 'Ampex 456')}
    ${f('interface', 'Converter', 'RME Fireface 800')}
    ${f('transfer_date', 'Transfer date', new Date().toISOString().slice(0, 10))}
    <div class="lokr-row">
      <button type="button" class="ace-btn ace-go" data-act="manifest">Write the manifest</button>
      <button type="button" class="ace-btn" data-act="verify"
        ${T.hasManifest ? '' : 'disabled'}>Verify against it</button>
      <span class="lokr-hint">Those details become a BWF Coding History line, the standard
        way an archive records what the audio came off.</span>
    </div>
    <div id="tape-verify"></div>`;
}

function helpPane() {
  return `
    <div class="help-section-title">📼 Multitrack tape</div>
    <p class="ace-note">Point WAIvePulse at the folder a multitrack transfer landed in and it
      reads every track, tells you what is wrong with the transfer, repairs what can honestly
      be repaired, and writes a preservation manifest you can check again years later.</p>
    <p class="ace-note"><b>It does not capture audio.</b> Getting sound off the machine needs
      your interface and its driver, and whatever you already record with does it better.
      This takes over the moment the files exist.</p>
    <p class="ace-note"><b>Checked per track:</b> mains hum and its level, tape hiss, dropouts,
      clicks, clipping and samples over full scale, DC offset, and how bright the track is
      next to its siblings — one track much duller across a single reel usually means the head
      azimuth was off for that pass, which is mechanical and no EQ gets the detail back.</p>
    <p class="ace-note"><b>Checked across the session:</b> whether the tracks line up. Tracks
      captured in one pass share the tape's timing exactly, so offsets of tens of
      milliseconds mean they were captured separately — worth knowing before you spend an
      evening wondering why the drums feel wrong.</p>
    <p class="ace-note"><b>Repairs:</b> adaptive hum removal that notches where the hum lines
      actually sit rather than where arithmetic says they should be; hiss subtraction from a
      noise print taken out of the track's own quietest moment; DC removal; click repair and
      clipped-peak rebuilding through ffmpeg's autoregressive filters; and speed, wow and
      flutter correction referenced to the hum.</p>
    <p class="ace-note"><b>Every repair writes a new file.</b> Your transfer is never opened
      for writing, and a repaired file carries a small JSON note saying what was done to it
      and which file it came from.</p>`;
}

// ── wiring ───────────────────────────────────────────────────────────────────
function wire() {
  const body = $('tape-body');
  if (!body) return;

  body.querySelectorAll('[data-tab]').forEach(b => b.addEventListener('click', () => {
    T.tab = b.dataset.tab; render();
  }));
  body.querySelectorAll('[data-folder]').forEach(b => b.addEventListener('click', () => {
    openFolder(b.dataset.folder);
  }));
  body.querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', () => {
    const p = b.dataset.play;
    play(p, p.split(/[\\/]/).pop());
  }));
  const pick = $('tape-pick');
  if (pick) pick.addEventListener('change', () => { T.selected = pick.value; render(); });

  body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));

  const input = $('tape-folder-in');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); openFolder(input.value.trim()); }
    });
    input.focus();
  }
}

async function act(what) {
  const sel = T.selected || T.tracks[0]?.path || '';
  switch (what) {
    case 'open': {
      const v = ($('tape-folder-in')?.value || '').trim();
      if (v) openFolder(v);
      return;
    }
    case 'reopen':
      stopPlay();
      T.folder = '';
      render();
      return;
    case 'studio':
      window.open(`/studio?tape=${encodeURIComponent(T.folder)}`, '_blank');
      return;
    case 'check':
      return runCheck();

    case 'clean': {
      const body = {
        path: sel,
        hum: !!$('tape-hum')?.checked,
        dc: !!$('tape-dc')?.checked,
        hiss: !!$('tape-hiss')?.checked,
        hiss_strength: Number($('tape-hiss-strength')?.value || 1),
      };
      if (!body.hum && !body.dc && !body.hiss) { setStatus('Nothing is ticked.', 'err'); return; }
      const r = await runJob('/tape/clean', body, 'Repairing');
      if (r?.ok) afterRepair(r);
      return;
    }
    case 'declick': {
      const body = {
        path: sel,
        clicks: !!$('tape-clicks')?.checked,
        clips: !!$('tape-clips')?.checked,
        strength: $('tape-strength')?.value || 'normal',
      };
      if (!body.clicks && !body.clips) { setStatus('Nothing is ticked.', 'err'); return; }
      const r = await runJob('/tape/declick', body, 'Repairing');
      if (r?.ok) afterRepair(r);
      return;
    }
    case 'curve': {
      const mains = $('tape-mains')?.value;
      setStatus('Measuring the hum line…');
      try {
        const q = `/tape/curve?path=${encodeURIComponent(sel)}` + (mains ? `&mains=${mains}` : '');
        const c = await get(q);
        const el = $('tape-curve');
        if (!c.ok) { setStatus(c.error || 'no hum to measure against', 'err'); if (el) el.innerHTML = ''; return; }
        setStatus('Measured — nothing was changed.', 'ok');
        if (el) el.innerHTML = `<div class="tape-whats">
          Speed error <b>${c.speed_error_pct > 0 ? '+' : ''}${c.speed_error_pct}%</b>
          (${c.semitones > 0 ? '+' : ''}${c.semitones} semitones) ·
          flutter <b>${c.flutter_pct}%</b>, worst swing ${c.worst_swing_pct}% ·
          measured against ${c.mains_hz} Hz over ${c.windows} windows</div>`;
      } catch (e) { setStatus(e.message, 'err'); }
      return;
    }
    case 'speed': {
      const mains = $('tape-mains')?.value;
      const r = await runJob('/tape/speed', {
        path: sel,
        mains: mains ? Number(mains) : null,
        flutter: !!$('tape-flutter')?.checked,
        absolute: !!$('tape-abs')?.checked,
      }, 'Correcting speed');
      if (r?.ok && !r.unchanged) afterRepair(r);
      return;
    }
    case 'manifest': {
      const keys = ['title', 'operator', 'machine', 'width', 'speed', 'noise_reduction',
        'stock', 'interface', 'transfer_date'];
      const body = { folder: T.folder };
      keys.forEach(k => { body[k] = ($(`tape-f-${k}`)?.value || '').trim(); });
      try { localStorage.setItem(DETAILS_KEY, JSON.stringify(body)); } catch {}
      setStatus('Writing the manifest…');
      try {
        const r = await post('/tape/manifest', body);
        T.hasManifest = true;
        setStatus(`Wrote ${(r.files || []).join(', ')} into the session folder.`, 'ok');
        const el = $('tape-verify');
        if (el) el.innerHTML = `<div class="tape-whats">
          <b>Coding history for this reel</b><br>
          <code>${esc(r.coding_history || '').replace(/\r\n/g, '<br>')}</code><br><br>
          ${esc(r.note || '')}</div>`;
        render();
      } catch (e) { setStatus(e.message, 'err'); }
      return;
    }
    case 'verify': {
      setStatus('Re-reading every track…');
      try {
        const v = await get(`/tape/verify?folder=${encodeURIComponent(T.folder)}`);
        setStatus(v.summary, v.all_good ? 'ok' : 'err');
        const el = $('tape-verify');
        if (el) el.innerHTML = `<div class="tape-whats">
          ${v.all_good
            ? '<b>Every track still matches the manifest.</b> The audio is bit-for-bit what was written down.'
            : '<b>Something has changed.</b>'}
          <br>${(v.tracks || []).map(t =>
            `${t.state === 'unchanged' ? '·' : '⚠'} ${esc(t.name)} — ${esc(t.state)}`).join('<br>')}
          <br><span class="tape-dim">Written ${esc(v.written || '')}</span></div>`;
      } catch (e) { setStatus(e.message, 'err'); }
      return;
    }
    default:
      return;
  }
}

function afterRepair(r) {
  // No log line here: the server already logged "Wrote <name>." and saying it twice makes
  // the panel look like it ran twice.
  T.repairs = [...new Set([...(T.repairs || []), r.name])];
  const el = $('tape-log');
  if (el) {
    const line = document.createElement('div');
    line.className = 'tape-whats';
    line.innerHTML = `<b>${esc(r.name)}</b> — ${esc(r.note || '')}
      <button type="button" class="tape-play" data-play="${esc(r.output)}">▶</button>
      <a class="tape-dl" href="/tape/download?path=${encodeURIComponent(r.output)}">💾</a>`;
    el.parentNode.insertBefore(line, el);
    line.querySelectorAll('[data-play]').forEach(b => b.addEventListener('click', () => {
      play(b.dataset.play, r.name);
    }));
  }
}

// ── open / close ─────────────────────────────────────────────────────────────
function open_() {
  $('tape-modal').style.display = 'flex';
  render();
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = $('tape-btn');
  if (!btn) return;
  btn.addEventListener('click', open_);
  $('tape-close').addEventListener('click', () => {
    stopPlay();
    $('tape-modal').style.display = 'none';
  });
  $('tape-modal').addEventListener('click', e => {
    if (e.target.id === 'tape-modal') { stopPlay(); $('tape-modal').style.display = 'none'; }
  });
});
