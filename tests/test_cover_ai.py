"""Tests for backend/cover_ai.py - the optional local AI art layer.

Run either way::

    F:\\HeartMuLa\\venv\\Scripts\\python.exe tests\\test_cover_ai.py
    F:\\HeartMuLa\\venv\\Scripts\\python.exe -m pytest tests/test_cover_ai.py -q

Most tests are pure and take milliseconds. The two that actually paint an image
are skipped automatically when the GPU is busy or ComfyUI is not installed, so
this file is safe to run while HeartMuLa or Demucs owns the card.

Set WAIVEPULSE_COVER_AI_SLOW=0 to skip the GPU tests even when it is free.
"""

import io
import json
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import cover_ai  # noqa: E402

STYLE = {
    "direction": "", "genre": "sea shanty", "mood": "epic",
    "tags": ["celtic", "male vocals", "fiddle"], "title": "Tarot Pigs",
    "palette": ["#1a2648", "#cea82e", "#ece0c6"],
}


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #

class patched:
    """Tiny monkeypatch context manager so the file needs no pytest fixtures."""

    def __init__(self, target, name, value):
        self.t, self.n, self.v = target, name, value

    def __enter__(self):
        self.old = getattr(self.t, self.n)
        setattr(self.t, self.n, self.v)
        return self

    def __exit__(self, *a):
        setattr(self.t, self.n, self.old)
        return False


def gpu_ready():
    """Is a real render possible and wanted right now?"""
    if os.environ.get("WAIVEPULSE_COVER_AI_SLOW", "1") in ("0", "off", "no"):
        return False, "slow tests disabled"
    ok, why = cover_ai.available()
    return ok, why


_AI_ENV = ("WAIVEPULSE_COVER_AI", "WAIVEPULSE_COMFY_ROOT", "WAIVEPULSE_COVER_AI_MODEL",
           "WAIVEPULSE_COVER_AI_MODEL_DIR", "WAIVEPULSE_COVER_AI_PORT",
           "WAIVEPULSE_COVER_AI_MIN_VRAM")


