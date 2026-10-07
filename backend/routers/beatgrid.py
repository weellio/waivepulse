"""Beat-grid endpoints + the two Suno-v6-style workflows that are really just packaging.

Everything heavy already existed in WAIvePulse: Demucs six-stem separation, a stem library
spanning every separated song, server-side time-stretch with the pitch preserved, per-track
key change, splice-with-crossfades. What was missing was a bar grid and a WORKFLOW. This
router adds the grid (backend/beatgrid.py) and two thin orchestrations over it:

  **Mashup** — POST /beatgrid/mashup/plan answers "vocals from A, drums from B, bass from C
  against this song's tempo and key": per role it returns the stretch factor, the semitone
  shift and the downbeat nudge in ms. The Studio then calls the EXISTING /timestretch and
  /pitchshift endpoints and drops each stem on its own ordinary track, so nothing is a
  black box and every number is visible and undoable.

  **Sample this** — GET /beatgrid/sample/... cuts a ruler selection out of one isolated stem
  (or the full mix), rounded out to whole bars using the grid, and reports the BPM, key,
  bar count and how far each edge moved in the response headers, so the Looper can come up
  already in time and in key.

Mounted automatically by backend/app.py's router scaffold (anything in backend/routers/*.py
exporting `router`), so app.py is untouched.
"""

from __future__ import annotations

import importlib
import io
import re
import sys
import tempfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, UploadFile, File as FastAPIFile
from fastapi.responses import Response
from pydantic import BaseModel

import beatgrid

router = APIRouter(prefix="/beatgrid", tags=["beatgrid"])

_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
MAX_UPLOAD = 120 * 1024 * 1024


# ── Reaching into the app without importing it at module level ────────────────
# The router scaffold imports this file while app.py is still executing, so `jobs`,
# `sep_jobs` and OUTPUTS_DIR do not exist yet. Endpoints run long after that, so the
# lookup is deferred to call time.
def _app():
    m = sys.modules.get("app")
    if m is None:
        m = importlib.import_module("app")
    return m


def _outputs() -> Path:
    return Path(_app().OUTPUTS_DIR)


def _safe(value: str, what: str) -> str:
    if not value or not _SAFE_ID.match(value):
        raise HTTPException(status_code=400, detail=f"Invalid {what}")
    return value


def _sep_record(sep_id: str) -> dict:
    app = _app()
    sep = app.sep_jobs.get(sep_id)
    if sep is None and hasattr(app, "_recover_sep"):
        try:
            if app._recover_sep(sep_id):
                sep = app.sep_jobs.get(sep_id)
        except Exception:
            sep = None
    if sep is None:
        raise HTTPException(status_code=404, detail="Separation not found")
    return sep


def _stem_file(sep_id: str, stem_name: str) -> Path:
    """The stem's file on disk, kept inside outputs/sep_<id>/ (no globs, no traversal)."""
    _safe(sep_id, "separation id")
    _safe(stem_name, "stem name")
    _sep_record(sep_id)
    base = (_outputs() / f"sep_{sep_id}").resolve()
    if not base.is_dir():
        raise HTTPException(status_code=404, detail="Separation folder is gone from outputs/")
    hits = list(base.rglob(f"{stem_name}.mp3")) + list(base.rglob(f"{stem_name}.wav")) \
        + list(base.rglob(f"{stem_name}.flac"))
    hits = [h for h in hits if base in h.resolve().parents]
    if not hits:
        raise HTTPException(status_code=404, detail=f"Stem '{stem_name}' not found")
    return hits[0]


def _song_file(job_id: str) -> Path:
    """The mixdown for a job id. Beat tracking is most reliable on the full mix, so the
    grid for a separation is taken from its source song, then reused for every stem —
    they share one timeline."""
    _safe(job_id, "job id")
    job = _app().jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Song not found")
    rel = (job.get("file") or "").lstrip("/")
    if not rel:
        raise HTTPException(status_code=404, detail="Song has no audio file")
    out = _outputs().resolve()
    p = (out.parent / rel).resolve() if rel.startswith("outputs/") else (out / Path(rel).name).resolve()
    if out not in p.parents or not p.is_file():
        raise HTTPException(status_code=404, detail="Song audio file is missing from outputs/")
    return p


