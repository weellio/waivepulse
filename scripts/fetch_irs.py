#!/usr/bin/env python
"""Fetch + prepare the Looper's convolution impulse responses.

The Looper's "Space" panel convolves with REAL room recordings instead of the old
generated-white-noise IR. This script downloads the raw captures, prepares them for
the browser, and writes the committed set under ``assets/ir/``:

  assets/ir/<id>.flac      16-bit FLAC @ 48 kHz (stereo rooms, mono cabs)
  assets/ir/manifest.json  what space.js reads: id / label / seconds / bytes / rt60
  assets/ir/LICENSES.md    every source named, with its licence

Preparation per IR:
  1. decode -> float32
  2. pick channels (4-channel "true stereo" captures: keep L->L for a mono cab)
  3. resample to 48 kHz (the browser resamples to the context rate anyway, and
     storing 192 kHz captures would waste ~4x the bytes for no audible gain)
  4. trim leading silence so the direct sound lands ~1 ms in -- the Looper adds its
     OWN per-distance pre-delay, so a capture's random pre-roll would fight it
  5. truncate where the envelope falls to -60 dB (capped per room so a noise floor
     can't pad the file), then a 30 ms raised-cosine fade so the tail can't click
  6. peak-normalise to -1 dBFS and write 16-bit FLAC

Licences: everything shipped here is MIT. OpenAIR (CC-BY) was evaluated and dropped --
its host's TLS certificate is expired, so the files cannot be fetched over a verified
connection. EchoThief / Samplicity M7 / Voxengo / Isophonics / Pori / SRIRACHA are
deliberately excluded: their licences forbid or conflict with redistribution here.

Usage:
    python scripts/fetch_irs.py              # fetch (cached), prepare, write assets/ir
    python scripts/fetch_irs.py --force      # re-download the raw captures
    python scripts/fetch_irs.py --report     # just print what is already prepared
"""

from __future__ import annotations

import argparse
import json
import os
import ssl
import sys
import urllib.parse
import urllib.request

import numpy as np

try:
    import soundfile as sf
except ImportError:  # pragma: no cover
    sys.exit("soundfile is required:  pip install soundfile")

try:
    from scipy.signal import resample_poly
except ImportError:  # pragma: no cover
    resample_poly = None

# Python on this machine cannot verify Let's Encrypt with the Windows root store;
# certifi's bundle can. Never fall back to an unverified context.
try:
    import certifi

    SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:  # pragma: no cover
    SSL_CTX = ssl.create_default_context()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "assets", "ir")
CACHE_DIR = os.path.join(
    os.environ.get("WP_IR_CACHE", os.path.join(os.environ.get("TEMP", "/tmp"), "wp-ir-cache"))
)

TARGET_SR = 48000
FADE_MS = 30.0          # raised-cosine fade at the truncation point
TRUNC_DB = -60.0        # truncate where the envelope reaches this, relative to peak
PEAK_DBFS = -1.0        # headroom so 16-bit quantisation can never clip
LEAD_MS = 1.0           # silence kept in front of the direct sound

# ── Sources ───────────────────────────────────────────────────────────────────────
# Every entry is from itsmusician/IR-Library, MIT (c) 2022 Conner. One repo keeps the
# whole set under a single permissive licence with no attribution UI obligation.
SOURCE = {
    "repo": "itsmusician/IR-Library",
    "rev": "main",
    "url": "https://github.com/itsmusician/IR-Library",
    "raw": "https://raw.githubusercontent.com/itsmusician/IR-Library/main/",
    "license": "MIT",
    "holder": "Copyright (c) 2022 Conner",
    "license_url": "https://github.com/itsmusician/IR-Library/blob/main/License.md",
}