class fresh_machine:
    """Pretend this box has never seen ComfyUI: no env, no config, empty disks.

    Points the config file at a throwaway folder, empties the search roots and
    drops every cache, so detection has nothing whatsoever to find.
    """

    def __init__(self, roots=None, config=None):
        self.roots, self.config = roots, config

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="wp_cover_ai_test_")
        self.saved_env = {k: os.environ.pop(k, None) for k in _AI_ENV}
        self.saved = {"CONFIG_PATH": cover_ai.CONFIG_PATH,
                      "_DATA_DIR": cover_ai._DATA_DIR,
                      "_search_roots": cover_ai._search_roots,
                      "_PATHS_YAML": cover_ai._PATHS_YAML}
        cover_ai._DATA_DIR = os.path.join(self.tmp, "data")
        cover_ai.CONFIG_PATH = self.config or os.path.join(cover_ai._DATA_DIR, "cover_ai.json")
        cover_ai._PATHS_YAML = os.path.join(self.tmp, "extra_model_paths.yaml")
        empty = os.path.join(self.tmp, "empty")
        os.makedirs(empty, exist_ok=True)
        cover_ai._search_roots = lambda: (self.roots if self.roots is not None else [(empty, 2)])
        cover_ai.invalidate()
        cover_ai.load_config(refresh=True)
        return self

    def __exit__(self, *a):
        for k, v in self.saved.items():
            setattr(cover_ai, k, v)
        for k, v in self.saved_env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        cover_ai.invalidate()
        cover_ai.load_config(refresh=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        return False


def fake_comfy(base, kind="portable"):
    """Build a directory tree that looks exactly like a ComfyUI install."""
    if kind == "portable":
        root = os.path.join(base, "ComfyUI_windows_portable")
        inner = os.path.join(root, "ComfyUI")
        py = os.path.join(root, "python_embeded", "python.exe" if os.name == "nt" else "bin/python3")
    else:
        root = inner = os.path.join(base, "ComfyUI")
        py = None
    os.makedirs(os.path.join(inner, "comfy"), exist_ok=True)
    os.makedirs(os.path.join(inner, "models", "checkpoints"), exist_ok=True)
    open(os.path.join(inner, "main.py"), "w").close()
    if py:
        os.makedirs(os.path.dirname(py), exist_ok=True)
        open(py, "w").close()
    return root


def fake_checkpoints(folder, names):
    os.makedirs(folder, exist_ok=True)
    for n in names:
        with open(os.path.join(folder, n), "wb") as f:
            f.write(b"\0" * 1024)
    return folder


# --------------------------------------------------------------------------- #
# nothing installed: detection is quiet, honest and never raises
# --------------------------------------------------------------------------- #

def test_detection_finds_nothing_cleanly_on_a_fresh_machine():
    with fresh_machine():
        det = cover_ai.detect(rescan=True)
        assert det["install"] is None
        assert det["installs"] == [] and det["checkpoints"] == []
        assert cover_ai._install() is None
        assert cover_ai._checkpoint_path() is None
        assert cover_ai.write_paths_yaml() is None


def test_nothing_raises_when_comfyui_is_absent():
    with fresh_machine():
        ok, why = cover_ai.available()
        assert ok is False and isinstance(why, str)
        cover_ai.warmup()
        cover_ai.shutdown()
        assert cover_ai.background(1, 512, STYLE, timeout=10) is None
        info = cover_ai.setup_info()
        assert info["ok"] is True and info["available"] is False
        assert info["comfy"]["found"] is False
        assert info["needs"], "the panel must say what to install"
        res = cover_ai.test_render(size=512, timeout=10)
        assert res["ok"] is False and res["note"]


def test_the_missing_comfyui_reason_is_plain_words():
    with fresh_machine():
        ok, why = cover_ai.available()
        assert ok is False
        low = why.lower()
        assert "comfyui not found" in low
        assert "rescan" in low and "github.com" in low
        for jargon in ("traceback", "none", "errno", "%s", "exception"):
            assert jargon not in low, why
        # a path somebody typed is quoted back at them instead
        os.environ["WAIVEPULSE_COMFY_ROOT"] = os.path.join(self_tmp(), "nope")
        try:
            cover_ai.invalidate()
            ok2, why2 = cover_ai.available()
        finally:
            del os.environ["WAIVEPULSE_COMFY_ROOT"]
        assert ok2 is False and "nope" in why2 and "set up ai covers" in why2.lower()


def self_tmp():
    return tempfile.gettempdir()


def test_every_unavailable_reason_reads_as_a_sentence():
    with fresh_machine():
        reasons = [cover_ai.available()[1]]
        os.environ["WAIVEPULSE_COVER_AI"] = "0"
        try:
            reasons.append(cover_ai.available()[1])
        finally:
            del os.environ["WAIVEPULSE_COVER_AI"]
        with patched(cover_ai, "_install", lambda *a, **k: {"root": "r", "cwd": "r",
                                                           "main": "m", "python": "p",
                                                           "python_source": "x", "kind": "y"}), \
             patched(cover_ai, "_checkpoint_path", lambda: "c.safetensors"), \
             patched(cover_ai, "vram_free_mb", lambda: None):
            reasons.append(cover_ai.available()[1])
        for r in reasons:
            assert r, "an empty reason tells nobody anything"
            assert len(r.split()) >= 4, "not a sentence: %r" % r
            for jargon in ("{", "\\n", "Traceback", "errno", "0x"):
                assert jargon not in r, r


# --------------------------------------------------------------------------- #
# detection finds a real install without anybody typing a path
# --------------------------------------------------------------------------- #

def test_detection_finds_a_portable_install_under_a_search_root():
    with fresh_machine() as fm:
        box = os.path.join(fm.tmp, "disk")
        root = fake_comfy(box)
        fake_checkpoints(os.path.join(box, "stable-diffusion-webui", "models", "Stable-diffusion"),
                         ["someXL_v3.safetensors"])
        cover_ai._search_roots = lambda: [(box, 2)]
        cover_ai.invalidate()
        with patched(cover_ai, "MIN_CKPT_MB", 0):
            det = cover_ai.detect(rescan=True)
        assert det["install"] is not None
        assert os.path.normcase(det["install"]["root"]) == os.path.normcase(root)
        assert det["install"]["kind"] in ("portable", "nested")
        names = [c["name"] for c in det["checkpoints"]]
        assert "someXL_v3.safetensors" in names, names


def test_detection_understands_a_plain_git_checkout():
    with fresh_machine() as fm:
        box = os.path.join(fm.tmp, "opt")
        root = fake_comfy(box, kind="checkout")
        rec = cover_ai._install_at(root)
        assert rec is not None and rec["kind"] in ("checkout", "portable", "nested")
        assert rec["python"], "a checkout still needs an interpreter to run with"
        # pointing at the inner folder of a portable install works too
        port = fake_comfy(os.path.join(fm.tmp, "box2"))
        inner = cover_ai._install_at(os.path.join(port, "ComfyUI"))
        assert inner and os.path.normcase(inner["root"]) == os.path.normcase(port)


def test_a_detected_install_is_remembered_so_the_next_run_does_not_crawl():
    with fresh_machine() as fm:
        box = os.path.join(fm.tmp, "disk")
        fake_comfy(box)
        fake_checkpoints(os.path.join(box, "ComfyUI_windows_portable", "ComfyUI",
                                      "models", "checkpoints"), ["bigXL.safetensors"])
        cover_ai._search_roots = lambda: [(box, 2)]
        cover_ai.invalidate()
        with patched(cover_ai, "MIN_CKPT_MB", 0):
            cover_ai.detect(rescan=True)
            saved = json.load(open(cover_ai.CONFIG_PATH, encoding="utf-8"))
            assert "ComfyUI_windows_portable" in saved["auto"]["comfy_root"]
            # now nothing is searchable, but the remembered path still resolves
            cover_ai._search_roots = lambda: []
            cover_ai.invalidate()
            assert cover_ai.detect()["install"] is not None


# --------------------------------------------------------------------------- #
# config file + precedence: env var > data/cover_ai.json > auto-detect > off
# --------------------------------------------------------------------------- #

def test_config_file_round_trips():
    with fresh_machine():
        assert cover_ai.load_config() == {}
        ok, cfg = cover_ai.save_config({"enabled": False, "comfy_root": "  C:/Comfy  ",
                                        "checkpoint": "x.safetensors", "port": "9999",
                                        "min_free_mb": 7000, "ignored": "nope"})
        assert ok and os.path.isfile(cover_ai.CONFIG_PATH)
        assert cfg["enabled"] is False and cfg["checkpoint"] == "x.safetensors"
        assert "Comfy" in cfg["comfy_root"] and cfg["port"] == 9999
        assert "ignored" not in cfg
        assert cover_ai._enabled() is False
        assert cover_ai._port() == 9999 and cover_ai._min_free_mb() == 7000
        # an empty string clears a key rather than saving ""
        _, cfg2 = cover_ai.save_config({"checkpoint": ""})
        assert "checkpoint" not in cfg2


def test_the_env_var_beats_the_config_file_which_beats_auto_detect():
    with fresh_machine() as fm:
        box = os.path.join(fm.tmp, "disk")
        auto_root = fake_comfy(box)
        cfg_root = fake_comfy(os.path.join(fm.tmp, "chosen"))
        cover_ai._search_roots = lambda: [(box, 2)]
        cover_ai.invalidate()

        # 1. nothing set: auto-detection wins
        assert os.path.normcase(cover_ai._comfy_root()) == os.path.normcase(auto_root)
        assert cover_ai._model_name() == cover_ai.DEFAULT_MODEL      # none on disk

        # 2. the config file beats it
        cover_ai.save_config({"comfy_root": cfg_root, "checkpoint": "fromfile.safetensors"})
        assert os.path.normcase(cover_ai._comfy_root()) == os.path.normcase(cfg_root)
        assert cover_ai._model_name() == "fromfile.safetensors"

        # 3. the env var beats the file
        os.environ["WAIVEPULSE_COMFY_ROOT"] = auto_root
        os.environ["WAIVEPULSE_COVER_AI_MODEL"] = "fromenv.safetensors"
        try:
            cover_ai.invalidate()
            assert os.path.normcase(cover_ai._comfy_root()) == os.path.normcase(auto_root)
            assert cover_ai._model_name() == "fromenv.safetensors"
        finally:
            del os.environ["WAIVEPULSE_COMFY_ROOT"]
            del os.environ["WAIVEPULSE_COVER_AI_MODEL"]

        # 4. off is off, whoever said so
        cover_ai.save_config({"enabled": False})
        assert cover_ai.available()[0] is False
        assert "switched off" in cover_ai.available()[1].lower()


def test_the_config_file_never_has_to_exist():
    with fresh_machine():
        assert cover_ai.load_config() == {}
        assert cover_ai._enabled() is True          # default on, nothing to edit
        assert cover_ai._port() == 8188
        assert cover_ai._min_free_mb() >= cover_ai.HARD_FLOOR_MB


# --------------------------------------------------------------------------- #
# checkpoint ranking
# --------------------------------------------------------------------------- #

def test_ranking_prefers_an_sdxl_checkpoint_over_an_sd15_one():
    sdxl = cover_ai._score_checkpoint("juggernautXL_ragnarokBy.safetensors", 6776)
    base = cover_ai._score_checkpoint("sd_xl_base_1.0.safetensors", 6616)
    sd15 = cover_ai._score_checkpoint("v1-5-pruned-emaonly.safetensors", 4067)
    sd35 = cover_ai._score_checkpoint("sd3.5_large.safetensors", 15697)
    refiner = cover_ai._score_checkpoint("sd_xl_refiner_1.0.safetensors", 6075)
    assert sdxl > sd15 and base > sd15
    assert sdxl > sd35 and base > refiner
    assert cover_ai._score_checkpoint("dreamshaperXL_v21.safetensors", 6600) > sd15


def test_ranking_picks_the_best_file_out_of_a_folder():
    with fresh_machine() as fm:
        folder = fake_checkpoints(os.path.join(fm.tmp, "ckpts"), [
            "v1-5-pruned-emaonly.safetensors",
            "realvisxlV5.safetensors",
            "notes.txt",
        ])
        with patched(cover_ai, "MIN_CKPT_MB", 0):
            got = cover_ai._list_checkpoints([folder])
        names = [c["name"] for c in got]
        assert names[0] == "realvisxlV5.safetensors", names
        assert "notes.txt" not in names
        assert len(got) == 2


def test_an_extra_configured_folder_is_searched():
    with fresh_machine() as fm:
        folder = fake_checkpoints(os.path.join(fm.tmp, "elsewhere"), ["mySDXL.safetensors"])
        cover_ai.save_config({"checkpoint_dir": folder})
        with patched(cover_ai, "MIN_CKPT_MB", 0):
            det = cover_ai.detect(rescan=True)
            assert [c["name"] for c in det["checkpoints"]] == ["mySDXL.safetensors"]
            assert cover_ai._model_name() == "mySDXL.safetensors"
            assert cover_ai._checkpoint_path() == os.path.join(folder, "mySDXL.safetensors")


# --------------------------------------------------------------------------- #
# extra_model_paths.yaml is generated, never committed
# --------------------------------------------------------------------------- #

def test_the_yaml_is_rendered_from_the_example_template():
    example = cover_ai._PATHS_EXAMPLE
    assert os.path.isfile(example), "the template must ship in git"
    with open(example, encoding="utf-8") as f:
        text = f.read()
    for token in ("__NAME__", "__BASE_PATH__", "__CHECKPOINTS__"):
        assert token in text, token
    assert ":\\" not in text and ":/" not in text, "the template must hold no absolute path"

    stanza = cover_ai._yaml_template()
    assert stanza.startswith("__NAME__") and "base_path" in stanza

    with fresh_machine() as fm:
        folder = fake_checkpoints(os.path.join(fm.tmp, "sd", "models", "Stable-diffusion"),
                                  ["someXL.safetensors"])
        cover_ai.save_config({"checkpoint_dir": folder})
        with patched(cover_ai, "MIN_CKPT_MB", 0):
            cover_ai.detect(rescan=True)
            out = cover_ai.write_paths_yaml()
        assert out and os.path.isfile(out)
        with open(out, encoding="utf-8") as f:
            body = f.read()
        assert "GENERATED" in body
        assert "waivepulse_1:" in body
        assert "checkpoints: Stable-diffusion" in body
        assert os.path.dirname(folder).replace("\\", "/") in body


def test_the_generated_yaml_is_gitignored():
    repo = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(repo, ".gitignore"), encoding="utf-8") as f:
        ignored = f.read()
    assert "backend/comfy/extra_model_paths.yaml" in ignored
    assert "data/cover_ai.json" in ignored


