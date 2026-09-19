// ── Export finishing: loudness target + true-peak ceiling + WAV / MP3 320 ─────
// Shared by the Looper's ⬇ Export and the Song Builder's ⬇ Render Full Track.
// Loudness is BS.1770 integrated LUFS (shared/loudness.js); when a target is set
// the mix is gained to it and a lookahead limiter keeps true peak ≤ −1 dBTP.
import { measureLoudness, normalizeToTarget } from '../shared/loudness.js';
import { audioBufferToMp3 } from '../shared/mp3enc.js';
import { encodePcmWav } from './wavio.js';

export const TP_CEILING = -1;                     // dBTP — safe headroom for lossy encoders
const TARGETS = { off: null, '-14': -14, '-16': -16, '-9': -9 };
export const targetOf = key => (key in TARGETS ? TARGETS[key] : null);

const MINUS = '−';
export const fmtLufs = v => (isFinite(v) ? v.toFixed(1).replace('-', MINUS) : MINUS + '∞');
export const fmtTp   = v => (isFinite(v) ? (v > 0 ? '+' : '') + v.toFixed(1).replace('-', MINUS) : MINUS + '∞');
export const readoutText = r => `${fmtLufs(r.lufs)} LUFS · ${fmtTp(r.truePeakDb)} dBTP`;

const nextPaint = () => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
export const safeName = n => (n || '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');

// buf is modified in place when a target is set. Returns the measurement plus
// the downloaded blob size. opts: { fmt:'wav'|'mp3', targetKey, bits, baseName,
// readoutEl, onStage(text) }
export async function finishExport(buf, opts) {
  const target = targetOf(opts.targetKey || 'off');
  const stage = opts.onStage || (() => {});
  stage('Measuring…'); await nextPaint();
  let res;
  if (target == null) res = measureLoudness(buf);
  else res = normalizeToTarget(buf, target, { ceilingDb: TP_CEILING });

  const el = opts.readoutEl;
  if (el) {
    el.textContent = readoutText(res);
    el.classList.remove('idle');
    el.classList.toggle('hot', target == null && res.truePeakDb > TP_CEILING);
    el.title = target == null
      ? `Measured (no loudness target). Sample peak ${fmtTp(res.samplePeakDb)} dBFS.` + (res.truePeakDb > TP_CEILING ? ' True peak is above −1 dBTP — pick a loudness target to fix it.' : '')
      : `Target ${target} LUFS, ceiling ${TP_CEILING} dBTP. Was ${fmtLufs(res.before.lufs)} LUFS / ${fmtTp(res.before.truePeakDb)} dBTP; gain ${fmtTp(res.gainDb)} dB` +
        (res.limitedDb > 0.05 ? `, limiter up to ${res.limitedDb.toFixed(1)} dB.` : ', no limiting.');
  }

  let blob, ext;
  if (opts.fmt === 'mp3') {
    stage('MP3 0%'); await nextPaint();
    blob = await audioBufferToMp3(buf, 320, p => stage(`MP3 ${Math.round(p * 100)}%`));
    ext = 'mp3';
  } else {
    blob = new Blob([encodePcmWav(buf, opts.bits || 16)], { type: 'audio/wav' });
    ext = 'wav';
  }
  const suffix = target == null ? '' : '_' + String(target).replace('-', 'm') + 'LUFS';
  const name = (safeName(opts.baseName) || 'looper-mix') + suffix + '.' + ext;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  const out = { name, bytes: blob.size, fmt: ext, target, lufs: res.lufs, truePeakDb: res.truePeakDb, samplePeakDb: res.samplePeakDb, gainDb: res.gainDb ?? 0, limitedDb: res.limitedDb ?? 0 };
  window.__looperLastExport = out;                 // read by the page test
  return out;
}
