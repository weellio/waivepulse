"""The non-GPU half of LoKr training: paths, adapter discovery, and refusals.

A real run is hours on the card, so what is testable here is everything around it — and
that is where this feature's bugs actually were. Each test below corresponds to a mistake
that shipped briefly and failed silently.
"""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import engines.acestep as eng                                       # noqa: E402


# ── paths ─────────────────────────────────────────────────────────────────────
def test_training_lives_next_to_the_checkpoints_not_on_c():
    """Everything big belongs on the drive ACE-Step already uses."""
    p = eng.train_paths("mystyle")
    assert p["base"].parent == eng.TRAIN_ROOT
    assert eng.TRAIN_ROOT.parent == eng.ACE_ROOT
    for key in ("dataset", "tensors", "output"):
        assert str(p[key]).startswith(str(p["base"]))


def test_a_hostile_style_name_cannot_escape_the_training_root():
    for bad in ("../../etc", "a/b", r"a\b", "../..", "  ", "!!!"):
        p = eng.train_paths(bad)
        assert ".." not in p["name"] and "/" not in p["name"] and "\\" not in p["name"]
        assert p["base"].parent == eng.TRAIN_ROOT


def test_an_empty_name_still_produces_a_usable_folder():
    assert eng.train_paths("")["name"] == "mystyle"


# ── adapter discovery ─────────────────────────────────────────────────────────
def _fake_run(tmp_root, name, files):
    base = tmp_root / name
    (base / "dataset").mkdir(parents=True)
    for i in range(3):
        (base / "dataset" / f"s{i}.json").write_text("{}", encoding="utf-8")
    ck = base / "adapter" / "checkpoints" / "epoch_3_loss_0.01"
    ck.mkdir(parents=True)
    for fname, size in files:
        (ck / fname).write_bytes(b"\0" * size)
    return base


def test_discovery_returns_the_weights_not_the_resume_state(tmp_path, monkeypatch):
    """The bug: every checkpoint folder also holds training_state.pt, which is written
    last and so is the newest file. Picking by mtime handed back the optimizer state, and
    load_lora() cannot read that."""
    monkeypatch.setattr(eng, "TRAIN_ROOT", tmp_path)
    _fake_run(tmp_path, "mystyle", [("lokr_weights.safetensors", 1000),
                                    ("training_state.pt", 9000)])
    # make the resume state unambiguously newer
    import os, time
    ck = next(tmp_path.rglob("training_state.pt"))
    os.utime(ck, (time.time() + 60, time.time() + 60))

    found = eng.list_adapters()
    assert len(found) == 1
    assert Path(found[0]["file"]).name == "lokr_weights.safetensors"
    assert found[0]["songs"] == 3


def test_a_run_with_no_weights_yet_is_not_listed(tmp_path, monkeypatch):
    monkeypatch.setattr(eng, "TRAIN_ROOT", tmp_path)
    _fake_run(tmp_path, "halfdone", [("training_state.pt", 100)])
    assert eng.list_adapters() == []


def test_no_training_root_at_all_is_not_an_error(tmp_path, monkeypatch):
    monkeypatch.setattr(eng, "TRAIN_ROOT", tmp_path / "nothing-here")
    assert eng.list_adapters() == []


# ── refusals ──────────────────────────────────────────────────────────────────
def test_preprocess_refuses_without_a_dataset(tmp_path, monkeypatch):
    monkeypatch.setattr(eng, "TRAIN_ROOT", tmp_path)
    monkeypatch.setattr(eng, "available", lambda check_vram=True: (True, "ok"))
    with pytest.raises(eng.AceStepError, match="No dataset"):
        eng.lokr_preprocess("mystyle")


def test_training_refuses_without_tensors(tmp_path, monkeypatch):
    monkeypatch.setattr(eng, "TRAIN_ROOT", tmp_path)
    monkeypatch.setattr(eng, "available", lambda check_vram=True: (True, "ok"))
    (tmp_path / "mystyle" / "tensors").mkdir(parents=True)
    with pytest.raises(eng.AceStepError, match="No tensors"):
        eng.lokr_train("mystyle")


def test_both_refuse_when_acestep_is_not_installed(tmp_path, monkeypatch):
    monkeypatch.setattr(eng, "TRAIN_ROOT", tmp_path)
    monkeypatch.setattr(eng, "available", lambda check_vram=True: (False, "not installed"))
    for call in (eng.lokr_preprocess, eng.lokr_train):
        with pytest.raises(eng.AceStepError, match="not installed"):
            call("mystyle")


# ── the worker's side ─────────────────────────────────────────────────────────
def _worker():
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "ace_worker", ROOT / "backend" / "engines" / "acestep_worker.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_worker_dispatches_the_training_tasks():
    w = _worker()
    for name in ("lokr_preprocess", "lokr_train"):
        assert name in w.TASKS, f"{name} is not dispatched"


def test_lokr_uses_its_own_learning_rate_not_lora_s():
    """LoKr's default is 0.03; LoRA's 1e-4 is three orders of magnitude too small and would
    look like training that runs fine and learns nothing."""
    import inspect
    sig = inspect.signature(eng.lokr_train)
    assert sig.parameters["learning_rate"].default == 0.03
    assert sig.parameters["gradient_checkpointing"].default is True


def test_generate_accepts_a_trained_adapter():
    """Without this the trained file has nothing that can play it: the Generate page runs
    HeartMuLa, which cannot load a LoKr."""
    import inspect
    sig = inspect.signature(eng.generate)
    assert "adapter" in sig.parameters
    assert "adapter_scale" in sig.parameters
