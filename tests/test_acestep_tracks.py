"""The multi-track ACE-Step jobs: everything that can be checked without the GPU.

A real layer/accompany/isolate run needs the 4.5 GB base checkpoint and several minutes of
a 12 GB card, so it cannot live in the suite. What CAN live here is every way the call can be
built wrong — and two of those bugs were real:

  * the worker's TASKS map did not list the new names, so a job died with "unknown task"
    before it reached the code that handles it;
  * GenerationParams spells the metadata fields `keyscale` / `timesignature` with no
    underscore, and it is a dataclass, so the underscored spellings used elsewhere in
    ACE-Step's own internals would raise TypeError.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import engines.acestep as eng                                       # noqa: E402

WORKER_PATH = ROOT / "backend" / "engines" / "acestep_worker.py"


def _worker():
    """The worker runs in ACE-Step's own venv, so import it by path, not by package."""
    spec = importlib.util.spec_from_file_location("ace_worker", WORKER_PATH)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ── the engine side ───────────────────────────────────────────────────────────
def test_three_kinds_with_a_template_each():
    assert set(eng.TRACK_TASKS) == {"layer", "accompany", "isolate"}
    for kind, template in eng.TRACK_TASKS.items():
        assert "{track}" in template, f"{kind} template must name the track"
        assert template.endswith(":"), f"{kind}: ACE-Step's instructions end with a colon"


def test_track_list_covers_what_demucs_cannot():
    """The whole point of isolate over Demucs is the instruments Demucs has no stem for."""
    for extra in ("strings", "brass", "woodwinds", "synth", "fx", "backing_vocals"):
        assert extra in eng.TRACK_NAMES
    for demucs_stem in ("vocals", "drums", "bass", "guitar"):
        assert demucs_stem in eng.TRACK_NAMES


def test_instruction_renders_readably():
    assert (eng.TRACK_TASKS["layer"].format(track="guitar")
            == "Generate the guitar track based on the audio context:")
    assert (eng.TRACK_TASKS["accompany"].format(track="drums, bass")
            == "Complete the input track with drums, bass:")
    assert (eng.TRACK_TASKS["isolate"].format(track="vocals")
            == "Extract the vocals track from the audio:")


def test_unknown_kind_and_track_are_refused():
    with pytest.raises(eng.AceStepError, match="Unknown track job"):
        eng.track_job("remix", "x.mp3", "guitar")
    with pytest.raises(eng.AceStepError, match="banjo"):
        eng.track_job("layer", "x.mp3", "banjo")


def test_base_weights_check_points_at_the_right_model():
    """xl-base is the 4B model that needs 24 GB; this must be the 2B one."""
    assert eng.BASE_MODEL == "acestep-v15-base"
    assert "xl" not in eng.BASE_MODEL
    assert isinstance(eng.base_weights_present(), bool)


# ── the worker side ───────────────────────────────────────────────────────────
def test_worker_dispatches_every_new_task():
    """The bug this catches: the names existed everywhere except the TASKS map, so a job
    failed with 'unknown task layer' before any of the new code ran."""
    w = _worker()
    for name in ("layer", "accompany", "isolate"):
        assert name in w.TASKS, f"{name} is not dispatched by the worker"
        assert w.TASKS[name] is w.task_generate
    assert set(w.BASE_TASKS) == set(eng.TRACK_TASKS), "engine and worker disagree on the kinds"


def test_worker_and_engine_use_identical_instructions():
    w = _worker()
    for kind, template in eng.TRACK_TASKS.items():
        assert w.BASE_TASKS[kind]["template"] == template
    assert tuple(w.TRACK_NAMES) == tuple(eng.TRACK_NAMES)


def test_metadata_fields_have_no_underscore():
    """GenerationParams is a dataclass: `key_scale=` would be a TypeError, not a no-op."""
    w = _worker()
    got = w._musical_metadata({"bpm": 128, "keyscale": "C major", "timesignature": "4/4"})
    assert got == {"bpm": 128, "keyscale": "C major", "timesignature": "4/4"}
    assert "key_scale" not in got and "time_signature" not in got


def test_metadata_drops_nonsense_rather_than_sending_it():
    w = _worker()
    assert w._musical_metadata({}) == {}
    assert w._musical_metadata({"bpm": 0}) == {}
    assert w._musical_metadata({"bpm": 9000}) == {}          # outside the documented 30-300
    assert w._musical_metadata({"bpm": "fast"}) == {}
    assert w._musical_metadata({"keyscale": "   "}) == {}
    assert w._musical_metadata({"bpm": 128})["bpm"] == 128


def test_metadata_is_json_safe_for_the_subprocess():
    """The job crosses a process boundary as JSON, so numpy or Decimal would die there."""
    import json
    w = _worker()
    json.dumps(w._musical_metadata({"bpm": 120, "keyscale": "A minor"}))


# ── the router's song lookup ──────────────────────────────────────────────────
def test_song_metadata_reads_bpm_and_key_from_the_job_record(monkeypatch):
    import types
    import routers.acestep as r

    fake = types.SimpleNamespace(jobs={
        "abc": {"file": "/outputs/Tacos_d911a5af.mp3", "bpm": 128, "key": "C major"},
        "def": {"file": "/outputs/other.mp3", "bpm": 90, "key": "A minor"},
    })
    monkeypatch.setitem(sys.modules, "app", fake)
    assert r._song_metadata("Tacos_d911a5af.mp3") == {"bpm": 128, "keyscale": "C major"}
    assert r._song_metadata("/outputs/other.mp3") == {"bpm": 90, "keyscale": "A minor"}


def test_song_metadata_is_quiet_when_it_knows_nothing(monkeypatch):
    """An imported MP3 has no job record, and an old song may have no BPM. Neither is a
    reason to refuse the rewrite, so this returns {} rather than raising."""
    import types
    import routers.acestep as r

    monkeypatch.setitem(sys.modules, "app", types.SimpleNamespace(jobs={
        "abc": {"file": "/outputs/known.mp3"},                 # no bpm, no key
    }))
    assert r._song_metadata("known.mp3") == {}
    assert r._song_metadata("never-seen.mp3") == {}
    assert r._song_metadata("") == {}
