"""ACE-Step 1.5 — WAIvePulse's second generation engine.

WHY A SECOND ENGINE
-------------------
HeartMuLa-oss-3B (the engine behind the Generate page) physically cannot edit an existing
song: `src/heartlib/pipelines/music_generation.py` raises
`NotImplementedError("ref_audio is not supported yet")` and injects a zero MuQ embedding on
every run, and its decoder is strictly left-to-right autoregressive, so there is no way to
regenerate the middle of a track. ACE-Step 1.5 (MIT, code *and* weights) is a masked
diffusion transformer, so a time span can be masked and re-denoised in place.

HOW IT RUNS
-----------
Out of process. ACE-Step needs Python >= 3.11 and torch 2.7.1+cu128; WAIvePulse runs on
F:\\HeartMuLa\\venv, whose torch/numba pinning is load-bearing for the whole app. So
ACE-Step gets its own venv on G: and we exchange a JSON job file for newline-delimited JSON
events. The GPU is released when the worker process exits — there is no resident model.

WHAT THE MODEL ACTUALLY DOES (read this before changing the UI)
---------------------------------------------------------------
Repaint is *prompt-conditioned regeneration*, not instruction following. It does not know
where "the chorus" is and it does not transform what is already there: it throws the span
away and redraws it from a text description, conditioned on the surrounding audio. So the
caller must hand it a description of the desired result, and the honest UI label is
"regenerate this section from a description".

Two gotchas confirmed by reading the upstream source, not by guessing:
  * `chunk_mask_mode` MUST be "explicit". The default "auto" overwrites the time mask with
    2.0 and regenerates the whole song (upstream issue #646).
  * The model returns a FULL-LENGTH track. We never trust it outside the window — we take
    only the selected span and splice it back ourselves.

THE SEAM IS OURS
----------------
`seam_report()` reproduces, sample for sample, what the browser's Splice path will produce,
then measures the two boundaries for a level jump and a waveform discontinuity. The numbers
in the UI are measured on the audio the user will actually hear, not on the model's output.
"""

from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable, Optional

# ── Layout ────────────────────────────────────────────────────────────────────
# Everything lives on G: on purpose. C: has about 11 GB free on this machine and the
# weights alone are bigger than that.
ACE_ROOT = Path(os.environ.get("WP_ACESTEP_ROOT") or r"G:\acestep")
ACE_REPO = Path(os.environ.get("WP_ACESTEP_REPO") or (ACE_ROOT / "repo"))
ACE_VENV_PY = Path(os.environ.get("WP_ACESTEP_PYTHON") or (ACE_ROOT / "venv" / "Scripts" / "python.exe"))
ACE_CKPT = Path(os.environ.get("ACESTEP_CHECKPOINTS_DIR") or (ACE_ROOT / "checkpoints"))
WORKER = Path(__file__).with_name("acestep_worker.py")

BACKEND_DIR = Path(__file__).resolve().parent.parent
PROJECT_DIR = BACKEND_DIR.parent
OUTPUTS_DIR = PROJECT_DIR / "outputs"
WORK_DIR = OUTPUTS_DIR / "acestep"

# MEASURED on an RTX 3060 12 GB, repainting 12 s of a 134 s song: torch reserved a peak of
# 9148 MB and the whole machine peaked at 11771 MB of 12288. The hog is not the 2B DiT
# (~4.7 GB) but the VAE decode, which runs over the ENTIRE song, not just the window — so
# the requirement scales with song length, not with how much you selected. 9.2 GB is the
# honest floor; anything less and the decode falls back to CPU or dies.
MIN_FREE_VRAM_MB = int(os.environ.get("WP_ACESTEP_MIN_VRAM_MB") or 9200)
GIT_URL = "https://github.com/ace-step/ACE-Step-1.5.git"

_CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


# ── Small helpers ─────────────────────────────────────────────────────────────
def _noop(_msg):
    pass


def _safe(log):
    """Never let a logging callback kill a running job.

    Worker output carries progress-bar glyphs; a caller printing to a cp1252 console
    raises UnicodeEncodeError, and losing a 20-minute GPU job to that would be absurd.
    """
    def wrapped(msg):
        try:
            log(msg)
        except Exception:
            try:
                log(str(msg).encode("ascii", "replace").decode("ascii"))
            except Exception:
                pass
    return wrapped