# --------------------------------------------------------------------------- #
# the setup panel's payload
# --------------------------------------------------------------------------- #

def test_setup_info_tells_a_stranger_what_to_do():
    with fresh_machine():
        info = cover_ai.setup_info()
        assert info["ok"] is True
        assert set(("available", "reason", "enabled", "config", "effective", "sources",
                    "comfy", "checkpoints", "gpu", "needs")) <= set(info)
        assert info["comfy"]["repo_url"].startswith("https://github.com/")
        joined = " ".join(info["needs"]).lower()
        assert "install comfyui" in joined
        assert "safetensors" in joined
        for key in cover_ai.CONFIG_KEYS:
            assert key in info["config"]


def test_setup_info_survives_a_broken_detection():
    with fresh_machine():
        with patched(cover_ai, "detect", lambda *a, **k: (_ for _ in ()).throw(OSError("disk gone"))):
            info = cover_ai.setup_info()
        assert info["ok"] is False and "disk gone" in info["reason"]
        assert info["available"] is False


# --------------------------------------------------------------------------- #
# available() is honest
# --------------------------------------------------------------------------- #

class installed:
    """available() with the software side satisfied, wherever this runs."""

    FAKE = {"root": "X:/Comfy", "cwd": "X:/Comfy/ComfyUI", "main": "X:/Comfy/ComfyUI/main.py",
            "python": "X:/Comfy/python_embeded/python.exe",
            "python_source": "bundled python", "kind": "portable"}

    def __enter__(self):
        self.a = patched(cover_ai, "_install", lambda *a, **k: dict(self.FAKE)).__enter__()
        self.b = patched(cover_ai, "_checkpoint_path", lambda: "X:/ckpt.safetensors").__enter__()
        self.c = patched(cover_ai, "_model_name", lambda: "fake.safetensors").__enter__()
        return self

    def __exit__(self, *a):
        for cm in (self.c, self.b, self.a):
            cm.__exit__()
        return False


