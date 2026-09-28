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
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse, Response
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

# Static frontend assets split out of the HTML pages (ES modules, CSS, AudioWorklets)
for _sub in ("js", "css", "worklets"):
    (FRONTEND_DIR / _sub).mkdir(parents=True, exist_ok=True)

app.mount("/outputs",  StaticFiles(directory=str(OUTPUTS_DIR)), name="outputs")
app.mount("/assets",   StaticFiles(directory=str(ASSETS_DIR)),  name="assets")
app.mount("/js",       StaticFiles(directory=str(FRONTEND_DIR / "js")),       name="js")
app.mount("/css",      StaticFiles(directory=str(FRONTEND_DIR / "css")),      name="css")
app.mount("/worklets", StaticFiles(directory=str(FRONTEND_DIR / "worklets")), name="worklets")


@app.middleware("http")
async def _no_cache_frontend(request, call_next):
    """Always revalidate the split frontend assets so edits show up on a normal
    reload (ES-module imports aren't cache-busted, so stale modules would mismatch),
    and never cache the dynamic /history list so the song library reflects the server
    immediately (e.g. after a restart or a manual history.json edit)."""
    resp = await call_next(request)
    if request.url.path.startswith(("/js/", "/css/", "/worklets/", "/history")):
        resp.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
    return resp

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
                    temperature: float, cfg_scale: float, seed: Optional[int] = None):
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
            text=f"Tags: {tags} | Temperature: {temperature} | CFG Scale: {cfg_scale}"
                 + (f" | Seed: {seed}" if seed is not None else ""),
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


def _detect_chords(mp3_path: str) -> list:
    """Return a list of {chord, start, end} spans, or [] if librosa unavailable."""
    if not _LIBROSA:
        return []
    try:
        import librosa
        import numpy as np

        y, sr = librosa.load(mp3_path, sr=22050, mono=True)
        hop = int(sr * 0.5)
        chroma = librosa.feature.chroma_cqt(y=y, sr=sr, hop_length=hop)

        NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B']
        major_tpl = np.array([1,0,0,0,1,0,0,1,0,0,0,0], dtype=float)
        minor_tpl = np.array([1,0,0,1,0,0,0,1,0,0,0,0], dtype=float)

        n_frames = chroma.shape[1]
        labels = []
        for f in range(n_frames):
            vec = chroma[:, f]
            best_score, best_label = -1e9, "C"
            for root in range(12):
                for tpl, suffix in [(major_tpl, ""), (minor_tpl, "m")]:
                    rotated = np.roll(tpl, root)
                    score = float(np.dot(vec, rotated))
                    if score > best_score:
                        best_score = score
                        best_label = f"{NOTES[root]}{suffix}"
            labels.append(best_label)

        times = librosa.frames_to_time(
            np.arange(n_frames), sr=sr, hop_length=hop
        )
        duration = float(len(y)) / sr

        # Merge consecutive identical chords into spans
        spans = []
        if labels:
            cur_chord = labels[0]
            cur_start = float(times[0])
            for i in range(1, len(labels)):
                if labels[i] != cur_chord:
                    spans.append({
                        "chord": cur_chord,
                        "start": round(cur_start, 2),
                        "end":   round(float(times[i]), 2),
                    })
                    cur_chord = labels[i]
                    cur_start = float(times[i])
            spans.append({
                "chord": cur_chord,
                "start": round(cur_start, 2),
                "end":   round(duration, 2),
            })

        return spans
    except Exception as e:
        _real_stderr.write(f"[waivepulse] Chord detection failed: {e}\n")
        return []


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

        # ── Diagnostics: which vocals file are we feeding Whisper? ──
        vocals_path = candidates[0]
        try:
            _sz = vocals_path.stat().st_size
        except OSError:
            _sz = -1
        _real_stdout.write(
            f'[waivepulse] Vocals stem: {vocals_path} ({_sz} bytes); '
            f'{len(candidates)} candidate(s) under {out_dir}\n'
        )
        if len(candidates) > 1:
            _real_stdout.write('[waivepulse]   other candidates: '
                               + ', '.join(str(c) for c in candidates[1:]) + '\n')
        if 0 <= _sz < 2048:
            _real_stdout.write('[waivepulse] ⚠ vocals stem is tiny/empty — separation likely produced no vocals\n')

        from faster_whisper import WhisperModel
        _real_stdout.write(f'[waivepulse] Loading {label} model…\n')
        model = WhisperModel(model_name, device='cpu', compute_type='int8')
        _real_stdout.write(f'[waivepulse] Transcribing vocals for sep {sep_id}…\n')
        segments, info = model.transcribe(
            str(vocals_path),
            word_timestamps=True,
            vad_filter=True,
            vad_parameters={"min_silence_duration_ms": 400},
            beam_size=5,
            temperature=0.0,
        )
        _real_stdout.write(
            f'[waivepulse] Whisper info: language={getattr(info, "language", "?")} '
            f'(p={getattr(info, "language_probability", 0) or 0:.2f}), '
            f'audio_duration={getattr(info, "duration", 0) or 0:.1f}s\n'
        )

        transcript_words = []
        seg_texts = []
        for seg in segments:
            seg_texts.append(seg.text)
            for w in (seg.words or []):
                wrd = w.word.strip()
                if wrd:
                    transcript_words.append({'word': wrd, 'start': round(w.start, 3), 'end': round(w.end, 3)})

        full_text = ' '.join(t.strip() for t in seg_texts).strip()
        _real_stdout.write(
            f'[waivepulse] {label} found {len(transcript_words)} words '
            f'in {len(seg_texts)} segment(s)\n'
        )
        _real_stdout.write(f'[waivepulse]   raw transcript: {full_text[:300]!r}\n')
        if transcript_words:
            _real_stdout.write('[waivepulse]   first words: '
                               + repr(' '.join(w['word'] for w in transcript_words[:25])) + '\n')
        else:
            _real_stdout.write('[waivepulse] ⚠ Whisper returned no words — vocals may be near-silent or '
                               'VAD filtered everything (try the Re-sync button with a larger model)\n')

        match_pct = None
        if lyrics and transcript_words:
            lyric_words = _extract_lyric_words(lyrics)
            _real_stdout.write(
                f'[waivepulse] {len(lyric_words)} lyric words to align; first: '
                + repr(' '.join(str(w) for w in lyric_words[:25])) + '\n'
            )
            alignment   = _lcs_align(lyric_words, transcript_words)
            matched     = sum(1 for a in alignment if a is not None)
            match_pct   = round(matched / len(lyric_words) * 100, 1) if lyric_words else 100.0
            _real_stdout.write(f'[waivepulse] LCS matched {matched}/{len(lyric_words)} words ({match_pct}%)\n')
            if matched == 0:
                _real_stdout.write('[waivepulse] ⚠ 0 matched — Whisper heard something but it does not line up '
                                   'with the lyrics. Compare the raw transcript above to your lyrics: wrong song/stem, '
                                   'wrong language, or instrumental bleed.\n')
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
                creationflags=_NO_WINDOW,
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


_history_lock = threading.RLock()