def _env():
    """Environment for the worker: its own venv, weights on G:, HF cache off C:."""
    env = dict(os.environ)
    env.pop("PIP_TARGET", None)       # this shell's PIP_TARGET hijacks installs
    env.pop("PYTHONPATH", None)       # do not leak the app venv's site-packages
    env["ACESTEP_CHECKPOINTS_DIR"] = str(ACE_CKPT)
    env.setdefault("HF_HOME", r"G:\cache\huggingface")
    env["PYTHONUNBUFFERED"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["TOKENIZERS_PARALLELISM"] = "false"
    return env


def nvidia_vram():
    """(free_mb, total_mb) from nvidia-smi, or (None, None) if it cannot be read."""
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=memory.free,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=12, creationflags=_CREATE_NO_WINDOW,
        )
        if out.returncode != 0:
            return None, None
        free, total = out.stdout.strip().splitlines()[0].split(",")
        return int(free.strip()), int(total.strip())
    except Exception:
        return None, None


def release_ollama(log=_noop):
    """Evict every model Ollama is holding in VRAM.

    A separation crashed on this machine because Ollama sat on 8 GB of a 12 GB card with
    OLLAMA_KEEP_ALIVE=-1. Ollama reloads on the next request in a few seconds, so this is
    cheap insurance, not a sacrifice.
    """
    freed = []
    try:
        with urllib.request.urlopen("http://127.0.0.1:11434/api/ps", timeout=5) as r:
            models = (json.loads(r.read().decode("utf-8")) or {}).get("models") or []
    except Exception:
        return freed
    for m in models:
        name = m.get("model") or m.get("name")
        if not name:
            continue
        try:
            body = json.dumps({"model": name, "prompt": "", "keep_alive": 0}).encode("utf-8")
            req = urllib.request.Request(
                "http://127.0.0.1:11434/api/generate", data=body,
                headers={"Content-Type": "application/json"},
            )
            urllib.request.urlopen(req, timeout=30).read()
            freed.append(name)
            log(f"Freed VRAM held by Ollama model {name}")
        except Exception:
            pass
    if freed:
        time.sleep(2.0)
    return freed


# ── Availability ──────────────────────────────────────────────────────────────
_weights_bytes_cache: tuple[float, int] | None = None


def weights_bytes(max_age_s: float = 60.0) -> int:
    """Total size of the checkpoints directory, cached.

    /acestep/status calls this, and walking ~9.4 GB of weights means thousands of stat()
    calls — far too expensive to repeat on every poll. The number only changes during a
    download, so a short cache is plenty.
    """
    global _weights_bytes_cache
    now = time.time()
    if _weights_bytes_cache and now - _weights_bytes_cache[0] < max_age_s:
        return _weights_bytes_cache[1]
    total = 0
    try:
        for p in ACE_CKPT.rglob("*"):
            if p.is_file():
                total += p.stat().st_size
    except Exception:
        pass
    _weights_bytes_cache = (now, total)
    return total


def weights_present() -> bool:
    """Mirror upstream's check: every main component holds a weights file."""
    components = ("acestep-v15-turbo", "vae", "Qwen3-Embedding-0.6B", "acestep-5Hz-lm-1.7B")
    names = ("model.safetensors", "model.safetensors.index.json",
             "diffusion_pytorch_model.safetensors", "diffusion_pytorch_model.safetensors.index.json",
             "pytorch_model.bin", "pytorch_model.bin.index.json")
    for c in components:
        d = ACE_CKPT / c
        if not d.is_dir() or not any((d / n).exists() for n in names):
            return False
    return True


def available(check_vram: bool = True) -> tuple[bool, str]:
    """(usable, plain-words reason). Never raises.

    `check_vram=False` answers "is ACE-Step installed and ready in principle". Callers that
    are about to start a job pass False here and let `repaint()`/`cover()` do the VRAM check
    *after* they have evicted whatever Ollama is holding — otherwise a resident 5 GB lyric
    model makes us refuse work we could actually do.
    """
    if not ACE_REPO.is_dir() or not (ACE_REPO / "acestep").is_dir():
        return False, "ACE-Step is not downloaded yet."
    if not ACE_VENV_PY.exists():
        return False, "ACE-Step's Python environment is not set up yet."
    if not weights_present():
        return False, "ACE-Step is installed but its model weights have not finished downloading."
    free, total = nvidia_vram()
    if total is None:
        return False, "No NVIDIA GPU could be found. ACE-Step needs one."
    if check_vram and free is not None and free < MIN_FREE_VRAM_MB:
        return False, (f"Only {free} MB of graphics memory is free and about {MIN_FREE_VRAM_MB} MB "
                       "is needed. Close anything else using the GPU and try again.")
    return True, "Ready."


