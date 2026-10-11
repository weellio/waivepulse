"""Building a LoKr training set out of the song library.

Training is a GPU job measured in hours, so it cannot run in the suite. The dataset step
can, and it is where a quiet mistake does the most damage: a song exported with a wrong or
invented caption, tempo or key teaches the model that wrong thing, and you only find out
after the training run.
"""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import lokr                                                         # noqa: E402


def rec(**kw):
    base = {"status": "done", "file": "/outputs/song.mp3", "title": "Song",
            "tags": "rock, male vocals", "lyrics": "[Verse]\nwords here"}
    base.update(kw)
    return base


@pytest.fixture
def library(tmp_path):
    """Three usable songs plus the three ways a song is not usable."""
    out = tmp_path / "outputs"
    out.mkdir()
    jobs = {}
    for i in range(3):
        name = f"good{i}.mp3"
        (out / name).write_bytes(b"\xff\xfb\x90" + b"\0" * 64)      # enough to be a file
        jobs[f"g{i}"] = rec(file=f"/outputs/{name}", title=f"Good {i}",
                            bpm=100 + i, key="C major")
    (out / "notags.mp3").write_bytes(b"\0" * 32)
    jobs["notags"] = rec(file="/outputs/notags.mp3", title="No Tags", tags="")
    (out / "nolyrics.mp3").write_bytes(b"\0" * 32)
    jobs["nolyrics"] = rec(file="/outputs/nolyrics.mp3", title="No Lyrics", lyrics="")
    jobs["unfinished"] = rec(file=None, title="Still Going", status="generating")
    return jobs, out


# ── planning ──────────────────────────────────────────────────────────────────
def test_plan_separates_usable_from_unusable(library):
    jobs, _ = library
    p = lokr.plan(jobs)
    assert p["count"] == 3
    whys = {s["title"]: s["why"] for s in p["skipped"]}
    assert "No Tags" in whys and "caption" in whys["No Tags"]
    assert "No Lyrics" in whys and "lyrics" in whys["No Lyrics"]
    assert "Still Going" in whys


def test_an_instrumental_does_not_need_lyrics(library):
    jobs, _ = library
    jobs["inst"] = rec(file="/outputs/good0.mp3", title="Inst", lyrics="", instrumental=True)
    titles = [u["title"] for u in lokr.plan(jobs)["usable"]]
    assert "Inst" in titles


def test_too_few_songs_is_said_plainly(library):
    jobs, _ = library
    p = lokr.plan(jobs, job_ids=["g0"])
    assert not p["enough"]
    assert any("too few" in n for n in p["notes"])


def test_caption_comes_from_the_tags_that_made_the_song(library):
    jobs, _ = library
    jobs["g0"]["tags"] = "rock,  male vocals ,anthemic"
    assert lokr.describe(jobs["g0"]) == "rock, male vocals, anthemic"


def test_caption_is_not_padded_with_title_or_artist(library):
    """Title and artist are not descriptions of the sound, and putting them in the caption
    teaches the model to associate a name with a style it never heard."""
    jobs, _ = library
    jobs["g0"].update(title="Tacos", artist="Grandrooster", tags="rock")
    cap = lokr.describe(jobs["g0"])
    assert "Tacos" not in cap and "Grandrooster" not in cap


# ── language ──────────────────────────────────────────────────────────────────
def test_language_is_english_only_when_the_lyrics_look_it():
    assert lokr._language_of("Morning light across the kitchen floor") == "en"
    assert lokr._language_of("ナユタン星からの物体") is None
    assert lokr._language_of("") is None
    assert lokr._language_of("12345 !!!") is None


# ── export ────────────────────────────────────────────────────────────────────
def test_export_writes_the_three_files_per_song(library, tmp_path):
    jobs, out = library
    dest = tmp_path / "ds"
    r = lokr.export(jobs, out, dest, measure=False)
    assert r["count"] == 3
    for w in r["written"]:
        assert (dest / f"{w['stem']}.mp3").exists()
        assert (dest / f"{w['stem']}.lyrics.txt").exists()
        meta = json.loads((dest / f"{w['stem']}.json").read_text(encoding="utf-8"))
        assert meta["caption"]
        assert meta["bpm"] in (100, 101, 102)
        assert meta["keyscale"] == "C major"


def test_export_never_invents_a_tempo_or_key(library, tmp_path):
    """The tutorial is explicit that guessed BPM/key are worse than absent ones, so an
    unknown value must be left out of the JSON entirely."""
    jobs, out = library
    for j in jobs.values():
        j.pop("bpm", None)
        j.pop("key", None)
    r = lokr.export(jobs, out, tmp_path / "ds", measure=False)
    for w in r["written"]:
        meta = json.loads((Path(r["dest"]) / f"{w['stem']}.json").read_text(encoding="utf-8"))
        assert "bpm" not in meta
        assert "keyscale" not in meta


def test_export_keeps_section_markers(library, tmp_path):
    """[Verse] and [Chorus] are structure tags the scanner understands, not noise."""
    jobs, out = library
    jobs["g0"]["lyrics"] = "[Verse]\nline one\n\n[Chorus]\nline two"
    r = lokr.export(jobs, out, tmp_path / "ds", measure=False)
    stem = next(w["stem"] for w in r["written"] if w["title"] == "Good 0")
    text = (Path(r["dest"]) / f"{stem}.lyrics.txt").read_text(encoding="utf-8")
    assert "[Verse]" in text and "[Chorus]" in text


def test_filenames_survive_a_hostile_title(library, tmp_path):
    jobs, out = library
    jobs["g0"]["title"] = '../../etc/pwn "weird" *name*'
    r = lokr.export(jobs, out, tmp_path / "ds", measure=False)
    for w in r["written"]:
        assert "/" not in w["stem"] and "\\" not in w["stem"] and ".." not in w["stem"]
        assert (Path(r["dest"]) / f"{w['stem']}.mp3").parent == Path(r["dest"])


def test_a_missing_audio_file_is_skipped_not_crashed(library, tmp_path):
    jobs, out = library
    (out / "good1.mp3").unlink()
    r = lokr.export(jobs, out, tmp_path / "ds", measure=False)
    assert r["count"] == 2
    assert any("gone from disk" in s.get("why", "") for s in r["skipped"])


def test_export_is_rerunnable(library, tmp_path):
    jobs, out = library
    dest = tmp_path / "ds"
    first = lokr.export(jobs, out, dest, measure=False)
    second = lokr.export(jobs, out, dest, measure=False)
    assert first["count"] == second["count"] == 3
    assert len(list(dest.glob("*.mp3"))) == 3           # no duplicates piling up