def _save_history():
    """Serialize + write history.json atomically. The lock stops two threads (the
    queue worker and a request handler, e.g. a favorite toggle) from interleaving
    writes, and temp-file + os.replace means a crash mid-write can never leave a
    half-written (corrupt) history.json behind."""
    with _history_lock:
        try:
            for attempt in range(3):
                try:   # a request thread may add a job mid-dump → "changed size during iteration"
                    payload = json.dumps({"jobs": jobs, "sep_jobs": sep_jobs}, indent=2)
                    break
                except RuntimeError:
                    if attempt == 2:
                        raise
            tmp = HISTORY_FILE.with_name(HISTORY_FILE.name + ".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(payload)
                f.flush()
                os.fsync(f.fileno())
            for attempt in range(5):
                try:
                    os.replace(tmp, HISTORY_FILE)
                    break
                except PermissionError:   # Windows: file briefly open elsewhere (AV, editor)
                    if attempt == 4:
                        raise
                    import time
                    time.sleep(0.05 * (attempt + 1))
        except Exception as e:
            _real_stderr.write(f"[waivepulse] Failed to save history: {e}\n")


# ── Seeds ──────────────────────────────────────────────────────────────────────
SEED_MAX = 2**32 - 1


def _resolve_seed(seed: Optional[int]) -> int:
    """Return *seed* clamped to the 32-bit range, or a fresh random 32-bit seed."""
    if seed is None:
        import secrets
        return secrets.randbelow(SEED_MAX + 1)
    return int(seed) % (SEED_MAX + 1)


def _seed_everything(seed: int) -> int:
    """Seed python `random`, numpy and torch (CPU + every CUDA device) so a
    generation with the same seed + settings is reproducible."""
    import random
    seed = int(seed) % (SEED_MAX + 1)
    random.seed(seed)
    try:
        import numpy as np
        np.random.seed(seed)
    except ImportError:
        pass
    try:
        import torch
        torch.manual_seed(seed)          # also seeds all CUDA devices
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
    except ImportError:
        pass
    return seed


# ── Instrumental ───────────────────────────────────────────────────────────────
# HeartMuLa has no dedicated instrumental token or mode (heartlib's
# music_generation.preprocess just lower-cases + tokenizes the lyrics text).
# The documented convention (heartlib README "Recommended format of lyrics") is
# that a section marker with no lines under it — e.g. "[Intro]\n\n" — is a
# non-sung section. So an instrumental = section markers only, plus the
# "instrumental" tag from the HeartMuLa tag guide (Gender category).
_SECTION_RE = re.compile(r"^\s*\[[^\]]+\]\s*$")
_DEFAULT_INSTRUMENTAL_SECTIONS = ["[Intro]", "[Verse]", "[Chorus]", "[Verse]", "[Chorus]", "[Bridge]", "[Chorus]", "[Outro]"]


def _instrumental_lyrics(lyrics: str) -> str:
    """Strip sung lines, keeping the user's section structure (or a default one)."""
    markers = [ln.strip() for ln in (lyrics or "").splitlines() if _SECTION_RE.match(ln)]
    if not markers:
        markers = _DEFAULT_INSTRUMENTAL_SECTIONS
    return "\n\n".join(markers) + "\n"


def _add_tag(tags: str, tag: str) -> str:
    parts = [t.strip() for t in (tags or "").split(",") if t.strip()]
    if tag.lower() not in (p.lower() for p in parts):
        parts.append(tag)
    return ",".join(parts)


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
def _run_generation(job_id, lyrics, tags, title, artist, max_ms, temperature, cfg_scale, topk, seed=None):
    log = []
    job_logs[job_id]      = log
    _thread_local.job_log = log
    _thread_local._buf    = ''

    jobs[job_id]["status"] = "generating"
    _save_history()

    out_path = None
    try:
        if cancel_flags.get(job_id, threading.Event()).is_set():   # cancelled before model load
            jobs[job_id]["status"]  = "cancelled"
            jobs[job_id]["message"] = "Cancelled"
            return
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

            if seed is not None:
                _seed_everything(seed)
                log.append(f"Seed: {seed}")

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
            _write_metadata(out_path, title, artist, tags, temperature, cfg_scale, seed)
            cover_ok = _embed_cover(out_path, job_id, {"title": title, "artist": artist, "tags": tags})
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
            jobs[job_id]["cover_embedded"]   = cover_ok

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


def _vram_free_mb():
    """Free VRAM in MB, or None when there is no NVIDIA card / nvidia-smi."""
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=memory.free", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=15,
                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if r.returncode == 0 and r.stdout.strip():
            return int(r.stdout.strip().splitlines()[0])
    except Exception:
        pass
    return None


def _ollama_release_vram(log=None):
    """Ask Ollama to let go of idle models.

    Ollama can be told to keep a model in VRAM for ever (OLLAMA_KEEP_ALIVE=-1). That is fine
    until something else on the same card needs the memory, which is what separation does.
    Unloading is free: the next lyric request just reloads the model.
    """
    freed = []
    try:
        import urllib.request
        with urllib.request.urlopen("http://127.0.0.1:11434/api/ps", timeout=5) as r:
            loaded = json.loads(r.read().decode("utf-8")).get("models", [])
        for m in loaded:
            name = m.get("name") or m.get("model")
            if not name:
                continue
            body = json.dumps({"model": name, "keep_alive": 0, "prompt": ""}).encode()
            req = urllib.request.Request("http://127.0.0.1:11434/api/generate", data=body,
                                         headers={"Content-Type": "application/json"})
            try:
                urllib.request.urlopen(req, timeout=20).read()
                freed.append(name)
            except Exception:
                pass
    except Exception:
        return []
    if freed and log is not None:
        log.append("Asked Ollama to unload " + ", ".join(freed) + " to free GPU memory")
    return freed


# Windows kills a process that corrupts its heap or faults; the code is an exception value,
# not an error message, so the output says nothing useful about running out of VRAM.
_WIN_CRASH_CODES = {3221225477, 3221225725, 3221226356, 3221225781, 3221225620}


def _looks_like_a_crash(rc):
    return rc in _WIN_CRASH_CODES or rc < 0 or rc > 2 ** 30


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

        free = _vram_free_mb()
        if free is not None:
            log.append(f"GPU: {free} MB free")
            if free < 2500:
                log.append("Not much GPU memory left for separation - trying to free some first")
                if _ollama_release_vram(log):
                    time.sleep(3)
                    free = _vram_free_mb()
                    log.append(f"GPU: {free} MB free after unloading")

        log.append(f"Starting separation: {source_path.name}")
        log.append(f"Output dir: {out_dir}")
        log.append(f"Using {'MP3' if _FFMPEG else 'WAV'} output")

        def _run(c):
            proc = subprocess.Popen(
                c, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding="utf-8", errors="replace",
            )
            for line in proc.stdout:
                clean = _ANSI_RE.sub('', line).strip()
                if clean:
                    log.append(clean)
            proc.wait()
            return proc.returncode

        rc = _run(cmd)
        # GPU run failed on a memory/CUDA error? The generator (HeartMuLa) is probably
        # still holding VRAM — fall back to CPU automatically (slower, but it works).
        if rc != 0 and (_looks_like_a_crash(rc)
                        or re.search(r"cuda|out of memory|gpu|cudnn", "\n".join(log[-12:]), re.I)):
            if _looks_like_a_crash(rc):
                log.append(f"⚠ Demucs was killed by Windows (code {rc}). On this card that means it ran "
                           "out of GPU memory - the message never reaches the log.")
                _ollama_release_vram(log)
                time.sleep(3)
                free = _vram_free_mb()
                if free is not None and free >= 3000:
                    log.append(f"⚠ {free} MB free now - trying the GPU once more…")
                    rc = _run(cmd)
            if rc != 0:
                log.append("⚠ GPU separation failed (VRAM likely in use by the song generator) — retrying on CPU; this is slower…")
                rc = _run(cmd + ["-d", "cpu"])
        if rc != 0:
            tail = "\n".join(log[-15:]) or "(no output captured)"
            if _looks_like_a_crash(rc):
                free = _vram_free_mb()
                where = f" Only {free} MB of GPU memory is free." if free is not None else ""
                raise RuntimeError(
                    "Separation crashed, and the CPU attempt failed too." + where +
                    " Close whatever else is using the GPU (Ollama keeps models loaded, and so does "
                    "the song generator) and try again.\n\n--- demucs output ---\n" + tail)
            raise RuntimeError(f"Demucs exited with code {rc}.\n\n--- demucs output ---\n{tail}")

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
    variation_of:     Optional[str]   = None   # job_id of song being varied
    seed:             Optional[int]   = None   # None → random 32-bit seed per take
    count:            Optional[int]   = 1      # batch takes (1-4), each its own queued job
    instrumental:     Optional[bool]  = False  # strip sung lines + add "instrumental" tag (experimental)


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
_gpu_info = None
def _gpu_status() -> dict:
    """Cached CUDA check so a GPU-less user is warned BEFORE generating (importing
    torch is slow, so compute once). Generation needs CUDA; Looper/Studio/Karaoke
    are pure browser Web Audio and work without a GPU."""
    global _gpu_info
    if _gpu_info is None:
        try:
            import torch
            if torch.cuda.is_available():
                props = torch.cuda.get_device_properties(0)
                _gpu_info = {"available": True, "name": props.name,
                             "vram_gb": round(props.total_memory / 1e9, 1)}
            else:
                _gpu_info = {"available": False, "name": None, "vram_gb": 0}
        except Exception as e:
            _gpu_info = {"available": False, "name": None, "vram_gb": 0, "error": str(e)[:200]}
    return _gpu_info


@app.get("/model-status")
def model_status():
    ms = _models_ready()
    ms["watermark"] = {
        "audioseal": _AUDIOSEAL and _TORCHAUDIO and _FFMPEG,
        "c2pa":      _C2PA and _CRYPTOGRAPHY,
    }
    ms["gpu"] = _gpu_status()
    ms["mastering"] = {"available": _DSP, "engine": "builtin"}
    ms["video"] = {"available": _FFMPEG and _PIL}
    return ms


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    ico = ASSETS_DIR / "favicon.ico"
    if ico.exists():
        return FileResponse(str(ico), media_type="image/x-icon")
    return FileResponse(str(ASSETS_DIR / "wave small.png"), media_type="image/png")


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
    count = max(1, min(4, int(req.count or 1)))
    lyrics, tags = req.lyrics, req.tags
    if req.instrumental:
        lyrics = _instrumental_lyrics(lyrics)
        tags   = _add_tag(tags, "instrumental")
    elif not (lyrics or "").strip():
        raise HTTPException(status_code=400, detail="Lyrics are required (or turn on Instrumental)")

    # Locked seed → take i uses seed+i (reproducible); no seed → random per take.
    base_seed = None if req.seed is None else _resolve_seed(req.seed)
    group     = str(uuid.uuid4())[:8] if count > 1 else None
    job_ids, seeds = [], []
    for i in range(count):
        job_id = str(uuid.uuid4())[:8]
        seed   = _resolve_seed(None) if base_seed is None else (base_seed + i) % (SEED_MAX + 1)
        jobs[job_id] = {
            "status":          "queued",
            "message":         "Queued",
            "file":            None,
            "file_size":       None,
            "title":           req.title,
            "artist":          req.artist,
            "tags":            tags,
            "lyrics":          lyrics,
            "max_duration_sec":req.max_duration_sec,
            "temperature":     req.temperature,
            "cfg_scale":       req.cfg_scale,
            "topk":            req.topk,
            "seed":            seed,
            "seed_locked":     base_seed is not None,
            "instrumental":    bool(req.instrumental),
            "take":            i + 1,
            "takes":           count,
            "take_group":      group,
            "favorite":        False,
            "created_at":      datetime.now().isoformat(),
            "bpm":              None,
            "key":              None,
            "watermarked_audio":None,
            "watermarked_c2pa": None,
            "variation_of":    req.variation_of,
        }
        cancel_flags[job_id] = threading.Event()
        _job_queue.put(("generate", job_id, {
            "lyrics":      lyrics,
            "tags":        tags,
            "title":       req.title,
            "artist":      req.artist,
            "max_ms":      req.max_duration_sec * 1000,
            "temperature": req.temperature,
            "cfg_scale":   req.cfg_scale,
            "topk":        req.topk,
            "seed":        seed,
        }))
        job_ids.append(job_id)
        seeds.append(seed)
    _save_history()
    return {"job_id": job_ids[0], "job_ids": job_ids, "seeds": seeds,
            "lyrics": lyrics, "tags": tags}


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


@app.get("/chords/{job_id}")
def chords(job_id: str):
    if job_id not in jobs and not _recover_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    job = jobs[job_id]
    if job["status"] != "done":
        raise HTTPException(status_code=400, detail="Job is not done yet")
    if "chords" in job:
        return {"chords": job["chords"]}
    # Find the source MP3 file
    file_path = job.get("file", "")
    mp3_name  = file_path.split("/")[-1] if file_path else ""
    mp3_path  = OUTPUTS_DIR / mp3_name if mp3_name else None
    if not mp3_path or not mp3_path.exists():
        raise HTTPException(status_code=404, detail="MP3 file not found")
    detected = _detect_chords(str(mp3_path))
    job["chords"] = detected
    _save_history()
    return {"chords": detected}


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


class MetaUpdate(BaseModel):
    title:    Optional[str]  = None
    artist:   Optional[str]  = None
    favorite: Optional[bool] = None
    rating:   Optional[int]  = None   # 0-5 (0 = unrated)


@app.patch("/history/{job_id}")
def update_job_meta(job_id: str, meta: MetaUpdate):
    """Edit library metadata for a song: title / artist / favorite / rating.
    Does NOT rename the mp3 file — only the history record (and the sep_jobs
    title copy) is updated."""
    if meta.rating is not None and not 0 <= meta.rating <= 5:
        raise HTTPException(status_code=400, detail="rating must be 0-5")
    with _history_lock:
        job = jobs.get(job_id)
        if job is None:
            raise HTTPException(status_code=404, detail="Job not found")
        if meta.title is not None:
            job["title"] = meta.title.strip() or "Untitled"
        if meta.artist is not None:
            job["artist"] = meta.artist.strip()
        if meta.favorite is not None:
            job["favorite"] = bool(meta.favorite)
        if meta.rating is not None:
            job["rating"] = int(meta.rating)
        # keep the duplicate title in any separation record (used by Studio/Karaoke) in sync
        if meta.title is not None:
            for sep in sep_jobs.values():
                if sep.get("job_id") == job_id:
                    sep["title"] = job["title"]
        _save_history()
    return {"job_id": job_id, "title": job.get("title"), "artist": job.get("artist", ""),
            "favorite": bool(job.get("favorite")), "rating": job.get("rating", 0)}


@app.delete("/history/{job_id}")
def delete_job(job_id: str):
    if job_id not in jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    stored_file = jobs[job_id].get("file")
    if stored_file:
        mp3 = OUTPUTS_DIR / Path(stored_file).name
        if mp3.exists():
            mp3.unlink()
    vid = (jobs[job_id].get("video") or {}).get("file")
    if vid:
        (OUTPUTS_DIR / "videos" / Path(vid).name).unlink(missing_ok=True)
    video_jobs.pop(job_id, None)
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


@app.get("/stems/library")
def stem_library():
    """List all available stems across all separations, for cross-song stem swapping."""
    library = []
    for sep_id, sep in sep_jobs.items():
        if sep.get("status") != "done" or not sep.get("stems"):
            continue
        job_id = sep.get("job_id")
        job = jobs.get(job_id, {})
        title = job.get("title") or sep.get("title") or "Unknown"
        for stem_name, stem_url in sep.get("stems", {}).items():
            library.append({
                "sep_id": sep_id,
                "job_id": job_id,
                "title": title,
                "stem": stem_name,
                "url": stem_url,
                "bpm": job.get("bpm"),
                "key": job.get("key"),
            })
    stem_order = {"vocals": 0, "drums": 1, "bass": 2, "guitar": 3, "piano": 4, "other": 5}
    library.sort(key=lambda x: (x.get("title", ""), stem_order.get(x["stem"], 9)))
    return {"stems": library}


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


# ── Time-stretch (phase vocoder) ──────────────────────────────────────────────

def _time_stretch_audio(audio_path: str, factor: float) -> bytes:
    """Load audio, time-stretch by *factor*, return WAV bytes.
    factor > 1 = speed up (shorter), factor < 1 = slow down (longer)."""
    import numpy as np, struct
    y, sr = _load_audio(audio_path)          # librosa-free (see "librosa-free DSP core")
    if y.shape[0] == 1:
        y = y[0]
    mono = y.ndim == 1
    if mono:
        ys = _time_stretch_pv(y, factor)
    else:
        # stretch each channel separately, stack back
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=min(4, y.shape[0])) as ex:
            ys = np.stack(list(ex.map(lambda ch: _time_stretch_pv(ch, factor), y)))
    # Encode as 16-bit PCM WAV
    nc = 1 if mono else ys.shape[0]
    if mono:
        samples = ys
    else:
        # interleave channels
        samples = ys.T.flatten()
    samples = np.clip(samples, -1.0, 1.0)
    pcm = (samples * 32767).astype(np.int16).tobytes()
    ns = len(samples) // nc
    # WAV header
    dl = len(pcm)
    hdr = struct.pack('<4sI4s', b'RIFF', 36 + dl, b'WAVE')
    fmt = struct.pack('<4sIHHIIHH', b'fmt ', 16, 1, nc, sr, sr * nc * 2, nc * 2, 16)
    dat = struct.pack('<4sI', b'data', dl)
    return hdr + fmt + dat + pcm