def test_available_says_no_when_the_gpu_is_busy():
    with installed(), patched(cover_ai, "vram_free_mb", lambda: 1500), \
         patched(cover_ai, "_ollama_loaded", lambda: []):
        ok, why = cover_ai.available()
    assert ok is False
    assert "1500" in why and "busy" in why.lower(), why


def test_available_counts_vram_ollama_is_holding_as_reclaimable():
    with installed(), patched(cover_ai, "vram_free_mb", lambda: 1500), \
         patched(cover_ai, "_ollama_loaded", lambda: ["qwen2.5:7b-instruct"]):
        ok, why = cover_ai.available()
    assert ok is True
    assert "ollama" in why.lower(), why


def test_available_says_no_without_a_gpu():
    with installed(), patched(cover_ai, "vram_free_mb", lambda: None):
        ok, why = cover_ai.available()
    assert ok is False
    assert "gpu" in why.lower(), why


def test_available_says_no_when_comfyui_is_missing():
    os.environ["WAIVEPULSE_COMFY_ROOT"] = r"X:\definitely\not\here"
    try:
        ok, why = cover_ai.available()
    finally:
        del os.environ["WAIVEPULSE_COMFY_ROOT"]
    assert ok is False
    assert "comfyui" in why.lower(), why


def test_available_respects_the_off_switch():
    os.environ["WAIVEPULSE_COVER_AI"] = "0"
    try:
        ok, why = cover_ai.available()
    finally:
        del os.environ["WAIVEPULSE_COVER_AI"]
    assert ok is False
    assert "off" in why.lower(), why


