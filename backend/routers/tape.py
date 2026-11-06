"""Multitrack tape sessions: endpoints for a folder of transferred tracks.

    GET  /tape/status                is ffmpeg here, which sessions are open
    POST /tape/open                  {folder} — list the tracks and open the session
    POST /tape/check                 {folder} — analyse every track (job)
    POST /tape/clean                 {path, hum, dc, hiss…} — write a repaired copy (job)
    POST /tape/declick               {path, clicks, clips, strength} (job)
    POST /tape/speed                 {path, mains, flutter, absolute} (job)
    GET  /tape/curve?path=           measure speed and flutter without correcting anything
    POST /tape/manifest              {folder, tape, title, operator} — preservation manifest
    GET  /tape/verify?folder=        re-hash every track against that manifest
    GET  /tape/job/{id}              one job's record
    GET  /tape/progress/{id}         live log, server-sent events
    GET  /tape/preview?path=         a playable mp3 of one track, for the browser
    GET  /tape/download?path=        the real file, for Save As

Mounted automatically by backend/app.py's router scaffold.

Two things shape this file.

**Folders, not uploads.** Eight tracks of a five-minute song at 24-bit/96k is about 700 MB.
The server runs on the same machine as the browser, so it reads the files where they are.
That means the browser sends absolute paths, which would be an arbitrary-file-read hole if
taken at face value — so every path has to sit inside a folder the user has explicitly
opened in this process, and anything else is refused.

**No GPU.** All of this is numpy, scipy and ffmpeg, so a tape job can run while a song is
generating. The jobs here are serialised against each other only, not against the card.
"""
from __future__ import annotations

import asyncio
import hashlib
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel

import tape as engine

router = APIRouter(prefix="/tape", tags=["tape"])

# Folders the user has opened this run. Nothing outside one of these can be read or written.
_sessions: Dict[str, Dict[str, Any]] = {}
jobs: Dict[str, Dict[str, Any]] = {}
_lock = threading.Lock()


def _app():
    return sys.modules.get("app")


PREVIEW_KEEP = 120   # several reels' worth, so a session in progress is never pruned


def _preview_dir() -> Path:
    app = _app()
    base = Path(getattr(app, "OUTPUTS_DIR", Path.cwd() / "outputs"))
    d = base / "tape"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _prune_previews() -> None:
    """Keep the newest previews and drop the rest.

    A preview is ~10 MB and a reel is eight of them, so a few months of sessions would
    quietly fill a drive with mp3s of files the user may not even have any more. They are
    a cache, keyed by path and modification time: deleting one costs a second of ffmpeg.
    """
    try:
        files = sorted(_preview_dir().glob("*.mp3"), key=lambda p: p.stat().st_mtime,
                       reverse=True)
    except OSError:
        return
    for p in files[PREVIEW_KEEP:]:
        try:
            p.unlink()
        except OSError:
            pass


def _resolve_folder(folder: str) -> Path:
    if not folder or not str(folder).strip():
        raise HTTPException(status_code=400, detail="No folder given.")
    try:
        d = Path(str(folder).strip().strip('"')).expanduser().resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"That path cannot be read: {e}")
    if not d.is_dir():
        raise HTTPException(status_code=404,
                            detail=f"{d} is not a folder on this machine.")
    return d


def _open_folder(folder: str) -> Path:
    d = _resolve_folder(folder)
    _sessions[str(d)] = {"folder": str(d), "opened": time.time()}
    return d


def _in_session(path: str) -> Path:
    """A file inside a folder the user opened. Everything else is refused.

    The check is on the resolved path, so ..\\..\\Windows\\System32 and a symlink pointing
    out of the session folder both fail — the string never gets trusted, only the real
    location it lands on.
    """
    if not path or not str(path).strip():
        raise HTTPException(status_code=400, detail="No file given.")
    try:
        p = Path(str(path).strip().strip('"')).expanduser().resolve()
    except OSError as e:
        raise HTTPException(status_code=400, detail=f"That path cannot be read: {e}")
    if not _sessions:
        raise HTTPException(status_code=409,
                            detail="No tape session is open. Open the folder first.")
    for root in _sessions:
        try:
            p.relative_to(Path(root))
        except ValueError:
            continue
        if not p.is_file():
            raise HTTPException(status_code=404, detail=f"{p.name} is not a file.")
        return p
    raise HTTPException(
        status_code=403,
        detail="That file is not inside a tape session folder you have opened.")


