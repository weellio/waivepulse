"""Record a WAIvePulse visualizer to the frame sequence used as the website background.

    python scripts/make_viz_frames.py                          # defaults: Hex Portal, the house instrumental
    python scripts/make_viz_frames.py --song outputs/x.mp3 --preset Mandala --start 40
    python scripts/make_viz_frames.py --list                   # show the visualizer names

How it works, and why it is not a screen recording:
the visualizer reads its audio off an AnalyserNode. This computes that spectrum offline with the
same maths the browser uses (2048-point FFT, -100..-30 dB, 0.8 smoothing), hands it to the real
visualizer one frame at a time through a stub analyser, and saves each frame. So it renders in
seconds instead of real time, and the same song always produces the same frames.

The app must be running (python backend/app.py, port 7861) because the page imports its modules.
Output: landing/img/viz/v00.webp ... ready for the scroll-scrubbed background in landing/app.js.
"""
import argparse
import base64
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "landing" / "img" / "viz"
APP = "http://127.0.0.1:7861"
FFT = 2048
BINS = FFT // 2
MIN_DB, MAX_DB = -100.0, -30.0        # AnalyserNode defaults
WARMUP = 24                           # frames for the engines to settle before capture

HARNESS = """<!doctype html><html><body style="margin:0;background:#000">
<canvas id="viz"></canvas>
<script type="module">
  import { S } from '/js/karaoke/state.js';
  import * as V from '/js/karaoke/visualizers.js';
  window.__S = S; window.__V = V; window.__ready = true;
</script></body></html>"""


def spectrum(song, start, frames, fps):
    import numpy as np
    import soundfile as sf

    x, sr = sf.read(str(song), always_2d=True)
    mono = x.mean(axis=1)
    win = np.hanning(FFT)
    smooth = np.full(BINS, MIN_DB)     # silence, not 0 dB (0 dB is full scale)
    out = []
    for i in range(-WARMUP, frames):
        a = int((start + max(0, i) / fps) * sr)
        seg = mono[a:a + FFT]
        if len(seg) < FFT:
            seg = np.pad(seg, (0, FFT - len(seg)))
        mag = np.abs(np.fft.rfft(seg * win))[:BINS] / FFT
        smooth = 0.8 * smooth + 0.2 * (20 * np.log10(np.maximum(mag, 1e-10)))
        if i >= 0:
            norm = (smooth - MIN_DB) / (MAX_DB - MIN_DB)
            out.append([int(v) for v in np.clip(norm * 255, 0, 255).astype("uint8")])
    return {"bins": BINS, "frames": out}


def capture(spec, preset, size, keep_every):
    from playwright.sync_api import sync_playwright

    shots = []
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": size, "height": size})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:200]))
        # A URL that was never loaded before, so the ES modules evaluate fresh and bind to OUR
        # canvas. Loading /karaoke first would hand us its cached module, still bound to its own.
        pg.route("**/__vizharness", lambda r: r.fulfill(status=200, content_type="text/html", body=HARNESS))
        pg.goto(f"{APP}/__vizharness", wait_until="domcontentloaded", timeout=20000)
        pg.wait_for_function("window.__ready === true", timeout=15000)

        names = pg.evaluate("() => window.__S.PRESETS.map(p => p.name)")
        if preset.lower() not in [n.lower() for n in names]:
            b.close()
            sys.exit(f"unknown visualizer {preset!r}. Available: {', '.join(names)}")

        pg.evaluate("""([spec, preset, size]) => {
            const S = window.__S, V = window.__V;
            const c = document.getElementById('viz');
            c.width = size; c.height = size;
            let idx = 0;
            S._analyser = {
                frequencyBinCount: spec.bins, fftSize: spec.bins * 2,
                getByteFrequencyData: a => a.set(spec.frames[idx]),
                getByteTimeDomainData: a => {
                    const f = spec.frames[idx];
                    for (let i = 0; i < a.length; i++)
                        a[i] = 128 + Math.round(Math.sin(i * 0.06 + idx * 0.3) * 110 * (f[i % f.length] / 255));
                },
            };
            S._presetIdx = S.PRESETS.findIndex(p => p.name.toLowerCase() === preset.toLowerCase());
            S._patCache = {}; S._stars = null; S._bubbles = null; S._lasers = null;
            window.requestAnimationFrame = () => 0;      // one call = exactly one frame
            window.__step = () => { V.renderFrame(); idx = (idx + 1) % spec.frames.length; };
            for (let k = 0; k < 24; k++) window.__step();
        }""", [spec, preset, size])

        for i in range(len(spec["frames"])):
            pg.evaluate("window.__step()")
            if i % keep_every:
                continue
            data = pg.evaluate("() => document.getElementById('viz').toDataURL('image/png')")
            shots.append(base64.b64decode(data.split(",", 1)[1]))
        if errs:
            print("  page errors:", errs[:3])
        b.close()
    return shots