# ── Worker plumbing ───────────────────────────────────────────────────────────
class AceStepError(RuntimeError):
    pass


_gpu_lock = threading.Lock()


def _run_worker(job: dict, log: Callable[[str], None] = _noop, timeout: int = 3 * 3600) -> dict:
    """Run one worker task to completion. Returns the `result` event payload."""
    if not ACE_VENV_PY.exists():
        raise AceStepError("ACE-Step's Python environment is missing. Install ACE-Step first.")
    log = _safe(log)
    job = dict(job)
    job.setdefault("repo", str(ACE_REPO))
    job.setdefault("checkpoints", str(ACE_CKPT))
    job.setdefault("hf_home", _env().get("HF_HOME"))

    tmpdir = Path(tempfile.mkdtemp(prefix="acestep_job_"))
    job_file = tmpdir / "job.json"
    job_file.write_text(json.dumps(job), encoding="utf-8")

    result: Optional[dict] = None
    error: Optional[dict] = None
    try:
        proc = subprocess.Popen(
            [str(ACE_VENV_PY), "-u", str(WORKER), str(job_file)],
            cwd=str(ACE_REPO),
            env=_env(),
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=_CREATE_NO_WINDOW,
        )
    except Exception as e:
        shutil.rmtree(tmpdir, ignore_errors=True)
        raise AceStepError(f"Could not start the ACE-Step process: {e}")

    deadline = time.time() + timeout
    try:
        assert proc.stdout is not None
        for raw in proc.stdout:
            line = raw.rstrip("\r\n")
            if not line.strip():
                continue
            if time.time() > deadline:
                proc.kill()
                raise AceStepError("ACE-Step took too long and was stopped.")
            if line.startswith("{"):
                try:
                    msg = json.loads(line)
                except Exception:
                    log(line)
                    continue
                ev = msg.get("ev")
                if ev == "log":
                    log(msg.get("msg", ""))
                elif ev == "result":
                    result = {k: v for k, v in msg.items() if k != "ev"}
                elif ev == "error":
                    error = msg
                    log(msg.get("msg", "failed"))
                else:
                    log(line)
            else:
                log(line)
        proc.wait(timeout=60)
    finally:
        if proc.poll() is None:
            try:
                proc.kill()
                proc.wait(timeout=30)
            except Exception:
                pass
        shutil.rmtree(tmpdir, ignore_errors=True)

    if error is not None:
        raise AceStepError(error.get("msg") or "ACE-Step failed.")
    if result is None:
        raise AceStepError(
            f"ACE-Step exited with code {proc.returncode} without producing a result. "
            "The log above has the details."
        )
    return result


def probe(log: Callable[[str], None] = _noop) -> dict:
    """Ask the worker what it can see: torch build, GPU, weights."""
    try:
        return _run_worker({"task": "probe", "out_dir": str(WORK_DIR)}, log, timeout=300)
    except Exception as e:
        return {"error": str(e)}


# ── One-time install ──────────────────────────────────────────────────────────
_UV = ACE_ROOT / "uv" / "uv.exe"

_CORE_DEPS = [
    "safetensors==0.7.0", "transformers>=4.51.0,<4.58.0", "diffusers>=0.37.0",
    "scipy>=1.10.1", "soundfile>=0.13.1", "loguru>=0.7.3", "einops>=0.8.1",
    "accelerate>=1.12.0", "numba>=0.61", "vector-quantize-pytorch>=1.27.15",
    "torchcodec>=0.9.1", "torchao>=0.16.0,<0.17.0", "toml", "modelscope",
    "matplotlib>=3.7.5", "xxhash", "diskcache", "typer-slim>=0.21.1",
    "pytorch-wavelets>=1.3.0", "pywavelets>=1.9.0", "huggingface_hub",
]


