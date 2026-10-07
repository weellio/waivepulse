"""Song Check endpoints — what is wrong with this render, and which panel fixes it.

Mounted automatically by backend/app.py's router scaffold (anything in backend/routers/*.py
exporting `router`), so app.py is untouched.

GET /songcheck/{job_id}   analyse a finished song from the library
POST /songcheck/upload    analyse any file the user drops in

The analysis is pure numpy over the decoded audio: no GPU, no model, no network, so it runs
while a generation is in flight. When a Demucs separation already exists for the song we pass
its stems in, which is the only way the instrumental-dropout check can say anything honest.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, File as FastAPIFile, HTTPException, UploadFile

import songcheck as engine

router = APIRouter(prefix="/songcheck", tags=["songcheck"])

MAX_UPLOAD = 80 * 1024 * 1024
AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".aiff", ".aif"}


def _app():
    return sys.modules.get("app")


def _song_path(job_id: str) -> Path:
    """The mp3 for a finished job, via the same record the Library renders from."""
    app = _app()
    if app is None:
        raise HTTPException(status_code=503, detail="app not loaded")
    rec = (getattr(app, "jobs", {}) or {}).get(job_id)
    if not rec:
        raise HTTPException(status_code=404, detail=f"no such song: {job_id}")
    rel = rec.get("file")
    if not rel:
        raise HTTPException(status_code=409,
                            detail="that song has no audio file yet")
    path = Path(app.OUTPUTS_DIR) / Path(str(rel)).name
    if not path.exists():
        raise HTTPException(status_code=410, detail=f"the file is gone: {path.name}")
    return path


def _stems_for(job_id: str) -> Optional[Dict[str, str]]:
    """Stems from an existing separation for this song, if one was ever run.

    Never triggers a separation: Demucs needs the GPU and several minutes, and Song Check
    promises to be instant. Without stems the dropout check simply stays quiet.
    """
    app = _app()
    if app is None:
        return None
    seps = getattr(app, "sep_jobs", {}) or {}
    for sep in seps.values():
        if sep.get("job_id") != job_id or sep.get("status") != "done":
            continue
        out: Dict[str, str] = {}
        for role, url in (sep.get("stems") or {}).items():
            parts = Path(str(url)).parts            # /stems/<sep_id>/<name>
            if len(parts) >= 2:
                p = Path(app.OUTPUTS_DIR) / f"sep_{parts[-2]}" / parts[-1]
                hits = list(p.parent.rglob(p.name)) if p.parent.exists() else []
                if hits:
                    out[role] = str(hits[0])
        if out:
            return out
    return None


@router.get("/{job_id}")
def check_song(job_id: str) -> Dict[str, Any]:
    path = _song_path(job_id)
    try:
        result = engine.check(str(path), stems=_stems_for(job_id))
    except Exception as exc:                                     # noqa: BLE001
        raise HTTPException(status_code=500,
                            detail=f"{type(exc).__name__}: {exc}") from exc
    app = _app()
    rec = (getattr(app, "jobs", {}) or {}).get(job_id) or {}
    result["title"] = rec.get("title") or path.stem
    result["job_id"] = job_id
    return result


@router.post("/upload")
async def check_upload(file: UploadFile = FastAPIFile(...)) -> Dict[str, Any]:
    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in AUDIO_SUFFIXES:
        raise HTTPException(status_code=400,
                            detail=f"unsupported audio type: {suffix or 'none'}")
    data = await file.read()
    if len(data) > MAX_UPLOAD:
        raise HTTPException(status_code=413, detail="file larger than 80 MB")
    tmp = Path(tempfile.gettempdir()) / f"wv_songcheck{suffix}"
    tmp.write_bytes(data)
    try:
        result = engine.check(str(tmp))
    except Exception as exc:                                     # noqa: BLE001
        raise HTTPException(status_code=500,
                            detail=f"{type(exc).__name__}: {exc}") from exc
    finally:
        tmp.unlink(missing_ok=True)
    result["title"] = file.filename
    return result
