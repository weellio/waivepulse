// "Add a part" — the Studio front end for ACE-Step's three multi-track jobs.
//
// Self-contained the same way repaint.js is: main.js does not import this module, so every
// listener is wired here by id.
//
//   Add a layer      write a new part that plays along with the song      (lego)
//   Backing track    put a band behind a bare vocal or a sparse take      (complete)
//   Isolate a track  pull one instrument out of the mix                   (extract)
//
// WHY THE RESULT BECOMES A TRACK, NOT THE SONG
// --------------------------------------------
// These jobs return the new part ON ITS OWN, not the mix with the part added. Measured: a
// guitar layer generated against a 30 s song correlated -0.001 with that song and sat at a
// 5564 Hz spectral centroid against the song's 1190 Hz. So the honest destination is a new
// mixer track you can balance, EQ and mute — exactly like an imported file — and never a
// replacement for what you already have.
//
// WHY THESE NEED A SECOND DOWNLOAD
// --------------------------------
// They are base-checkpoint tasks. The turbo checkpoint the Rewrite Section feature uses has
// no weights for them, so the panel checks /acestep/tracks and says so rather than failing
// at generate time.

import { S } from './state.js';
import { addImportedBuffer } from './tracks.js';

const $ = id => document.getElementById(id);

let info = null;        // /acestep/tracks payload
let aceId = null;
let readyUrl = null;    // the generated clip, once a job finishes

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function songFile() {
  const f = S._jobMeta && S._jobMeta.file;
  return f ? String(f).replace(/\\/g, '/').split('/').pop() : '';
}

function setStatus(msg, kind) {
  const el = $('addtrk-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = kind === 'err' ? '#e8a04a' : kind === 'ok' ? '#5cbe6a' : '#8a8a96';
}

function kindId() {
  const b = document.querySelector('#addtrk-kinds .addtrk-kind.active');
  return b ? b.dataset.kind : 'layer';
}

function render() {
  const body = $('addtrk-body');
  if (!body || !info) return;

  if (!info.ready) {
    body.innerHTML = `<p class="ace-note"><b>These need the ACE-Step base model</b>, which is a
      separate download of about ${info.download_gb} GB. The turbo model already installed
      cannot do them — it has no weights for these three jobs.</p>
      <p class="ace-note">It installs next to the rest of ACE-Step on the same drive, never
      your C: drive. Until then nothing here changes.</p>
      <p class="ace-note">Run this once, from the project folder:</p>
      <pre class="addtrk-cmd">python scripts/get_acestep_base.py</pre>`;
    return;
  }

  const kinds = info.kinds.map((k, i) =>
    `<button type="button" class="addtrk-kind${i === 0 ? ' active' : ''}" data-kind="${esc(k.id)}"
       title="${esc(k.blurb)}">${esc(k.label)}</button>`).join('');
  const tracks = info.tracks.map(t =>
    `<option value="${esc(t)}">${esc(t.replace(/_/g, ' '))}</option>`).join('');

  body.innerHTML = `
    <div id="addtrk-kinds">${kinds}</div>
    <p class="ace-note" id="addtrk-blurb">${esc(info.kinds[0].blurb)}</p>
    <div class="addtrk-row">
      <label for="addtrk-track">Instrument</label>
      <select id="addtrk-track">${tracks}</select>
    </div>
    <div class="addtrk-row" id="addtrk-desc-row">
      <label for="addtrk-desc">How should it sound?</label>
      <input type="text" id="addtrk-desc" placeholder="e.g. bluesy lead with a bit of grit"
             autocomplete="off">
    </div>
    <div class="addtrk-row">
      <button type="button" class="ace-btn ace-go" id="addtrk-run">Generate</button>
      <button type="button" class="ace-btn" id="addtrk-add" disabled>Add as a track</button>
      <span class="ace-status" id="addtrk-status"></span>
    </div>
    <audio id="addtrk-audio" controls style="display:none;width:100%;margin-top:8px"></audio>
    <pre id="addtrk-log"></pre>`;

  $('addtrk-kinds').addEventListener('click', e => {
    const b = e.target.closest('.addtrk-kind');
    if (!b) return;
    document.querySelectorAll('#addtrk-kinds .addtrk-kind')
      .forEach(x => x.classList.toggle('active', x === b));
    const k = info.kinds.find(x => x.id === b.dataset.kind);
    $('addtrk-blurb').textContent = k ? k.blurb : '';
    // isolate pulls out what is already there, so there is nothing to describe
    $('addtrk-desc-row').style.display = b.dataset.kind === 'isolate' ? 'none' : '';
  });
  $('addtrk-run').addEventListener('click', run);
  $('addtrk-add').addEventListener('click', addAsTrack);
}

async function streamLog(id) {
  try {
    const res = await fetch(`/acestep/progress/${id}`);
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split('\n\n');
      buf = parts.pop();
      for (const p of parts) {
        const line = p.replace(/^data: /, '');
        if (line === '__done__') return;
        const el = $('addtrk-log');
        if (el) { el.textContent += line + '\n'; el.scrollTop = el.scrollHeight; }
      }
    }
  } catch { /* the status poll is the source of truth */ }
}