@app.post("/timestretch/{sep_id}/{stem_name}")
def timestretch_stem(sep_id: str, stem_name: str, factor: float = Query(...)):
    """Time-stretch an existing separated stem. factor>1=faster, <1=slower."""
    if not _DSP:
        raise HTTPException(status_code=501, detail="soundfile + scipy are required")
    if factor < 0.25 or factor > 4.0:
        raise HTTPException(status_code=400, detail="factor must be between 0.25 and 4.0")
    if sep_id not in sep_jobs and not _recover_sep(sep_id):
        raise HTTPException(status_code=404, detail="Separation not found")
    # Locate the stem file on disk
    ext = "mp3" if _FFMPEG else "wav"
    out_dir = OUTPUTS_DIR / f"sep_{sep_id}"
    candidates = list(out_dir.rglob(f"{stem_name}.{ext}"))
    if not candidates:
        candidates = list(out_dir.rglob(f"{stem_name}.wav"))
    if not candidates:
        raise HTTPException(status_code=404, detail=f"Stem '{stem_name}' not found")
    wav_bytes = _time_stretch_audio(str(candidates[0]), factor)
    return Response(content=wav_bytes, media_type="audio/wav",
                             headers={"Content-Disposition": f'attachment; filename="{stem_name}_stretched.wav"'})


@app.post("/timestretch")
async def timestretch_upload(file: UploadFile = FastAPIFile(...), factor: float = Query(...)):
    """Time-stretch an uploaded audio file. factor>1=faster, <1=slower."""
    if not _DSP:
        raise HTTPException(status_code=501, detail="soundfile + scipy are required")
    if factor < 0.25 or factor > 4.0:
        raise HTTPException(status_code=400, detail="factor must be between 0.25 and 4.0")
    # Save to temp file
    import tempfile
    content = await file.read()
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        wav_bytes = _time_stretch_audio(tmp_path, factor)
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    return Response(content=wav_bytes, media_type="audio/wav",
                             headers={"Content-Disposition": 'attachment; filename="stretched.wav"'})