def _job_of_sep(sep_id: str) -> tuple[str, dict]:
    sep = _sep_record(sep_id)
    job_id = sep.get("job_id") or ""
    return job_id, (_app().jobs.get(job_id) or {})


def _grid(path: Path, force: bool = False, with_key: bool = True) -> dict:
    try:
        return beatgrid.analyze_file(path, with_key=with_key, force=force)
    except RuntimeError as e:
        raise HTTPException(status_code=501, detail=str(e))
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Audio file not found")
    except Exception as e:
        import traceback
        traceback.print_exc()          # the console gets the whole story, the client a line
        try:
            beatgrid.CACHE_DIR.mkdir(parents=True, exist_ok=True)
            (beatgrid.CACHE_DIR / "last_error.txt").write_text(traceback.format_exc(), "utf-8")
        except Exception:
            pass
        raise HTTPException(status_code=500, detail=f"Beat tracking failed: {type(e).__name__}: {e}")


def _slim(grid: dict) -> dict:
    """The grid without the full beat list — plenty for a plan response."""
    return {k: v for k, v in grid.items() if k != "beats"}


# ── Status ────────────────────────────────────────────────────────────────────
@router.get("/status")
def beatgrid_status():
    """Which tracker is in use and why — the UI prints this verbatim so it can be honest."""
    info = beatgrid.tracker_info()
    info["cache_dir"] = str(beatgrid.CACHE_DIR)
    try:
        info["cached_files"] = len(list(beatgrid.CACHE_DIR.glob("*.json")))
    except Exception:
        info["cached_files"] = 0
    return info


@router.post("/cache/clear")
def beatgrid_cache_clear():
    return {"removed": beatgrid.clear_cache()}


# ── Analysis ──────────────────────────────────────────────────────────────────
@router.get("/song/{job_id}")
def grid_for_song(job_id: str, force: bool = Query(False)):
    grid = _grid(_song_file(job_id), force=force)
    job = _app().jobs.get(job_id) or {}
    grid["stored_bpm"] = job.get("bpm")
    grid["stored_key"] = job.get("key")
    grid["title"] = job.get("title")
    return grid


@router.get("/sep/{sep_id}")
def grid_for_sep(sep_id: str, force: bool = Query(False)):
    """Grid for a separation — measured on its source mix, which every stem shares."""
    job_id, job = _job_of_sep(sep_id)
    grid = _grid(_song_file(job_id), force=force) if job_id else {}
    if not grid:
        raise HTTPException(status_code=404, detail="That separation has no source song on disk")
    grid["stored_bpm"] = job.get("bpm")
    grid["stored_key"] = job.get("key")
    grid["title"] = job.get("title") or _sep_record(sep_id).get("title")
    grid["sep_id"] = sep_id
    grid["job_id"] = job_id
    return grid


@router.get("/stem/{sep_id}/{stem_name}")
def grid_for_stem(sep_id: str, stem_name: str, force: bool = Query(False)):
    """Grid measured on the isolated stem itself. Useful for drums (crisper onsets) and to
    show when a stem alone is untrackable (a pad, a vocal with no percussion)."""
    grid = _grid(_stem_file(sep_id, stem_name), force=force, with_key=False)
    grid["sep_id"] = sep_id
    grid["stem"] = stem_name
    return grid


@router.post("/analyze")
async def grid_for_upload(file: UploadFile = FastAPIFile(...)):
    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="File is too large to analyse")
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as t:
        t.write(data)
        tmp = Path(t.name)
    try:
        return _grid(tmp)
    finally:
        tmp.unlink(missing_ok=True)