async function run() {
  const src = songFile();
  if (!src) { setStatus('This song has no file on the server to work from.', 'err'); return; }
  const kind = kindId();
  const desc = (($('addtrk-desc') || {}).value || '').trim();
  if (kind !== 'isolate' && !desc) {
    setStatus('Say how the new part should sound.', 'err');
    return;
  }

  readyUrl = null;
  $('addtrk-add').disabled = true;
  $('addtrk-run').disabled = true;
  $('addtrk-log').textContent = '';
  $('addtrk-audio').style.display = 'none';
  setStatus('Generating… the base model loads first, so the first run is the slowest.');

  try {
    const r = await fetch('/acestep/track', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ src, kind, track: $('addtrk-track').value, description: desc }),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `server said ${r.status}`);
    }
    aceId = (await r.json()).ace_id;
  } catch (e) {
    setStatus(e.message, 'err');
    $('addtrk-run').disabled = false;
    return;
  }

  streamLog(aceId);
  for (;;) {
    await new Promise(res => setTimeout(res, 1500));
    let job;
    try {
      const r = await fetch(`/acestep/status/${aceId}`);
      if (!r.ok) throw new Error('lost the job');
      job = await r.json();
    } catch (e) { setStatus(e.message, 'err'); break; }

    if (job.status === 'done') {
      readyUrl = `/acestep/preview/${aceId}`;   // the generic job-result route; /track sets job["preview"]
      const a = $('addtrk-audio');
      a.src = readyUrl;
      a.style.display = '';
      const m = job.metrics || {};
      setStatus(`Done in ${m.wall_s ?? '?'}s, peak graphics memory ${m.peak_vram_mb ?? '?'} MB.`, 'ok');
      $('addtrk-add').disabled = false;
      break;
    }
    if (job.status === 'error') { setStatus(job.message || 'Generation failed.', 'err'); break; }
    setStatus(job.message || 'Working…');
  }
  $('addtrk-run').disabled = false;
}

async function addAsTrack() {
  if (!readyUrl || !S._actx) return;
  $('addtrk-add').disabled = true;
  setStatus('Decoding…');
  try {
    const buf = await (await fetch(readyUrl)).arrayBuffer();
    const abuf = await S._actx.decodeAudioData(buf);
    const name = `${kindId()} ${$('addtrk-track').value.replace(/_/g, ' ')}`;
    const key = addImportedBuffer(abuf, name);
    setStatus(key ? `Added as "${name}". Balance it with the other tracks.` : 'Could not add it.',
              key ? 'ok' : 'err');
  } catch (e) {
    setStatus(`Could not decode the clip: ${e.message}`, 'err');
    $('addtrk-add').disabled = false;
  }
}

async function open() {
  $('addtrk-modal').style.display = 'flex';
  if (!info) {
    try {
      info = await (await fetch('/acestep/tracks')).json();
    } catch {
      $('addtrk-body').innerHTML =
        '<p class="ace-note">Could not reach the ACE-Step engine.</p>';
      return;
    }
  }
  render();
}

// ── In-app help ──────────────────────────────────────────────────────────────
// Feature modules add their own section to the Studio help modal (mashup.js does the same).
// Rewrite Section never had one, and it is the sibling of these three, so it is covered here
// too rather than left as the one ACE-Step feature the help does not mention.
const HELP_ACESTEP = `
<div class="help-section" id="help-addtrack">
  <div class="help-section-title">🎸 Add a Part &amp; ✨ Rewrite Section — the second engine</div>
  <p class="help-p">WAIvePulse's usual engine (HeartMuLa) writes a song start to finish and
    cannot go back into one. ACE-Step is a diffusion model, so parts of a song can be masked
    and redrawn. Both buttons use it, with different checkpoints.</p>
  <table class="help-table"><tbody>
    <tr><td><b>✨ Rewrite Section</b></td><td>Select a span on the ruler and redraw just that
      span from a description. Held to the song's own tempo and key. Turbo checkpoint, which
      the normal ACE-Step install includes.</td></tr>
    <tr><td><b>🎸 Add a layer</b></td><td>Writes a new instrument part that plays along with
      the whole song.</td></tr>
    <tr><td><b>🎸 Build a backing track</b></td><td>Puts a band behind a bare vocal or a
      sparse take. Point it at a vocal stem for this.</td></tr>
    <tr><td><b>🎸 Isolate a track</b></td><td>Pulls one instrument out of the mix. Reaches
      strings, brass, woodwinds, synth, fx and backing vocals, which the six-stem separation
      has no track for.</td></tr>
    <tr><td>Where the result goes</td><td>Add a Part returns the new part <b>on its own</b>,
      so it arrives as a new mixer track with its own fader and EQ. It never replaces the
      song. Rewrite Section is different: that one splices into the timeline.</td></tr>
    <tr><td>Isolate vs. separation</td><td>Studio's separation is a real separation and is
      sample-accurate against the mix. Isolate <b>rebuilds</b> the part, so prefer separation
      whenever one of its six stems is what you want.</td></tr>
    <tr><td>Second download</td><td>The three Add a Part jobs need the ACE-Step base
      checkpoint, about 4.5 GB on top of the normal install. The panel says so and does not
      let you start without it. Run
      <code>python scripts/get_acestep_base.py</code> once.</td></tr>
    <tr><td>How long</td><td>Measured on a 12 GB card: 58–82 s per job, peaking 7.3–9.3 GB of
      graphics memory. Nothing stays loaded afterwards.</td></tr>
  </tbody></table>
</div>`;

function injectHelp() {
  const body = document.querySelector('#help-modal .help-body');
  if (!body || $('help-addtrack')) return;
  body.insertAdjacentHTML('beforeend', HELP_ACESTEP);
}

document.addEventListener('DOMContentLoaded', () => {
  injectHelp();
  const btn = $('addtrk-btn');
  if (!btn) return;
  btn.addEventListener('click', open);
  $('addtrk-close').addEventListener('click', () => { $('addtrk-modal').style.display = 'none'; });
  $('addtrk-modal').addEventListener('click', e => {
    if (e.target.id === 'addtrk-modal') $('addtrk-modal').style.display = 'none';
  });
});
