"""Three Suno-style entry points for the Generate page — no new generator.

1. ``analyze_reference()``  — an audio clip becomes tags.
   BPM + key come from the app's own librosa path (``app._detect_bpm_key``), the
   mood/genre guess comes from CLAP (laion/clap-htsat-fused, Apache-2.0) scored
   against the Generate page's OWN tag vocabulary, and the timbre/density/
   acoustic-vs-electronic descriptors come from plain spectral DSP so they can be
   explained in one line ("128 BPM, A minor, bright, dense").

   MuQ-MuLan scores better on paper but its weights are CC-BY-NC, so it is not
   used here. CLAP is Apache-2.0.

2. ``analyze_image()`` — a picture becomes a starting point.
   A local vision model (qwen3-vl:4b through Ollama) DESCRIBES THE SCENE, and the
   text model the Lyrics page already uses (llama3.1:8b) maps that description to
   tags + a lyric theme. The vision model is never asked for musical tags
   directly; it is bad at that.

3. ``TIERS`` + ``install_generation_hook()`` — fast / balanced / deep / wild.
   heartlib's ``codec.detokenize(num_steps=, guidance_scale=)`` is never set by
   backend/app.py, so the vocoder always runs at its 10-step / 1.25-guidance
   default. The hook here wraps ``app._run_generation`` (app.py is not edited)
   so a tier can set those two codec knobs alongside the LM's temperature /
   cfg_scale / topk, and stamps the tier onto the job record so history stays
   truthful.

Everything is lazy: importing this module costs nothing but stdlib.
"""

from __future__ import annotations

import json
import math
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# ── Render tiers ──────────────────────────────────────────────────────────────
# "balanced" is EXACTLY today's behaviour (app.py defaults: temperature 1.0,
# cfg_scale 1.5, topk 50; heartlib defaults: num_steps 10, guidance_scale 1.25),
# so nothing regresses for anyone who never touches the control.
#
# cfg_scale is the one knob that changes wall-clock a lot: heartlib runs the
# language model with batch 2 whenever cfg_scale != 1.0 (classifier-free
# guidance needs the unconditional pass), and batch 1 when it is exactly 1.0.
# "Quick take" exploits that. See MEASURED_NOTE for the numbers.
TIERS: Dict[str, Dict[str, Any]] = {
    "quick": {
        "label": "Quick take",
        "blurb": "Fastest — for auditioning ideas. No classifier-free guidance "
                 "(batch 1 in the language model) and a 5-step vocoder.",
        "temperature": 1.0, "cfg_scale": 1.0, "topk": 50,
        "num_steps": 5, "guidance_scale": 1.0,
        "seconds": 248.3, "measured": {"audio_s": 8, "runs": 2, "total_s": 248.3, "total_min_s": 247.6, "total_max_s": 249.1, "lm_s": 61.3, "codec_s": 187.8, "split_runs": 1, "vs_balanced": 0.42, "vs_balanced_same_session": 0.45, "lufs": -12.8, "spectral_flatness": 0.29545, "stereo_width": 0.3395, "whisper_words": 5, "whisper_logprob": -0.812, "verdict": "248 s for 8 s of audio; 0.42x Balanced. The vocoder is 76% of it."},
    },
    "balanced": {
        "label": "Balanced",
        "blurb": "Today's behaviour, unchanged. The default.",
        "temperature": 1.0, "cfg_scale": 1.5, "topk": 50,
        "num_steps": 10, "guidance_scale": 1.25,
        "seconds": 591.7, "measured": {"audio_s": 8, "runs": 4, "total_s": 591.7, "total_min_s": 491.2, "total_max_s": 630.2, "lm_s": 76.8, "codec_s": 476.4, "split_runs": 2, "vs_balanced": 1.0, "vs_balanced_same_session": 1.0, "lufs": -24.69, "spectral_flatness": 0.35833, "stereo_width": 0.2986, "whisper_words": 6, "whisper_logprob": -0.594, "verdict": "592 s for 8 s of audio, 491-630 s across 4 runs; the reference. The vocoder is 81% of it."},
    },
    "deep": {
        "label": "Deep",
        "blurb": "More vocoder steps and stronger guidance — the best render of "
                 "the same idea. Slower.",
        "temperature": 0.95, "cfg_scale": 2.0, "topk": 50,
        "num_steps": 25, "guidance_scale": 1.6,
        "seconds": 1396.1, "measured": {"audio_s": 8, "runs": 2, "total_s": 1396.1, "total_min_s": 1084.6, "total_max_s": 1707.6, "lm_s": 145.9, "codec_s": 1250.2, "split_runs": 2, "vs_balanced": 2.36, "vs_balanced_same_session": 1.76, "lufs": -16.74, "spectral_flatness": 0.22939, "stereo_width": 0.3734, "whisper_words": 11, "whisper_logprob": -0.362, "verdict": "1396 s for 8 s of audio, 1085-1708 s across 2 runs; 2.36x Balanced. The vocoder is 90% of it."},
    },
    "wild": {
        "label": "Wild",
        "blurb": "Hotter sampling, looser guidance — unpredictable takes. Same "
                 "speed as Balanced.",
        "temperature": 1.35, "cfg_scale": 1.15, "topk": 150,
        "num_steps": 10, "guidance_scale": 1.25,
        "seconds": 485.2, "measured": {"audio_s": 8, "runs": 1, "total_s": 485.2, "total_min_s": 485.2, "total_max_s": 485.2, "lm_s": 70.7, "codec_s": 414.5, "split_runs": 1, "vs_balanced": 0.82, "vs_balanced_same_session": 0.99, "lufs": -20.71, "spectral_flatness": 0.1318, "stereo_width": 0.4422, "whisper_words": 2, "whisper_logprob": -0.873, "verdict": "485 s for 8 s of audio; 0.82x Balanced. The vocoder is 85% of it."},
    },
}

DEFAULT_TIER = "balanced"
CUSTOM_TIER = "custom"   # the user moved a slider → apply nothing, send as-is

# Filled in by measurement (see README). Field by field:
#   total_s         mean of 'runs' timed renders on this machine
#   total_min_s     the observed spread. Read it: balanced ranged 491-630 s for the
#   total_max_s     same prompt and seed, so the mean alone overstates the precision
#   lm_s, codec_s   language model vs vocoder, averaged over 'split_runs' renders
#                   (fewer than 'runs' — only some runs carried a timing probe)
#   vs_balanced     derived from the published means, so the displayed arithmetic adds up
#   vs_balanced_same_session
#                   the tighter estimate: tier and balanced measured back to back under
#                   identical conditions. Differs from vs_balanced where a tier's runs
#                   are far apart (deep: 1.76 vs 2.36)
# 'quality' entries are listen-free proxies from one consistent pass. They only hold
# within a session: the same seed produced different audio in a different process, so
# they rank the tiers as measured and are not a cross-machine promise.
MEASURED_NOTE = (
    "Timed on an RTX 3060 12 GB, 8-second clips, same seed, lyrics and tags. One render is "
    "not a repeatable benchmark here: the model and vocoder together exceed 12 GB, so every "
    "render pages about 14 GB through shared system memory and the clock moves with whatever "
    "else touches the bus. Two Balanced runs inside one process landed 630.2 s and 630.1 s, "
    "but across sessions Balanced ranged 491-630 s. Read each number as the mean of its runs "
    "and the ratios between tiers as the stable part. Unload Ollama first to reproduce."
)

