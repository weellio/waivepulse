import sys
import os
import re
import uuid
import json
import queue
import tempfile
import threading
from pathlib import Path
from typing import Optional
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

try:
    from mutagen.id3 import (ID3, ID3NoHeaderError,
                              TIT2, TPE1, TPE2, TCON, COMM, TDRC, TENC, TCOM)
    _MUTAGEN = True
except ImportError:
    _MUTAGEN = False

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

HEARTMULA_PATH = os.environ.get("HEARTMULA_PATH", "F:/HeartMuLa/ckpt")
OUTPUTS_DIR    = Path(__file__).parent.parent / "outputs"
FRONTEND_DIR   = Path(__file__).parent.parent / "frontend"
HISTORY_FILE   = Path(__file__).parent.parent / "history.json"
OUTPUTS_DIR.mkdir(exist_ok=True)

app = FastAPI(title="WAIvePulse")
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")

# ── Model ──────────────────────────────────────────────────────────────────────
_pipeline      = None
_pipeline_lock = threading.Lock()

# ── State ──────────────────────────────────────────────────────────────────────
jobs:         dict = {}   # job_id → job dict
job_logs:     dict = {}   # job_id → list[str]
cancel_flags: dict = {}   # job_id → threading.Event

# ── Job queue (single FIFO worker) ────────────────────────────────────────────
_job_queue = queue.Queue()

# ── Thread-local stdout/stderr capture ───────────────────────────────────────
_thread_local = threading.local()
_ANSI_RE      = re.compile(r'\x1b\[[0-9;]*[mGKHFJA-Za-z]')

class _TeeStream:
    """Routes writes to a per-thread log list when inside a generation thread,
    otherwise passes through to the real stream."""
    def __init__(self, real):
        self.real = real

    def write(self, text):
        log = getattr(_thread_local, 'job_log', None)
        if log is not None:
            clean = _ANSI_RE.sub('', text)
            buf   = getattr(_thread_local, '_buf', '')
            buf  += clean
            parts = re.split(r'[\r\n]', buf)
            for part in parts[:-1]:
                s = part.strip()
                if s:
                    log.append(s)
            _thread_local._buf = parts[-1]
        else:
            self.real.write(text)

    def flush(self):  self.real.flush()
    def fileno(self): return self.real.fileno()
    def isatty(self): return False

_real_stdout = sys.stdout
_real_stderr = sys.stderr
sys.stdout   = _TeeStream(_real_stdout)
sys.stderr   = _TeeStream(_real_stderr)


# ── Helpers ────────────────────────────────────────────────────────────────────
def _write_metadata(path: str, title: str, artist: str, tags: str,
                    temperature: float, cfg_scale: float):
    if not _MUTAGEN:
        return
    try:
        try:
            id3 = ID3(path)
        except ID3NoHeaderError:
            id3 = ID3()
        id3["TIT2"] = TIT2(encoding=3, text=title)
        id3["TPE1"] = TPE1(encoding=3, text=artist or "WAIvePulse")
        id3["TPE2"] = TPE2(encoding=3, text="WAIvePulse")
        id3["TCOM"] = TCOM(encoding=3, text="HeartMuLa 3B")
        id3["TCON"] = TCON(encoding=3, text=tags)
        id3["TDRC"] = TDRC(encoding=3, text=str(datetime.now().year))
        id3["TENC"] = TENC(encoding=3, text="WAIvePulse / HeartMuLa 3B")
        id3["COMM::eng"] = COMM(
            encoding=3, lang="eng", desc="",
            text=f"Tags: {tags} | Temperature: {temperature} | CFG Scale: {cfg_scale}",
        )
        id3.save(path)
    except Exception as e:
        _real_stderr.write(f"[waivepulse] Metadata write failed: {e}\n")


def _output_filename(title: str, job_id: str) -> str:
    slug = re.sub(r"[^\w\s-]", "", title).strip()
    slug = re.sub(r"[\s_]+", "_", slug)[:48].strip("_")
    return f"{slug}_{job_id}" if slug else job_id


