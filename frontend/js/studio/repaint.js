// "Rewrite this section" — the Studio front end for WAIvePulse's second generation
// engine, ACE-Step 1.5.
//
// Self-contained on purpose. main.js owns which functions become window.* globals and
// this module is not in its import list, so everything here wires its own listeners by
// id, exactly the way server-fx.js does. Nothing in main.js, edit.js or app.py changes.
//
// WHAT THIS IS NOT
// ----------------
// It is not "edit my song with words". ACE-Step regenerates the selected span from a
// *description*; it has no idea where "the chorus" is and it does not transform what is
// already there. The panel says so, and the description that will actually be sent is
// shown in an editable box before anything is generated. That honesty is the difference
// between a usable tool and a lottery.
//
// APPLY REUSES THE REAL SPLICE PATH
// ---------------------------------
// Apply does not reimplement splicing. It drives edit.js's exported spliceRegion() with
// the generated clip, so the crossfade, the `_editedAudio` bookkeeping and the undo
// snapshot are the same code the Splice button has always used — which is why a bad
// result is one Uncut away.

import { S } from './state.js';
import { spliceRegion } from './edit.js';
import { stopPlayback } from './transport.js';
import { fmtTime } from './util.js';

const $ = id => document.getElementById(id);

let st = null;            // last /acestep/status payload
let aceId = null;         // current job
let patchReady = false;
let previewAudio = null;
let describeSeq = 0;
let lastDescribedFrom = '';

// ── Selection ────────────────────────────────────────────────────────────────
function selection() {
  if (S._loopStart === null || S._loopEnd === null) return null;
  const a = Math.max(0, Math.min(S._loopStart, S._loopEnd));
  const b = Math.min(S._dur, Math.max(S._loopStart, S._loopEnd));
  return (b - a) >= 0.2 ? { a, b, len: b - a } : null;
}

function stemCount() {
  return Math.max(1, Object.values(S.tracks || {}).filter(t => !t.isImport && t.buffer).length);
}

function songFile() {
  const f = S._jobMeta && S._jobMeta.file;
  return f ? String(f).replace(/\\/g, '/').split('/').pop() : '';
}

function hasCuts() {
  return !!(S._cutLog && S._cutLog.length);
}

// ── Chrome ───────────────────────────────────────────────────────────────────
function setStatus(msg, cls) {
  const el = $('ace-status');
  if (!el) return;
  el.textContent = msg || '';
  el.style.color = cls === 'err' ? '#f09a8a' : cls === 'ok' ? '#5cbe6a' : '#777';
}

