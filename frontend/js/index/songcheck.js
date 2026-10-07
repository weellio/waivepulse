// Song Check — ask the server what is wrong with a finished render and show the fix.
//
// The point of the panel is the last line of each finding: the control that fixes it and the
// page it lives on. A diagnosis with no destination is just bad news.
//
// Exposes window.runSongCheck(jobId) for the card button in jobs.js.

const SEV = {
  high:   { label: 'will hear it', cls: 'sc-high' },
  medium: { label: 'worth fixing', cls: 'sc-med'  },
  note:   { label: 'for info',     cls: 'sc-note' },
};

const esc = s => String(s ?? '').replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// `btn` is the button that was actually clicked, and it matters: a finished song is rendered
// twice (the jobs strip and the library list), both cards carry id="job-<id>", and
// getElementById returns the FIRST one. Anchoring by id dropped the panel into whichever copy
// came first in the DOM — usually the collapsed one — so it rendered 223px tall inside a 10px
// accordion row, 700px away from the button the user pressed.
function panelFor(jobId, btn) {
  const card = (btn && btn.closest('.job-card'))
    || document.getElementById(`job-${jobId}`) || document.getElementById(jobId);
  let el = card ? card.querySelector('.songcheck-panel') : null;
  if (el) return el;
  const anchor = card ? card.querySelector('.card-actions') : null;
  el = document.createElement('div');
  // class, not id: the same job can be on the page twice, and two elements sharing an id is
  // what caused the misplacement above
  el.className = 'songcheck-panel';
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(el, anchor.nextSibling);
  else if (card) card.appendChild(el);
  else document.body.appendChild(el);
  return el;
}

function render(el, d) {
  if (d.error) {
    el.innerHTML = `<div class="sc-head">Song Check</div>
      <div class="sc-empty">Could not analyse this one: ${esc(d.error)}</div>`;
    return;
  }
  const bits = [];
  bits.push(`<div class="sc-head">Song Check
    <span class="sc-sub">${d.duration_s}s · ${d.integrated_lufs ?? '—'} LUFS · peak ${d.peak_dbfs} dBFS${
      d.used_stems ? ' · using your stems' : ''}</span>
    <button class="sc-close" onclick="this.closest('.songcheck-panel').remove()">✕</button>
  </div>`);

  if (!d.findings.length) {
    bits.push(`<div class="sc-empty">Nothing worth flagging. Loudness is steady, it ends
      cleanly, and nothing is over the ceiling.</div>`);
  } else {
    for (const f of d.findings) {
      const s = SEV[f.severity] || SEV.note;
      bits.push(`<div class="sc-item ${s.cls}">
        <div class="sc-title">${esc(f.title)}<span class="sc-pill">${s.label}</span></div>
        <div class="sc-detail">${esc(f.detail)}</div>
        <div class="sc-fix"><b>Fix:</b> ${esc(f.fix)} <span class="sc-where">${esc(f.where)}</span></div>
      </div>`);
    }
  }
  if (!d.used_stems) {
    bits.push(`<div class="sc-foot">Separate this song in Studio and run the check again to
      also test for instrumental dropouts under the vocal — that one needs stems to be honest.</div>`);
  }
  el.innerHTML = bits.join('');
}

export async function runSongCheck(jobId, btn) {
  const el = panelFor(jobId, btn);
  // its own class, not sc-empty: the loading state and the "nothing found" state must be
  // distinguishable, or a waiting panel looks exactly like a clean result
  el.innerHTML = `<div class="sc-head">Song Check</div><div class="sc-loading">Analysing…</div>`;
  try {
    const r = await fetch(`/songcheck/${encodeURIComponent(jobId)}`);
    const d = await r.json();
    if (!r.ok) throw new Error(d.detail || `HTTP ${r.status}`);
    d.job_id = jobId;
    render(el, d);
  } catch (e) {
    render(el, { error: e.message, job_id: jobId, findings: [] });
  }
}

window.runSongCheck = runSongCheck;
