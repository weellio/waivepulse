import sys
import os
import re
import io
import uuid
import json
import queue
import shutil
import tempfile
import threading
import subprocess
import zipfile
import importlib.util
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

from fastapi import FastAPI, HTTPException, UploadFile, File as FastAPIFile, Query
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import platform as _platform
_DEFAULT_HEARTMULA = (
    "F:/HeartMuLa/ckpt" if _platform.system() == "Windows"
    else str(Path.home() / "HeartMuLa" / "ckpt")
)
HEARTMULA_PATH = os.environ.get("HEARTMULA_PATH", _DEFAULT_HEARTMULA)
PYTHON_EXE     = os.environ.get("PYTHON_EXE", sys.executable)
OUTPUTS_DIR    = Path(__file__).parent.parent / "outputs"
FRONTEND_DIR   = Path(__file__).parent.parent / "frontend"
ASSETS_DIR     = Path(__file__).parent.parent / "assets"
HISTORY_FILE   = Path(__file__).parent.parent / "history.json"
CREDS_DIR      = Path(__file__).parent.parent / ".credentials"
OUTPUTS_DIR.mkdir(exist_ok=True)
ASSETS_DIR.mkdir(exist_ok=True)
CREDS_DIR.mkdir(exist_ok=True)

_DEMUCS         = importlib.util.find_spec("demucs")         is not None
_LIBROSA        = importlib.util.find_spec("librosa")        is not None
_AUDIOSEAL      = importlib.util.find_spec("audioseal")      is not None
_TORCHAUDIO     = importlib.util.find_spec("torchaudio")     is not None
_C2PA           = importlib.util.find_spec("c2pa")           is not None
_CRYPTOGRAPHY   = importlib.util.find_spec("cryptography")   is not None
_FFMPEG         = bool(shutil.which("ffmpeg"))
_FASTER_WHISPER = importlib.util.find_spec("faster_whisper") is not None

_audioseal_gen = None   # lazy-loaded AudioSeal generator
_wp_cert_pem   = None   # cached WAIvePulse signing cert
_wp_key_pem    = None   # cached WAIvePulse signing key

app = FastAPI(title="WAIvePulse")
app.mount("/outputs", StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")
app.mount("/assets",  StaticFiles(directory=str(ASSETS_DIR)),  name="assets")

# ── Model ──────────────────────────────────────────────────────────────────────
_pipeline      = None
_pipeline_lock = threading.Lock()

# ── State ──────────────────────────────────────────────────────────────────────
jobs:         dict = {}   # job_id → job dict
job_logs:     dict = {}   # job_id → list[str]
cancel_flags: dict = {}   # job_id → threading.Event

sep_jobs: dict = {}       # sep_id → sep dict
sep_logs: dict = {}       # sep_id → list[str]
transcribe_jobs: dict = {}  # sep_id → {status, words, message}

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


def _detect_bpm_key(mp3_path: str) -> tuple:
    """Return (bpm_int, key_str) or (None, None) if librosa unavailable."""
    if not _LIBROSA:
        return None, None
    try:
        import librosa
        import numpy as np
        y, sr = librosa.load(mp3_path, sr=22050, mono=True, duration=120)
        tempo, _ = librosa.beat.beat_track(y=y, sr=sr)
        bpm = int(round(float(tempo))) if tempo else None

        chroma = librosa.feature.chroma_cqt(y=y, sr=sr)
        chroma_mean = chroma.mean(axis=1)
        # Krumhansl-Schmuckler key profiles
        major = np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88])
        minor = np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17])
        NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
        best_score, best_key = -1e9, "C major"
        for i in range(12):
            for profile, quality in [(major, "major"), (minor, "minor")]:
                rotated = np.roll(chroma_mean, -i)
                score   = float(np.corrcoef(rotated, profile)[0, 1])
                if score > best_score:
                    best_score = score
                    best_key   = f"{NOTES[i]} {quality}"
        return bpm, best_key
    except Exception as e:
        _real_stderr.write(f"[waivepulse] BPM/key detection failed: {e}\n")
        return None, None


