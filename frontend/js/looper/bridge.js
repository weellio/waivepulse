// Looper side of the Looper → Studio bridge. Pings for an open Studio (heartbeat) so
// the "Send to Studio" buttons can grey out when none is listening, and ships a loop's
// raw audio over a BroadcastChannel when sent.
import { S } from './state.js';
import { setStatus } from './util.js';

const ch = ('BroadcastChannel' in window) ? new BroadcastChannel('waivepulse-bridge') : null;
let lastSeen = 0;
let onChange = () => {};

// A Studio is considered open if it answered a ping within the last ~6 s (we ping
// every 2.5 s, so this never flickers between heartbeats).
export function studioOpen() { return !!ch && (Date.now() - lastSeen) < 6000; }

export function initStudioBridge(refreshCb) {
  onChange = refreshCb || (() => {});
  if (!ch) { onChange(); return; }            // no BroadcastChannel support → stays greyed out
  ch.onmessage = e => {
    const m = e.data; if (!m) return;
    if (m.type === 'studio-here') { lastSeen = Date.now(); onChange(); }
    else if (m.type === 'studio-bye') { lastSeen = 0; onChange(); }
  };
  ch.postMessage({ type: 'ping' });
  setInterval(() => { ch.postMessage({ type: 'ping' }); onChange(); }, 2500);
}

export function sendLoopToStudio(id) {
  const s = S.slots[id];
  if (!s || !s.buffer) { setStatus('That loop is empty — record something first'); return; }
  sendBufferToStudio(s.buffer, 'Loop ' + (id + 1));
}

// Ship any rendered AudioBuffer to the Studio as a new track (used by the Song
// Builder to send the full arrangement or individual stems).
export function sendBufferToStudio(buf, name) {
  if (!buf) return false;
  if (!studioOpen()) { setStatus('Open the Studio in another window first'); return false; }
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c).slice());
  ch.postMessage({ type: 'loop', name: name || 'Looper clip', sampleRate: buf.sampleRate, length: buf.length, ch: chans });
  setStatus('Sent "' + (name || 'clip') + '" to the Studio →');
  return true;
}

export { studioOpen as isStudioOpen };
