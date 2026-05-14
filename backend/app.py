import sys
import os
import uuid
import tempfile
import threading
from pathlib import Path
from typing import Optional
from datetime import datetime

sys.path.insert(0, str(Path(__file__).parent.parent / "scripts"))

from fastapi import FastAPI, BackgroundTasks, HTTPException
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

HEARTMULA_PATH = os.environ.get("HEARTMULA_PATH", "F:/HeartMuLa/ckpt")
OUTPUTS_DIR = Path(__file__).parent.parent / "outputs"
FRONTEND_DIR = Path(__file__).parent.parent / "frontend"
OUTPUTS_DIR.mkdir(exist_ok=True)

app = FastAPI(title="WAIvePulse")

app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")

# Model pipeline — loaded once on first use
_pipeline = None
_pipeline_lock = threading.Lock()

# Job state: job_id -> {status, message, file, created_at, title}
jobs: dict = {}


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        with _pipeline_lock:
            if _pipeline is None:
                import torch
                from heartlib import HeartMuLaGenPipeline
                print("[waivepulse] Loading HeartMuLa model...")
                _pipeline = HeartMuLaGenPipeline.from_pretrained(
                    HEARTMULA_PATH,
                    device={"mula": torch.device("cuda"), "codec": torch.device("cuda")},
                    dtype={"mula": torch.bfloat16, "codec": torch.float32},
                    version="3B",
                    lazy_load=False,
                )
                print("[waivepulse] Model loaded.")
    return _pipeline


def run_generation(job_id: str, lyrics: str, tags: str, title: str, max_ms: int, temperature: float, cfg_scale: float, topk: int):
    jobs[job_id]["status"] = "generating"
    try:
        import torch
        pipe = get_pipeline()

        with tempfile.TemporaryDirectory() as tmpdir:
            lyrics_path = os.path.join(tmpdir, "lyrics.txt")
            tags_path = os.path.join(tmpdir, "tags.txt")
            with open(lyrics_path, "w", encoding="utf-8") as f:
                f.write(lyrics)
            with open(tags_path, "w", encoding="utf-8") as f:
                f.write(tags)

            out_path = str(OUTPUTS_DIR / f"{job_id}.mp3")
            with torch.no_grad():
                pipe(
                    {"lyrics": lyrics_path, "tags": tags_path},
                    max_audio_length_ms=max_ms,
                    save_path=out_path,
                    topk=topk,
                    temperature=temperature,
                    cfg_scale=cfg_scale,
                )

        jobs[job_id]["status"] = "done"
        jobs[job_id]["file"] = f"/outputs/{job_id}.mp3"
        jobs[job_id]["message"] = "Generation complete"
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["message"] = str(e)
        print(f"[waivepulse] Generation error for {job_id}: {e}")


class GenerateRequest(BaseModel):
    lyrics: str
    tags: str
    title: Optional[str] = "Untitled"
    max_duration_sec: Optional[int] = 300
    temperature: Optional[float] = 1.0
    cfg_scale: Optional[float] = 1.5
    topk: Optional[int] = 50


def _models_ready() -> dict:
    """Check whether all required model files are present (no .incomplete files)."""
    ckpt = Path(HEARTMULA_PATH)
    required = {
        "HeartMuLaGen": ckpt / "gen_config.json",
        "HeartMuLa-3B": ckpt / "HeartMuLa-oss-3B" / "config.json",
        "HeartCodec": ckpt / "HeartCodec-oss",
    }
    status = {}
    for name, path in required.items():
        status[name] = path.exists()

    incomplete = list((ckpt).rglob("*.incomplete"))
    return {
        "ready": all(status.values()) and len(incomplete) == 0,
        "components": status,
        "incomplete_files": len(incomplete),
    }


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
def generate(req: GenerateRequest, background_tasks: BackgroundTasks):
    ms = _models_ready()
    if not ms["ready"]:
        raise HTTPException(status_code=503, detail=f"Models not ready: {ms['incomplete_files']} files still downloading")
    job_id = str(uuid.uuid4())[:8]
    jobs[job_id] = {
        "status": "queued",
        "message": "Queued",
        "file": None,
        "title": req.title,
        "tags": req.tags,
        "created_at": datetime.now().isoformat(),
    }
    background_tasks.add_task(
        run_generation,
        job_id=job_id,
        lyrics=req.lyrics,
        tags=req.tags,
        title=req.title,
        max_ms=req.max_duration_sec * 1000,
        temperature=req.temperature,
        cfg_scale=req.cfg_scale,
        topk=req.topk,
    )
    return {"job_id": job_id}


@app.get("/status/{job_id}")
def status(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]


@app.get("/history")
def history():
    sorted_jobs = sorted(jobs.items(), key=lambda x: x[1].get("created_at", ""), reverse=True)
    return [{"job_id": k, **v} for k, v in sorted_jobs]


@app.delete("/history/{job_id}")
def delete_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    mp3 = OUTPUTS_DIR / f"{job_id}.mp3"
    if mp3.exists():
        mp3.unlink()
    del jobs[job_id]
    return {"deleted": job_id}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=7860, reload=False)
