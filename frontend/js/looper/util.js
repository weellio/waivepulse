// ── Helpers ───────────────────────────────────────────────────────────────────
export function fmtSec(s) {
  return Math.floor(s) + '.' + Math.floor((s % 1) * 10) + 's';
}
export function setStatus(msg) {
  document.getElementById('statusMsg').textContent = msg;
}