_tier_lock = threading.Lock()
_tier_name = DEFAULT_TIER
_active_codec: Optional[Dict[str, Any]] = None   # read by the patched postprocess
_hook_state: Dict[str, Any] = {"generation": False, "codec": False, "caches": False, "error": None}


def tier_names() -> List[str]:
    return list(TIERS.keys())


def current_tier() -> str:
    with _tier_lock:
        return _tier_name


def set_tier(name: str) -> str:
    """Select the render tier used by the next generation(s) that start."""
    global _tier_name
    key = (name or "").strip().lower()
    if key not in TIERS and key != CUSTOM_TIER:
        raise ValueError(f"unknown tier {name!r}; expected one of "
                         f"{', '.join(tier_names())}, {CUSTOM_TIER}")
    with _tier_lock:
        _tier_name = key
    return key


def tier_payload() -> Dict[str, Any]:
    """What the UI needs to draw the control."""
    return {
        "tiers": [
            {
                "id": key,
                "label": t["label"],
                "blurb": t["blurb"],
                "temperature": t["temperature"],
                "cfg_scale": t["cfg_scale"],
                "topk": t["topk"],
                "num_steps": t["num_steps"],
                "guidance_scale": t["guidance_scale"],
                "seconds": t.get("seconds"),
                "measured": t.get("measured") or {},
            }
            for key, t in TIERS.items()
        ],
        "current": current_tier(),
        "default": DEFAULT_TIER,
        "note": MEASURED_NOTE,
        "hooks": dict(_hook_state),
    }


# ── Tier plumbing: wrap app._run_generation, patch heartlib's postprocess ─────
def _app_module():
    """The running app module (it is imported as ``app`` by uvicorn from backend/)."""
    import sys as _sys
    mod = _sys.modules.get("app")
    if mod is not None and hasattr(mod, "_run_generation"):
        return mod
    for m in list(_sys.modules.values()):
        if getattr(m, "__name__", "").endswith("app") and hasattr(m, "_run_generation"):
            return m
    return None


def _drop_stale_kv_caches(model, max_batch_size: int) -> int:
    """Forget any torchtune key-value cache built for a different batch size.

    torchtune's ``setup_cache`` refuses to rebuild an existing cache ("already
    setup ... Skipping"), so after one classifier-free-guidance run (batch 2) a
    cfg_scale == 1.0 run (batch 1) attends against batch-2 caches and dies with
    ``mat1 and mat2 shapes cannot be multiplied (Nx6144 and 3072x3072)``.
    Returns how many caches were dropped.
    """
    dropped = 0
    for mod in model.modules():
        cache = getattr(mod, "kv_cache", None)
        if cache is not None and getattr(cache, "batch_size", max_batch_size) != max_batch_size:
            mod.kv_cache = None
            mod.cache_enabled = False
            dropped += 1
    return dropped


def _patch_setup_caches() -> bool:
    """Make ``HeartMuLa.setup_caches(bs)`` honour a batch-size change (see above)."""
    if _hook_state.get("caches"):
        return True
    try:
        from heartlib.heartmula.modeling_heartmula import HeartMuLa
    except Exception as e:                                    # pragma: no cover
        _hook_state["error"] = f"cache hook unavailable: {type(e).__name__}: {e}"
        return False
    if getattr(HeartMuLa, "_wv_cache_patched", False):
        _hook_state["caches"] = True
        return True
    original = HeartMuLa.setup_caches

    def setup_caches(self, max_batch_size: int):           # noqa: ANN001
        _drop_stale_kv_caches(self, max_batch_size)
        return original(self, max_batch_size)

    HeartMuLa.setup_caches = setup_caches
    HeartMuLa._wv_cache_patched = True
    _hook_state["caches"] = True
    return True


def _patch_codec_detokenize() -> bool:
    """Make heartlib's vocoder honour the active tier's num_steps / guidance_scale.

    ``HeartMuLaGenPipeline.postprocess`` hard-codes ``self.codec.detokenize(frames)``,
    so the two real quality knobs of the vocoder are unreachable from app.py.
    Patched here, on the class, so the already-loaded pipeline instance picks it up.
    """
    if _hook_state["codec"]:
        return True
    try:
        import torch
        import torchaudio
        from heartlib.pipelines.music_generation import HeartMuLaGenPipeline as P
    except Exception as e:                                    # pragma: no cover
        _hook_state["error"] = f"codec hook unavailable: {type(e).__name__}: {e}"
        return False

    if getattr(P, "_wv_tier_patched", False):
        _hook_state["codec"] = True
        return True

    original = P.postprocess

    def postprocess(self, model_outputs, save_path):           # noqa: ANN001
        knobs = _active_codec
        if not knobs:
            return original(self, model_outputs, save_path)
        frames = model_outputs["frames"].to(self.codec_device)
        wav = self.codec.detokenize(
            frames,
            num_steps=int(knobs["num_steps"]),
            guidance_scale=float(knobs["guidance_scale"]),
        )
        self._unload()
        torchaudio.save(save_path, wav.to(torch.float32).cpu(), 48000)

    P.postprocess = postprocess
    P._wv_tier_patched = True
    _hook_state["codec"] = True
    return True


def install_generation_hook() -> bool:
    """Wrap ``app._run_generation`` so each job runs at the selected tier.

    app.py's queue worker calls ``_run_generation(job_id, **kwargs)`` by module
    global, so replacing the global is enough — app.py itself is not touched.
    """
    if _hook_state["generation"]:
        return True
    appmod = _app_module()
    if appmod is None:
        _hook_state["error"] = "generation hook unavailable: app module not imported yet"
        return False

    original = getattr(appmod, "_run_generation", None)
    if original is None or getattr(original, "_wv_tier_wrapped", False):
        _hook_state["generation"] = original is not None
        return _hook_state["generation"]

    def wrapped(job_id, **kwargs):
        global _active_codec
        tier = current_tier()
        t = TIERS.get(tier)
        record = appmod.jobs.get(job_id)
        if t:
            kwargs["temperature"] = t["temperature"]
            kwargs["cfg_scale"] = t["cfg_scale"]
            kwargs["topk"] = t["topk"]
            _active_codec = dict(t)
            if isinstance(record, dict):
                record["tier"] = tier
                record["temperature"] = t["temperature"]
                record["cfg_scale"] = t["cfg_scale"]
                record["topk"] = t["topk"]
                record["codec_num_steps"] = t["num_steps"]
                record["codec_guidance_scale"] = t["guidance_scale"]
            _patch_codec_detokenize()
            _patch_setup_caches()
        else:
            _active_codec = None          # "custom": run exactly what was sent
            if isinstance(record, dict):
                record["tier"] = CUSTOM_TIER
        try:
            return original(job_id, **kwargs)
        finally:
            _active_codec = None

    wrapped._wv_tier_wrapped = True
    wrapped.__name__ = "_run_generation"
    appmod._run_generation = wrapped
    _hook_state["generation"] = True
    return True