def _get_waivepulse_creds():
    """Return (cert_pem_bytes, key_pem_bytes), generating a self-signed cert on first call."""
    global _wp_cert_pem, _wp_key_pem
    if _wp_cert_pem and _wp_key_pem:
        return _wp_cert_pem, _wp_key_pem
    cert_path = CREDS_DIR / "waivepulse_cert.pem"
    key_path  = CREDS_DIR / "waivepulse_key.pem"
    if cert_path.exists() and key_path.exists():
        _wp_cert_pem = cert_path.read_bytes()
        _wp_key_pem  = key_path.read_bytes()
        return _wp_cert_pem, _wp_key_pem
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID
    import datetime as _dt
    key  = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "WAIvePulse"),
        x509.NameAttribute(NameOID.COMMON_NAME, "WAIvePulse Content Credentials"),
    ])
    cert = (x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(_dt.datetime.utcnow())
        .not_valid_after(_dt.datetime.utcnow() + _dt.timedelta(days=3650))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256()))
    _wp_cert_pem = cert.public_bytes(serialization.Encoding.PEM)
    _wp_key_pem  = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    cert_path.write_bytes(_wp_cert_pem)
    key_path.write_bytes(_wp_key_pem)
    _real_stdout.write("[waivepulse] Generated WAIvePulse signing credentials.\n")
    return _wp_cert_pem, _wp_key_pem


def _normalize_word(w: str) -> str:
    w = w.lower()
    w = w.replace('’', "'").replace('‘', "'").replace('ʼ', "'")
    return re.sub(r"[^\w']", "", w)

def _extract_lyric_words(lyrics_text: str) -> list:
    words = []
    for line in lyrics_text.split('\n'):
        line = line.strip()
        if not line or re.match(r'^\[.*\]$', line):
            continue
        words.extend(w for w in line.split() if w)
    return words

def _lcs_align(lyric_words: list, transcript_words: list) -> list:
    n, m = len(lyric_words), len(transcript_words)
    nl = [_normalize_word(w) for w in lyric_words]
    nt = [_normalize_word(w['word']) for w in transcript_words]
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            dp[i][j] = dp[i-1][j-1] + 1 if nl[i-1] == nt[j-1] else max(dp[i-1][j], dp[i][j-1])
    alignment = [None] * n
    i, j = n, m
    while i > 0 and j > 0:
        if nl[i-1] == nt[j-1]:
            alignment[i-1] = j - 1; i -= 1; j -= 1
        elif dp[i-1][j] >= dp[i][j-1]:
            i -= 1
        else:
            j -= 1
    return alignment

def _build_word_timing(lyric_words: list, alignment: list, transcript_words: list) -> list:
    n = len(alignment)
    result = []
    for i, j in enumerate(alignment):
        if j is not None:
            tw = transcript_words[j]
            result.append({'word': lyric_words[i], 'start': tw['start'], 'end': tw['end']})
        else:
            result.append({'word': lyric_words[i], 'start': None, 'end': None})
    for i in range(n):
        if result[i]['start'] is not None:
            continue
        prev_i = next((k for k in range(i-1, -1, -1) if result[k]['start'] is not None), None)
        next_i = next((k for k in range(i+1, n)      if result[k]['start'] is not None), None)
        if prev_i is not None and next_i is not None:
            t0 = result[prev_i]['end'] or result[prev_i]['start']
            t1 = result[next_i]['start']
            if t1 <= t0: t0 = result[prev_i]['start']
            gap = next_i - prev_i
            pos = i - prev_i
            dur = max(0, t1 - t0) / gap
            result[i]['start'] = round(t0 + dur * pos, 3)
            result[i]['end']   = round(t0 + dur * (pos + 1), 3)
        elif prev_i is not None:
            result[i]['start'] = round(result[prev_i]['end'] or result[prev_i]['start'], 3)
            result[i]['end']   = round(result[i]['start'] + 0.25, 3)
        elif next_i is not None:
            result[i]['start'] = round(max(0.0, result[next_i]['start'] - 0.25), 3)
            result[i]['end']   = round(result[next_i]['start'], 3)
        else:
            result[i]['start'] = 0.0
            result[i]['end']   = 0.25
    return result

WHISPER_MODELS = ('tiny', 'base', 'small', 'medium', 'large-v2', 'large-v3')

