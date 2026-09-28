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
import os
import sys
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


# --------------------------------------------------------------------------- #
# available() is honest
# --------------------------------------------------------------------------- #

def test_available_says_no_when_the_gpu_is_busy():
    with patched(cover_ai, "vram_free_mb", lambda: 1500), \
         patched(cover_ai, "_ollama_loaded", lambda: []):
        ok, why = cover_ai.available()
    assert ok is False
    assert "1500" in why and "busy" in why.lower(), why


def test_available_counts_vram_ollama_is_holding_as_reclaimable():
    with patched(cover_ai, "vram_free_mb", lambda: 1500), \
         patched(cover_ai, "_ollama_loaded", lambda: ["qwen2.5:7b-instruct"]):
        ok, why = cover_ai.available()
    assert ok is True
    assert "ollama" in why.lower(), why


def test_available_says_no_without_a_gpu():
    with patched(cover_ai, "vram_free_mb", lambda: None):
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
