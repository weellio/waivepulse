"""Train a LoKr adapter on your own songs.

    GET  /lokr/status                what is installed, what is trained, what it costs
    POST /lokr/dataset               build a training set from songs in your library
    POST /lokr/preprocess            encode that set into tensors (GPU, minutes)
    POST /lokr/train                 train the adapter (GPU, long)
    GET  /lokr/progress/{id}         live log, server-sent events
    GET  /lokr/job/{id}              one job's record

Mounted automatically by backend/app.py's router scaffold.

Only one GPU job at a time, enforced here as well as in the engine: preprocessing or
training alongside a song generation would put two multi-gigabyte models on a 12 GB card.
"""
from __future__ import annotations

import asyncio
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

import lokr as ds

router = APIRouter(prefix="/lokr", tags=["lokr"])

jobs: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()


def _engine():
    try:
        import engines.acestep as eng
        return eng
    except Exception as exc:                                     # noqa: BLE001
        raise HTTPException(status_code=503, detail=f"ACE-Step engine unavailable: {exc}")


def _app():
    return sys.modules.get("app")


def _log_to(jid: str):
    def log(msg):
        rec = jobs.get(jid)
        if rec is not None:
            rec["log"].append(str(msg))
            rec["message"] = str(msg)[:200]
    return log


def _start(kind: str, run) -> str:
    """Run `run(log)` on a worker thread, refusing if a GPU job is already going."""
    with _lock:
        if any(j["status"] == "running" for j in jobs.values()):
            raise HTTPException(status_code=409,
                                detail="A training job is already running. One at a time — "
                                       "two of these will not fit on the card together.")
        jid = uuid.uuid4().hex[:8]
        jobs[jid] = {"id": jid, "kind": kind, "status": "running", "message": "Starting…",
                     "log": [], "started": time.time(), "result": None}

    def worker():
        try:
            jobs[jid]["result"] = run(_log_to(jid))
            jobs[jid]["status"] = "done"
            jobs[jid]["message"] = "Finished"
        except Exception as e:                                   # noqa: BLE001
            jobs[jid]["status"] = "error"
            jobs[jid]["message"] = str(e)
            jobs[jid]["log"].append(f"Failed: {e}")
        finally:
            jobs[jid]["ended"] = time.time()

    threading.Thread(target=worker, daemon=True).start()
    return jid


# ── status ────────────────────────────────────────────────────────────────────
@router.get("/status")
def status() -> Dict[str, Any]:
    eng = _engine()
    app = _app()
    ok, reason = eng.available(check_vram=False)
    plan = ds.plan(getattr(app, "jobs", {}) or {}) if app else {"count": 0, "usable": []}
    return {
        "engine_ready": ok,
        "engine_reason": reason,
        "lycoris": _lycoris_present(),
        "library": {"usable": plan.get("count", 0), "enough": plan.get("enough", False),
                    "min_songs": ds.MIN_SONGS, "suggested": ds.SUGGESTED_SONGS,
                    "skipped": plan.get("skipped", []), "notes": plan.get("notes", [])},
        "adapters": eng.list_adapters(),
        "running": next((j["id"] for j in jobs.values() if j["status"] == "running"), None),
        "cost": {
            "vram_note": "ACE-Step's own tutorial asks for 16 GB minimum to train, and this "
                         "card has 12. That is why it trains LoKr rather than LoRA, with "
                         "gradient checkpointing on and only the first couple of minutes of "
                         "each song encoded.",
            "time_note": "Preprocessing runs once per dataset. Training is long and holds "
                         "the GPU the whole time, so nothing else can generate while it runs.",
        },
    }


