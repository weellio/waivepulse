// Small shared helpers: URL params, time formatting, loading-overlay control.
export function getParam(k) { return new URLSearchParams(window.location.search).get(k); }

export function fmtTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${Math.floor(s % 60).toString().padStart(2, '0')}`;
}

export function setOverlay(title, msg, prog) {
  document.getElementById('overlay').classList.remove('hidden');
  document.getElementById('overlay-title').textContent = title;
  document.getElementById('overlay-msg').textContent = msg;
  document.getElementById('overlay-err').style.display = 'none';
  const p = document.getElementById('overlay-progress');
  p.style.display = prog ? 'block' : 'none';
  if (prog) document.getElementById('overlay-bar').style.width = '0%';
}

export function showError(msg) {
  document.getElementById('overlay').classList.remove('hidden');
  document.querySelector('#overlay .spinner').style.display = 'none';
  document.getElementById('overlay-title').textContent = 'Error';
  document.getElementById('overlay-msg').textContent = '';
  document.getElementById('overlay-err').style.display = 'block';
  document.getElementById('overlay-err').textContent = msg;
  document.getElementById('overlay-progress').style.display = 'none';
}

export function hideOverlay() { document.getElementById('overlay').classList.add('hidden'); }
