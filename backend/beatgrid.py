"""Beat grid — downbeats, beat positions, tempo and an honest confidence for any audio file.

This is the piece WAIvePulse was missing. Demucs already splits a song into six stems,
the server already time-stretches (pitch preserved) and pitch-shifts, and the Studio
already splices with crossfades — but nothing knew WHERE the bar lines were, so every
cross-song edit had to be nudged by ear. With a grid, "vocals from A over drums from B"
and "sample the riff at 0:45" become bookkeeping.

Two trackers, in preference order:

  1. **Beat This!** (CPJKU, MIT code *and* weights) — a transformer that predicts beat and
     downbeat activations at 50 fps. It gives real downbeats (so bars, not just beats) and
     a usable per-beat probability. Used when `beat_this` imports and a checkpoint is on
     disk. Inference runs on CPU by default: a 2:40 song takes ~12 s, and the GPU on this
     machine is usually busy holding other models, where a VRAM failure would take the
     whole app server down with it. Set WAIVEPULSE_BEATGRID_DEVICE=cuda to use the GPU.
  2. **librosa** `beat_track` — always available (the app already uses it for BPM). Beats
     only: no downbeats, so the bar phase is *estimated* by picking the beat offset whose
     onset strength is highest, 4/4 is assumed, and the confidence is capped. Grids from
     this tracker say so, in the API and in the UI.

The checkpoint is NOT bundled. Put `final0.ckpt` (81 MB, from
https://cloud.cp.jku.at/public.php/dav/files/7ik4RrBKTS273gp/final0.ckpt) in
G:/cache/waivepulse/beatgrid (Windows) or ~/.cache/waivepulse/beatgrid, or point
WAIVEPULSE_BEATGRID_CKPT at it. Without it the module falls back to librosa and says so
in /beatgrid/status, so the UI can be honest about which tracker produced a grid.

Everything is cached per file (path + mtime + size + tracker + cache version) as JSON
under outputs/.beatgrid/, because tracking a four-minute song is not free and the same
song gets analysed by the mashup builder, the sampler and the ruler.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import threading
import time
from pathlib import Path
from typing import Optional

# Imported eagerly on purpose. Uvicorn runs sync endpoints on a thread pool, so two requests
# can import the same C extension at the same moment — one of them then gets a half-built
# module and the import dies with
#   SystemError: initialization of _internal failed without raising an exception
# which is exactly what happened here when a beat-grid analysis (numpy + soxr, via beat_this)
# overlapped a /detect-bpm or /timestretch call (numpy + soxr again). Importing the shared
# extensions once, on the main thread, as the router is mounted takes beatgrid out of that
# race. torch and librosa stay lazy (they are heavy, and only this module imports torch), but
# every use of them is serialised by `_lock` below.
import numpy as np  # noqa: F401  (functions below re-import it locally for clarity)

for _m in ("soxr", "soundfile"):
    try:
        __import__(_m)
    except Exception:
        pass

CACHE_VERSION = 4   # 4: robust iterative tempo fit + canonical bar phase (see _fit_period)

_ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = Path(os.environ.get("WAIVEPULSE_BEATGRID_CACHE", str(_ROOT / "outputs" / ".beatgrid")))

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

_lock = threading.Lock()          # one analysis at a time: torch + librosa are CPU hogs
_model = None                     # lazily-built Beat This! wrapper
_model_err: Optional[str] = None


# ── Where the checkpoint lives ────────────────────────────────────────────────
def _default_model_dirs() -> list[Path]:
    dirs = []
    env = os.environ.get("WAIVEPULSE_BEATGRID_CKPT")
    if env:
        dirs.append(Path(env))
    dirs += [
        Path("G:/cache/waivepulse/beatgrid"),
        Path.home() / ".cache" / "waivepulse" / "beatgrid",
        _ROOT / "data" / "beatgrid",
    ]
    return dirs


def checkpoint_path() -> Optional[Path]:
    """The Beat This! checkpoint on disk, or None."""
    for d in _default_model_dirs():
        if d.is_file() and d.suffix == ".ckpt":
            return d
        if d.is_dir():
            for name in ("final0.ckpt", "beat_this-final0.ckpt", "small0.ckpt"):
                p = d / name
                if p.is_file():
                    return p
            found = sorted(d.glob("*.ckpt"))
            if found:
                return found[0]
    return None


def _have(mod: str) -> bool:
    import importlib.util
    try:
        return importlib.util.find_spec(mod) is not None
    except Exception:
        return False


def tracker_info() -> dict:
    """Which tracker will be used, and why — surfaced by GET /beatgrid/status."""
    ckpt = checkpoint_path()
    bt = _have("beat_this") and _have("torch")
    librosa = _have("librosa")
    if bt and ckpt:
        return {
            "tracker": "beat_this",
            "label": f"Beat This! ({ckpt.stem})",
            "downbeats": "detected",
            "device": _device(),
            "checkpoint": str(ckpt),
            "reason": "beat_this imports and a checkpoint is on disk",
            "available": True,
            "librosa_fallback": librosa,
            "error": _model_err,
        }
    reason = ("beat_this is not installed" if not bt else
              "beat_this is installed but no checkpoint was found "
              f"(looked in {', '.join(str(d) for d in _default_model_dirs())})")
    if librosa:
        return {
            "tracker": "librosa",
            "label": "librosa beat_track (beats only, bar phase estimated)",
            "downbeats": "estimated",
            "device": "cpu",
            "checkpoint": None,
            "reason": reason + " — falling back to librosa",
            "available": True,
            "librosa_fallback": True,
            "error": _model_err,
        }
    return {
        "tracker": "none", "label": "no beat tracker available", "downbeats": "none",
        "device": None, "checkpoint": None,
        "reason": reason + " and librosa is missing either",
        "available": False, "librosa_fallback": False, "error": _model_err,
    }


def _device() -> str:
    want = (os.environ.get("WAIVEPULSE_BEATGRID_DEVICE") or "cpu").lower()
    if want.startswith("cuda"):
        try:
            import torch
            if torch.cuda.is_available():
                return want
        except Exception:
            pass
        return "cpu"
    return "cpu"


# ── Audio loading ─────────────────────────────────────────────────────────────
def _load_signal(path: str):
    """→ (mono-or-stereo float32 ndarray shaped (n, ch) or (n,), sample_rate)."""
    try:
        from beat_this.preprocessing import load_audio   # soundfile/ffmpeg under the hood
        return load_audio(path)
    except Exception:
        pass
    import librosa
    y, sr = librosa.load(path, sr=22050, mono=True)
    return y, sr


def _mono(sig):
    import numpy as np
    a = np.asarray(sig)
    return a.mean(axis=1) if a.ndim == 2 else a


# ── Trackers ──────────────────────────────────────────────────────────────────
class _BeatThis:
    def __init__(self, ckpt: Path, device: str):
        from beat_this.inference import Audio2Beats, Audio2Frames
        self._frames_cls = Audio2Frames
        self.a2b = Audio2Beats(checkpoint_path=str(ckpt), device=device, dbn=False)
        self.device = device
        self.ckpt = ckpt

    def track(self, sig, sr):
        """→ (beats_sec, downbeats_sec, per-beat probability or None)"""
        import numpy as np
        import torch
        beat_logits, down_logits = self._frames_cls.__call__(self.a2b, sig, sr)
        beats, downbeats = self.a2b.frames2beats(beat_logits, down_logits)
        probs = torch.sigmoid(beat_logits).detach().cpu().numpy()
        n = _mono(sig).shape[0]
        dur = n / float(sr)
        fps = (len(probs) / dur) if dur > 0 else 50.0
        beats = np.asarray(beats, dtype=float)
        if len(beats):
            idx = np.clip(np.round(beats * fps).astype(int), 0, len(probs) - 1)
            beat_prob = float(np.median(probs[idx]))
        else:
            beat_prob = 0.0
        return beats, np.asarray(downbeats, dtype=float), beat_prob


def _get_model():
    global _model, _model_err
    if _model is not None:
        return _model
    ckpt = checkpoint_path()
    if not ckpt:
        return None
    try:
        _model = _BeatThis(ckpt, _device())
        _model_err = None
    except Exception as e:                                   # pragma: no cover
        _model = None
        _model_err = f"{type(e).__name__}: {e}"
    return _model


def _track_librosa(sig, sr):
    """Beats from librosa + an ESTIMATED downbeat phase (assumes 4/4)."""
    import numpy as np
    import librosa
    y = _mono(sig).astype("float32")
    if sr != 22050:
        y = librosa.resample(y, orig_sr=sr, target_sr=22050)
        sr = 22050
    onset = librosa.onset.onset_strength(y=y, sr=sr)
    _tempo, frames = librosa.beat.beat_track(onset_envelope=onset, sr=sr, trim=False)
    beats = librosa.frames_to_time(frames, sr=sr)
    if len(beats) < 5:
        return np.asarray(beats, dtype=float), np.asarray([], dtype=float), None
    # Bar phase: of the four possible 4/4 offsets, the strongest average onset wins.
    strength = onset[np.clip(frames, 0, len(onset) - 1)]
    best_phase, best_score = 0, -1.0
    for phase in range(4):
        sel = strength[phase::4]
        score = float(sel.mean()) if len(sel) else -1.0
        if score > best_score:
            best_phase, best_score = phase, score
    downbeats = np.asarray(beats[best_phase::4], dtype=float)
    return np.asarray(beats, dtype=float), downbeats, None


# ── Tempo: a least-squares fit, NOT the median beat interval ──────────────────
# Beat This! reports beats on a 50 fps frame grid, so every interval is a multiple of 20 ms.
# On a 136 BPM song the intervals alternate 0.44 / 0.46 s and the median lands on 0.44 →
# 136.36 BPM, when the truth is nearer 134.3. That 1.5 % error is invisible in a BPM readout
# and fatal in a mashup: it is ~30 ms of drift per bar, so stem two walks off the grid after
# a few bars. Fitting time against beat index over the whole song removes the quantisation
# (the residual error is one frame spread over N beats) and gives a free measure of how well
# a CONSTANT tempo describes the song, which is a better confidence signal than interval MAD.
def _fit_period(times):
    """(period_sec, intercept_sec, rms_residual_sec, inlier_fraction) for gappy beat times.

    Iterative: assign each beat an index, fit, re-index from the fit, drop the beats that do
    not fit, repeat. Re-indexing from the fit matters — a first pass that uses the median
    interval mis-indexes any gap that is not a whole number of median beats, and the index
    error then accumulates for the rest of the song. Dropping outliers matters too: a song
    with an added bar, a half-time section or a free intro would otherwise drag the tempo of
    the whole song off, and the inlier fraction that comes out is itself worth reporting.
    """
    import numpy as np
    t = np.asarray(times, dtype=float)
    if len(t) < 3:
        return (float(np.median(np.diff(t))) if len(t) > 1 else 0.0), (float(t[0]) if len(t) else 0.0), 0.0, 1.0
    d = np.diff(t)
    m = float(np.median(d))
    if m <= 0:
        return 0.0, float(t[0]), 0.0, 1.0
    idx = np.concatenate([[0.0], np.cumsum(np.maximum(1.0, np.round(d / m)))])
    mask = np.ones(len(t), dtype=bool)
    slope, intercept, rms = m, float(t[0]), 0.0
    for _ in range(6):
        A = np.vstack([idx[mask], np.ones(int(mask.sum()))]).T
        (slope, intercept), *_ = np.linalg.lstsq(A, t[mask], rcond=None)
        if slope <= 0:
            return m, float(t[0]), 0.0, 1.0
        idx = np.round((t - intercept) / slope)
        res = t - (slope * idx + intercept)
        rms = float(np.sqrt(np.mean(res[mask] ** 2))) if mask.any() else 0.0
        new = np.abs(res) <= max(3.0 * rms, 0.02)        # 3 sigma, floor of one frame
        if new.sum() < max(4, 0.5 * len(t)):             # never throw away half the song
            break
        if np.array_equal(new, mask):
            mask = new
            break
        mask = new
    res = t - (slope * np.round((t - intercept) / slope) + intercept)
    rms = float(np.sqrt(np.mean(res[mask] ** 2))) if mask.any() else 0.0
    return float(slope), float(intercept), rms, float(mask.mean())


def _beat_index(times, period, intercept):
    import numpy as np
    if period <= 0:
        return np.zeros(len(times), dtype=int)
    return np.round((np.asarray(times, dtype=float) - intercept) / period).astype(int)


def _canonical_downbeats(downbeats, beats, period, intercept, beats_per_bar):
    """Keep the downbeats that sit on one consistent bar phase.

    The model sometimes marks a half bar as a downbeat; snapping a sample or a mashup to one
    of those puts it on beat 3. Each downbeat is mapped to its beat index, the commonest
    index-modulo-bar wins, and the rest are dropped — unless that would throw away half the
    list, which would mean the song genuinely does not keep one bar length.
    """
    import numpy as np
    db = np.asarray(downbeats, dtype=float)
    if len(db) < 3 or period <= 0 or beats_per_bar < 2:
        return db, 0
    idx = _beat_index(db, period, intercept)
    res = idx % beats_per_bar
    vals, counts = np.unique(res, return_counts=True)
    phase = int(vals[int(counts.argmax())])
    keep = db[res == phase]
    if len(keep) < max(3, 0.5 * len(db)):
        return db, 0
    return keep, int(len(db) - len(keep))


# ── Confidence ────────────────────────────────────────────────────────────────
def _grade(beats, downbeats, duration, beat_prob, estimated_downbeats, period, rms, inliers=1.0):
    """An honest 0–1 confidence plus the raw components, so the UI can explain itself."""
    import numpy as np
    out = {"beat_prob": beat_prob, "tempo_stability": 0.0,
           "bar_regularity": 0.0, "coverage": 0.0, "tempo_inliers": inliers}
    if len(beats) < 4:
        return 0.0, out, ["fewer than four beats were found — this is not a usable grid"]

    # How well does ONE constant tempo describe the song? rms is in seconds of beat error;
    # 25 ms of scatter on a half-second beat (5 %) is already unmixable. The inlier fraction
    # discounts it further when a chunk of the song had to be excluded to get that fit.
    rel = (rms / period) if period > 0 else 1.0
    out["tempo_stability"] = max(0.0, 1.0 - rel / 0.05) * (0.4 + 0.6 * inliers)

    if len(downbeats) >= 3:
        gaps = np.diff(downbeats)
        per_bar = np.round(gaps / period) if period > 0 else gaps * 0
        counts = np.unique(per_bar, return_counts=True)[1]
        out["bar_regularity"] = float(counts.max() / len(per_bar))
    elif len(downbeats):
        out["bar_regularity"] = 0.3

    span = float(beats[-1] - beats[0])
    out["coverage"] = max(0.0, min(1.0, span / duration)) if duration > 0 else 0.0

    if beat_prob is None:                                    # librosa: no model probability
        conf = (0.55 * out["tempo_stability"] + 0.20 * out["bar_regularity"]
                + 0.25 * out["coverage"])
    else:
        conf = (0.45 * beat_prob + 0.30 * out["tempo_stability"]
                + 0.15 * out["bar_regularity"] + 0.10 * out["coverage"])
    if estimated_downbeats:
        conf *= 0.85          # the bar phase is a guess, so never claim "strong"
    conf = max(0.0, min(1.0, conf))

    warn = []
    if rel > 0.025:
        warn.append(f"the beats scatter {rms * 1000:.0f} ms around a steady tempo "
                    f"({rel * 100:.1f} % of a beat) — live or rubato material, so one stretch "
                    "factor will drift")
    if inliers < 0.85:
        warn.append(f"only {inliers * 100:.0f} % of the beats fit one steady tempo — this song "
                    "probably changes tempo or has a free section, so the single BPM below "
                    "describes most of it, not all of it")
    if out["coverage"] < 0.8:
        warn.append(f"beats were only found across {out['coverage'] * 100:.0f} % of the file")
    if estimated_downbeats:
        warn.append("downbeats are ESTIMATED (librosa gives beats only): 4/4 assumed and the "
                    "bar phase picked by onset strength — check the first downbeat by ear")
    return conf, out, warn


def _label(conf: float) -> str:
    return ("strong" if conf >= 0.80 else "usable" if conf >= 0.60
            else "shaky" if conf >= 0.40 else "weak")


# ── Key (same Krumhansl-Schmuckler profiles the app already uses for /detect-bpm) ──
def estimate_key(path: str) -> Optional[str]:
    try:
        import librosa
        import numpy as np
        y, sr = librosa.load(path, sr=22050, mono=True, duration=120)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)
        major = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
        minor = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
        best, best_key = -1e9, None
        for i in range(12):
            rot = np.roll(chroma, -i)
            for prof, qual in ((major, "major"), (minor, "minor")):
                s = float(np.corrcoef(rot, prof)[0, 1])
                if s > best:
                    best, best_key = s, f"{NOTES[i]} {qual}"
        return best_key
    except Exception:
        return None


# ── Cache ─────────────────────────────────────────────────────────────────────
def _cache_key(path: Path, tracker: str, with_key: bool) -> Path:
    try:
        st = path.stat()
        sig = f"{path.resolve()}|{st.st_mtime_ns}|{st.st_size}|{tracker}|{CACHE_VERSION}|{int(with_key)}"
    except OSError:
        sig = f"{path}|{tracker}|{CACHE_VERSION}|{int(with_key)}"
    return CACHE_DIR / (hashlib.sha1(sig.encode("utf-8")).hexdigest() + ".json")


def clear_cache() -> int:
    n = 0
    if CACHE_DIR.is_dir():
        for p in CACHE_DIR.glob("*.json"):
            try:
                p.unlink(); n += 1
            except OSError:
                pass
    return n


# ── The analysis ──────────────────────────────────────────────────────────────
def analyze_file(path, with_key: bool = True, force: bool = False) -> dict:
    """Beat grid for one audio file. Cached. Raises RuntimeError if no tracker exists.

    Retried once on SystemError / MemoryError. Under real memory pressure — several
    concurrent /timestretch calls on long stems will do it — an import inside this module
    can die with "initialization of _internal failed without raising an exception", which is
    a symptom, not the disease. Collecting garbage and trying again once turns a 500 into a
    pause. (A traceback is written to outputs/.beatgrid/last_error.txt if it fails anyway.)
    """
    try:
        return _analyze_file(path, with_key=with_key, force=force)
    except (SystemError, MemoryError):
        import gc
        gc.collect()
        return _analyze_file(path, with_key=with_key, force=force)


def _analyze_file(path, with_key: bool = True, force: bool = False) -> dict:
    p = Path(path)
    if not p.is_file():
        raise FileNotFoundError(str(p))

    info = tracker_info()
    if not info["available"]:
        raise RuntimeError(info["reason"])

    cache = _cache_key(p, info["tracker"], with_key)
    if not force and cache.is_file():
        try:
            grid = json.loads(cache.read_text("utf-8"))
            if grid.get("cache_version") == CACHE_VERSION:
                grid["cached"] = True
                return grid
        except Exception:
            pass

    t0 = time.time()
    with _lock:
        import numpy as np
        sig, sr = _load_signal(str(p))
        duration = float(_mono(sig).shape[0]) / float(sr)

        tracker = info["tracker"]
        model = _get_model() if tracker == "beat_this" else None
        if model is not None:
            beats, downbeats, beat_prob = model.track(sig, sr)
            tracker_label = f"Beat This! ({model.ckpt.stem}, {model.device})"
            estimated = False
        else:
            if tracker == "beat_this":           # checkpoint found but the model would not build
                tracker = "librosa"
            beats, downbeats, beat_prob = _track_librosa(sig, sr)
            tracker_label = "librosa beat_track (bar phase estimated)"
            estimated = True

        # Tempo from a fit over every beat, not the median interval (see _fit_period).
        period, intercept, rms, inliers = _fit_period(beats)
        med_ioi = float(np.median(np.diff(beats))) if len(beats) > 1 else 0.0
        bpm = (60.0 / period) if period > 0 else 0.0

        # Tempo drift: fit the two halves separately and compare.
        drift = 0.0
        if len(beats) >= 16:
            h = len(beats) // 2
            a = _fit_period(beats[:h])[0]
            b = _fit_period(beats[h:])[0]
            if a > 0 and b > 0:
                drift = abs(60.0 / a - 60.0 / b)

        beats_per_bar = 4
        if len(downbeats) >= 3 and period > 0:
            per_bar = np.round(np.diff(downbeats) / period)
            vals, counts = np.unique(per_bar, return_counts=True)
            modal = int(vals[int(counts.argmax())])
            if 2 <= modal <= 12:
                beats_per_bar = modal

        downbeats, dropped = _canonical_downbeats(downbeats, beats, period, intercept, beats_per_bar)

        conf, parts, warn = _grade(beats, downbeats, duration, beat_prob, estimated,
                                   period, rms, inliers)
        if drift > 2.0:
            warn.append(f"tempo drifts about {drift:.1f} BPM across the file — a single "
                        "stretch factor cannot hold both ends in time")
        if dropped:
            warn.append(f"{dropped} detected downbeat{'s' if dropped != 1 else ''} did not sit on "
                        "the song's bar phase and were dropped (probably half bars)")

        grid = {
            "cache_version": CACHE_VERSION,
            "file": p.name,
            "duration": round(duration, 4),
            "tracker": tracker,
            "tracker_label": tracker_label,
            "device": info["device"] if tracker == "beat_this" else "cpu",
            "bpm": round(bpm, 2),
            "bpm_int": int(round(bpm)) if bpm else None,
            "bpm_median_ioi": round(60.0 / med_ioi, 2) if med_ioi else None,   # the old, quantised answer
            "tempo_drift_bpm": round(drift, 2),
            "fit_rms_ms": round(rms * 1000, 2),
            "fit_inliers": round(inliers, 3),
            "beats": [round(float(x), 4) for x in beats],
            "downbeats": [round(float(x), 4) for x in downbeats],
            "downbeats_dropped": dropped,
            "beats_per_bar": beats_per_bar,
            "bar_sec": round(period * beats_per_bar, 6) if period else 0.0,
            "beat_sec": round(period, 6),
            "downbeats_estimated": estimated,
            "confidence": round(conf, 3),
            "confidence_label": _label(conf),
            "confidence_parts": {k: (None if v is None else round(float(v), 3))
                                 for k, v in parts.items()},
            "warnings": warn,
            "key": estimate_key(str(p)) if with_key else None,
            "analyzed_ms": int((time.time() - t0) * 1000),
            "cached": False,
        }

    try:
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(grid), "utf-8")
    except OSError:
        pass
    return grid


# ── Grid maths the mashup builder and the sampler use ─────────────────────────
def bar_lines(grid: dict, pad: bool = True) -> list[float]:
    """Downbeat times covering the whole file — extrapolated before the first and after
    the last detected downbeat so a selection anywhere on the ruler can still snap."""
    dbs = list(grid.get("downbeats") or [])
    bar = float(grid.get("bar_sec") or 0)
    dur = float(grid.get("duration") or 0)
    if not dbs:
        if bar <= 0:
            return []
        n = int(dur / bar) + 2
        return [round(i * bar, 4) for i in range(n)]
    if not pad or bar <= 0:
        return dbs
    # Fill internal gaps first: the canonical-phase filter drops half-bar detections, and a
    # section where the bar phase shifts can leave a stretch of the song with no bar line at
    # all. Those gaps are filled at the fitted bar length so snapping works everywhere.
    out = [dbs[0]]
    for nxt in dbs[1:]:
        n = int(round((nxt - out[-1]) / bar))
        for k in range(1, min(n, 64)):          # one line per missing bar, evenly spread
            out.append(round(out[-1] + (nxt - out[-1]) / (n - k + 1), 4))
        out.append(nxt)
    t = out[0] - bar
    while t >= 0:                 # extrapolate backwards on the beat, never clamp to 0
        out.insert(0, round(t, 4))
        t -= bar
    t = out[-1] + bar
    while t < dur + bar:
        out.append(round(t, 4))
        t += bar
    return out


def nearest(times, t: float):
    """(value, signed delta = value - t) for the closest entry, or (None, None)."""
    if not times:
        return None, None
    best = min(times, key=lambda x: abs(x - t))
    return best, best - t


def snap_region(grid: dict, start: float, end: float, min_bars: int = 1) -> dict:
    """Snap a ruler selection out to whole bars. Returns the snapped bounds, how far each
    edge moved (ms — the honest number the UI prints) and how many bars the clip is."""
    lines = bar_lines(grid)
    bar = float(grid.get("bar_sec") or 0)
    dur = float(grid.get("duration") or 0)
    if not lines or bar <= 0:
        return {"start": start, "end": end, "bars": 0, "snapped": False,
                "start_shift_ms": 0.0, "end_shift_ms": 0.0, "bar_sec": bar}
    s, ds = nearest(lines, start)
    bars = max(min_bars, int(round(max(0.0, end - s) / bar)) or min_bars)
    e = s + bars * bar
    if dur and e > dur:                      # don't run off the end of the file
        bars = max(min_bars, int((dur - s) / bar))
        e = s + bars * bar
        if e > dur:
            s = max(0.0, dur - bars * bar)
            e = s + bars * bar
    return {
        "start": round(s, 4), "end": round(e, 4), "bars": bars, "snapped": True,
        "start_shift_ms": round((s - start) * 1000, 1),
        "end_shift_ms": round((e - end) * 1000, 1),
        "bar_sec": round(bar, 4), "beat_sec": grid.get("beat_sec"),
        "beats_per_bar": grid.get("beats_per_bar"),
    }


def octave_fold(src_bpm: float, tgt_bpm: float) -> tuple[float, float]:
    """Half/double `src_bpm` until it is within a tritone of `tgt_bpm`.
    Returns (folded_bpm, multiplier). 170 against 85 means "the same tempo", not "twice as
    fast", and a mashup that stretched 170 → 85 would smear the audio for nothing."""
    if src_bpm <= 0 or tgt_bpm <= 0:
        return src_bpm, 1.0
    mult = 1.0
    bpm = src_bpm
    for _ in range(3):
        if bpm / tgt_bpm > 1.45:
            bpm /= 2.0; mult /= 2.0
        elif tgt_bpm / bpm > 1.45:
            bpm *= 2.0; mult *= 2.0
        else:
            break
    return bpm, mult


