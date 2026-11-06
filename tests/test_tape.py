"""Tape sessions: does each detector fire on the fault it is for, and stay quiet otherwise?

Everything is synthesised, so these are deterministic and need no GPU, no model and none of
the user's transfers. Each defect test is paired against a clean control, because a detector
that fires on everything is as useless as one that never fires — and in this feature's case
that was not hypothetical: the first click detector reported 520 clicks on a song that had
none, and the first dropout detector called every staccato rest a tape fault.

The repairs are checked against the thing that actually matters: whether the output is
measurably closer to the undamaged signal than the input was.
"""
import math
import struct
import sys
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import tape                                                        # noqa: E402

SR = 48_000


# ── material ──────────────────────────────────────────────────────────────────
def _music(seconds=12.0, sr=SR, seed=0):
    """A few harmonics with a slow envelope — smooth, so a click has something to break."""
    t = np.arange(int(seconds * sr)) / sr
    rng = np.random.default_rng(seed)
    y = (0.25 * np.sin(2 * np.pi * 220.0 * t)
         + 0.12 * np.sin(2 * np.pi * 440.0 * t)
         + 0.06 * np.sin(2 * np.pi * 659.26 * t))
    y *= 0.8 + 0.2 * np.sin(2 * np.pi * 0.3 * t + rng.random())
    return y


def _write(tmp_path, y, name="track.wav", sr=SR):
    p = tmp_path / name
    sf.write(str(p), y.T if y.ndim > 1 else y, sr, subtype="PCM_24")
    return str(p)


def _hum_tone(seconds, f0=50.0, amp=0.03, sr=SR):
    t = np.arange(int(seconds * sr)) / sr
    return amp * np.sin(2 * np.pi * f0 * t) + 0.4 * amp * np.sin(2 * np.pi * 2 * f0 * t)


# ── scanning ──────────────────────────────────────────────────────────────────
def test_scan_sorts_numerically_not_lexicographically(tmp_path):
    """Track10 after Track2. Tape transfers are numbered and sorted() gets it wrong."""
    for n in (1, 2, 10, 11):
        _write(tmp_path, _music(1.0), f"Track{n}.wav")
    names = [t["name"] for t in tape.scan(str(tmp_path))["tracks"]]
    assert names == ["Track1.wav", "Track2.wav", "Track10.wav", "Track11.wav"]


def test_scan_skips_its_own_repairs(tmp_path):
    """A cleaned file must never be offered for cleaning again."""
    _write(tmp_path, _music(1.0), "a.wav")
    _write(tmp_path, _music(1.0), f"a{tape.REPAIR_SUFFIX}.wav")
    assert [t["name"] for t in tape.scan(str(tmp_path))["tracks"]] == ["a.wav"]
    # …but the manifest has to see both, or it cannot say which is derived from which.
    both = tape.scan(str(tmp_path), include_repairs=True)["tracks"]
    assert len(both) == 2


def test_scan_notices_mixed_sample_rates(tmp_path):
    _write(tmp_path, _music(1.0), "a.wav", sr=48000)
    _write(tmp_path, _music(1.0), "b.wav", sr=44100)
    notes = " ".join(tape.scan(str(tmp_path))["notes"])
    assert "sample rate" in notes.lower()


def test_scan_rejects_a_path_that_is_not_a_folder(tmp_path):
    out = tape.scan(str(tmp_path / "nope"))
    assert out["ok"] is False and "not a folder" in out["error"]


# ── hum ───────────────────────────────────────────────────────────────────────
def test_hum_found_when_present_and_not_when_absent(tmp_path):
    clean = _music(12.0)
    assert not (tape._hum(clean, SR) or {}).get("present")
    dirty = clean + _hum_tone(12.0, 50.0)
    found = tape._hum(dirty, SR)
    assert found["present"] and abs(found["hz"] - 50.0) < 0.6


def test_hum_reports_where_the_lines_really_sit(tmp_path):
    """A tape played back off-speed drags the whole hum stack off the textbook series.

    Notching 50/100/150 exactly would then cut music and leave the hum, so the measurement
    has to report the frequencies it actually found.
    """
    dirty = _music(12.0) + _hum_tone(12.0, 51.4)
    found = tape._hum(dirty, SR)
    assert found["present"]
    measured = found.get("measured_hz") or []
    assert measured and abs(measured[0] - 51.4) < 1.0
    assert abs(found.get("drift_hz", 0.0)) > 0.2


