import { S, VIZ_LABELS } from './state.js';
import { escHtml, formatSize } from './util.js';
import { attachVizListeners, attachMetaListeners, stopViz } from './viz.js';

// ── Card HTML ─────────────────────────────────────────────────────────────────
export function jobCardHTML(jobId, title, tags, status, message, file, fileSize, createdAt, bpm, key) {
  const timeStr  = createdAt ? new Date(createdAt).toLocaleTimeString() : "";
  const isOpen   = S.openCards.has(jobId);
  const vizStyle = S.vizStyles[jobId] || 'ring';
  const vizLabel = VIZ_LABELS[vizStyle] || '◉ Ring';
  const isActive = status === "queued" || status === "generating";

  const cancelBtn = isActive
    ? `<button class="btn-cancel" onclick="event.stopPropagation();cancelJob('${jobId}')" title="Cancel">Cancel</button>`
    : "";

  const durSpan = (status === "done")
    ? `<span class="job-duration" id="dur-${jobId}"></span>`
    : "";

  const row = `
    <div class="job-row" onclick="toggleCard('${jobId}')">
      <div class="dot dot-${status}"></div>
      <div class="job-row-text">
        <span class="job-title">${escHtml(title)}</span>
        <span class="job-tags">${escHtml(tags)}</span>
      </div>
      ${durSpan}
      <span class="job-time">${timeStr}</span>
      <span class="expand-icon" id="arrow-${jobId}">${isOpen ? "▼" : "▶"}</span>
      ${cancelBtn}
      <button class="btn-delete" onclick="event.stopPropagation();deleteJob('${jobId}')" title="Delete">✕</button>
    </div>`;

  let bodyContent = '';

  if (isActive) {
    const logText = (S.jobLogLines[jobId] || []).slice(-12).join('\n') || (status === "queued" ? "Waiting in queue…" : "Starting…");
    const lmPct   = getLMProgress(jobId);
    const codecPct = getCodecProgress(jobId);
    bodyContent = `
      <div class="progress-phases">
        <div class="phase-row">
          <span class="phase-label" id="lm-label-${jobId}">Language model</span>
          <div class="progress-bar"><div class="progress-fill" id="lm-bar-${jobId}" style="width:${lmPct}%"></div></div>
        </div>
        <div class="phase-row">
          <span class="phase-label" id="codec-label-${jobId}">Audio codec</span>
          <div class="progress-bar"><div class="progress-fill codec" id="codec-bar-${jobId}" style="width:${codecPct}%"></div></div>
        </div>
      </div>
      <pre class="job-log" id="log-${jobId}">${escHtml(logText)}</pre>`;
  } else if (status === "done" && file) {
    const sizeStr = formatSize(fileSize);
    bodyContent = `
      <audio controls preload="metadata"><source src="${file}" type="audio/mpeg"></audio>
      <div class="viz-wrap" ondblclick="launchFullscreen('${jobId}')" title="Double-click for fullscreen">
        <canvas id="viz-${jobId}" class="viz-canvas" width="400" height="260"></canvas>
        <button class="viz-toggle" id="viz-btn-${jobId}" onclick="cycleVizStyle('${jobId}');event.stopPropagation()" title="Cycle visualization style">${vizLabel}</button>
        <button class="viz-fs-btn" onclick="launchFullscreen('${jobId}');event.stopPropagation()" title="Fullscreen (or double-click)">⛶</button>
      </div>
      <div class="card-actions">
        <a class="btn-action" href="${file}" download>⬇ Download</a>
        ${!jobId.startsWith('local_') ? `<button class="btn-action" onclick="loadJobToForm('${jobId}')">↺ Use Settings</button>` : ''}
        ${!jobId.startsWith('local_')
          ? `<a class="btn-action" href="/studio?job=${jobId}" target="_blank">🎛 Studio</a>`
          : `<button class="btn-action" id="studio-btn-${jobId}" onclick="openStudioForLocal('${jobId}')">🎛 Studio</button>`}
      </div>
      <div class="job-meta" id="meta-${jobId}">
        ${sizeStr ? `<span>${sizeStr}</span>` : ''}
        ${bpm  ? `<span class="chip chip-bpm">♩ ${bpm} BPM</span>` : ''}
        ${key  ? `<span class="chip chip-key">♬ ${escHtml(key)}</span>` : ''}
      </div>`;
  } else if (status === "error") {
    bodyContent = `
      <div style="font-size:0.82rem;color:#e05555;padding:8px 0;white-space:pre-wrap">${escHtml(message)}</div>
      ${S.jobSettings[jobId] ? `<div class="card-actions"><button class="btn-action" onclick="loadJobToForm('${jobId}')">↺ Use Settings</button></div>` : ''}`;
  } else if (status === "cancelled") {
    bodyContent = `
      <div style="font-size:0.82rem;color:#666;padding:8px 0">Cancelled</div>
      ${S.jobSettings[jobId] ? `<div class="card-actions"><button class="btn-action" onclick="loadJobToForm('${jobId}')">↺ Use Settings</button></div>` : ''}`;
  }

  return `${row}
    <div class="job-body${isOpen ? " open" : ""}" id="body-${jobId}">
      <div class="job-body-inner">${bodyContent}</div>
    </div>`;
}