def _run_transcription(sep_id: str, model_name: str = 'base'):
    label = f'Whisper {model_name}'
    transcribe_jobs[sep_id] = {'status': 'transcribing', 'words': None, 'message': f'Running {label} on vocals stem…'}
    try:
        sep = sep_jobs.get(sep_id)
        if not sep:
            raise ValueError('Separation not found')
        job_id = sep.get('job_id')
        lyrics = jobs.get(job_id, {}).get('lyrics', '') if job_id else ''

        out_dir = OUTPUTS_DIR / f'sep_{sep_id}'
        ext = 'mp3' if _FFMPEG else 'wav'
        candidates = list(out_dir.rglob(f'vocals.{ext}')) or list(out_dir.rglob('vocals.wav'))
        if not candidates:
            raise FileNotFoundError('Vocals stem not found — run separation first')

        from faster_whisper import WhisperModel
        _real_stdout.write(f'[waivepulse] Loading {label} model…\n')
        model = WhisperModel(model_name, device='cpu', compute_type='int8')
        _real_stdout.write(f'[waivepulse] Transcribing vocals for sep {sep_id}…\n')
        segments, _ = model.transcribe(
            str(candidates[0]),
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            beam_size=5,
            temperature=0.0,
        )

        transcript_words = []
        for seg in segments:
            for w in (seg.words or []):
                wrd = w.word.strip()
                if wrd:
                    transcript_words.append({'word': wrd, 'start': round(w.start, 3), 'end': round(w.end, 3)})

        _real_stdout.write(f'[waivepulse] {label} found {len(transcript_words)} words\n')

        match_pct = None
        if lyrics and transcript_words:
            lyric_words = _extract_lyric_words(lyrics)
            alignment   = _lcs_align(lyric_words, transcript_words)
            matched     = sum(1 for a in alignment if a is not None)
            match_pct   = round(matched / len(lyric_words) * 100, 1) if lyric_words else 100.0
            _real_stdout.write(f'[waivepulse] LCS matched {matched}/{len(lyric_words)} words ({match_pct}%)\n')
            words = _build_word_timing(lyric_words, alignment, transcript_words)
        else:
            words = [{'word': w['word'], 'start': w['start'], 'end': w['end']} for w in transcript_words]

        msg = f'{len(words)} words'
        if match_pct is not None:
            msg += f', {match_pct}% matched'
        transcribe_jobs[sep_id] = {'status': 'done', 'words': words, 'message': msg, 'match_pct': match_pct}
        sep_jobs[sep_id]['words']     = words
        sep_jobs[sep_id]['match_pct'] = match_pct
        sep_jobs[sep_id]['tx_model']  = model_name
        _save_history()
        _real_stdout.write(f'[waivepulse] Transcription done for sep {sep_id}: {msg}\n')
    except Exception as e:
        transcribe_jobs[sep_id] = {'status': 'error', 'words': None, 'message': str(e)}
        _real_stderr.write(f'[waivepulse] Transcription error for {sep_id}: {e}\n')


def _apply_audioseal(mp3_path: str, job_id: str) -> bool:
    """Embed AudioSeal neural watermark. Must run before ID3 write (re-encodes file)."""
    global _audioseal_gen
    if not (_AUDIOSEAL and _TORCHAUDIO and _FFMPEG):
        return False
    try:
        import torch
        import torchaudio
        from audioseal import AudioSeal
        import hashlib

        if _audioseal_gen is None:
            _real_stdout.write("[waivepulse] Loading AudioSeal model…\n")
            _audioseal_gen = AudioSeal.load_generator("audioseal_wm_16bits")
            _audioseal_gen.eval()

        waveform, sr = torchaudio.load(mp3_path)

        # Resample to 16 kHz for watermark generation
        if sr != 16000:
            down = torchaudio.transforms.Resample(sr, 16000)
            wf16 = down(waveform)
        else:
            wf16 = waveform

        # Deterministic 16-bit message derived from job_id
        h   = hashlib.sha256(f"waivepulse:{job_id}".encode()).digest()
        msg = torch.tensor(
            [[int(b) for b in format(int.from_bytes(h[:2], "big"), "016b")]],
            dtype=torch.float32,
        )

        with torch.no_grad():
            wm16 = _audioseal_gen.get_watermark(wf16.unsqueeze(0), sample_rate=16000, message=msg)

        # Upsample watermark back to original sample rate
        if sr != 16000:
            up   = torchaudio.transforms.Resample(16000, sr)
            wm   = up(wm16.squeeze(0))
        else:
            wm = wm16.squeeze(0)

        # Add watermark and clamp
        min_len = min(waveform.shape[-1], wm.shape[-1])
        result  = (waveform[..., :min_len] + wm[..., :min_len]).clamp(-1.0, 1.0)

        # WAV → MP3 via ffmpeg (preserves original sample rate / quality)
        tmp_wav = mp3_path + ".wm.wav"
        tmp_mp3 = mp3_path + ".wm.mp3"
        try:
            torchaudio.save(tmp_wav, result, sr)
            ret = subprocess.run(
                ["ffmpeg", "-y", "-i", tmp_wav, "-q:a", "2", tmp_mp3],
                capture_output=True,
            )
            if ret.returncode == 0:
                shutil.move(tmp_mp3, mp3_path)
                return True
        finally:
            for p in (tmp_wav, tmp_mp3):
                if os.path.exists(p):
                    os.unlink(p)
        return False
    except Exception as e:
        _real_stderr.write(f"[waivepulse] AudioSeal failed: {e}\n")
        return False