# id, UI label, source path in the repo, channel plan, max seconds of tail to keep.
ROOMS = [
    dict(id="small-room", label="Small Room",
         path="Rooms/Commercial/Hotels/Guest Rooms/Hotel Room 1 XY (Balloon).wav",
         mode="stereo", max_s=0.9,
         note="Hotel guest room, XY pair, balloon burst - tight, dry, close walls."),
    dict(id="live-room", label="Live Room",
         path="Rooms/Residential/Ranch House/Ranch House Open Living Room.wav",
         mode="stereo", max_s=1.2,
         note="Open residential living room - wood floor slap, drum-friendly."),
    dict(id="studio-chamber", label="Studio Chamber",
         path="Rooms/Public/Colleges & Universities/University of Central Florida/Old Audio Engineering Club Room.wav",
         mode="stereo", max_s=1.8,
         note="Treated club room - diffuse, even decay, the classic echo-chamber send."),
    dict(id="concert-hall", label="Concert Hall",
         path="Rooms/Commercial/Hotels/Ballrooms/Palm Ballroom.wav",
         mode="stereo", max_s=4.0,
         note="Large ballroom - long, wide, orchestral tail."),
    dict(id="cathedral", label="Cathedral",
         path="Rooms/Historical/Landmarks/The Pantheon (Rome)/The Pantheon Optimal.wav",
         mode="stereo", max_s=4.5,
         note="The Pantheon, Rome - stone dome, enormous and dark."),
    dict(id="plate", label="Steel Plate",
         path="Plates/Conner Plate I/Conner Plate I Sweeps/Conner Plate I 10s -36.wav",
         mode="stereo", max_s=3.2,
         note="Real steel reverb plate, swept - dense, metallic, no early reflections."),
    dict(id="spring", label="Spring Tank",
         path="Speakers/Amplifiers/Jazz Chorus 120/JC-120 Spring 5s -42.wav",
         mode="stereo", max_s=2.6,
         note="Combo-amp spring tank, swept - boingy, mid-forward, surf guitar."),
    dict(id="cab", label="Amp Cab",
         path="Speakers/Amplifiers/Jazz Chorus 120/JC-120 True Stereo Chorus Dry.wav",
         mode="mono-first",  # 4-channel true-stereo capture: keep L->L
         max_s=0.22,
         note="Twin 12\" combo cab, chorus off - speaker colour, not a room."),
]


# ── helpers ───────────────────────────────────────────────────────────────────────
def log(*a):
    print(*a, flush=True)


def download(path: str, force: bool = False) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    local = os.path.join(CACHE_DIR, path.replace("/", "__"))
    if os.path.exists(local) and os.path.getsize(local) > 0 and not force:
        return local
    url = SOURCE["raw"] + urllib.parse.quote(path)
    log(f"  fetching {path}")
    req = urllib.request.Request(url, headers={"User-Agent": "waivepulse-fetch-irs"})
    with urllib.request.urlopen(req, context=SSL_CTX, timeout=180) as r:
        data = r.read()
    tmp = local + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, local)
    return local


