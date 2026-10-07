"""Song Check — find the defects AI music actually ships with, and name the fix.

Every check here comes from a complaint people make repeatedly about generated songs:

  loudness ramp      "Songs keep getting progressively louder as they progress"
  instrumental dropout "How do you stop instrumental dropouts that emphasize individual words?"
  hard stop          AI songs end by stopping dead rather than finishing
  clipping           renders come back already squashed against 0 dBFS
  dead air           a gap in the middle where the model lost the plot
  narrow stereo      a 'stereo' file that is really mono
  tempo drift        "it turns the song into a fast rock piece after a minute"
  quiet master       the track is 6+ LU below streaming level

The point is not the diagnosis, it is that every finding names a control WAIvePulse already
has, so the fix is one panel away instead of a re-roll. Nothing here needs the GPU, a model,
or the network: it is numpy plus the K-weighting already in analyze.py.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

SR = 48_000
TARGET_LUFS = -14.0          # the level streaming services normalise to

# Each finding is {id, severity, title, detail, fix, where, numbers}. Severity drives the
# sort and the colour: "high" = you will hear it, "note" = worth knowing, not a defect.
HIGH, MED, NOTE = "high", "medium", "note"


def _short_term_lufs(y, sr: int):
    """Short-term loudness (3 s window, 1 s hop) as (times, lufs) — the curve the
    'it gets louder as it goes' complaint is about."""
    import numpy as np
    from scipy import signal

    # BS.1770-4 K-weighting, same coefficients as analyze.quality_proxy
    shelf_b = np.array([1.53512485958697, -2.69169618940638, 1.19839281085285])
    shelf_a = np.array([1.0, -1.69065929318241, 0.73248077421585])
    hp_b = np.array([1.0, -2.0, 1.0])
    hp_a = np.array([1.0, -1.99004745483398, 0.99007225036621])
    filtered = []
    for ch in y:
        f = signal.lfilter(shelf_b, shelf_a, ch.astype("float64"))
        filtered.append(signal.lfilter(hp_b, hp_a, f))
    win, hop = int(3.0 * sr), int(1.0 * sr)
    times, vals = [], []
    n = filtered[0].size
    for s in range(0, max(1, n - win + 1), hop):
        p = sum(float(np.mean(ch[s:s + win] ** 2)) for ch in filtered)
        if p > 0:
            lufs = -0.691 + 10 * np.log10(p)
            if lufs > -70:                      # absolute gate, as in the spec
                times.append(s / sr)
                vals.append(lufs)
    return np.asarray(times), np.asarray(vals)


def _rms_envelope(mono, sr: int, win_s: float = 0.05):
    import numpy as np
    w = max(1, int(win_s * sr))
    n = (mono.size // w) * w
    if n == 0:
        return np.zeros(1), np.zeros(1)
    blocks = mono[:n].reshape(-1, w)
    rms = np.sqrt((blocks ** 2).mean(axis=1) + 1e-12)
    t = np.arange(blocks.shape[0]) * win_s
    return t, rms


def _plain(obj):
    """numpy scalar -> python scalar, recursively. json.dumps and FastAPI both refuse
    np.float64/np.int64, and the failure only shows up once it is served, not in a console
    test where they print identically to floats."""
    if isinstance(obj, dict):
        return {k: _plain(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_plain(v) for v in obj]
    item = getattr(obj, "item", None)          # numpy scalars expose .item()
    if callable(item) and hasattr(obj, "dtype"):
        return obj.item()
    return obj


def _fmt_t(seconds: float) -> str:
    m, s = divmod(int(round(seconds)), 60)
    return f"{m}:{s:02d}"


def check(path: str, stems: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    """Analyse one finished song. `stems` maps role -> file path when a separation exists;
    with it the dropout check gets much sharper, without it we fall back to the full mix."""
    import numpy as np

    import analyze                                   # reuse its decoder
    y, sr = analyze._decode(path, SR)
    y = np.asarray(y, dtype="float64")
    if y.ndim == 1:
        y = y[None, :]
    mono = y.mean(axis=0)
    dur = mono.size / sr
    findings: List[Dict[str, Any]] = []

    def add(fid, sev, title, detail, fix, where, **numbers):
        # numpy scalars are not JSON-serialisable and FastAPI would 500 on them, which is
        # easy to miss because they print exactly like floats in a console test.
        findings.append({"id": fid, "severity": sev, "title": title, "detail": detail,
                         "fix": fix, "where": where, "numbers": _plain(numbers)})

    # ── 1. loudness ramp ──────────────────────────────────────────────────────
    times, lufs = _short_term_lufs(y, sr)
    integrated = None
    if lufs.size:
        integrated = float(-0.691 + 10 * np.log10(np.mean(10 ** ((lufs + 0.691) / 10))))
    if lufs.size >= 6:
        third = max(1, lufs.size // 3)
        head = float(np.median(lufs[:third]))
        tail = float(np.median(lufs[-third:]))
        drift = tail - head
        if abs(drift) >= 2.0:
            rising = drift > 0
            add("loudness_ramp", HIGH if abs(drift) >= 4 else MED,
                f"The song gets {abs(drift):.1f} LU {'louder' if rising else 'quieter'} as it goes",
                f"First third sits at {head:.1f} LUFS, last third at {tail:.1f} LUFS. "
                f"{'A rise like this is the model piling on layers, not a mix decision.' if rising else 'The ending loses energy rather than resolving.'}",
                "Draw the opposite slope on the master automation lane, or let the limiter "
                "catch the loud half and lift the quiet half.",
                "Studio → Automation lanes / Master FX rack",
                head_lufs=round(head, 1), tail_lufs=round(tail, 1), drift_lu=round(drift, 1))

    # ── 2. over 0 dBFS, and genuine flat-topping ──────────────────────────────
    # Two different defects, and on a decoded MP3 only one of them is visible. A lossy
    # decode routinely overshoots past 1.0 even when the encoder's input never clipped, and
    # it also smears any flat top away - so counting samples >= 0.999 and calling them
    # "pinned at full scale" would be wrong on exactly the files we mostly have. Instead:
    # report the overshoot (true on any format) and only claim flat-topping when consecutive
    # samples really do sit still at the ceiling, which survives only in lossless files.
    peak = float(np.abs(y).max())
    peak_db = float(20 * np.log10(peak + 1e-12))
    over = int((np.abs(y) > 1.0).sum())
    flat = 0
    if peak >= 0.999:
        for ch in y:
            at_top = np.abs(ch) >= 0.9995
            if at_top.any():
                # a run of 3+ touching samples that barely move = a squared-off waveform
                still = at_top[:-1] & at_top[1:] & (np.abs(np.diff(ch)) < 1e-4)
                flat += int(still.sum())
    if flat > 100:
        add("clipping", HIGH if flat > 2000 else MED,
            f"{flat:,} samples are flat-topped at full scale",
            f"Peak is {peak_db:.2f} dBFS and the waveform sits still at the ceiling, which is "
            "digital clipping baked into the file. It survives every later export.",
            "Pull the master down and use the soft clipper, which rounds the peaks instead of "
            "squaring them off.",
            "Studio → Master FX rack → CLP",
            flat_samples=flat, peak_dbfs=round(peak_db, 2))
    elif peak_db > 1.0:
        add("over_full_scale", MED if peak_db > 2.0 else NOTE,
            f"Peaks reach {peak_db:+.1f} dB over full scale",
            f"{over:,} samples decode above 0 dBFS. The master was pushed past the ceiling "
            "before encoding, so players and any re-encode will distort those peaks even "
            "though the file itself holds them.",
            "Drop the master a decibel or two and let the limiter catch the peaks; the LUFS "
            "meter shows what you get back.",
            "Studio → Master FX rack → LMT",
            over_samples=over, peak_dbfs=round(peak_db, 2))

    # ── 3. hard stop / abrupt ending ──────────────────────────────────────────
    t_env, env = _rms_envelope(mono, sr)
    if env.size > 20:
        body = float(np.median(env[env > env.max() * 0.05])) if (env > env.max() * 0.05).any() else 0.0
        tail_rms = float(env[-4:].mean())            # last ~0.2 s
        if body > 0 and tail_rms > body * 0.35:
            add("hard_stop", MED,
                "The song stops dead instead of ending",
                f"The final 0.2 s is still at {20 * np.log10(tail_rms / body):.1f} dB "
                "relative to the body of the track. Generated songs often run out of tokens "
                "mid-phrase rather than resolving.",
                "A short master fade-out shapes the ending; it is measured back from the "
                "current song end, so it follows a Cut.",
                "Studio → Master fade in/out",
                tail_ratio_db=round(20 * np.log10(tail_rms / body), 1))

    # ── 4. dead air in the middle ─────────────────────────────────────────────
    if env.size > 40:
        floor = max(env.max() * 0.02, 1e-5)
        quiet = env < floor
        runs, start = [], None
        for i, q in enumerate(quiet):
            if q and start is None:
                start = i
            elif not q and start is not None:
                runs.append((start, i))
                start = None
        if start is not None:
            runs.append((start, len(quiet)))
        inner = [(a, b) for a, b in runs
                 if (b - a) * 0.05 >= 1.2 and a * 0.05 > 1.0 and b * 0.05 < dur - 1.0]
        if inner:
            a, b = max(inner, key=lambda r: r[1] - r[0])
            add("dead_air", HIGH,
                f"{(b - a) * 0.05:.1f} s of near-silence at {_fmt_t(a * 0.05)}",
                "A gap this long in the middle is the model losing the thread, not an "
                "arrangement choice.",
                "Select the gap on the ruler and ripple-delete it, or rewrite that span.",
                "Studio → Cut (ripple delete) / Rewrite Section",
                gap_s=round((b - a) * 0.05, 1), at_s=round(a * 0.05, 1),
                gaps_found=len(inner))

    # ── 5. instrumental dropout under the vocal ───────────────────────────────
    drop = _dropout_check(stems, sr, dur)
    if drop:
        findings.append(drop)

    # ── 6. stereo width ───────────────────────────────────────────────────────
    if y.shape[0] >= 2:
        mid = (y[0] + y[1]) * 0.5
        side = (y[0] - y[1]) * 0.5
        width = float(np.sqrt(np.mean(side ** 2)) / (np.sqrt(np.mean(mid ** 2)) + 1e-12))
        if width < 0.02:
            add("narrow_stereo", NOTE,
                "Effectively mono",
                f"Side energy is {width:.3f} of mid. The file has two channels but almost "
                "no stereo information.",
                "The reverb and the stereo widener in the master chain open it up; per-track "
                "panning does more.",
                "Studio → Master FX rack",
                stereo_width=round(width, 4))

    # ── 7. tempo drift ────────────────────────────────────────────────────────
    tempo = _tempo_drift(mono, sr, dur)
    if tempo:
        findings.append(tempo)

    # ── 8. level vs streaming target ──────────────────────────────────────────
    if integrated is not None and integrated < TARGET_LUFS - 5:
        add("quiet_master", NOTE,
            f"{TARGET_LUFS - integrated:.1f} LU below streaming level",
            f"Integrated loudness is {integrated:.1f} LUFS against the {TARGET_LUFS:.0f} LUFS "
            "that streaming services normalise to. Nothing is wrong with the audio; it will "
            "just play quieter than everything around it.",
            "Match master lifts it to a reference, and the LUFS meter confirms the result.",
            "Studio → 🎚 Match master",
            integrated_lufs=round(integrated, 1))

    order = {HIGH: 0, MED: 1, NOTE: 2}
    findings.sort(key=lambda f: order.get(f["severity"], 3))
    return {
        "ok": True,
        "duration_s": round(dur, 1),
        "integrated_lufs": round(float(integrated), 1) if integrated is not None else None,
        "peak_dbfs": round(float(peak_db), 2),
        "used_stems": bool(stems),
        "findings": findings,
        "clean": not any(f["severity"] in (HIGH, MED) for f in findings),
    }


def _dropout_check(stems: Optional[Dict[str, str]], sr: int, dur: float) -> Optional[Dict[str, Any]]:
    """Backing instruments falling away under the vocal.

    This is the "instrumental dropouts that emphasize individual words" complaint. It needs
    stems to be meaningful: in a full mix a quiet moment and a dropout look identical, so
    without a separation we say nothing rather than guess.
    """
    if not stems:
        return None
    import numpy as np
    import analyze

    vocal_path = stems.get("vocals")
    backing = [p for role, p in stems.items() if role != "vocals" and p]
    if not vocal_path or not backing:
        return None
    try:
        v, _ = analyze._decode(vocal_path, sr)
        v = np.asarray(v, dtype="float64")
        vmono = v.mean(axis=0) if v.ndim > 1 else v
        bmix = None
        for p in backing:
            b, _ = analyze._decode(p, sr)
            b = np.asarray(b, dtype="float64")
            bm = b.mean(axis=0) if b.ndim > 1 else b
            bmix = bm if bmix is None else bmix[:min(len(bmix), len(bm))] + bm[:min(len(bmix), len(bm))]
    except Exception:                                            # noqa: BLE001
        return None
    if bmix is None:
        return None
    n = min(len(vmono), len(bmix))
    _, venv = _rms_envelope(vmono[:n], sr, 0.1)
    _, benv = _rms_envelope(bmix[:n], sr, 0.1)
    m = min(len(venv), len(benv))
    venv, benv = venv[:m], benv[:m]
    if m < 20:
        return None
    sings = venv > venv.max() * 0.15                  # the vocal is actually present
    if sings.sum() < 10:
        return None
    b_ref = float(np.median(benv[sings]))
    if b_ref <= 0:
        return None
    holes = sings & (benv < b_ref * 0.25)             # backing drops >12 dB while singing
    if holes.sum() < 3:
        return None
    # group consecutive frames so one dropout is not counted ten times
    idx = np.flatnonzero(holes)
    groups, run = [], [idx[0]]
    for i in idx[1:]:
        if i - run[-1] <= 2:
            run.append(i)
        else:
            groups.append(run)
            run = [i]
    groups.append(run)

    # A dropout is a HOLE punched in continuous backing, not a sparse passage. Without these
    # three rules the check called an intro a defect (6.4 s "dropout" starting at 0:00) and
    # reported 56 of them on a song that simply has an airy arrangement.
    #   - 0.2 to 2.0 s: the complaint is about single words jumping out, not breakdowns
    #   - backing must return on BOTH sides, so edges and intros do not qualify
    #   - if holes cover a quarter of the singing, the arrangement is sparse by design
    def surrounded(g):
        before = benv[max(0, g[0] - 5):g[0]]
        after = benv[g[-1] + 1:g[-1] + 6]
        return (before.size and after.size
                and float(before.max()) >= b_ref * 0.6
                and float(after.max()) >= b_ref * 0.6)

    groups = [g for g in groups if 2 <= len(g) <= 20 and surrounded(g)]
    if not groups:
        return None
    if sum(len(g) for g in groups) > 0.25 * int(sings.sum()):
        return None                                   # sparse by design, not a defect
    worst = max(groups, key=len)
    at = worst[0] * 0.1
    # A handful of holes are discrete defects you go and fix. Fifty of them are not fifty
    # defects, they are how the whole mix behaves, and calling them "50 dropouts" would send
    # someone hunting for individual moments that are really a mix-wide trait.
    many = len(groups) > 12
    title = (f"The backing ducks under the vocal throughout ({len(groups)} places)" if many
             else f"The backing drops out under the vocal {len(groups)}x")
    return {
        "id": "instrumental_dropout", "severity": "medium",
        "title": title,
        "detail": (f"Longest is {len(worst) * 0.1:.1f} s at {_fmt_t(at)}, where the instruments "
                   f"fall more than 12 dB below their usual level while the vocal keeps going. "
                   + ("At this count it is the character of the mix rather than a few bad "
                      "moments: the backing is pumping against every vocal phrase."
                      if many else
                      "This is what makes single words jump out of an AI mix.")),
        "fix": "Side-chain ducking set gently, or ride the backing stem up on its automation "
               "lane across those moments.",
        "where": "Studio → Side-chain ducking / Automation lanes",
        "numbers": _plain({"dropouts": len(groups), "longest_s": round(len(worst) * 0.1, 1),
                           "at_s": round(at, 1)}),
    }


def _tempo_drift(mono, sr: int, dur: float) -> Optional[Dict[str, Any]]:
    """Does the first half keep the same tempo as the second?

    "V6 keeps ignoring the style - it turns into a fast rock piece after a minute". Uses an
    onset-autocorrelation estimate per half; only reports when the halves disagree by enough
    that it is not an octave or estimator wobble.
    """
    if dur < 30:
        return None
    import numpy as np

    def bpm_of(seg):
        if seg.size < sr * 8:
            return None
        win = 1024
        n = (seg.size // win) * win
        if n == 0:
            return None
        frames = seg[:n].reshape(-1, win)
        env = np.sqrt((frames ** 2).mean(axis=1) + 1e-12)
        env = np.diff(env, prepend=env[0]).clip(min=0)        # onset strength
        env -= env.mean()
        if not np.any(env):
            return None
        ac = np.correlate(env, env, mode="full")[env.size - 1:]
        fps = sr / win
        lo, hi = int(fps * 60 / 180), int(fps * 60 / 60)      # 60-180 BPM
        if hi <= lo or hi >= ac.size:
            return None
        lag = int(np.argmax(ac[lo:hi]) + lo)
        return 60.0 * fps / lag if lag else None

    half = mono.size // 2
    a, b = bpm_of(mono[:half]), bpm_of(mono[half:])
    if not a or not b:
        return None
    ratio = max(a, b) / min(a, b)
    if ratio > 1.9:                       # half/double time is an estimator artefact, not drift
        return None
    if abs(a - b) < 6:
        return None
    return {
        "id": "tempo_drift", "severity": "medium",
        "title": f"Tempo moves from about {a:.0f} to {b:.0f} BPM",
        "detail": "The two halves of the song do not share a tempo. Generated songs drift "
                  "when the model changes its mind about the arrangement partway through.",
        "fix": "Time-stretch the slower half to match (the pitch is preserved), or cut the "
               "section where it changes.",
        "where": "Studio → Time-stretch / Cut",
        "numbers": _plain({"first_half_bpm": round(a, 1), "second_half_bpm": round(b, 1)}),
    }
