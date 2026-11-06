"""Tape sessions: get a multitrack tape transfer into the app, check it, and clean it up.

The rest of WAIvePulse starts from a song it generated. This starts from a folder of WAVs
somebody captured off a 4-track, an 8-track reel or an ADAT, and the differences matter:

  * **A folder, not an upload.** Eight tracks of a five-minute song at 24-bit/96k is about
    700 MB. The server runs on the same machine as the browser, so it reads the files where
    they already are instead of copying them through an HTTP form.

  * **Originals are never written to.** A flat transfer is the preservation master and may be
    the only surviving copy of the performance — the tape itself may not survive another
    pass. Every repair writes a NEW file alongside, and the scanner skips what it wrote.

  * **The faults are tape faults.** Mains hum, hiss, dropouts, DC offset, a dull track from
    head azimuth, tracks that do not line up because they were captured in separate passes.
    Song Check looks for the things a generator gets wrong; none of those apply here.

What this deliberately does NOT do is capture audio. That needs the interface's own driver
and belongs in whatever the user already records with.
"""
from __future__ import annotations

import math
import re
from pathlib import Path
from typing import Any, Dict, List, Optional

AUDIO_EXT = {".wav", ".aiff", ".aif", ".flac", ".mp3", ".ogg", ".opus", ".m4a"}

# Files this module has written. Re-scanning a folder must not pick up its own output and
# offer to clean an already-cleaned track.
REPAIR_SUFFIX = ".wp-clean"

# Mains frequency differs by country and the wrong guess leaves the hum in place.
MAINS = (50.0, 60.0)


def _probe(path: Path) -> Dict[str, Any]:
    import soundfile as sf
    info = sf.info(str(path))
    return {
        "name": path.name,
        "path": str(path),
        "seconds": round(float(info.frames) / info.samplerate, 2) if info.samplerate else 0.0,
        "samplerate": info.samplerate,
        "channels": info.channels,
        "subtype": info.subtype,
        "frames": int(info.frames),
    }


def scan(folder: str, include_repairs: bool = False) -> Dict[str, Any]:
    """List the audio files in a folder, newest capture conventions tolerated.

    Sorted naturally, so Track2 comes before Track10 — tape transfers are numbered and
    lexicographic order puts them in the wrong places.

    Repaired files are left out by default: a session should not offer to clean a track it
    cleaned ten minutes ago. The manifest asks for them, because a manifest that lists only
    the masters cannot say where the derived files came from.
    """
    d = Path(folder).expanduser()
    if not d.is_dir():
        return {"ok": False, "error": f"{d} is not a folder on this machine.", "tracks": []}

    files = [p for p in sorted(d.iterdir())
             if p.is_file() and p.suffix.lower() in AUDIO_EXT
             and (include_repairs or REPAIR_SUFFIX not in p.name)]

    def natural(p: Path):
        return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", p.name)]

    files.sort(key=natural)

    tracks, bad = [], []
    for p in files:
        try:
            tracks.append(_probe(p))
        except Exception as e:                                   # noqa: BLE001
            bad.append({"name": p.name, "why": f"{type(e).__name__}: {e}"})

    notes: List[str] = []
    if tracks:
        rates = {t["samplerate"] for t in tracks}
        if len(rates) > 1:
            notes.append(f"Mixed sample rates in one folder ({', '.join(str(r) for r in sorted(rates))} Hz). "
                         "These were not captured in one pass and will not line up.")
        lens = [t["frames"] / max(1, t["samplerate"]) for t in tracks]
        if lens and (max(lens) - min(lens)) > 0.5:
            notes.append(f"Track lengths differ by {max(lens) - min(lens):.1f} s. That is normal if "
                         "the transfer was stopped per track, and a problem if it was meant to be one pass.")
        if any(t["channels"] > 1 for t in tracks) and any(t["channels"] == 1 for t in tracks):
            notes.append("Mono and stereo files mixed together. Check which is which before mixing.")
    return {"ok": True, "folder": str(d), "tracks": tracks, "unreadable": bad,
            "count": len(tracks), "notes": notes}


# ── analysis ──────────────────────────────────────────────────────────────────
def _load_mono(path: str, max_seconds: Optional[float] = None):
    """Mono plus the sample rate. Analysis only — repairs read the real channels.

    float32, deliberately. A whole reel side at 24-bit/96k is tens of minutes of stereo,
    and in float64 that is several gigabytes decoded before a single measurement happens —
    on a machine that may also be holding a 3B model on the graphics card. The source is
    24-bit, so float32's 24-bit mantissa loses nothing that was ever there, and every
    measurement here is a level, a ratio or a frequency rather than an accumulation where
    the extra precision would matter. The mean is taken in float64 to keep the channel sum
    exact, then brought back down.
    """
    import numpy as np
    import soundfile as sf
    with sf.SoundFile(str(path)) as f:
        sr = f.samplerate
        frames = int(max_seconds * sr) if max_seconds else -1
        data = f.read(frames=frames, dtype="float32", always_2d=True)
    mono = data.mean(axis=1, dtype="float64").astype("float32")
    return mono, sr, data


def _band_db(x, sr: int, lo: float, hi: float) -> float:
    """Energy in a band, in dB. Used for hiss and for the azimuth comparison."""
    import numpy as np
    n = min(len(x), 1 << 18)
    if n < 1024:
        return -120.0
    seg = x[:n] * np.hanning(n)
    spec = np.abs(np.fft.rfft(seg)) ** 2
    freqs = np.fft.rfftfreq(n, 1 / sr)
    sel = (freqs >= lo) & (freqs < hi)
    if not sel.any() or spec[sel].sum() <= 0:
        return -120.0
    return float(10 * np.log10(spec[sel].mean() + 1e-20))


def _hum(x, sr: int) -> Dict[str, Any]:
    """Mains hum: a narrow peak at 50 or 60 Hz standing above its own neighbourhood.

    Measured in the track's QUIETEST passage, not across the whole take. Hum runs for the
    length of the transfer, gaps included, which is exactly what makes it audible between
    numbers — and measuring it there is what stops a bass guitar being reported as hum.
    Against a test tape of pure tones the whole-take version flagged four clean tracks at
    60-70 dB "excess", because a bass note at 240 Hz is the fourth harmonic of 60.

    Compared against the band immediately around each harmonic rather than the whole
    spectrum, so a dull track does not read as humming.
    """
    import numpy as np
    # One second, not two: a tape leader or a count-in gap is often barely longer than
    # that, and asking for a wider window drags music into the measurement, which is the
    # one thing this is trying to avoid.
    a, b = _quietest_window(x, sr, seconds=1.0)
    quiet = x[a:b]
    quiet = quiet - np.mean(quiet)          # DC is not hum; subtracting it stops a bias
    n = len(quiet)
    if n < sr // 2:
        return {"present": False}
    # Digital silence has no hum in it, and dividing two near-zero spectra produces
    # confident nonsense: a test track whose leader is literal zeros reported 9.9 dB of
    # 60 Hz hum. Below about -80 dBFS there is nothing to measure.
    if float(np.sqrt(np.mean(quiet ** 2))) < 1e-4:
        return {"present": False}
    seg = quiet * np.hanning(n)
    spec = np.abs(np.fft.rfft(seg))
    freqs = np.fft.rfftfreq(n, 1 / sr)

    best = {"present": False, "excess_db": 0.0}
    for f0 in MAINS:
        peaks, floors, actual = [], [], []
        for k in range(1, 5):                                    # f0 and three harmonics
            f = f0 * k
            if f > sr / 2 - 20:
                break
            # Search a window rather than one bin, and record where the line REALLY sits.
            # Tape hum does not land on the exact series: the machine playing the tape runs
            # at a slightly different speed from the one that recorded it, so the whole
            # harmonic stack shifts by a few Hz. Notching 50/100/150 exactly then misses
            # it. Widening with k because the error is proportional to speed, not absolute.
            span = 1.5 + 0.02 * f
            near = (freqs > f - span) & (freqs < f + span)
            around = (((freqs > f - 12 - span) & (freqs < f - 3 - span))
                      | ((freqs > f + 3 + span) & (freqs < f + 12 + span)))
            if near.any() and around.any():
                idx = int(np.argmax(np.where(near, spec, 0)))
                peaks.append(float(spec[idx]))
                actual.append(float(freqs[idx]))
                floors.append(float(np.median(spec[around])) + 1e-12)
        if not peaks:
            continue
        mean_peak = sum(peaks) / len(peaks)
        mean_floor = sum(floors) / len(floors)
        if mean_peak <= 0 or mean_floor <= 0:
            continue              # a silent track has no peak and no floor, not a hum of -inf
        excess = 20 * math.log10(mean_peak / mean_floor)
        # Contrast alone is not enough. After a notch the residual at 60 Hz is 80 dB down
        # but still towers over the near-nothing around it, so the track kept reporting
        # "hum present" once it had been cleaned. Hum nobody can hear is not hum: it has to
        # clear an absolute level as well as stand out locally.
        level_dbfs = 20 * math.log10(mean_peak / (n / 2) + 1e-20)
        if level_dbfs < -65.0:
            continue
        if excess > best.get("excess_db", 0.0):
            best = {"present": excess > 14.0, "hz": f0, "excess_db": round(excess, 1),
                    "level_dbfs": round(level_dbfs, 1),
                    "harmonics": len(peaks),
                    # where the lines actually are, for the notch to aim at
                    "measured_hz": [round(a, 2) for a in actual],
                    "drift_hz": round(actual[0] - f0, 2) if actual else 0.0}
    return best


