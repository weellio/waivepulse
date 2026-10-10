"""HTTP surface for the ACE-Step 1.5 engine.

Auto-mounted by app.py's `_mount_routers()` — nothing in app.py needs to change, and if
ACE-Step is half-installed or missing this module still imports, so the rest of WAIvePulse
behaves exactly as it did before.

Job shape and progress streaming deliberately mirror app.py's `sep_jobs` / `sep_logs` and
`/separate/progress/{id}`, so the Studio's existing SSE handling pattern carries straight
over: a dict per job with status/message, a list of log lines, and an event stream that
replays the log then sends `__done__`.

Endpoints
    GET  /acestep/status             installed? weights? VRAM? — in plain words
    POST /acestep/install            one-time setup, streams progress
    POST /acestep/describe           user instruction -> style description (local Ollama)
    POST /acestep/repaint            regenerate a time span; returns {ace_id}
    POST /acestep/cover              restyle the whole song; returns {ace_id}
    GET  /acestep/status/{ace_id}    job record
    GET  /acestep/progress/{ace_id}  SSE log stream
    GET  /acestep/patch/{ace_id}     the splice-ready clip (?tracks=N scales it, see below)
    GET  /acestep/preview/{ace_id}   the full song with the new section, for auditioning
"""

from __future__ import annotations

import asyncio
import json
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

try:
    from engines import acestep as engine
except Exception:  # pragma: no cover - keeps the app alive if the engine file is broken
    engine = None

router = APIRouter(prefix="/acestep", tags=["acestep"])

OUTPUTS_DIR = Path(__file__).resolve().parent.parent.parent / "outputs"

ace_jobs: dict = {}   # ace_id -> job dict   (same shape as app.py's sep_jobs)
ace_logs: dict = {}   # ace_id -> list[str] (same shape as app.py's sep_logs)

_install_lock = threading.Lock()
_install_state = {"running": False, "log": [], "done": False, "ok": None, "message": ""}

# One GPU, one job. The engine holds its own lock too; this one keeps the queue honest
# and lets /status say "busy" instead of silently stacking up work.
_run_lock = threading.Lock()


def _need_engine():
    if engine is None:
        raise HTTPException(status_code=503, detail="The ACE-Step engine module failed to load.")
    return engine


def _log_to(ace_id: str):
    def log(msg):
        for line in str(msg).splitlines():
            line = line.rstrip()
            if line:
                ace_logs.setdefault(ace_id, []).append(line)
        # Keep the newest line visible as the job's one-line status.
        if ace_id in ace_jobs and ace_logs.get(ace_id):
            ace_jobs[ace_id]["message"] = ace_logs[ace_id][-1][:200]
    return log


def _resolve_src(name: str) -> Path:
    """Map a client-supplied song reference onto a real file inside outputs/.

    The client sends whatever the job record calls `file` (or an /outputs/ URL). Only the
    basename is honoured, so a crafted value cannot reach outside outputs/.
    """
    if not name:
        raise HTTPException(status_code=400, detail="No source song given.")
    base = Path(str(name).replace("\\", "/")).name
    path = OUTPUTS_DIR / base
    try:
        path.resolve().relative_to(OUTPUTS_DIR.resolve())
    except Exception:
        raise HTTPException(status_code=400, detail="That source path is not allowed.")
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"{base} is not in your outputs folder.")
    return path


def _song_metadata(name: str) -> dict:
    """The song's own detected BPM and key, by matching the file back to its job record.

    Worth the lookup: a repainted span is spliced back between bars the listener already
    heard, so the patch has to agree with the song's tempo. ACE-Step takes bpm/keyscale as
    DiT conditioning, and app.py already measured both when the song was generated — we were
    simply throwing that away and letting the model choose a tempo for the patch.

    Silent by design: an imported MP3 has no job record and an older song may have no BPM, and
    neither is a reason to refuse a rewrite.
    """
    app = sys.modules.get("app")
    if app is None or not name:
        return {}
    base = Path(str(name).replace("\\", "/")).name
    for rec in (getattr(app, "jobs", {}) or {}).values():
        f = rec.get("file")
        if f and Path(str(f).replace("\\", "/")).name == base:
            out = {}
            if rec.get("bpm"):
                out["bpm"] = rec["bpm"]
            if rec.get("key"):
                out["keyscale"] = str(rec["key"])
            return out
    return {}