function appendLog(line) {
  const el = $('ace-log');
  if (!el) return;
  el.classList.add('show');
  el.textContent += (el.textContent ? '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function clearLog() {
  const el = $('ace-log');
  if (el) { el.textContent = ''; el.classList.remove('show'); }
  const m = $('ace-metrics');
  if (m) { m.innerHTML = ''; m.classList.remove('show'); }
}

function refreshRange() {
  const sel = selection();
  const el = $('ace-range');
  if (!el) return;
  if (!sel) {
    el.innerHTML = '<span style="color:#e8a04a">No region selected</span> — drag across the ruler, ' +
                   'or press [ and ] at two playhead positions.';
  } else {
    el.innerHTML = `<b>${fmtTime(sel.a)}</b> to <b>${fmtTime(sel.b)}</b> ` +
                   `(${sel.len.toFixed(2)}s) across ${stemCount()} track(s)`;
  }
  const cuts = hasCuts();
  const cw = $('ace-cut-warn');
  if (cw) cw.style.display = cuts ? '' : 'none';
  const run = $('ace-run');
  if (run) run.disabled = !sel || cuts || !st || !st.ready;
}

// ── Status / first run ───────────────────────────────────────────────────────
async function loadStatus() {
  let why = '';
  try {
    const r = await fetch('/acestep/status');
    if (!r.ok) { st = null; why = `the server answered ${r.status}`; }
    else st = await r.json();
  } catch (e) {
    st = null;
    why = e.message || String(e);
  }

  const installPane = $('ace-install');
  const workPane = $('ace-work');
  const root = $('ace-root');
  if (!st) {
    if (installPane) installPane.style.display = '';
    if (workPane) workPane.style.display = 'none';
    setStatus('Could not read the ACE-Step status' + (why ? ` — ${why}` : '') + '.', 'err');
    return;
  }
  if (root && st.install_root) root.textContent = st.install_root;

  const ready = !!st.ready;
  if (installPane) installPane.style.display = ready ? 'none' : '';
  if (workPane) workPane.style.display = ready ? '' : 'none';
  for (const id of ['ace-run', 'ace-preview', 'ace-apply']) {
    const b = $(id);
    if (b && !ready) b.disabled = true;
  }
  if (!ready) {
    setStatus(st.reason || 'Not ready.', 'err');
    // Installed but blocked (no VRAM, weights still downloading) — say which.
    const btn = $('ace-install-btn');
    if (btn) btn.textContent = st.installed ? 'Finish setting up ACE-Step' : 'Install ACE-Step';
  } else if (st.vram_ok === false) {
    // Not a blocker: starting a job evicts any resident Ollama model first, which usually
    // frees several GB. Say what is true rather than disabling the button on a guess.
    setStatus(`Only ${st.vram_free_mb} MB of graphics memory free, ${st.vram_needed_mb} MB needed — ` +
              `will try anyway after freeing Ollama.`, 'err');
  } else {
    setStatus(`Ready — ${st.vram_free_mb} MB of graphics memory free.`, 'ok');
  }
  refreshRange();
}

function openPanel() {
  const m = $('ace-modal');
  if (!m) return;
  m.classList.add('open');
  const tags = (S._jobMeta && S._jobMeta.tags) || '';
  const t = $('ace-instruction');
  if (t && !t.value) t.placeholder = 'make the chorus a gospel choir';
  loadStatus();
  if (tags) {
    const d = $('ace-desc');
    if (d) d.placeholder = `e.g. ${tags}`;
  }
}

function closePanel() {
  const m = $('ace-modal');
  if (m) m.classList.remove('open');
  stopPreview();
}

// ── Install ──────────────────────────────────────────────────────────────────
async function runInstall() {
  const btn = $('ace-install-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Installing…'; }
  const info = $('ace-install-status');
  if (info) info.textContent = 'This takes a while. You can leave this open.';
  clearLog();
  appendLog('Starting one-time setup…');

  try {
    const res = await fetch('/acestep/install', { method: 'POST' });
    if (!res.ok || !res.body) throw new Error(`server said ${res.status}`);
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
        if (line === '__done__') { buf = ''; break; }
        try { appendLog(JSON.parse(line)); } catch { appendLog(line); }
      }
    }
  } catch (e) {
    appendLog('Install failed: ' + e.message);
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Install ACE-Step'; }
  if (info) info.textContent = '';
  await loadStatus();
}

// ── Instruction -> description ───────────────────────────────────────────────
async function describe(force) {
  const instr = ($('ace-instruction') || {}).value || '';
  const descEl = $('ace-desc');
  if (!descEl || !instr.trim()) return;
  // Do not stomp on a description the user has edited by hand.
  if (!force && descEl.value.trim() && instr.trim() === lastDescribedFrom) return;
  if (!force && descEl.value.trim() && descEl.dataset.edited === '1') return;

  const seq = ++describeSeq;
  const why = $('ace-desc-why');
  if (why) { why.textContent = ' Translating…'; why.style.color = '#8cffff'; }
  try {
    const r = await fetch('/acestep/describe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ instruction: instr, tags: (S._jobMeta && S._jobMeta.tags) || '' }),
    });
    const j = await r.json();
    if (seq !== describeSeq) return;             // a newer request won
    descEl.value = j.description || instr;
    descEl.dataset.edited = '0';
    lastDescribedFrom = instr.trim();
    if (why) {
      why.textContent = j.ok ? ` Written by ${j.model}.` : ' ' + (j.reason || '');
      why.style.color = j.ok ? '#5cbe6a' : '#e8a04a';
    }
  } catch (e) {
    if (seq !== describeSeq) return;
    descEl.value = descEl.value || instr;
    if (why) { why.textContent = ' Could not reach the local model; your words are used as-is.'; why.style.color = '#e8a04a'; }
  }
}