def test_available_returns_a_pair_of_the_right_types():
    ok, why = cover_ai.available()
    assert isinstance(ok, bool) and isinstance(why, str) and why


# --------------------------------------------------------------------------- #
# background() degrades instead of raising
# --------------------------------------------------------------------------- #

def test_background_returns_none_when_comfyui_is_missing():
    os.environ["WAIVEPULSE_COMFY_ROOT"] = r"X:\definitely\not\here"
    try:
        assert cover_ai.background(1, 512, STYLE, timeout=20) is None
    finally:
        del os.environ["WAIVEPULSE_COMFY_ROOT"]


def test_background_returns_none_when_the_server_dies_mid_render():
    def boom(self, graph, client_id):
        raise ConnectionResetError("ComfyUI went away")

    with patched(cover_ai, "available", lambda: (True, "pretend")), \
         patched(cover_ai, "_gpu_ready", lambda *a, **k: (True, "pretend")), \
         patched(cover_ai._Comfy, "start", lambda self, deadline: (True, "pretend")), \
         patched(cover_ai._Comfy, "alive", lambda self: True), \
         patched(cover_ai._Comfy, "stop", lambda self: None), \
         patched(cover_ai._Comfy, "submit", boom):
        assert cover_ai.background(1, 512, STYLE, timeout=30) is None


