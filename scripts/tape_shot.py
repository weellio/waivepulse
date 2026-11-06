"""Screenshot the Multitrack tape panel for the README and the landing page.

Takes a folder of transferred tracks and shoots the Check tab, because the findings list is
the part of this feature that is hard to describe and obvious in a picture.

    python scripts/tape_shot.py <folder-with-transferred-tracks>
    WAIVEPULSE_URL=http://localhost:7899 python scripts/tape_shot.py D:\\transfers\\reel3

Without a folder it makes a demonstration reel in a temp directory — a short piece played
by four instruments with the faults a real transfer has: mains hum on one track, a dull
track as if the head azimuth was off, a couple of dropouts, and one track that was captured
in a second pass and lands late.
"""
import math
import os
import sys
import tempfile

import numpy as np
import soundfile as sf
from playwright.sync_api import sync_playwright

BASE = os.environ.get("WAIVEPULSE_URL", "http://localhost:7861")
OUT = os.path.join(os.path.dirname(__file__), "shots")
os.makedirs(OUT, exist_ok=True)
SR = 48_000


def demo_reel() -> str:
    """Four tracks of one performance, with the faults a tape transfer really has."""
    folder = os.path.join(tempfile.gettempdir(), "waivepulse-demo-reel")
    os.makedirs(folder, exist_ok=True)
    seconds = 18.0
    t = np.arange(int(seconds * SR)) / SR
    gate = (np.sin(2 * np.pi * 0.9 * t) > -0.4).astype(float)
    gate = np.convolve(gate, np.ones(400) / 400, mode="same")

    def note(f, amp):
        """Partials all the way up, so "duller than its siblings" can mean something.

        With only a handful of partials every track's 6-14 kHz band is just tape hiss, the
        azimuth comparison has nothing to compare, and a track with its top end sawn off
        measures the same as one without.
        """
        y = np.zeros_like(t)
        for k in range(1, 200):
            if f * k > 14000:
                break
            y += (amp / k) * np.sin(2 * np.pi * f * k * t)
        return y

    rng = np.random.default_rng(3)
    tracks = {
        "01_bass.wav": note(82.41, 0.30) * gate,
        "02_guitar.wav": (note(196.0, 0.16) + note(246.94, 0.12)) * gate,
        "03_keys.wav": (note(130.81, 0.14) + note(329.63, 0.08)) * gate,
        "04_vocal.wav": note(293.66, 0.22) * gate,
    }
    # 50 Hz mains hum on the guitar: a bad earth somewhere in the transfer chain. The whole
    # harmonic stack, because that is what a hum actually looks like and what the detector
    # measures — one lonely 50 Hz sine is not mains hum, it is a sine.
    # Applied across the WHOLE track, run-out included, because that is where it comes from:
    # the transfer chain hums whenever the converter is running, not only while the tape has
    # music on it. Hum measurement looks in the quietest second, so a fixture that stops the
    # hum when the music stops hides it from the very test that would find it.
    # the keys came off a head with the azimuth out: the top end is simply gone
    k = np.ones(64) / 64
    tracks["03_keys.wav"] = np.convolve(tracks["03_keys.wav"], k, mode="same")
    # a DC offset on the bass, from a converter input that was not quite centred
    tracks["01_bass.wav"] = tracks["01_bass.wav"] + 0.03
    # shed oxide on the vocal, placed where the part is actually playing
    for at in (4.6, 11.3):
        i = int(at * SR)
        while i < len(t) - SR and gate[i] < 0.9:
            i += 200
        tracks["04_vocal.wav"][i:i + int(0.05 * SR)] = 0.0
    # tape hiss everywhere, and a run-out so the floor can be measured honestly
    for name in tracks:
        tracks[name] = np.concatenate([tracks[name], np.zeros(int(1.5 * SR))])
        tracks[name] += rng.normal(0, 0.0012, len(tracks[name]))
    full = np.arange(len(tracks["02_guitar.wav"])) / SR
    tracks["02_guitar.wav"] += sum(0.022 / k * np.sin(2 * np.pi * 50.0 * k * full)
                                   for k in range(1, 5))
    # the vocal was a second pass: tape never starts in the same place twice
    tracks["04_vocal.wav"] = np.concatenate(
        [np.zeros(int(0.09 * SR)), tracks["04_vocal.wav"]])

    for name, y in tracks.items():
        sf.write(os.path.join(folder, name), y, SR, subtype="PCM_24")
    return folder


folder = sys.argv[1] if len(sys.argv) > 1 else demo_reel()
print(f"reel: {folder}")

with sync_playwright() as p:
    b = p.chromium.launch()
    page = b.new_page(viewport={"width": 1180, "height": 1000}, device_scale_factor=2)
    errs = []
    page.on("console", lambda m: errs.append(m.text) if m.type == "error" else None)
    page.goto(f"{BASE}/", wait_until="domcontentloaded", timeout=30000)
    page.wait_for_selector("#tape-btn", timeout=20000)
    page.click("#tape-btn")
    page.wait_for_selector("#tape-folder-in", timeout=10000)
    page.fill("#tape-folder-in", folder)
    page.click("button[data-act='open']")
    page.wait_for_selector(".tape-table", timeout=30000)
    page.screenshot(path=os.path.join(OUT, "tape-tracks.png"),
                    clip=page.locator("#tape-panel").bounding_box())

    page.click("button[data-act='check']")
    page.wait_for_selector(".tape-find", timeout=300000)
    page.wait_for_timeout(600)
    panel = page.locator("#tape-panel")
    panel.screenshot(path=os.path.join(OUT, "tape.png"))
    print(f"findings: {page.locator('.tape-find').count()}")
    for i in range(min(6, page.locator(".tape-find-h").count())):
        print("  " + page.locator(".tape-find-h").nth(i).inner_text()
              .encode("ascii", "replace").decode())

    page.click("button.tape-tab[data-tab='clean']")
    page.wait_for_selector("#tape-pick", timeout=10000)
    page.wait_for_timeout(400)
    panel.screenshot(path=os.path.join(OUT, "tape-clean.png"))

    print(f"console errors: {errs[:5] if errs else 'none'}")
    print(f"written to {OUT}")
    b.close()
