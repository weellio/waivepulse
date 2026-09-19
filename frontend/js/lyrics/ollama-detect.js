// Ollama detection: status badge, model dropdown population, and install guide.
import { S } from './state.js';

const INSTALL_GUIDE_FULL = `
  <div class="install-title">⚡ Ollama needed for lyric generation</div>
  <div class="install-step">
    <span class="step-num">1</span>
    <div>
      <b>Install Ollama</b> — pick whichever works for your setup:
      <div class="install-options">
        <div class="install-os"><span>Windows</span><code>winget install Ollama.Ollama</code></div>
        <div class="install-os"><span>Linux</span><code>curl -fsSL https://ollama.com/install.sh | sh</code></div>
        <div class="install-os"><span>or</span><a href="https://ollama.com/download" target="_blank" rel="noopener">Download the installer from ollama.com →</a></div>
      </div>
    </div>
  </div>
  <div class="install-step">
    <span class="step-num">2</span>
    <div>
      <b>Pull a lyric model</b> — open a terminal and run:
      <div style="margin-top:5px"><code>ollama pull llama3.1:8b</code></div>
      <span class="install-hint">~5 GB download. Smaller alternative if you're tight on disk or VRAM: <code>ollama pull llama3.2:3b</code> (~2 GB).</span>
    </div>
  </div>
  <div class="install-step">
    <span class="step-num">3</span>
    <div><b>Refresh this page.</b> The badge in the top right turns green when Ollama is detected.</div>
  </div>
`;

const INSTALL_GUIDE_MODELS_ONLY = `
  <div class="install-title">⚡ Ollama is running — but no models are installed</div>
  <div class="install-step">
    <span class="step-num">1</span>
    <div>
      <b>Pull a lyric model</b> — open a terminal and run:
      <div style="margin-top:5px"><code>ollama pull llama3.1:8b</code></div>
      <span class="install-hint">~5 GB download. Smaller alternative if you're tight on disk or VRAM: <code>ollama pull llama3.2:3b</code> (~2 GB).</span>
    </div>
  </div>
  <div class="install-step">
    <span class="step-num">2</span>
    <div><b>Refresh this page.</b> The model will appear in the dropdown below.</div>
  </div>
`;

export async function checkOllama() {
  const badge = document.getElementById('ollamaBadge');
  const modelSel = document.getElementById('model');
  const btn = document.getElementById('btnGen');
  const guide = document.getElementById('installGuide');
  const status = document.getElementById('status');
  try {
    const r = await fetch('/ollama-status');
    const d = await r.json();
    if (!d.available) {
      badge.textContent = '✗ Ollama not installed';
      badge.classList.remove('ok'); badge.classList.add('err');
      modelSel.innerHTML = '<option>— Ollama required —</option>';
      btn.disabled = true;
      guide.innerHTML = INSTALL_GUIDE_FULL;
      guide.classList.add('show');
      status.className = 'status-line';
      status.textContent = '';
      return;
    }
    if (!d.models.length) {
      badge.textContent = '⚠ Ollama running — 0 models';
      badge.classList.add('err');
      modelSel.innerHTML = '<option>— install a model —</option>';
      btn.disabled = true;
      guide.innerHTML = INSTALL_GUIDE_MODELS_ONLY;
      guide.classList.add('show');
      status.className = 'status-line';
      status.textContent = '';
      return;
    }
    badge.textContent = `✓ Ollama: ${d.models.length} model${d.models.length>1?'s':''}`;
    badge.classList.add('ok');
    modelSel.innerHTML = d.models.map(m => `<option value="${m}">${m}</option>`).join('');
    const def = d.models.includes(S.PREFERRED_MODEL) ? S.PREFERRED_MODEL : d.models[0];
    modelSel.value = def;
    btn.disabled = false;
    guide.classList.remove('show');
    guide.innerHTML = '';
  } catch (e) {
    badge.textContent = '✗ Status check failed';
    badge.classList.add('err');
    btn.disabled = true;
    guide.innerHTML = `<div class="install-title">⚠ Could not check Ollama status</div>
      <div class="install-step"><div>The WAIvePulse backend didn't respond to the status check. Make sure the server is running and try refreshing.</div></div>`;
    guide.classList.add('show');
  }
}