// ── Progress state ────────────────────────────────────────────────────────────
export function getLMProgress(jobId)    { return S._lmProgress[jobId]    || 0; }
export function getCodecProgress(jobId) { return S._codecProgress[jobId] || 0; }

// ── SSE ───────────────────────────────────────────────────────────────────────
export function connectSSE(jobId) {
  if (S.sseConns[jobId]) return;
  const es = new EventSource(`/progress/${jobId}`);
  S.sseConns[jobId] = es;
  es.onmessage = (e) => {
    if (e.data === '__done__') { es.close(); delete S.sseConns[jobId]; return; }
    let line;
    try { line = JSON.parse(e.data); } catch { return; }
    handleLogLine(jobId, line);
  };
  es.onerror = () => { es.close(); delete S.sseConns[jobId]; };
}

export function disconnectSSE(jobId) {
  if (S.sseConns[jobId]) { S.sseConns[jobId].close(); delete S.sseConns[jobId]; }
}

export function handleLogLine(jobId, line) {
  if (!S.jobLogLines[jobId]) S.jobLogLines[jobId] = [];
  S.jobLogLines[jobId].push(line);
  if (S.jobLogLines[jobId].length > 50) S.jobLogLines[jobId].splice(0, 20);

  const logEl = document.getElementById(`log-${jobId}`);
  if (logEl) {
    logEl.textContent = S.jobLogLines[jobId].slice(-12).join('\n');
    logEl.scrollTop = logEl.scrollHeight;
  }

  parseLogProgress(jobId, line);
}

export function parseLogProgress(jobId, line) {
  // LM token generation: "Generating tokens:  45%|..."
  const lmMatch = line.match(/(?:token|generating)[^:]*:\s*(\d+)%/i);
  if (lmMatch) {
    const pct = parseInt(lmMatch[1]);
    S._lmProgress[jobId] = pct;
    const bar = document.getElementById(`lm-bar-${jobId}`);
    const lbl = document.getElementById(`lm-label-${jobId}`);
    if (bar) bar.style.width = pct + '%';
    if (lbl) lbl.textContent = `Language model: ${pct}%`;
    return;
  }
  // Codec decode: "6/10 [04:52<03:20, 100.2s/it]" or "codec...6/10"
  const codecMatch = line.match(/(\d+)\/(\d+)/);
  if (codecMatch && /codec|decode|step/i.test(line)) {
    const step = parseInt(codecMatch[1]), total = parseInt(codecMatch[2]);
    if (total > 0) {
      const pct = Math.round((step / total) * 100);
      S._codecProgress[jobId] = pct;
      const bar = document.getElementById(`codec-bar-${jobId}`);
      const lbl = document.getElementById(`codec-label-${jobId}`);
      if (bar) bar.style.width = pct + '%';
      if (lbl) lbl.textContent = `Audio codec: ${step}/${total}`;
    }
  }
}