// ── Generate ─────────────────────────────────────────────────────────────────
async function streamProgress(id) {
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
        try { appendLog(JSON.parse(line)); } catch { appendLog(line); }
      }
    }
  } catch { /* the status poll is the source of truth */ }
}

async function runGenerate() {
  const sel = selection();
  if (!sel) { setStatus('Select a region on the ruler first.', 'err'); return; }
  if (hasCuts()) { setStatus('Undo your cuts first — see the warning above.', 'err'); return; }
  const src = songFile();
  if (!src) { setStatus('This song has no file on the server to work from.', 'err'); return; }

  const desc = (($('ace-desc') || {}).value || '').trim();
  if (!desc) { setStatus('Fill in the description first.', 'err'); return; }

  clearLog();
  patchReady = false;
  $('ace-apply').disabled = true;
  $('ace-preview').disabled = true;
  $('ace-run').disabled = true;
  setStatus('Generating… the model loads first, so the first run is the slowest.');

  const body = {
    src,
    start_s: sel.a,
    end_s: sel.b,
    description: desc,
    tags: (S._jobMeta && S._jobMeta.tags) || '',
    lyrics: (($('ace-lyrics') || {}).value || ''),
    strength: Number(($('ace-strength') || {}).value || 60) / 100,
  };

  try {
    const r = await fetch('/acestep/repaint', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.detail || `server said ${r.status}`);
    }
    aceId = (await r.json()).ace_id;
  } catch (e) {
    setStatus(e.message, 'err');
    $('ace-run').disabled = false;
    return;
  }

  streamProgress(aceId);

  // Poll the job record; the SSE stream is just the log.
  for (;;) {
    await new Promise(res => setTimeout(res, 1500));
    let job;
    try {
      const r = await fetch(`/acestep/status/${aceId}`);
      if (!r.ok) throw new Error('lost the job');
      job = await r.json();
    } catch (e) { setStatus(e.message, 'err'); break; }

    if (job.status === 'done') {
      patchReady = true;
      renderMetrics(job.metrics || {});
      setStatus(job.message || 'Done.', 'ok');
      $('ace-apply').disabled = false;
      $('ace-preview').disabled = false;
      break;
    }
    if (job.status === 'error') {
      setStatus(job.message || 'Generation failed.', 'err');
      break;
    }
    setStatus(job.message || 'Working…');
  }
  $('ace-run').disabled = false;
  refreshRange();
}