def _lycoris_present() -> bool:
    """LoKr needs lycoris-lora inside ACE-Step's own venv, not this one."""
    eng = _engine()
    try:
        import subprocess
        r = subprocess.run([str(eng.ACE_VENV_PY), "-c", "import lycoris; print('ok')"],
                           capture_output=True, text=True, timeout=60,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return r.returncode == 0 and "ok" in (r.stdout or "")
    except Exception:                                            # noqa: BLE001
        return False


# ── dataset ───────────────────────────────────────────────────────────────────
class DatasetReq(BaseModel):
    name: str = "mystyle"
    job_ids: Optional[List[str]] = None       # None = everything usable in the library


@router.post("/dataset")
def build_dataset(req: DatasetReq) -> Dict[str, Any]:
    """Cheap and CPU-only, so it runs inline rather than as a job."""
    eng = _engine()
    app = _app()
    if app is None:
        raise HTTPException(status_code=503, detail="app not loaded")
    p = eng.train_paths(req.name)
    out = ds.export(app.jobs, Path(app.OUTPUTS_DIR), p["dataset"], req.job_ids)
    out["name"] = p["name"]
    if not out["enough"]:
        out["warning"] = (f"Only {out['count']} usable song(s). {ds.MIN_SONGS} is the floor "
                          f"and about {ds.SUGGESTED_SONGS} works better.")
    return out


# ── GPU jobs ──────────────────────────────────────────────────────────────────
class PreprocessReq(BaseModel):
    name: str = "mystyle"
    max_duration: float = 120.0        # seconds of each song to encode; the VRAM dial


@router.post("/preprocess")
def preprocess(req: PreprocessReq) -> Dict[str, Any]:
    eng = _engine()
    return {"job_id": _start("preprocess", lambda log: eng.lokr_preprocess(
        req.name, max_duration=req.max_duration, log=log))}


class TrainReq(BaseModel):
    name: str = "mystyle"
    epochs: int = 500
    learning_rate: float = 0.03        # LoKr's default; LoRA's 1e-4 is far too low here
    linear_dim: int = 64
    linear_alpha: int = 128
    save_every: int = 50
    gradient_checkpointing: bool = True


@router.post("/train")
def train(req: TrainReq) -> Dict[str, Any]:
    eng = _engine()
    return {"job_id": _start("train", lambda log: eng.lokr_train(
        req.name, epochs=req.epochs, learning_rate=req.learning_rate,
        linear_dim=req.linear_dim, linear_alpha=req.linear_alpha,
        save_every=req.save_every,
        gradient_checkpointing=req.gradient_checkpointing, log=log))}


class TryReq(BaseModel):
    """Hear a trained style. The only way to, from scratch: Generate runs HeartMuLa."""
    name: str
    tags: str = "rock, male vocals"
    lyrics: str = ""
    seconds: float = 30.0
    scale: float = 1.0


@router.post("/try")
def try_style(req: TryReq) -> Dict[str, Any]:
    eng = _engine()
    adapters = {a["name"]: a for a in eng.list_adapters()}
    if req.name not in adapters:
        raise HTTPException(status_code=404,
                            detail=f"No trained style called {req.name!r}. "
                                   f"Trained: {', '.join(adapters) or 'none yet'}")
    path = adapters[req.name]["file"]

    def run(log):
        metrics: Dict[str, Any] = {}
        out = eng.generate(req.tags, req.lyrics, req.seconds, log=log, metrics=metrics,
                           adapter=path, adapter_scale=req.scale)
        return {"path": str(out), "adapter": path, **metrics}

    return {"job_id": _start("try", run)}


@router.get("/audio/{job_id}")
def audio(job_id: str):
    """The clip a 'try' job produced."""
    from fastapi.responses import FileResponse
    rec = jobs.get(job_id)
    if not rec or not (rec.get("result") or {}).get("path"):
        raise HTTPException(status_code=404, detail="No audio for that job yet.")
    p = Path(rec["result"]["path"])
    if not p.exists():
        raise HTTPException(status_code=410, detail="The clip is gone from disk.")
    return FileResponse(str(p), media_type="audio/wav", filename=f"{rec['id']}.wav")


@router.get("/job/{job_id}")
def job(job_id: str) -> Dict[str, Any]:
    rec = jobs.get(job_id)
    if not rec:
        raise HTTPException(status_code=404, detail="No such job.")
    return {k: v for k, v in rec.items() if k != "log"} | {"lines": len(rec["log"])}


@router.get("/progress/{job_id}")
async def progress(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="No such job.")

    async def stream():
        sent = 0
        while True:
            rec = jobs.get(job_id)
            if rec is None:
                break
            while sent < len(rec["log"]):
                yield f"data: {rec['log'][sent]}\n\n"
                sent += 1
            if rec["status"] != "running":
                yield "data: __done__\n\n"
                break
            await asyncio.sleep(0.6)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