# ── Audio features (plain DSP, explainable in one line) ───────────────────────
CLAP_MODEL_ID = "laion/clap-htsat-fused"
CLAP_SR = 48_000
_clap_lock = threading.Lock()
_clap: Dict[str, Any] = {}
_text_cache: Dict[Tuple[str, ...], Any] = {}


_librosa_probe: Dict[str, Any] = {}
LIBROSA_NOTE = (
    "librosa cannot run in this Python ({err}) — that is the numba/numpy mismatch "
    "app.py warns about. Tags and timbre still work; BPM and key need the "
    "interpreter from .waivepulse.bat (F:\\HeartMuLa\\venv\\Scripts\\python.exe)."
)


def librosa_ok() -> Dict[str, Any]:
    """librosa imports fine on a broken numba and then fails on the first real
    call, so probe it with one tiny FFT and cache the answer.

    Only BPM/key need it (they go through app._detect_bpm_key). Everything else
    below is soundfile + scipy, like app.py's own librosa-free DSP core, so a
    broken numba costs two chips instead of the whole feature.
    """
    if not _librosa_probe:
        try:
            import librosa
            import numpy as np
            librosa.stft(np.zeros(2048, dtype="float32"))
            _librosa_probe.update({"ok": True, "error": None})
        except Exception as exc:
            _librosa_probe.update({"ok": False, "error": f"{type(exc).__name__}: {exc}"})
    return dict(_librosa_probe)


def _decode(path: str, sr: int = CLAP_SR):
    """(channels, n) float32 at *sr*. Reuses app.py's librosa-free decoder
    (soundfile, ffmpeg fallback, soxr/scipy resampling) when the app is loaded."""
    import numpy as np
    app = _app_module()
    if app is not None and hasattr(app, "_load_audio"):
        y, fs = app._load_audio(path, sr=sr)
        return np.asarray(y, dtype="float32"), int(fs)
    import soundfile as sf
    from scipy.signal import resample_poly
    d, fs = sf.read(path, dtype="float32", always_2d=True)
    y = np.ascontiguousarray(d.T)
    if fs != sr:
        from fractions import Fraction
        fr = Fraction(sr / fs).limit_denominator(2000)
        y = resample_poly(y, fr.numerator, fr.denominator, axis=-1).astype("float32")
    return y, sr


def _load_audio(path: str, max_seconds: float = 150.0):
    """Return (mono48k, stereo_width, duration)."""
    import numpy as np

    y, _sr = _decode(path, CLAP_SR)
    if y.shape[-1] > int(max_seconds * CLAP_SR):
        y = y[:, :int(max_seconds * CLAP_SR)]
    if y.shape[0] >= 2:
        mid = (y[0] + y[1]) * 0.5
        side = (y[0] - y[1]) * 0.5
        mid_rms = float(np.sqrt(np.mean(mid ** 2)) + 1e-9)
        width = min(1.0, float(np.sqrt(np.mean(side ** 2))) / mid_rms)
        mono = mid
    else:
        mono = y[0]
        width = 0.0
    return np.ascontiguousarray(mono, dtype="float32"), width, float(len(mono)) / CLAP_SR


# ── spectral measurements, scipy only (no numba, no JIT warm-up) ──────────────
FEATURE_WINDOW_S = 45.0
N_FFT = 2048
HOP = 512


def _magnitude(y, sr: int):
    """(magnitude spectrogram, bin frequencies, frame times)."""
    import numpy as np
    from scipy.signal import stft
    freqs, times, Z = stft(y, fs=sr, nperseg=N_FFT, noverlap=N_FFT - HOP,
                           window="hann", boundary=None, padded=False)
    return np.abs(Z).astype("float32"), freqs.astype("float32"), times.astype("float32")


def _hpss_ratio(S, h_frames: int = 17, p_bins: int = 17) -> float:
    """Percussive share of the energy, by the usual median-filter separation:
    smear along time to get what is steady, along frequency to get what is a hit."""
    import numpy as np
    from scipy.ndimage import median_filter
    harm = median_filter(S, size=(1, h_frames), mode="nearest")
    perc = median_filter(S, size=(p_bins, 1), mode="nearest")
    h = float(np.sum(harm ** 2)) + 1e-9
    p = float(np.sum(perc ** 2)) + 1e-9
    return p / (h + p)


def _onset_envelope(S):
    """Half-wave-rectified spectral flux, one value per frame."""
    import numpy as np
    logS = np.log1p(S * 10.0)
    flux = np.diff(logS, axis=1)
    env = np.sum(np.maximum(flux, 0.0), axis=0)
    env = np.concatenate([[0.0], env])
    m = float(np.max(env)) or 1.0
    return env / m


def _pick_onsets(env, times):
    """Peaks above a local mean + a small margin, at least 3 frames apart."""
    import numpy as np
    if len(env) < 5:
        return np.asarray([], dtype="float32")
    from scipy.ndimage import uniform_filter1d
    local = uniform_filter1d(env, size=21, mode="nearest")
    thresh = local + 0.05
    peaks = []
    last = -10
    for i in range(1, len(env) - 1):
        if env[i] >= thresh[i] and env[i] >= env[i - 1] and env[i] > env[i + 1] and i - last >= 3:
            peaks.append(i)
            last = i
    return times[np.asarray(peaks, dtype=int)] if peaks else np.asarray([], dtype="float32")


def _grid_jitter(env, times) -> float:
    """How far the onsets sit off a steady grid: 0 = a drum machine, 0.3 = a human.

    The period comes from the autocorrelation of the onset envelope; the jitter is
    the spread of each onset's distance to its nearest grid line.
    """
    import numpy as np
    onsets = _pick_onsets(env, times)
    if len(onsets) < 6:
        return 0.5
    env0 = env - env.mean()
    ac = np.correlate(env0, env0, mode="full")[len(env0) - 1:]
    frame_s = float(times[1] - times[0]) if len(times) > 1 else HOP / 22_050
    lo = max(2, int(0.20 / frame_s))          # 0.2 s .. 1.5 s  (40-300 BPM)
    hi = min(len(ac) - 1, int(1.50 / frame_s))
    if hi <= lo:
        return 0.5
    period = (lo + int(np.argmax(ac[lo:hi]))) * frame_s
    if period <= 0:
        return 0.5
    phase = np.mod(onsets - onsets[0], period) / period
    off = np.minimum(phase, 1.0 - phase)      # distance to the nearest grid line
    return float(np.clip(np.std(off) * 2.0 + np.mean(off), 0.0, 1.0))