def _apply_c2pa(mp3_path: str, title: str, tags: str, job_id: str) -> bool:
    """Embed C2PA provenance manifest with a self-signed WAIvePulse certificate."""
    if not (_C2PA and _CRYPTOGRAPHY):
        return False
    try:
        import c2pa as c2pa_sdk
        import io
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec

        cert_pem, key_pem = _get_waivepulse_creds()
        private_key = serialization.load_pem_private_key(key_pem, password=None)

        manifest = {
            "claim_generator": "WAIvePulse/1.0",
            "claim_generator_info": [{"name": "WAIvePulse", "version": "1.0"}],
            "title": title,
            "assertions": [
                {
                    "label": "c2pa.training-mining",
                    "data": {"entries": {"c2pa.ai_generative_training": {"use": "notAllowed"}}},
                },
                {
                    "label": "c2pa.ai.generatedInfo",
                    "data": {
                        "description": f"AI-generated music via WAIvePulse. Tags: {tags}",
                        "modelUsed": "HeartMuLa 3B",
                    },
                },
            ],
        }

        def sign_fn(data: bytes) -> bytes:
            return private_key.sign(data, ec.ECDSA(hashes.SHA256()))

        signer  = c2pa_sdk.create_signer(sign_fn, "es256", cert_pem.decode(), None)
        builder = c2pa_sdk.Builder(manifest)

        with open(mp3_path, "rb") as f_in:
            out_buf = io.BytesIO()
            builder.sign(signer, "audio/mpeg", f_in, out_buf)

        with open(mp3_path, "wb") as f_out:
            f_out.write(out_buf.getvalue())

        return True
    except Exception as e:
        _real_stderr.write(f"[waivepulse] C2PA embedding failed: {e}\n")
        return False


def _save_history():
    try:
        data = {"jobs": jobs, "sep_jobs": sep_jobs}
        HISTORY_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")
    except Exception as e:
        _real_stderr.write(f"[waivepulse] Failed to save history: {e}\n")


def _load_history():
    if not HISTORY_FILE.exists():
        return
    try:
        raw = json.loads(HISTORY_FILE.read_text(encoding="utf-8"))
        # Support old format (flat dict of jobs)
        if "jobs" in raw and isinstance(raw["jobs"], dict):
            job_data = raw["jobs"]
            sep_data = raw.get("sep_jobs", {})
        else:
            job_data = raw
            sep_data = {}

        for job_id, job in job_data.items():
            if job.get("status") in ("generating", "queued"):
                job["status"]  = "error"
                job["message"] = "Server restarted — job lost"
            jobs[job_id] = job

        for sep_id, sep in sep_data.items():
            if sep.get("status") in ("separating", "queued"):
                sep["status"]  = "error"
                sep["message"] = "Server restarted — job lost"
            sep_jobs[sep_id] = sep
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
            audio_wm = _apply_audioseal(out_path, job_id)   # re-encodes — must be first
            _write_metadata(out_path, title, artist, tags, temperature, cfg_scale)
            c2pa_ok  = _apply_c2pa(out_path, title, tags, job_id)
            bpm, key = _detect_bpm_key(out_path)
            filename = _output_filename(title, job_id)
            jobs[job_id]["status"]           = "done"
            jobs[job_id]["file"]             = f"/outputs/{filename}.mp3"
            jobs[job_id]["file_size"]        = os.path.getsize(out_path)
            jobs[job_id]["message"]          = "Generation complete"
            jobs[job_id]["bpm"]              = bpm
            jobs[job_id]["key"]              = key
            jobs[job_id]["watermarked_audio"]= audio_wm
            jobs[job_id]["watermarked_c2pa"] = c2pa_ok

    except Exception as e:
        msg = str(e)
        if "out of memory" in msg.lower():
            msg += (
                "\n\nCommon causes on a 12 GB card:"
                "\n  1. Ollama is still holding a lyric model in VRAM. Run: ollama stop <model-name>"
                "\n  2. A previous generation crashed without releasing memory — restart this server."
                "\n  3. Another GPU app is open (browser with WebGL, video player, second model)."
                "\nIf none of the above: your GPU is genuinely too small for HeartMuLa 3B (~12 GB required)."
            )
        jobs[job_id]["status"]  = "error"
        jobs[job_id]["message"] = msg
        _real_stderr.write(f"[waivepulse] Generation error for {job_id}: {e}\n")
    finally:
        _thread_local.job_log = None
        _save_history()


