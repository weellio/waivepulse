# WAIvePulse

A local, fully offline AI music generation tool powered by **HeartMuLa 3B**. Give it lyrics and genre tags, get back a complete song with vocals as an MP3.

Runs on your own machine. No cloud, no subscription, no usage limits.

---

## What It Does

- Takes structured lyrics (with `[Verse]`, `[Chorus]`, etc. section markers) and a list of style/genre tags
- Generates a complete song with full vocals, instrumentation, and structure as an MP3
- Serves a dark-themed web UI on `http://localhost:7860`
- Queues and tracks jobs — you can submit a new request while one is generating
- Shows a live audio player with visualizer when each song is done

---

<img width="1103" height="881" alt="image" src="https://github.com/user-attachments/assets/01819fb0-771f-4d88-a06d-d259415ed424" />


## Requirements

| Component | Requirement |
|---|---|
| GPU | NVIDIA GPU with ~10 GB VRAM minimum |
| Python | 3.10+ with a virtual environment set up for heartlib |
| Model | HeartMuLa-oss-3B (~15 GB) + HeartCodec-oss (~6.2 GB) |
| Framework | FastAPI + uvicorn |

---

## Quick Start

### 1. Set your paths

Open `start.bat` and edit the two lines at the top:

```batch
set PYTHON_EXE=F:\HeartMuLa\venv\Scripts\python.exe
set HEARTMULA_PATH=F:\HeartMuLa\ckpt
```

Point `PYTHON_EXE` to the Python interpreter in your heartlib virtual environment, and `HEARTMULA_PATH` to the directory containing your downloaded model weights.

### 2. Download models (first run only)

```
<your-python> scripts\download_models.py
```

Total download size is ~21 GB. You can also set `HEARTMULA_PATH` as an environment variable before running the script.

### 3. Launch

Double-click `start.bat` (or run it from a terminal):

```
.\start.bat
```

Then open **http://localhost:7860** in any browser.

`start.bat` automatically kills any old server process on port 7860 before starting a new one.

---

## Using the Web UI

### 1. Song Title
Optional label — used as the name displayed in the history panel.

### 2. Lyrics
Write your lyrics using section markers. HeartMuLa is trained on this format and produces much better results with proper structure.

**Supported markers:**
```
[Intro]
[Verse]
[Prechorus]
[Chorus]
[Bridge]
[Outro]
```

**Minimal working example:**
```
[Verse]
The city lights shine bright tonight
I walk alone beneath the open sky

[Chorus]
Feel the rhythm, feel the beat
Dancing through the crowded street
```

Use the template links (**pop · rock · ballad · hip-hop**) above the lyrics box to load a full example you can edit.

### 3. Genre & Style Tags
Click the preset tag buttons to select genres, moods, and instruments. You can also type custom tags in the text field below — comma-separated, no spaces needed.

**Genre examples:** pop, rock, jazz, blues, hip-hop, electronic, classical, country, r&b, metal, folk, reggae, soul, funk, ambient, lofi, indie, punk, synthwave

**Mood examples:** happy, sad, energetic, calm, romantic, dark, upbeat, melancholic

**Instrument examples:** piano, guitar, drums, bass, violin, synthesizer, vocals

Mix freely. `pop,piano,happy,upbeat` works great. The more specific, the better the match.

### 4. Advanced Settings (click to expand)

| Setting | Default | Range | Description |
|---|---|---|---|
| Max Duration | 5:00 | 0:30 – 5:00 | Upper limit on song length. The model may stop earlier at a natural end. |
| Temperature | 1.0 | 0.5 – 2.0 | Higher = more creative/unpredictable. Lower = more conservative/structured. |
| CFG Scale | 1.5 | 1.0 – 5.0 | How strictly the output follows your tags. Higher = stronger style adherence. |

### 5. Generate
Hit **Generate Song**. The button re-enables immediately so you can queue another request, but only one job runs at a time — the second waits until the first finishes.

**The amber pulsing dot** = currently generating. **Green dot** = done, audio player appears.

### 6. Load MP3
Use the **Load MP3** button to load one or more local MP3 files into the history panel for visualization. Supports multi-select.

---

## Generation Time

Approximate times on a mid-range GPU with 12 GB VRAM — your hardware may vary:

| Duration | LM Tokens | Approx. Time |
|---|---|---|
| 30 seconds | ~375 tokens | 10–12 min |
| 1 minute | ~750 tokens | 20–25 min |
| 2 minutes | ~1500 tokens | 40–50 min |
| 3 minutes | ~2250 tokens | 60–80 min |
| 5 minutes | ~3750 tokens | 100–130 min |

Two phases run sequentially:
1. **Language model phase** — generates audio tokens (~1.5 tokens/sec)
2. **Codec decode phase** — converts tokens to waveform (~41 sec/step, 10 steps per ~30s of audio)

The UI shows "Generating…" throughout. Check the terminal running `start.bat` to see detailed progress bars.

---

## File Structure