def pack(shots, size, quality):
    import numpy as np
    from PIL import Image

    yy, xx = np.mgrid[0:size, 0:size].astype("float32")
    r = np.hypot(xx - size / 2, yy - size / 2) / (size / 2)
    # Fade to black at the edge: the page composites with 'lighter', where black is invisible,
    # so this bakes a soft round vignette in for free and shrinks the files by ~40%.
    falloff = np.clip(1.0 - np.clip((r - 0.45) / 0.5, 0, 1) ** 1.5, 0, 1)

    OUT.mkdir(parents=True, exist_ok=True)
    for old in OUT.glob("*.webp"):
        old.unlink()
    total = 0
    from io import BytesIO
    for i, raw in enumerate(shots):
        im = Image.open(BytesIO(raw)).convert("RGB").resize((size, size), Image.LANCZOS)
        im = Image.fromarray((np.asarray(im).astype("float32") * falloff[..., None]).astype("uint8"))
        p = OUT / f"v{i:02d}.webp"
        im.save(p, "WEBP", quality=quality, method=6)
        total += p.stat().st_size
    return total


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--song", default=str(ROOT / "brag-assets" / "waivepulse_instrumental.wav"))
    ap.add_argument("--preset", default="Hex Portal")
    ap.add_argument("--start", type=float, default=31.0, help="seconds into the song")
    ap.add_argument("--seconds", type=float, default=3.0)
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--keep-every", type=int, default=3, help="keep every Nth rendered frame")
    ap.add_argument("--size", type=int, default=512)
    ap.add_argument("--quality", type=int, default=62)
    ap.add_argument("--list", action="store_true", help="list the visualizer names and exit")
    a = ap.parse_args()

    try:
        urllib.request.urlopen(APP + "/demucs-status", timeout=8)
    except Exception:
        sys.exit(f"WAIvePulse is not answering on {APP}. Start it first (start.bat).")

    if a.list:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as p:
            b = p.chromium.launch(); pg = b.new_page()
            pg.route("**/__vizharness", lambda r: r.fulfill(status=200, content_type="text/html", body=HARNESS))
            pg.goto(f"{APP}/__vizharness", wait_until="domcontentloaded", timeout=20000)
            pg.wait_for_function("window.__ready === true", timeout=15000)
            print("\n".join(pg.evaluate("() => window.__S.PRESETS.map(p => p.name)")))
            b.close()
        return 0

    song = Path(a.song)
    if not song.is_file():
        sys.exit(f"song not found: {song}")
    n = int(a.seconds * a.fps)
    t0 = time.time()
    print(f"analysing {song.name} from {a.start:.1f}s ({n} frames at {a.fps} fps)")
    spec = spectrum(song, a.start, n, a.fps)
    print(f"rendering '{a.preset}' at {a.size}px")
    shots = capture(spec, a.preset, a.size, a.keep_every)
    total = pack(shots, a.size, a.quality)
    print(f"{len(shots)} frames -> {OUT}")
    print(f"  {total/1024:.0f} KiB total, {total/len(shots)/1024:.1f} KiB each, {time.time()-t0:.1f}s")
    print("  deploy with: python scripts/deploy_site.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
