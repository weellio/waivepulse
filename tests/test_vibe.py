"""Tests for backend/analyze.py — the Generate page's three entry points.

Run either way::

    F:\\HeartMuLa\\venv\\Scripts\\python.exe tests\\test_vibe.py
    F:\\HeartMuLa\\venv\\Scripts\\python.exe -m pytest tests/test_vibe.py -q

Plain asserts, no fixtures. The first group never touches a model: it feeds
made-up measurements and made-up CLAP probabilities through the pure mapping.
The CLAP group builds its own audio (a four-on-the-floor loop and a plucked
acoustic strum) and is skipped if the weights are not cached yet.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import analyze                                   # noqa: E402


# ── the real vocabulary, read from the page that owns it ───────────────────────
def tag_categories():
    src = (ROOT / "frontend" / "js" / "index" / "state.js").read_text(encoding="utf-8")
    block = src.split("export const TAG_CATEGORIES = [", 1)[1].split("\n];", 1)[0]
    cats = {}
    for m in re.finditer(r'label:\s*"([^"]+)".*?tags:\s*\[(.*?)\]\s*\}', block, re.S):
        cats[m.group(1)] = re.findall(r'"([^"]+)"', m.group(2))
    return cats


CATS = tag_categories()

ELECTRONIC_FEATURES = {
    "centroid_hz": 3400.0, "rolloff_hz": 9800.0, "flatness": 0.028,
    "bandwidth_hz": 3100.0, "zcr": 0.10, "crest": 2.1, "percussive_ratio": 0.42,
    "onset_rate": 4.1, "grid_jitter": 0.02, "sub_energy": 0.040,
    "low_energy": 0.22, "high_energy": 0.16, "stereo_width": 0.30,
    "duration": 120.0,
}
ACOUSTIC_FEATURES = {
    "centroid_hz": 1700.0, "rolloff_hz": 6200.0, "flatness": 0.004,
    "bandwidth_hz": 1900.0, "zcr": 0.06, "crest": 3.4, "percussive_ratio": 0.30,
    "onset_rate": 1.8, "grid_jitter": 0.22, "sub_energy": 0.003,
    "low_energy": 0.15, "high_energy": 0.015, "stereo_width": 0.10,
    "duration": 120.0,
}


def ranked(pairs):
    return sorted(pairs, key=lambda kv: kv[1], reverse=True)


def test_mapping_never_calls_an_electronic_clip_acoustic_folk():
    """CLAP is mildly wrong (folk slightly ahead); the spectrum says electronic.
    The mapping must not hand back 'folk'."""
    scores = {
        "Genre": ranked([("folk", 0.21), ("edm", 0.20), ("dance", 0.18),
                         ("acoustic", 0.11), ("electronic", 0.10), ("pop", 0.08),
                         ("country", 0.07), ("rock", 0.05)]),
        "_axis": [("electronic", 0.93), ("acoustic", 0.07)],
    }
    out = analyze.map_to_tags(ELECTRONIC_FEATURES, scores, CATS, bpm=128, key="A minor")
    genre = [p["tag"] for p in out["picks"] if p["category"] == "Genre"]
    assert genre, "a genre must always be picked"
    assert genre[0] not in analyze.ACOUSTIC_GENRES, (
        "an electronic clip came back as %s" % genre[0])
    assert genre[0] in ("edm", "dance", "electronic")
    assert "128 BPM" in out["why"] and "A minor" in out["why"]
    assert "electronic-leaning" in out["why"]


def test_mapping_keeps_acoustic_material_acoustic():
    scores = {
        "Genre": ranked([("folk", 0.24), ("edm", 0.22), ("acoustic", 0.18),
                         ("dance", 0.12), ("pop", 0.10)]),
        "_axis": [("electronic", 0.05), ("acoustic", 0.95)],
    }
    out = analyze.map_to_tags(ACOUSTIC_FEATURES, scores, CATS, bpm=92, key="G major")
    genre = [p["tag"] for p in out["picks"] if p["category"] == "Genre"][0]
    assert genre not in analyze.ELECTRONIC_GENRES, genre
    assert "acoustic-leaning" in out["why"]
    assert "sparse" in out["why"]


def test_nudge_is_bounded_not_a_veto():
    """A confident CLAP genre must survive a contrary spectrum reading."""
    scores = {
        "Genre": ranked([("folk", 0.90), ("edm", 0.04), ("pop", 0.03)]),
        "_axis": [("electronic", 0.99), ("acoustic", 0.01)],
    }
    out = analyze.map_to_tags(ELECTRONIC_FEATURES, scores, CATS)
    assert [p["tag"] for p in out["picks"] if p["category"] == "Genre"] == ["folk"]


def test_one_pick_per_category_and_all_tags_are_real():
    scores = {
        "Genre": ranked([("pop", 0.4), ("rock", 0.2)]),
        "Mood": ranked([("upbeat", 0.5), ("happy", 0.3)]),
        "Instrument": ranked([("piano", 0.4), ("drums", 0.2)]),
        "Gender": ranked([("female vocals", 0.6), ("male vocals", 0.2)]),
        "_axis": [("electronic", 0.5), ("acoustic", 0.5)],
    }
    out = analyze.map_to_tags(ELECTRONIC_FEATURES, scores, CATS, bpm=120, key="C major")
    cats = [p["category"] for p in out["picks"]]
    assert len(cats) == len(set(cats)), "two picks landed in one category: %s" % cats
    for p in out["picks"] + out["extras"]:
        assert p["tag"] in CATS[p["category"]], (p["category"], p["tag"])
        assert 0 <= p["confidence"] <= 100
    assert set(out["skipped"]) == {"Scene", "Region", "Topic"}


def test_timbre_comes_from_the_spectrum():
    assert analyze.brightness_word(ELECTRONIC_FEATURES) == "bright"
    assert analyze.brightness_word(ACOUSTIC_FEATURES) == "warm"
    dark = dict(ACOUSTIC_FEATURES, centroid_hz=800.0)
    assert analyze.brightness_word(dark) == "dark"
    fuzz = dict(ELECTRONIC_FEATURES, flatness=0.05, zcr=0.2)
    assert analyze.brightness_word(fuzz) == "distorted"
    assert analyze.density_word(ELECTRONIC_FEATURES) in ("full", "thick")
    assert analyze.density_word(ACOUSTIC_FEATURES) in ("thin", "airy", "rich")


def test_electronicness_proxy_orders_the_two_extremes():
    assert analyze.electronicness(ELECTRONIC_FEATURES) > analyze.electronicness(ACOUSTIC_FEATURES)


def test_scene_tags_are_filtered_to_the_vocabulary():
    picks = analyze.filter_to_vocabulary(
        ["Synthwave", "neon-drenched", "female vocals", "edm", "#nostalgic", "piano"],
        CATS)
    pairs = [(p["category"], p["tag"]) for p in picks]
    assert ("Genre", "synthwave") in pairs          # canonical lower-case spelling
    assert ("Gender", "female vocals") in pairs
    assert ("Mood", "nostalgic") in pairs
    assert ("Instrument", "piano") in pairs
    assert not any(t == "neon-drenched" for _c, t in pairs), "invented tag got through"
    assert len([c for c, _t in pairs if c == "Genre"]) == 1, "two genres got through"


def test_filter_accepts_a_comma_string():
    picks = analyze.filter_to_vocabulary("rock, dark, male vocals", CATS)
    assert [p["tag"] for p in picks] == ["rock", "dark", "male vocals"]


# ── tiers ─────────────────────────────────────────────────────────────────────
def test_balanced_tier_is_exactly_todays_behaviour():
    """If this drifts, every existing song silently changes sound."""
    b = analyze.TIERS["balanced"]
    assert (b["temperature"], b["cfg_scale"], b["topk"]) == (1.0, 1.5, 50), \
        "app.py's GenerateRequest defaults are temperature 1.0 / cfg 1.5 / topk 50"
    assert (b["num_steps"], b["guidance_scale"]) == (10, 1.25), \
        "heartlib's detokenize defaults are num_steps 10 / guidance_scale 1.25"


def test_app_defaults_still_match_the_balanced_tier():
    src = (ROOT / "backend" / "app.py").read_text(encoding="utf-8")
    for field, value in (("temperature", "1.0"), ("cfg_scale", "1.5"), ("topk", "50")):
        assert re.search(rf"{field}:\s+Optional\[\w+\]\s*=\s*{re.escape(value)}", src), \
            f"app.py no longer defaults {field} to {value}"


def test_quick_tier_turns_classifier_free_guidance_off():
    """cfg_scale == 1.0 is what makes it fast: heartlib runs the language model at
    batch 1 instead of batch 2."""
    assert analyze.TIERS["quick"]["cfg_scale"] == 1.0
    assert analyze.TIERS["quick"]["num_steps"] < analyze.TIERS["balanced"]["num_steps"]


def test_deep_and_wild_move_the_right_knobs():
    deep, wild, bal = (analyze.TIERS[k] for k in ("deep", "wild", "balanced"))
    assert deep["num_steps"] > bal["num_steps"]
    assert deep["guidance_scale"] > bal["guidance_scale"]
    assert wild["temperature"] > bal["temperature"]
    assert wild["cfg_scale"] < bal["cfg_scale"]


def test_set_tier_rejects_nonsense():
    try:
        analyze.set_tier("ludicrous")
    except ValueError:
        pass
    else:
        raise AssertionError("set_tier accepted a tier that does not exist")
    assert analyze.set_tier("Deep") == "deep"
    assert analyze.set_tier("custom") == "custom"
    analyze.set_tier(analyze.DEFAULT_TIER)


# ── CLAP, on audio built right here (skipped if the weights are not cached) ────
def clap_cached():
    try:
        return bool(analyze._clap_path(download=False))
    except Exception:
        return False


def four_on_the_floor(seconds=10, sr=48000):
    import numpy as np
    rng = np.random.default_rng(1)
    t = np.arange(sr * seconds) / sr
    y = np.zeros(len(t), dtype="float32")
    for i in range(seconds * 2):                      # 120 BPM kick + hat
        s = int(i * 0.5 * sr)
        n = int(0.14 * sr)
        env = np.exp(-np.linspace(0, 10, n))
        f = np.linspace(120, 45, n)
        y[s:s + n] += (0.9 * env * np.sin(2 * np.pi * np.cumsum(f) / sr)).astype("float32")
        hs = s + int(0.25 * sr)
        y[hs:hs + 3000] += (0.25 * rng.standard_normal(3000)
                            * np.exp(-np.linspace(0, 9, 3000))).astype("float32")
    y += (0.12 * (2 * (np.mod(55 * t, 1.0) - 0.5))).astype("float32")   # saw bass
    return y


def acoustic_strum(seconds=10, sr=48000):
    import numpy as np
    y = np.zeros(sr * seconds, dtype="float32")
    for i in range(seconds * 2):
        s = int(i * 0.5 * sr)
        n = int(0.5 * sr)
        env = np.exp(-np.linspace(0, 6, n))
        for f in (196.0, 246.9, 293.7, 392.0):
            ph = 2 * np.pi * f * np.arange(n) / sr
            y[s:s + n] += (0.12 * env * np.sin(ph)).astype("float32")
            y[s:s + n] += (0.04 * env * np.sin(2 * ph)).astype("float32")
    return y


def test_clap_calls_a_four_on_the_floor_loop_electronic():
    if not clap_cached():
        print("   (skipped: CLAP weights not cached)")
        return
    scores = analyze.clap_scores(four_on_the_floor(), CATS)
    axis = dict(scores["_axis"])
    assert axis["electronic"] > axis["acoustic"], axis
    genre = scores["Genre"][0][0]
    assert genre not in analyze.ACOUSTIC_GENRES, (
        "a synthetic four-on-the-floor loop came back as %r" % genre)
    out = analyze.map_to_tags(ELECTRONIC_FEATURES, scores, CATS, bpm=120, key="A minor")
    picked = [p["tag"] for p in out["picks"] if p["category"] == "Genre"][0]
    assert picked not in analyze.ACOUSTIC_GENRES, picked
    assert picked != "folk"


def test_clap_calls_a_plucked_strum_acoustic():
    if not clap_cached():
        print("   (skipped: CLAP weights not cached)")
        return
    scores = analyze.clap_scores(acoustic_strum(), CATS)
    axis = dict(scores["_axis"])
    assert axis["acoustic"] > axis["electronic"], axis


def test_clap_hears_whether_anyone_is_singing():
    if not clap_cached():
        print("   (skipped: CLAP weights not cached)")
        return
    scores = analyze.clap_scores(four_on_the_floor(), CATS)
    gender = dict(scores["Gender"])
    assert gender["instrumental"] + gender["no vocals"] > gender["female vocals"], gender


# ── runner ────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        try:
            fn()
            print("  ok   %s" % name)
        except Exception as exc:
            failed += 1
            print("  FAIL %s: %s: %s" % (name, type(exc).__name__, exc))
    print("\n%d/%d passed" % (len(tests) - failed, len(tests)))
    sys.exit(1 if failed else 0)