def _sh(cmd, log, cwd=None, timeout=4 * 3600):
    log = _safe(log)
    log("$ " + " ".join(str(c) for c in cmd))
    proc = subprocess.Popen(
        [str(c) for c in cmd], cwd=str(cwd) if cwd else None, env=_env(),
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        encoding="utf-8", errors="replace", bufsize=1, creationflags=_CREATE_NO_WINDOW,
    )
    deadline = time.time() + timeout
    assert proc.stdout is not None
    for line in proc.stdout:
        log(line.rstrip())
        if time.time() > deadline:
            proc.kill()
            raise AceStepError("a step of the install took too long and was stopped")
    proc.wait(timeout=120)
    if proc.returncode != 0:
        raise AceStepError(f"install step failed (exit {proc.returncode}): {' '.join(str(c) for c in cmd)}")


def install(log: Callable[[str], None] = _noop, skip_weights: bool = False):
    """One-time setup. Safe to re-run: every step is skipped if it is already done."""
    ACE_ROOT.mkdir(parents=True, exist_ok=True)
    WORK_DIR.mkdir(parents=True, exist_ok=True)

    # 1. uv — gives us a Python 3.11 without touching the system Python (3.10 here,
    #    and ACE-Step needs >= 3.11) and without installing anything on C:.
    if not _UV.exists():
        log("Step 1/5 — fetching uv (the installer that will provide Python 3.11)…")
        _UV.parent.mkdir(parents=True, exist_ok=True)
        zip_path = ACE_ROOT / "dl" / "uv.zip"
        zip_path.parent.mkdir(parents=True, exist_ok=True)
        url = "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip"
        urllib.request.urlretrieve(url, zip_path)
        import zipfile
        with zipfile.ZipFile(zip_path) as zf:
            zf.extractall(_UV.parent)
        log("uv ready.")
    else:
        log("Step 1/5 — uv is already here.")

    # 2. the source
    if not (ACE_REPO / "acestep").is_dir():
        log("Step 2/5 — downloading the ACE-Step 1.5 source (about 30 MB)…")
        _sh(["git", "clone", "--depth", "1", GIT_URL, str(ACE_REPO)], log, timeout=1800)
    else:
        log("Step 2/5 — the ACE-Step source is already here.")

    # 3. a private Python 3.11
    if not ACE_VENV_PY.exists():
        log("Step 3/5 — setting up a private Python 3.11 (your main environment is left alone)…")
        env2 = _env()
        env2["UV_PYTHON_INSTALL_DIR"] = str(ACE_ROOT / "pythons")
        env2["UV_CACHE_DIR"] = str(ACE_ROOT / "uvcache")
        _sh([_UV, "python", "install", "3.11"], log, timeout=1800)
        _sh([_UV, "venv", "--python", "3.11", str(ACE_VENV_PY.parent.parent)], log, timeout=1800)
    else:
        log("Step 3/5 — the ACE-Step Python environment is already here.")

    # 4. dependencies (about 7 GB — torch for CUDA 12.8 is most of it)
    probe_now = probe(_noop)
    if probe_now.get("torch") and not probe_now.get("acestep_import_error"):
        log("Step 4/5 — the ACE-Step libraries are already installed.")
    else:
        log("Step 4/5 — installing the ACE-Step libraries, about 6 GB. This is the slow part.")
        _sh([_UV, "pip", "install", "--python", str(ACE_VENV_PY),
             "--extra-index-url", "https://download.pytorch.org/whl/cu128",
             "torch==2.7.1+cu128", "torchaudio==2.7.1+cu128", "torchvision==0.22.1+cu128"],
            log, timeout=4 * 3600)
        _sh([_UV, "pip", "install", "--python", str(ACE_VENV_PY), *_CORE_DEPS], log, timeout=2 * 3600)
        log("Libraries installed.")

    # 5. weights
    if skip_weights:
        log("Step 5/5 — skipping the model download as asked.")
    elif weights_present():
        log(f"Step 5/5 — the model weights are already on disk ({weights_bytes() / 2**30:.1f} GB).")
    else:
        log("Step 5/5 — downloading the model weights. One time, and it is big.")
        ACE_CKPT.mkdir(parents=True, exist_ok=True)
        _run_worker({"task": "download", "out_dir": str(WORK_DIR)}, log, timeout=8 * 3600)
        log(f"Weights downloaded ({weights_bytes(max_age_s=0) / 2**30:.1f} GB).")

    ok, reason = available()
    log("ACE-Step is ready." if ok else f"Install finished but ACE-Step is not usable yet: {reason}")
    return ok, reason