# ── Shared audio helpers (pitch shift / mastering) ────────────────────────────
_SAFE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


def _safe_id(value: str, what: str) -> str:
    """Reject anything that could escape outputs/ or act as a glob (.., *, /, ?)."""
    if not value or not _SAFE_ID_RE.match(value):
        raise HTTPException(status_code=400, detail=f"Invalid {what}")
    return value


def _find_stem_file(sep_id: str, stem_name: str) -> Path:
    _safe_id(sep_id, "separation id")
    _safe_id(stem_name, "stem name")
    if sep_id not in sep_jobs and not _recover_sep(sep_id):
        raise HTTPException(status_code=404, detail="Separation not found")
    out_dir = (OUTPUTS_DIR / f"sep_{sep_id}").resolve()
    ext = "mp3" if _FFMPEG else "wav"
    candidates = list(out_dir.rglob(f"{stem_name}.{ext}")) or list(out_dir.rglob(f"{stem_name}.wav"))
    candidates = [c for c in candidates if out_dir in c.resolve().parents]
    if not candidates:
        raise HTTPException(status_code=404, detail=f"Stem '{stem_name}' not found")
    return candidates[0]


def _wav_bytes(y, sr: int, bits: int = 16) -> bytes:
    """(channels, n) or (n,) float → WAV bytes (PCM_16 or PCM_24)."""
    import numpy as np, soundfile as sf
    data = y.T if y.ndim == 2 else y
    buf = io.BytesIO()
    sf.write(buf, np.clip(data, -1.0, 1.0), int(sr), format="WAV",
             subtype="PCM_24" if bits == 24 else "PCM_16")
    return buf.getvalue()


async def _upload_to_temp(upload: UploadFile, default_suffix: str = ".wav") -> str:
    content = await upload.read()
    if not content:
        raise HTTPException(status_code=400, detail=f"Empty file: {upload.filename or 'upload'}")
    suffix = Path(upload.filename or "audio" + default_suffix).suffix.lower()
    if not re.match(r"^\.[a-z0-9]{1,5}$", suffix):
        suffix = default_suffix
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        return tmp.name


# ── librosa-free DSP core ─────────────────────────────────────────────────────
# librosa needs a numba that matches numpy; on a mismatched install (e.g. numba 0.56
# + numpy 2.x) *every* librosa call fails at import time. Time-stretch, pitch shift
# and mastering therefore use soundfile (+ ffmpeg fallback) for decoding, soxr (or
# scipy) for resampling and a numpy/scipy phase vocoder — same algorithm librosa uses.
_SOUNDFILE = importlib.util.find_spec("soundfile") is not None
_SCIPY     = importlib.util.find_spec("scipy") is not None
_DSP       = _SOUNDFILE and _SCIPY


def _resample(y, fs_in: float, fs_out: float):
    """(channels, n) → resampled (channels, m) float32."""
    import numpy as np
    if abs(fs_in - fs_out) < 1e-9:
        return y.astype(np.float32, copy=False)
    try:
        import soxr
        out = soxr.resample(np.ascontiguousarray(y.T, dtype=np.float32), fs_in, fs_out, "HQ")
        out = out[:, None] if out.ndim == 1 else out
        return np.ascontiguousarray(out.T, dtype=np.float32)
    except ImportError:
        from fractions import Fraction
        from scipy.signal import resample_poly
        fr = Fraction(fs_out / fs_in).limit_denominator(2000)
        return resample_poly(y, fr.numerator, fr.denominator, axis=-1).astype(np.float32)


def _load_audio(path: str, sr: Optional[int] = None):
    """Decode any audio file → ((channels, n) float32, sample_rate).
    soundfile handles wav/flac/ogg/mp3; anything else goes through ffmpeg."""
    import numpy as np, soundfile as sf
    try:
        d, fs = sf.read(path, dtype="float32", always_2d=True)
    except Exception:
        if not _FFMPEG:
            raise ValueError("Unsupported audio format (install ffmpeg for more formats)")
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as t:
            tmp = t.name
        try:
            r = subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", path, "-vn", "-c:a", "pcm_f32le", tmp],
                               capture_output=True, creationflags=_NO_WINDOW)
            if r.returncode != 0:
                raise ValueError("Unsupported or corrupt audio file")
            d, fs = sf.read(tmp, dtype="float32", always_2d=True)
        finally:
            Path(tmp).unlink(missing_ok=True)
    if d.size == 0:
        raise ValueError("Audio file contains no samples")
    y = np.ascontiguousarray(d.T)
    if sr and sr != fs:
        y, fs = _resample(y, fs, sr), sr
    return y, int(fs)


def _time_stretch_pv(x, rate: float, n_fft: int = 2048, hop: int = 512):
    """Phase-vocoder time stretch of a 1-D signal. rate > 1 = faster/shorter."""
    import numpy as np
    from scipy.signal import stft, istft
    x = np.asarray(x, dtype=np.float32)
    _, _, D = stft(x, nperseg=n_fft, noverlap=n_fft - hop, window="hann")
    D = D.astype(np.complex64, copy=False)
    F, T = D.shape
    if T < 2:
        return x.copy()
    steps = np.arange(0, T - 1, rate)
    TWO_PI = np.float32(2 * np.pi)
    phi_adv = np.linspace(0, np.pi * hop, F, dtype=np.float32)[:, None]
    MAG, ANG = np.abs(D), np.angle(D).astype(np.float32)
    del D
    # per-input-frame wrapped phase deviation (computed once, reused by every step)
    dev = ANG[:, 1:] - ANG[:, :-1] - phi_adv
    dev -= TWO_PI * np.round(dev / TWO_PI)
    dev += phi_adv
    out = np.empty((F, len(steps)), np.complex64)
    phase = ANG[:, :1].astype(np.float64)
    CH = 2048                                   # chunk frames → bounded memory
    for c0 in range(0, len(steps), CH):
        st = steps[c0:c0 + CH]
        i0 = st.astype(np.int64)
        a = (st - i0).astype(np.float32)[None, :]
        mag = MAG[:, i0] * (1 - a) + MAG[:, i0 + 1] * a
        inc = dev[:, i0]
        acc = np.cumsum(inc, axis=1, dtype=np.float64)
        acc -= inc                                   # exclusive prefix sum
        acc += phase
        phase = acc[:, -1:] + inc[:, -1:]
        acc = np.mod(acc, 2 * np.pi).astype(np.float32)
        o = out[:, c0:c0 + len(st)]
        o.real = mag * np.cos(acc)
        o.imag = mag * np.sin(acc)
    _, y = istft(out, nperseg=n_fft, noverlap=n_fft - hop, window="hann")
    return y.astype(np.float32)


def _fix_length(y, n: int):
    import numpy as np
    return y[:n] if len(y) >= n else np.pad(y, (0, n - len(y)))


# ── Pitch shift (phase vocoder + soxr resample, tempo preserved) ──────────────
def _pitch_shift_audio(audio_path: str, semitones: float) -> bytes:
    import numpy as np
    y, sr = _load_audio(audio_path)
    n = y.shape[1]
    if abs(semitones) < 1e-6:
        ys = y
    else:
        rate = 2.0 ** (-float(semitones) / 12.0)          # stretch by 1/ratio, then resample back
        from concurrent.futures import ThreadPoolExecutor
        one = lambda ch: _fix_length(_resample(_time_stretch_pv(ch, rate)[None, :], sr / rate, sr)[0], n)
        with ThreadPoolExecutor(max_workers=min(4, y.shape[0])) as ex:   # numpy releases the GIL
            ys = np.stack(list(ex.map(one, y)))
    peak = float(np.max(np.abs(ys))) if ys.size else 0.0
    if peak > 1.0:            # resampling can overshoot a hot stem — scale instead of clipping
        ys = ys / peak * 0.999
    return _wav_bytes(ys if ys.shape[0] > 1 else ys[0], sr, 16)


def _check_semitones(semitones: float):
    import math
    if not math.isfinite(semitones) or semitones < -12 or semitones > 12:
        raise HTTPException(status_code=400, detail="semitones must be between -12 and 12")


@app.post("/pitchshift/{sep_id}/{stem_name}")
def pitchshift_stem(sep_id: str, stem_name: str, semitones: float = Query(...)):
    """Pitch-shift an existing separated stem by N semitones (−12..12), tempo unchanged."""
    if not _DSP:
        raise HTTPException(status_code=501, detail="soundfile + scipy are required")
    _check_semitones(semitones)
    path = _find_stem_file(sep_id, stem_name)
    try:
        wav = _pitch_shift_audio(str(path), semitones)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Pitch shift failed: {e}")
    return Response(content=wav, media_type="audio/wav",
                             headers={"Content-Disposition": f'attachment; filename="{stem_name}_pitch{semitones:+g}.wav"'})


