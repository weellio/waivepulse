import { S } from './state.js';
import { getTagsString } from './tags.js';
import { addJobCard, connectSSE, pollJob } from './jobs.js';

// ── Generate ──────────────────────────────────────────────────────────────────
export async function generate() {
  const lyrics = document.getElementById("lyrics").value.trim();
  const tags   = getTagsString();
  const title  = document.getElementById("title").value.trim() || "Untitled";
  const artist = document.getElementById("artist").value.trim();
  const maxDur = parseInt(document.getElementById("maxDur").value);
  const temp   = parseFloat(document.getElementById("temperature").value);
  const cfg    = parseFloat(document.getElementById("cfgScale").value);

  if (!lyrics) { alert("Please enter some lyrics first."); return; }
  if (!tags)   { alert("Please select at least one genre tag."); return; }

  const btn = document.getElementById("btnGenerate");
  btn.disabled = true; btn.textContent = "Sending...";

  try {
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lyrics, tags, title, artist, max_duration_sec: maxDur, temperature: temp, cfg_scale: cfg, topk: 50 })
    });
    const data = await res.json();
    if (data.job_id) {
      S.jobSettings[data.job_id] = { lyrics, tags, title, artist, maxDurationSec: maxDur, temperature: temp, cfgScale: cfg };
      S.activeJobs.add(data.job_id);
      addJobCard(data.job_id, title, tags, new Date().toISOString());
      connectSSE(data.job_id);
      pollJob(data.job_id);
    }
  } catch(e) { alert("Error: " + e.message); }

  btn.disabled = false; btn.textContent = "Generate Song";
}

// ── Cancel ────────────────────────────────────────────────────────────────────
export async function cancelJob(jobId) {
  try {
    await fetch(`/cancel/${jobId}`, { method: "POST" });
  } catch(e) {}
}

// ── Model status ──────────────────────────────────────────────────────────────
export async function checkModelStatus() {
  try {
    const res  = await fetch("/model-status");
    const data = await res.json();
    const badge = document.getElementById("modelBadge");
    const btn   = document.getElementById("btnGenerate");
    if (data.ready && data.gpu && !data.gpu.available) {
      badge.textContent = "No CUDA GPU — generation needs one (Looper/Studio still work)";
      badge.style.color = "#f5a623"; badge.style.borderColor = "#3a3020"; badge.style.background = "#1e1a0e";
      btn.disabled = true; btn.textContent = "Generation needs an NVIDIA GPU";
    } else if (data.ready) {
      badge.textContent = "Models ready";
      badge.style.color = "#4caf7d"; badge.style.borderColor = "#2a4a3a"; badge.style.background = "#0e2a1e";
    } else if (data.incomplete_files > 0) {
      badge.textContent = `Downloading models (${data.incomplete_files} files pending)`;
      badge.style.color = "#f5a623"; badge.style.borderColor = "#3a3020"; badge.style.background = "#1e1a0e";
      btn.disabled = true; btn.textContent = "Waiting for models...";
      setTimeout(checkModelStatus, 10000);
    } else {
      badge.textContent = "Models missing — run download_models.py";
      badge.style.color = "#e05555"; badge.style.borderColor = "#3a2020"; badge.style.background = "#1e0e0e";
      btn.disabled = true;
    }
  } catch(e) {}
}