# ── jobs ──────────────────────────────────────────────────────────────────────
def _start(kind: str, label: str, run) -> str:
    """Run `run(log)` on a worker thread. One tape job at a time; the GPU is not involved."""
    with _lock:
        if any(j["status"] == "running" for j in jobs.values()):
            raise HTTPException(
                status_code=409,
                detail="A tape job is already running. These are disk-bound, so running "
                       "two at once makes both slower.")
        jid = uuid.uuid4().hex[:8]
        jobs[jid] = {"id": jid, "kind": kind, "label": label, "status": "running",
                     "message": "Starting…", "log": [], "started": time.time(),
                     "result": None}

    def log(msg):
        rec = jobs.get(jid)
        if rec is not None:
            rec["log"].append(str(msg))
            rec["message"] = str(msg)[:200]

    def worker():
        try:
            jobs[jid]["result"] = run(log)
            jobs[jid]["status"] = "done"
            jobs[jid]["message"] = "Finished"
        except Exception as e:                                   # noqa: BLE001
            jobs[jid]["status"] = "error"
            jobs[jid]["message"] = f"{type(e).__name__}: {e}"
            jobs[jid]["log"].append(f"Failed: {e}")
        finally:
            jobs[jid]["ended"] = time.time()

    threading.Thread(target=worker, daemon=True).start()
    return jid


@router.get("/job/{jid}")
def job(jid: str) -> Dict[str, Any]:
    rec = jobs.get(jid)
    if not rec:
        raise HTTPException(status_code=404, detail="no such job")
    return rec


@router.get("/progress/{jid}")
async def progress(jid: str):
    """Server-sent events: each new log line, then __done__."""
    if jid not in jobs:
        raise HTTPException(status_code=404, detail="no such job")

    async def stream():
        sent = 0
        while True:
            rec = jobs.get(jid) or {}
            lines = rec.get("log") or []
            while sent < len(lines):
                yield f"data: {lines[sent]}\n\n"
                sent += 1
            if rec.get("status") != "running":
                yield "data: __done__\n\n"
                return
            await asyncio.sleep(0.4)

    return StreamingResponse(stream(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})


# ── session ───────────────────────────────────────────────────────────────────
@router.get("/status")
def status() -> Dict[str, Any]:
    import shutil
    return {
        "ffmpeg": bool(shutil.which("ffmpeg")),
        "sessions": sorted(_sessions),
        "running": [j["id"] for j in jobs.values() if j["status"] == "running"],
        "repair_suffix": engine.REPAIR_SUFFIX,
    }


class FolderIn(BaseModel):
    folder: str


@router.post("/open")
def open_session(body: FolderIn) -> Dict[str, Any]:
    d = _open_folder(body.folder)
    out = engine.scan(str(d))
    if not out.get("ok"):
        raise HTTPException(status_code=400, detail=out.get("error", "could not read that folder"))
    out["manifest"] = (d / engine.MANIFEST_JSON).is_file()
    out["repairs"] = sorted(p.name for p in d.glob(f"*{engine.REPAIR_SUFFIX}*")
                            if p.suffix.lower() in engine.AUDIO_EXT)
    return out


@router.post("/check")
def check(body: FolderIn) -> Dict[str, Any]:
    d = _open_folder(body.folder)

    def run(log):
        log(f"Reading {d}…")
        result = engine.check(str(d))
        if result.get("ok"):
            log(f"{len(result.get('tracks') or [])} track(s) analysed, "
                f"{len(result.get('findings') or [])} finding(s).")
        else:
            log(result.get("error", "check failed"))
        return result

    return {"job_id": _start("check", d.name, run)}


