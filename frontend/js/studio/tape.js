// Open a folder of multitrack tape transfers in the Studio.
//
// Everything else in the Studio starts from a song the app generated and then separated:
// ?job= runs Demucs, ?sep= loads the stems it produced. A tape session has no generated song
// and needs no separation — the tracks were already separate when they were recorded, which
// is the whole point of a multitrack tape. So this is a third boot path: the tracks load
// straight in as Studio tracks, in the order they sit on the reel.
//
// The audio is the server's 320 kbps preview, not the transfer. Eight full-resolution tracks
// decoded into AudioBuffers is most of a gigabyte of memory and the browser would have to
// download every byte first. Repairs, measurements and exports all run server-side on the
// originals, so what the Studio is for here is listening, balancing and arranging.

import { S } from './state.js';
import { setOverlay, showError, hideOverlay } from './util.js';
import { ensureAudioEngine, finishUI } from './boot.js';
import { addImportedBuffer } from './tracks.js';
import { updateAudioInfo } from './pitch.js';

export async function bootTape(folder) {
  try {
    setOverlay('Reading the tape session…', folder, true);
    const r = await fetch(`/tape/tracks?folder=${encodeURIComponent(folder)}`);
    if (!r.ok) {
      const e = await r.json().catch(() => ({}));
      throw new Error(e.detail || `Could not open that folder (${r.status})`);
    }
    const data = await r.json();
    const list = (data.tracks || []).filter(t => t.url);
    if (!list.length) throw new Error('No readable audio files in that folder.');

    S._title = data.title || 'Tape session';
    S._tapeFolder = data.folder;
    document.getElementById('song-title').textContent = S._title;

    await ensureAudioEngine();

    let loaded = 0;
    for (const t of list) {
      setOverlay('Loading the tape…', `${t.name} (${loaded + 1} of ${list.length})`, true);
      try {
        const res = await fetch(t.url);
        const buf = await res.arrayBuffer();
        const abuf = await S._actx.decodeAudioData(buf);
        if (abuf.duration > S._dur) S._dur = abuf.duration;
        // Strip the extension: "03_keys.wav" is a filename, "03_keys" is a track name.
        addImportedBuffer(abuf, t.name.replace(/\.[^.]+$/, ''));
      } catch (err) {
        console.warn(`Could not load ${t.name}:`, err);
      }
      loaded++;
      const bar = document.getElementById('overlay-bar');
      if (bar) bar.style.width = Math.round(loaded / list.length * 100) + '%';
    }

    if (!Object.keys(S.tracks).length) {
      showError('None of the tracks in that folder could be decoded.');
      return;
    }

    updateAudioInfo();
    finishUI();
    hideOverlay();
  } catch (e) {
    showError(e.message);
  }
}