# Pitch-class distance that always takes the short way round (−6…+5 semitones).
def key_distance(src_key: Optional[str], tgt_key: Optional[str]) -> Optional[int]:
    a, b = _pitch_class(src_key), _pitch_class(tgt_key)
    if a is None or b is None:
        return None
    d = (b - a) % 12
    return d - 12 if d > 6 else d


_FLATS = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#"}


def _pitch_class(key: Optional[str]) -> Optional[int]:
    if not key:
        return None
    tok = str(key).strip().split()[0].replace("♯", "#").replace("♭", "b")
    tok = _FLATS.get(tok, tok)
    return NOTES.index(tok) if tok in NOTES else None


def shift_key_name(key: Optional[str], semis: int) -> Optional[str]:
    pc = _pitch_class(key)
    if pc is None or not semis:
        return key
    rest = str(key).strip().split(" ", 1)
    quality = (" " + rest[1]) if len(rest) > 1 else ""
    return NOTES[(pc + semis) % 12] + quality


def align_nudge(target_grid: dict, source_grid: dict, factor: float,
                at_time: float = 0.0) -> dict:
    """How far to slide a source stem so its downbeats land on the target's.

    `factor` is the time-stretch already applied to the source (>1 = faster, so a source time
    t ends up at t / factor). Matching the first downbeat of each song would be the obvious
    thing, and it is wrong: real songs — including the ones this app generates — wobble around
    their own average tempo by tens of milliseconds, so an offset that nails bar 1 can be 100 ms
    out by bar 30. Instead every offset inside one bar is scored by the MEDIAN error across the
    whole overlap and the best one wins, and that median is returned so the UI can say how well
    the two songs really sit together. The answer is pushed positive at the end, because a
    Studio clip cannot start before zero.
    """
    import numpy as np
    tb = np.asarray(bar_lines(target_grid), dtype=float)
    sb = np.asarray(bar_lines(source_grid), dtype=float) / factor if factor > 0 else np.asarray([])
    bar = float(target_grid.get("bar_sec") or 0)
    blank = {"nudge_sec": 0.0, "nudge_ms": 0.0, "bar_sec": bar, "wrapped": False,
             "target_downbeat": None, "source_downbeat": None, "median_err_ms": None}
    if not len(tb) or not len(sb) or bar <= 0 or factor <= 0:
        return blank

    # Reference offset: the one that matches the first usable downbeat of each.
    t0 = float(nearest(list(tb), at_time)[0])
    s0 = float(sb[0])
    for t in sb:
        if t >= at_time - 1e-6:
            s0 = float(t)
            break
    first = math.fmod(t0 - s0, bar)

    def score(off):
        moved = sb + off
        lo, hi = max(tb[0], moved[0]), min(tb[-1], moved[-1])
        sel = tb[(tb >= lo) & (tb <= hi)]
        if len(sel) < 2:
            return None
        i = np.clip(np.searchsorted(moved, sel), 1, len(moved) - 1)
        err = np.minimum(np.abs(moved[i] - sel), np.abs(moved[i - 1] - sel))
        return float(np.median(err))

    best_off, best_err = first, score(first)
    for off in np.arange(0.0, bar, 0.001) - bar / 2 + math.fmod(first, bar):
        e = score(float(off))
        if e is not None and (best_err is None or e < best_err):
            best_off, best_err = float(off), e

    off = math.fmod(best_off, bar)
    if off > bar / 2:
        off -= bar
    elif off < -bar / 2:
        off += bar
    wrapped = False
    while off < 0:
        off += bar
        wrapped = True
    return {
        "nudge_sec": round(off, 5),
        "nudge_ms": round(off * 1000, 1),
        "raw_offset_ms": round(best_off * 1000, 1),
        "first_downbeat_offset_ms": round(first * 1000, 1),
        "median_err_ms": None if best_err is None else round(best_err * 1000, 1),
        "bar_sec": round(bar, 6),
        "wrapped": wrapped,
        "target_downbeat": round(t0, 4),
        "source_downbeat": round(s0 * factor, 4),
        "source_downbeat_stretched": round(s0, 4),
    }