# ── Status ────────────────────────────────────────────────────────────────────
@router.get("/status")
def status():
    if engine is None:
        return {"installed": False, "ready": False, "reason": "The ACE-Step engine module failed to load.",
                "download_gb": 16, "busy": False}
    # "ready" means installed and weighted, NOT "the GPU happens to be free this second".
    # Starting a job evicts any resident Ollama model first, which routinely frees several
    # GB, so gating the button on a momentary reading would refuse work that would succeed.
    ok, reason = engine.available(check_vram=False)
    free, total = engine.nvidia_vram()
    vram_ok = free is None or free >= engine.MIN_FREE_VRAM_MB
    have_repo = (engine.ACE_REPO / "acestep").is_dir()
    have_venv = engine.ACE_VENV_PY.exists()
    have_weights = engine.weights_present()
    return {
        "installed": bool(have_repo and have_venv),
        "ready": bool(ok),
        "reason": reason,
        "source_present": have_repo,
        "python_present": have_venv,
        "weights_present": have_weights,
        "weights_gb": round(engine.weights_bytes() / 2**30, 2),
        "vram_free_mb": free,
        "vram_total_mb": total,
        "vram_needed_mb": engine.MIN_FREE_VRAM_MB,
        "vram_ok": bool(vram_ok),
        "install_root": str(engine.ACE_ROOT),
        "download_gb": 16,            # ~6 GB of libraries + ~9.4 GB of weights (measured)
        "busy": _run_lock.locked(),
        "installing": _install_state["running"],
        "license": "MIT (code and weights) — commercial use allowed",
    }


# ── One-time install ──────────────────────────────────────────────────────────
def _install_thread(skip_weights: bool):
    eng = engine

    def log(msg):
        for line in str(msg).splitlines():
            if line.strip():
                _install_state["log"].append(line.rstrip())
    try:
        ok, reason = eng.install(log, skip_weights=skip_weights)
        _install_state["ok"] = bool(ok)
        _install_state["message"] = reason
    except Exception as e:
        _install_state["ok"] = False
        _install_state["message"] = f"{type(e).__name__}: {e}"
        log(_install_state["message"])
    finally:
        _install_state["done"] = True
        _install_state["running"] = False


@router.post("/install")
def install(skip_weights: bool = Query(False, description="Set up code and libraries but skip the weight download")):
    """Start (or re-attach to) the one-time setup and stream its log as SSE."""
    _need_engine()
    with _install_lock:
        if not _install_state["running"]:
            _install_state.update({"running": True, "log": [], "done": False, "ok": None, "message": ""})
            threading.Thread(target=_install_thread, args=(skip_weights,), daemon=True).start()

    async def event_stream():
        sent = 0
        while True:
            log = _install_state["log"]
            while sent < len(log):
                yield f"data: {json.dumps(log[sent])}\n\n"
                sent += 1
            if _install_state["done"]:
                log = _install_state["log"]
                while sent < len(log):
                    yield f"data: {json.dumps(log[sent])}\n\n"
                    sent += 1
                yield f"data: {json.dumps('__' + ('ok' if _install_state['ok'] else 'failed') + '__ ' + _install_state['message'])}\n\n"
                yield "data: __done__\n\n"
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ── Instruction -> description (local Ollama) ─────────────────────────────────
_DESCRIBE_SYSTEM = (
    "You translate a music producer's instruction into a short style description for a "
    "text-to-music model. The model does NOT follow instructions; it regenerates audio from "
    "a description of the finished sound. Reply with ONE line of 4-12 comma-separated "
    "musical descriptors: genre, instruments, vocal type, mood, production. No sentences, no "
    "quotes, no explanation, no section names like 'chorus'."
)


class DescribeReq(BaseModel):
    instruction: str = ""
    tags: str = ""
    model: str = ""


