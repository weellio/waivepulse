import { S } from './state.js';

// ── Card HTML helpers ─────────────────────────────────────────────────────────
export function escHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

export function formatSize(bytes) {
  if (!bytes) return '';
  return bytes > 1048576 ? (bytes / 1048576).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
}

// ── Toast ───────────────────────────────────────────────────────────────────────
export function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(S._toastTimer);
  S._toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}