def test_background_returns_none_when_the_gpu_is_busy():
    with patched(cover_ai, "vram_free_mb", lambda: 900), \
         patched(cover_ai, "_ollama_loaded", lambda: []):
        assert cover_ai.background(1, 512, STYLE, timeout=30) is None


def test_background_survives_rubbish_input():
    with patched(cover_ai, "available", lambda: (False, "not now")):
        assert cover_ai.background("not an int", None, None) is None        # type: ignore
        assert cover_ai.background(5, -3, {"tags": 42, "palette": "nope"}) is None  # type: ignore


# --------------------------------------------------------------------------- #
# the timeout is real
# --------------------------------------------------------------------------- #

def test_timeout_is_respected():
    """A slow ComfyUI must not hold the caller past `timeout`."""
    def slow_start(self, deadline):
        time.sleep(30)
        return False, "too slow"

    with patched(cover_ai, "available", lambda: (True, "pretend")), \
         patched(cover_ai, "_gpu_ready", lambda *a, **k: (True, "pretend")), \
         patched(cover_ai._Comfy, "start", slow_start), \
         patched(cover_ai._Comfy, "stop", lambda self: None):
        t0 = time.time()
        img = cover_ai.background(1, 512, STYLE, timeout=5)
        spent = time.time() - t0
    assert img is None
    assert spent < 9.0, "background() blocked for %.1fs on a 5s timeout" % spent


# --------------------------------------------------------------------------- #
# the prompt system
# --------------------------------------------------------------------------- #

def test_describe_is_deterministic():
    a = cover_ai.describe(4242, STYLE)
    b = cover_ai.describe(4242, dict(STYLE))
    assert a == b
    assert cover_ai.describe(4243, STYLE)["positive"] != a["positive"]