// ── Measured seam, shown plainly ─────────────────────────────────────────────
function renderMetrics(m) {
  const el = $('ace-metrics');
  if (!el) return;
  const rows = [];
  const push = (k, v) => rows.push(`<tr><td>${k}</td><td>${v}</td></tr>`);

  push('Took', `<b>${m.wall_s ?? '?'} s</b> wall clock (model ${m.model_wall_s ?? '?'} s)`);
  push('Peak graphics memory', `<b>${m.peak_vram_mb ?? '?'} MB</b>`);
  if (m.seed != null) push('Seed', m.seed);

  if (m.outside_rms_diff_db != null) {
    const good = m.range_honored;
    push('Audio outside your section',
      `<span class="${good ? 'ace-good' : 'ace-bad'}">${m.outside_rms_diff_db} dB</span> different` +
      (good ? ' — the time range was respected' : ' — the model changed material outside the section too'));
  }
  if (m.level_match_db != null) push('Level correction applied', `${m.level_match_db} dB`);
  if (m.equal_power_xfade_ms != null) push('Equal-power crossfade', `${m.equal_power_xfade_ms} ms each edge`);

  // A boundary is judged against the SAME measurement on the untouched song at the same
  // spot, not against zero. Music is full of natural level steps — a 2.5 dB jump where the
  // original already jumps 2.5 dB is not a seam, it is the song. Only the excess is ours.
  const seams = (m.seam && m.seam.patched) || [];
  const base = (m.seam && m.seam.source_baseline) || [];
  let worstExcess = 0, worstClickExcess = 0, worstClick = 0;
  seams.forEach((s, i) => {
    if (s.note) { push(`Seam at ${s.at_s}s`, s.note); return; }
    const b = base[i] || {};
    const excess = Math.abs((s.rms_delta_db ?? 0) - (b.rms_delta_db ?? 0));
    const click = s.click_ratio, bClick = b.click_ratio;
    const clickExcess = (click != null && bClick != null) ? click - bClick : 0;
    worstExcess = Math.max(worstExcess, excess);
    worstClickExcess = Math.max(worstClickExcess, clickExcess);
    worstClick = Math.max(worstClick, click || 0);
    const exCls = excess < 1.5 ? 'ace-good' : excess < 3 ? '' : 'ace-bad';
    const clickCls = click == null ? '' : click < 2 ? 'ace-good' : click < 4 ? '' : 'ace-bad';
    push(`Seam at ${s.at_s}s`,
      `level step ${s.rms_delta_db} dB vs ${b.rms_delta_db ?? '?'} dB in the untouched song — ` +
      `<span class="${exCls}">${excess.toFixed(2)} dB of that is ours</span> &nbsp;·&nbsp; ` +
      `discontinuity <span class="${clickCls}">${click == null ? 'n/a' : click + '×'}</span> normal ` +
      `(untouched: ${bClick == null ? 'n/a' : bClick + '×'})`);
  });

  let verdict;
  if (!seams.length) verdict = '';
  else if (worstExcess < 1.5 && worstClickExcess < 1 && worstClick < 4) {
    verdict = '<span class="ace-good">The joins measure clean</span> — the level step and the ' +
              'waveform continuity are no worse than the song\'s own transitions at those points. ' +
              'That does <i>not</i> mean the <b>musical</b> transition works, and it says nothing ' +
              'about whether the new section sounds good. Listen to the preview.';
  } else {
    verdict = '<span class="ace-bad">The joins measure rough</span> — more of a step than the song ' +
              'itself has there. Try a higher "keep the original" value, or a selection that starts ' +
              'and ends on a beat.';
  }

  el.innerHTML = `<table>${rows.join('')}</table>` +
    (verdict ? `<div style="margin-top:7px;border-top:1px solid #242424;padding-top:6px">${verdict}</div>` : '') +
    `<div style="margin-top:5px;color:#667">Measured on the exact audio Apply will produce: 200 ms either
     side of each boundary, after the crossfade. "Untouched" is the same measurement on the original song
     at the same spots, for comparison.</div>`;
  el.classList.add('show');
}

// ── Preview ──────────────────────────────────────────────────────────────────
function stopPreview() {
  if (previewAudio) { previewAudio.pause(); previewAudio = null; }
  const b = $('ace-preview');
  if (b && patchReady) b.innerHTML = '&#9654; Preview';
}

function togglePreview() {
  if (!aceId || !patchReady) return;
  if (previewAudio) { stopPreview(); return; }
  if (S._playing) stopPlayback();
  const sel = selection();
  previewAudio = new Audio(`/acestep/preview/${aceId}`);
  previewAudio.onended = stopPreview;
  previewAudio.onerror = () => { setStatus('Could not play the preview.', 'err'); stopPreview(); };
  // Start a couple of seconds before the new section so the join is audible.
  previewAudio.oncanplay = () => {
    if (sel && previewAudio) {
      try { previewAudio.currentTime = Math.max(0, sel.a - 2); } catch { /* ignore */ }
    }
  };
  previewAudio.play().then(() => {
    const b = $('ace-preview');
    if (b) b.innerHTML = '&#9632; Stop';
  }).catch(() => setStatus('The browser blocked playback; click Preview again.', 'err'));
}