def _quietest_window(x, sr: int, seconds: float = 1.0):
    """The quietest second of the track — tape leader, a count-in gap, the run-out.

    This is where a noise print comes from, and it is also the honest place to measure the
    hiss floor: measuring "noise" over music measures the music.
    """
    import numpy as np
    w = max(1, int(seconds * sr))
    if len(x) <= w:
        return 0, len(x)
    step = max(1, w // 4)
    # The last window is included explicitly. range() stops short of len(x) - w, so the
    # final second of the file was never a candidate — and on a tape transfer the run-out
    # is exactly where the quiet is. Missing it meant a window half full of music, which
    # read as a noise floor 35 dB higher than the real one.
    starts = list(range(0, len(x) - w, step)) + [len(x) - w]
    best_i, best_v = 0, None
    for i in starts:
        v = float(np.sqrt(np.mean(x[i:i + w] ** 2)))
        if best_v is None or v < best_v:
            best_i, best_v = i, v
    return best_i, best_i + w


def _dropouts(x, sr: int) -> Dict[str, Any]:
    """Brief collapses in level while the track is otherwise playing — oxide shed, a
    crease, a dirty head. Distinct from an arrangement rest, which is why this only looks
    inside stretches that are loud either side."""
    import numpy as np
    win = max(1, int(0.02 * sr))
    n = (len(x) // win) * win
    if n < win * 50:
        return {"count": 0}
    env = np.sqrt((x[:n].reshape(-1, win) ** 2).mean(axis=1) + 1e-20)
    playing = env > np.median(env[env > 0]) * 0.25 if (env > 0).any() else env > 0
    if playing.sum() < 20:
        return {"count": 0}
    ref = float(np.median(env[playing]))
    holes = env < ref * 0.06                                     # 24 dB below the body
    runs, start = [], None
    for i, h in enumerate(holes):
        if h and start is None:
            start = i
        elif not h and start is not None:
            runs.append((start, i))
            start = None
    # Only holes punched into sustained sound. The surround window is 0.5 s either side,
    # not 0.2 s: with the short version, ordinary gated playing — anything staccato — read
    # as a dropout on every rest, 43 of them on one test track.
    span = max(5, int(0.5 / (win / sr)))
    found = []
    for a, b in runs:
        dur = (b - a) * win / sr
        # 10-150 ms. Musical rests are longer than this; shed oxide and a crease are not.
        # Allowing up to 500 ms made every staccato gap a "dropout", and switching the
        # surround test to a median to compensate then threw away the real ones.
        if not (0.01 <= dur <= 0.15):
            continue
        before = env[max(0, a - span):a]
        after = env[b:b + span]
        if (before.size and after.size
                and float(before.max()) > ref * 0.5
                and float(after.max()) > ref * 0.5):
            found.append({"at_s": round(a * win / sr, 2), "len_s": round(dur, 3)})

    # A tape fault is occasional. More than one "dropout" every two seconds is the rhythm
    # of the performance, and reporting it as damage would train the user to ignore this.
    seconds = n / sr
    if seconds > 0 and len(found) / seconds > 0.5:
        return {"count": 0, "suppressed": len(found),
                "why": "too regular to be tape damage — this is the playing"}
    return {"count": len(found), "worst": found[:6]}


def analyse_track(path: str) -> Dict[str, Any]:
    """Everything measurable about one transferred track."""
    import numpy as np

    mono, sr, data = _load_mono(path)
    out: Dict[str, Any] = {"name": Path(path).name, "samplerate": sr,
                           "seconds": round(len(mono) / sr, 2)}
    if not len(mono):
        out["silent"] = True
        return out

    peak = float(np.abs(data).max())
    rms = float(np.sqrt(np.mean(mono ** 2)))
    out["peak_dbfs"] = round(20 * math.log10(max(peak, 1e-9)), 2)
    out["rms_dbfs"] = round(20 * math.log10(max(rms, 1e-9)), 2)
    out["dc_offset"] = round(float(np.mean(mono)), 5)
    out["over_full_scale"] = int((np.abs(data) > 1.0).sum())
    out["clipped"] = int((np.abs(data) >= 0.999).sum())

    # an unused tape track: 8-track tapes routinely have two or three
    out["silent"] = bool(rms < 1e-4)

    a, b = _quietest_window(mono, sr)
    quiet = mono[a:b]
    # DC is reported separately and fixed separately; leaving it in here made a track with
    # a 0.035 offset read as a -29 dBFS "noise floor", which would send the user to the
    # hiss tool for a problem one subtraction solves.
    quiet = quiet - float(np.mean(quiet))
    out["noise_window"] = {"start_s": round(a / sr, 2), "end_s": round(b / sr, 2)}
    out["noise_rms_dbfs"] = round(20 * math.log10(max(float(np.sqrt(np.mean(quiet ** 2))), 1e-9)), 1)
    # hiss is the HF part of that noise; 4 kHz up is where tape hiss lives
    out["hiss_dbfs"] = round(_band_db(quiet, sr, 4000, min(16000, sr / 2 - 1)) / 2, 1)
    out["hum"] = _hum(mono, sr)
    out["dropouts"] = _dropouts(mono, sr)
    out["clicks"] = _clicks(mono, sr)
    # for the azimuth comparison across tracks
    out["hf_db"] = round(_band_db(mono, sr, 6000, min(14000, sr / 2 - 1)), 1)
    out["mid_db"] = round(_band_db(mono, sr, 300, 3000), 1)
    out["hf_ratio"] = round(out["hf_db"] - out["mid_db"], 1)
    return out


# ── session-level checks ──────────────────────────────────────────────────────
def _align_offset(ref, other, sr: int, max_shift_s: float = 2.0) -> Dict[str, Any]:
    """How far `other` sits from `ref`, by cross-correlation.

    The thing this catches is a transfer done in several passes. Tape does not start in the
    same place twice, so tracks captured separately land tens of milliseconds apart and no
    amount of mixing makes them sound like one performance again.
    """
    import numpy as np

    n = min(len(ref), len(other), sr * 60)
    if n < sr * 2:
        return {"offset_ms": 0.0, "confidence": 0.0}
    a = ref[:n] - np.mean(ref[:n])
    b = other[:n] - np.mean(other[:n])
    if not np.any(a) or not np.any(b):
        return {"offset_ms": 0.0, "confidence": 0.0}
    # Envelope correlation, not sample correlation: a bass track and a vocal track do not
    # correlate sample by sample, but they do share the performance's rhythm.
    w = max(1, sr // 200)
    ea = np.sqrt((a[:(len(a) // w) * w].reshape(-1, w) ** 2).mean(axis=1))
    eb = np.sqrt((b[:(len(b) // w) * w].reshape(-1, w) ** 2).mean(axis=1))
    ea = ea - ea.mean()
    eb = eb - eb.mean()
    if not np.any(ea) or not np.any(eb):
        return {"offset_ms": 0.0, "confidence": 0.0}
    lim = int(max_shift_s * sr / w)
    corr = np.correlate(ea, eb, mode="full")
    mid = len(eb) - 1
    lo, hi = max(0, mid - lim), min(len(corr), mid + lim + 1)
    seg = corr[lo:hi]
    if not seg.size:
        return {"offset_ms": 0.0, "confidence": 0.0}
    k = int(np.argmax(seg)) + lo - mid
    denom = float(np.sqrt(np.sum(ea ** 2) * np.sum(eb ** 2))) or 1.0
    return {"offset_ms": round(k * w / sr * 1000, 1),
            "confidence": round(float(seg.max()) / denom, 3)}


def check(folder: str) -> Dict[str, Any]:
    """Analyse every track in a tape session and report what is wrong with the transfer."""
    import numpy as np

    listing = scan(folder)
    if not listing["ok"]:
        return {"ok": False, "error": listing["error"], "findings": []}
    if not listing["tracks"]:
        return {"ok": False, "error": f"No audio files in {folder}.", "findings": []}

    tracks = [analyse_track(t["path"]) for t in listing["tracks"]]
    findings: List[Dict[str, Any]] = []

    def add(sev, title, detail, fix, where="", **numbers):
        findings.append({"severity": sev, "title": title, "detail": detail,
                         "fix": fix, "where": where, "numbers": numbers})

    live = [t for t in tracks if not t.get("silent")]
    silent = [t["name"] for t in tracks if t.get("silent")]
    if silent:
        add("note", f"{len(silent)} track(s) carry no signal",
            ", ".join(silent) + ". Unused tape tracks are completely normal — worth a glance "
            "to be sure you did not mis-patch a machine output.",
            "Leave them out of the session, or re-check the outputs and transfer again.")

    for t in live:
        hum = t.get("hum") or {}
        if hum.get("present"):
            add("high" if hum["excess_db"] > 18 else "medium",
                f"{t['name']}: {hum['hz']:.0f} Hz hum at {hum.get('level_dbfs', 0)} dBFS",
                f"A narrow peak at {hum['hz']:.0f} Hz with {hum.get('harmonics', 0)} harmonic(s), "
                f"standing {hum['excess_db']} dB above the noise either side of it. "
                "That is mains hum picked up in the transfer chain, not something on the tape.",
                "Remove hum on this track. Better still, find the earth loop and transfer it "
                "again: a notch always takes a little music with it.",
                "Tape → Clean up", hz=hum["hz"], excess_db=hum["excess_db"])

        if abs(t.get("dc_offset", 0)) > 0.002:
            add("medium", f"{t['name']}: DC offset of {t['dc_offset']:+.4f}",
                "The waveform does not sit on zero. It costs headroom and makes every edit click.",
                "Remove DC offset on this track.", "Tape → Clean up", dc=t["dc_offset"])

        drop = t.get("dropouts") or {}
        if drop.get("count"):
            worst = drop.get("worst") or []
            add("high" if drop["count"] > 4 else "medium",
                f"{t['name']}: {drop['count']} dropout(s)",
                "Brief collapses in level while the track is otherwise playing — shed oxide, a "
                "crease, or a dirty head."
                + (f" Worst at {worst[0]['at_s']}s." if worst else ""),
                "Clean the heads and transfer again. A dropout is missing signal and no plugin "
                "puts it back; if the tape will not survive another pass, patch it from a repeat.",
                "", count=drop["count"])

        clk = t.get("clicks") or {}
        if clk.get("count"):
            worst = clk.get("worst") or []
            add("medium" if clk["count"] < 40 else "high",
                f"{t['name']}: {clk['count']} click(s)",
                "Sample-scale breaks in the waveform — a splice, a dirty connector, or a "
                "converter that dropped samples. Unlike a dropout these are repairable: "
                "the audio either side is intact, so the gap can be modelled and filled."
                + (f" Loudest at {worst[0]['at_s']}s." if worst else ""),
                "Repair clicks on this track.", "Tape → Clean up", count=clk["count"])

        if t.get("over_full_scale", 0) > 50:
            add("high", f"{t['name']}: {t['over_full_scale']:,} samples over full scale",
                "The transfer clipped on the way in. This is the cheapest fault to fix properly, "
                "because the tape itself is almost certainly fine.",
                "Lower the interface input and transfer this track again. Aim for peaks near "
                "-12 dBFS: tape has nothing like digital's hard ceiling, so there is no reason "
                "to run it hot.",
                "", over=t["over_full_scale"])

        if t.get("clipped", 0) > 200 and t.get("over_full_scale", 0) <= 50:
            add("medium", f"{t['name']}: {t['clipped']:,} samples pinned at full scale",
                "Flat-topped peaks: the transfer hit the converter's ceiling and the tops of "
                "the waveform were cut off. The tape still has them.",
                "Transfer this track again a few dB lower if you can. If the tape is gone, "
                "rebuild the peaks — the shape is guessed from the audio either side, which "
                "is better than a flat top but is not the original.",
                "Tape → Clean up", clipped=t["clipped"])

        if t.get("noise_rms_dbfs", -99) > -48:
            win = t.get("noise_window") or {}
            add("medium", f"{t['name']}: noise floor at {t['noise_rms_dbfs']} dBFS",
                f"Measured across the quietest second ({win.get('start_s')}s to "
                f"{win.get('end_s')}s), so this is the tape and the chain rather than the music.",
                "Learn a noise print from that window and subtract it.",
                "Tape → Clean up", floor=t["noise_rms_dbfs"])

    # Azimuth: one track much duller than its siblings is usually head alignment, not taste.
    if len(live) >= 3:
        med = float(np.median([t["hf_ratio"] for t in live]))
        for t in live:
            if t["hf_ratio"] < med - 9:
                add("medium",
                    f"{t['name']} is {med - t['hf_ratio']:.0f} dB duller than the other tracks",
                    "Its top end sits well below the rest of the reel. Across one tape that "
                    "usually means the head azimuth was off for this track, not that the part "
                    "was recorded dark.",
                    "Azimuth is mechanical: nudge the playback head for the brightest top end "
                    "and transfer again. EQ afterwards buys back level, not the lost detail.",
                    "", hf_ratio=t["hf_ratio"], median=round(med, 1))

    # Alignment: the check that tells you whether this was really one pass.
    if len(live) >= 2:
        paths = {p["name"]: p["path"] for p in listing["tracks"]}
        ref_name = max(live, key=lambda t: t.get("rms_dbfs", -99))["name"]
        ref, sr, _ = _load_mono(paths[ref_name], max_seconds=60)
        drifted = []
        for t in live:
            if t["name"] == ref_name:
                continue
            other, osr, _ = _load_mono(paths[t["name"]], max_seconds=60)
            if osr != sr:
                continue
            r = _align_offset(ref, other, sr)
            if abs(r["offset_ms"]) >= 15 and r["confidence"] > 0.25:
                drifted.append((t["name"], r["offset_ms"]))
        if drifted:
            add("high", f"{len(drifted)} track(s) do not line up with {ref_name}",
                "; ".join(f"{n} is {o:+.0f} ms out" for n, o in drifted[:5])
                + ". Tracks captured in one pass share the tape's timing exactly, so offsets "
                "this size mean they were captured separately.",
                "Re-transfer every track in ONE pass if the machine has the outputs for it. If "
                "it does not, nudge each track by the offset above: that fixes the start, but "
                "tape speed wanders, so a long take will drift apart again anyway.",
                "Studio → per-track offset", tracks=len(drifted))

    order = {"high": 0, "medium": 1, "note": 2}
    findings.sort(key=lambda f: order.get(f["severity"], 3))
    return {"ok": True, "folder": listing["folder"], "tracks": tracks,
            "findings": findings, "notes": listing["notes"],
            "clean": not any(f["severity"] in ("high", "medium") for f in findings)}


# ── repairs ───────────────────────────────────────────────────────────────────
# Every repair writes a NEW file beside the original and returns its path. The transfer is
# the preservation master: the tape may not survive another pass, so nothing here opens an
# original for writing, and scan() skips anything carrying REPAIR_SUFFIX so a cleaned file
# is never offered for cleaning again.

def repaired_path(src: Path) -> Path:
    """<name>.wp-clean.wav beside the original, numbered if that already exists."""
    base = src.with_suffix("")
    out = Path(f"{base}{REPAIR_SUFFIX}.wav")
    n = 2
    while out.exists():
        out = Path(f"{base}{REPAIR_SUFFIX}-{n}.wav")
        n += 1
    return out


def _notch_at(data, sr: int, freqs: List[float], q: float = 35.0):
    """Notch each frequency given, forwards and backwards.

    Takes measured frequencies rather than a fundamental, because the harmonics of tape
    hum are not where arithmetic says they are: playback speed differs from record speed,
    so the whole stack slides a few Hz and a textbook 50/100/150 notch cuts music while
    leaving the hum alone.
    """
    import numpy as np
    from scipy import signal

    out = np.array(data, dtype="float64", copy=True)
    done = []
    for f in freqs:
        if not (5.0 < f < sr / 2 - 10):
            continue
        b, a = signal.iirnotch(f / (sr / 2), q)
        for ch in range(out.shape[1]):
            out[:, ch] = signal.filtfilt(b, a, out[:, ch])
        done.append(round(f, 2))
    return out, done


def _notch(data, sr: int, f0: float, harmonics: int = 4, q: float = 35.0):
    """IIR notches at f0 and its harmonics, applied forwards and backwards.

    filtfilt rather than lfilter because a notch has a steep phase twist around the stop
    band; running it both ways cancels that, which matters when the track has to sit
    phase-coherent against the others from the same tape.
    """
    import numpy as np
    from scipy import signal

    out = np.array(data, dtype="float64", copy=True)
    done = []
    for k in range(1, harmonics + 1):
        f = f0 * k
        if f >= sr / 2 - 10:
            break
        b, a = signal.iirnotch(f / (sr / 2), q)
        for ch in range(out.shape[1]):
            out[:, ch] = signal.filtfilt(b, a, out[:, ch])
        done.append(round(f, 1))
    return out, done


def _spectral_subtract(data, sr: int, noise, strength: float = 1.0):
    """Classic spectral subtraction against a noise print taken from the track itself.

    Gentle on purpose. Hiss removal is the effect most likely to ruin a transfer: push it
    and cymbals turn to chirping artefacts, and on a 40-year-old demo that is worse than the
    hiss, which at least sounds like tape. The floor keeps 10% of the original magnitude
    rather than subtracting to zero, which is what stops the warble.
    """
    import numpy as np

    n_fft = 2048
    hop = n_fft // 4
    win = np.hanning(n_fft).astype("float64")

    # average magnitude spectrum of the noise print
    prof = np.zeros(n_fft // 2 + 1)
    frames = 0
    for i in range(0, max(1, len(noise) - n_fft), hop):
        seg = noise[i:i + n_fft]
        if len(seg) < n_fft:
            break
        prof += np.abs(np.fft.rfft(seg * win))
        frames += 1
    if frames == 0:
        return np.array(data, copy=True)
    prof /= frames

    out = np.zeros_like(data, dtype="float64")
    for ch in range(data.shape[1]):
        x = data[:, ch]
        y = np.zeros(len(x) + n_fft)
        wsum = np.zeros(len(x) + n_fft)
        for i in range(0, len(x), hop):
            seg = np.zeros(n_fft)
            piece = x[i:i + n_fft]
            seg[:len(piece)] = piece
            spec = np.fft.rfft(seg * win)
            mag = np.abs(spec)
            reduced = np.maximum(mag - strength * prof, 0.1 * mag)
            rec = np.fft.irfft(reduced * np.exp(1j * np.angle(spec)), n_fft)
            y[i:i + n_fft] += rec * win
            wsum[i:i + n_fft] += win ** 2
        # Clamp the window-sum before dividing. At the first and last frame only part of
        # the window has been accumulated, so wsum there is a small fraction of its steady
        # value; dividing by it multiplies the edges by hundreds. With a 1e-9 floor the
        # result peaked at ~84.0 and the "stay under full scale" guard then pulled the
        # whole track down 38 dB, which destroyed the music and left a clean, quiet ruin.
        steady = float(np.max(wsum)) if wsum.size else 1.0
        wsum[wsum < steady * 1e-3] = steady
        out[:, ch] = (y / wsum)[:len(x)]
    return out


def clean(path: str, *, hum: bool = False, hum_hz: float = 0.0, dc: bool = False,
          hiss: bool = False, hiss_strength: float = 1.0,
          noise_start: Optional[float] = None, noise_end: Optional[float] = None,
          ) -> Dict[str, Any]:
    """Apply the requested repairs to one track and write a new file beside it."""
    import numpy as np
    import soundfile as sf

    src = Path(path)
    if not src.is_file():
        return {"ok": False, "error": f"{src.name} is not a file."}

    data, sr = sf.read(str(src), dtype="float64", always_2d=True)
    original = data
    applied: List[str] = []

    if dc:
        offsets = data.mean(axis=0)
        data = data - offsets
        applied.append(f"removed DC offset ({', '.join(f'{o:+.4f}' for o in offsets)})")

    if hum:
        found = _hum(data.mean(axis=1), sr) or {}
        measured = found.get("measured_hz") or []
        if hum_hz:                                   # the user overrode the mains frequency
            measured = [hum_hz * k for k in range(1, 5)]
        if not measured:
            measured = [(found.get("hz") or 50.0) * k for k in range(1, 5)]
        data, done = _notch_at(data, sr, [float(f) for f in measured])
        drift = found.get("drift_hz", 0.0)
        applied.append(
            f"notched {len(done)} line(s) at {', '.join(f'{d:g}' for d in done)} Hz"
            + (f" (the stack sits {drift:+.2f} Hz off the textbook series)"
               if abs(drift) >= 0.2 else ""))

    if hiss:
        mono = data.mean(axis=1)
        if noise_start is None or noise_end is None:
            a, b = _quietest_window(mono, sr)
        else:
            a, b = int(noise_start * sr), int(noise_end * sr)
        a = max(0, min(a, len(mono) - 1))
        b = max(a + sr // 4, min(b, len(mono)))
        data = _spectral_subtract(data, sr, mono[a:b], float(hiss_strength))
        applied.append(f"subtracted a noise print taken from {a / sr:.2f}s to {b / sr:.2f}s")

    if not applied:
        return {"ok": False, "error": "Nothing was selected to clean."}

    peak = float(np.abs(data).max())
    if peak > 1.0:                       # notches can lift a peak slightly; never clip
        data = data / peak * 0.999
        applied.append(f"scaled by {20 * math.log10(0.999 / peak):.2f} dB to stay under full scale")

    out = repaired_path(src)
    # 24-bit: this is archival work and the source is usually 24-bit already
    sf.write(str(out), data, sr, subtype="PCM_24")

    before = float(np.sqrt(np.mean(original.mean(axis=1) ** 2)))
    after = float(np.sqrt(np.mean(data.mean(axis=1) ** 2)))
    _write_sidecar(out, src, applied, tool="clean")
    return {
        "ok": True,
        "source": str(src),
        "output": str(out),
        "name": out.name,
        "applied": applied,
        "rms_before_dbfs": round(20 * math.log10(max(before, 1e-9)), 2),
        "rms_after_dbfs": round(20 * math.log10(max(after, 1e-9)), 2),
        "seconds": round(len(data) / sr, 2),
        "note": "Your original file was not touched.",
    }


# ── speed and flutter, measured against the hum line ──────────────────────────
# The best idea in the prior art, and it is a lovely one: mains hum is a physical
# constant. It left the wall at exactly 50 or 60 Hz, so anywhere the recovered hum is NOT
# at 50 or 60, the tape is running at the wrong speed. Track that frequency over time and
# you have measured the speed error second by second — which is absolute speed error plus
# wow and flutter, the thing otherwise written off as uncorrectable.
#
# It only works when there is hum on the tape. That used to be a fault; here it is the
# reference signal, which is why Tape Check reports the hum level even on tracks nobody
# wants to clean.

def hum_speed_curve(path: str, mains: Optional[float] = None,
                    window_s: float = 0.5) -> Dict[str, Any]:
    """Measure tape speed over time from the hum line.

    Returns the ratio of measured hum frequency to nominal, per window. 1.0 means correct
    speed; 1.02 means the tape is running 2% fast and everything is 2% sharp.
    """
    import numpy as np

    mono, sr, _ = _load_mono(path)
    if len(mono) < sr:
        return {"ok": False, "error": "Track is too short to measure."}

    found = _hum(mono, sr)
    f0 = mains or found.get("hz")
    if not f0:
        return {"ok": False,
                "error": "No mains hum found on this track, so there is no speed "
                         "reference to measure against. This only works on transfers that "
                         "picked up hum."}

    n = int(window_s * sr)
    hop = n // 2
    times, ratios, strengths = [], [], []
    # zero-pad heavily: we need to resolve a fraction of a Hz around 50/60
    nfft = 1 << int(math.ceil(math.log2(max(n * 8, 1 << 15))))
    win = np.hanning(n)
    for i in range(0, max(1, len(mono) - n), hop):
        seg = mono[i:i + n]
        if len(seg) < n:
            break
        spec = np.abs(np.fft.rfft((seg - seg.mean()) * win, nfft))
        freqs = np.fft.rfftfreq(nfft, 1 / sr)
        band = (freqs > f0 * 0.90) & (freqs < f0 * 1.10)
        if not band.any():
            break
        sub = np.where(band, spec, 0.0)
        k = int(np.argmax(sub))
        if sub[k] <= 0:
            continue
        # parabolic interpolation around the peak: the bin spacing is still coarser than
        # the drift we are chasing, and the true peak lies between bins
        if 0 < k < len(spec) - 1:
            a_, b_, c_ = spec[k - 1], spec[k], spec[k + 1]
            denom = (a_ - 2 * b_ + c_)
            delta = 0.5 * (a_ - c_) / denom if denom else 0.0
        else:
            delta = 0.0
        f_meas = (k + float(np.clip(delta, -1, 1))) * sr / nfft
        local = float(np.median(spec[band])) + 1e-20
        # The CENTRE of the window, not its start. The frequency measured here is the
        # average across the whole window, so stamping it with the start time shifts the
        # whole speed curve by half a window. With 0.5 s windows against a 0.7 Hz wow that
        # is 63 degrees of phase error, and correcting with a curve that far out of step
        # removed 3% of the wobble instead of all of it — the amplitude and the frequency
        # both looked right, which is what made it hard to see.
        times.append((i + n / 2) / sr)
        ratios.append(f_meas / f0)
        strengths.append(float(sub[k]) / local)

    if len(ratios) < 4:
        return {"ok": False, "error": "Could not follow the hum line for long enough."}

    r = np.asarray(ratios)
    s = np.asarray(strengths)
    # windows where the hum was buried are guesses; drop them rather than let them steer
    good = s > np.median(s) * 0.4
    if good.sum() >= 4:
        r = r[good]
        t_used = np.asarray(times)[good]
    else:
        t_used = np.asarray(times)

    median = float(np.median(r))
    return {
        "ok": True,
        "mains_hz": f0,
        "windows": int(len(r)),
        "speed_ratio": round(median, 5),
        "speed_error_pct": round((median - 1.0) * 100, 3),
        "semitones": round(12 * math.log2(median), 3),
        "flutter_pct": round(float(np.std(r)) * 100, 3),
        "worst_swing_pct": round(float(r.max() - r.min()) * 100, 3),
        "times": [round(float(x), 2) for x in t_used[:400]],
        "ratios": [round(float(x), 5) for x in r[:400]],
    }


def _resample_to(x, factor: float):
    """Resample by a ratio with linear interpolation.

    Linear rather than sinc because this is applied per short window to undo wow, and the
    correction factors are within a per cent of 1.0, where the interpolation error sits far
    below tape noise. A whole-file speed change uses the server's existing time-stretch
    instead, which is properly band-limited.
    """
    import numpy as np
    n_out = int(round(len(x) * factor))
    if n_out < 2:
        return x[:0]
    src = np.linspace(0, len(x) - 1, n_out)
    return np.interp(src, np.arange(len(x)), x)


def fix_speed(path: str, *, mains: Optional[float] = None, flutter: bool = True,
              absolute: bool = True) -> Dict[str, Any]:
    """Correct speed, and optionally wow and flutter, using the hum line as the reference.

    `absolute` pulls the whole track back to true pitch. `flutter` additionally straightens
    the wobble within it, by resampling each window by its own measured error.
    """
    import numpy as np
    import soundfile as sf

    curve = hum_speed_curve(path, mains=mains)
    if not curve.get("ok"):
        return curve

    src = Path(path)
    data, sr = sf.read(str(src), dtype="float64", always_2d=True)
    applied: List[str] = []

    if flutter and curve["flutter_pct"] > 0.05:
        times = np.asarray(curve["times"])
        ratios = np.asarray(curve["ratios"])
        # per-sample correction, smoothed: a step in the resample factor is an audible click
        pos = np.arange(len(data)) / sr
        local = np.interp(pos, times, ratios, left=ratios[0], right=ratios[-1])
        k = max(1, int(0.25 * sr))
        local = np.convolve(local, np.ones(k) / k, mode="same")
        local[:k] = local[k]
        local[-k:] = local[-k - 1]
        # Build an explicit time map rather than stepping a cursor.
        #
        # Stepping failed because the step size was indexed by OUTPUT sample while the
        # measured error is a function of INPUT time; the two only agree when there is no
        # wobble, which is the case this is for. Speed came out right and flutter barely
        # moved (0.270% to 0.253%).
        #
        # Instead: a stretch of tape that ran fast is compressed, so it must occupy more
        # output time. Integrating the local error over input time gives exactly that
        # mapping, and inverting it says where to read for each uniform output sample.
        median_ratio = float(np.median(ratios))
        rate = np.clip(local / median_ratio, 0.8, 1.25)   # wobble only; absolute is below
        out_time = np.cumsum(rate) / sr                   # output time of each input sample
        out_time -= out_time[0]
        in_time = np.arange(len(data)) / sr
        grid = np.arange(0.0, out_time[-1], 1.0 / sr)     # uniform output
        read_at = np.interp(grid, out_time, in_time)      # where to read in the source
        out = np.zeros((len(grid), data.shape[1]))
        for ch in range(data.shape[1]):
            out[:, ch] = np.interp(read_at, in_time, data[:, ch])
        data = out
        applied.append(f"straightened {curve['flutter_pct']:.3f}% flutter "
                       f"(worst swing {curve['worst_swing_pct']:.2f}%)")

    if absolute and abs(curve["speed_error_pct"]) > 0.05:
        factor = curve["speed_ratio"]
        data = np.stack([_resample_to(data[:, c], factor) for c in range(data.shape[1])], axis=1)
        applied.append(f"corrected {curve['speed_error_pct']:+.3f}% speed error "
                       f"({curve['semitones']:+.3f} semitones)")

    if not applied:
        return {"ok": True, "unchanged": True,
                "note": f"Speed is within 0.05% and flutter is {curve['flutter_pct']:.3f}%. "
                        "Nothing worth correcting.",
                "curve": curve}

    peak = float(np.abs(data).max())
    if peak > 1.0:
        data = data / peak * 0.999
    out_path = repaired_path(src)
    sf.write(str(out_path), data, sr, subtype="PCM_24")
    _write_sidecar(out_path, src, applied, tool="speed")
    return {"ok": True, "source": str(src), "output": str(out_path), "name": out_path.name,
            "applied": applied, "curve": curve,
            "seconds": round(len(data) / sr, 2),
            "note": "Your original file was not touched."}


# ── clicks and crackle ────────────────────────────────────────────────────────
# A click is a discontinuity: the waveform jumps and comes straight back. A drum hit is a
# steep RAMP, which is why the test is the width of the jump and not its height — the
# loudest snare in the session has a bigger second difference than a quiet click does.

def _clicks(x, sr: int, *, min_jump: float = 1e-3, isolation: float = 25.0,
            max_width: int = 6, rel: float = 0.05) -> Dict[str, Any]:
    """Isolated sample-scale breaks in the waveform — splice clicks, dropped samples, crackle.

    The hard part is not finding jumps, it is not reporting drums. A snare attack has a
    second difference as large as a click's, so amplitude cannot tell them apart: a plain
    "bigger than its surroundings" test returned 520 clicks on one real song and not one of
    them was a click.

    Shape can tell them apart. A click is a break in the curve — over in two or three
    samples, with smooth audio either side. A drum attack is a steep but continuous event
    that stays rough for milliseconds. So the test is isolation: the spike must tower over
    the 2 ms around it. Measured across six real songs, a ratio of 25 gives no false
    positives at all, and on single instrument tracks — which is what comes off a
    multitrack tape — it finds 12 of 12 injected clicks down to -30 dBFS.

    The one case it misses is a track with heavy hiss, where the noise keeps the
    neighbourhood rough and nothing can tower over it. Subtract the hiss first and the
    clicks appear.
    """
    import numpy as np

    if len(x) < sr:
        return {"count": 0}
    d = np.abs(np.diff(np.asarray(x, dtype="float64"), n=2))
    n = len(d)
    if n < sr // 2:
        return {"count": 0}

    # Mean level of |second difference| over the 2 ms around each sample, excluding the
    # three samples at the middle so a click cannot raise its own context. Cumulative sums
    # rather than a sliding window: this runs over every sample of every track in a
    # session, and a Python loop over 11 million samples is not a thing anyone will wait for.
    ctx = max(8, int(0.002 * sr))
    csum = np.concatenate(([0.0], np.cumsum(d)))
    i = np.arange(n)
    lo, hi = np.maximum(i - ctx, 0), np.minimum(i + ctx + 1, n)
    lo2, hi2 = np.maximum(i - 1, 0), np.minimum(i + 2, n)
    around = np.maximum(hi - lo - (hi2 - lo2), 1)
    ctx_mean = ((csum[hi] - csum[lo]) - (csum[hi2] - csum[lo2])) / around
    ratio = d / np.maximum(ctx_mean, 1e-12)

    hot = (d > min_jump) & (ratio > isolation)
    if not hot.any():
        return {"count": 0}
    idx = np.flatnonzero(hot)
    splits = np.flatnonzero(np.diff(idx) > 2)
    starts = np.concatenate(([idx[0]], idx[splits + 1]))
    ends = np.concatenate((idx[splits], [idx[-1]]))

    ax = np.abs(np.asarray(x, dtype="float64"))
    seconds = len(x) / sr
    found = []
    for a, b in zip(starts, ends):
        if b - a + 1 > max_width:        # wider than ~0.1 ms: an event, not a break
            continue
        jump = float(d[a:b + 1].max())
        near = ax[max(0, a - 400):b + 400]
        # Nobody hears a break 26 dB below what is playing beside it, and chasing those
        # fills the panel with repairs not worth making.
        if near.size and jump < rel * float(near.max()):
            continue
        found.append({"at_s": round(float(a) / sr, 3), "jump": round(jump, 5),
                      "isolation": round(float(ratio[a:b + 1].max()), 1)})

    # Same honesty rule as dropouts: a fault is occasional. Reporting the performance as
    # damage would teach the user to ignore this panel.
    if seconds > 0 and len(found) / seconds > 2.0:
        return {"count": 0, "suppressed": len(found),
                "why": "too dense to be clicks — this is the recording's own texture"}
    found.sort(key=lambda f: -f["jump"])
    return {"count": len(found), "worst": found[:6],
            "per_minute": round(len(found) / max(seconds / 60, 1e-6), 1)}


def _ffmpeg() -> str:
    import shutil
    exe = shutil.which("ffmpeg")
    if not exe:
        raise RuntimeError("ffmpeg is not installed or not on PATH.")
    return exe


def declick(path: str, *, clicks: bool = True, clips: bool = False,
            window_ms: float = 55.0, threshold: float = 10.0) -> Dict[str, Any]:
    """Repair clicks and rebuild clipped peaks, with ffmpeg's adeclick / adeclip.

    Not hand-rolled. Both filters fit an autoregressive model to the audio either side of
    the damage and interpolate across it, which is the right algorithm and a fiddly one to
    get right; ffmpeg's has been in use for years and is already a dependency here.

    Three things are worth adding. The first is overlap-SAVE rather than overlap-add
    (`m=s`). With overlap-add, which is what every example on the internet uses, the filter
    alters every sample slightly whether it found damage there or not: measured here it
    moved an undamaged file by a flat -44 dBFS no matter what the threshold was, because
    the alteration had nothing to do with click detection at all. Overlap-save leaves
    uninterpolated samples exactly as they were, which took the same measurement to
    -95 dBFS. On archival work that difference is the whole argument.

    The second is a sane threshold: ffmpeg's default of 2 altered an undamaged dense mix by
    -49 dBFS, where 10 altered it by -95 dBFS and repaired a damaged tape track slightly
    better besides. The third is headroom —
    rebuilding a clipped peak puts the peak back ABOVE full scale, so writing straight to
    24-bit integer clips it off again and the repair does nothing. ffmpeg therefore renders
    to float here, and the level is brought down afterwards by exactly the overshoot.
    """
    import numpy as np
    import soundfile as sf
    import subprocess

    src = Path(path)
    if not src.is_file():
        return {"ok": False, "error": f"{src.name} is not a file."}
    if not clicks and not clips:
        return {"ok": False, "error": "Nothing was selected to repair."}

    chain = []
    if clicks:
        chain.append(f"adeclick=w={window_ms:g}:o=75:a=2:t={threshold:g}:b=2:m=s")
    if clips:
        # arorder 8: a clipped peak is a long flat top rather than a spike, so the model
        # needs more history to guess the shape that was cut off.
        chain.append("adeclip=w=55:o=75:a=8:t=10:n=1000:m=s")

    out = repaired_path(src)
    tmp = out.with_suffix(".f32.wav")
    try:
        exe = _ffmpeg()
    except RuntimeError as e:
        return {"ok": False, "error": str(e)}
    cmd = [exe, "-y", "-hide_banner", "-loglevel", "error", "-i", str(src),
           "-af", ",".join(chain), "-c:a", "pcm_f32le", str(tmp)]
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0 or not tmp.exists():
        tmp.unlink(missing_ok=True)
        return {"ok": False,
                "error": f"ffmpeg could not process this file: {proc.stderr.strip()[-300:]}"}

    try:
        before, sr = sf.read(str(src), dtype="float64", always_2d=True)
        after, _ = sf.read(str(tmp), dtype="float64", always_2d=True)
    finally:
        pass

    applied = []
    if clicks:
        applied.append("repaired clicks (ffmpeg adeclick, autoregressive interpolation)")
    if clips:
        applied.append("rebuilt clipped peaks (ffmpeg adeclip)")

    peak = float(np.abs(after).max()) if after.size else 0.0
    if peak > 1.0:
        after = after / peak * 0.999
        applied.append(f"brought the level down {20 * math.log10(0.999 / peak):.2f} dB to fit "
                       f"the rebuilt peaks, which reached {20 * math.log10(peak):+.2f} dBFS")
    sf.write(str(out), after, sr, subtype="PCM_24")
    tmp.unlink(missing_ok=True)

    n = min(len(before), len(after))
    diff = np.abs(before[:n].mean(axis=1) - after[:n].mean(axis=1))
    touched = diff > 1e-4
    regions = 0
    if touched.any():
        regions = int(1 + np.count_nonzero(np.diff(touched.astype(np.int8)) == 1))
    applied.append(f"{regions} region(s) changed, {float(touched.sum()) / sr * 1000:.0f} ms "
                   f"of audio in total")

    _write_sidecar(out, src, applied, tool="declick")
    return {
        "ok": True, "source": str(src), "output": str(out), "name": out.name,
        "applied": applied, "regions": regions,
        "changed_ms": round(float(touched.sum()) / sr * 1000, 1),
        "largest_change": round(float(diff.max()) if diff.size else 0.0, 5),
        "seconds": round(len(after) / sr, 2),
        "note": "Your original file was not touched.",
    }


# ── preservation manifest ─────────────────────────────────────────────────────
# "Preserve the tracks" is half the job and it is not an audio problem. A transfer is only
# a preservation master if you can still prove, years later, that the file you have is the
# file that came off the tape.
#
# The checksum therefore covers the AUDIO ONLY, not the whole file. This is the trick BWF
# MetaEdit uses and the reason it is worth copying: metadata gets added for the rest of the
# file's life — titles, dates, a coding history, whatever the next archivist's system
# wants — and every one of those edits changes a whole-file hash while changing no audio at
# all. A hash over the data chunk alone stays valid through all of it, so a mismatch means
# something real.

def _wav_data_span(fh) -> Optional[tuple]:
    """(offset, length) of the RIFF 'data' chunk payload."""
    import struct
    fh.seek(0)
    head = fh.read(12)
    if len(head) < 12 or head[0:4] not in (b"RIFF", b"RF64") or head[8:12] != b"WAVE":
        return None
    pos = 12
    while True:
        fh.seek(pos)
        hdr = fh.read(8)
        if len(hdr) < 8:
            return None
        cid, size = hdr[0:4], struct.unpack("<I", hdr[4:8])[0]
        if cid == b"data":
            return pos + 8, size
        pos += 8 + size + (size & 1)


def _aiff_data_span(fh) -> Optional[tuple]:
    import struct
    fh.seek(0)
    head = fh.read(12)
    if len(head) < 12 or head[0:4] != b"FORM" or head[8:12] not in (b"AIFF", b"AIFC"):
        return None
    pos = 12
    while True:
        fh.seek(pos)
        hdr = fh.read(8)
        if len(hdr) < 8:
            return None
        cid, size = hdr[0:4], struct.unpack(">I", hdr[4:8])[0]
        if cid == b"SSND":
            # 8 bytes of offset/blockSize come before the samples
            return pos + 16, max(0, size - 8)
        pos += 8 + size + (size & 1)


def audio_md5(path: str) -> Dict[str, Any]:
    """MD5 of the audio samples alone, where the format allows it.

    FLAC is the happy case: the format already stores an MD5 of the unencoded audio in its
    STREAMINFO block, computed when the file was made, so this reads the encoder's own
    answer rather than a second opinion.
    """
    import hashlib
    import struct

    p = Path(path)
    ext = p.suffix.lower()
    h = hashlib.md5()

    if ext == ".flac":
        with open(p, "rb") as fh:
            if fh.read(4) == b"fLaC":
                blk = fh.read(4)
                if len(blk) == 4 and (blk[0] & 0x7F) == 0:      # STREAMINFO
                    info = fh.read(34)
                    if len(info) == 34:
                        return {"md5": info[18:34].hex(), "scope": "audio samples",
                                "how": "the MD5 the FLAC encoder stored in STREAMINFO"}

    span = None
    if ext in (".wav", ".wave", ".bwf"):
        with open(p, "rb") as fh:
            span = _wav_data_span(fh)
    elif ext in (".aiff", ".aif", ".aifc"):
        with open(p, "rb") as fh:
            span = _aiff_data_span(fh)

    if span:
        offset, length = span
        with open(p, "rb") as fh:
            fh.seek(offset)
            left = length
            while left > 0:
                buf = fh.read(min(1 << 20, left))
                if not buf:
                    break
                h.update(buf)
                left -= len(buf)
        return {"md5": h.hexdigest(), "scope": "audio samples",
                "how": f"the data chunk only, {length:,} bytes from offset {offset:,} — "
                       "tagging the file later will not change this"}

    with open(p, "rb") as fh:
        for buf in iter(lambda: fh.read(1 << 20), b""):
            h.update(buf)
    return {"md5": h.hexdigest(), "scope": "whole file",
            "how": "the whole file, because this format does not expose its audio as a "
                   "single span. Any tag edit will change it."}


def coding_history(info: Dict[str, Any], tape: Optional[Dict[str, Any]] = None) -> str:
    """A BWF Coding History block in the EBU R98 / Tech 3285 layout.

    Two lines, because there were two stages: the tape, then the converter. Written the way
    the recommendation wants it — A= coding, F= sample rate, W= word length, M= mode,
    T= free text — so another archive's software can read it without a human in the middle.
    """
    tape = tape or {}
    ch = int(info.get("channels") or 1)
    mode = {1: "mono", 2: "stereo"}.get(ch, f"{ch}-channel")
    bits = {"PCM_16": 16, "PCM_24": 24, "PCM_32": 32, "FLOAT": 32,
            "DOUBLE": 64, "PCM_U8": 8, "PCM_S8": 8}.get(str(info.get("subtype")), 24)

    analogue_bits = [tape.get("machine"), tape.get("width"), tape.get("speed"),
                     tape.get("noise_reduction"), tape.get("stock")]
    analogue = "; ".join(str(b).strip() for b in analogue_bits if str(b or "").strip())
    lines = []
    if analogue:
        lines.append(f"A=ANALOGUE,M={mode},T={analogue}")
    chain = "; ".join(s for s in [str(tape.get("interface") or "").strip(),
                                  "WAIvePulse tape session"] if s)
    lines.append(f"A=PCM,F={int(info.get('samplerate') or 0)},W={bits},M={mode},T={chain}")
    return "\r\n".join(lines)


def _write_sidecar(out: Path, src: Path, applied: List[str], tool: str) -> Path:
    """A JSON note beside every repair saying what was done to what.

    Written at the moment of the repair rather than guessed at later, because the manifest
    has to be able to say which file is the master and which is derived — and after a few
    months of cleaning, filenames alone will not tell you.
    """
    import json
    from datetime import datetime, timezone

    note = {
        "derived_from": src.name,
        "derived_from_audio_md5": audio_md5(str(src)).get("md5"),
        "tool": f"WAIvePulse tape session / {tool}",
        "applied": applied,
        "at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    p = out.with_suffix(out.suffix + ".json")
    try:
        p.write_text(json.dumps(note, indent=2), encoding="utf-8")
    except OSError:
        return p
    return p


MANIFEST_JSON = "WAIvePulse-MANIFEST.json"
MANIFEST_TXT = "WAIvePulse-MANIFEST.txt"
MANIFEST_CSV = "WAIvePulse-bwfmetaedit.csv"


def manifest(folder: str, *, tape: Optional[Dict[str, Any]] = None,
             title: str = "", operator: str = "") -> Dict[str, Any]:
    """Write a preservation manifest for a tape session.

    Three files, because three different readers need this: JSON for the app and for
    whatever comes after it, a plain-text copy that will still be readable with no software
    at all, and a CSV in the layout BWF MetaEdit's `--in-core=` import expects, so the
    coding history can be embedded with the archival standard tool instead of with us.
    """
    import csv
    import json
    from datetime import datetime, timezone

    listing = scan(folder, include_repairs=True)
    if not listing["ok"]:
        return {"ok": False, "error": listing["error"]}
    if not listing["tracks"]:
        return {"ok": False, "error": f"No audio files in {folder}."}

    d = Path(listing["folder"])
    tape = dict(tape or {})
    now = datetime.now(timezone.utc)
    entries = []
    for t in listing["tracks"]:
        p = Path(t["path"])
        digest = audio_md5(t["path"])
        stat = p.stat()
        sidecar = p.with_suffix(p.suffix + ".json")
        derived = None
        if sidecar.is_file():
            try:
                derived = json.loads(sidecar.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                derived = None
        entries.append({
            "name": p.name,
            "bytes": stat.st_size,
            "modified": datetime.fromtimestamp(stat.st_mtime, timezone.utc)
                                .strftime("%Y-%m-%dT%H:%M:%SZ"),
            "seconds": t["seconds"],
            "samplerate": t["samplerate"],
            "channels": t["channels"],
            "subtype": t["subtype"],
            "audio_md5": digest["md5"],
            "checksum_scope": digest["scope"],
            "checksum_note": digest["how"],
            "coding_history": coding_history(t, tape),
            "derived": derived,
            "role": "derived" if derived else "preservation master",
        })

    doc = {
        "manifest": "WAIvePulse tape session",
        "version": 1,
        "written": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "folder": str(d),
        "title": title or d.name,
        "operator": operator,
        "tape": tape,
        "tracks": entries,
        "notes": listing["notes"],
        "checksums": "MD5 over the audio samples only where the format allows it, so "
                     "adding or editing metadata later does not invalidate them. "
                     "Re-check with Verify in the app.",
    }
    (d / MANIFEST_JSON).write_text(json.dumps(doc, indent=2), encoding="utf-8")

    lines = [f"WAIvePulse tape session — {doc['title']}",
             f"written {doc['written']}",
             f"folder  {doc['folder']}", ""]
    if operator:
        lines.append(f"transferred by {operator}")
    for k, v in tape.items():
        if str(v or "").strip():
            lines.append(f"{k:>16}: {v}")
    lines.append("")
    for e in entries:
        lines += [
            f"{e['name']}  [{e['role']}]",
            f"    {e['seconds']}s  {e['samplerate']} Hz  {e['channels']} ch  "
            f"{e['subtype']}  {e['bytes']:,} bytes",
            f"    audio MD5 {e['audio_md5']}  ({e['checksum_scope']})",
        ]
        for cl in e["coding_history"].split("\r\n"):
            lines.append(f"    {cl}")
        if e["derived"]:
            lines.append(f"    derived from {e['derived'].get('derived_from')}: "
                         + "; ".join(e["derived"].get("applied") or []))
        lines.append("")
    lines += [doc["checksums"], ""]
    (d / MANIFEST_TXT).write_text("\n".join(lines), encoding="utf-8")

    # BWF MetaEdit reads a CSV whose first column is literally FileName and whose other
    # column names are bext field names, matched without regard to case.
    with open(d / MANIFEST_CSV, "w", newline="", encoding="utf-8") as fh:
        w = csv.writer(fh)
        w.writerow(["FileName", "Description", "Originator", "OriginatorReference",
                    "OriginationDate", "OriginationTime", "CodingHistory"])
        for e in entries:
            w.writerow([
                e["name"],
                f"{doc['title']} — {e['name']}",
                operator or "WAIvePulse tape session",
                "",
                (tape.get("transfer_date") or now.strftime("%Y-%m-%d")),
                now.strftime("%H:%M:%S"),
                e["coding_history"],
            ])

    return {"ok": True, "folder": str(d), "tracks": entries,
            "files": [MANIFEST_JSON, MANIFEST_TXT, MANIFEST_CSV],
            "written": doc["written"], "title": doc["title"],
            "coding_history": entries[0]["coding_history"] if entries else "",
            "note": "Checksums cover the audio samples, not the file, so tagging these "
                    "files later will not break them."}


def verify_manifest(folder: str) -> Dict[str, Any]:
    """Re-hash every track and compare against the manifest.

    This is the point of the whole exercise: a year from now, one button says whether the
    audio is still bit-for-bit what came off the tape.
    """
    import json

    d = Path(folder).expanduser()
    mf = d / MANIFEST_JSON
    if not mf.is_file():
        return {"ok": False, "error": "No manifest in this folder yet. Write one first."}
    try:
        doc = json.loads(mf.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {"ok": False, "error": f"The manifest could not be read: {e}"}

    recorded = {e["name"]: e for e in doc.get("tracks", [])}
    on_disk = {Path(t["path"]).name: t for t in
               scan(folder, include_repairs=True).get("tracks", [])}
    results, changed, missing = [], [], []
    for name, e in recorded.items():
        if name not in on_disk:
            missing.append(name)
            results.append({"name": name, "state": "missing"})
            continue
        got = audio_md5(on_disk[name]["path"])
        same = got["md5"] == e.get("audio_md5")
        if not same:
            changed.append(name)
        results.append({"name": name, "state": "unchanged" if same else "CHANGED",
                        "expected": e.get("audio_md5"), "found": got["md5"],
                        "scope": got["scope"]})
    added = [n for n in on_disk if n not in recorded]
    for n in added:
        results.append({"name": n, "state": "not in the manifest"})

    return {"ok": True, "folder": str(d), "written": doc.get("written"),
            "tracks": results, "changed": changed, "missing": missing, "added": added,
            "all_good": not changed and not missing,
            "summary": (f"{len(recorded) - len(changed) - len(missing)} of {len(recorded)} "
                        f"track(s) still match the manifest"
                        + (f", {len(changed)} CHANGED" if changed else "")
                        + (f", {len(missing)} missing" if missing else "")
                        + (f", {len(added)} new file(s) not in it" if added else ""))}