@app.post("/pitchshift")
async def pitchshift_upload(file: UploadFile = FastAPIFile(...), semitones: float = Query(...)):
    """Pitch-shift an uploaded audio file by N semitones (−12..12), tempo unchanged."""
    if not _DSP:
        raise HTTPException(status_code=501, detail="soundfile + scipy are required")
    _check_semitones(semitones)
    tmp_path = await _upload_to_temp(file)
    try:
        wav = _pitch_shift_audio(tmp_path, semitones)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not process audio: {e}")
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    return Response(content=wav, media_type="audio/wav",
                             headers={"Content-Disposition": 'attachment; filename="pitched.wav"'})


# ── Reference-track mastering (built-in matcher) ──────────────────────────────
# `matchering` would upgrade numba/llvmlite/soundfile/cffi (librosa + HeartMuLa deps)
# and needs resampy + statsmodels, so WAIvePulse ships its own lightweight matcher:
#   1. mid/side split  2. average-spectrum match EQ per M and S (Welch PSD ratio,
#   1/3-octave smoothed, ±12 dB, linear-phase FIR)  3. stereo width match (S/M RMS)
#   4. integrated-LUFS match (BS.1770-4)  5. 4× oversampled true-peak limiter at
#   min(−1 dBTP, reference true peak), iterated so loudness still lands on the reference.
_MATCHERING = importlib.util.find_spec("matchering") is not None


def _k_weight(x, sr):
    """BS.1770 K-weighting (pre-filter shelf + RLB high-pass) for any sample rate."""
    import numpy as np
    from scipy.signal import lfilter
    f0, G, Q = 1681.974450955533, 3.999843853973347, 0.7071752369554196
    K = np.tan(np.pi * f0 / sr); Vh = 10 ** (G / 20); Vb = Vh ** 0.4996667741545416
    a0 = 1 + K / Q + K * K
    b1 = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0]
    a1 = [1, 2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0]
    f0, Q = 38.13547087602444, 0.5003270373238773
    K = np.tan(np.pi * f0 / sr); d = 1 + K / Q + K * K
    b2 = [1.0, -2.0, 1.0]
    a2 = [1, 2 * (K * K - 1) / d, (1 - K / Q + K * K) / d]
    return lfilter(b2, a2, lfilter(b1, a1, x, axis=-1), axis=-1)


def _lufs(x, sr) -> float:
    """Integrated loudness (BS.1770-4, gated) of a (channels, n) array."""
    import numpy as np
    z = _k_weight(np.asarray(x, dtype=np.float64), sr)
    e = np.concatenate([[0.0], np.cumsum((z ** 2).sum(axis=0))])
    blk, hop = int(round(0.4 * sr)), int(round(0.1 * sr))
    if z.shape[-1] < blk:
        return float("-inf")
    starts = np.arange(0, z.shape[-1] - blk + 1, hop)
    ms = (e[starts + blk] - e[starts]) / blk
    L = lambda v: -0.691 + 10 * np.log10(np.maximum(v, 1e-20))
    g = ms[L(ms) > -70]
    if not g.size:
        return float("-inf")
    g2 = g[L(g) > L(g.mean()) - 10]
    return float(L(g2.mean())) if g2.size else float("-inf")


def _tp_envelope(x):
    """Per-sample 4×-oversampled absolute peak across channels (chunked, low memory)."""
    import numpy as np
    from scipy.signal import resample_poly
    ch, n = x.shape
    out = np.empty(n, np.float32)
    C, P = 1 << 19, 64
    for s in range(0, n, C):
        a, b = max(0, s - P), min(n, s + C + P)
        up = resample_poly(x[:, a:b], 4, 1, axis=1)
        env = np.abs(up).max(axis=0).reshape(-1, 4).max(axis=1)
        m = min(C, n - s)
        out[s:s + m] = env[s - a:s - a + m]
    return np.maximum(out, np.abs(x).max(axis=0))


def _true_peak_db(x) -> float:
    import numpy as np
    pk = float(_tp_envelope(x).max()) if x.size else 0.0
    return 20 * np.log10(max(pk, 1e-12))