def audio_features(mono48k, width: float, duration: float) -> Dict[str, float]:
    """Spectral descriptors that can be put into words.

    Measured on a centred window — a 2½-minute song costs more seconds than the
    extra accuracy is worth.
    """
    import numpy as np

    win = int(FEATURE_WINDOW_S * CLAP_SR)
    if len(mono48k) > win:
        start = (len(mono48k) - win) // 2
        mono48k = mono48k[start:start + win]

    sr = 22_050
    from fractions import Fraction
    from scipy.signal import resample_poly
    fr = Fraction(sr / CLAP_SR).limit_denominator(2000)
    y = resample_poly(mono48k, fr.numerator, fr.denominator).astype("float32")
    peak = float(np.max(np.abs(y))) or 1.0
    y = y / peak

    S, freqs, times = _magnitude(y, sr)
    power = S + 1e-10
    colsum = np.sum(power, axis=0) + 1e-10
    centroid_f = (freqs[:, None] * power).sum(axis=0) / colsum
    centroid = float(np.mean(centroid_f))
    bandwidth = float(np.mean(np.sqrt(
        ((freqs[:, None] - centroid_f[None, :]) ** 2 * power).sum(axis=0) / colsum)))
    cum = np.cumsum(power, axis=0) / colsum
    rolloff = float(np.mean(freqs[np.argmax(cum >= 0.95, axis=0)]))
    flatness = float(np.mean(np.exp(np.mean(np.log(power), axis=0)) / (np.mean(power, axis=0))))

    frames = max(1, (len(y) - N_FFT) // HOP + 1)
    idx = np.arange(frames) * HOP
    block = np.lib.stride_tricks.sliding_window_view(y, N_FFT)[idx] if frames > 1 else y[None, :N_FFT]
    zcr = float(np.mean(np.mean(np.abs(np.diff(np.sign(block), axis=1)) > 0, axis=1)))
    rms = np.sqrt(np.mean(block ** 2, axis=1))
    rms_mean = float(np.mean(rms)) + 1e-9
    crest = float(np.max(rms) / rms_mean)

    percussive_ratio = _hpss_ratio(S)
    env = _onset_envelope(S)
    onsets = _pick_onsets(env, times)
    onset_rate = float(len(onsets)) / max(1.0, len(y) / sr)
    grid_jitter = _grid_jitter(env, times)

    mean_spec = np.mean(S, axis=1)
    total = float(np.sum(mean_spec)) + 1e-9
    sub = float(np.sum(mean_spec[freqs < 60])) / total
    low = float(np.sum(mean_spec[(freqs >= 60) & (freqs < 250)])) / total
    high = float(np.sum(mean_spec[freqs > 6000])) / total

    return {
        "centroid_hz": round(centroid, 1),
        "rolloff_hz": round(rolloff, 1),
        "flatness": round(flatness, 5),
        "bandwidth_hz": round(bandwidth, 1),
        "zcr": round(zcr, 4),
        "crest": round(crest, 3),
        "percussive_ratio": round(percussive_ratio, 3),
        "onset_rate": round(onset_rate, 2),
        "grid_jitter": round(grid_jitter, 3),
        "sub_energy": round(sub, 4),
        "low_energy": round(low, 4),
        "high_energy": round(high, 4),
        "stereo_width": round(float(width), 3),
        "duration": round(duration, 1),
    }


# ── Words for the measurements ────────────────────────────────────────────────
ACOUSTIC_GENRES = {
    "folk", "acoustic", "country", "classical", "blues", "bossa nova",
    "gospel", "jazz", "opera", "soul",
}
ELECTRONIC_GENRES = {
    "electronic", "edm", "dance", "synthwave", "trap", "disco", "lofi",
    "ambient", "hip-hop", "k-pop",
}


def electronicness(f: Dict[str, float]) -> float:
    """0 = sounds played in a room, 1 = sounds built in a box. Honest about being
    a blend of four cheap measurements, not a classifier."""
    def ramp(v, lo, hi):
        return max(0.0, min(1.0, (v - lo) / (hi - lo)))

    sub = ramp(f["sub_energy"], 0.004, 0.030)          # synth/808 bass below 60 Hz
    grid = 1.0 - ramp(f["grid_jitter"], 0.04, 0.30)    # machine-tight beat grid
    flat = ramp(f["flatness"], 0.002, 0.030)           # noisy/saturated spectrum
    bright = ramp(f["high_energy"], 0.02, 0.14)        # lots of >6 kHz content
    return round(0.34 * sub + 0.30 * grid + 0.20 * flat + 0.16 * bright, 3)


def brightness_word(f: Dict[str, float]) -> str:
    c = f["centroid_hz"]
    if f["flatness"] > 0.020 and f["zcr"] > 0.12:
        return "distorted"
    if c > 3200:
        return "bright"
    if c > 2400:
        return "crisp"
    if c > 1500:
        return "warm"
    if c > 1000:
        return "mellow"
    return "dark"


def density_word(f: Dict[str, float]) -> str:
    """dense/sparse, said in the app's own Timbre vocabulary."""
    dense = f["onset_rate"] > 3.2 and f["crest"] < 2.6
    thin = f["low_energy"] < 0.18 and f["onset_rate"] < 2.2
    if dense:
        return "full" if f["centroid_hz"] < 3000 else "thick"
    if thin:
        return "airy" if f["centroid_hz"] > 2400 else "thin"
    return "rich"


# ── CLAP, scored against the app's own vocabulary ─────────────────────────────
# One prompt template per category. CLAP is a text/audio contrastive model: it
# scores "does this audio match this sentence", so the sentence has to read like
# a caption, not like a tag.
PROMPTS: Dict[str, List[str]] = {
    "Genre": ["{tag}", "{tag} music"],
    "Mood": ["{tag}", "{tag} music", "music that sounds {tag}"],
    "Instrument": ["{tag}", "a song with {tag}"],
}
GENDER_PROMPTS = {
    "male vocals": "a song sung by a male singer",
    "female vocals": "a song sung by a female singer",
    "mixed vocals": "a song sung by a male and a female singer together",
    "choir": "a song with a choir singing together",
    "no vocals": "instrumental music with no singing at all",
    "instrumental": "an instrumental music track with only instruments",
}
# Categories CLAP is asked about. Timbre is measured instead (it is literally a
# spectrum reading), and Scene / Region / Topic are not audible — a picture of a
# beach and a song recorded at a beach sound nothing alike — so they are skipped
# and reported as skipped rather than guessed.
CLAP_CATEGORIES = ("Genre", "Mood", "Instrument", "Gender")
# A two-prompt axis, asked of CLAP directly, because the cheap spectral proxies
# below could not separate this app's own folk takes from its own dance takes
# (mp3 at 48 kHz gives everything the same high-frequency noise floor, and every
# HeartMuLa render has a machine-tight beat grid). See electronicness().
AXIS_PROMPTS = {
    "electronic": "music made with synthesizers and drum machines",
    "acoustic": "music played on acoustic instruments in a room",
}

# Categories whose scores are CENTRED (the music centroid below is subtracted from
# the audio embedding first) and categories that are scored raw.
#
# Why: CLAP's absolute audio/text cosines carry a big per-prompt offset. Scored
# raw against 33 genre names, every piece of music on this machine came back
# "bossa nova" with p>0.5 — the prompt, not the audio, was winning. Subtracting
# the mean audio embedding of a music reference set removes that common
# component and the scores become discriminative (a synthetic four-on-the-floor
# loop goes from "bossa nova 0.58" to "edm 0.55"; see tests/test_vibe.py).
#
# Gender is deliberately NOT centred: every song in the reference set has
# vocals, so the centroid contains the "there is singing here" direction and
# subtracting it throws away exactly the signal that question needs.
CENTRED_CATEGORIES = ("Genre", "Mood", "Instrument")

# Mean CLAP audio embedding over 16 songs (float16, base64). Computed once from a
# genre-spread reference set — folk, rock, metal, grunge, pop, dance, soul,
# gospel, hip-hop, k-pop. It is a "this is music" direction, nothing more.
MUSIC_CENTROID_B64 = (
    "0qw7qwsoLqW2iI+oqCZlrCgmcCRCqUorQqFyrA+pL5tMqpuolapeJtUraQPDqgKeyxkOKpQa3aYQ"
    "pLAnLSHZLXOhXypFJCQWA6wPKvGl442yIUAm2SbGpEgr5iuMpaokDJ9CIcWm6ih/I6Ek5yaYKNgg"
    "a567HF4qQaPXjBarTagKqgctRCFWKjWiJxhIqaOaziYboHcc/h8Jqzyqv5y6qzinfZyUrE8qYSbq"
    "pFQpiakDJuih7SXIpSMtOSzoqEKrDzD5qiEp+KgapKCmIqn/lBSqqqD4H+Elz6SWoWiqyiYirNgq"
    "OaFYrNmppiwVHYqZiizXp1WsUCmoqDKrhSX6pqEo/Cr6HEyiiiJgL4EqWCVqqYWjhyhdj8OofxgT"
    "oQaHbSF6ojkopKFYK2utFihipWqsACtRmX0kaKCRIG0hUR+apOcojqzTFlGeDKFhLLQmBK5Cqwym"
    "PKnBIXchdae9qvata6gIqSiqVBxVLDSiMJf/qlqsPCnnqJyod6nLqDar7p+gpRKreSgwraMoFqlg"
    "LeQemKhOJhSrCKc4KJqlsCdGpguutyqVIY4pOagBJ1CmqpvQotgWDRxYJJcq8KrroCcs+iRxg8ya"
    "qaE8IGMhhqNDKUakJy2gpq4ZDCPuJR4jHqT9oC8o0Bozog0qEC17qU4Z6R7SrWur0qs9pMIa5yYf"
    "ngIlTig/nwwtEyqQJp2hziqAqjwtPB9RJAemeKsjLIkmLqYrGgCrGCl+oQ6lW6ItqGwg+qirIUIs"
    "QKxVrHoj5CpkKTqnEJySKQokX6Cjq20pTx8jmuMon664JhAgwx7ZqLcneJ8GqEMmHyUUJBMpoaXW"
    "J6usjqvFKAWiFaVunDanMauAp3ugq6ooqOglix6MKj4kGKHaqZWf0aj9kEQpT6bMKEcnpJgmqimq"
    "kSRlJmGshJlbqlCmjCgBqDiqkiEPoaYrTCYDrmegORRnGgIoE5z6q9oop6MHpwomcCRpKCQqkiml"
    "nfqn1JyLpLMq3x39GbOdp6Z6qXSs7KPjnRurii2SKYmkZCUoK5yc/SnPo8EoF61SpP2gKa2CHj0n"
    "MKUqrbociisHJoOfjKomk0WiOKnqqJYqmSr8JEqeoSlrIhsnn6lmphKpty5Xoyem3CjjIFct8icI"
    "KJ8UqKKSI6IsSibrJ66pRpgNqOolnCHpLHqsuZ2QqsiqxYs0pY0nFaxHq/uoWiwVKXclfC3uJG6n"
    "yS2FqyAouJsgrJElX5tpJ9+raiw6pZSsnh0VrbqmiKjWpS+ruCfGmxuqCx6qob2oyqeYpgurbKXg"
    "LR8b9B/7q0omkarXHVKn1izTmSIctS5vpnice63fKTglS6YHrVgnLyxbrdYo8B+9H8EgXSmylg=="
)


def music_centroid():
    import base64

    import numpy as np
    if "centroid" not in _clap:
        raw = np.frombuffer(base64.b64decode(MUSIC_CENTROID_B64), dtype="float16")
        # The RAW mean (norm ~0.92), not a unit vector: renormalising it would
        # overshoot and flip the sign of the music component it is meant to cancel.
        _clap["centroid"] = raw.astype("float32")
    return _clap["centroid"]
DSP_CATEGORIES = ("Timbre",)
SKIPPED_CATEGORIES = ("Scene", "Region", "Topic")


CLAP_PATTERNS = ["*.json", "*.txt", "*.safetensors", "*.model"]
CLAP_DOWNLOAD_MB = 618


def _clap_path(download: bool = True) -> Optional[str]:
    """Where CLAP's weights are on disk, or None if they are not there yet.

    Always loaded from an explicit local path: ``from_pretrained("laion/...")``
    makes transformers 4.57 ask the Hub for an ``additional_chat_templates``
    folder that CLAP does not have, and the 404 kills the load.
    """
    from huggingface_hub import snapshot_download
    try:
        return snapshot_download(CLAP_MODEL_ID, allow_patterns=CLAP_PATTERNS,
                                 local_files_only=True)
    except Exception:
        if not download:
            return None
    return snapshot_download(CLAP_MODEL_ID, allow_patterns=CLAP_PATTERNS)


def clap_status() -> Dict[str, Any]:
    cached = None
    try:
        cached = _clap_path(download=False)
    except Exception:
        cached = None
    return {
        "model": CLAP_MODEL_ID,
        "license": "Apache-2.0",
        "cached": bool(cached),
        "download_mb": CLAP_DOWNLOAD_MB,
        "loaded": "model" in _clap,
    }


def _get_clap():
    """Load CLAP once, on CPU. The GPU is shared with HeartMuLa on this machine
    and a 12 GB card has no room for a second resident model; CLAP on CPU scores
    a whole song in about two seconds once loaded."""
    with _clap_lock:
        if "model" not in _clap:
            from transformers import ClapModel, ClapProcessor
            local = _clap_path()
            model = ClapModel.from_pretrained(local)
            model.eval()
            proc = ClapProcessor.from_pretrained(local)
            _clap["model"], _clap["processor"] = model, proc   # both, or neither
        return _clap["model"], _clap["processor"]


def _prompts_for(category: str, tag: str) -> List[str]:
    if category == "Gender":
        return [GENDER_PROMPTS.get(tag, f"a song with {tag}")]
    return [t.format(tag=tag) for t in PROMPTS.get(category, ["{tag}"])]


def _text_embeddings(prompts: List[str]):
    """Unit-normalised text embeddings for these exact prompts (cached)."""
    import torch
    key = tuple(prompts)
    hit = _text_cache.get(key)
    if hit is not None:
        return hit
    model, proc = _get_clap()
    with torch.no_grad():
        inputs = proc(text=list(prompts), return_tensors="pt", padding=True)
        emb = model.get_text_features(**inputs)
    emb = emb / emb.norm(dim=-1, keepdim=True)
    _text_cache[key] = emb
    return emb


def _tag_embeddings(category: str, tags: List[str]):
    """One unit vector per tag — the mean of that tag's prompt templates."""
    import torch
    rows = []
    for tag in tags:
        emb = _text_embeddings(_prompts_for(category, tag)).mean(dim=0)
        rows.append(emb / emb.norm())
    out = torch.stack(rows)
    return out / out.norm(dim=-1, keepdim=True)


def _audio_embedding(mono48k):
    """Average the embedding of up to three 10 s windows so a whole song counts,
    not just its intro."""
    import numpy as np
    import torch

    model, proc = _get_clap()
    win = 10 * CLAP_SR
    n = len(mono48k)
    if n <= win:
        chunks = [np.pad(mono48k, (0, max(0, win - n)))]
    else:
        starts = [int(n * 0.12), int(n * 0.45), int(n * 0.75)]
        chunks = []
        for s in starts:
            s = max(0, min(s, n - win))
            chunks.append(mono48k[s:s + win])
    with torch.no_grad():
        batch = [np.asarray(c, dtype="float32") for c in chunks]
        # The fused feature extractor picks its three mel crops with np.random,
        # so the same clip came back with different tags on every run. Pin the
        # global numpy seed for the length of the call (and put it back after):
        # the model still gets the fusion input it was trained on, and a "why"
        # panel that says "128 BPM, bright, dense" now says the same thing twice.
        kw = dict(sampling_rate=CLAP_SR, return_tensors="pt", padding=True)
        state = np.random.get_state()
        np.random.seed(20_260_101)
        try:
            try:
                inputs = proc(audio=batch, **kw)
            except TypeError:                  # transformers < 4.57 spells it "audios"
                inputs = proc(audios=batch, **kw)
        finally:
            np.random.set_state(state)
        emb = model.get_audio_features(**inputs)
    emb = emb / emb.norm(dim=-1, keepdim=True)
    emb = emb.mean(dim=0, keepdim=True)
    return emb / emb.norm(dim=-1, keepdim=True)


def clap_scores(mono48k, categories: Dict[str, List[str]]) -> Dict[str, List[Tuple[str, float]]]:
    """{category: [(tag, probability), ...] sorted} for the CLAP categories only.

    Plus ``_axis``: the acoustic/electronic read, scored raw.
    """
    import torch

    audio = _audio_embedding(mono48k)
    centred = audio - torch.from_numpy(music_centroid()).to(audio.dtype)
    centred = centred / centred.norm(dim=-1, keepdim=True)
    model, _ = _get_clap()
    scale = float(model.logit_scale_a.exp().detach())
    out: Dict[str, List[Tuple[str, float]]] = {}
    for cat in CLAP_CATEGORIES:
        tags = [t for t in (categories.get(cat) or []) if t]
        if not tags:
            continue
        text = _tag_embeddings(cat, tags)
        vec = centred if cat in CENTRED_CATEGORIES else audio
        with torch.no_grad():
            probs = torch.softmax((vec @ text.T).squeeze(0) * scale, dim=-1).tolist()
        ranked = sorted(zip(tags, probs), key=lambda kv: kv[1], reverse=True)
        out[cat] = [(t, round(float(p), 4)) for t, p in ranked]

    keys = list(AXIS_PROMPTS)
    text = _text_embeddings([AXIS_PROMPTS[k] for k in keys])
    with torch.no_grad():
        probs = torch.softmax((audio @ text.T).squeeze(0) * scale, dim=-1).tolist()
    out["_axis"] = [(k, round(float(p), 4)) for k, p in zip(keys, probs)]
    return out


# ── The mapping (pure, unit-testable) ────────────────────────────────────────
def map_to_tags(features: Dict[str, float],
                scores: Dict[str, List[Tuple[str, float]]],
                categories: Dict[str, List[str]],
                bpm: Optional[int] = None,
                key: Optional[str] = None) -> Dict[str, Any]:
    """Turn measurements + CLAP probabilities into one tag per category.

    No model call in here, so it can be tested with made-up numbers.

    Genre probabilities are nudged along one acoustic/electronic axis before the
    top pick is taken, so a four-on-the-floor synth track cannot come back
    "acoustic folk". The axis comes from CLAP's own two-prompt score when it is
    available and falls back to the spectral ``electronicness()`` proxy when it
    is not. The nudge is a bounded multiplier, never a veto, and the amount
    applied is reported in ``detail``.
    """
    spectral_e = electronicness(features)
    axis = dict(scores.get("_axis") or [])
    e = float(axis.get("electronic", spectral_e)) if axis else spectral_e
    nudge = (e - 0.5) * 2.0          # -1 .. +1
    picks: List[Dict[str, Any]] = []
    extras: List[Dict[str, Any]] = []
    detail: Dict[str, Any] = {
        "electronicness": round(e, 3),
        "electronicness_source": "CLAP axis" if axis else "spectral proxy",
        "spectral_electronicness": spectral_e,
        "genre_nudge": round(nudge, 3),
    }

    genre_ranked = list(scores.get("Genre") or [])
    if genre_ranked:
        adjusted = []
        for tag, p in genre_ranked:
            factor = 1.0
            if tag in ELECTRONIC_GENRES:
                factor = 1.0 + 0.55 * nudge
            elif tag in ACOUSTIC_GENRES:
                factor = 1.0 - 0.55 * nudge
            adjusted.append((tag, max(1e-6, p * max(0.1, factor))))
        total = sum(p for _, p in adjusted) or 1.0
        adjusted = sorted(((t, p / total) for t, p in adjusted),
                          key=lambda kv: kv[1], reverse=True)
        detail["genre_adjusted"] = [(t, round(p, 4)) for t, p in adjusted[:6]]
        top, top_p = adjusted[0]
        picks.append({
            "category": "Genre", "tag": top,
            "confidence": int(round(top_p * 100)), "source": "CLAP + spectrum",
        })
        if len(adjusted) > 1:
            alt, alt_p = adjusted[1]
            extras.append({
                "category": "Genre", "tag": alt,
                "confidence": int(round(alt_p * 100)), "source": "CLAP runner-up",
            })

    for cat in ("Mood", "Instrument", "Gender"):
        ranked = scores.get(cat) or []
        if not ranked:
            continue
        tag, p = ranked[0]
        picks.append({"category": cat, "tag": tag,
                      "confidence": int(round(p * 100)), "source": "CLAP"})

    # Timbre is measured, not guessed.
    bright = brightness_word(features)
    vocab = {c: set(t or []) for c, t in categories.items()}
    if bright in vocab.get("Timbre", set()):
        picks.append({"category": "Timbre", "tag": bright,
                      "confidence": 90, "source": "spectral centroid"})
    dense = density_word(features)
    if dense in vocab.get("Timbre", set()) and dense != bright:
        extras.append({"category": "Timbre", "tag": dense,
                       "confidence": 75, "source": "onset density"})

    words = []
    if bpm:
        words.append(f"{bpm} BPM")
    if key:
        words.append(key)
    words.append(bright)
    words.append("dense" if features["onset_rate"] > 3.2 else "sparse")
    words.append("electronic-leaning" if e >= 0.5 else "acoustic-leaning")
    if features["stereo_width"] > 0.25:
        words.append("wide stereo")

    return {
        "picks": picks,
        "extras": extras,
        "why": " · ".join(words),
        "detail": detail,
        "skipped": list(SKIPPED_CATEGORIES),
    }


def analyze_reference(path: str, categories: Dict[str, List[str]]) -> Dict[str, Any]:
    """Full "sounds like this" pass over one audio file."""
    mono, width, duration = _load_audio(path)
    features = audio_features(mono, width, duration)

    bpm = key = None
    appmod = _app_module()               # reuse the app's own BPM/key path
    if appmod is not None:
        try:
            bpm, key = appmod._detect_bpm_key(path)
        except Exception:
            pass

    scores: Dict[str, List[Tuple[str, float]]] = {}
    clap_error = None
    try:
        scores = clap_scores(mono, categories)
    except Exception as exc:
        clap_error = f"{type(exc).__name__}: {exc}"

    result = map_to_tags(features, scores, categories, bpm=bpm, key=key)
    result.update({
        "bpm": bpm, "key": key,
        "features": features,
        "clap": {c: v[:5] for c, v in scores.items()},
        "clap_model": CLAP_MODEL_ID if scores else None,
        "clap_error": clap_error,
    })
    return result


# ── Ollama (vision + text), both unloaded the moment they answer ──────────────
OLLAMA = "http://127.0.0.1:11434"
VISION_MODEL = "qwen3-vl:4b"
VISION_FALLBACKS = ("qwen3-vl:4b", "qwen2.5vl:7b", "gemma3:4b", "gemma3:27b")
TEXT_MODEL = "llama3.1:8b"        # the model the Lyrics page already uses


class OllamaError(RuntimeError):
    """An error Ollama itself reported, with its own words kept."""


GPU_BUSY = (
    "The GPU is full — reading a picture needs about 4 GB free and HeartMuLa is "
    "holding the card. Wait for the generation to finish and try again."
)


def _ollama_json(path: str, payload: Optional[dict] = None, timeout: int = 20):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        OLLAMA + path, data=data,
        headers={"Content-Type": "application/json"},
        method="POST" if data is not None else "GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        # Ollama puts the real reason in the body; a bare "HTTP Error 500" in the
        # UI is useless, and the usual reason here is a full GPU.
        body = exc.read().decode("utf-8", "replace")[:500]
        try:
            msg = json.loads(body).get("error", body)
        except Exception:
            msg = body
        if "out of memory" in msg.lower() or "cudamalloc" in msg.lower():
            raise OllamaError(GPU_BUSY) from None
        raise OllamaError(f"Ollama said: {msg}") from None
    except urllib.error.URLError as exc:
        raise OllamaError(f"Ollama is not reachable on 127.0.0.1:11434 ({exc.reason})") from None


def ollama_models() -> List[str]:
    try:
        return [m.get("name", "") for m in _ollama_json("/api/tags").get("models", [])]
    except Exception:
        return []


def release_vram() -> List[str]:
    """Free every model Ollama is still holding. The GPU is shared with
    HeartMuLa; a resident 5 GB lyric model is the difference between a
    generation running and a CUDA OOM."""
    freed = []
    try:
        for m in _ollama_json("/api/ps").get("models", []):
            name = m.get("name") or m.get("model")
            if not name:
                continue
            try:
                _ollama_json("/api/generate",
                             {"model": name, "prompt": "", "keep_alive": 0})
                freed.append(name)
            except Exception:
                pass
    except Exception:
        pass
    return freed


def _ollama_generate(model: str, prompt: str, *, images: Optional[List[str]] = None,
                     options: Optional[dict] = None, fmt: Optional[str] = None,
                     timeout: int = 300) -> str:
    payload = {"model": model, "prompt": prompt, "stream": False,
               "options": options or {}, "keep_alive": 0}
    if images:
        payload["images"] = images
    if fmt:
        payload["format"] = fmt
    data = _ollama_json("/api/generate", payload, timeout=timeout)
    return (data.get("response") or "").strip()


def vision_status() -> Dict[str, Any]:
    installed = ollama_models()
    present = [m for m in VISION_FALLBACKS if m in installed]
    return {
        "ollama": bool(installed),
        "model": VISION_MODEL,
        "installed": VISION_MODEL in installed,
        "alternatives": present,
        "text_model": TEXT_MODEL if TEXT_MODEL in installed else (installed[0] if installed else None),
        "download_mb": 3300,
    }


DESCRIBE_PROMPT = (
    "Describe this image for someone who cannot see it. Two or three sentences. "
    "Say what is in it, the light and the time of day, the colours, the weather, "
    "how crowded or empty it is, and the feeling of the place. "
    "Do NOT mention music, songs, genres, instruments or tempo. Just the scene."
)


def describe_image(image_b64: str, model: Optional[str] = None) -> Dict[str, str]:
    status = vision_status()
    if not status["ollama"]:
        raise RuntimeError("Ollama is not reachable on 127.0.0.1:11434")
    chosen = model or (VISION_MODEL if status["installed"]
                       else (status["alternatives"][0] if status["alternatives"] else None))
    if not chosen:
        raise RuntimeError(f"No vision model installed — pull {VISION_MODEL} "
                           f"(~3.3 GB) first")
    text = _ollama_generate(chosen, DESCRIBE_PROMPT, images=[image_b64],
                            options={"temperature": 0.2}, timeout=300)
    text = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    return {"description": text, "model": chosen}


def _vocab_block(categories: Dict[str, List[str]]) -> str:
    return "\n".join(f"- {cat}: {', '.join(tags)}"
                     for cat, tags in categories.items() if tags)


def scene_to_tags(description: str, categories: Dict[str, List[str]],
                  model: Optional[str] = None) -> Dict[str, Any]:
    """Scene description → tags in the app's vocabulary + a lyric theme.

    Two hops on purpose: vision models describe scenes well and choose musical
    tags badly, so the text model does the translating.
    """
    installed = ollama_models()
    chosen = model or (TEXT_MODEL if TEXT_MODEL in installed
                       else (installed[0] if installed else None))
    if not chosen:
        raise RuntimeError("Ollama is not reachable on 127.0.0.1:11434")
    prompt = (
        "You are a music supervisor. Someone describes a photograph; you choose "
        "the song that should play over it.\n\n"
        f"Photograph:\n{description}\n\n"
        "Pick tags for an AI song generator. Rules:\n"
        "- AT MOST ONE tag per category. Genre is required.\n"
        "- Copy tags EXACTLY from this list, do not invent any:\n"
        f"{_vocab_block(categories)}\n"
        "- Also write 'theme': one short sentence (under 15 words) a lyricist "
        "could write a song from, grounded in the photograph.\n"
        "- Also write 'because': one short sentence saying which part of the "
        "photograph drove the choice.\n\n"
        'Respond with JSON only: {"tags": ["pop", "warm"], "theme": "...", "because": "..."}'
    )
    raw = _ollama_generate(chosen, prompt, options={"temperature": 0.4},
                           fmt="json", timeout=240)
    theme = because = ""
    tags_raw: Any = []
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, dict):
            tags_raw = parsed.get("tags", [])
            theme = str(parsed.get("theme") or "").strip()
            because = str(parsed.get("because") or "").strip()
        else:
            tags_raw = parsed
    except Exception:
        tags_raw = re.split(r"[,\n]", raw)
    picks = filter_to_vocabulary(tags_raw, categories)
    return {"picks": picks, "theme": theme, "because": because, "model": chosen}


