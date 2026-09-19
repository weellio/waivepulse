// Streaming lyric generation + generating-state UI.
import { S } from './state.js';
import { scheduleRefresh } from './editor.js';

function _setGenerating(on) {
  const btn  = document.getElementById('btnGen');
  const bar  = document.getElementById('progressBar');
  const out  = document.getElementById('output');
  btn.disabled = on;
  btn.classList.toggle('generating', on);
  btn.innerHTML = on ? '<span class="pulse-dot"></span>Generating…' : 'Generate Lyrics';
  bar.classList.toggle('show', on);
  out.classList.toggle('streaming', on);
}

export async function generateLyrics() {
  const status = document.getElementById('status');
  const out    = document.getElementById('output');
  const body = {
    theme:     document.getElementById('theme').value.trim(),
    structure: document.getElementById('structure').value,
    tone:      S.selectedTone,
    rhyme:     document.getElementById('rhyme').value,
    style:     document.getElementById('style').value.trim(),
    model:     document.getElementById('model').value,
    temperature: parseFloat(document.getElementById('temp').value),
  };
  if (!body.theme && !body.style) {
    status.className = 'status-line error';
    status.textContent = 'Add a theme/topic or a style reference first.';
    return;
  }
  _setGenerating(true);
  status.className = 'status-line';
  status.textContent = `Loading ${body.model}… first tokens will appear in a moment.`;
  out.value = '';
  scheduleRefresh();

  let tokenCount = 0;
  const startedAt = performance.now();
  try {
    const r = await fetch('/lyrics/suggest/stream', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const e = await r.json().catch(()=>({detail:'Request failed'}));
      throw new Error(e.detail || `HTTP ${r.status}`);
    }
    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, {stream: true});
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const raw of lines) {
        if (!raw.startsWith('data: ')) continue;
        const payload = raw.slice(6);
        if (payload === '__done__') { reader.cancel(); break; }
        let parsed;
        try { parsed = JSON.parse(payload); } catch { continue; }
        if (parsed && typeof parsed === 'object' && parsed.__error__) {
          throw new Error(parsed.__error__);
        }
        if (typeof parsed === 'string') {
          out.value += parsed;
          out.scrollTop = out.scrollHeight;
          scheduleRefresh();
          tokenCount++;
          if (tokenCount === 1) {
            status.className = 'status-line';
            status.textContent = `Streaming from ${body.model}…`;
          }
        }
      }
    }
    const elapsed = ((performance.now() - startedAt) / 1000).toFixed(1);
    status.className = 'status-line ok';
    status.textContent = out.value.trim()
      ? `Done in ${elapsed}s — ${tokenCount} tokens from ${body.model}.`
      : '(no output — try a different theme or model)';
  } catch (e) {
    status.className = 'status-line error';
    status.textContent = 'Error: ' + e.message;
  } finally {
    _setGenerating(false);
    scheduleRefresh();
  }
}