// ── Apply, through the real Splice path ──────────────────────────────────────
// edit.js's spliceRegion() opens a file picker, so there is no function to call with a
// Blob. Rather than copy its crossfade and undo logic (two copies would drift apart),
// we let it build its own <input type="file">, intercept that element, neuter the click
// that would open a dialog, and hand it the generated clip. Every byte of the splice
// itself is still edit.js's code.
async function applyThroughSplice(blob, filename) {
  const origCreate = document.createElement;
  let captured = null;
  document.createElement = function (tag, ...rest) {
    const el = origCreate.call(document, tag, ...rest);
    if (String(tag).toLowerCase() === 'input') {
      captured = el;
      el.click = () => {};
    }
    return el;
  };
  try {
    spliceRegion();
  } finally {
    document.createElement = origCreate;
  }
  if (!captured || typeof captured.onchange !== 'function') {
    throw new Error('Could not hand the new section to the Splice tool. ' +
                    'Use Download, then the Splice button, as a fallback.');
  }
  const dt = new DataTransfer();
  dt.items.add(new File([blob], filename, { type: 'audio/wav' }));
  captured.files = dt.files;
  await captured.onchange();
}

async function runApply() {
  if (!aceId || !patchReady) return;
  const sel = selection();
  if (!sel) { setStatus('The selection changed — select the same region again, or regenerate.', 'err'); return; }

  const n = stemCount();
  const btn = $('ace-apply');
  btn.disabled = true;
  setStatus('Splicing into the timeline…');
  try {
    // ?tracks=N scales the clip by 1/N: the Studio writes the same audio into every
    // stem and the mix is their sum, so without this the new section plays N times
    // too loud.
    const r = await fetch(`/acestep/patch/${aceId}?tracks=${n}`);
    if (!r.ok) throw new Error(`server said ${r.status}`);
    const blob = await r.blob();
    if (S._playing) stopPlayback();
    stopPreview();
    await applyThroughSplice(blob, 'acestep_section.wav');

    // spliceRegion() pushes an undo snapshot but never re-enables the Uncut button
    // (only cutRegion/undoCut do). Enable it, or the undo we just promised is invisible.
    const ub = $('uncut-btn');
    if (ub) ub.disabled = false;

    setStatus('Applied. Press ↩ Uncut in the transport bar to undo it.', 'ok');
  } catch (e) {
    setStatus('Apply failed: ' + e.message, 'err');
  }
  btn.disabled = false;
}

// ── Wiring ───────────────────────────────────────────────────────────────────
function init() {
  const modal = $('ace-modal');
  if (!modal) return;
  // The markup lives inside #transport so the button lands in the toolbar; move the
  // overlay to <body> so its stacking context can never be affected by the toolbar.
  if (modal.parentElement !== document.body) document.body.appendChild(modal);

  $('ace-btn')?.addEventListener('click', openPanel);
  $('ace-close')?.addEventListener('click', closePanel);
  modal.addEventListener('mousedown', e => { if (e.target === modal) closePanel(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closePanel();
  });

  $('ace-install-btn')?.addEventListener('click', runInstall);
  $('ace-run')?.addEventListener('click', runGenerate);
  $('ace-preview')?.addEventListener('click', togglePreview);
  $('ace-apply')?.addEventListener('click', runApply);

  const instr = $('ace-instruction');
  instr?.addEventListener('change', () => describe(false));
  instr?.addEventListener('blur', () => describe(false));
  instr?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); describe(true); } });
  $('ace-desc')?.addEventListener('input', e => { e.target.dataset.edited = '1'; });

  const sl = $('ace-strength');
  sl?.addEventListener('input', () => { $('ace-strength-val').textContent = sl.value + '%'; });

  // Keep the shown range in step with the ruler while the panel is open.
  setInterval(() => { if (modal.classList.contains('open')) refreshRange(); }, 500);
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
