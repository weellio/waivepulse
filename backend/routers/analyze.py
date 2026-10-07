"""HTTP surface for the Generate page's three entry points.

Mounted automatically by app.py's router scaffold — app.py itself is untouched.

    GET  /vibe/status                 what is installed, what it will cost to install
    POST /vibe/clap/download          fetch the CLAP weights (618 MB), once
    POST /vibe/reference              an uploaded clip  → tags + why
    POST /vibe/reference/{job_id}     one of your own songs → tags + why
    POST /vibe/vision/pull            pull qwen3-vl:4b (3.3 GB), once
    POST /vibe/image                  an uploaded picture → description → tags + theme
    GET  /vibe/tiers                  the tier table with its measured seconds
    POST /vibe/tier                   choose the tier the next generation runs at
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

import analyze as engine

MAX_AUDIO_BYTES = 80 * 1024 * 1024
MAX_IMAGE_BYTES = 20 * 1024 * 1024
AUDIO_SUFFIXES = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus", ".wma", ".aiff", ".aif"}
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}

_download_lock = threading.Lock()


def _startup():
    """Wrap app._run_generation so the tier control actually reaches the model.

    Runs after app.py has finished importing, which is why it cannot be done at
    module import time (the router is mounted a hundred lines before
    ``_run_generation`` exists).
    """
    if engine._hook_state["generation"]:
        return
    ok = engine.install_generation_hook()
    print(f"[waivepulse] vibe: tier hook {'installed' if ok else 'NOT installed'}",
          flush=True)


router = APIRouter(prefix="/vibe", tags=["vibe"], on_startup=[_startup])


# ── helpers ───────────────────────────────────────────────────────────────────
def _categories(raw: Optional[str]) -> Dict[str, List[str]]:
    """The Generate page sends its own TAG_CATEGORIES so the server can never
    invent a tag the picker does not have."""
    if not raw:
        raise HTTPException(status_code=400,
                            detail="categories (the page's tag vocabulary) is required")
    try:
        parsed = json.loads(raw)
    except Exception:
        raise HTTPException(status_code=400, detail="categories must be JSON")
    if not isinstance(parsed, dict) or not parsed:
        raise HTTPException(status_code=400, detail="categories must be a non-empty object")
    out: Dict[str, List[str]] = {}
    for cat, tags in parsed.items():
        if isinstance(tags, list):
            out[str(cat)] = [str(t) for t in tags if str(t).strip()]
    if not out:
        raise HTTPException(status_code=400, detail="categories contained no tags")
    return out


async def _save_upload(upload: UploadFile, allowed: set, limit: int, kind: str) -> str:
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"{upload.filename or kind} is empty")
    if len(data) > limit:
        raise HTTPException(status_code=413,
                            detail=f"{kind} is {len(data) // 1_000_000} MB; "
                                   f"the limit is {limit // 1_000_000} MB")
    suffix = Path(upload.filename or "").suffix.lower()
    if suffix not in allowed:
        raise HTTPException(
            status_code=400,
            detail=f"{suffix or 'that file'} is not a {kind} this can read "
                   f"({', '.join(sorted(allowed))})")
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(data)
        return tmp.name


def _job_audio(job_id: str) -> str:
    app = engine._app_module()
    if app is None:
        raise HTTPException(status_code=503, detail="app module not ready")
    job = app.jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"No song {job_id} in the library")
    rel = job.get("file")
    if not rel:
        raise HTTPException(status_code=400,
                            detail=f"{job.get('title') or job_id} has no audio file yet")
    path = app.OUTPUTS_DIR / Path(str(rel)).name
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{path.name} is missing from outputs/")
    return str(path)


# ── status ────────────────────────────────────────────────────────────────────
@router.get("/status")
def status() -> Dict[str, Any]:
    import importlib.util
    clap = engine.clap_status()
    vision = engine.vision_status()
    probe = engine.librosa_ok()
    return {
        "librosa": probe["ok"],
        "librosa_error": probe["error"],
        "transformers": importlib.util.find_spec("transformers") is not None,
        "clap": clap,
        "vision": vision,
        "tiers": engine.tier_payload(),
        "skipped_categories": list(engine.SKIPPED_CATEGORIES),
    }


@router.post("/clap/download")
def clap_download() -> Dict[str, Any]:
    """Fetch the CLAP weights. One-off, ~618 MB, goes to the usual Hugging Face
    cache (HF_HUB_CACHE / HF_HOME — never the C: drive on this machine)."""
    with _download_lock:
        try:
            path = engine._clap_path(download=True)
        except Exception as exc:
            raise HTTPException(status_code=502, detail=f"CLAP download failed: {exc}")
    size = 0
    for root, _dirs, files in os.walk(path):
        for f in files:
            try:
                size += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return {"ok": True, "path": path, "bytes": size, "mb": round(size / 1e6, 1)}


# ── 1. sounds like this ───────────────────────────────────────────────────────
@router.post("/reference")
async def reference_upload(file: UploadFile = File(...),
                           categories: str = Form(...)) -> Dict[str, Any]:
    cats = _categories(categories)
    path = await _save_upload(file, AUDIO_SUFFIXES, MAX_AUDIO_BYTES, "audio file")
    try:
        result = engine.analyze_reference(path, cats)
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read that clip: {exc}")
    finally:
        Path(path).unlink(missing_ok=True)
    result["source"] = file.filename or "upload"
    return result


class JobReferenceRequest(BaseModel):
    categories: dict = {}


@router.post("/reference/{job_id}")
def reference_job(job_id: str, req: JobReferenceRequest) -> Dict[str, Any]:
    cats = _categories(json.dumps(req.categories))
    path = _job_audio(job_id)
    try:
        result = engine.analyze_reference(path, cats)
    except HTTPException:
        raise
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read that song: {exc}")
    result["source"] = Path(path).name
    result["job_id"] = job_id
    return result


# ── 2. from a picture ─────────────────────────────────────────────────────────
@router.post("/vision/pull")
def vision_pull() -> Dict[str, Any]:
    """Pull the vision model through Ollama. Blocking — the UI says what it is
    downloading and how big it is before this is called."""
    body = json.dumps({"model": engine.VISION_MODEL, "stream": False}).encode()
    req = urllib.request.Request(engine.OLLAMA + "/api/pull", data=body,
                                 headers={"Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=3600) as r:
            payload = json.loads(r.read().decode("utf-8", "replace") or "{}")
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Pulling {engine.VISION_MODEL} failed: {exc}")
    if str(payload.get("status", "")).lower() not in ("success", ""):
        raise HTTPException(status_code=502,
                            detail=f"Ollama said: {payload.get('status')}")
    return {"ok": True, "model": engine.VISION_MODEL, "status": engine.vision_status()}


@router.post("/image")
async def image_upload(file: UploadFile = File(...),
                       categories: str = Form(...)) -> Dict[str, Any]:
    cats = _categories(categories)
    path = await _save_upload(file, IMAGE_SUFFIXES, MAX_IMAGE_BYTES, "image")
    try:
        b64 = base64.b64encode(Path(path).read_bytes()).decode("ascii")
        result = engine.analyze_image(b64, cats)
    except HTTPException:
        raise
    except engine.OllamaError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Could not read that picture: {exc}")
    finally:
        Path(path).unlink(missing_ok=True)
    result["source"] = file.filename or "upload"
    return result


# ── 3. tiers ──────────────────────────────────────────────────────────────────
@router.get("/tiers")
def tiers() -> Dict[str, Any]:
    return engine.tier_payload()


class TierRequest(BaseModel):
    tier: str


@router.post("/tier")
def choose_tier(req: TierRequest) -> Dict[str, Any]:
    try:
        name = engine.set_tier(req.tier)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    engine.install_generation_hook()          # idempotent; covers a missed startup
    payload = engine.tier_payload()
    applied = engine.TIERS.get(name)
    return {"ok": True, "tier": name, "applies": applied, "hooks": payload["hooks"]}