def _tp_limit(x, sr, ceil_db=-1.0, look_ms=2.0, release_ms=80.0):
    """Look-ahead true-peak limiter (channel-linked). Returns a new array."""
    import numpy as np
    from scipy.ndimage import minimum_filter1d
    ceil = 10 ** (ceil_db / 20)
    env = _tp_envelope(x)
    n, B = x.shape[1], 16
    nb = -(-n // B)
    pad = np.zeros(nb * B, np.float32); pad[:n] = env
    req = np.minimum(1.0, ceil / np.maximum(pad.reshape(nb, B).max(axis=1), 1e-9))
    La = max(1, int(round(sr * look_ms / 1000 / B)))
    target = minimum_filter1d(req, 2 * La + 1, mode="nearest").tolist()
    rel = float(np.exp(-B / (sr * release_ms / 1000)))
    g, cur = [0.0] * nb, 1.0
    for i, t in enumerate(target):
        cur = t if t < cur else t + (cur - t) * rel
        g[i] = cur
    gains = np.interp(np.arange(n), np.arange(nb) * B + B / 2, np.asarray(g)).astype(np.float32)
    y = x * gains
    tp = float(_tp_envelope(y).max())
    if tp > ceil:                       # residual overshoot from interpolation → trim it
        y *= ceil / tp
    return y


def _smooth_octave(f, v, frac=3):
    """Average v over a 1/frac-octave window around each frequency bin."""
    import numpy as np
    c = np.concatenate([[0.0], np.cumsum(v)])
    k = 2 ** (1 / (2 * frac))
    lo = np.searchsorted(f, f / k, side="left")
    hi = np.searchsorted(f, f * k, side="right")
    hi = np.maximum(hi, lo + 1)
    return (c[hi] - c[lo]) / (hi - lo)


def _match_eq_fir(tgt, ref, sr, numtaps=4095, max_db=12.0):
    """Linear-phase FIR that moves tgt's average spectrum shape onto ref's."""
    import numpy as np
    from scipy.signal import welch, firwin2
    nper = 8192
    f, pt = welch(tgt, sr, nperseg=nper, noverlap=nper // 2)
    _, pr = welch(ref, sr, nperseg=nper, noverlap=nper // 2)
    eps = 1e-14
    r_db = 10 * np.log10((pr + eps) / (pt + eps))
    r_db = _smooth_octave(f, r_db, 3)
    band = (f >= 100) & (f <= 10000)
    r_db -= np.average(r_db[band], weights=pt[band] + eps) if band.any() else 0.0   # shape only
    lo_f, hi_f = 25.0, min(18000.0, sr / 2 * 0.9)
    r_db = np.where(f < lo_f, np.interp(lo_f, f, r_db), r_db)
    r_db = np.where(f > hi_f, np.interp(hi_f, f, r_db), r_db)
    r_db = np.clip(r_db, -max_db, max_db)
    taps = firwin2(numtaps, f, 10 ** (r_db / 20), fs=sr)
    return taps, float(np.max(np.abs(r_db[(f >= 30) & (f <= 16000)])))


def _to_stereo(y):
    import numpy as np
    if y.ndim == 1:
        return np.stack([y, y])
    if y.shape[0] == 1:
        return np.concatenate([y, y])
    return y[:2]


def _master_match(target_path: str, reference_path: str):
    """Returns (mastered (2,n) float32, sr, report dict)."""
    import numpy as np
    from scipy.signal import oaconvolve
    tgt, sr = _load_audio(target_path)
    ref, _  = _load_audio(reference_path, sr=sr)
    tgt, ref = _to_stereo(tgt).astype(np.float32), _to_stereo(ref).astype(np.float32)
    for name, a in (("target", tgt), ("reference", ref)):
        if a.shape[1] < 3 * sr:
            raise ValueError(f"The {name} is too short (need at least 3 seconds)")
        if float(np.sqrt(np.mean(a ** 2))) < 1e-5:
            raise ValueError(f"The {name} is silent")

    in_lufs, ref_lufs = _lufs(tgt, sr), _lufs(ref, sr)
    ref_tp = _true_peak_db(ref)

    mid_t, side_t = (tgt[0] + tgt[1]) / 2, (tgt[0] - tgt[1]) / 2
    mid_r, side_r = (ref[0] + ref[1]) / 2, (ref[0] - ref[1]) / 2
    rms = lambda v: float(np.sqrt(np.mean(np.square(v, dtype=np.float64))))
    width = lambda m, s: rms(s) / max(rms(m), 1e-12)
    w_in, w_ref = width(mid_t, side_t), width(mid_r, side_r)

    taps_m, eq_mid_db = _match_eq_fir(mid_t, mid_r, sr)
    mid = oaconvolve(mid_t, taps_m, mode="same").astype(np.float32)
    side = side_t
    eq_side_db = 0.0
    if w_in > 0.01 and w_ref > 0.01:     # near-mono → leave the side channel alone (noise)
        taps_s, eq_side_db = _match_eq_fir(side_t, side_r, sr)
        side = oaconvolve(side_t, taps_s, mode="same").astype(np.float32)
        side_gain = float(np.clip(w_ref / max(width(mid, side), 1e-9), 0.25, 4.0))
        side = side * side_gain
    y0 = np.stack([mid + side, mid - side]).astype(np.float32)

    ceil_db = float(min(-1.0, max(ref_tp, -12.0)))
    cur = _lufs(y0, sr)
    gain_db = float(np.clip(ref_lufs - cur, -30.0, 24.0))
    y = y0
    for _ in range(5):
        y = _tp_limit(y0 * np.float32(10 ** (gain_db / 20)), sr, ceil_db)
        out_l = _lufs(y, sr)
        err = ref_lufs - out_l
        if abs(err) < 0.1 or gain_db >= 24.0:
            break
        gain_db = float(min(24.0, gain_db + err))
    out_lufs = _lufs(y, sr)
    report = {
        "engine": "builtin",
        "in_lufs": round(in_lufs, 2), "ref_lufs": round(ref_lufs, 2), "out_lufs": round(out_lufs, 2),
        "ref_true_peak_db": round(ref_tp, 2), "out_true_peak_db": round(_true_peak_db(y), 2),
        "ceiling_db": round(ceil_db, 2), "gain_db": round(gain_db, 2),
        "width_in": round(w_in, 3), "width_ref": round(w_ref, 3),
        "width_out": round(width((y[0] + y[1]) / 2, (y[0] - y[1]) / 2), 3),
        "eq_max_db": round(max(eq_mid_db, eq_side_db), 1), "sample_rate": int(sr),
    }
    return y, sr, report


@app.get("/master-status")
def master_status():
    return {"available": _DSP, "engine": "builtin",
            "matchering_installed": _MATCHERING}


@app.post("/master/match")
async def master_match(target: UploadFile = FastAPIFile(...),
                       reference: UploadFile = FastAPIFile(...),
                       bits: int = Query(24)):
    """Master `target` (your mix) to sound like `reference` (any song): loudness, tonal
    balance, peak level and stereo width. Returns a 16/24-bit WAV; measurements are
    in the X-Master-* response headers."""
    if not _DSP:
        raise HTTPException(status_code=501, detail="soundfile + scipy are required for mastering")
    if bits not in (16, 24):
        raise HTTPException(status_code=400, detail="bits must be 16 or 24")
    t_path = await _upload_to_temp(target, ".wav")
    r_path = None
    try:
        r_path = await _upload_to_temp(reference, ".wav")
        import asyncio
        try:
            y, sr, rep = await asyncio.to_thread(_master_match, t_path, r_path)
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))
        except Exception as e:
            _real_stderr.write(f"[waivepulse] master/match failed: {e}\n")
            raise HTTPException(status_code=400, detail=f"Could not master these files: {e}")
        wav = _wav_bytes(y, sr, bits)
    finally:
        for p in (t_path, r_path):
            if p:
                Path(p).unlink(missing_ok=True)
    stem = re.sub(r"[^\w-]", "_", Path(target.filename or "mix").stem)[:48] or "mix"
    headers = {
        "Content-Disposition": f'attachment; filename="{stem}_mastered.wav"',
        "X-Master-Report": json.dumps(rep),
        "X-Master-In-LUFS": str(rep["in_lufs"]), "X-Master-Ref-LUFS": str(rep["ref_lufs"]),
        "X-Master-Out-LUFS": str(rep["out_lufs"]), "X-Master-Out-TP": str(rep["out_true_peak_db"]),
    }
    return Response(content=wav, media_type="audio/wav", headers=headers)


# ── Cover art + YouTube video ─────────────────────────────────────────────────
_PIL = importlib.util.find_spec("PIL") is not None
_NO_WINDOW = 0x08000000 if os.name == "nt" else 0     # CREATE_NO_WINDOW: no console popup
VIDEOS_DIR = OUTPUTS_DIR / "videos"
video_jobs: dict = {}     # job_id → {status, progress, file, message}

_FONT_BOLD = ["C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
              "/System/Library/Fonts/Supplemental/Arial Bold.ttf", "DejaVuSans-Bold.ttf"]
_FONT_REG  = ["C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
              "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
              "/System/Library/Fonts/Supplemental/Arial.ttf", "DejaVuSans.ttf"]


def _font(size: int, bold: bool = True):
    from PIL import ImageFont
    for p in (_FONT_BOLD if bold else _FONT_REG):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    try:
        return ImageFont.load_default(size=size)
    except TypeError:
        return ImageFont.load_default()


def _clean_text(s: str) -> str:
    """Drop characters the bundled fonts can't draw (emoji / astral plane)."""
    return "".join(ch for ch in (s or "") if ord(ch) <= 0xFFFF and ch.isprintable()).strip()


def _fit_lines(draw, text: str, max_w: int, start: int, min_size: int, max_lines: int, bold=True):
    """Largest font size whose word-wrap fits max_w in ≤ max_lines lines."""
    words = text.split() or [""]
    for size in range(start, min_size - 1, -4):
        f = _font(size, bold)
        lines, cur = [], ""
        for w in words:
            trial = (cur + " " + w).strip()
            if draw.textlength(trial, font=f) <= max_w:
                cur = trial
            else:
                if cur:
                    lines.append(cur)
                cur = w
        lines.append(cur)
        if len(lines) <= max_lines and all(draw.textlength(l, font=f) <= max_w for l in lines):
            return f, lines
    f = _font(min_size, bold)
    line = text
    while line and draw.textlength(line + "…", font=f) > max_w:
        line = line[:-1]
    return f, [line + "…" if line != text else line]


def _cover_seed(job_id: str, tags: str) -> int:
    import hashlib
    return int.from_bytes(hashlib.sha256(f"waivepulse-cover|{job_id}|{tags}".encode()).digest()[:8], "big")


def _cover_art(job_id: str, tags: str, w: int, h: int):
    """Deterministic abstract art (no text): colour blobs + glowing sound ribbons + grain."""
    import numpy as np, colorsys
    from PIL import Image
    rng = np.random.default_rng(_cover_seed(job_id, tags))
    t = (tags or "").lower()
    dark = any(k in t for k in ("dark", "sad", "melanchol", "haunting", "metal", "desperate", "lonel"))
    bright = any(k in t for k in ("happy", "upbeat", "energetic", "euphoric", "playful", "summer", "party"))
    h0 = rng.random()
    scheme = rng.choice([[0, .08, .16, .5], [0, .5, .58, .92], [0, .33, .66, .12], [0, .06, .9, .45]])
    vmax = .72 if dark else (1.0 if bright else .9)
    pal = [np.array(colorsys.hsv_to_rgb((h0 + d) % 1, .55 + .4 * rng.random(), vmax * (.7 + .3 * rng.random())))
           for d in scheme]
    # work at reduced resolution (smooth content) then upscale
    sw, sh = max(64, w // 3), max(64, h // 3)
    yy, xx = np.mgrid[0:sh, 0:sw].astype(np.float32)
    xx /= sw; yy /= sh
    aspect = sw / sh
    base = np.array(colorsys.hsv_to_rgb(h0, .6, .06 if dark else .1))
    img = np.ones((sh, sw, 3), np.float32) * base
    for k in range(6):
        c = pal[k % len(pal)]
        cx, cy = rng.random(), rng.random()
        r = .18 + .3 * rng.random()
        d2 = ((xx - cx) * aspect) ** 2 + (yy - cy) ** 2
        wgt = (np.exp(-d2 / (2 * r * r)) * (.55 + .4 * rng.random()))[..., None]
        img = img * (1 - wgt) + c * wgt
    # glowing "sound ribbons"
    for k in range(3 + int(rng.integers(0, 3))):
        c = pal[(k + 1) % len(pal)] * 1.2 + .15
        cy, amp = .25 + .5 * rng.random(), .05 + .12 * rng.random()
        f1, f2 = 1 + 3 * rng.random(), 4 + 8 * rng.random()
        p1, p2 = rng.random() * 6.28, rng.random() * 6.28
        yc = cy + amp * np.sin(2 * np.pi * f1 * xx + p1) + amp * .35 * np.sin(2 * np.pi * f2 * xx + p2)
        dist = np.abs(yy - yc)
        thick = max(.0025 + .004 * rng.random(), 1.6 / sh)   # ≥1.6 px at work res → no dotted aliasing
        glow = (np.exp(-(dist / thick) ** 2) * .9 + np.exp(-(dist / (thick * 9)) ** 2) * .25)[..., None]
        img = img + c * glow * (.5 + .5 * rng.random())
    # vignette
    vr = ((xx - .5) * aspect / max(aspect, 1)) ** 2 + (yy - .5) ** 2
    img *= (1 - .75 * np.clip(vr, 0, 1))[..., None]
    img = 1 - np.exp(-img * 1.6)            # soft tone-map, no hard clipping
    small = Image.fromarray((np.clip(img, 0, 1) * 255).astype(np.uint8), "RGB")
    big = np.asarray(small.resize((w, h), Image.BICUBIC)).astype(np.float32)
    big += rng.normal(0, 4.0, big.shape[:2])[..., None]     # film grain
    return Image.fromarray(np.clip(big, 0, 255).astype(np.uint8), "RGB")


def _logo():
    from PIL import Image
    p = ASSETS_DIR / "wave small.png"
    try:
        return Image.open(p).convert("RGBA") if p.exists() else None
    except Exception:
        return None


def _draw_wordmark(img, x: int, y: int, size: int, anchor_right=False):
    """Small 'WAIvePulse' wordmark (+ logo) with its top-left (or top-right) at x,y."""
    from PIL import Image, ImageDraw
    d = ImageDraw.Draw(img)
    f = _font(size, True)
    tw = int(d.textlength("WAIvePulse", font=f))
    logo = _logo()
    lw = 0
    if logo is not None:
        lh = int(size * 1.25)
        logo = logo.resize((max(1, int(logo.width * lh / logo.height)), lh), Image.LANCZOS)
        lw = logo.width + size // 3
    total = lw + tw
    x0 = x - total if anchor_right else x
    if logo is not None:
        img.paste(logo, (x0, y), logo)
    d.text((x0 + lw, y + size * 0.1), "WAIvePulse", font=f, fill=(255, 255, 255, 215))


def _job_texts(job: dict):
    title = _clean_text(job.get("title") or "Untitled") or "Untitled"
    artist = _clean_text(job.get("artist") or "")
    return title, artist


def _render_cover(job_id: str, job: dict, size: int = 1200):
    """Square cover: art + title/artist + small wordmark. Returns PIL RGB image."""
    from PIL import Image, ImageDraw
    import numpy as np
    title, artist = _job_texts(job)
    img = _cover_art(job_id, job.get("tags", ""), size, size).convert("RGBA")
    # bottom shade for legibility
    shade = np.zeros((size, size, 4), np.uint8)
    ramp = np.clip((np.arange(size) - size * .45) / (size * .55), 0, 1) ** 1.4
    shade[..., 3] = (ramp * 200).astype(np.uint8)[:, None]
    img = Image.alpha_composite(img, Image.fromarray(shade, "RGBA"))
    d = ImageDraw.Draw(img)
    m = int(size * .07)
    f_art = _font(int(size * .045), False)
    f_t, lines = _fit_lines(d, title, size - 2 * m, int(size * .11), int(size * .05), 3)
    lh = int(f_t.size * 1.12)
    y = size - m - (int(f_art.size * 1.5) if artist else 0) - lh * len(lines)
    for ln in lines:
        d.text((m, y), ln, font=f_t, fill=(255, 255, 255, 255))
        y += lh
    if artist:
        d.text((m, y + int(size * .01)), artist, font=f_art, fill=(225, 235, 240, 235))
    _draw_wordmark(img, m, m, int(size * .028))
    return img.convert("RGB")


def _waveform_peaks(audio_path: str, n: int):
    import numpy as np
    y, _ = _load_audio(audio_path)
    y = y.mean(axis=0)
    if not y.size:
        return np.zeros(n)
    edges = np.linspace(0, y.size, n + 1).astype(int)
    pk = np.array([np.sqrt(np.mean(y[a:b] ** 2)) if b > a else 0 for a, b in zip(edges[:-1], edges[1:])])
    return pk / max(pk.max(), 1e-9)


def _render_video_frame(job_id: str, job: dict, audio_path: Optional[str]):
    """1920×1080 still: blurred art backdrop, square cover left, title/artist right,
    wordmark, and an audio waveform strip along the bottom."""
    from PIL import Image, ImageDraw, ImageFilter
    W, H = 1920, 1080
    title, artist = _job_texts(job)
    tags = job.get("tags", "") or ""
    bg = _cover_art(job_id, tags, W // 4, H // 4).resize((W, H), Image.BICUBIC)
    bg = bg.filter(ImageFilter.GaussianBlur(18)).convert("RGBA")
    bg = Image.alpha_composite(bg, Image.new("RGBA", (W, H), (6, 8, 14, 150)))
    S = 720
    art = _cover_art(job_id, tags, S, S).convert("RGBA")
    ax, ay = 110, (H - S) // 2 - 50
    shadow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((ax + 14, ay + 22, ax + S + 14, ay + S + 22), 26, fill=(0, 0, 0, 170))
    bg = Image.alpha_composite(bg, shadow.filter(ImageFilter.GaussianBlur(22)))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), 22, fill=255)
    bg.paste(art, (ax, ay), mask)
    d = ImageDraw.Draw(bg)
    tx = ax + S + 90
    tw = W - tx - 100
    f_t, lines = _fit_lines(d, title, tw, 118, 56, 3)
    f_a = _font(58, False)
    f_g = _font(30, False)
    lh = int(f_t.size * 1.1)
    block = lh * len(lines) + (80 if artist else 0) + 60
    y = ay + (S - block) // 2
    for ln in lines:
        d.text((tx, y), ln, font=f_t, fill=(255, 255, 255, 255))
        y += lh
    if artist:
        d.text((tx, y + 14), artist, font=f_a, fill=(140, 255, 255, 255))
        y += 80
    tag_line = " · ".join(t.strip() for t in tags.split(",") if t.strip())[:90]
    if tag_line:
        d.text((tx, y + 24), _clean_text(tag_line), font=f_g, fill=(200, 205, 215, 200))
    _draw_wordmark(bg, W - 60, 48, 30, anchor_right=True)
    # waveform strip
    if audio_path:
        try:
            n = 240
            pk = _waveform_peaks(audio_path, n)
            strip = Image.new("RGBA", (W, H), (0, 0, 0, 0))
            sd = ImageDraw.Draw(strip)
            x0, x1, cy, amp = 110, W - 110, H - 92, 56
            step = (x1 - x0) / n
            for i, v in enumerate(pk):
                hgt = max(2, int(v * amp))
                bx = x0 + i * step
                sd.rounded_rectangle((bx, cy - hgt, bx + step * .55, cy + hgt), 2, fill=(140, 255, 255, 150))
            bg = Image.alpha_composite(bg, strip)
        except Exception as e:
            _real_stderr.write(f"[waivepulse] waveform strip skipped: {e}\n")
    return bg.convert("RGB")


def _job_audio_path(job: dict) -> Optional[Path]:
    f = job.get("file")
    if not f:
        return None
    p = OUTPUTS_DIR / Path(f).name
    return p if p.exists() else None


def _embed_cover(mp3_path: str, job_id: str, job: dict) -> bool:
    """Embed the generated cover as ID3 APIC (front cover, JPEG)."""
    if not (_MUTAGEN and _PIL):
        return False
    try:
        from mutagen.id3 import APIC
        buf = io.BytesIO()
        _render_cover(job_id, job, 1000).save(buf, "JPEG", quality=90)
        try:
            id3 = ID3(mp3_path)
        except ID3NoHeaderError:
            id3 = ID3()
        id3.delall("APIC")
        id3.add(APIC(encoding=3, mime="image/jpeg", type=3, desc="Cover", data=buf.getvalue()))
        id3.save(mp3_path)
        return True
    except Exception as e:
        _real_stderr.write(f"[waivepulse] Cover embed failed: {e}\n")
        return False


def _get_job_or_404(job_id: str) -> dict:
    _safe_id(job_id, "job id")
    if job_id not in jobs and not _recover_job(job_id):
        raise HTTPException(status_code=404, detail="Job not found")
    return jobs[job_id]


@app.get("/cover/{job_id}.png")
def cover_png(job_id: str, size: int = Query(1200, ge=128, le=3000)):
    if not _PIL:
        raise HTTPException(status_code=501, detail="Pillow is not installed")
    job = _get_job_or_404(job_id)
    buf = io.BytesIO()
    _render_cover(job_id, job, size).save(buf, "PNG", optimize=False)
    return Response(content=buf.getvalue(), media_type="image/png",
                             headers={"Cache-Control": "no-cache"})


def _audio_duration(path: Path) -> float:
    try:
        from mutagen import File as MFile
        m = MFile(str(path))
        if m is not None and m.info and m.info.length:
            return float(m.info.length)
    except Exception:
        pass
    return 0.0


def _run_video(job_id: str, audio: Path, out: Path, title: str, artist: str):
    vj = video_jobs[job_id]
    frame = out.with_suffix(".frame.png")
    tmp_out = out.with_suffix(".part.mp4")
    try:
        vj["message"] = "Drawing cover…"
        _render_video_frame(job_id, jobs[job_id], str(audio)).save(frame, "PNG")
        dur = _audio_duration(audio)
        vj["message"] = "Encoding video…"
        cmd = ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-nostats", "-progress", "pipe:1",
               "-loop", "1", "-framerate", "6", *(["-t", f"{dur:.3f}"] if dur > 0 else []),
               "-i", str(frame), "-i", str(audio),
               "-map", "0:v:0", "-map", "1:a:0",
               "-c:v", "libx264", "-tune", "stillimage", "-preset", "veryfast", "-crf", "20",
               "-pix_fmt", "yuv420p", "-r", "6",
               "-c:a", "aac", "-b:a", "320k",
               "-shortest", "-movflags", "+faststart", str(tmp_out)]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                                encoding="utf-8", errors="replace", creationflags=_NO_WINDOW)
        for line in proc.stdout:
            if line.startswith("out_time_us=") and dur > 0:
                try:
                    vj["progress"] = min(99, int(int(line.split("=", 1)[1]) / 1e6 / dur * 100))
                except ValueError:
                    pass
        err = proc.stderr.read()
        proc.wait()
        if proc.returncode != 0 or not tmp_out.exists():
            raise RuntimeError(f"ffmpeg failed ({proc.returncode}): {err.strip()[-400:]}")
        os.replace(tmp_out, out)
        url = f"/outputs/videos/{out.name}"
        jobs[job_id]["video"] = {"file": url, "title": title, "artist": artist}
        _save_history()
        vj.update(status="done", progress=100, file=url, message="Video ready")
    except Exception as e:
        vj.update(status="error", message=str(e))
        _real_stderr.write(f"[waivepulse] Video render failed for {job_id}: {e}\n")
    finally:
        for p in (frame, tmp_out):
            try:
                p.unlink(missing_ok=True)
            except OSError:
                pass