# ── Separation worker ─────────────────────────────────────────────────────────
def _run_separation(sep_id, source_file, job_id):
    log = []
    sep_logs[sep_id]      = log
    sep_jobs[sep_id]["status"] = "separating"
    _save_history()

    out_dir = OUTPUTS_DIR / f"sep_{sep_id}"
    out_dir.mkdir(exist_ok=True)

    try:
        source_path = Path(source_file)
        if not source_path.exists():
            raise FileNotFoundError(f"Source file not found: {source_file}")

        cmd = [PYTHON_EXE, "-m", "demucs",
               "-n", "htdemucs_6s",
               "--out", str(out_dir),
               str(source_path)]
        if _FFMPEG:
            cmd.insert(3, "--mp3")

        log.append(f"Starting separation: {source_path.name}")
        log.append(f"Output dir: {out_dir}")
        log.append(f"Using {'MP3' if _FFMPEG else 'WAV'} output")

        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        for line in proc.stdout:
            clean = _ANSI_RE.sub('', line).strip()
            if clean:
                log.append(clean)

        proc.wait()

        if proc.returncode != 0:
            raise RuntimeError(f"Demucs exited with code {proc.returncode}")

        ext = "mp3" if _FFMPEG else "wav"
        stem_dir = out_dir / "htdemucs_6s" / source_path.stem
        stems = {}
        for stem_name in ("vocals", "drums", "bass", "guitar", "piano", "other"):
            stem_file = stem_dir / f"{stem_name}.{ext}"
            if stem_file.exists():
                stems[stem_name] = f"/stems/{sep_id}/{stem_name}.{ext}"

        sep_jobs[sep_id]["status"] = "done"
        sep_jobs[sep_id]["stems"]  = stems
        sep_jobs[sep_id]["message"] = f"Separated into {len(stems)} stems"
        log.append(f"Done — {len(stems)} stems ready")

    except Exception as e:
        sep_jobs[sep_id]["status"]  = "error"
        sep_jobs[sep_id]["message"] = str(e)
        _real_stderr.write(f"[waivepulse] Separation error for {sep_id}: {e}\n")
    finally:
        _save_history()


# ── Queue worker ──────────────────────────────────────────────────────────────
def _queue_worker():
    while True:
        item = _job_queue.get()
        try:
            kind = item[0]
            if kind == "generate":
                _, job_id, kwargs = item
                if jobs.get(job_id, {}).get("status") != "cancelled":
                    _run_generation(job_id, **kwargs)
            elif kind == "separate":
                _, sep_id, kwargs = item
                if sep_jobs.get(sep_id, {}).get("status") != "cancelled":
                    _run_separation(sep_id, **kwargs)
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
    ms = _models_ready()
    ms["watermark"] = {
        "audioseal": _AUDIOSEAL and _TORCHAUDIO and _FFMPEG,
        "c2pa":      _C2PA and _CRYPTOGRAPHY,
    }
    return ms


@app.get("/", response_class=HTMLResponse)
def index():
    html_path = FRONTEND_DIR / "index.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>Frontend not found</h1>", status_code=404)