def _save_history():
    try:
        HISTORY_FILE.write_text(json.dumps(jobs, indent=2), encoding="utf-8")
    except Exception as e:
        _real_stderr.write(f"[waivepulse] Failed to save history: {e}\n")


def _load_history():
    if not HISTORY_FILE.exists():
        return
    try:
        data = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        for job_id, job in data.items():
            if job.get("status") in ("generating", "queued"):
                job["status"]  = "error"
                job["message"] = "Server restarted — job lost"
            jobs[job_id] = job
    except Exception as e:
        _real_stderr.write(f"[waivepulse] Failed to load history: {e}\n")


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        with _pipeline_lock:
            if _pipeline is None:
                import torch
                from heartlib import HeartMuLaGenPipeline
                _real_stdout.write("[waivepulse] Loading HeartMuLa model...\n")
                _pipeline = HeartMuLaGenPipeline.from_pretrained(
                    HEARTMULA_PATH,
                    device={"mula": torch.device("cuda"), "codec": torch.device("cuda")},
                    dtype={"mula": torch.bfloat16, "codec": torch.float32},
                    version="3B",
                    lazy_load=False,
                )
                _real_stdout.write("[waivepulse] Model loaded.\n")
    return _pipeline


# ── Generation worker ─────────────────────────────────────────────────────────
def _run_generation(job_id, lyrics, tags, title, artist, max_ms, temperature, cfg_scale, topk):
    log = []
    job_logs[job_id]      = log
    _thread_local.job_log = log
    _thread_local._buf    = ''

    jobs[job_id]["status"] = "generating"
    _save_history()

    out_path = None
    try:
        import torch
        pipe = get_pipeline()

        with tempfile.TemporaryDirectory() as tmpdir:
            lp = os.path.join(tmpdir, "lyrics.txt")
            tp = os.path.join(tmpdir, "tags.txt")
            with open(lp, "w", encoding="utf-8") as f:
                f.write(lyrics)
            with open(tp, "w", encoding="utf-8") as f:
                f.write(tags)

            out_path = str(OUTPUTS_DIR / f"{_output_filename(title, job_id)}.mp3")

            if cancel_flags.get(job_id, threading.Event()).is_set():
                jobs[job_id]["status"]  = "cancelled"
                jobs[job_id]["message"] = "Cancelled"
                _save_history()
                return

            with torch.no_grad():
                pipe(
                    {"lyrics": lp, "tags": tp},
                    max_audio_length_ms=max_ms,
                    save_path=out_path,
                    topk=topk,
                    temperature=temperature,
                    cfg_scale=cfg_scale,
                )

        if cancel_flags.get(job_id, threading.Event()).is_set():
            if out_path and os.path.exists(out_path):
                os.unlink(out_path)
            jobs[job_id]["status"]  = "cancelled"
            jobs[job_id]["message"] = "Cancelled"
        else:
            _write_metadata(out_path, title, artist, tags, temperature, cfg_scale)
            filename = _output_filename(title, job_id)
            jobs[job_id]["status"]    = "done"
            jobs[job_id]["file"]      = f"/outputs/{filename}.mp3"
            jobs[job_id]["file_size"] = os.path.getsize(out_path)
            jobs[job_id]["message"]   = "Generation complete"

    except Exception as e:
        jobs[job_id]["status"]  = "error"
        jobs[job_id]["message"] = str(e)
        _real_stderr.write(f"[waivepulse] Generation error for {job_id}: {e}\n")
    finally:
        _thread_local.job_log = None
        _save_history()


def _queue_worker():
    while True:
        job_id, kwargs = _job_queue.get()
        try:
            if jobs.get(job_id, {}).get("status") != "cancelled":
                _run_generation(job_id, **kwargs)
        finally:
            _job_queue.task_done()


threading.Thread(target=_queue_worker, daemon=True, name="job-worker").start()
_load_history()