def test_describe_never_raises_on_junk():
    for junk in (None, {}, {"tags": None, "palette": ["zzz", "#12"], "genre": 5}):
        p = cover_ai.describe(7, junk)                                       # type: ignore
        assert p["positive"] and p["negative"]


def test_prompt_never_invites_type_into_the_picture():
    banned = ("album", "cover art", "record sleeve", "poster design",
              "lettering", "typography", "title text", "logo")
    for seed in range(40):
        pos = cover_ai.describe(seed * 977, STYLE)["positive"].lower()
        for word in banned:
            assert word not in pos, "%r leaked into a positive prompt" % word


def test_negative_prompt_always_blocks_text_and_slop():
    neg = cover_ai.describe(1, STYLE)["negative"].lower()
    for word in ("text", "letters", "watermark", "logo", "artstation",
                 "extra fingers", "neon glow", "border"):
        assert word in neg, word


def test_faces_are_excluded_unless_asked_for():
    neg = cover_ai.describe(1, STYLE)["negative"].lower()
    assert "human face" in neg and "person" in neg
    asked = cover_ai.describe(1, dict(STYLE, tags=["portrait"]))["negative"].lower()
    assert "(person:1.5)" not in asked


def test_direction_names_are_honoured_in_any_spelling():
    for spelling in ("film_still", "film-still", "Film Still", "FILM_STILL"):
        assert cover_ai.describe(3, dict(STYLE, direction=spelling))["direction"] == "film_still"
    # a design name the typography layer might use maps onto a medium
    assert cover_ai.describe(3, dict(STYLE, direction="swiss"))["direction"] == "screenprint"
    # something we have never heard of falls back to the genre, not a crash
    assert cover_ai.describe(3, dict(STYLE, direction="zzzz"))["direction"] in cover_ai.DIRECTIONS


def test_every_direction_is_complete():
    for key, d in cover_ai.DIRECTIONS.items():
        for field in ("label", "lead", "medium", "tail", "light", "cfg", "steps"):
            assert d.get(field) is not None, "%s is missing %s" % (key, field)
        assert 1.0 <= d["cfg"] <= 12.0 and 10 <= d["steps"] <= 60


def test_genre_aliases_all_resolve():
    for key, ent in cover_ai.GENRES.items():
        seen = set()
        while "alias" in ent:
            assert ent["alias"] not in seen, "alias loop at %s" % key
            seen.add(ent["alias"])
            ent = cover_ai.GENRES[ent["alias"]]
        assert ent.get("subjects"), key


def test_palette_reaches_the_prompt_as_colour_words():
    p = cover_ai.describe(9, dict(STYLE, palette=["#1a2648", "#cea82e"]))["positive"]
    assert "navy" in p and "mustard yellow" in p
    assert "restricted palette" in p


def test_real_song_tags_from_history_resolve_to_a_genre():
    cases = [
        # a broad tag must not beat a specific one later in the same list
        (("celtic", "sea shanty"), ["male vocals", "bar", "folk", "raw", "celtic", "sea shanty"]),
        (("k-pop",), ["k-pop", "resonant", "melancholic"]),
        (("grunge",), ["grunge", "alternative", "mandolin"]),
        (("gospel",), ["gospel", "acoustic", "woody"]),
        (("soul",), ["soul", "smooth", "choir", "ukulele"]),
        (("nu-metal",), ["linkin park", "rock", "alternative", "nu-metal", "anthemic"]),
        (("dance",), ["dance", "bright", "smooth", "upbeat"]),
    ]
    for expect, tags in cases:
        got = cover_ai.describe(1, {"tags": tags})["genre"]
        assert got in expect, "%s -> %s" % (tags, got)