def test_clean_removes_hum_and_leaves_the_original_alone(tmp_path):
    src = _write(tmp_path, _music(12.0) + _hum_tone(12.0, 50.0))
    before = Path(src).read_bytes()
    r = tape.clean(src, hum=True)
    assert r["ok"]
    assert Path(src).read_bytes() == before, "the transfer must never be written to"
    mono, sr, _ = tape._load_mono(r["output"])
    assert not (tape._hum(mono, sr) or {}).get("present")


# ── DC, hiss ──────────────────────────────────────────────────────────────────
def test_dc_offset_measured_and_removed(tmp_path):
    src = _write(tmp_path, _music(8.0) + 0.04)
    assert abs(tape.analyse_track(src)["dc_offset"] - 0.04) < 0.005
    r = tape.clean(src, dc=True)
    assert abs(tape.analyse_track(r["output"])["dc_offset"]) < 1e-4


def test_dc_is_not_reported_as_a_noise_floor(tmp_path):
    """A 0.04 offset reads as a -28 dBFS 'noise floor' unless it is taken out first, which
    would send the user to the hiss tool for a problem one subtraction solves."""
    quiet = np.concatenate([_music(6.0), np.zeros(SR) + 0.04])
    src = _write(tmp_path, quiet)
    assert tape.analyse_track(src)["noise_rms_dbfs"] < -60


def test_hiss_subtraction_lowers_the_floor_without_gutting_the_music(tmp_path):
    rng = np.random.default_rng(4)
    body = _music(10.0)
    noise = rng.normal(0, 0.004, len(body) + SR)
    y = np.concatenate([np.zeros(SR), body]) + noise
    src = _write(tmp_path, y)
    before = tape.analyse_track(src)
    r = tape.clean(src, hiss=True, noise_start=0.1, noise_end=0.9)
    assert r["ok"]
    after = tape.analyse_track(r["output"])
    assert after["noise_rms_dbfs"] < before["noise_rms_dbfs"] - 3
    # the music must survive: spectral subtraction gone wrong took 37 dB off everything
    assert abs(after["rms_dbfs"] - before["rms_dbfs"]) < 2.0


# ── dropouts and clicks ───────────────────────────────────────────────────────
def test_dropout_found_but_staccato_playing_is_not(tmp_path):
    y = _music(12.0).copy()
    y[int(5 * SR):int(5 * SR) + int(0.05 * SR)] = 0.0
    assert tape._dropouts(y, SR)["count"] >= 1

    # eighth notes at 120 bpm: gaps everywhere, none of them tape damage
    gated = _music(12.0).copy()
    step = int(0.25 * SR)
    for i in range(0, len(gated) - step, step):
        gated[i + int(step * 0.6):i + step] = 0.0
    assert tape._dropouts(gated, SR)["count"] == 0


def test_clicks_found_and_clean_audio_stays_clean(tmp_path):
    clean = _music(12.0)
    assert tape._clicks(clean, SR)["count"] == 0
    dirty = clean.copy()
    at = [int(x * SR) for x in (2.0, 4.5, 7.25, 9.1)]
    for i in at:
        dirty[i] += 0.3 * (1 if i % 2 else -1)
    assert tape._clicks(dirty, SR)["count"] == len(at)


def test_clicks_ignores_an_inaudible_break(tmp_path):
    """The local scale collapses in a quiet passage, so a -88 dBFS step reads as enormous
    relative to its surroundings. It is still inaudible and not worth a repair."""
    dirty = _music(12.0).copy()
    dirty[int(6 * SR)] += 0.00004
    assert tape._clicks(dirty, SR)["count"] == 0


@pytest.mark.skipif(__import__("shutil").which("ffmpeg") is None, reason="needs ffmpeg")
def test_declick_moves_the_track_back_towards_the_original(tmp_path):
    clean = _music(12.0)
    dirty = clean.copy()
    for i in (int(2.0 * SR), int(5.5 * SR), int(8.25 * SR)):
        dirty[i] += 0.3
    src = _write(tmp_path, dirty)
    r = tape.declick(src, clicks=True)
    assert r["ok"]
    fixed, _, _ = tape._load_mono(r["output"])
    n = min(len(fixed), len(clean))
    before = float(np.sqrt(np.mean((dirty[:n] - clean[:n]) ** 2)))
    after = float(np.sqrt(np.mean((fixed[:n] - clean[:n]) ** 2)))
    assert after < before / 2

    # And it must leave an undamaged track alone. This is the overlap-save check: with
    # ffmpeg's overlap-ADD method the filter moves every sample whether it found damage or
    # not, which on a preservation transfer is unacceptable and silently so.
    untouched = tape.declick(_write(tmp_path, clean, "clean.wav"), clicks=True)
    again, _, _ = tape._load_mono(untouched["output"])
    harm = float(np.sqrt(np.mean((again[:n] - clean[:n]) ** 2)))
    assert harm < after