@app.get("/studio", response_class=HTMLResponse)
def studio():
    html_path = FRONTEND_DIR / "studio.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>Studio not found</h1>", status_code=404)


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
        "bpm":              None,
        "key":              None,
        "watermarked_audio":None,
        "watermarked_c2pa": None,
    }
    cancel_flags[job_id] = threading.Event()
    _job_queue.put(("generate", job_id, {
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


def _recover_job(job_id: str) -> bool:
    """Try to reconstruct a job record from the outputs directory."""
    candidates = list(OUTPUTS_DIR.glob(f"*_{job_id}.mp3"))
    if not candidates:
        return False
    mp3 = candidates[0]
    title = mp3.stem.rsplit(f"_{job_id}", 1)[0].replace("_", " ")
    jobs[job_id] = {
        "status":   "done", "message": "Recovered from disk",
        "file":     f"/outputs/{mp3.name}",
        "file_size": mp3.stat().st_size,
        "title":    title,  "artist": "",
        "tags":     "",     "lyrics": "",
        "max_duration_sec": None, "temperature": None,
        "cfg_scale": None,  "created_at": None,
    }
    return True


def _recover_sep(sep_id: str) -> bool:
    """Try to reconstruct a separation record from the outputs directory."""
    out_dir = OUTPUTS_DIR / f"sep_{sep_id}"
    if not out_dir.exists():
        return False
    ext   = "mp3" if _FFMPEG else "wav"
    stems = {}
    for name in ("vocals", "drums", "bass", "guitar", "piano", "other"):
        hits = list(out_dir.rglob(f"{name}.{ext}")) or list(out_dir.rglob(f"{name}.wav"))
        if hits:
            stems[name] = f"/stems/{sep_id}/{hits[0].name}"
    if not stems:
        return False
    sep_jobs[sep_id] = {
        "status": "done", "message": f"Recovered from disk ({len(stems)} stems)",
        "job_id": None,   "title": "Unknown",
        "stems":  stems,  "created_at": None,
    }
    return True


@app.get("/status/{job_id}")
def status(job_id: str):
    if job_id not in jobs and not _recover_job(job_id):
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


# ── Separation routes ─────────────────────────────────────────────────────────
@app.post("/separate/{job_id}")
def separate(job_id: str):
    if not _DEMUCS:
        raise HTTPException(
            status_code=503,
            detail="Demucs is not installed. Run: pip install demucs",
        )
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    job = jobs[job_id]
    if job.get("status") != "done":
        raise HTTPException(status_code=400, detail="Job must be done before separating")

    stored_file = job.get("file")
    if not stored_file:
        raise HTTPException(status_code=400, detail="No output file for this job")

    source_path = OUTPUTS_DIR / Path(stored_file).name
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Output file not found on disk")

    # Return existing separation if one already completed or is in progress
    for existing_id, sep in sep_jobs.items():
        if sep.get("job_id") == job_id and sep.get("status") in ("done", "queued", "separating"):
            return {"sep_id": existing_id}

    sep_id = str(uuid.uuid4())[:8]
    sep_jobs[sep_id] = {
        "status":     "queued",
        "message":    "Queued",
        "job_id":     job_id,
        "title":      job.get("title", "Untitled"),
        "stems":      {},
        "created_at": datetime.now().isoformat(),
    }
    _job_queue.put(("separate", sep_id, {
        "source_file": str(source_path),
        "job_id":      job_id,
    }))
    _save_history()
    return {"sep_id": sep_id}


@app.get("/separate/status/{sep_id}")
def sep_status(sep_id: str):
    if sep_id not in sep_jobs and not _recover_sep(sep_id):
        raise HTTPException(status_code=404, detail="Separation job not found")
    return sep_jobs[sep_id]


@app.get("/separate/progress/{sep_id}")
async def sep_progress_stream(sep_id: str):
    import asyncio

    async def event_stream():
        sent = 0
        while True:
            log = sep_logs.get(sep_id, [])
            while sent < len(log):
                yield f"data: {json.dumps(log[sent])}\n\n"
                sent += 1
            s = sep_jobs.get(sep_id, {}).get("status", "")
            if s in ("done", "error"):
                log = sep_logs.get(sep_id, [])
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


@app.get("/stems/{sep_id}/{filename}")
def serve_stem(sep_id: str, filename: str):
    if sep_id not in sep_jobs:
        raise HTTPException(status_code=404, detail="Separation not found")

    sep  = sep_jobs[sep_id]
    job  = jobs.get(sep.get("job_id", ""), {})
    src  = job.get("file", "")
    src_stem = Path(src).stem.rsplit("_", 1)[0] if src else "audio"

    # htdemucs_6s uses the source filename stem as the subfolder
    ext      = "mp3" if _FFMPEG else "wav"
    stem_name = Path(filename).stem
    out_dir  = OUTPUTS_DIR / f"sep_{sep_id}"

    # Find the actual stem file — Demucs uses source filename as subdirectory
    candidates = list(out_dir.rglob(f"{stem_name}.{ext}"))
    if not candidates:
        # Try wav fallback
        candidates = list(out_dir.rglob(f"{stem_name}.wav"))
    if not candidates:
        raise HTTPException(status_code=404, detail=f"Stem {filename} not found")

    return FileResponse(
        str(candidates[0]),
        media_type="audio/mpeg" if candidates[0].suffix == ".mp3" else "audio/wav",
    )


@app.get("/stems/{sep_id}/zip")
def download_stems_zip(sep_id: str):
    out_dir = OUTPUTS_DIR / f"sep_{sep_id}"
    if not out_dir.exists():
        raise HTTPException(status_code=404, detail="Separation directory not found — stem files may have been deleted")

    ext = "mp3" if _FFMPEG else "wav"
    stem_files = []
    for name in ("vocals", "drums", "bass", "guitar", "piano", "other"):
        hits = list(out_dir.rglob(f"{name}.{ext}")) or list(out_dir.rglob(f"{name}.wav"))
        if hits:
            stem_files.append(hits[0])

    if not stem_files:
        raise HTTPException(status_code=404, detail="No stem files found")

    sep   = sep_jobs.get(sep_id) or {}
    title = sep.get("title", "stems")
    buf   = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for f in stem_files:
            zf.write(f, arcname=f.name)

    buf.seek(0)
    slug = re.sub(r"[^\w\s-]", "", title).strip()
    slug = re.sub(r"[\s_]+", "_", slug)[:48].strip("_") or "stems"

    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{slug}_stems.zip"'},
    )


@app.post("/upload")
async def upload_audio(file: UploadFile = FastAPIFile(...)):
    """Upload any audio file for Studio use — saves to outputs/ and creates a job record."""
    original = Path(file.filename or "upload.mp3")
    safe_stem = re.sub(r"[^\w\s-]", "", original.stem).strip()
    safe_stem = re.sub(r"\s+", "_", safe_stem)[:48] or "upload"
    suffix    = original.suffix.lower() or ".mp3"

    job_id   = str(uuid.uuid4())[:8]
    filename = f"{safe_stem}_{job_id}{suffix}"
    out_path = OUTPUTS_DIR / filename

    content = await file.read()
    out_path.write_bytes(content)

    bpm, key = _detect_bpm_key(str(out_path))

    jobs[job_id] = {
        "status":           "done",
        "message":          "Uploaded file",
        "file":             f"/outputs/{filename}",
        "file_size":        len(content),
        "title":            safe_stem.replace("_", " "),
        "artist":           "",
        "tags":             "",
        "lyrics":           "",
        "max_duration_sec": None,
        "temperature":      None,
        "cfg_scale":        None,
        "created_at":       datetime.now().isoformat(),
        "bpm":              bpm,
        "key":              key,
        "watermarked_audio":False,
        "watermarked_c2pa": False,
    }
    _save_history()
    return {"job_id": job_id}


@app.get("/demucs-status")
def demucs_status():
    return {"available": _DEMUCS, "ffmpeg": _FFMPEG}


@app.get("/ollama-status")
def ollama_status():
    """Check whether Ollama is reachable on localhost:11434 and list installed models."""
    import urllib.request
    try:
        with urllib.request.urlopen("http://localhost:11434/api/tags", timeout=2) as r:
            data = json.loads(r.read().decode("utf-8"))
        models = [m.get("name") for m in data.get("models", []) if m.get("name")]
        return {"available": True, "models": models}
    except Exception:
        return {"available": False, "models": []}


class LyricsRequest(BaseModel):
    theme: str = ""
    structure: str = "Verse-Chorus-Verse-Chorus-Bridge-Chorus"
    tone: str = ""
    rhyme: str = ""
    style: str = ""
    model: str = "llama3.1:8b"
    temperature: float = 0.9


def _build_lyrics_prompt(req: LyricsRequest) -> str:
    parts = [
        "You are a professional songwriter. Write song lyrics in the structure requested.",
        "",
        "Rules:",
        "- Use ONLY these section markers, each on its own line: [Intro], [Verse], [Prechorus], [Chorus], [Bridge], [Outro]",
        "- Do NOT number sections. Write [Verse] not [Verse 1]. Repeat the same marker if the section repeats.",
        "- Keep lines roughly 5-9 syllables so they fit a melody.",
        "- Use vivid concrete imagery. Avoid cliches like 'time stood still', 'broken hearts', 'crazy little thing'.",
        "- Repeat the [Chorus] verbatim each time it appears.",
        "- Output ONLY the lyrics. No title, no commentary, no explanation before or after.",
    ]
    if req.theme:     parts.append(f"\nTheme / topic: {req.theme}")
    if req.structure: parts.append(f"Structure: {req.structure}")
    if req.tone:      parts.append(f"Tone / mood: {req.tone}")
    if req.rhyme:     parts.append(f"Rhyme scheme: {req.rhyme}")
    if req.style:     parts.append(f"Style reference: {req.style}")
    parts.append("\nLyrics:")
    return "\n".join(parts)


@app.post("/lyrics/suggest")
def suggest_lyrics(req: LyricsRequest):
    """Generate lyrics via local Ollama. Requires Ollama running on localhost:11434."""
    import urllib.request, urllib.error
    body = json.dumps({
        "model":      req.model,
        "prompt":     _build_lyrics_prompt(req),
        "stream":     False,
        "options":    {"temperature": req.temperature, "top_p": 0.9},
        # Unload the model from VRAM the moment the response is returned.
        # Prevents Ollama from holding ~5 GB while the user moves on to a
        # HeartMuLa generation job (12 GB card = OOM otherwise).
        "keep_alive": 0,
    }).encode("utf-8")
    request = urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=300) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.URLError as e:
        raise HTTPException(status_code=503, detail=f"Ollama not reachable on localhost:11434. Is it running? ({e.reason})")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lyric generation failed: {e}")
    return {"lyrics": (data.get("response") or "").strip(), "model": req.model}


@app.post("/lyrics/suggest/stream")
def suggest_lyrics_stream(req: LyricsRequest):
    """Streaming variant — relays each Ollama token as an SSE event."""
    import urllib.request, urllib.error

    def event_stream():
        body = json.dumps({
            "model":      req.model,
            "prompt":     _build_lyrics_prompt(req),
            "stream":     True,
            "options":    {"temperature": req.temperature, "top_p": 0.9},
            "keep_alive": 0,
        }).encode("utf-8")
        request = urllib.request.Request(
            "http://localhost:11434/api/generate",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=300) as r:
                for raw in r:
                    if not raw.strip():
                        continue
                    try:
                        chunk = json.loads(raw.decode("utf-8"))
                    except Exception:
                        continue
                    tok = chunk.get("response", "")
                    if tok:
                        yield f"data: {json.dumps(tok)}\n\n"
                    if chunk.get("done"):
                        yield "data: __done__\n\n"
                        return
        except urllib.error.URLError as e:
            err = f"Ollama not reachable on localhost:11434 ({e.reason})"
            yield f"data: {json.dumps({'__error__': err})}\n\n"
        except Exception as e:
            yield f"data: {json.dumps({'__error__': str(e)})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/lyrics", response_class=HTMLResponse)
