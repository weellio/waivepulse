// 🎚 Match master — reference-track mastering (server-side, POST /master/match).
// Flow: pick a reference song → render the current mix offline (renderMix, same as
// Export Mix) → upload mix + reference → the server matches loudness, tonal balance,
// true peak and stereo width → download <song>_mastered.wav and show before/after
// LUFS measured in the browser with the same BS.1770 meter as Export Mix.
// Markup lives in studio.html between <!-- server-fx:start --> / <!-- server-fx:end -->.
import { S } from './state.js';
import { renderMix, audioBufferToWav } from './export.js';
import { measureLoudness } from '../shared/loudness.js';

const $ = id => document.getElementById(id);
const nextPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
const fmt = v => (Number.isFinite(v) ? v.toFixed(1) : '−∞').replace('-', '−');
const slug = s => (s || 'mix').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '_') || 'mix';

function setReadout(html, title = '') {
  const el = $('match-master-readout');
  if (el) { el.innerHTML = html; el.title = title; }
}

function setBusy(text) {
  const b = $('match-master-btn');
  if (!b) return;
  b.textContent = text || '🎚 Match master…';
  b.classList.toggle('busy', !!text);
  b.disabled = !!text || !hasTracks();
}

const hasTracks = () => Object.keys(S.tracks || {}).length > 0;

async function decodeWav(blob, sampleRate) {
  const ab = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, sampleRate);   // decode at the mix rate
  return ctx.decodeAudioData(ab);
}

export async function matchMaster(refFile) {
  if (!refFile) return;
  if (!hasTracks()) { alert('Load a song first.'); return; }
  try {
    setBusy('⏳ Rendering…'); setReadout('<span class="mm-dim">rendering mix…</span>');
    const mix = await renderMix();
    await nextPaint();
    const before = measureLoudness(mix);

    setBusy('⏳ Mastering…'); setReadout('<span class="mm-dim">matching to ' + refFile.name.replace(/[<>&]/g, '') + '…</span>');
    const bits = $('match-bits')?.value === '16' ? 16 : 24;
    const fd = new FormData();
    fd.append('target', new Blob([audioBufferToWav(mix)], { type: 'audio/wav' }), slug(S._title) + '.wav');
    fd.append('reference', refFile, refFile.name);
    const res = await fetch(`/master/match?bits=${bits}`, { method: 'POST', body: fd });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { msg = (await res.json()).detail || msg; } catch (_) {}
      throw new Error(msg);
    }
    let report = {};
    try { report = JSON.parse(res.headers.get('X-Master-Report') || '{}'); } catch (_) {}
    const blob = await res.blob();

    setBusy('⏳ Measuring…'); await nextPaint();
    const mastered = await decodeWav(blob, mix.sampleRate);
    const after = measureLoudness(mastered);

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = slug(S._title) + '_mastered.wav';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    const refL = Number(report.ref_lufs);
    setReadout(
      `<b>Master:</b> ${fmt(before.lufs)} → <b>${fmt(after.lufs)}</b> LUFS · ${fmt(after.truePeakDb)} dBTP` +
      (Number.isFinite(refL) ? ` <span class="mm-dim">(ref ${fmt(refL)})</span>` : ''),
      `Reference: ${refFile.name}\n` +
      `Before: ${fmt(before.lufs)} LUFS / ${fmt(before.truePeakDb)} dBTP\n` +
      `After:  ${fmt(after.lufs)} LUFS / ${fmt(after.truePeakDb)} dBTP (${bits}-bit WAV)\n` +
      (report.gain_db != null ? `Gain ${report.gain_db} dB, EQ up to ±${report.eq_max_db} dB, ceiling ${report.ceiling_db} dBTP\n` : '') +
      (report.width_ref != null ? `Stereo width (side/mid): ${report.width_in} → ${report.width_out} (ref ${report.width_ref})` : ''));
    S._lastMaster = { reference: refFile.name, before, after, report, bits };
  } catch (e) {
    setReadout('<span class="mm-err">master failed</span>', e.message);
    alert('Match master failed: ' + e.message);
  } finally {
    setBusy(null);
  }
}

function init() {
  const btn = $('match-master-btn'), input = $('match-ref-input');
  if (!btn || !input) return;
  btn.addEventListener('click', () => { if (!btn.disabled) input.click(); });
  input.addEventListener('change', () => { const f = input.files?.[0]; input.value = ''; matchMaster(f); });
  // Enable together with Export Mix (i.e. once the song's tracks are loaded).
  const exp = $('export-btn');
  const sync = () => { if (!btn.classList.contains('busy')) btn.disabled = !exp || exp.disabled || !hasTracks(); };
  if (exp) new MutationObserver(sync).observe(exp, { attributes: true, attributeFilter: ['disabled'] });
  sync();
  // Hide if the server can't master (e.g. scipy/soundfile missing).
  fetch('/master-status').then(r => r.ok ? r.json() : null).then(st => {
    if (st && !st.available) { btn.title = 'Mastering unavailable on this server (needs soundfile + scipy)'; btn.style.display = 'none'; }
  }).catch(() => {});
}

window.matchMaster = matchMaster;
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
else init();
