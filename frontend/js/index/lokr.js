// "Train a style" — a LoKr adapter trained on your own songs.
//
// One button runs all three stages, because they are not decisions, they are a pipeline:
// build the dataset from the library, encode it to tensors, then train. Splitting them into
// three buttons would just be three chances to walk away half way.
//
// WHAT THIS DOES NOT DO
// ---------------------
// It does not change the Generate button. A LoKr trains against ACE-Step, and WAIvePulse's
// main generator is HeartMuLa, so the trained style applies to the ACE-Step features
// (Rewrite Section, Add a Part) and to "Try it" here — not to the song you make with
// Generate. The panel says so rather than letting you discover it after an hour of training.

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let st = null;          // last /lokr/status
let jobId = null;
let busy = false;

function setStatus(msg, kind) {
  const el = $('lokr-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = kind === 'err' ? '#e8a04a' : kind === 'ok' ? '#5cbe6a' : '#8a8a96';
}

function appendLog(line) {
  const el = $('lokr-log');
  if (!el) return;
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

function render() {
  const body = $('lokr-body');
  if (!body || !st) return;

  if (!st.engine_ready) {
    body.innerHTML = `<p class="ace-note"><b>ACE-Step is not installed yet.</b>
      ${esc(st.engine_reason || '')} Training builds on it, so install it from Studio
      (✨ Rewrite Section → Install ACE-Step) first.</p>`;
    return;
  }

  const lib = st.library || {};
  const adapters = st.adapters || [];
  const skipped = (lib.skipped || []).slice(0, 6);

  body.innerHTML = `
    <p class="ace-note"><b>Train the model on your own songs.</b> It learns the sound of
      the music you have already made, so a new render leans that way instead of towards
      the average of everything the model ever heard.</p>

    <p class="ace-note ace-warn"><b>This does not change the Generate button.</b> The style
      attaches to the ACE-Step features — Rewrite Section and Add a Part — and to
      <b>Try it</b> below. Generate itself uses a different engine (HeartMuLa) that cannot
      load it.</p>

    <div class="lokr-stat">
      <div><b>${lib.usable ?? 0}</b> songs in your library can be used
        ${lib.enough ? '' : `<span class="lokr-bad">— ${esc(String(lib.min_songs))} is the minimum</span>`}</div>
      ${skipped.length ? `<div class="lokr-skip">Left out: ${skipped.map(s =>
        `${esc(s.title)} <i>(${esc(s.why)})</i>`).join(', ')}</div>` : ''}
      ${(lib.notes || []).map(n => `<div class="lokr-skip">${esc(n)}</div>`).join('')}
    </div>

    <p class="ace-note ace-warn"><b>It holds the graphics card for the whole run</b>, so you
      cannot generate songs while it trains, and the machine will feel slow. ${esc(st.cost?.vram_note || '')}</p>

    <div class="lokr-row">
      <label for="lokr-name">Call this style</label>
      <input type="text" id="lokr-name" value="mystyle" autocomplete="off" spellcheck="false">
    </div>
    <div class="lokr-row">
      <label for="lokr-epochs">Epochs</label>
      <input type="number" id="lokr-epochs" value="200" min="10" max="2000" step="10">
      <span class="lokr-hint">more = closer to your songs, and longer. 500 is the
        tutorial's default for a set this size.</span>
    </div>
    <div class="lokr-row">
      <button type="button" class="ace-btn ace-go" id="lokr-run"
        ${lib.enough ? '' : 'disabled'}>Train on my songs</button>
      <span class="ace-status" id="lokr-status"></span>
    </div>
    <pre id="lokr-log"></pre>

    <div class="lokr-adapters">
      <div class="lokr-adapters-h">Trained styles</div>
      ${adapters.length ? adapters.map(a => `
        <div class="lokr-adapter">
          <b>${esc(a.name)}</b>
          <span>${a.songs} songs · ${a.size_mb} MB · ${a.checkpoints} checkpoint${a.checkpoints === 1 ? '' : 's'}</span>
          <button type="button" class="ace-btn lokr-try" data-name="${esc(a.name)}"
            title="Generate a short clip with this style attached. Uses ACE-Step, so it holds the graphics card for a minute or two.">Try it</button>
        </div>`).join('')
      : '<div class="lokr-skip">None yet.</div>'}
      ${adapters.length ? `<audio id="lokr-audio" controls style="display:none;width:100%;margin-top:8px"></audio>` : ''}
    </div>`;

  $('lokr-run').addEventListener('click', run);
  $('lokr-body').querySelectorAll('.lokr-try').forEach(
    b => b.addEventListener('click', () => tryStyle(b.dataset.name, b)));
}

async function tryStyle(name, btn) {
  if (busy) return;
  busy = true;
  btn.disabled = true;
  $('lokr-log').textContent = '';
  setStatus(`Generating a clip with "${name}"…`);
  try {
    const { job_id } = await post('/lokr/try', { name, seconds: 30 });
    const j = await waitFor(job_id);
    if (j.status !== 'done') throw new Error(j.message || 'Generation failed.');
    const a = $('lokr-audio');
    a.src = `/lokr/audio/${job_id}`;
    a.style.display = '';
    setStatus('Here it is. This is ACE-Step with your style attached, not Generate.', 'ok');
  } catch (e) {
    setStatus(e.message, 'err');
  } finally {
    busy = false;
    btn.disabled = false;
  }
}

async function pump(id) {
  try {
    const res = await fetch(`/lokr/progress/${id}`);
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
        appendLog(line);
      }
    }
  } catch { /* the job poll is the source of truth */ }
}

