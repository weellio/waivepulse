"""Tests for backend/cover.py — the album-cover art directions.

Run with:  F:\\HeartMuLa\\venv\\Scripts\\python.exe -m pytest tests/test_cover.py -q
(or just run this file directly; it has a __main__ that prints a summary).

Plain asserts, no fixtures. Nothing here touches the network or the model.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import cover                                    # noqa: E402
from PIL import Image                           # noqa: E402


# ── material ──────────────────────────────────────────────────────────────────

TITLES = [
    ("one word",       "Nine"),
    ("nine words",     "Everything I Never Said Out Loud In The Kitchen At Night"),
    ("40-char word",   "Supercalifragilisticexpialidociousness"),
    ("non-ascii",      "Caf\u00e9 \u00c9t\u00e9 No\u00ebl \u00dcber Ma\u00f1ana Z\u00f6e"),
    ("cyrillic+ext",   "\u041c\u043e\u0441\u043a\u0432\u0430 Sofi\u00e0 \u00c6ther \u0141\u00f3d\u017a"),
    ("empty",          ""),
    ("single char",    "A"),
    ("punctuation",    "WAIT!!! (feat. nobody) [extended club mix]"),
    ("emoji only",     "\U0001F600\U0001F680"),
]

TAGSETS = [
    "metal,doom,heavy,dark",
    "jazz,smooth,saxophone",
    "pop,upbeat,playful",
    "ambient,calm,dreamy",
    "folk,acoustic,celtic",
    "techno,industrial,glitch",
    "",
]


def _job(title, tags, artist="Grandrooster", style=None):
    j = {"title": title, "artist": artist, "tags": tags}
    if style:
        j["cover_style"] = style
    return j


# ── structure ─────────────────────────────────────────────────────────────────

def test_there_are_at_least_eight_directions():
    assert len(cover.DIRECTIONS) >= 8, "the brief asks for at least 8 art directions"
    ids = [d["id"] for d in cover.directions()]
    assert len(set(ids)) == len(ids)
    assert set(ids) == set(cover.DIRECTIONS)
    for d in cover.directions():
        assert d["label"] and d["label"] != d["id"]


def test_every_direction_has_its_own_palettes():
    for name in cover.DIRECTIONS:
        pals = cover.PALETTES[name]
        assert len(pals) >= 3, f"{name} needs a real palette set, not one option"
        for p in pals:
            for key in ("paper", "ink", "accent"):
                assert cover.hx(p[key])
            # a sleeve never runs more than three hues
            hues = {p["paper"], p["ink"], p["accent"], p["accent2"]}
            assert len(hues) <= 4


def test_fonts_are_vendored_and_load():
    for face, (fname, _axes) in cover._FACES.items():
        assert (cover.FONT_DIR / fname).exists(), f"missing vendored font {fname}"
        f = cover.font(face, 64)
        assert f.getlength("Hxg") > 0
    assert (cover.FONT_DIR / "LICENSES.md").exists()


# ── typesetting ───────────────────────────────────────────────────────────────

def test_titles_fit_the_box_and_never_exceed_three_lines():
    box_w, box_h = 840.0, 400.0
    for label, title in TITLES:
        for face in ("archivo", "oswald", "anton", "fraunces", "mono"):
            b = cover.set_type(title or "Untitled", face, box_w, box_h,
                               150, 40, tracking=-10, leading=0.95)
            assert len(b.lines) <= cover.MAX_LINES, f"{label}/{face}: too many lines"
            for ln in b.lines:
                w = cover.text_width(b.font, ln, b.tracking)
                assert w <= box_w + 1.0, f"{label}/{face}: line overflows ({w:.0f} > {box_w})"
            h = b.line_h * (len(b.lines) - 1) + b.font.size * 1.02
            assert h <= box_h + 1.0, f"{label}/{face}: block too tall"


def test_wrapping_happens_on_word_boundaries():
    b = cover.set_type("Everything I Never Said Out Loud In The Kitchen At Night",
                       "archivo", 700.0, 400.0, 120, 30)
    joined = " ".join(b.lines)
    assert "-" not in joined, "multi-word titles must never be hyphen-broken"
    assert joined.split() == ("Everything I Never Said Out Loud In The Kitchen "
                              "At Night").split()


def test_a_single_long_word_is_hyphen_broken_not_overflowed():
    b = cover.set_type("Supercalifragilisticexpialidociousness", "archivo",
                       420.0, 400.0, 120, 44)
    assert len(b.lines) > 1
    assert "".join(l.rstrip("-") for l in b.lines) == \
        "Supercalifragilisticexpialidociousness"


def test_lines_are_balanced_not_greedy():
    b = cover.set_type("Everything I Never Said Out Loud In The Kitchen At Night",
                       "archivo", 700.0, 400.0, 120, 30)
    widths = [cover.text_width(b.font, l, b.tracking) for l in b.lines]
    assert (max(widths) - min(widths)) / max(widths) < 0.45, \
        "a balanced wrap should not leave one line far shorter than the others"


def test_impossible_text_is_ellipsised_not_dropped():
    b = cover.set_type("Everything I Never Said Out Loud In The Kitchen At Night",
                       "anton", 200.0, 90.0, 60, 52, max_lines=1)
    assert len(b.lines) == 1
    assert b.lines[0].endswith("\u2026")


def test_emoji_and_astral_characters_are_stripped():
    assert cover.strip_undrawable("Tacos \U0001F32E are life", "archivo") == "Tacos are life"


def test_a_face_that_cannot_draw_the_text_falls_back():
    # blackletter has no Cyrillic; the chain must move to something that does
    assert cover.usable_face("blackletter", "Doom") == "blackletter"
    assert cover.usable_face("blackletter", "\u041c\u043e\u0441\u043a\u0432\u0430") != "blackletter"


def test_fill_lines_balances_by_character_count():
    lines = cover.fill_lines("Everything I Never Said Out Loud In The Kitchen At Night", 3)
    assert len(lines) == 3
    lens = [len(l) for l in lines]
    assert max(lens) - min(lens) <= 10


def test_fill_lines_keeps_short_single_words_whole():
    assert cover.fill_lines("UNTITLED", 3) == ["UNTITLED"]


# ── contrast ──────────────────────────────────────────────────────────────────

def test_contrast_ratio_maths():
    assert round(cover.contrast("#000000", "#ffffff"), 1) == 21.0
    assert round(cover.contrast("#777777", "#777777"), 1) == 1.0


def test_every_piece_of_type_clears_45_to_1_on_every_direction():
    """The headline rule: the ratio is measured over the pixels actually behind
    the glyphs, after any plate has been drawn."""
    failures = []
    for direction in cover.DIRECTIONS:
        for ti, (label, title) in enumerate(TITLES):
            tags = TAGSETS[ti % len(TAGSETS)]
            job = _job(title, tags, style=direction)
            _img, audit = cover.render_audited(f"t{ti}{direction}", job, 900)
            assert audit, f"{direction} placed no type at all"
            for what, ratio in audit:
                if ratio < cover.MIN_CONTRAST:
                    failures.append(f"{direction}/{label}: {what!r} at {ratio:.2f}:1")
    assert not failures, "type below 4.5:1:\n  " + "\n  ".join(failures[:25])


def test_contrast_holds_at_thumbnail_size_too():
    failures = []
    for direction in cover.DIRECTIONS:
        job = _job("Tacos Are Life", "rock,anthemic", style=direction)
        _img, audit = cover.render_audited("thumb", job, 300)
        for what, ratio in audit:
            if ratio < cover.MIN_CONTRAST:
                failures.append(f"{direction}: {what!r} at {ratio:.2f}:1")
    assert not failures, "type below 4.5:1 at 300px:\n  " + "\n  ".join(failures)


# ── rendering ─────────────────────────────────────────────────────────────────

def test_every_direction_renders_square_rgb_at_several_sizes():
    for direction in cover.DIRECTIONS:
        for size in (300, 1200):
            img = cover.render("r1", _job("Tacos", "rock", style=direction), size)
            assert isinstance(img, Image.Image)
            assert img.mode == "RGB"
            assert img.size == (size, size)


def test_covers_are_not_blank_and_not_muddy():
    """A cover has real light and real dark in it — the old one was a pastel
    smear, so this guards the floor."""
    import numpy as np
    for direction in cover.DIRECTIONS:
        img = cover.render("r2", _job("Tacos Are Life", "rock,anthemic",
                                      style=direction), 600)
        a = np.asarray(img.convert("L")).astype(float)
        assert a.std() > 18, f"{direction} is too flat (std {a.std():.1f})"
        assert a.max() - a.min() > 140, f"{direction} has no tonal range"


def test_rendering_is_deterministic():
    job = _job("Tacos Are Life", "rock,dark")
    a = cover.render("same", job, 400).tobytes()
    b = cover.render("same", job, 400).tobytes()
    assert a == b


def test_a_new_nonce_gives_a_different_cover():
    job = _job("Tacos Are Life", "rock,dark")
    a = cover.render("same", job, 400, nonce="").tobytes()
    b = cover.render("same", job, 400, nonce="abc123").tobytes()
    assert a != b


def test_explicit_style_beats_the_automatic_pick():
    for direction in cover.DIRECTIONS:
        got, ai = cover.resolve_style("j1", "metal,doom", direction)
        assert got == direction and ai is False


def test_tags_steer_the_automatic_pick():
    """Not every metal song must land on the metal sleeve, but most should."""
    def spread(tags, want):
        hits = sum(cover.resolve_style(f"job{i:03d}", tags)[0] == want
                   for i in range(300))
        return hits / 300.0
    assert spread("metal,doom,heavy,growl", "metal") > 0.45
    assert spread("jazz,saxophone,bebop", "bluenote") > 0.40
    assert spread("ambient,drone,peaceful", "ambient") > 0.30
    assert spread("folk,acoustic,banjo", "folk") > 0.35
    # an untagged song still gets a real direction, just a less predictable one
    assert cover.resolve_style("untagged", "")[0] in cover.DIRECTIONS


def test_untagged_songs_spread_across_directions():
    picks = {cover.resolve_style(f"u{i}", "")[0] for i in range(200)}
    assert len(picks) >= 8, "with no tags the whole catalogue should be in play"


def test_render_fitted_crops_to_the_requested_aspect():
    img = cover.render_fitted("v1", _job("Tacos", "rock"), 480, 270)
    assert img.size == (480, 270)


def test_an_unknown_style_falls_back_instead_of_exploding():
    d, ai = cover.resolve_style("j2", "rock", "no-such-direction")
    assert d in cover.DIRECTIONS and ai is False


# ── the optional AI art layer ─────────────────────────────────────────────────

def test_ai_is_optional_and_never_breaks_a_render():
    ok, reason = cover.ai_status()
    assert isinstance(ok, bool) and isinstance(reason, str)
    if not ok:
        assert reason, "an unavailable AI layer must say why (for the UI tooltip)"
    img = cover.render("aijob", _job("Tacos", "rock"), 300, style="ai")
    assert img.size == (300, 300)


def test_ai_style_still_resolves_to_a_real_direction():
    d, ai = cover.resolve_style("j3", "metal,doom", "ai")
    assert d in cover.DIRECTIONS and ai is True


if __name__ == "__main__":
    import time
    fails = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        t0 = time.time()
        try:
            fn()
            print(f"  ok   {name}  ({time.time()-t0:.1f}s)")
        except AssertionError as e:
            fails += 1
            print(f"  FAIL {name}\n       {e}")
        except Exception as e:
            fails += 1
            print(f"  ERR  {name}: {type(e).__name__}: {e}")
    print(f"\n{'FAILED' if fails else 'all green'} ({fails} failing)")
    sys.exit(1 if fails else 0)
