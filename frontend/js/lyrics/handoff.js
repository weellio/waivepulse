// Copy to clipboard + send-to-generator handoff via localStorage.

export function copyOutput() {
  const out = document.getElementById('output');
  if (!out.value.trim()) return;
  navigator.clipboard.writeText(out.value).then(() => {
    const t = document.getElementById('copyToast');
    t.classList.add('show'); setTimeout(()=>t.classList.remove('show'), 1400);
  });
}

export function sendToGenerator() {
  const text = document.getElementById('output').value.trim();
  if (!text) {
    document.getElementById('status').className = 'status-line error';
    document.getElementById('status').textContent = 'Nothing to send — generate or paste lyrics first.';
    return;
  }
  localStorage.setItem('waivepulse_pending_lyrics', text);
  window.location.href = '/';
}