# ── repairs ───────────────────────────────────────────────────────────────────
class CleanIn(BaseModel):
    path: str
    hum: bool = False
    hum_hz: float = 0.0
    dc: bool = False
    hiss: bool = False
    hiss_strength: float = 1.0
    noise_start: Optional[float] = None
    noise_end: Optional[float] = None


@router.post("/clean")
def clean(body: CleanIn) -> Dict[str, Any]:
    p = _in_session(body.path)
    if not (body.hum or body.dc or body.hiss):
        raise HTTPException(status_code=400, detail="Nothing was selected to clean.")

    def run(log):
        wanted = [n for n, on in (("hum", body.hum), ("DC offset", body.dc),
                                  ("hiss", body.hiss)) if on]
        log(f"{p.name}: removing {', '.join(wanted)}. The original is not opened for writing.")
        r = engine.clean(str(p), hum=body.hum, hum_hz=body.hum_hz, dc=body.dc,
                         hiss=body.hiss, hiss_strength=body.hiss_strength,
                         noise_start=body.noise_start, noise_end=body.noise_end)
        for line in (r.get("applied") or []):
            log("· " + line)
        if r.get("ok"):
            log(f"Wrote {r['name']}.")
        else:
            log(r.get("error", "clean failed"))
        return r

    return {"job_id": _start("clean", p.name, run)}


class DeclickIn(BaseModel):
    path: str
    clicks: bool = True
    clips: bool = False
    strength: str = "normal"            # gentle / normal / strong


# Measured on this machine: ffmpeg's own default of 2 altered an undamaged dense mix by
# -49 dBFS, where 10 altered it by -72 dBFS and repaired a damaged tape track slightly
# better as well. "Strong" is nearer the ffmpeg default and is for tracks that really are
# full of crackle.
_STRENGTH = {"gentle": 25.0, "normal": 10.0, "strong": 3.0}


@router.post("/declick")
def declick(body: DeclickIn) -> Dict[str, Any]:
    p = _in_session(body.path)
    if not (body.clicks or body.clips):
        raise HTTPException(status_code=400, detail="Nothing was selected to repair.")
    t = _STRENGTH.get(body.strength, 10.0)

    def run(log):
        bits = [n for n, on in (("clicks", body.clicks), ("clipped peaks", body.clips)) if on]
        log(f"{p.name}: repairing {' and '.join(bits)} ({body.strength}).")
        r = engine.declick(str(p), clicks=body.clicks, clips=body.clips, threshold=t)
        for line in (r.get("applied") or []):
            log("· " + line)
        if r.get("ok"):
            log(f"Wrote {r['name']}.")
        else:
            log(r.get("error", "repair failed"))
        return r

    return {"job_id": _start("declick", p.name, run)}


class SpeedIn(BaseModel):
    path: str
    mains: Optional[float] = None
    flutter: bool = True
    absolute: bool = True


@router.post("/speed")
def speed(body: SpeedIn) -> Dict[str, Any]:
    p = _in_session(body.path)

    def run(log):
        log(f"{p.name}: measuring the hum line to find the tape speed…")
        r = engine.fix_speed(str(p), mains=body.mains, flutter=body.flutter,
                             absolute=body.absolute)
        curve = r.get("curve") or {}
        if curve:
            log(f"Speed error {curve.get('speed_error_pct', 0):+.3f}%, "
                f"flutter {curve.get('flutter_pct', 0):.3f}%, "
                f"reference {curve.get('mains_hz', 0):.0f} Hz.")
        for line in (r.get("applied") or []):
            log("· " + line)
        if r.get("unchanged"):
            log(r.get("note", "nothing worth correcting"))
        elif r.get("ok"):
            log(f"Wrote {r['name']}.")
        else:
            log(r.get("error", "speed correction failed"))
        return r

    return {"job_id": _start("speed", p.name, run)}