async function waitFor(id) {
  pump(id);
  for (;;) {
    await new Promise(r => setTimeout(r, 2000));
    let j;
    try {
      const r = await fetch(`/lokr/job/${id}`);
      if (!r.ok) throw new Error('lost the job');
      j = await r.json();
    } catch (e) { return { status: 'error', message: e.message }; }
    if (j.status !== 'running') return j;
    setStatus(j.message || 'Working…');
  }
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

async function run() {
  if (busy) return;
  busy = true;
  const name = ($('lokr-name').value || 'mystyle').trim();
  const epochs = Number($('lokr-epochs').value || 200);
  $('lokr-run').disabled = true;
  $('lokr-log').textContent = '';

  try {
    setStatus('Building the training set from your library…');
    const ds = await post('/lokr/dataset', { name });
    appendLog(`Dataset: ${ds.count} songs` +
      (ds.measured ? `, measured tempo and key for ${ds.measured} of them` : ''));
    (ds.notes || []).forEach(appendLog);
    if (!ds.enough) throw new Error(ds.warning || 'Not enough usable songs.');

    setStatus('Encoding the songs. This runs once per dataset.');
    const pre = await waitFor((await post('/lokr/preprocess', { name })).job_id);
    if (pre.status !== 'done') throw new Error(pre.message || 'Preprocessing failed.');
    appendLog(`Encoded ${pre.result?.tensors ?? '?'} songs, ` +
      `peak graphics memory ${pre.result?.peak_vram_mb ?? '?'} MB`);

    setStatus('Training. This is the long part.');
    jobId = (await post('/lokr/train', { name, epochs })).job_id;
    const tr = await waitFor(jobId);
    if (tr.status !== 'done') throw new Error(tr.message || 'Training failed.');
    const m = tr.result || {};
    setStatus(`Done — ${m.steps} steps in ${Math.round((m.wall_s || 0) / 60)} min, ` +
      `peak graphics memory ${m.peak_vram_mb ?? '?'} MB.`, 'ok');
    await refresh();
  } catch (e) {
    setStatus(e.message, 'err');
  } finally {
    busy = false;
    const b = $('lokr-run');
    if (b) b.disabled = false;
  }
}

async function refresh() {
  try {
    st = await (await fetch('/lokr/status')).json();
  } catch {
    const body = $('lokr-body');
    if (body) body.innerHTML = '<p class="ace-note">Could not reach the training engine.</p>';
    return;
  }
  render();
}

async function open_() {
  $('lokr-modal').style.display = 'flex';
  await refresh();
}

document.addEventListener('DOMContentLoaded', () => {
  const btn = $('lokr-btn');
  if (!btn) return;
  btn.addEventListener('click', open_);
  $('lokr-close').addEventListener('click', () => { $('lokr-modal').style.display = 'none'; });
  $('lokr-modal').addEventListener('click', e => {
    if (e.target.id === 'lokr-modal') $('lokr-modal').style.display = 'none';
  });
});