# ── Mashup plan ───────────────────────────────────────────────────────────────
class MashupRole(BaseModel):
    role: str                       # which track slot this fills (vocals, drums, bass…)
    sep_id: str                     # the separation the audio comes from
    stem: str                       # the stem inside it
    title: Optional[str] = None


class MashupRequest(BaseModel):
    target_sep_id: Optional[str] = None      # the song already open in the Studio
    target_job_id: Optional[str] = None
    target_bpm: Optional[float] = None       # override: build at this tempo instead
    target_key: Optional[str] = None         # override: build in this key instead
    roles: list[MashupRole] = []
    match_tempo: bool = True
    match_key: bool = True
    align_downbeats: bool = True
    force: bool = False


@router.post("/mashup/plan")
def mashup_plan(req: MashupRequest):
    """Work out, per role, exactly what has to happen to the source stem: the stretch
    factor for /timestretch, the semitones for /pitchshift and the downbeat nudge in ms.

    The Studio then performs each step with the endpoints that already exist, so what lands
    on the timeline is six ordinary tracks the user can mix, re-stretch or undo.
    """
    if not req.roles:
        raise HTTPException(status_code=400, detail="Pick at least one stem")
    if len(req.roles) > 12:
        raise HTTPException(status_code=400, detail="Too many roles")

    target_job = req.target_job_id
    if not target_job and req.target_sep_id:
        target_job = _job_of_sep(req.target_sep_id)[0]
    if not target_job:
        raise HTTPException(status_code=400, detail="No target song given")

    tgrid = _grid(_song_file(target_job), force=req.force)
    tjob = _app().jobs.get(target_job) or {}
    target_bpm = float(req.target_bpm or tgrid.get("bpm") or tjob.get("bpm") or 0)
    target_key = req.target_key or tgrid.get("key") or tjob.get("key")
    if target_bpm <= 0:
        raise HTTPException(status_code=422, detail="Could not establish a target tempo")

    warnings = list(tgrid.get("warnings") or [])
    if tgrid.get("confidence", 0) < 0.6:
        warnings.append(f"the grid for the base song is {tgrid.get('confidence_label')} "
                        f"({tgrid.get('confidence'):.2f}) — alignment is a starting point, "
                        "not a guarantee")

    plans = []
    for role in req.roles:
        _safe(role.sep_id, "separation id")
        _safe(role.stem, "stem name")
        try:
            _stem_file(role.sep_id, role.stem)                 # 404 early if it is gone
            sjob_id, sjob = _job_of_sep(role.sep_id)
            sgrid = _grid(_song_file(sjob_id), force=req.force)
        except HTTPException as e:
            plans.append({"role": role.role, "sep_id": role.sep_id, "stem": role.stem,
                          "ok": False, "error": e.detail})
            continue

        src_bpm = float(sgrid.get("bpm") or sjob.get("bpm") or 0)
        src_key = sgrid.get("key") or sjob.get("key")
        title = role.title or sjob.get("title") or role.sep_id

        same_song = (role.sep_id == req.target_sep_id) or (sjob_id == target_job)

        folded_bpm, octave_mult = beatgrid.octave_fold(src_bpm, target_bpm) if src_bpm else (0.0, 1.0)
        factor = 1.0
        if req.match_tempo and folded_bpm > 0 and not same_song:
            factor = target_bpm / folded_bpm                   # >1 = faster (app.py convention)
            factor = max(0.25, min(4.0, factor))
            if abs(factor - 1.0) < 0.004:
                factor = 1.0

        semis = 0
        if req.match_key and not same_song:
            d = beatgrid.key_distance(src_key, target_key)
            if d:
                semis = max(-12, min(12, int(d)))

        align = {"nudge_sec": 0.0, "nudge_ms": 0.0, "wrapped": False}
        if req.align_downbeats and not same_song:
            align = beatgrid.align_nudge(tgrid, sgrid, factor or 1.0, at_time=0.0)

        notes = []
        if same_song:
            notes.append("already in this song — kept as it is")
        else:
            if factor != 1.0:
                notes.append(f"{src_bpm:.0f} → {target_bpm:.0f} BPM (stretch ×{factor:.4f}"
                             + (f", counted at half/double time ×{octave_mult:g}" if octave_mult != 1 else "")
                             + ")")
            elif req.match_tempo:
                notes.append(f"tempo already matches ({src_bpm:.0f} BPM)")
            if semis:
                notes.append(f"{semis:+d} semitone{'s' if abs(semis) != 1 else ''} "
                             f"({src_key} → {beatgrid.shift_key_name(src_key, semis)})")
            elif req.match_key:
                notes.append(f"key already matches ({src_key or 'unknown'})")
            if req.align_downbeats and align.get("nudge_ms"):
                notes.append(f"nudged {align['nudge_ms']:.0f} ms onto the downbeat"
                             + (" (forward a bar, a clip cannot start before zero)" if align.get("wrapped") else ""))
            if req.align_downbeats and align.get("median_err_ms") is not None:
                notes.append(f"downbeats then line up to ±{align['median_err_ms']:.0f} ms")
        stem_warn = list(sgrid.get("warnings") or [])
        if align.get("median_err_ms") is not None and align["median_err_ms"] > 40:
            stem_warn.append(
                f"the two songs only line up to ±{align['median_err_ms']:.0f} ms — neither keeps a "
                "perfectly steady tempo, so expect to nudge this clip by ear in places")
        if sgrid.get("confidence", 0) < 0.6:
            stem_warn.append(f"this song's grid is {sgrid.get('confidence_label')} "
                             f"({sgrid.get('confidence'):.2f}) — expect to nudge by ear")

        plans.append({
            "ok": True,
            "role": role.role, "sep_id": role.sep_id, "stem": role.stem,
            "job_id": sjob_id, "title": title, "same_song": same_song,
            "stem_url": f"/stems/{role.sep_id}/{role.stem}.mp3",
            "source_bpm": round(src_bpm, 2) or None,
            "source_bpm_folded": round(folded_bpm, 2) or None,
            "octave_multiplier": octave_mult,
            "source_key": src_key,
            "target_bpm": round(target_bpm, 2),
            "target_key": target_key,
            "stretch_factor": round(factor, 6),
            "result_bpm": round((src_bpm * factor) if src_bpm else 0, 2) or None,
            "semitones": semis,
            "result_key": beatgrid.shift_key_name(src_key, semis) if semis else src_key,
            "nudge_sec": align.get("nudge_sec", 0.0),
            "nudge_ms": align.get("nudge_ms", 0.0),
            "nudge_wrapped": align.get("wrapped", False),
            "align_median_err_ms": align.get("median_err_ms"),
            "target_downbeat": align.get("target_downbeat"),
            "source_downbeat": align.get("source_downbeat"),
            "source_downbeat_stretched": align.get("source_downbeat_stretched"),
            "summary": " · ".join(notes) if notes else "nothing to change",
            "grid": _slim(sgrid),
            "warnings": stem_warn,
            # The exact calls the Studio should make, in order. No hidden steps.
            "steps": ([] if factor == 1.0 else
                      [{"op": "timestretch", "url": f"/timestretch/{role.sep_id}/{role.stem}?factor={factor:.6f}"}])
                     + ([] if semis == 0 else [{"op": "pitchshift", "semitones": semis}]),
        })

    return {
        "target": {"job_id": target_job, "sep_id": req.target_sep_id,
                   "title": tjob.get("title"), "bpm": round(target_bpm, 2), "key": target_key,
                   "grid": _slim(tgrid)},
        "tracker": beatgrid.tracker_info()["label"],
        "roles": plans,
        "warnings": warnings,
    }