@router.get("/curve")
def curve(path: str, mains: Optional[float] = None) -> Dict[str, Any]:
    """Measure speed and flutter and change nothing — the 'show me first' call."""
    p = _in_session(path)
    try:
        return engine.hum_speed_curve(str(p), mains=mains)
    except Exception as exc:                                     # noqa: BLE001
        raise HTTPException(status_code=500,
                            detail=f"{type(exc).__name__}: {exc}") from exc


# ── preservation ──────────────────────────────────────────────────────────────
class ManifestIn(BaseModel):
    folder: str
    title: str = ""
    operator: str = ""
    machine: str = ""
    width: str = ""
    speed: str = ""
    noise_reduction: str = ""
    stock: str = ""
    interface: str = ""
    transfer_date: str = ""


@router.post("/manifest")
def manifest(body: ManifestIn) -> Dict[str, Any]:
    d = _open_folder(body.folder)
    details = {k: v for k, v in {
        "machine": body.machine, "width": body.width, "speed": body.speed,
        "noise_reduction": body.noise_reduction, "stock": body.stock,
        "interface": body.interface, "transfer_date": body.transfer_date,
    }.items() if str(v or "").strip()}
    try:
        r = engine.manifest(str(d), tape=details, title=body.title, operator=body.operator)
    except Exception as exc:                                     # noqa: BLE001
        raise HTTPException(status_code=500,
                            detail=f"{type(exc).__name__}: {exc}") from exc
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("error", "manifest failed"))
    return r


@router.get("/verify")
def verify(folder: str) -> Dict[str, Any]:
    d = _open_folder(folder)
    r = engine.verify_manifest(str(d))
    if not r.get("ok"):
        raise HTTPException(status_code=400, detail=r.get("error", "verify failed"))
    return r


# ── audio for the browser ─────────────────────────────────────────────────────
@router.get("/preview")
def preview(path: str) -> Dict[str, Any]:
    """An mp3 of one track, so the browser can play and decode it.

    A 24-bit/96k transfer is not something to hand a web page: eight of them decoded into
    AudioBuffers is most of a gigabyte of memory, and the browser has to download every
    byte first. The preview is 320 kbps and cached; every repair, measurement and export
    still runs on the original file, untouched, at full resolution.
    """
    p = _in_session(path)
    stat = p.stat()
    key = hashlib.sha1(f"{p}|{stat.st_mtime_ns}|{stat.st_size}".encode()).hexdigest()[:16]
    out = _preview_dir() / f"{key}.mp3"
    if not out.is_file():
        import shutil
        if not shutil.which("ffmpeg"):
            raise HTTPException(status_code=501,
                                detail="ffmpeg is not installed, so previews cannot be made.")
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(p),
               "-b:a", "320k", "-ac", "2", str(out)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0 or not out.is_file():
            raise HTTPException(status_code=500,
                                detail=f"ffmpeg could not read that file: "
                                       f"{proc.stderr.strip()[-200:]}")
        _prune_previews()
    return {"ok": True, "url": f"/outputs/tape/{out.name}", "name": p.name,
            "source": str(p), "bytes": stat.st_size}


@router.get("/download")
def download(path: str):
    """The real file, at full resolution, for Save As."""
    p = _in_session(path)
    return FileResponse(str(p), filename=p.name, media_type="application/octet-stream")


@router.get("/tracks")
def tracks(folder: str) -> Dict[str, Any]:
    """Everything Studio needs to open a tape session: a preview URL per track."""
    d = _open_folder(folder)
    listing = engine.scan(str(d))
    if not listing.get("ok"):
        raise HTTPException(status_code=400, detail=listing.get("error", "could not read that folder"))
    out: List[Dict[str, Any]] = []
    for t in listing["tracks"]:
        try:
            pv = preview(t["path"])
        except HTTPException as e:
            out.append({"name": t["name"], "error": str(e.detail)})
            continue
        out.append({"name": t["name"], "path": t["path"], "url": pv["url"],
                    "seconds": t["seconds"], "samplerate": t["samplerate"],
                    "channels": t["channels"], "subtype": t["subtype"]})
    return {"ok": True, "folder": str(d), "title": d.name, "tracks": out,
            "notes": listing.get("notes") or []}