# ── Audio helpers (run in the WAIvePulse process; numpy/soundfile/scipy live here) ──
def _np():
    import numpy as np
    return np


def read_audio(path, target_sr: Optional[int] = None):
    """(float32 [n, ch], sr). soundfile first, ffmpeg as the fallback decoder."""
    np = _np()
    import soundfile as sf

    data = None
    try:
        data, sr = sf.read(str(path), dtype="float32", always_2d=True)
    except Exception:
        data = None
    if data is None:
        tmp = Path(tempfile.mkdtemp(prefix="ace_dec_")) / "d.wav"
        try:
            subprocess.run(["ffmpeg", "-nostdin", "-y", "-i", str(path), str(tmp)],
                           capture_output=True, timeout=600, creationflags=_CREATE_NO_WINDOW)
            data, sr = sf.read(str(tmp), dtype="float32", always_2d=True)
        finally:
            shutil.rmtree(tmp.parent, ignore_errors=True)
    if target_sr and sr != target_sr:
        data = resample(data, sr, target_sr)
        sr = target_sr
    return data, sr


def resample(data, sr_from: int, sr_to: int):
    if sr_from == sr_to:
        return data
    from fractions import Fraction
    from scipy.signal import resample_poly
    f = Fraction(sr_to, sr_from).limit_denominator(2000)
    return resample_poly(data, f.numerator, f.denominator, axis=0).astype("float32")


def write_audio(path, data, sr: int):
    import soundfile as sf
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), data, sr, subtype="FLOAT")
    return str(path)


def _rms(x):
    np = _np()
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype="float64"))))


def _db(ratio):
    return 20.0 * math.log10(max(ratio, 1e-12))


def _match_channels(a, n_ch):
    np = _np()
    if a.shape[1] == n_ch:
        return a
    if a.shape[1] == 1:
        return np.repeat(a, n_ch, axis=1)
    if n_ch == 1:
        return a.mean(axis=1, keepdims=True)
    return a[:, :n_ch] if a.shape[1] > n_ch else np.pad(a, ((0, 0), (0, n_ch - a.shape[1])), mode="edge")


# ── The seam ──────────────────────────────────────────────────────────────────
def client_xfade_sec(region_len: float) -> float:
    """Exactly what frontend/js/studio/edit.js spliceRegion() uses: 10% of the region,
    capped at 0.5 s. Mirrored here so our measurements match what the browser produces."""
    return min(region_len * 0.1, 0.5)