# ── Sample this ───────────────────────────────────────────────────────────────
def _wav_bytes(y, sr: int, bits: int = 16) -> bytes:
    import numpy as np
    import soundfile as sf
    buf = io.BytesIO()
    data = np.ascontiguousarray(y.T if y.ndim == 2 else y[:, None])
    sf.write(buf, data, int(sr), subtype="PCM_24" if bits == 24 else "PCM_16", format="WAV")
    return buf.getvalue()


def _load(path: Path):
    """(channels, n) float32 + sample rate — reuses app.py's decoder (soundfile + ffmpeg)."""
    app = _app()
    if hasattr(app, "_load_audio"):
        return app._load_audio(str(path))
    import numpy as np
    import soundfile as sf
    d, fs = sf.read(str(path), dtype="float32", always_2d=True)
    return np.ascontiguousarray(d.T), int(fs)


def _cut(path: Path, grid: dict, start: float, end: float, snap: str,
         min_bars: int, fade_ms: float, bits: int):
    import numpy as np
    if end <= start:
        raise HTTPException(status_code=400, detail="The selection has no length")

    if snap == "bar":
        snapped = beatgrid.snap_region(grid, start, end, min_bars=min_bars)
    elif snap == "beat":
        lines = grid.get("beats") or []
        s, ds = beatgrid.nearest(lines, start)
        e, de = beatgrid.nearest(lines, end)
        s = start if s is None else s
        e = end if e is None else e
        snapped = {"start": round(s, 4), "end": round(e, 4), "snapped": True,
                   "bars": round((e - s) / (grid.get("bar_sec") or 1), 2),
                   "start_shift_ms": round((s - start) * 1000, 1),
                   "end_shift_ms": round((e - end) * 1000, 1),
                   "bar_sec": grid.get("bar_sec"), "beat_sec": grid.get("beat_sec"),
                   "beats_per_bar": grid.get("beats_per_bar")}
    else:
        snapped = {"start": round(start, 4), "end": round(end, 4), "snapped": False,
                   "bars": round((end - start) / (grid.get("bar_sec") or 1), 2),
                   "start_shift_ms": 0.0, "end_shift_ms": 0.0,
                   "bar_sec": grid.get("bar_sec"), "beat_sec": grid.get("beat_sec"),
                   "beats_per_bar": grid.get("beats_per_bar")}

    y, sr = _load(path)
    n = y.shape[-1]
    a = max(0, int(round(snapped["start"] * sr)))
    b = min(n, int(round(snapped["end"] * sr)))
    if b - a < 16:
        raise HTTPException(status_code=400, detail="That snapped region is empty — "
                                                   "drag a wider selection")
    clip = np.array(y[:, a:b], dtype="float32", copy=True)

    # A couple of ms of fade so a bar-exact cut cannot click at the loop point.
    f = int(max(0.0, fade_ms) * sr / 1000)
    f = min(f, (b - a) // 4)
    if f > 1:
        ramp = np.linspace(0.0, 1.0, f, dtype="float32")
        clip[:, :f] *= ramp
        clip[:, -f:] *= ramp[::-1]

    return clip, sr, snapped


def _sample_headers(grid: dict, snapped: dict, extra: dict) -> dict:
    h = {
        "X-Sample-Start": f"{snapped['start']:.4f}",
        "X-Sample-End": f"{snapped['end']:.4f}",
        "X-Sample-Bars": str(snapped.get("bars")),
        "X-Sample-Snapped": "1" if snapped.get("snapped") else "0",
        "X-Sample-Start-Shift-Ms": str(snapped.get("start_shift_ms")),
        "X-Sample-End-Shift-Ms": str(snapped.get("end_shift_ms")),
        "X-Sample-Bar-Sec": str(snapped.get("bar_sec")),
        "X-Sample-Beats-Per-Bar": str(snapped.get("beats_per_bar")),
        "X-Sample-Bpm": str(grid.get("bpm")),
        "X-Sample-Key": str(grid.get("key") or ""),
        "X-Beatgrid-Tracker": str(grid.get("tracker")),
        "X-Beatgrid-Confidence": str(grid.get("confidence")),
        "X-Beatgrid-Confidence-Label": str(grid.get("confidence_label")),
        "X-Beatgrid-Downbeats-Estimated": "1" if grid.get("downbeats_estimated") else "0",
        # Everything above, in one header, so the browser needs no CORS-exposed list.
        "Access-Control-Expose-Headers": "*",
    }
    h.update({k: str(v) for k, v in extra.items()})
    return h


@router.get("/sample/stem/{sep_id}/{stem_name}")
def sample_stem(sep_id: str, stem_name: str,
                start: float = Query(..., ge=0), end: float = Query(..., gt=0),
                snap: str = Query("bar", pattern="^(bar|beat|none)$"),
                min_bars: int = Query(1, ge=1, le=64),
                fade_ms: float = Query(3.0, ge=0, le=100),
                bits: int = Query(16)):
    """One isolated stem, trimmed to whole bars around the ruler selection.

    The grid comes from the full mix (every stem shares that timeline), so a vocal with no
    percussion still snaps to the song's real bars.
    """
    path = _stem_file(sep_id, stem_name)
    job_id, job = _job_of_sep(sep_id)
    grid = _grid(_song_file(job_id)) if job_id else _grid(path)
    clip, sr, snapped = _cut(path, grid, start, end, snap, min_bars, fade_ms, bits)
    name = f"{(job.get('title') or 'sample')}_{stem_name}_{snapped['start']:.2f}s"
    name = re.sub(r"[^\w.-]+", "_", name)
    return Response(
        content=_wav_bytes(clip, sr, bits), media_type="audio/wav",
        headers=_sample_headers(grid, snapped, {
            "X-Sample-Name": name, "X-Sample-Stem": stem_name, "X-Sample-Sep": sep_id,
            "Content-Disposition": f'attachment; filename="{name}.wav"'}),
    )


@router.get("/sample/song/{job_id}")
def sample_song(job_id: str,
                start: float = Query(..., ge=0), end: float = Query(..., gt=0),
                snap: str = Query("bar", pattern="^(bar|beat|none)$"),
                min_bars: int = Query(1, ge=1, le=64),
                fade_ms: float = Query(3.0, ge=0, le=100),
                bits: int = Query(16)):
    """The same cut, but from the full mix (no stem isolation)."""
    path = _song_file(job_id)
    grid = _grid(path)
    clip, sr, snapped = _cut(path, grid, start, end, snap, min_bars, fade_ms, bits)
    job = _app().jobs.get(job_id) or {}
    name = re.sub(r"[^\w.-]+", "_", f"{(job.get('title') or 'sample')}_mix_{snapped['start']:.2f}s")
    return Response(
        content=_wav_bytes(clip, sr, bits), media_type="audio/wav",
        headers=_sample_headers(grid, snapped, {
            "X-Sample-Name": name, "X-Sample-Stem": "mix", "X-Sample-Job": job_id,
            "Content-Disposition": f'attachment; filename="{name}.wav"'}),
    )


@router.get("/snap")
def snap_preview(sep_id: Optional[str] = None, job_id: Optional[str] = None,
                 start: float = Query(..., ge=0), end: float = Query(..., gt=0),
                 min_bars: int = Query(1, ge=1, le=64)):
    """What a bar-snap WOULD do, without cutting any audio — this is what the Sample panel
    shows while the user drags the selection."""
    if sep_id:
        job_id = _job_of_sep(sep_id)[0]
    if not job_id:
        raise HTTPException(status_code=400, detail="Give sep_id or job_id")
    grid = _grid(_song_file(job_id))
    snapped = beatgrid.snap_region(grid, start, end, min_bars=min_bars)
    snapped["grid"] = _slim(grid)
    return snapped