def resample(x: np.ndarray, sr: int, target: int) -> tuple[np.ndarray, int]:
    if sr == target:
        return x, sr
    if resample_poly is None:
        return x, sr  # keep the source rate; the browser will resample on decode
    from math import gcd

    g = gcd(sr, target)
    y = resample_poly(x, target // g, sr // g, axis=0).astype(np.float32)
    return y, target


def smooth_env(x: np.ndarray, sr: int, ms: float = 5.0) -> np.ndarray:
    """Envelope = max across channels, box-smoothed, so one stray sample in the
    noise floor cannot decide where the tail ends."""
    env = np.abs(x).max(axis=1)
    n = max(1, int(sr * ms / 1000))
    k = np.ones(n, dtype=np.float64) / n
    return np.convolve(env, k, mode="same")


def rt60(x: np.ndarray, sr: int) -> float:
    """Schroeder backward integration, line-fitted -5..-35 dB, extrapolated to -60."""
    e = x.mean(axis=1).astype(np.float64) ** 2
    sch = np.cumsum(e[::-1])[::-1]
    if sch[0] <= 0:
        return 0.0
    db = 10 * np.log10(np.maximum(sch / sch[0], 1e-20))
    below = np.where(db <= -5)[0]
    i5 = int(below[0]) if len(below) else 0
    below = np.where(db <= -35)[0]
    i35 = int(below[0]) if len(below) else len(db) - 1
    if i35 - i5 < 16:
        return 0.0
    t = np.arange(i5, i35) / sr
    slope, _ = np.polyfit(t, db[i5:i35], 1)
    return float(-60.0 / slope) if slope < 0 else 0.0


def prepare(room: dict, force: bool) -> dict:
    local = download(room["path"], force)
    x, sr = sf.read(local, always_2d=True, dtype="float32")
    src_ch, src_sr, src_len = x.shape[1], sr, len(x) / sr

    # 2. channel plan
    if room["mode"] == "mono-first":
        x = x[:, :1]
    elif room["mode"] == "mono":
        x = x.mean(axis=1, keepdims=True)
    elif x.shape[1] > 2:
        x = x[:, :2]
    elif x.shape[1] == 1:
        x = np.repeat(x, 2, axis=1)

    # 3. resample
    x, sr = resample(x, sr, TARGET_SR)

    # 4. trim leading silence to LEAD_MS in front of the direct sound
    env = smooth_env(x, sr)
    pk = float(env.max())
    if pk <= 0:
        raise RuntimeError(f"{room['id']}: source is silent")
    onset = int(np.argmax(env >= pk * 10 ** (-40 / 20)))
    lead = int(sr * LEAD_MS / 1000)
    x = x[max(0, onset - lead):]

    # 5. truncate at -60 dB (capped), then fade.
    # A capture's noise floor can sit above -60 dB of peak, which would otherwise pad
    # the file with hiss, so the threshold also has to clear the floor itself -- the 5th
    # percentile of the envelope is a robust read of "the quiet part of this recording".
    env = smooth_env(x, sr)
    pk = float(env.max())
    floor = float(np.percentile(env, 5))
    thr = max(pk * 10 ** (TRUNC_DB / 20), floor * 3.0)
    above = np.where(env > thr)[0]
    end = int(above[-1]) + 1 if len(above) else len(x)
    end = min(end, int(sr * room["max_s"]))
    end = max(end, int(sr * 0.02))
    x = x[:end].copy()

    fade = min(int(sr * FADE_MS / 1000), len(x) // 2)
    if fade > 1:
        w = 0.5 * (1 + np.cos(np.linspace(0, np.pi, fade)))   # 1 -> 0, zero slope at both ends
        x[-fade:] *= w[:, None].astype(np.float32)

    # 6. normalise and write
    peak = float(np.abs(x).max())
    if peak < 1e-7:
        raise RuntimeError(f"{room['id']}: prepared IR is silent")
    x *= (10 ** (PEAK_DBFS / 20)) / peak

    os.makedirs(OUT_DIR, exist_ok=True)
    dest = os.path.join(OUT_DIR, room["id"] + ".flac")
    sf.write(dest, x, sr, subtype="PCM_16", format="FLAC")

    meta = dict(
        id=room["id"], label=room["label"], file=room["id"] + ".flac",
        seconds=round(len(x) / sr, 3), channels=x.shape[1], sampleRate=sr,
        rt60=round(rt60(x, sr), 3), peak=round(float(np.abs(x).max()), 4),
        bytes=os.path.getsize(dest), note=room["note"], source=room["path"],
        license=SOURCE["license"],
    )
    log(f"  {room['id']:<15} {meta['seconds']:>5.2f}s  {meta['channels']}ch  "
        f"rt60 {meta['rt60']:>5.2f}s  {meta['bytes']/1024:>7.1f} KiB   "
        f"(from {src_ch}ch {src_sr} Hz {src_len:.2f}s)")
    return meta


def write_licenses(metas: list[dict]) -> None:
    rows = "\n".join(
        f"| `{m['id']}.flac` | {m['label']} | {m['seconds']:.2f} s | "
        f"{m['bytes'] / 1024:.0f} KiB | {m['license']} | `{m['source']}` |"
        for m in metas
    )
    total = sum(m["bytes"] for m in metas)
    text = f"""# Impulse response licences

Every impulse response bundled in this folder is redistributed under a permissive
licence. Nothing here requires an attribution notice inside the app UI, but the
sources are named below anyway, and this file travels with the files.

Prepared by `scripts/fetch_irs.py` (resample to {TARGET_SR // 1000} kHz, trim lead-in,
truncate at {TRUNC_DB:.0f} dB with a {FADE_MS:.0f} ms fade, peak {PEAK_DBFS:.0f} dBFS,
16-bit FLAC). Total bundled: **{total / 1024:.0f} KiB** across {len(metas)} rooms.

## Source

**{SOURCE['repo']}** — <{SOURCE['url']}> (rev `{SOURCE['rev']}`)
Licence: **{SOURCE['license']}** — {SOURCE['holder']}
Full text: <{SOURCE['license_url']}>

> Permission is hereby granted, free of charge, to any person obtaining a copy of this
> software and associated documentation files (the "Software"), to deal in the Software
> without restriction… The above copyright notice and this permission notice shall be
> included in all copies or substantial portions of the Software.

The MIT notice above is reproduced in full in `MIT-itsmusician-IR-Library.txt`
next to this file.

## Files

| File | Room | Length | Size | Licence | Source capture |
|---|---|---|---|---|---|
{rows}

## Sets deliberately NOT used

| Set | Why not |
|---|---|
| OpenAIR (York) | CC-BY, usable in principle, but the host's TLS certificate is expired so the captures cannot be fetched over a verified connection. Dropped rather than downloaded insecurely. |
| EchoThief | Licence does not grant redistribution. |
| Samplicity Bricasti M7 | Licence restricts redistribution of the IR files. |
| Voxengo IR packs | Licence conflicts with bundling in an app. |
| Isophonics / Pori / SRIRACHA | Research-use or non-commercial terms that conflict with this project's licence. |

Trademarks named in the source capture paths (e.g. amplifier model names) belong to
their owners and are used for identification only; no affiliation or endorsement is
implied. See the source repository's `References.md`.
"""
    with open(os.path.join(OUT_DIR, "LICENSES.md"), "w", encoding="utf-8", newline="\n") as f:
        f.write(text)

    mit = f"""{SOURCE['holder']}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Source: {SOURCE['url']}
"""
    with open(os.path.join(OUT_DIR, "MIT-itsmusician-IR-Library.txt"), "w",
              encoding="utf-8", newline="\n") as f:
        f.write(mit)


def report() -> int:
    mf = os.path.join(OUT_DIR, "manifest.json")
    if not os.path.exists(mf):
        log("nothing prepared yet — run without --report")
        return 1
    data = json.load(open(mf, encoding="utf-8"))
    total = 0
    for m in data["rooms"]:
        p = os.path.join(OUT_DIR, m["file"])
        n = os.path.getsize(p) if os.path.exists(p) else 0
        total += n
        log(f"  {m['id']:<15} {m['seconds']:>5.2f}s  {m['channels']}ch  "
            f"rt60 {m['rt60']:>5.2f}s  {n/1024:>7.1f} KiB" + ("" if n else "  MISSING"))
    log(f"  {'TOTAL':<15} {total/1024:>31.1f} KiB")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--force", action="store_true", help="re-download the raw captures")
    ap.add_argument("--report", action="store_true", help="print the prepared set and exit")
    args = ap.parse_args()
    if args.report:
        return report()

    log(f"preparing {len(ROOMS)} impulse responses -> {OUT_DIR}")
    metas = [prepare(r, args.force) for r in ROOMS]

    manifest = dict(
        version=1, sampleRate=TARGET_SR, truncateDb=TRUNC_DB, fadeMs=FADE_MS,
        generatedBy="scripts/fetch_irs.py",
        source={k: SOURCE[k] for k in ("repo", "rev", "url", "license", "holder", "license_url")},
        rooms=[{k: m[k] for k in
                ("id", "label", "file", "seconds", "channels", "sampleRate",
                 "rt60", "peak", "bytes", "note", "license")} for m in metas],
    )
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8", newline="\n") as f:
        json.dump(manifest, f, indent=1)
        f.write("\n")
    write_licenses(metas)

    total = sum(m["bytes"] for m in metas)
    log(f"\n  TOTAL {total} bytes ({total/1024/1024:.2f} MiB) across {len(metas)} rooms")
    if total > 8 * 1024 * 1024:
        log("  WARNING: over the 8 MiB budget")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