@pytest.mark.skipif(__import__("shutil").which("ffmpeg") is None, reason="needs ffmpeg")
def test_declip_rebuilds_flat_tops_and_makes_room_for_them(tmp_path):
    """Rebuilt peaks land above full scale. Writing straight to 24-bit integer would clip
    them off again and the repair would do nothing at all."""
    clipped = np.clip(_music(10.0) * 3.0, -1.0, 1.0)
    src = _write(tmp_path, clipped)
    before = tape.analyse_track(src)
    assert before["clipped"] > 1000
    r = tape.declick(src, clicks=False, clips=True)
    assert r["ok"]
    after = tape.analyse_track(r["output"])
    assert after["clipped"] < before["clipped"] / 4
    assert after["peak_dbfs"] <= 0.0


# ── speed, wow and flutter ────────────────────────────────────────────────────
def _warp(y, speed, wow=0.0, wow_hz=0.7, sr=SR):
    """Walk the source at a varying rate: what a wobbling capstan does to the tape."""
    t = np.arange(len(y)) / sr
    rate = speed * (1.0 + wow * np.sin(2 * np.pi * wow_hz * t))
    idx = np.cumsum(rate)
    idx -= idx[0]
    idx = idx[idx < len(y) - 1]
    return np.interp(idx, np.arange(len(y)), y)


def test_speed_error_measured_from_the_hum_line(tmp_path):
    y = _music(20.0) + _hum_tone(20.0, 50.0)
    src = _write(tmp_path, _warp(y, 1.018))
    c = tape.hum_speed_curve(src)
    assert c["ok"]
    assert abs(c["speed_error_pct"] - 1.8) < 0.15


def test_a_steady_file_measures_as_steady(tmp_path):
    """The noise floor of the measurement itself. Without this, a correction that does
    nothing and a correction that works look the same."""
    src = _write(tmp_path, _music(20.0) + _hum_tone(20.0, 50.0))
    c = tape.hum_speed_curve(src)
    assert c["ok"]
    assert abs(c["speed_error_pct"]) < 0.05
    assert c["flutter_pct"] < 0.05


def test_speed_and_flutter_are_corrected(tmp_path):
    y = _music(20.0) + _hum_tone(20.0, 50.0)
    src = _write(tmp_path, _warp(y, 1.018, wow=0.004))
    before = tape.hum_speed_curve(src)
    r = tape.fix_speed(src)
    assert r["ok"] and not r.get("unchanged")
    after = tape.hum_speed_curve(r["output"])
    assert abs(after["speed_error_pct"]) < 0.1
    assert after["flutter_pct"] < before["flutter_pct"] / 2


def test_speed_refuses_politely_without_a_hum_reference(tmp_path):
    src = _write(tmp_path, _music(20.0))
    r = tape.fix_speed(src)
    assert r["ok"] is False
    assert "hum" in r["error"].lower()


# ── session findings ──────────────────────────────────────────────────────────
def test_check_finds_the_misaligned_track(tmp_path):
    base = _music(20.0, seed=1)
    _write(tmp_path, base, "01.wav")
    _write(tmp_path, np.concatenate([np.zeros(int(0.12 * SR)), base]), "02.wav")
    _write(tmp_path, base * 0.9, "03.wav")
    out = tape.check(str(tmp_path))
    assert out["ok"]
    assert any("do not line up" in f["title"] for f in out["findings"])


def test_check_calls_a_silent_track_a_note_not_a_fault(tmp_path):
    """Unused tracks are completely normal on an 8-track reel."""
    _write(tmp_path, _music(10.0), "01.wav")
    _write(tmp_path, np.zeros(int(10 * SR)), "02.wav")
    out = tape.check(str(tmp_path))
    silent = [f for f in out["findings"] if "carry no signal" in f["title"]]
    assert silent and silent[0]["severity"] == "note"


def test_check_is_quiet_on_a_clean_transfer(tmp_path):
    """Three tracks of one performance, captured in one pass, with a quiet run-out.

    The run-out matters: a transfer that plays wall to wall has nowhere to measure a noise
    floor, so the only honest answer about its hiss is the music's own level. Real tape
    always has leader or run-out; a test without it is testing the wrong thing.
    """
    base = _music(14.0, seed=0)
    tail = np.zeros(int(1.5 * SR))
    for i in range(3):
        part = base * (1.0 - 0.1 * i) * np.sin(2 * np.pi * (1 + i) * 0.5
                                               * np.arange(len(base)) / SR) ** 2
        _write(tmp_path, np.concatenate([part, tail]), f"0{i + 1}.wav")
    out = tape.check(str(tmp_path))
    assert out["ok"]
    assert out["clean"], [f["title"] for f in out["findings"]]


