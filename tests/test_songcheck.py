"""Song Check: does each detector fire on a defect it is meant to catch, and stay quiet
on clean audio?

Every case is synthesised, so the tests are deterministic and need no GPU, no model and
none of the user's songs. A detector that fires on everything is as useless as one that
never fires, so each defect test is paired against the clean control.
"""
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import songcheck                                                    # noqa: E402

SR = 48_000


def _write(tmp_path, y, name="x.wav"):
    """y is (n,) or (2, n) float; written as a real file because check() takes a path."""
    p = tmp_path / name
    data = y.T if y.ndim > 1 else y
    sf.write(str(p), data, SR)
    return str(p)


def _tone(seconds, freq=220.0, amp=0.2, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    # a couple of partials so spectral measures see something musical
    return amp * (np.sin(2 * np.pi * freq * t) + 0.3 * np.sin(2 * np.pi * 2 * freq * t))


def _stereo(mono, width=0.3):
    return np.stack([mono, np.roll(mono, int(SR * 0.0005)) * (1 - width) + mono * width])


def ids(result):
    return {f["id"] for f in result["findings"]}


@pytest.fixture
def clean(tmp_path):
    """40 s, steady level, fades out, peaks well under the ceiling."""
    y = _tone(40)
    fade = int(2 * SR)
    y[-fade:] *= np.linspace(1, 0, fade)
    y[:fade] *= np.linspace(0, 1, fade)
    return _write(tmp_path, _stereo(y), "clean.wav")


def test_clean_audio_is_reported_clean(clean):
    r = songcheck.check(clean)
    assert r["ok"] and r["clean"], f"clean audio flagged: {ids(r)}"
    assert "loudness_ramp" not in ids(r)
    assert "hard_stop" not in ids(r)


def test_loudness_ramp_is_caught(tmp_path, clean):
    y = _tone(40)
    y *= np.linspace(0.25, 1.0, y.size)          # ~12 dB climb across the song
    fade = int(2 * SR)
    y[-fade:] *= np.linspace(1, 0, fade)
    r = songcheck.check(_write(tmp_path, _stereo(y), "ramp.wav"))
    assert "loudness_ramp" in ids(r)
    f = next(x for x in r["findings"] if x["id"] == "loudness_ramp")
    assert f["numbers"]["drift_lu"] > 2
    assert "Automation" in f["where"]
    # and the control: the same material without the ramp must not trip it
    assert "loudness_ramp" not in ids(songcheck.check(clean))


def test_hard_stop_is_caught(tmp_path):
    y = _tone(40)                                 # full level right up to the final sample
    r = songcheck.check(_write(tmp_path, _stereo(y), "stop.wav"))
    assert "hard_stop" in ids(r)


def test_dead_air_in_the_middle_is_caught(tmp_path):
    y = _tone(40)
    y[int(15 * SR):int(19 * SR)] = 0.0            # 4 s hole
    y[-int(2 * SR):] *= np.linspace(1, 0, int(2 * SR))
    r = songcheck.check(_write(tmp_path, _stereo(y), "gap.wav"))
    assert "dead_air" in ids(r)
    f = next(x for x in r["findings"] if x["id"] == "dead_air")
    assert 3.0 <= f["numbers"]["gap_s"] <= 5.0


def test_flat_topping_and_overshoot_are_different_findings(tmp_path):
    """A squared-off waveform is clipping; a peak merely over 0 dBFS is not the same thing
    and must not be described as flat-topped."""
    y = np.clip(_tone(20, amp=2.0), -1.0, 1.0)    # genuinely squared off
    r = songcheck.check(_write(tmp_path, _stereo(y, width=0.0), "clip.wav"))
    assert "clipping" in ids(r)
    assert "over_full_scale" not in ids(r)


def test_quiet_master_is_a_note_not_a_defect(tmp_path):
    y = _tone(40, amp=0.004)                      # far below streaming level
    y[-int(2 * SR):] *= np.linspace(1, 0, int(2 * SR))
    r = songcheck.check(_write(tmp_path, _stereo(y), "quiet.wav"))
    assert "quiet_master" in ids(r)
    f = next(x for x in r["findings"] if x["id"] == "quiet_master")
    assert f["severity"] == "note"


def test_mono_file_is_flagged_as_narrow(tmp_path):
    y = _tone(40)
    y[-int(2 * SR):] *= np.linspace(1, 0, int(2 * SR))
    r = songcheck.check(_write(tmp_path, np.stack([y, y]), "mono.wav"))
    assert "narrow_stereo" in ids(r)


def test_findings_are_json_safe(tmp_path, clean):
    """numpy scalars serialise fine in a console test and 500 the endpoint when served."""
    import json
    y = _tone(40) * np.linspace(0.25, 1.0, int(40 * SR))
    r = songcheck.check(_write(tmp_path, _stereo(y), "json.wav"))
    json.dumps(r)                                  # raises on np.float64
    for f in r["findings"]:
        for v in f["numbers"].values():
            assert type(v) in (int, float), f"{type(v)} is not JSON-safe"


def test_every_finding_names_a_fix_and_a_place(tmp_path):
    """The panel is only useful because each finding ends somewhere the user can go."""
    y = _tone(40) * np.linspace(0.25, 1.0, int(40 * SR))
    r = songcheck.check(_write(tmp_path, _stereo(y), "fix.wav"))
    assert r["findings"]
    for f in r["findings"]:
        assert f["fix"].strip() and f["where"].strip()
        assert f["severity"] in ("high", "medium", "note")


def test_dropout_needs_stems_and_stays_quiet_without_them(tmp_path, clean):
    assert songcheck._dropout_check(None, SR, 40.0) is None
    assert "instrumental_dropout" not in ids(songcheck.check(clean))


def test_sparse_arrangement_is_not_called_a_dropout(tmp_path):
    """A vocal over a deliberately airy backing is an arrangement, not 50 defects."""
    n = int(40 * SR)
    vocal = _tone(40, freq=330, amp=0.3)
    backing = _tone(40, freq=110, amp=0.3)
    # backing absent for half of every second -> sparse by design
    mask = (np.arange(n) % SR) < (SR // 2)
    backing[mask] = 0.0
    v = _write(tmp_path, np.stack([vocal, vocal]), "v.wav")
    d = _write(tmp_path, np.stack([backing, backing]), "d.wav")
    assert songcheck._dropout_check({"vocals": v, "drums": d}, SR, 40.0) is None