def filter_to_vocabulary(raw: Any, categories: Dict[str, List[str]]) -> List[Dict[str, str]]:
    """Keep only real tags, canonical spelling, one per category.

    Same contract as app.py's ``_filter_suggested_tags`` but it returns the
    category too, so the UI can show which slot each chip fills.
    """
    if isinstance(raw, str):
        raw = raw.split(",")
    lookup: Dict[str, Tuple[str, str]] = {}
    for cat, tags in (categories or {}).items():
        for t in tags or []:
            lookup.setdefault(str(t).strip().lower(), (cat, str(t).strip()))
    picked: List[Dict[str, str]] = []
    used = set()
    for item in raw or []:
        key = str(item).strip().strip("#").lower()
        if key not in lookup:
            continue
        cat, canon = lookup[key]
        if cat in used:
            continue
        used.add(cat)
        picked.append({"category": cat, "tag": canon, "source": "scene → tags"})
    return picked


def analyze_image(image_b64: str, categories: Dict[str, List[str]],
                  vision: Optional[str] = None,
                  text: Optional[str] = None) -> Dict[str, Any]:
    release_vram()                       # the 12 GB card is shared — start from clean
    described = describe_image(image_b64, vision)
    mapped = scene_to_tags(described["description"], categories, text)
    release_vram()
    return {
        "description": described["description"],
        "vision_model": described["model"],
        "text_model": mapped["model"],
        "picks": mapped["picks"],
        "theme": mapped["theme"],
        "because": mapped["because"],
    }