# ── preservation ──────────────────────────────────────────────────────────────
def test_audio_md5_covers_the_samples_not_the_file(tmp_path):
    """The whole point: tagging a file later must not invalidate its checksum."""
    src = Path(_write(tmp_path, _music(4.0)))
    first = tape.audio_md5(str(src))
    assert first["scope"] == "audio samples"

    raw = bytearray(src.read_bytes())
    tag = b"ICMT" + struct.pack("<I", 12) + b"tagged later"
    riff = struct.unpack("<I", bytes(raw[4:8]))[0]
    raw[4:8] = struct.pack("<I", riff + len(tag))
    src.write_bytes(bytes(raw) + tag)

    assert src.stat().st_size > len(bytes(raw)) - len(tag)
    assert tape.audio_md5(str(src))["md5"] == first["md5"]


def test_audio_md5_changes_when_the_audio_changes(tmp_path):
    src = _write(tmp_path, _music(4.0))
    first = tape.audio_md5(src)["md5"]
    y, sr = sf.read(src, dtype="float64", always_2d=True)
    y[sr:sr * 2] *= 0.5
    sf.write(src, y, sr, subtype="PCM_24")
    assert tape.audio_md5(src)["md5"] != first


def test_coding_history_is_in_the_ebu_layout(tmp_path):
    src = _write(tmp_path, _music(2.0))
    info = tape.scan(str(tmp_path))["tracks"][0]
    ch = tape.coding_history(info, {"machine": "Tascam 38", "width": "1/2 inch",
                                    "speed": "15 ips", "interface": "RME"})
    lines = ch.split("\r\n")
    assert lines[0].startswith("A=ANALOGUE,M=")
    assert "Tascam 38; 1/2 inch; 15 ips" in lines[0]
    assert lines[1].startswith(f"A=PCM,F={SR},W=24,M=")


def test_manifest_and_verify_round_trip(tmp_path):
    for i in range(3):
        _write(tmp_path, _music(3.0, seed=i), f"0{i + 1}.wav")
    m = tape.manifest(str(tmp_path), tape={"machine": "Tascam 38"}, title="Reel 3",
                      operator="B")
    assert m["ok"]
    for name in m["files"]:
        assert (tmp_path / name).is_file()

    v = tape.verify_manifest(str(tmp_path))
    assert v["all_good"] and not v["changed"]

    y, sr = sf.read(str(tmp_path / "02.wav"), dtype="float64", always_2d=True)
    y[:sr] *= 0.5
    sf.write(str(tmp_path / "02.wav"), y, sr, subtype="PCM_24")
    v2 = tape.verify_manifest(str(tmp_path))
    assert not v2["all_good"] and v2["changed"] == ["02.wav"]


def test_manifest_csv_starts_with_the_column_bwf_metaedit_requires(tmp_path):
    """BWF MetaEdit's --in-core= refuses a CSV whose header does not begin with FileName."""
    _write(tmp_path, _music(2.0), "01.wav")
    tape.manifest(str(tmp_path))
    header = (tmp_path / tape.MANIFEST_CSV).read_text(encoding="utf-8").splitlines()[0]
    assert header.startswith("FileName,")
    assert "CodingHistory" in header


def test_a_repair_records_where_it_came_from(tmp_path):
    src = _write(tmp_path, _music(8.0) + 0.04)
    r = tape.clean(src, dc=True)
    note = Path(r["output"] + ".json")
    assert note.is_file()
    import json
    data = json.loads(note.read_text(encoding="utf-8"))
    assert data["derived_from"] == Path(src).name
    assert data["derived_from_audio_md5"] == tape.audio_md5(src)["md5"]

    m = tape.manifest(str(tmp_path))
    roles = {e["name"]: e["role"] for e in m["tracks"]}
    assert roles[Path(src).name] == "preservation master"
    assert roles[Path(r["output"]).name] == "derived"


def test_verify_without_a_manifest_says_so(tmp_path):
    _write(tmp_path, _music(2.0), "01.wav")
    out = tape.verify_manifest(str(tmp_path))
    assert out["ok"] is False and "manifest" in out["error"].lower()
