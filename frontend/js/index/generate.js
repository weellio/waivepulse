import { S } from './state.js';
import { getTagsString } from './tags.js';
import { addJobCard, connectSSE, pollJob } from './jobs.js';
import { randomizeSeed } from './ui.js';
import { showToast } from './util.js';

// ── Generate ──────────────────────────────────────────────────────────────────
export async function generate() {
  const lyrics = document.getElementById("lyrics").value.trim();
  const tags   = getTagsString();
  const title  = document.getElementById("title").value.trim() || "Untitled";
  const artist = document.getElementById("artist").value.trim();
  const maxDur = parseInt(document.getElementById("maxDur").value);
  const temp   = parseFloat(document.getElementById("temperature").value);
  const cfg    = parseFloat(document.getElementById("cfgScale").value);
  const instrumental = !!document.getElementById("instrumental")?.checked;
  const takes  = S.takes || 1;
  const topk   = 50;

  if (!lyrics && !instrumental) { alert("Please enter some lyrics first (or tick Instrumental)."); return; }
  if (!tags)   { alert("Please select at least one genre tag."); return; }

  // Locked → send the Seed field (roll one if empty); unlocked → server picks random seeds.
  let seed = null;
  if (S.seedLocked) {
    const seedEl = document.getElementById("seed");
    if (seedEl.value === "") randomizeSeed();
    seed = Math.max(0, Math.min(4294967295, parseInt(seedEl.value, 10) || 0));
    seedEl.value = seed;
  }

  const btn = document.getElementById("btnGenerate");
  btn.disabled = true; btn.textContent = "Sending...";

  try {
    const payload = { lyrics, tags, title, artist, max_duration_sec: maxDur, temperature: temp,
                      cfg_scale: cfg, topk, seed, count: takes, instrumental };
    if (window._variationOf) payload.variation_of = window._variationOf;
    const res = await fetch("/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
    const ids = data.job_ids || (data.job_id ? [data.job_id] : []);
    const createdAt = new Date().toISOString();
    ids.forEach((id, i) => {
      const jl = data.lyrics ?? lyrics, jt = data.tags ?? tags;
      S.jobSettings[id] = { lyrics: jl, tags: jt, title, artist, maxDurationSec: maxDur, temperature: temp, cfgScale: cfg };
      S.jobFull[id] = {
        job_id: id, status: "queued", title, artist, lyrics: jl, tags: jt,
        max_duration_sec: maxDur, temperature: temp, cfg_scale: cfg, topk,
        seed: data.seeds?.[i], instrumental, take: i + 1, takes: ids.length,
        favorite: false, created_at: createdAt,
      };
    });
    // Insert in reverse so Take 1 ends up on top (addJobCard prepends).
    [...ids].reverse().forEach(id => {
      S.activeJobs.add(id);
      addJobCard(id, title, S.jobFull[id].tags, createdAt);
      connectSSE(id);
      pollJob(id);
    });
    // Show the seed that was actually used (unlocked = random pick from the server).
    if (!S.seedLocked && data.seeds?.length) document.getElementById("seed").value = data.seeds[0];
    if (ids.length > 1) showToast(`${ids.length} takes queued`);
  } catch(e) { alert("Error: " + e.message); }

  btn.disabled = false;
  btn.textContent = takes > 1 ? `Generate ${takes} Takes` : "Generate Song";
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
