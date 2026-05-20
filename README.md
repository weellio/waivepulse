# WAIvePulse

![License: MIT + Commons Clause](https://img.shields.io/badge/license-MIT%20%2B%20Commons%20Clause-blue)

![WAIvePulse](assets/wave%20small.png)

A local, fully offline AI music generation tool powered by **HeartMuLa 3B**. Give it lyrics and genre tags, get back a complete song with vocals as an MP3.

Runs on your own machine. No cloud, no subscription, no usage limits.

> **Supported platforms: Windows and Linux only.**
> macOS is not supported — this tool requires an NVIDIA GPU with CUDA, which no modern Mac provides.

---

## What It Does

- Takes structured lyrics (with `[Verse]`, `[Chorus]`, etc. section markers) and a list of style/genre tags
- Generates a complete song with full vocals, instrumentation, and structure as an MP3
- Serves a dark-themed web UI on `http://localhost:7860`
- Queues jobs in order — submit new requests while one is generating, they run one at a time
- Shows real-time generation progress (language model phase + codec phase) with live log output
- Persists job history across server restarts
- 7 audio visualizer styles with fullscreen mode (great on a TV)
- **BPM + key detection** — each completed song card shows the detected tempo and musical key (requires `librosa`)
- **Studio page** — separates any generated song into 6 stems (vocals, drums, bass, guitar, piano, other) with a DAW-style mixer, waveform display, mute/solo/volume per track, and stem zip export
- **Studio stem presets** — one-click mix presets: Full Mix, Karaoke (vocals off), Acappella (instruments off), Drums Only, No Drums
- **Studio A-B loop** — drag on the ruler to mark a loop region; playback repeats within that region when loop is enabled; ESC clears it
- **Studio track duplication** — DUP button per track creates a layered copy with independent knobs; OFS knob (0–50 ms) on every track for ADT doubling effects
- **Studio mute automation** — shift+drag on any waveform to draw red mute regions; live during playback and baked into exports; click a region to delete it
- **Studio track import** — drag & drop or ＋ Track button adds any audio file (MP3/WAV/FLAC/OGG) as a full mixer track; drag the clip block left/right on the timeline to set its start position; loop toggle repeats short clips for the full song
- **Studio per-track SUB knob** — 60 Hz lowshelf shelf per track; AI music often lacks sub-bass — boost this on drums and bass stems to add physical rumble and body
- **Studio master harmonic exciter** — EXC button on the master bus; high-passes at 3 kHz, applies soft saturation, mixes back at 18% wet; adds overtone shimmer and "air" AI audio typically lacks
- **Studio MASTER preset** — one-click mastering treatment: duplicates drums at 12 ms ADT offset, boosts sub/treble per stem, adds reverb presence, enables the exciter, and boosts master sub + air EQ
- **Studio master volume** — VOL slider in the transport bar scales the entire mix output from 0–150%; affects both live playback and Export Mix; default 100%
- **Studio RST ALL** — resets every knob on every track to defaults in one click; individual RST button per track still available
- **Studio track selection + DAW shortcuts** — click any track to select it (cyan border); keyboard shortcuts then operate on that track (M/S/N/R/D); Tab/Shift+Tab cycles tracks; full shortcut reference via the **?** button or H key
- **Studio help modal** — **?** button (top-right) or **H** key opens a full in-app reference covering every knob, button, and keyboard shortcut
- **Karaoke mode** — fullscreen visualizer with synced lyrics; Whisper transcribes the vocals stem, LCS-aligns to the original lyrics, displays a 5-word sliding window with the active word highlighted; vocals toggle for sing-along vs instrumental; requires `faster-whisper`
- **AI content watermarking** — AudioSeal neural watermark (survives re-encoding) + C2PA provenance manifest embedded in every generated MP3 (requires `audioseal`, `torchaudio`, `c2pa`, `cryptography`)

---

![WAIvePulse](assets/wavepulse.jpg)


---

## Demo

▶ [Sing-along demo made with WAIvePulse](https://www.youtube.com/watch?v=gKttuxGeLkw) — AI-generated song with lyrics displayed on screen

---

## Requirements

| Component | Requirement |
|---|---|
| OS | Windows 10/11 or Linux (macOS not supported) |
| GPU | NVIDIA GPU with ~10 GB VRAM minimum (CUDA required) |
| Python | 3.10+ |
| Model | HeartMuLa-oss-3B (~15 GB) + HeartCodec-oss (~6.2 GB) + HeartMuLaGen (~small) |
| Framework | FastAPI + uvicorn (installed automatically by setup) |
| BPM/Key | `librosa` — `pip install librosa` |
| Watermarking | `audioseal torchaudio c2pa cryptography` — `pip install audioseal torchaudio c2pa cryptography` |

---

## Quick Start

### 1. First-time setup (run once)

**Linux:**
```bash
bash setup.sh
```

**Windows:**
```batch
setup.bat
```

The setup script does everything automatically:
- Installs Python, ffmpeg, and git (if not already present)
- Checks your NVIDIA GPU and CUDA version
- Creates a Python virtual environment
- Installs PyTorch (with the right CUDA build), heartlib, and all other dependencies
- Downloads the HeartMuLa model weights (~21 GB — this takes a while)

No manual steps. When it finishes, you're ready to launch.

> **Default install locations** — models and the venv go under `~/HeartMuLa/` (Linux) or `%USERPROFILE%\HeartMuLa\` (Windows). To use a different location, set `WAIVEPULSE_VENV` and `WAIVEPULSE_CKPT` environment variables before running setup.

### 2. Launch (every time)

**Linux:**
```bash
bash start.sh
```

**Windows:**
```batch
start.bat
```

Then open **http://localhost:7860** in any browser.

The launchers automatically kill any old server process on port 7860 before starting.

---

## Using the Web UI

### 1. Song Title
Optional label — used as the filename and display name in the history panel.

### 2. Artist
Optional. Embedded directly into the MP3 as the ID3 Artist tag. If left blank, defaults to "WAIvePulse".

### 3. Lyrics
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

### 4. Genre & Style Tags

Tags are how you communicate the sound you want. HeartMuLa was trained with **8 distinct tag categories** — each one shapes a different dimension of the output. The UI organizes them into collapsible sections so you can pick deliberately rather than guess.

**The most important rule: one tag per category.** The model was trained on examples where each category had a single value. Stacking multiple tags from the same category (e.g. `pop,rock,jazz`) causes the model to average them into something muddier than any one would produce alone. More tags is not better — cleaner is better.

| Category | Importance | What it shapes |
|---|---|---|
| **Genre** | Required | The core musical style. Always pick one. |
| **Timbre** | Recommended | The tone and texture of the sound — bright vs dark, warm vs harsh, smooth vs gritty. |
| **Gender** | Recommended | Whether the vocalist sounds male, female, or mixed. Also use `no vocals` for instrumentals. |
| **Mood** | Recommended | The emotional color — nostalgic, epic, melancholic, playful, etc. |
| **Instrument** | Recommended | A featured instrument the model will try to put front and center. |
| **Scene** | Optional | A setting or context that influences the atmosphere — coffee shop, stadium, late night, etc. |
| **Region** | Optional | A cultural flavor — `british` pulls toward melodic rock, `latin` adds rhythmic warmth, `nordic` tends cold and sparse. |
| **Topic** | Optional | The lyrical subject. Reinforces what you wrote in the lyrics box. |

**Good combo:** `rock,dark,male vocals,nostalgic,electric guitar,british` — clear, one per category, covers the most influential dimensions.

**Avoid:** `pop,rock,jazz` (three Genre tags produce muddy averaging), or `happy,melancholic,dark` (conflicting Mood tags).

**Blending two artists:** The model doesn't know artist names, but you can describe what makes each distinctive across different categories. To blend Linkin Park and The Beatles, for example: Genre `rock`, Timbre `dark`, Region `british` (the key Beatles lever), Mood `nostalgic`, Instrument `electric guitar`. The characteristics come from different categories so they don't conflict.

You can also type freeform tags in the custom field below the grid — comma-separated. Use this for anything not covered by the presets, or for sub-genre descriptors like `nu-metal`, `anthemic`, or `chamber pop`.

### 5. Tag Presets

Click **+ Save current** next to "Tag Presets" to save your active tag selection under a name. Saved presets appear as chips — click a chip to apply it, × to delete it. Presets are stored in browser localStorage and persist across sessions.

### 6. Advanced Settings (click to expand)

| Setting | Default | Range | Description |
|---|---|---|---|
| Max Duration | 5:00 | 0:30 – 5:00 | Upper limit on song length. The model may stop earlier at a natural end. |
| Temperature | 1.0 | 0.5 – 2.0 | Higher = more creative/unpredictable. Lower = more conservative/structured. |
| CFG Scale | 1.5 | 1.0 – 5.0 | How strictly the output follows your tags. Higher = stronger style adherence. |

### 7. Generate
Hit **Generate Song**. The button re-enables immediately so you can queue another request. Only one job runs at a time — others wait in the queue.

While generating, each job card shows:

- **Language model** progress bar — token generation (phase 1)
- **Audio codec** progress bar — waveform decode (phase 2)
- **Live log** — raw output from the model, scrolling in real time

**Amber pulsing dot** = generating. **Green dot** = done, audio player appears.

### 8. Completed cards

Each finished card has:

- **Audio player** with 7 visualizer styles — click the style button to cycle, or **double-click the visualizer** (or click ⛶) to go **fullscreen**
- **⬇ Download** — saves the MP3 directly to disk
- **↺ Use Settings** — loads this song's lyrics, tags, and artist back into the form so you can regenerate or tweak
- **🎛 Studio** — opens the stem separation Studio page for this song
- **Duration and file size** shown in the card
- **BPM and key** displayed as chips on the card (e.g. `♩ 128 BPM`, `♬ A minor`) — requires `librosa`
- **ID3 metadata** embedded in the file (readable by any media player or DAW)

**Visualizer styles:**

| Style | Description |
| --- | --- |
| ◉ Ring | Circular frequency bars around a glowing core |
| ▐ Bars | Vertical frequency spectrum with glow |
| ∿ Wave | Mirrored waveform fill |
| ✦ Galaxy | Rotating starburst — lines radiate from center, colored by frequency |
| ≋ Aurora | Layered flowing sine bands, like northern lights |
| ✺ Particles | Frequency-reactive particles that scatter outward and drift with gravity |
| ⊙ Scope | Stabilized oscilloscope with zero-crossing lock |

**Fullscreen:** double-click any visualizer (or click the ⛶ icon in the corner) to launch it fullscreen — works great on a TV or second screen. Move the mouse to reveal the style-cycle and exit controls. Press **Escape** to exit.

| Tag | Value |
| --- | --- |
| Title | Song title |
| Artist | Your input, or "WAIvePulse" if blank |
| Album Artist | WAIvePulse |
| Composer | HeartMuLa 3B |
| Genre | Full tags string |
| Year | Current year |
| Encoded by | WAIvePulse / HeartMuLa 3B |
| Comment | `Tags: ... \| Temperature: ... \| CFG Scale: ...` |

### 9. Cancel

Active jobs (queued or generating) have a **Cancel** button in the card header. Queued jobs cancel immediately. In-progress jobs finish the current generation, then discard the output.

### 10. Load MP3

Use the **▶ Load MP3** button to load one or more local audio files into the history panel for visualization. Also supports **drag and drop** — drag MP3 files anywhere onto the right-hand panel.

---

## Studio (Stem Separation)

![WAIvePulse Studio](assets/studio.jpg)

Click **🎛 Studio** on any completed song card to open the Studio page for that song.

### What it does

The Studio page runs **Demucs** (Facebook Research) on your song to separate it into up to 6 individual stems, then gives you a DAW-style mixer to play them back together.

### Setup

- **Demucs** installed in your Python environment: `pip install demucs` (included in `requirements.txt`)
- **ffmpeg** on your PATH for MP3 stem output (WAV fallback if not present)
  - Linux: `sudo apt install ffmpeg`
  - Windows: `winget install ffmpeg`
- Separation uses your GPU and takes a few minutes per song

### Stems

| Stem | Description |
| --- | --- |
| Vocals | Lead and backing vocals |
| Drums | Drum kit and percussion |
| Bass | Bass guitar and low-end |
| Guitar | Electric and acoustic guitar |
| Piano | Piano and keys |
| Other | Everything else |

### Presets

One-click buttons above the mixer apply common stem combinations:

| Preset | What's audible |
| --- | --- |
| Full Mix | All stems |
| Karaoke | Everything except vocals — sing along |
| Acappella | Vocals only |
| Drums Only | Drums only |
| No Drums | Everything except drums |

### A-B Loop

**Drag on the ruler** to mark a loop region — a cyan highlight shows the selected range. Enable the **⟳** loop button and playback will repeat within that region. **ESC** clears the loop region.

### Mute Automation

Draw mute regions directly on any waveform to silence a track for a specific section — acappella refrain, drum solo, instrumental bridge.

- **Shift + drag** on a waveform — draws a red mute region for that track
- **Click inside a mute region** — deletes that region
- Regions from the same track are **automatically merged** if they overlap or sit within 50 ms of each other
- Mute regions work live during playback and are baked into the **⬇ Export Mix**
- Hint reminder in the sidebar header: `⇧ drag = mute region`

### Track Import

Bring in any audio file as an extra mixer track — a sample, a loop, a scratch vocal, anything.

- **＋ Track** button in the transport bar — opens a file picker (MP3, WAV, FLAC, OGG, M4A, AAC)
- **Drag and drop** one or more audio files onto the Studio window — a full-screen drop target appears
- Imported tracks appear below the stem tracks with the same full knob set (VOL, PAN, EQ, REV, DLY, OFS)
- **⟳ button** on imported tracks — toggles loop mode so a short sample repeats for the full song duration
- **× button** — removes the imported track
- Loop state is respected in Export Mix — looped imports will loop for the full render duration
- Imported tracks get a distinct gold color in the waveform view so they're easy to spot

### Karaoke Mode

Click **🎤 Karaoke** in the transport bar (enabled once separation is done) to open a fullscreen performance page.

| Feature | Description |
|---|---|
| 5-word lyric window | Active word highlighted in amber; two words on each side shown dimmer and smaller — same sliding window style as professional karaoke |
| Lyrics sync | Whisper transcribes the vocals stem on-demand; LCS algorithm aligns Whisper's output to your original lyrics to correct misheard words |
| Vocals toggle | **V** key or button — mutes/unmutes the vocals stem in real time. Karaoke mode = vocals off, sing-along mode = vocals on |
| Visual styles | 4 styles: Galaxy, Aurora, Bars, Scope — press **N** to cycle |
| Auto-transcribe | **AUTO TX** toggle in Studio transport — when on, Whisper runs automatically in the background right after separation finishes so Karaoke opens instantly |
| Keyboard | **Space** play/pause · **V** vocals toggle · **N** next style · **←/→** seek ±5s · **Esc** back to Studio |

**Setup:** requires `faster-whisper` — already included in `requirements.txt`, installed automatically by the setup script.

```
pip install faster-whisper
```

If `faster-whisper` is not installed, Karaoke mode still works — it just plays the song with the visualizer and no lyric sync.

### Controls

- **Mute (M)** — silence an individual track
- **Solo (S)** — hear only soloed tracks (multiple solo works)
- **Volume, Pan, SUB, Bass, Mid, Treb, Rev, Dly, OFS knobs** — per-track; drag up/down or scroll wheel; double-click to reset
- **NRM** — normalize track to peak level
- **RST** — reset all knobs to default
- **DUP** — duplicate track with independent knobs (use OFS knob for ADT/doubling)
- **Click a track strip or waveform row** — selects that track (cyan highlight); keyboard shortcuts then apply to it
- **Tab / Shift+Tab** — cycle to next / previous track
- **Click anywhere on a waveform / ruler** — seek to that position (drag on ruler to set A-B loop)
- **Shift + drag on a waveform** — draw a mute region for that section
- **Drag an imported clip block** — reposition where in the song it plays (grab cursor appears on hover)
- **EXC** — toggle master bus harmonic exciter (adds overtone shimmer to high frequencies only)
- **LMT** — toggle master bus limiter/compressor (loudness glue, tames peaks)
- **MASTER** — one-click mastering preset applied to all stems
- **VOL slider** — master output volume (0–150%); scales the full mix; baked into Export Mix
- **RST ALL** — reset every knob on every track to defaults in one click
- **? / H** — open the in-app help reference
- **Space** — play / pause
- **Home** — stop and return to start
- **⬇ Export Mix** — renders the full mix (all knobs, EQ, mute regions, positioning, master chain) to a lossless WAV

**Full keyboard shortcut reference:** press **?** or **H** inside the Studio to open the built-in help panel.

### Notes

- Separation and generation share the same job queue — only one runs at a time to avoid VRAM conflicts
- The stems are cached: clicking Studio again on the same song loads instantly
- The `?sep=` URL parameter lets you bookmark or share a direct link to a finished separation

---

## Generation Time

Approximate times on a mid-range GPU with 12 GB VRAM — your hardware will vary:

| Duration | LM Tokens | Approx. Time |
|---|---|---|
| 30 seconds | ~375 tokens | 10–12 min |
| 1 minute | ~750 tokens | 20–25 min |
| 2 minutes | ~1500 tokens | 40–50 min |
| 3 minutes | ~2250 tokens | 60–80 min |
| 5 minutes | ~3750 tokens | 100–130 min |

Two phases run sequentially:

1. **Language model phase** — autoregressive audio token generation (~1.5 tokens/sec)
2. **Codec decode phase** — converts tokens to waveform (~41 sec/step, 10 steps per ~30s of audio)

Progress for both phases is shown live in the browser via the job card.

---

## File Structure

```
waivepulse/
├── setup.sh                    First-time setup: install deps + download models (Linux)
├── setup.bat                   First-time setup: install deps + download models (Windows)
├── start.sh                    Launch the server (Linux)
├── start.bat                   Launch the server (Windows)
├── requirements.txt            Python dependencies (installed by setup script)
├── README.md                   This file
│
├── backend/
│   └── app.py                  FastAPI server — queue, SSE, history, pipeline loader
│
├── frontend/
│   └── index.html              Single-page UI — no build step, served directly by FastAPI
│
├── scripts/
│   ├── test_generate.py        Standalone end-to-end test (bypasses the web server)
│   ├── download_models.py      Download/re-download model weights from HuggingFace
│   └── fix_dist_infos.py       Utility to remove stale dist-info conflicts in site-packages
│
├── history.json                Persisted job history (auto-created, gitignored)
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
Returns `{"job_id": "abc12345"}`. Job is added to the FIFO queue immediately.

| Field | Type | Default | Description |
|---|---|---|---|
| lyrics | string | required | Full lyrics with section markers |
| tags | string | required | Comma-separated style tags |
| title | string | "Untitled" | Used for display name and output filename |
| max_duration_sec | int | 300 | Maximum audio length in seconds |
| temperature | float | 1.0 | Sampling temperature (0.5–2.0) |
| cfg_scale | float | 1.5 | Classifier-free guidance scale |
| topk | int | 50 | Top-k sampling cutoff |

### `GET /status/{job_id}`
```json
{
  "status": "done",
  "message": "Generation complete",
  "file": "/outputs/My_Song_abc12345.mp3",
  "file_size": 4521984,
  "title": "My Song",
  "tags": "pop,piano,upbeat",
  "lyrics": "...",
  "temperature": 1.0,
  "cfg_scale": 1.5,
  "max_duration_sec": 60,
  "created_at": "2026-05-14T19:16:02.634449"
}
```
Status values: `queued` → `generating` → `done` / `error` / `cancelled`

### `POST /cancel/{job_id}`

Cancels a queued or generating job. Queued jobs cancel immediately. Generating jobs are flagged — the output is discarded once generation finishes.

### `GET /progress/{job_id}`

Server-Sent Events stream of live log lines from the generation thread. Each event is a JSON-encoded string. Ends with a `__done__` event when the job completes.

```
data: "Generating tokens:  45%|████  | 337/750 [10:23<12:44]"
data: "Codec decode step: 6/10 [04:52<03:20]"
data: "__done__"
```

### `GET /outputs/{filename}.mp3`
Direct download/stream of a generated audio file.

### `GET /history`
Returns all jobs in reverse chronological order. Includes full job data (lyrics, settings, file path, etc.). Persisted in `history.json` across server restarts.

### `DELETE /history/{job_id}`
Deletes the job record and the corresponding MP3 file on disk.

---

## Troubleshooting

### Port already in use
The launchers automatically kill any existing process on port 7860 before starting. If you still see the error, run manually:

Linux:
```bash
fuser -k 7860/tcp
```
Windows:
```batch
for /f "tokens=5" %a in ('netstat -ano ^| findstr ":7860 " ^| findstr "LISTENING"') do taskkill /F /PID %a
```

### "Models missing" badge
Run the download script directly:

Linux:
```bash
HEARTMULA_PATH="$HOME/HeartMuLa/ckpt" <your-python> scripts/download_models.py
```
Windows:
```batch
<your-python> scripts\download_models.py
```
Total download size is ~21 GB. The badge auto-refreshes every 10 seconds while downloading.

### Generation error in job card
Check the terminal running the launcher for the full Python traceback. Common causes:

- **Out of VRAM** — close other GPU-heavy apps before generating
- **Corrupted model file** — re-run `download_models.py` to re-download

### Model loads slowly on first request
Normal. The first `POST /generate` after starting the server triggers model load (~20–30 seconds) before generation begins. Subsequent requests use the already-loaded model.

### `import error: No module named 'triton'`
Harmless warning from PyTorch on Windows — triton is Linux-only and will be present automatically on Linux. Generation still works correctly on Windows without it.

### History not showing after restart

History is loaded from `history.json` on startup. Any jobs that were `queued` or `generating` when the server stopped are automatically marked as errors.

---

## How It Works (Technical)

```
Browser → FastAPI (uvicorn) → FIFO queue → worker thread → HeartMuLaGenPipeline
                    ↑                              │
             SSE /progress              thread-local stdout capture
             (real-time logs)                      │
                                       1. Language Model (3B params)
                                          Autoregressive token generation
                                          Input: lyrics text + style tags
                                          Output: audio tokens (discrete codes)
                                                   │
                                       2. HeartCodec (decoder)
                                          Converts audio tokens → waveform
                                          Multiple decode passes per audio segment
                                                   │
                                       3. MP3 saved to outputs/{title}_{job_id}.mp3
                                          history.json updated
```

A single background worker thread processes jobs in order. `stdout` and `stderr` are wrapped with a thread-local tee so each generation thread's output is captured separately and streamed to the browser without interfering with other output.

---

## Configuration

Setup writes a small config file (`.waivepulse` on Linux, `.waivepulse.bat` on Windows) that `start` reads automatically — you never need to edit `start.sh` or `start.bat`.

To change the install location, set these environment variables **before running setup**:

| Variable | Default (Linux) | Default (Windows) |
| --- | --- | --- |
| `WAIVEPULSE_VENV` | `~/HeartMuLa/venv` | `%USERPROFILE%\HeartMuLa\venv` |
| `WAIVEPULSE_CKPT` | `~/HeartMuLa/ckpt` | `%USERPROFILE%\HeartMuLa\ckpt` |

Example:
```bash
WAIVEPULSE_CKPT=/mnt/models/HeartMuLa bash setup.sh
```