// ── Job card lifecycle ────────────────────────────────────────────────────────
export function addJobCard(jobId, title, tags, createdAt) {
  S.openCards.add(jobId);
  const list  = document.getElementById("historyList");
  const empty = list.querySelector(".empty-state");
  if (empty) empty.remove();

  const card = document.createElement("div");
  card.className = "job-card active-job";
  card.id = `job-${jobId}`;
  card.innerHTML = jobCardHTML(jobId, title, tags, "queued", "Queued", null, null, createdAt);
  list.insertBefore(card, list.firstChild);
}

export function updateJobCard(jobId, data) {
  const card = document.getElementById(`job-${jobId}`);
  if (!card) return;

  if (data.lyrics) {
    S.jobSettings[jobId] = {
      lyrics: data.lyrics, tags: data.tags, title: data.title,
      maxDurationSec: data.max_duration_sec,
      temperature: data.temperature, cfgScale: data.cfg_scale,
    };
  }

  const done = data.status === "done" || data.status === "error" || data.status === "cancelled";
  card.className = done ? "job-card" : "job-card active-job";

  card.innerHTML = jobCardHTML(jobId, data.title || "Untitled", data.tags || "", data.status, data.message, data.file, data.file_size, data.created_at, data.bpm, data.key);

  if (data.status === "done") {
    setTimeout(() => { attachVizListeners(jobId); attachMetaListeners(jobId); }, 0);
  }
}

export async function deleteJob(jobId) {
  disconnectSSE(jobId);
  stopViz(jobId);
  S.openCards.delete(jobId);
  delete S.jobSettings[jobId];
  delete S.jobLogLines[jobId];
  delete S._lmProgress[jobId];
  delete S._codecProgress[jobId];
  try { await fetch(`/history/${jobId}`, { method: "DELETE" }); } catch(e) {}
  const card = document.getElementById(`job-${jobId}`);
  if (card) card.remove();
  if (!document.querySelector(".job-card")) {
    document.getElementById("historyList").innerHTML =
      '<div class="empty-state">No songs yet — generate your first one!<div class="drag-hint">or drag MP3 files here</div></div>';
  }
}

export async function pollJob(jobId) {
  while (S.activeJobs.has(jobId)) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const res = await fetch(`/status/${jobId}`);
      if (!res.ok) break;
      const data = await res.json();
      updateJobCard(jobId, data);
      if (data.status === "done" || data.status === "error" || data.status === "cancelled") {
        S.activeJobs.delete(jobId);
        disconnectSSE(jobId);
        break;
      }
    } catch(e) { break; }
  }
}

// ── Load history on startup ───────────────────────────────────────────────────
export async function loadHistory() {
  try {
    const res  = await fetch("/history");
    const list_data = await res.json();
    if (!list_data.length) return;
    const list  = document.getElementById("historyList");
    list.innerHTML = "";
    list_data.forEach(j => {
      if (j.lyrics) {
        S.jobSettings[j.job_id] = {
          lyrics: j.lyrics, tags: j.tags, title: j.title,
          maxDurationSec: j.max_duration_sec,
          temperature: j.temperature, cfgScale: j.cfg_scale,
        };
      }
      const card = document.createElement("div");
      const done = j.status === "done" || j.status === "error" || j.status === "cancelled";
      card.className = done ? "job-card" : "job-card active-job";
      card.id = `job-${j.job_id}`;
      card.innerHTML = jobCardHTML(j.job_id, j.title || "Untitled", j.tags || "", j.status, j.message, j.file, j.file_size, j.created_at, j.bpm, j.key);
      list.appendChild(card);
      if (!done) {
        S.openCards.add(j.job_id);
        S.activeJobs.add(j.job_id);
        connectSSE(j.job_id);
        pollJob(j.job_id);
      }
      if (j.status === "done") setTimeout(() => { attachVizListeners(j.job_id); attachMetaListeners(j.job_id); }, 0);
    });
  } catch(e) {}
}