def lyrics_page():
    html_path = FRONTEND_DIR / "lyrics.html"
    if html_path.exists():
        return html_path.read_text(encoding="utf-8")
    raise HTTPException(status_code=404, detail="lyrics.html not found")


@app.get("/whisper-status")
def whisper_status():
    return {"available": _FASTER_WHISPER}


@app.post("/transcribe/{sep_id}")
def start_transcription(
    sep_id: str,
    force: bool = Query(False, description="Clear cached words and re-run"),
    model: str  = Query("base",  description="Whisper model: tiny/base/small/medium/large-v2/large-v3"),
):
    if not _FASTER_WHISPER:
        raise HTTPException(status_code=503, detail="faster-whisper not installed. Run: pip install faster-whisper")
    if sep_id not in sep_jobs and not _recover_sep(sep_id):
        raise HTTPException(status_code=404, detail="Separation not found")
    if sep_jobs[sep_id].get("status") != "done":
        raise HTTPException(status_code=400, detail="Separation must complete before transcribing")
    if model not in WHISPER_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown model. Choose from: {', '.join(WHISPER_MODELS)}")
    if force:
        sep_jobs[sep_id].pop("words",     None)
        sep_jobs[sep_id].pop("match_pct", None)
        sep_jobs[sep_id].pop("tx_model",  None)
        transcribe_jobs.pop(sep_id, None)
        _save_history()
    # Return cached result from sep_jobs (persisted across restarts)
    if sep_jobs[sep_id].get("words"):
        return {"status": "done", "words": sep_jobs[sep_id]["words"],
                "match_pct": sep_jobs[sep_id].get("match_pct"),
                "tx_model":  sep_jobs[sep_id].get("tx_model")}
    existing = transcribe_jobs.get(sep_id, {})
    if existing.get("status") == "transcribing":
        return {"status": "transcribing"}
    if existing.get("status") == "done":
        return {"status": "done", "words": existing["words"], "match_pct": existing.get("match_pct")}
    threading.Thread(target=_run_transcription, args=(sep_id, model), daemon=True, name=f"transcribe-{sep_id}").start()
    return {"status": "transcribing"}


@app.get("/transcribe/status/{sep_id}")
def transcription_status(sep_id: str):
    # Persisted words survive server restarts
    sep = sep_jobs.get(sep_id, {})
    if sep.get("words"):
        return {"status": "done", "words": sep["words"],
                "match_pct": sep.get("match_pct"), "tx_model": sep.get("tx_model")}
    job = transcribe_jobs.get(sep_id)
    if not job:
        return {"status": "none"}
    return job


@app.get("/karaoke", response_class=HTMLResponse)
def karaoke_page():
    html_path = FRONTEND_DIR / "karaoke.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>Karaoke page not found</h1>", status_code=404)


@app.get("/looper", response_class=HTMLResponse)
def looper_page():
    html_path = FRONTEND_DIR / "looper.html"
    if html_path.exists():
        return HTMLResponse(content=html_path.read_text(encoding="utf-8"))
    return HTMLResponse(content="<h1>Looper page not found</h1>", status_code=404)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app:app", host="0.0.0.0", port=7861, reload=False)
