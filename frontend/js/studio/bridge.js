// Looper → Studio bridge (same-origin, cross-window via BroadcastChannel).
// The Studio answers presence pings (so the Looper can grey out its "Send to Studio"
// button when no Studio is open) and receives loop audio as raw Float32 channels,
// rebuilding an AudioBuffer and adding it as an import track.
import { S } from './state.js';
import { addImportedBuffer } from './tracks.js';

const ch = ('BroadcastChannel' in window) ? new BroadcastChannel('waivepulse-bridge') : null;

export function initStudioReceiver() {
  if (!ch) return;
  const announce = () => { if (S._actx) ch.postMessage({ type: 'studio-here' }); };
  ch.onmessage = e => {
    const m = e.data; if (!m) return;
    if (m.type === 'ping') { announce(); return; }       // a Looper is checking if we're here
    if (m.type === 'loop' && S._actx && m.ch && m.ch.length) {
      try {
        const buf = S._actx.createBuffer(m.ch.length, m.length, m.sampleRate || S._actx.sampleRate);
        for (let c = 0; c < m.ch.length; c++) buf.copyToChannel(m.ch[c], c);
        addImportedBuffer(buf, m.name || 'Looper clip');
        flash('Received "' + (m.name || 'loop') + '" from the Looper');
      } catch (err) { console.warn('Looper → Studio import failed:', err); }
    }
  };
  announce();                                            // tell any open Looper we're here
  window.addEventListener('beforeunload', () => { try { ch.postMessage({ type: 'studio-bye' }); } catch {} });
}

function flash(msg) {
  let el = document.getElementById('bridge-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'bridge-toast';
    el.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);' +
      'background:#12303a;border:1px solid #1ab8b8;color:#8cffff;padding:8px 16px;border-radius:8px;' +
      'font-size:12px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.5);transition:opacity .4s;pointer-events:none';
    document.body.appendChild(el);
  }
  el.textContent = msg; el.style.opacity = '1';
  clearTimeout(el._t); el._t = setTimeout(() => { el.style.opacity = '0'; }, 2600);
}