def _video_state(job_id: str, job: dict) -> Optional[dict]:
    """Cached video that still matches the current title/artist, else None."""
    v = job.get("video") or {}
    if v.get("file") and (OUTPUTS_DIR / "videos" / Path(v["file"]).name).exists() \
            and v.get("title") == job.get("title") and v.get("artist", "") == (job.get("artist") or ""):
        return {"status": "done", "progress": 100, "file": v["file"], "message": "Video ready"}
    return None


@app.post("/video/{job_id}")
def make_video(job_id: str, force: bool = Query(False)):
    """Render (or return the cached) 1920×1080 H.264/AAC-320k MP4 of a song for YouTube.
    Poll GET /video/{job_id} for progress."""
    if not _FFMPEG:
        raise HTTPException(status_code=501, detail="ffmpeg is not installed / not on PATH")
    if not _PIL:
        raise HTTPException(status_code=501, detail="Pillow is not installed (pip install pillow)")
    job = _get_job_or_404(job_id)
    if job.get("status") != "done":
        raise HTTPException(status_code=400, detail="Song is not finished yet")
    audio = _job_audio_path(job)
    if not audio:
        raise HTTPException(status_code=404, detail="Audio file not found on disk")
    cur = video_jobs.get(job_id)
    if cur and cur.get("status") == "rendering":
        return cur
    if not force:
        cached = _video_state(job_id, job)
        if cached:
            return cached
    VIDEOS_DIR.mkdir(exist_ok=True)
    out = VIDEOS_DIR / f"{audio.stem}.mp4"
    video_jobs[job_id] = {"status": "rendering", "progress": 0, "file": None, "message": "Starting…"}
    threading.Thread(target=_run_video, name=f"video-{job_id}", daemon=True,
                     args=(job_id, audio, out, job.get("title"), job.get("artist") or "")).start()
    return video_jobs[job_id]