def test_workflow_json_matches_what_we_patch():
    g = cover_ai._load_graph()
    for node in ("3", "4", "5", "6", "7", "8", "9"):
        assert node in g, "workflow is missing node %s" % node
    assert g["4"]["class_type"] == "CheckpointLoaderSimple"
    assert g["3"]["class_type"] == "KSampler"
    built = cover_ai._build_graph(cover_ai.describe(5, STYLE), 1024, "px")
    assert built["5"]["inputs"]["width"] == 1024
    assert built["3"]["inputs"]["seed"] == 5
    assert built["6"]["inputs"]["text"].startswith("(")


# --------------------------------------------------------------------------- #
# image plumbing
# --------------------------------------------------------------------------- #

def test_debleed_crops_a_flat_margin_but_leaves_real_art_alone():
    from PIL import Image, ImageDraw
    bordered = Image.new("RGB", (512, 512), (250, 248, 240))
    d = ImageDraw.Draw(bordered)
    for i in range(60, 452, 7):
        d.line([(60, i), (452, i)], fill=(20, 40 + (i % 90), 160), width=3)
    cropped = cover_ai._debleed(bordered)
    assert cropped.size[0] < 512, "the flat margin was not removed"

    busy = Image.new("RGB", (512, 512))
    px = busy.load()
    for y in range(512):
        for x in range(512):
            px[x, y] = ((x * 7) % 256, (y * 11) % 256, ((x + y) * 5) % 256)
    assert cover_ai._debleed(busy).size == (512, 512)


def test_square_resizes_and_crops():
    from PIL import Image
    wide = Image.new("RGB", (1024, 768), (10, 20, 30))
    out = cover_ai._square(wide, 600)
    assert out.size == (600, 600) and out.mode == "RGB"


def test_warmup_is_harmless():
    cover_ai.warmup()
    cover_ai.warmup()


def test_shutdown_is_safe_with_no_session():
    cover_ai.shutdown()


# --------------------------------------------------------------------------- #
# the slow ones - only when the card is free
# --------------------------------------------------------------------------- #

def test_same_seed_gives_the_same_bytes():
    ok, why = gpu_ready()
    if not ok:
        print("SKIP determinism: %s" % why)
        return
    style = dict(STYLE, direction="riso")
    one = cover_ai.background(20260928, 512, style, timeout=300)
    two = cover_ai.background(20260928, 512, style, timeout=300)
    assert one is not None and two is not None, "the GPU was free but no image came back"
    a, b = io.BytesIO(), io.BytesIO()
    one.save(a, "PNG")
    two.save(b, "PNG")
    assert a.getvalue() == b.getvalue(), "same seed produced different bytes"

    other = cover_ai.background(20260929, 512, style, timeout=300)
    c = io.BytesIO()
    other.save(c, "PNG")
    assert c.getvalue() != a.getvalue(), "a different seed produced the same image"


def test_a_real_render_is_square_and_leaves_nothing_resident():
    ok, why = gpu_ready()
    if not ok:
        print("SKIP live render: %s" % why)
        return
    before = cover_ai.vram_free_mb()
    img = cover_ai.background(31337, 900, STYLE, timeout=300)
    assert img is not None and img.size == (900, 900) and img.mode == "RGB"
    time.sleep(3)
    after = cover_ai.vram_free_mb()
    assert after >= before - 400, "VRAM did not come back: %s -> %s MB" % (before, after)
    assert cover_ai._SESSION is None, "a ComfyUI session was left running"


# --------------------------------------------------------------------------- #

def main():
    tests = [(n, f) for n, f in sorted(globals().items())
             if n.startswith("test_") and callable(f)]
    failed = 0
    for name, fn in tests:
        t0 = time.time()
        try:
            fn()
            print("PASS  %-58s %5.1fs" % (name, time.time() - t0))
        except AssertionError as e:
            failed += 1
            print("FAIL  %-58s %s" % (name, e))
        except Exception as e:
            failed += 1
            print("ERROR %-58s %s: %s" % (name, type(e).__name__, e))
    print("\n%d/%d passed" % (len(tests) - failed, len(tests)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