# ── Listen-free quality proxies (used to measure the tiers) ───────────────────
def quality_proxy(path: str) -> Dict[str, float]:
    """Numbers you can compare between two renders of the same song without
    listening: spectral flatness (noisiness), stereo width, integrated loudness
    (ITU-R BS.1770 K-weighting) and peak."""
    import numpy as np
    from scipy import signal

    sr = 48_000
    y, _ = _decode(path, sr)
    y = np.asarray(y, dtype="float64")
    if y.ndim == 1:
        y = y[None, :]
    mono = y.mean(axis=0)
    if y.shape[0] >= 2:
        mid = (y[0] + y[1]) * 0.5
        side = (y[0] - y[1]) * 0.5
        width = float(np.sqrt(np.mean(side ** 2)) / (np.sqrt(np.mean(mid ** 2)) + 1e-12))
    else:
        width = 0.0

    # K-weighting: shelving filter + high-pass, per BS.1770-4 at 48 kHz.
    shelf_b = np.array([1.53512485958697, -2.69169618940638, 1.19839281085285])
    shelf_a = np.array([1.0, -1.69065929318241, 0.73248077421585])
    hp_b = np.array([1.0, -2.0, 1.0])
    hp_a = np.array([1.0, -1.99004745483398, 0.99007225036621])
    gated = []
    for ch in y:
        f = signal.lfilter(shelf_b, shelf_a, ch)
        f = signal.lfilter(hp_b, hp_a, f)
        gated.append(f)
    block = int(0.4 * sr)
    step = int(0.1 * sr)
    powers = []
    for ch in gated:
        p = []
        for s in range(0, max(1, len(ch) - block + 1), step):
            seg = ch[s:s + block]
            p.append(float(np.mean(seg ** 2)))
        powers.append(np.array(p))
    if powers and len(powers[0]):
        total = sum(powers)                      # channel weights are 1.0 for L/R
        loud = -0.691 + 10 * np.log10(total + 1e-12)
        keep = loud > -70
        if keep.any():
            mean_pow = float(np.mean(total[keep]))
            thresh = -0.691 + 10 * math.log10(mean_pow + 1e-12) - 10
            keep2 = loud > thresh
            if keep2.any():
                lufs = -0.691 + 10 * math.log10(float(np.mean(total[keep2])) + 1e-12)
            else:
                lufs = float(-0.691 + 10 * math.log10(mean_pow + 1e-12))
        else:
            lufs = -70.0
    else:
        lufs = -70.0

    f = audio_features(mono.astype("float32"), width, len(mono) / sr)
    flat, cent = f["flatness"], f["centroid_hz"]
    return {
        "lufs": round(float(lufs), 2),
        "peak_dbfs": round(20 * math.log10(float(np.max(np.abs(mono))) + 1e-12), 2),
        "spectral_flatness": flat,
        "spectral_centroid_hz": cent,
        "stereo_width": round(width, 4),
        "duration_s": round(len(mono) / sr, 1),
    }


def transcribe_proxy(path: str, model_name: str = "base") -> Dict[str, Any]:
    """Is the vocal intelligible? Runs the faster-whisper the app already ships,
    on CPU, on the full mix (no stem separation) — which is exactly why the
    word count matters more than the words."""
    from faster_whisper import WhisperModel
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    segments, info = model.transcribe(path, beam_size=5, temperature=0.0,
                                      vad_filter=True)
    words: List[str] = []
    logprobs: List[float] = []
    for seg in segments:
        words.extend(w for w in seg.text.split() if w)
        if getattr(seg, "avg_logprob", None) is not None:
            logprobs.append(float(seg.avg_logprob))
    import statistics
    return {
        "words": len(words),
        "text": " ".join(words)[:400],
        "avg_logprob": round(statistics.mean(logprobs), 3) if logprobs else None,
        "language": getattr(info, "language", None),
    }