@app.get("/video/{job_id}")
def video_status(job_id: str):
    job = _get_job_or_404(job_id)
    cur = video_jobs.get(job_id)
    if cur and cur.get("status") in ("rendering", "error"):
        return cur
    return _video_state(job_id, job) or {"status": "none", "progress": 0, "file": None, "message": ""}



@app.post("/detect-bpm")
async def detect_bpm_upload(file: UploadFile = FastAPIFile(...)):
    """Detect BPM and key of an uploaded audio file."""
    if not _LIBROSA:
        raise HTTPException(status_code=501, detail="librosa is not installed")
    import tempfile
    content = await file.read()
    suffix = Path(file.filename or "audio.wav").suffix or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(content)
        tmp_path = tmp.name
    try:
        bpm, key = _detect_bpm_key(tmp_path)
    finally:
        Path(tmp_path).unlink(missing_ok=True)
    return {"bpm": bpm, "key": key}


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


def _ollama_generate(model: str, prompt: str, options: dict,
                     fmt: Optional[str] = None, timeout: int = 300) -> str:
    """One-shot (non-streaming) Ollama /api/generate call. keep_alive 0 unloads the
    model from VRAM the moment the response is returned — prevents Ollama holding
    ~5 GB while the user moves on to a HeartMuLa generation (12 GB card = OOM).
    Raises HTTPException 503 if Ollama is unreachable."""
    import urllib.request, urllib.error
    payload = {"model": model, "prompt": prompt, "stream": False,
               "options": options, "keep_alive": 0}
    if fmt:
        payload["format"] = fmt
    request = urllib.request.Request(
        "http://localhost:11434/api/generate",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise HTTPException(status_code=502, detail=f"Ollama error ({e.code}): {detail}")
    except urllib.error.URLError as e:
        raise HTTPException(status_code=503, detail=f"Ollama not reachable on localhost:11434. Is it running? ({e.reason})")
    return (data.get("response") or "").strip()


@app.post("/lyrics/suggest")
def suggest_lyrics(req: LyricsRequest):
    """Generate lyrics via local Ollama. Requires Ollama running on localhost:11434."""
    try:
        text = _ollama_generate(req.model, _build_lyrics_prompt(req),
                                {"temperature": req.temperature, "top_p": 0.9})
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Lyric generation failed: {e}")
    return {"lyrics": text, "model": req.model}


class TagSuggestRequest(BaseModel):
    idea:       str = ""
    lyrics:     str = ""
    title:      str = ""
    categories: dict = {}           # {"Genre": ["pop", ...], ...} — the allowed vocabulary
    model:      str = "llama3.1:8b"  # same default as /lyrics/suggest


def _filter_suggested_tags(raw, categories: dict) -> list:
    """Keep only tags that exist in the allowed vocabulary, max one per category,
    in vocabulary spelling. *raw* may be a list or a comma string."""
    if isinstance(raw, str):
        raw = raw.split(",")
    lookup = {}   # lower-case tag → (category, canonical tag); first category wins
    for cat, tags in categories.items():
        for t in tags or []:
            lookup.setdefault(str(t).strip().lower(), (cat, str(t).strip()))
    picked, used = [], set()
    for item in raw or []:
        key = str(item).strip().strip("#").lower()
        if key not in lookup:
            continue
        cat, canon = lookup[key]
        if cat in used:
            continue
        used.add(cat)
        picked.append(canon)
    return picked


@app.post("/tags/suggest")
def suggest_tags(req: TagSuggestRequest):
    """Ask local Ollama to pick style tags for an idea / lyrics, constrained to the
    Generate page's tag vocabulary (one per category)."""
    if not req.categories:
        raise HTTPException(status_code=400, detail="categories (allowed tag vocabulary) is required")
    source = "\n".join(p for p in (
        f"Title: {req.title}" if req.title.strip() else "",
        f"Idea: {req.idea}" if req.idea.strip() else "",
        f"Lyrics:\n{req.lyrics[:2500]}" if req.lyrics.strip() else "",
    ) if p)
    if not source:
        raise HTTPException(status_code=400, detail="Give an idea or some lyrics to tag")

    model = req.model
    status = ollama_status()
    if not status["available"]:
        raise HTTPException(status_code=503, detail="Ollama not reachable on localhost:11434. Is it running?")
    if status["models"] and model not in status["models"]:
        model = status["models"][0]   # requested default not installed → first installed model

    vocab = "\n".join(f"- {cat}: {', '.join(tags)}" for cat, tags in req.categories.items())
    prompt = (
        "You are a music producer choosing style tags for an AI song generator.\n"
        "Pick the tags that best fit the song below. Rules:\n"
        "- Choose AT MOST ONE tag per category. Genre is required; skip a category if nothing fits.\n"
        "- Use ONLY tags copied exactly from this list:\n"
        f"{vocab}\n\n"
        f"{source}\n\n"
        'Respond with JSON only, like {"tags": ["pop", "warm", "female vocals", "hopeful"]}'
    )
    try:
        text = _ollama_generate(model, prompt, {"temperature": 0.4}, fmt="json", timeout=120)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Tag suggestion failed: {e}")
    try:
        parsed = json.loads(text)
        raw = parsed.get("tags", []) if isinstance(parsed, dict) else parsed
    except Exception:
        raw = re.split(r"[,\n]", text)
    tags = _filter_suggested_tags(raw, req.categories)
    if not tags:
        raise HTTPException(status_code=502, detail="The model didn't return any usable tags — try again")
    return {"tags": tags, "model": model}


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