# ── Pydantic models ────────────────────────────────────────────────────────────
class GenerateRequest(BaseModel):
    lyrics:           str
    tags:             str
    title:            Optional[str]   = "Untitled"
    artist:           Optional[str]   = ""
    max_duration_sec: Optional[int]   = 300
    temperature:      Optional[float] = 1.0
    cfg_scale:        Optional[float] = 1.5
    topk:             Optional[int]   = 50


def _models_ready() -> dict:
    ckpt = Path(HEARTMULA_PATH)
    required = {
        "HeartMuLaGen": ckpt / "gen_config.json",
        "HeartMuLa-3B": ckpt / "HeartMuLa-oss-3B" / "config.json",
        "HeartCodec":   ckpt / "HeartCodec-oss",
    }
    status     = {name: path.exists() for name, path in required.items()}
    incomplete = list(ckpt.rglob("*.incomplete"))
    return {
        "ready":            all(status.values()) and len(incomplete) == 0,
        "components":       status,
        "incomplete_files": len(incomplete),
    }


# ── Routes ─────────────────────────────────────────────────────────────────────
@app.get("/model-status")
def model_status():
    return _models_ready()


@app.get("/", response_class=HTMLResponse)
def index():
    html_path = FRONTEND_DIR / "index.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>Frontend not found</h1>", status_code=404)


@app.post("/generate")
def generate(req: GenerateRequest):
    ms = _models_ready()
    if not ms["ready"]:
        raise HTTPException(
            status_code=503,
            detail=f"Models not ready: {ms['incomplete_files']} files still downloading",
        )
    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {
        "status":          "queued",
        "message":         "Queued",
        "file":            None,
        "file_size":       None,
        "title":           req.title,
        "artist":          req.artist,
        "tags":            req.tags,
        "lyrics":          req.lyrics,
        "max_duration_sec":req.max_duration_sec,
        "temperature":     req.temperature,
        "cfg_scale":       req.cfg_scale,
        "created_at":      datetime.now().isoformat(),
    }
    cancel_flags[job_id] = threading.Event()
    _job_queue.put((job_id, {
        "lyrics":      req.lyrics,
        "tags":        req.tags,
        "title":       req.title,
        "artist":      req.artist,
        "max_ms":      req.max_duration_sec * 1000,
        "temperature": req.temperature,
        "cfg_scale":   req.cfg_scale,
        "topk":        req.topk,
    }))
    _save_history()
    return {"job_id": job_id}


@app.get("/status/{job_id}")
def status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]


@app.post("/cancel/{job_id}")
def cancel_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    s = jobs[job_id]["status"]
    if s in ("done", "error", "cancelled"):
        raise HTTPException(status_code=400, detail=f"Job already {s}")
    cancel_flags.setdefault(job_id, threading.Event()).set()
    if s == "queued":
        jobs[job_id]["status"]  = "cancelled"
        jobs[job_id]["message"] = "Cancelled"
        _save_history()
    return {"cancelled": job_id}


@app.get("/progress/{job_id}")
async def progress_stream(job_id: str):
    import asyncio

    async def event_stream():
        sent = 0
        while True:
            log = job_logs.get(job_id, [])
            while sent < len(log):
                yield f"data: {json.dumps(log[sent])}\n\n"
                sent += 1
            s = jobs.get(job_id, {}).get("status", "")
            if s in ("done", "error", "cancelled"):
                log = job_logs.get(job_id, [])
                while sent < len(log):
                    yield f"data: {json.dumps(log[sent])}\n\n"
                    sent += 1
                yield "data: __done__\n\n"
                break
            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/history")
def history():
    sorted_jobs = sorted(
        jobs.items(),
        key=lambda x: x[1].get("created_at", ""),
        reverse=True,
    )
    return [{"job_id": k, **v} for k, v in sorted_jobs]


@app.delete("/history/{job_id}")
def delete_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    stored_file = jobs[job_id].get("file")
    if stored_file:
        mp3 = OUTPUTS_DIR / Path(stored_file).name
        if mp3.exists():
            mp3.unlink()
    del jobs[job_id]
    cancel_flags.pop(job_id, None)
    job_logs.pop(job_id, None)
    _save_history()
    return {"deleted": job_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=7860, reload=False)