```
waivepulse/
├── start.bat                   Launch the server (edit paths at top, then run this)
├── README.md                   This file
│
├── backend/
│   └── app.py                  FastAPI server — API endpoints, job queue, pipeline loader
│
├── frontend/
│   └── index.html              Single-page UI — no build step, served directly by FastAPI
│
├── scripts/
│   ├── test_generate.py        Standalone end-to-end test (bypasses the web server)
│   ├── download_models.py      Download/re-download model weights from HuggingFace
│   └── fix_dist_infos.py       Utility to remove stale dist-info conflicts in site-packages
│
└── outputs/                    All generated MP3 files saved here (gitignored)
    └── *.mp3
```

**Model files** live wherever you set `HEARTMULA_PATH`:
```
<HEARTMULA_PATH>/
├── gen_config.json
├── tokenizer.json
├── HeartMuLa-oss-3B/       Language model (~15 GB, 4 safetensors shards)
└── HeartCodec-oss/          Audio codec (~6.2 GB, 2 safetensors shards)
```

---

## API Endpoints

The backend is a plain REST API — you can call it from curl, Python, or any HTTP client.

### `GET /`
Returns the frontend HTML.

### `GET /model-status`
```json
{
  "ready": true,
  "components": {
    "HeartMuLaGen": true,
    "HeartMuLa-3B": true,
    "HeartCodec": true
  },
  "incomplete_files": 0
}
```
`ready: false` with `incomplete_files > 0` means models are still downloading.

### `POST /generate`
```json
{
  "lyrics": "[Verse]\nHello world\n[Chorus]\nSinging now",
  "tags": "pop,piano,upbeat",
  "title": "My Song",
  "max_duration_sec": 60,
  "temperature": 1.0,
  "cfg_scale": 1.5,
  "topk": 50
}
```
Returns `{"job_id": "abc12345"}`.

| Field | Type | Default | Description |
|---|---|---|---|
| lyrics | string | required | Full lyrics with section markers |
| tags | string | required | Comma-separated style tags |
| title | string | "Untitled" | Display name only, not passed to model |
| max_duration_sec | int | 300 | Maximum audio length in seconds |
| temperature | float | 1.0 | Sampling temperature (0.5–2.0) |
| cfg_scale | float | 1.5 | Classifier-free guidance scale |
| topk | int | 50 | Top-k sampling cutoff |

### `GET /status/{job_id}`
```json
{
  "status": "done",
  "message": "Generation complete",
  "file": "/outputs/abc12345.mp3",
  "title": "My Song",
  "tags": "pop,piano,upbeat",
  "created_at": "2026-05-13T19:16:02.634449"
}
```
Status values: `queued` → `generating` → `done` or `error`

### `GET /outputs/{filename}.mp3`
Direct download/stream of generated audio.

### `GET /history`
Returns array of all jobs in reverse chronological order (in-memory, cleared on server restart).

### `DELETE /history/{job_id}`
Deletes the job record and the corresponding MP3 file on disk.

---

## Troubleshooting

### Port already in use
`start.bat` automatically kills any existing process on port 7860 before starting. If you still see the error, run manually:
```batch
for /f "tokens=5" %a in ('netstat -ano ^| findstr ":7860 " ^| findstr "LISTENING"') do taskkill /F /PID %a
```

### "Models missing" badge
Run the download script:
```
<your-python> scripts\download_models.py
```
Total download size is ~21 GB. The badge auto-refreshes every 10 seconds while downloading.

### Generation error in job card
Check the terminal running `start.bat` for the full Python traceback. Common causes:

- **Out of VRAM** — close other GPU-heavy apps before generating
- **Corrupted model file** — re-run `download_models.py` to re-download

### Model loads slowly on first request
Normal. The first `POST /generate` after starting the server triggers model load (~20–30 seconds) before generation begins. Subsequent requests use the already-loaded model.

### `import error: No module named 'triton'`
Harmless warning from PyTorch on Windows — triton is Linux-only. Generation still works correctly.

---

## How It Works (Technical)

```
Browser → FastAPI (uvicorn) → BackgroundTask → HeartMuLaGenPipeline
                                                    │
                                          1. Language Model (3B params)
                                             Autoregressive token generation
                                             Input: lyrics text + style tags
                                             Output: audio tokens (discrete codes)
                                                    │
                                          2. HeartCodec (decoder)
                                             Converts audio tokens → waveform
                                             Multiple decode passes per audio segment
                                                    │
                                          3. MP3 saved to outputs/{job_id}.mp3
```

The pipeline is loaded once on the first request and kept in GPU memory for subsequent jobs. Restart the server to reload.

---

## Configuration

All machine-specific paths are controlled by two settings in `start.bat`:

| Variable | Description |
| --- | --- |
| `PYTHON_EXE` | Path to your heartlib virtualenv's Python interpreter |
| `HEARTMULA_PATH` | Path to the model checkpoint directory |

Both can also be set as system environment variables before launching.