@router.post("/describe")
def describe(req: DescribeReq):
    """Turn "make the chorus a gospel choir" into "gospel choir, Hammond organ, ...".

    ACE-Step is prompt-conditioned, so this translation is the difference between a usable
    feature and a lottery. The result is shown to the user and is editable — we never
    generate from a description the user has not seen.
    """
    instruction = (req.instruction or "").strip()
    if not instruction:
        raise HTTPException(status_code=400, detail="Nothing to describe.")

    model = req.model or ""
    if not model:
        try:
            with urllib.request.urlopen("http://127.0.0.1:11434/api/tags", timeout=4) as r:
                names = [m.get("name", "") for m in (json.loads(r.read().decode()) or {}).get("models", [])]
        except Exception as e:
            return {"ok": False, "description": instruction,
                    "reason": f"Ollama is not reachable, so the instruction is used as-is ({e})."}
        for pref in ("qwen2.5:7b-instruct", "qwen2.5", "llama3", "gemma3", "mistral"):
            hit = next((n for n in names if n.startswith(pref)), None)
            if hit:
                model = hit
                break
        if not model:
            usable = [n for n in names if "embed" not in n]
            model = usable[0] if usable else ""
        if not model:
            return {"ok": False, "description": instruction,
                    "reason": "Ollama has no usable text model, so the instruction is used as-is."}

    prompt = (f"{_DESCRIBE_SYSTEM}\n\nExisting song style: {req.tags or 'unknown'}\n"
              f"Instruction: {instruction}\n\nDescription:")
    try:
        body = json.dumps({"model": model, "prompt": prompt, "stream": False,
                           "keep_alive": 0,   # never leave a model resident on a shared 12 GB card
                           "options": {"temperature": 0.4, "num_predict": 120}}).encode()
        rq = urllib.request.Request("http://127.0.0.1:11434/api/generate", data=body,
                                    headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(rq, timeout=120) as r:
            text = (json.loads(r.read().decode()) or {}).get("response", "")
    except Exception as e:
        return {"ok": False, "description": instruction,
                "reason": f"Ollama failed, so the instruction is used as-is ({e})."}

    line = next((ln.strip(" -*\"'") for ln in (text or "").splitlines() if ln.strip()), "")
    if not line:
        return {"ok": False, "description": instruction,
                "reason": "The local model returned nothing, so the instruction is used as-is."}
    return {"ok": True, "description": line[:400], "model": model}


# ── Generation jobs ───────────────────────────────────────────────────────────
class RepaintReq(BaseModel):
    src: str                      # the job's stored filename, e.g. "Tacos_d911a5af.mp3"
    start_s: float
    end_s: float
    description: str = ""         # what the new section should sound like (shown + editable)
    tags: str = ""                # the song's existing style tags, prepended for continuity
    lyrics: str = ""
    strength: float = 0.6
    steps: int = 8
    seed: int = -1


class CoverReq(BaseModel):
    src: str
    description: str = ""
    strength: float = 0.6
    lyrics: str = ""
    steps: int = 8
    seed: int = -1


class TrackReq(BaseModel):
    """layer / accompany / isolate — the base-checkpoint multi-track jobs."""
    src: str
    kind: str                     # "layer" | "accompany" | "isolate"
    track: str                    # one of engines.acestep.TRACK_NAMES
    description: str = ""         # how the new part should sound (ignored by isolate)
    steps: int = 32               # base model: docs say 32-64
    guidance: float = 7.0         # real here; the turbo model forces this to 1.0
    seed: int = -1


def _start_job(kind: str, src: Path, run) -> str:
    ace_id = str(uuid.uuid4())[:8]
    ace_jobs[ace_id] = {
        "status": "queued", "message": "Queued", "kind": kind,
        "src": src.name, "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "metrics": {}, "patch": None, "preview": None,
    }
    ace_logs[ace_id] = []

    def worker():
        log = _log_to(ace_id)
        if not _run_lock.acquire(blocking=False):
            ace_jobs[ace_id].update(status="error",
                                    message="ACE-Step is already working on another section. Wait for it to finish.")
            return
        try:
            ace_jobs[ace_id]["status"] = "running"
            log(f"Starting {kind}…")
            run(log, ace_jobs[ace_id])
            ace_jobs[ace_id]["status"] = "done"
        except Exception as e:
            ace_jobs[ace_id]["status"] = "error"
            ace_jobs[ace_id]["message"] = str(e)
            log(f"Failed: {e}")
        finally:
            _run_lock.release()

    threading.Thread(target=worker, daemon=True).start()
    return ace_id


@router.post("/repaint")
def repaint(req: RepaintReq):
    eng = _need_engine()
    ok, reason = eng.available(check_vram=False)
    if not ok:
        raise HTTPException(status_code=503, detail=reason)
    src = _resolve_src(req.src)
    if req.end_s - req.start_s < 0.2:
        raise HTTPException(status_code=400, detail="Select at least 0.2 seconds of the song.")
    if not (req.description or "").strip():
        raise HTTPException(status_code=400, detail="Describe what the new section should sound like.")

    def run(log, job):
        out_dir = OUTPUTS_DIR / "acestep" / f"repaint_{time.strftime('%H%M%S')}"
        metrics: dict = {}
        meta = _song_metadata(req.src)
        if meta:
            log("Holding the rewrite to the song's own "
                + " and ".join(filter(None, [
                    f"tempo ({meta['bpm']} BPM)" if meta.get("bpm") else "",
                    f"key ({meta['keyscale']})" if meta.get("keyscale") else ""])))
        patch = eng.repaint(src, req.start_s, req.end_s, req.description, req.tags,
                           req.lyrics, req.strength, log=log, out_dir=out_dir,
                           seed=req.seed, steps=req.steps, metrics=metrics, **meta)
        job["patch"] = patch
        job["preview"] = metrics.get("preview")
        job["metrics"] = metrics
        job["message"] = (f"Done in {metrics.get('wall_s')}s, "
                          f"peak graphics memory {metrics.get('peak_vram_mb')} MB")

    return {"ace_id": _start_job("repaint", src, run)}


@router.post("/cover")
def cover(req: CoverReq):
    eng = _need_engine()
    ok, reason = eng.available(check_vram=False)
    if not ok:
        raise HTTPException(status_code=503, detail=reason)
    src = _resolve_src(req.src)
    if not (req.description or "").strip():
        raise HTTPException(status_code=400, detail="Describe the style you want.")

    def run(log, job):
        out_dir = OUTPUTS_DIR / "acestep" / f"cover_{time.strftime('%H%M%S')}"
        metrics: dict = {}
        path = eng.cover(src, req.description, req.strength, log=log, out_dir=out_dir,
                         lyrics=req.lyrics, seed=req.seed, steps=req.steps, metrics=metrics)
        job["preview"] = path
        job["metrics"] = metrics
        job["message"] = f"Done in {metrics.get('wall_s')}s"

    return {"ace_id": _start_job("cover", src, run)}


@router.get("/tracks")
def tracks():
    """What the multi-track jobs can do, and whether the weights for them are here."""
    eng = _need_engine()
    return {
        "ready": eng.base_weights_present(),
        "model": eng.BASE_MODEL,
        "download_gb": 4.5,
        "tracks": list(eng.TRACK_NAMES),
        "kinds": [
            {"id": "layer", "label": "Add a layer",
             "blurb": "Write a new part that plays along with the song."},
            {"id": "accompany", "label": "Build a backing track",
             "blurb": "Put a band behind a bare vocal or a sparse take."},
            {"id": "isolate", "label": "Isolate a track",
             "blurb": "Pull one instrument out of the mix. Reaches strings, brass, "
                      "woodwinds, synth and fx, which Demucs has no stem for — but it "
                      "rebuilds the part rather than separating it, so use Studio's "
                      "separation when one of its six stems is what you need."},
        ],
    }


@router.post("/track")
def track(req: TrackReq):
    eng = _need_engine()
    ok, reason = eng.available(check_vram=False)
    if not ok:
        raise HTTPException(status_code=503, detail=reason)
    if req.kind not in eng.TRACK_TASKS:
        raise HTTPException(status_code=400,
                            detail=f"kind must be one of: {', '.join(eng.TRACK_TASKS)}")
    if req.track not in eng.TRACK_NAMES:
        raise HTTPException(status_code=400,
                            detail=f"track must be one of: {', '.join(eng.TRACK_NAMES)}")
    if not eng.base_weights_present():
        raise HTTPException(
            status_code=503,
            detail="This needs the ACE-Step base model, a separate 4.5 GB download. "
                   "The installed turbo model has no weights for these three jobs.")
    src = _resolve_src(req.src)

    def run(log, job):
        out_dir = OUTPUTS_DIR / "acestep" / f"{req.kind}_{time.strftime('%H%M%S')}"
        metrics: dict = {}
        meta = _song_metadata(req.src)          # keep the new part in the song's tempo and key
        path = eng.track_job(req.kind, src, req.track, req.description, log=log,
                             out_dir=out_dir, steps=req.steps, guidance=req.guidance,
                             seed=req.seed, metrics=metrics, **meta)
        job["preview"] = path
        job["metrics"] = metrics
        job["message"] = f"Done in {metrics.get('wall_s')}s"

    return {"ace_id": _start_job(req.kind, src, run)}


@router.get("/status/{ace_id}")
def job_status(ace_id: str):
    if ace_id not in ace_jobs:
        raise HTTPException(status_code=404, detail="That ACE-Step job is not known.")
    return ace_jobs[ace_id]


@router.get("/progress/{ace_id}")
async def progress(ace_id: str):
    """SSE log stream — same shape as app.py's /separate/progress/{sep_id}."""
    async def event_stream():
        sent = 0
        while True:
            log = ace_logs.get(ace_id, [])
            while sent < len(log):
                yield f"data: {json.dumps(log[sent])}\n\n"
                sent += 1
            s = ace_jobs.get(ace_id, {}).get("status", "")
            if s in ("done", "error"):
                log = ace_logs.get(ace_id, [])
                while sent < len(log):
                    yield f"data: {json.dumps(log[sent])}\n\n"
                    sent += 1
                yield "data: __done__\n\n"
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(event_stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/patch/{ace_id}")
def patch(ace_id: str, tracks: int = Query(1, ge=1, le=32)):
    """The splice-ready clip, exactly as long as the selected region.

    `tracks` is how many timeline tracks the browser is about to splice this into. The
    Studio writes the SAME replacement audio into every stem, and the mix is their sum,
    so a full-mix patch dropped onto 6 stems would play back 6x too loud. Dividing by the
    track count makes the sum come out at unity. The trade-off is real and the panel says
    so: inside the new section the stems no longer hold separate instruments.
    """
    job = ace_jobs.get(ace_id)
    if not job or not job.get("patch"):
        raise HTTPException(status_code=404, detail="No patch for that job yet.")
    src = Path(job["patch"])
    if not src.exists():
        raise HTTPException(status_code=404, detail="The patch file is gone from disk.")
    if tracks <= 1:
        return FileResponse(str(src), media_type="audio/wav", filename="acestep_patch.wav")

    scaled = src.with_name(f"patch_x{tracks}.wav")
    if not scaled.exists():
        eng = _need_engine()
        data, sr = eng.read_audio(src)
        eng.write_audio(scaled, data / float(tracks), sr)
    return FileResponse(str(scaled), media_type="audio/wav", filename="acestep_patch.wav")


@router.get("/preview/{ace_id}")
def preview(ace_id: str):
    """The whole song with the new section in place — what Apply will sound like."""
    job = ace_jobs.get(ace_id)
    if not job or not job.get("preview"):
        raise HTTPException(status_code=404, detail="No preview for that job yet.")
    p = Path(job["preview"])
    if not p.exists():
        raise HTTPException(status_code=404, detail="The preview file is gone from disk.")
    return FileResponse(str(p), media_type="audio/wav", filename="acestep_preview.wav")