def build_patch(src_path, model_path, start_s: float, end_s: float,
                match_level: bool = True, log: Callable[[str], None] = _noop):
    """Turn a full-length model output into a splice-ready clip plus honest numbers.

    Returns (patch, preview, sr, info) where

      patch    exactly (end_s - start_s) long, equal-power crossfaded at both edges
               against the source so its first and last samples *are* the source. The
               browser then runs its own linear crossfade over the same window; because
               the clip already matches at the edges that second blend cannot introduce
               a step, it only softens the onset.
      preview  the whole song with the patch applied through the browser's exact
               formula — this is what the user will hear, so this is what we measure.
      info     range_honored / outside diff / level match / seam metrics.
    """
    np = _np()
    src, sr = read_audio(src_path)
    out, _ = read_audio(model_path, target_sr=sr)
    out = _match_channels(out, src.shape[1])

    a = max(0, int(round(start_s * sr)))
    b = min(src.shape[0], int(round(end_s * sr)))
    if b - a < int(0.2 * sr):
        raise AceStepError("The selected section is shorter than 0.2 s — pick a wider region.")

    info = {"sr": sr, "start_s": start_s, "end_s": end_s,
            "region_s": round((b - a) / sr, 3),
            "src_len_s": round(src.shape[0] / sr, 3),
            "model_len_s": round(out.shape[0] / sr, 3)}

    # Did the model honour the time range, or did it quietly regenerate the whole song?
    # (upstream issue #646). Compare the audio OUTSIDE the window against the source.
    n = min(src.shape[0], out.shape[0])
    if n > a + 1:
        mask = np.ones(n, dtype=bool)
        mask[a:min(b, n)] = False
        if mask.any():
            d_out = _rms(src[:n][mask] - out[:n][mask])
            r_src = _rms(src[:n][mask])
            info["outside_rms_diff"] = round(d_out, 6)
            info["outside_rms_diff_db"] = round(_db(d_out / max(r_src, 1e-9)), 2)
            # -40 dB relative is lossy-codec / VAE round-trip territory; above about
            # -20 dB the model clearly rewrote material outside the window.
            info["range_honored"] = bool(info["outside_rms_diff_db"] < -20)
        if b <= n:
            inside = _rms(src[a:b] - out[a:b])
            info["inside_rms_diff"] = round(inside, 6)
            info["inside_rms_diff_db"] = round(_db(inside / max(_rms(src[a:b]), 1e-9)), 2)

    # Take ONLY the window. Whatever the model did elsewhere is discarded, so the rest of
    # the song is bit-identical no matter how the model behaves.
    if out.shape[0] < b:
        pad = np.zeros((b - out.shape[0], out.shape[1]), dtype="float32")
        out = np.concatenate([out, pad], axis=0)
    patch = out[a:b].copy()
    region = src[a:b]

    if match_level:
        g_src, g_new = _rms(region), _rms(patch)
        if g_new > 1e-6:
            gain = min(2.0, max(0.5, g_src / g_new))   # clamp to +-6 dB
            patch *= gain
            info["level_match_db"] = round(_db(gain), 2)

    # Equal-power (sin/cos) crossfade at both edges, inside the window so the clip stays
    # exactly region-length and lines up sample for sample with the browser's selection.
    xf_s = client_xfade_sec((b - a) / sr)
    xf = max(1, min(int(round(xf_s * sr)), (b - a) // 2))
    t = (np.arange(xf, dtype="float32") + 0.5) / xf
    fin = np.sin(t * (math.pi / 2))[:, None]
    fout = np.cos(t * (math.pi / 2))[:, None]
    # Head: patch fades in (sin), source fades out (cos). Tail: the mirror image —
    # patch weight descends (cos) while the source returns (sin). sin^2 + cos^2 = 1, so
    # the blend holds power constant instead of dipping the way a linear fade does.
    patch[:xf] = patch[:xf] * fin + region[:xf] * fout
    patch[-xf:] = patch[-xf:] * fout + region[-xf:] * fin
    info["equal_power_xfade_ms"] = round(xf / sr * 1000, 1)

    # Reproduce the browser's splice exactly: linear ramp over the same window.
    preview = src.copy()
    lin = (np.arange(xf, dtype="float32") / xf)[:, None]
    merged = patch.copy()
    # edit.js spliceRegion(): head  fade = i/xf                 -> dst = orig*(1-fade) + rep*fade
    #                         tail  fade = (len-1-i)/xf         -> rep's weight descends to 0
    merged[:xf] = region[:xf] * (1 - lin) + patch[:xf] * lin
    merged[-xf:] = region[-xf:] * lin + patch[-xf:] * (1 - lin)
    preview[a:b] = merged

    info["seam"] = {
        "patched": seam_report(preview, sr, (a, b)),
        "source_baseline": seam_report(src, sr, (a, b)),
    }
    log(f"Seam measured at {start_s:.2f}s and {end_s:.2f}s — see the numbers in the panel.")
    return patch, preview, sr, info


def seam_report(sig, sr: int, boundaries, win_ms: float = 200.0):
    """Level jump and waveform discontinuity at each boundary.

    rms_delta_db   RMS of the 200 ms after the boundary vs the 200 ms before it. Near 0
                   means no audible level step.
    step           |x[i] - x[i-1]| at the boundary sample, worst channel.
    local_p999     the 99.9th percentile of |x[i] - x[i-1]| over the surrounding 400 ms.
    click_ratio    step / local_p999. Around 1 means the boundary sample is no more
                   abrupt than normal music; above ~3 you can hear a click.
    """
    np = _np()
    w = max(1, int(win_ms / 1000.0 * sr))
    rows = []
    for idx in boundaries:
        i = int(idx)
        if i - w < 0 or i + w > sig.shape[0]:
            rows.append({"at_s": round(i / sr, 3), "note": "too close to the edge to measure"})
            continue
        pre, post = sig[i - w:i], sig[i:i + w]
        r_pre, r_post = _rms(pre), _rms(post)
        win = sig[max(0, i - w):min(sig.shape[0], i + w)]
        diffs = np.abs(np.diff(win, axis=0))
        local = float(np.percentile(diffs, 99.9)) if diffs.size else 0.0
        step = float(np.max(np.abs(sig[i] - sig[i - 1])))
        rows.append({
            "at_s": round(i / sr, 3),
            "rms_before": round(r_pre, 5),
            "rms_after": round(r_post, 5),
            "rms_delta_db": round(_db(r_post / max(r_pre, 1e-9)), 2),
            "step": round(step, 6),
            "local_p999": round(local, 6),
            "click_ratio": round(step / local, 2) if local > 1e-9 else None,
        })
    return rows


# ── Public engine API ─────────────────────────────────────────────────────────
def prune_work_dir(keep: int = 8, log: Callable[[str], None] = _noop):
    """Keep only the newest `keep` job folders under outputs/acestep.

    Every repaint writes three uncompressed WAVs — the model's full-length output, the
    patch and the preview — which is roughly 110 MB for a three-minute song. Without this
    a few afternoons of experimenting quietly eats tens of gigabytes.
    """
    try:
        dirs = sorted((d for d in WORK_DIR.iterdir() if d.is_dir()),
                      key=lambda d: d.stat().st_mtime, reverse=True)
    except Exception:
        return
    for d in dirs[max(1, keep):]:
        try:
            shutil.rmtree(d, ignore_errors=True)
            log(f"Cleaned up an older ACE-Step result ({d.name})")
        except Exception:
            pass


def _resolve_src(src_wav) -> Path:
    p = Path(src_wav)
    if not p.is_absolute():
        p = OUTPUTS_DIR / p.name
    if not p.exists():
        raise AceStepError(f"Could not find the song file {p.name} in outputs.")
    return p


def repaint(src_wav, start_s, end_s, instruction, tags, lyrics, strength,
            *, log: Callable[[str], None] = _noop, out_dir=None,
            seed: int = -1, steps: int = 8, ref_audio=None, metrics: Optional[dict] = None):
    """Regenerate [start_s, end_s) of `src_wav` from a description.

    `instruction` and `tags` are joined into the caption. ACE-Step does not follow
    instructions — the caller should already have turned the user's words into a
    description of the desired sound (see routers/acestep.py: /acestep/describe).

    Returns the path to a splice-ready clip exactly (end_s - start_s) long, or raises
    AceStepError. Fills `metrics` with the measured seam numbers when given.
    """
    ok, reason = available(check_vram=False)
    if not ok:
        raise AceStepError(reason)
    src = _resolve_src(src_wav)
    start_s, end_s = float(start_s), float(end_s)
    if end_s - start_s < 0.2:
        raise AceStepError("Select at least 0.2 s of the song.")

    caption = ", ".join(x.strip() for x in (tags or "", instruction or "") if x and x.strip())[:512]
    if not caption:
        raise AceStepError("Describe what the new section should sound like.")

    job_dir = Path(out_dir) if out_dir else (WORK_DIR / f"repaint_{int(time.time())}")
    raw_dir = job_dir / "model"
    raw_dir.mkdir(parents=True, exist_ok=True)

    with _gpu_lock:
        release_ollama(log)
        free, total = nvidia_vram()
        if free is not None:
            log(f"Graphics memory before loading: {free} MB free of {total} MB")
            if free < MIN_FREE_VRAM_MB:
                raise AceStepError(
                    f"Only {free} MB of graphics memory is free and about {MIN_FREE_VRAM_MB} MB "
                    "is needed. Close anything else using the GPU and try again.")
        t0 = time.time()
        res = _run_worker({
            "task": "repaint", "src_audio": str(src), "out_dir": str(raw_dir),
            "start_s": start_s, "end_s": end_s, "caption": caption,
            "lyrics": lyrics or "", "strength": float(strength), "seed": int(seed),
            "steps": int(steps), "ref_audio": str(ref_audio) if ref_audio else None,
        }, log)
        wall = time.time() - t0

    patch, preview, sr, info = build_patch(src, res["path"], start_s, end_s, log=log)
    patch_path = write_audio(job_dir / "patch.wav", patch, sr)
    preview_path = write_audio(job_dir / "preview.wav", preview, sr)

    info.update({
        "wall_s": round(wall, 1),
        "model_wall_s": res.get("wall_s"),
        "peak_vram_mb": res.get("peak_reserved_mb") or res.get("peak_alloc_mb"),
        "peak_alloc_mb": res.get("peak_alloc_mb"),
        "seed": res.get("seed"),
        "caption": caption,
        "time_costs": res.get("time_costs"),
        "patch": patch_path,
        "preview": preview_path,
        "model_output": res["path"],
    })
    prune_work_dir(log=log)
    free_after, _ = nvidia_vram()
    info["vram_after_mb_free"] = free_after
    if metrics is not None:
        metrics.update(info)
    log(f"Done in {wall:.0f}s. Peak graphics memory {info.get('peak_vram_mb')} MB.")
    return patch_path


def cover(src_wav, tags, strength, *, log: Callable[[str], None] = _noop,
          out_dir=None, lyrics="", seed: int = -1, steps: int = 8, ref_audio=None,
          metrics: Optional[dict] = None):
    """Restyle a whole song. Same plumbing as repaint, and more reliable, because there
    is no boundary to get wrong. Returns the path to the new full-length track."""
    ok, reason = available(check_vram=False)
    if not ok:
        raise AceStepError(reason)
    src = _resolve_src(src_wav)
    caption = (tags or "").strip()[:512]
    if not caption:
        raise AceStepError("Describe the style you want.")

    job_dir = Path(out_dir) if out_dir else (WORK_DIR / f"cover_{int(time.time())}")
    job_dir.mkdir(parents=True, exist_ok=True)

    with _gpu_lock:
        release_ollama(log)
        free, total = nvidia_vram()
        if free is not None and free < MIN_FREE_VRAM_MB:
            raise AceStepError(
                f"Only {free} MB of graphics memory is free and about {MIN_FREE_VRAM_MB} MB "
                "is needed. Close anything else using the GPU and try again.")
        t0 = time.time()
        res = _run_worker({
            "task": "cover", "src_audio": str(src), "out_dir": str(job_dir),
            "caption": caption, "lyrics": lyrics or "", "strength": float(strength),
            "seed": int(seed), "steps": int(steps),
            "ref_audio": str(ref_audio) if ref_audio else None,
        }, log)
        wall = time.time() - t0

    prune_work_dir(log=log)
    info = {"wall_s": round(wall, 1), "peak_vram_mb": res.get("peak_reserved_mb"),
            "seed": res.get("seed"), "caption": caption, "path": res["path"],
            "preview": res["path"], "vram_after_mb_free": nvidia_vram()[0]}
    if metrics is not None:
        metrics.update(info)
    return res["path"]


def generate(tags, lyrics, seconds, ref_audio=None, *, log: Callable[[str], None] = _noop,
             out_dir=None, seed: int = -1, steps: int = 8, metrics: Optional[dict] = None):
    """From-scratch generation, optionally steered by a reference clip — the thing
    HeartMuLa cannot do at all (its pipeline raises NotImplementedError for ref_audio)."""
    ok, reason = available(check_vram=False)
    if not ok:
        raise AceStepError(reason)
    job_dir = Path(out_dir) if out_dir else (WORK_DIR / f"gen_{int(time.time())}")
    job_dir.mkdir(parents=True, exist_ok=True)

    with _gpu_lock:
        release_ollama(log)
        t0 = time.time()
        res = _run_worker({
            "task": "generate", "out_dir": str(job_dir), "caption": (tags or "")[:512],
            "lyrics": lyrics or "", "seconds": float(seconds or 30),
            "ref_audio": str(ref_audio) if ref_audio else None,
            "seed": int(seed), "steps": int(steps),
        }, log)
        wall = time.time() - t0
    info = {"wall_s": round(wall, 1), "peak_vram_mb": res.get("peak_reserved_mb"),
            "seed": res.get("seed"), "path": res["path"]}
    if metrics is not None:
        metrics.update(info)
    return res["path"]
