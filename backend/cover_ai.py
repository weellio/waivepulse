"""
WAIvePulse - optional LOCAL AI art layer for song covers.

This module paints the *picture* underneath a cover. It never draws type: the
caller (backend/cover.py) lays title / artist / wordmark on top of whatever
square image comes back here.

Public contract (nothing else is required by callers)::

    available() -> (bool, str)
    background(seed, size, style, timeout=180) -> PIL.Image | None
    warmup() -> None

``style`` is a dict::

    {"direction": str, "genre": str, "mood": str,
     "tags": [str], "title": str, "palette": ["#rrggbb", ...]}

Everything is best-effort: this module never raises, never blocks past
``timeout``, and never leaves a model resident on the GPU.

How it runs
-----------
An on-demand headless ComfyUI (the owner's existing portable install) is
started on 127.0.0.1:8188, a small SDXL text-to-image graph is submitted over
the HTTP API, the PNG is read back, and the server is shut down again. Nothing
is downloaded, nothing is installed, and the owner's own ComfyUI config is left
alone (we pass our own --extra-model-paths-config and our own output/temp/user
directories).

The GPU is shared with HeartMuLa generation, Demucs separation, Ollama and
video renders, so before loading anything we require a free-VRAM floor, and we
politely ask Ollama to drop idle models first. If it is still tight we give up
and return None - a cover is never worth crashing a separation over.

Environment switches (all optional)
-----------------------------------
WAIVEPULSE_COVER_AI          0/off/false disables the whole layer.
WAIVEPULSE_COVER_AI_MODEL    checkpoint filename (default juggernautXL_ragnarokBy).
WAIVEPULSE_COVER_AI_PORT     port for the throwaway ComfyUI (default 8188).
WAIVEPULSE_COVER_AI_MIN_VRAM free MB required before loading (default 6000).
WAIVEPULSE_COVER_AI_KEEP_ALIVE seconds to keep the *server* (never a model)
                             alive between calls, for batch runs. Default 0.
WAIVEPULSE_COVER_AI_STEPS    override sampler steps.
WAIVEPULSE_COVER_AI_CFG      override cfg scale.
WAIVEPULSE_COMFY_ROOT        path to ComfyUI_windows_portable.
WAIVEPULSE_COVER_AI_DEBUG    1 = keep the ComfyUI log and print timings.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import random
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

try:                                    # Pillow is a hard requirement of the app
    from PIL import Image
except Exception:                       # pragma: no cover - app cannot run without it
    Image = None

__all__ = ["available", "background", "warmup", "background_batch", "describe", "shutdown"]

# --------------------------------------------------------------------------- #
# paths / config
# --------------------------------------------------------------------------- #

_HERE = os.path.dirname(os.path.abspath(__file__))
_COMFY_DIR = os.path.join(_HERE, "comfy")
_WORKFLOW = os.path.join(_COMFY_DIR, "sdxl_cover.json")
_PATHS_YAML = os.path.join(_COMFY_DIR, "extra_model_paths.yaml")

CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

DEFAULT_MODEL = "juggernautXL_ragnarokBy.safetensors"
NATIVE = 1024                 # SDXL is trained square at 1024; we render there

# Two VRAM numbers, both measured on the owner's 12 GB RTX 3060:
#   HARD_FLOOR  - never, ever load below this. Someone else owns the card.
#   SPEED_FLOOR - SDXL fp16 is ~5.1 GB of weights plus attention at 1024. With
#                 8.2 GB+ free a cover takes ~25 s. At 6.2 GB free ComfyUI falls
#                 back to per-layer offload and the same image took over 300 s,
#                 so below this we decline instead of hogging the GPU for
#                 minutes. Set WAIVEPULSE_COVER_AI_MIN_VRAM to move it.
HARD_FLOOR_MB = 6000
MIN_FREE_MB = 8200
OLLAMA = "http://127.0.0.1:11434"


def _env(name: str, default: str = "") -> str:
    return (os.environ.get(name) or default).strip()


def _env_flag(name: str, default: bool) -> bool:
    v = _env(name).lower()
    if not v:
        return default
    return v not in ("0", "off", "false", "no", "none")


def _comfy_root() -> str:
    return _env("WAIVEPULSE_COMFY_ROOT", r"F:\StableDiffusion\ComfyUI_windows_portable")


def _model_name() -> str:
    return _env("WAIVEPULSE_COVER_AI_MODEL", DEFAULT_MODEL)


def _port() -> int:
    try:
        return int(_env("WAIVEPULSE_COVER_AI_PORT", "8188"))
    except ValueError:
        return 8188


def _min_free_mb() -> int:
    """How much free VRAM we want before loading (never below the hard floor)."""
    try:
        want = int(_env("WAIVEPULSE_COVER_AI_MIN_VRAM", str(MIN_FREE_MB)))
    except ValueError:
        want = MIN_FREE_MB
    return max(HARD_FLOOR_MB, want)


def _keep_alive() -> float:
    try:
        return max(0.0, float(_env("WAIVEPULSE_COVER_AI_KEEP_ALIVE", "0")))
    except ValueError:
        return 0.0


def _debug() -> bool:
    return _env_flag("WAIVEPULSE_COVER_AI_DEBUG", False)


def _log(msg: str) -> None:
    if _debug():
        sys.stderr.write("[cover_ai] %s\n" % msg)
        sys.stderr.flush()


def _workdir() -> str:
    """Scratch space for the throwaway ComfyUI (outputs, temp, user dir)."""
    d = os.path.join(tempfile.gettempdir(), "waivepulse_cover_ai")
    for sub in ("out", "tmp", "user"):
        try:
            os.makedirs(os.path.join(d, sub), exist_ok=True)
        except Exception:
            pass
    return d


# --------------------------------------------------------------------------- #
# the prompt system - this is the actual product
# --------------------------------------------------------------------------- #
#
# Rules that keep the output off the "AI slop" shelf:
#   * never say album / cover / poster / sleeve / lettering in the positive
#     prompt - those words drag typography into the picture.
#   * describe a real, ordinary, photographable or printable THING, plus the
#     medium it was reproduced in. Medium is what makes it look designed.
#   * one subject, plain area left for the type.
#   * no "trending on artstation", no "8k octane", no glow.

# Each direction = a medium with its own process tells, light, sampler taste.
DIRECTIONS = {
    "riso": {
        "label": "risograph print",
        "mode": "flat",
        "lead": "(risographed in two flat spot inks:1.3)",
        "sub": "%s drawn as flat hard-edged shapes",
        "medium": ("flat spot inks on rough paper, coarse visible halftone dot screen, "
                   "slight ink misregistration, uneven roller coverage"),
        "tail": "(risograph halftone dots, flat ink:1.2)",
        "light": "flat graphic shapes, no photographic shading",
        "cfg": 7.5, "steps": 26,
        "props_ok": True, "figures": "silhouette",
        "neg": "photograph, photorealistic, glossy, smooth gradient, 3d render, depth of field",
    },
    "screenprint": {
        "label": "screen print",
        "mode": "flat",
        "lead": "(silkscreened in three flat inks:1.3)",
        "sub": "%s drawn as flat hard-edged shapes",
        "medium": ("three flat ink layers, hand-cut stencil edges, overprint where the inks "
                   "cross, a tiny registration slip, ink slub and pinholes"),
        "tail": "(flat screenprinted inks, hard-edged shapes:1.2)",
        "light": "flat poster shapes, bold and simple, no shading",
        "cfg": 7.5, "steps": 26,
        "props_ok": True, "figures": "silhouette",
        "neg": ("photograph, photorealistic, depth of field, soft focus, airbrush, 3d render, "
                "pencil signature, edition number"),
    },
    "film_still": {
        "label": "film still",
        "mode": "photo",
        "lead": "(a 35mm film photograph:1.2)",
        "medium": ("Kodak Portra 400, visible grain, slight halation, shallow depth of field, "
                   "honest colour, scanned negative with a speck of dust"),
        "tail": "(film grain, analogue colour:1.15)",
        "light": "available light, window light, no studio strobes",
        "cfg": 5.0, "steps": 28,
        "props_ok": True, "figures": "back_turned",
        "neg": "illustration, painting, cartoon, cgi, hdr, oversharpened",
    },
    "collage": {
        "label": "cut-paper collage",
        "mode": "flat",
        "lead": "(a flat cut-paper collage:1.3)",
        "sub": "%s built from flat cut paper shapes",
        "medium": ("shapes cut from plain coloured paper and pasted flat in layers, visible "
                   "scissor edges, glue shadow, slight paper grain, scanned on a flatbed"),
        "tail": "(flat cut paper shapes, matisse cut-out:1.2)",
        "light": "flat scanner light, hard paper shadows",
        "cfg": 7.0, "steps": 26,
        "props_ok": True, "figures": "fragment",
        "neg": ("newspaper, newsprint, printed page, magazine clipping, pile of paper, "
                "scrapbook, seamless render, smooth digital art, single photograph"),
    },
    "abstract_paint": {
        "label": "abstract painting",
        "mode": "paint",
        "lead": "(painted thickly in oil:1.3)",
        "sub": "%s dissolved into paint",
        "medium": ("palette knife impasto, visible canvas weave, dry brush drag, bare primed "
                   "patches, the paint surface fills the entire frame"),
        "tail": "(oil paint ridges, brush and knife marks:1.2)",
        "light": "raking light across the paint surface",
        "cfg": 6.5, "steps": 28,
        "props_ok": False, "figures": "none",
        "neg": ("framed canvas on a wall, painting hanging in a room, easel, photograph, "
                "fractal, kaleidoscope, mandala, symmetrical pattern, digital airbrush, glow"),
    },
    "still_life": {
        "label": "studio still life",
        "mode": "photo",
        "lead": "(a large-format studio still life photograph:1.2)",
        "medium": ("seamless paper backdrop, one hard sculpted light and a deep shadow, a "
                   "little dust on the surface, colour transparency film"),
        "tail": "(studio photograph, one hard light:1.15)",
        "light": "single hard studio light, one long shadow",
        "cfg": 5.5, "steps": 28,
        "props_ok": True, "figures": "none",
        "neg": "illustration, painting, cartoon, cluttered set, many objects",
    },
    "photo_texture": {
        "label": "photographed texture",
        "mode": "photo",
        "lead": "(an extreme close-up photograph of a real surface:1.25)",
        "medium": ("the material fills the whole frame, natural imperfection, fine detail, "
                   "no object and no scene, medium-format film"),
        "tail": "(material surface filling the frame:1.2)",
        "light": "soft even north light",
        "cfg": 5.0, "steps": 26,
        "props_ok": False, "figures": "none",
        "neg": "illustration, cgi, pattern repeat, tiling, symmetry, wide shot, landscape view",
    },
    "lithograph": {
        "label": "vintage lithograph",
        "mode": "flat",
        "lead": "(chromolithographed in stone-printed inks:1.3)",
        "sub": "%s drawn in fine engraved lines",
        "medium": ("limited stone-printed inks, fine engraved hatching and stipple, aged "
                   "foxed paper tone, slightly faded"),
        "tail": "(engraved hatching, lithographic ink:1.2)",
        "light": "even antique plate rendering",
        "cfg": 7.0, "steps": 28,
        "props_ok": True, "figures": "engraved",
        "neg": "modern, photograph, photorealistic, 3d render, digital gradient",
    },
    "long_exposure": {
        "label": "night long exposure",
        "mode": "photo",
        "lead": "(a long exposure night photograph:1.2)",
        "medium": ("colour negative film, gentle camera movement, one sodium street lamp, "
                   "deep unlit shadow, heavy grain"),
        "tail": "(night film grain, motion smear:1.15)",
        "light": "one dim practical light, mostly darkness",
        "cfg": 5.5, "steps": 28,
        "props_ok": False, "figures": "blurred",
        "neg": ("neon signs, cyberpunk, light trails everywhere, lens flare, bloom, glow, "
                "vaporwave, daylight"),
    },
    "airbrush_70s": {
        "label": "1970s airbrush illustration",
        "mode": "paint",
        "lead": "(airbrushed in gouache, 1976:1.3)",
        "sub": "%s painted in soft airbrushed gradients",
        "medium": ("soft flat gradient sky, sun-faded dye, fine dust and a scuff, slightly "
                   "off-register printing, illustrated not photographed"),
        "tail": "(airbrushed gouache, soft flat gradients:1.2)",
        "light": "smooth graded dusk light",
        "cfg": 6.5, "steps": 28,
        "props_ok": True, "figures": "small_distant",
        "neg": "photograph, photorealistic, chrome, neon, modern digital art, glow",
    },
    "xerox_punk": {
        "label": "photocopied zine",
        "mode": "flat",
        "lead": "(photocopied in stark black and white:1.35)",
        "sub": "%s in stark black and white only",
        "medium": ("third generation toner copy, blown-out blacks and clipped whites, no "
                   "midtones at all, coarse toner grain and streaks, crumpled and re-scanned"),
        "tail": "(pure black and white toner, no midtones:1.25)",
        "light": "harsh flash, everything either black or white",
        "cfg": 7.5, "steps": 24,
        "props_ok": True, "figures": "silhouette",
        "neg": "colour, colourful, smooth, clean, glossy, grey midtones, 3d render",
    },
    "ceramic_form": {
        "label": "sculpted object study",
        "mode": "photo",
        "lead": "(a photograph of a hand-built ceramic form:1.2)",
        "medium": ("ash glaze with crawl and pooling, unglazed grog foot, plaster plinth, "
                   "museum daylight"),
        "tail": "(glazed ceramic surface:1.15)",
        "light": "cool museum daylight from one side",
        "cfg": 5.5, "steps": 28,
        "props_ok": False, "figures": "none",
        "neg": "illustration, cgi, plastic, glossy render",
    },
}

# Caller-side design names (cover.py owns those) mapped onto our media.
DIRECTION_ALIASES = {
    "print": "screenprint", "poster": "screenprint", "swiss": "screenprint",
    "brutalist": "screenprint", "bauhaus": "screenprint", "graphic": "screenprint",
    "type": "screenprint", "typographic": "screenprint", "bold": "screenprint",
    "riso": "riso", "risograph": "riso", "duotone": "riso", "zine": "xerox_punk",
    "punk": "xerox_punk", "photocopy": "xerox_punk", "raw": "xerox_punk",
    "photo": "film_still", "photographic": "film_still", "documentary": "film_still",
    "film": "film_still", "cinematic": "film_still", "portrait": "film_still",
    "collage": "collage", "cutup": "collage", "montage": "collage", "dada": "collage",
    "paint": "abstract_paint", "painting": "abstract_paint", "painterly": "abstract_paint",
    "abstract": "abstract_paint", "expressive": "abstract_paint",
    "still_life": "still_life", "studio": "still_life", "product": "still_life",
    "object": "still_life", "minimal": "photo_texture", "texture": "photo_texture",
    "material": "photo_texture", "macro": "photo_texture", "monolith": "photo_texture",
    "vintage": "lithograph", "engraving": "lithograph", "antique": "lithograph",
    "victorian": "lithograph", "woodcut": "lithograph",
    "night": "long_exposure", "neon": "long_exposure", "dark": "long_exposure",
    "moody": "long_exposure", "blur": "long_exposure",
    "retro": "airbrush_70s", "seventies": "airbrush_70s", "airbrush": "airbrush_70s",
    "psychedelic": "airbrush_70s", "dreamy": "airbrush_70s", "soft": "airbrush_70s",
    "ceramic": "ceramic_form", "sculpture": "ceramic_form", "gallery": "ceramic_form",
    # the names backend/cover.py uses for its typographic directions, so the
    # art underneath suits the type on top
    "bluenote": "film_still", "metal": "photo_texture", "synthwave": "airbrush_70s",
    "ambient": "photo_texture", "techno": "long_exposure", "xerox": "xerox_punk",
    "folk": "film_still", "pop": "still_life",
}

# genre -> concrete subjects + the media that suit it.
# Subjects are deliberately ordinary objects and places. No "music vibes".
GENRES = {
    "sea shanty": {
        "dirs": ["lithograph", "film_still", "riso", "collage"],
        "subjects": [
            "a coil of tarred rope on a wet stone dock",
            "a whale-oil lantern standing on a salt-stained crate",
            "grey Atlantic swell seen low over a wooden gunwale",
            "a torn linen sail bundled on a deck",
            "a brass ship's bell green with verdigris",
            "a chart weighted down with a lead sinker",
        ],
        "world": "north Atlantic harbour, 1880s, wet salt air",
    },
    "celtic": {
        "dirs": ["lithograph", "film_still", "riso"],
        "subjects": [
            "a drystone wall running into low sea fog",
            "wet hawthorn branches over a peat track",
            "a standing stone in wind-flattened grass",
            "a fiddle laid on a bench in a stone pub",
        ],
        "world": "west of Ireland, drizzle, iron-grey daylight",
    },
    "folk": {
        "dirs": ["film_still", "riso", "lithograph", "still_life"],
        "subjects": [
            "a bundle of dried flowers on a peeling windowsill",
            "an enamel jug and a linen cloth on bare boards",
            "a pressed leaf taped inside a notebook",
            "a dirt road between two hedgerows at dusk",
        ],
        "world": "rural, worn, handmade",
    },
    "country": {
        "dirs": ["film_still", "airbrush_70s", "lithograph"],
        "subjects": [
            "a hay bale in stubble with a fence line behind",
            "a dented chrome pickup mirror holding a wide sky",
            "a pair of worn boots on a porch step",
            "a roadside gas pump in flat afternoon light",
        ],
        "world": "west Texas, dust, big sky",
    },
    "gospel": {
        "dirs": ["film_still", "riso", "screenprint", "still_life"],
        "subjects": [
            "morning light falling through a wooden church window onto empty pews",
            "a tambourine resting on a red hymn book",
            "white cotton drapes lifting in an open doorway",
            "a stack of paper fans on a folding chair",
        ],
        "world": "small clapboard church, warm dusty light",
    },
    "soul": {
        "dirs": ["film_still", "still_life", "airbrush_70s"],
        "subjects": [
            "a heavy velvet stage curtain half drawn",
            "a chrome microphone stand casting one long shadow",
            "a ring of condensation on a lacquered bar top",
            "a silk shirt folded on a hotel bedspread",
        ],
        "world": "1972, warm tungsten, worn glamour",
    },
    "rhythm and blues": {"alias": "soul"}, "r&b": {"alias": "soul"},
    "blues": {
        "dirs": ["film_still", "xerox_punk", "lithograph"],
        "subjects": [
            "a bare bulb over a cracked linoleum floor",
            "rain on a bus window at night",
            "an empty wooden chair in a plaster room",
        ],
        "world": "delta humidity, cheap rooms",
    },
    "jazz": {
        "dirs": ["still_life", "film_still", "abstract_paint", "screenprint"],
        "subjects": [
            "a folded newspaper and a whisky glass on a bar",
            "a stack of records leaning against a radiator",
            "smoke curling under a low ceiling lamp",
            "a chair and a music stand in an empty room",
        ],
        "world": "1959 Manhattan, late, blue-grey",
    },
    "rock": {
        "dirs": ["xerox_punk", "film_still", "screenprint", "collage"],
        "subjects": [
            "a scorched cymbal lying on black gravel",
            "a dented amplifier cabinet against a breeze-block wall",
            "a chain-link fence with a torn banner in it",
            "an empty stage seen from the wings, gaffer tape on the boards",
        ],
        "world": "loading bay, sodium light, cigarette burns",
    },
    "alternative": {
        "dirs": ["riso", "collage", "film_still", "photo_texture"],
        "subjects": [
            "a cheap plastic chair on wet concrete",
            "a net curtain against a bright window",
            "a payphone with its cord cut",
            "a bunch of keys on a formica table",
        ],
        "world": "suburban, overcast, slightly bleak",
    },
    "indie": {"alias": "alternative"},
    "grunge": {
        "dirs": ["xerox_punk", "film_still", "collage", "photo_texture"],
        "subjects": [
            "a garage door with flaking paint and an oil stain",
            "a flannel shirt crumpled on a bathroom tile floor",
            "a cracked skate ramp under pine trees",
            "a strip-lit corridor with one dead tube",
        ],
        "world": "Pacific northwest, damp, 1992",
    },
    "punk": {
        "dirs": ["xerox_punk", "collage", "screenprint"],
        "subjects": [
            "a wall of torn and pasted paper layers",
            "a safety pin pushed through a vinyl jacket",
            "a bent road sign photographed with a flash",
        ],
        "world": "1977, photocopier, spray paint",
    },
    "nu-metal": {
        "dirs": ["xerox_punk", "photo_texture", "film_still"],
        "subjects": [
            "a rusted steel shutter with a scuffed kick mark",
            "cracked safety glass in a wire mesh",
            "an industrial extractor fan choked with dust",
        ],
        "world": "warehouse, chrome and grime, 2001",
    },
    "metal": {
        "dirs": ["lithograph", "photo_texture", "xerox_punk", "ceramic_form"],
        "subjects": [
            "a wet basalt cliff face under low cloud",
            "an iron chain over black sand",
            "a burnt pine forest in snow",
        ],
        "world": "northern, cold, severe",
    },
    "pop": {
        "dirs": ["still_life", "screenprint", "riso", "airbrush_70s"],
        "subjects": [
            "a single glossy balloon against a seamless backdrop",
            "a scoop of sorbet melting on a coloured plinth",
            "a plastic flower in a cut-glass tumbler",
            "a swimming pool corner with one float",
        ],
        "world": "clean set, bright saturated colour, hard shadow",
    },
    "k-pop": {
        "dirs": ["still_life", "screenprint", "film_still"],
        "subjects": [
            "chrome hair clips arranged on pink acrylic",
            "a lace glove draped over a lacquered stool",
            "a cluster of glass marbles on a mirrored shelf",
            "a satin ribbon threaded through a metal grille",
        ],
        "world": "Seoul studio, glossy pastel, precise",
    },
    "dance": {
        "dirs": ["photo_texture", "long_exposure", "still_life", "screenprint"],
        "subjects": [
            "condensation running down a steel railing",
            "a crumpled mylar sheet under one hard light",
            "a concrete stairwell at first light",
            "a fire door propped open onto a bare yard",
        ],
        "world": "warehouse at 5am, cold light, no neon",
    },
    "edm": {"alias": "dance"}, "electronic": {"alias": "dance"},
    "house": {"alias": "dance"}, "techno": {"alias": "dance"},
    "disco": {
        "dirs": ["still_life", "airbrush_70s", "screenprint"],
        "subjects": [
            "a mirrored tile wall with one warm bulb",
            "a satin sleeve against a foil curtain",
            "a glass of something fizzing on a chrome table",
        ],
        "world": "1978, warm foil, hard flash",
    },
    "hip-hop": {
        "dirs": ["film_still", "collage", "xerox_punk", "still_life"],
        "subjects": [
            "a folding chair on a tenement roof at golden hour",
            "a payphone handset hanging off the hook",
            "a gold chain lying on a flatbed scanner",
            "a corner store awning with a broken letter board",
        ],
        "world": "1994 New York, summer heat, hard flash",
    },
    "lofi": {
        "dirs": ["film_still", "photo_texture", "riso"],
        "subjects": [
            "rain flecks on a window over a cold radiator",
            "a half-drunk mug of tea beside a desk lamp",
            "an unmade bed in late afternoon light",
            "a cassette deck with the door open",
        ],
        "world": "quiet room, soft grey afternoon, nothing happening",
    },
    "ambient": {
        "dirs": ["photo_texture", "abstract_paint", "long_exposure", "ceramic_form"],
        "subjects": [
            "fog lying flat over a reservoir at dawn",
            "a plaster cast fragment on grey paper",
            "frost spreading across dark glass",
            "the surface of still water holding one pale reflection",
        ],
        "world": "almost empty, cold, patient",
    },
    "classical": {
        "dirs": ["ceramic_form", "still_life", "lithograph", "film_still"],
        "subjects": [
            "a marble fragment on a wooden crate",
            "a folded orchestral score under a reading lamp",
            "dust in a shaft of light across a parquet floor",
        ],
        "world": "old hall, dark wood, restrained",
    },
    "orchestral": {"alias": "classical"}, "cinematic": {"alias": "classical"},
    "reggae": {
        "dirs": ["film_still", "riso", "screenprint"],
        "subjects": [
            "a sun-bleached corrugated wall behind a plantain leaf",
            "a hand-painted sign on a roadside shack",
            "a speaker box stacked on a dirt yard",
        ],
        "world": "Kingston, hard sun, faded paint",
    },
    "synthwave": {
        "dirs": ["long_exposure", "airbrush_70s", "photo_texture"],
        "subjects": [
            "palm shadows falling on a stucco wall at dusk",
            "a cracked swimming pool lit from below",
            "an empty parking lot with one lamp on",
        ],
        "world": "1984 suburbia, dusk, restrained colour",
    },
    "chiptune": {"alias": "dance"},
    "soundtrack": {"alias": "classical"},
    "latin": {
        "dirs": ["film_still", "screenprint", "riso"],
        "subjects": [
            "painted tiles behind a tin cup of coffee",
            "papel picado flags against a white wall",
            "a market table of chillies in flat noon light",
        ],
        "world": "hot noon, saturated paint, hand-lettered signage removed",
    },
    "world": {"alias": "latin"},
}

# Broad buckets that lose to a more specific genre in the same tag list.
UMBRELLA_GENRES = {"pop", "rock", "alternative", "indie", "folk", "dance",
                   "electronic", "world", "soundtrack", "cinematic"}

# mood -> light and colour treatment
MOODS = {
    "melancholic": "overcast, desaturated, long soft shadows, cool grey cast",
    "sad": "underexposed, muted, heavy shadow",
    "dark": "very low key, deep blacks, one small highlight",
    "nostalgic": "faded dye, warm sun-bleach, slight fog and age",
    "bittersweet": "late afternoon light going cold, gentle haze",
    "peaceful": "soft diffuse light, calm, clean tonal steps",
    "smooth": "soft even light, gentle falloff, rich midtones",
    "warm": "warm tungsten cast, amber shadows",
    "happy": "clear bright daylight, clean saturated colour",
    "upbeat": "bright hard light, punchy saturated colour",
    "energetic": "hard direct flash, high contrast, a little motion smear",
    "playful": "hard flash, bold flat colour, odd cropping",
    "epic": "wide horizon, dramatic raking light, huge empty sky",
    "anthemic": "big raking light, long shadows, monumental scale",
    "aggressive": "harsh contrast, blown highlights, crushed blacks",
    "tense": "cold hard light, uncomfortable cropping",
    "dreamy": "diffused haze, gentle bloomless glow, pastel",
    "raw": "unfiltered daylight, no polish, honest",
    "bright": "high key, clean white light",
    "resonant": "deep even light, generous space",
    "rich": "saturated deep colour, velvety shadow",
    "hypnotic": "even repetitive light, quiet",
    "romantic": "warm low sun, soft edges",
    "triumphant": "high sun, strong clean shadows",
    # the coarse moods backend/cover.py hands us
    "calm": "quiet even light, unhurried, restrained colour",
    "neutral": "plain daylight, honest colour, nothing dramatic",
}

# tag -> a place, if the tag names one
PLACES = {
    "concert hall": "in an empty concert hall",
    "stadium": "in an empty stadium at dusk",
    "bar": "in a dim bar after closing",
    "church": "in a small wooden church",
    "cathedral": "in a stone cathedral aisle",
    "studio": "on a studio floor with a paper backdrop",
    "street": "on a wet street",
    "beach": "on a cold empty beach",
    "desert": "on a flat desert road",
    "forest": "at the edge of a wet forest",
    "road trip": "on a long empty highway",
    "travel": "on a station platform",
    "space": "under a very deep night sky",
    "garage": "in a single-car garage",
    "club": "in an empty club before opening",
}

# tag -> an object prop, used only in directions where props read well
PROPS = {
    "electric guitar": "an electric guitar leaning against the wall",
    "acoustic guitar": "an acoustic guitar case left open",
    "guitar": "a guitar case left open",
    "piano": "an upright piano with the lid open",
    "electric piano": "a small electric piano on a stand",
    "rhodes piano": "a Rhodes piano with a chipped corner",
    "organ": "a church organ bench",
    "violin": "a violin laid on a chair",
    "fiddle": "a fiddle and bow on a bench",
    "mandolin": "a mandolin hung on a nail",
    "ukulele": "a small ukulele on a striped blanket",
    "banjo": "a banjo propped on a porch rail",
    "drums": "a single snare drum on a bare floor",
    "heavy drums": "a dented kick drum on its side",
    "drum machine": "a battered drum machine with its faders up",
    "synthesizer": "a small analogue synth with patch cables",
    "saxophone": "a saxophone on a stool",
    "trumpet": "a trumpet on a folded cloth",
    "strings": "a bundle of spare strings coiled on paper",
    "choir": "rows of empty choir stalls",
    "tambourine": "a tambourine hanging from a hook",
    "harmonica": "a harmonica on a windowsill",
    "cassette": "a cassette with a hand-inked label removed",
    "vinyl": "a stack of sleeveless records",
}

# Composition: always leave the type somewhere to live.
COMPOSITIONS = [
    "the subject sits low and right, the whole upper left is plain empty tone",
    "the subject occupies the lower third, above it an uninterrupted plain field",
    "wide empty space on the left, the subject pushed to the right edge",
    "the subject small and centred low, large calm emptiness above it",
    "a plain flat band across the top two fifths, the subject below it",
    "the subject cropped at the right edge, the left half quiet and even",
]

# Goes near the FRONT of the prompt: SDXL weights early tokens hardest, and the
# single biggest failure mode is rendering a photo of a print lying on a table
# instead of the artwork itself.
FRAMING = ("full bleed artwork running off all four edges of the square, "
           "(no border and no margin:1.3)")

COMPOSITION_TAIL = ("one single clear subject, uncluttered, "
                    "(generous empty negative space:1.2), clear tonal separation, "
                    "confident contrast")

FIGURE_RULES = {
    "none": "no people at all",
    "silhouette": "if a person appears at all they are a flat silhouette with no face",
    "back_turned": "if a person appears they are seen from behind, face not visible",
    "fragment": "any person is a torn paper fragment, no whole face",
    "engraved": "any figure is a small engraved silhouette",
    "small_distant": "any figure is tiny and far away",
    "blurred": "any figure is a long-exposure blur, unrecognisable",
}

NEGATIVE_BASE = (
    "(text:1.5), (letters:1.5), (lettering:1.5), (words:1.4), writing, handwriting, "
    "typography, title, caption, subtitles, numbers, dates, signature, autograph, "
    "(watermark:1.4), stamp, (logo:1.4), brand, labels, packaging, book, magazine, "
    "poster mockup, price tag, barcode, ui, menu, speech bubble, "
    "(white margin:1.5), (border:1.5), (paper edge:1.4), deckle edge, caption strip, "
    "print laid on a background, matted print, scan of a whole sheet, "
    # the objects that carry invented text into a picture
    "(index card:1.3), business card, filing card, leaflet, flyer, brochure, "
    "document, receipt, form, envelope, letter, ticket, certificate, "
    # never a picture of a picture
    "(photograph of a print:1.4), sheet of paper on a wall, pinned poster, "
    "mounted print, framed artwork, mat board, gallery wall, easel, canvas on a stand, "
    "product shot, drop shadow under the artwork, "
    "deformed hands, extra fingers, missing fingers, mangled fingers, extra limbs, "
    "extra arms, fused bodies, distorted anatomy, mutated, uncanny face, dead eyes, "
    "asymmetric eyes, plastic skin, waxy skin, "
    "trending on artstation, deviantart, concept art, matte painting, artstation, "
    "cgi, 3d render, octane render, unreal engine, blender, ray tracing, "
    "hdr, oversaturated, oversharpened, overprocessed, instagram filter, "
    "neon glow, glowing edges, bloom, lens flare, light streaks, god rays, sparkles, "
    "fractal, kaleidoscope, mandala, sacred geometry, wallpaper pattern, tiling, "
    "cyberpunk, vaporwave, retrowave grid, wireframe landscape, "
    "busy cluttered composition, many small objects, split panels, diptych, triptych, "
    "grid of thumbnails, picture frame, photo border, white border, vignette, "
    "muddy colour, grey mush, low contrast haze, blurry, out of focus, jpeg artifacts, "
    "watermarked stock photo, getty images, "
    "(nude:1.4), naked body, pencil signature, edition number, artist monogram"
)


def _hex_to_rgb(h: str):
    h = (h or "").strip().lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) != 6:
        return None
    try:
        return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


# Ink names an image model actually understands, with their RGB anchors.
_COLOUR_NAMES = [
    ("soft black", (24, 24, 26)), ("charcoal", (54, 54, 58)), ("warm grey", (140, 133, 124)),
    ("cool grey", (150, 158, 165)), ("bone white", (240, 236, 226)), ("paper cream", (236, 224, 198)),
    ("oxblood red", (110, 28, 32)), ("vermilion red", (216, 62, 40)), ("coral pink", (240, 128, 116)),
    ("bubblegum pink", (240, 150, 190)), ("magenta", (196, 40, 120)), ("plum purple", (92, 50, 100)),
    ("lilac", (176, 160, 214)), ("ultramarine blue", (42, 56, 150)), ("cobalt blue", (34, 92, 176)),
    ("sky blue", (130, 186, 222)), ("teal", (24, 120, 124)), ("bottle green", (28, 74, 54)),
    ("olive green", (110, 118, 60)), ("lime green", (160, 200, 80)), ("mustard yellow", (206, 168, 46)),
    ("butter yellow", (240, 214, 130)), ("orange ochre", (200, 122, 40)), ("burnt sienna", (150, 78, 46)),
    ("chocolate brown", (78, 52, 40)), ("sand beige", (208, 186, 152)), ("mint", (168, 216, 198)),
    ("navy", (26, 38, 72)), ("rust", (162, 76, 40)), ("silver", (198, 200, 204)),
]


def _colour_name(rgb) -> str:
    best, bd = "soft black", 1e9
    r, g, b = rgb
    for name, (nr, ng, nb) in _COLOUR_NAMES:
        # weighted RGB distance: closer to how we read hue than plain euclidean
        d = 2.0 * (r - nr) ** 2 + 4.0 * (g - ng) ** 2 + 3.0 * (b - nb) ** 2
        if d < bd:
            bd, best = d, name
    return best


def _palette_phrase(palette, rng) -> str:
    names, seen = [], set()
    for h in (palette or [])[:6]:
        rgb = _hex_to_rgb(h if isinstance(h, str) else "")
        if not rgb:
            continue
        n = _colour_name(rgb)
        if n not in seen:
            seen.add(n)
            names.append(n)
    if not names:
        return ""
    names = names[:3]
    if len(names) == 1:
        return "a restricted palette of %s with paper white" % names[0]
    return "a restricted palette of %s and %s" % (", ".join(names[:-1]), names[-1])


_WORD = re.compile(r"[^a-z0-9&+ -]+")


def _norm(s) -> str:
    return _WORD.sub("", str(s or "").lower()).strip()


def _split_tags(style) -> list:
    raw = style.get("tags") or []
    if isinstance(raw, str):
        raw = re.split(r"[,\n;|]+", raw)
    out = []
    for t in raw:
        t = _norm(t)
        if t:
            out.append(t)
    return out


def _resolve_genre(style, tags):
    """Find the best genre entry from style['genre'] then the tag list.

    Tag lists from the app look like "male vocals, bar, folk, raw, celtic,
    sea shanty" - the interesting genre is rarely the first one, so an umbrella
    like "folk" loses to anything more specific that is also tagged.
    """
    def entry(key):
        ent = GENRES[key]
        while "alias" in ent:
            ent = GENRES.get(ent["alias"], {})
        return ent

    explicit = _norm(style.get("genre"))
    if explicit in GENRES:
        return explicit, entry(explicit)

    hits = [t for t in tags if t in GENRES]
    for h in hits:
        if h not in UMBRELLA_GENRES:
            return h, entry(h)
    if hits:
        return hits[0], entry(hits[0])
    cands = [explicit] + tags
    # substring pass: "alternative rock", "k pop", "nu metal"
    joined = " ".join(cands)
    for key in sorted(GENRES, key=len, reverse=True):
        probe = key.replace("-", " ")
        if probe in joined.replace("-", " "):
            ent = GENRES[key]
            while "alias" in ent:
                ent = GENRES.get(ent["alias"], {})
            return key, ent
    return "alternative", GENRES["alternative"]


_SLUG = re.compile(r"[^a-z0-9]+")


def _slug(s) -> str:
    """'Film Still' / 'film-still' / 'film_still' -> 'film_still'."""
    return _SLUG.sub("_", str(s or "").lower()).strip("_")


def _resolve_direction(style, genre_entry, rng):
    for key in ("ai_direction", "art_direction", "direction"):
        raw = _slug(style.get(key))
        if not raw:
            continue
        if raw in DIRECTIONS:
            return raw
        if raw in DIRECTION_ALIASES:
            return DIRECTION_ALIASES[raw]
        for word in raw.split("_"):
            if word in DIRECTION_ALIASES:
                return DIRECTION_ALIASES[word]
    dirs = genre_entry.get("dirs") or list(DIRECTIONS)
    return rng.choice(dirs)


def _resolve_mood(style, tags, rng) -> str:
    bits, seen = [], set()
    for c in [_norm(style.get("mood"))] + tags:
        if c in MOODS and c not in seen:
            seen.add(c)
            bits.append(MOODS[c])
        if len(bits) >= 2:
            break
    return ", ".join(bits)


def describe(seed: int, style: dict | None = None) -> dict:
    """Resolve a style into the exact prompt/sampler settings we would use.

    Pure and deterministic - handy for tests, docs and for logging what a cover
    was actually asked for. Never raises.
    """
    style = dict(style or {})
    try:
        seed = int(seed)
    except Exception:
        seed = 0
    seed &= (1 << 63) - 1
    rng = random.Random(seed ^ 0x57415645)          # stable, independent of the sampler seed

    tags = _split_tags(style)
    genre_key, genre = _resolve_genre(style, tags)
    dkey = _resolve_direction(style, genre, rng)
    d = DIRECTIONS.get(dkey) or DIRECTIONS["riso"]

    subjects = genre.get("subjects") or GENRES["alternative"]["subjects"]
    subject = rng.choice(subjects)

    place = ""
    for t in tags:
        if t in PLACES:
            place = PLACES[t]
            break

    prop = ""
    if d.get("props_ok") and rng.random() < 0.45:
        for t in tags:
            if t in PROPS:
                prop = PROPS[t]
                break

    mood = _resolve_mood(style, tags, rng)
    palette = _palette_phrase(style.get("palette"), rng)
    comp = rng.choice(COMPOSITIONS)
    figures = FIGURE_RULES.get(d.get("figures", "none"), FIGURE_RULES["none"])
    want_face = any(t in ("portrait", "face", "band photo") for t in tags)

    # The medium has to win the argument with the subject, or SDXL turns every
    # direction into "moody 35mm photograph". So: a weighted plain noun for the
    # medium first, the process detail second, and a short weighted reminder at
    # the end (which lands in CLIP's second 75-token chunk and carries weight
    # there too). Graphic media also restate the subject as flat shapes.
    sub_tmpl = d.get("sub") or "%s"
    subject = sub_tmpl % subject

    parts = [d.get("lead", ""), d["medium"], FRAMING, subject]
    if prop:
        parts.append(prop)
    if place:
        parts.append(place)
    if genre.get("world"):
        parts.append(genre["world"])
    if mood:
        parts.append(mood)
    parts.append(d["light"])
    if palette:
        parts.append(palette)
    parts.append(comp)
    parts.append(COMPOSITION_TAIL)
    # Never spell out "person" or "face" in a positive prompt just to forbid
    # them - CLIP has no "not", and naming them is how you summon them. (A
    # round of screenprints came back with a nude because of exactly that.)
    parts.append(figures if want_face else "nobody present, an empty scene")
    parts.append(d.get("tail", ""))
    positive = ", ".join(p for p in parts if p)

    negative = NEGATIVE_BASE
    if d.get("neg"):
        negative += ", " + d["neg"]
    if not want_face:
        negative += (", (person:1.5), (human face:1.5), (man:1.4), (woman:1.4), "
                     "(human body:1.4), portrait, sitting figure, standing figure, eyes, "
                     "crowd, hands, fingers, mannequin")

    steps = d.get("steps", 26)
    cfg = d.get("cfg", 6.0)
    try:
        if _env("WAIVEPULSE_COVER_AI_STEPS"):
            steps = int(_env("WAIVEPULSE_COVER_AI_STEPS"))
        if _env("WAIVEPULSE_COVER_AI_CFG"):
            cfg = float(_env("WAIVEPULSE_COVER_AI_CFG"))
    except ValueError:
        pass

    return {
        "positive": positive,
        "negative": negative,
        "direction": dkey,
        "direction_label": d["label"],
        "genre": genre_key,
        "subject": subject,
        "steps": int(steps),
        "cfg": float(cfg),
        "sampler": "dpmpp_2m",
        "scheduler": "karras",
        "seed": seed,
        "model": _model_name(),
    }


# --------------------------------------------------------------------------- #
# GPU manners
# --------------------------------------------------------------------------- #

def _run(cmd, timeout=15):
    """Quiet subprocess - no console window ever pops up."""
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                              creationflags=CREATE_NO_WINDOW)
    except Exception:
        return None


def vram_free_mb():
    """Free VRAM in MB, or None if nvidia-smi is not answering."""
    exe = shutil.which("nvidia-smi") or r"C:\Windows\System32\nvidia-smi.exe"
    r = _run([exe, "--query-gpu=memory.free", "--format=csv,noheader,nounits"], timeout=15)
    if not r or r.returncode != 0 or not r.stdout.strip():
        return None
    try:
        return min(int(x.strip()) for x in r.stdout.strip().splitlines() if x.strip())
    except ValueError:
        return None


def _http(url, data=None, timeout=10, method=None):
    req = urllib.request.Request(url, data=data, method=method,
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        body = r.read()
    return body


def _http_json(url, payload=None, timeout=10):
    data = json.dumps(payload).encode() if payload is not None else None
    return json.loads(_http(url, data=data, timeout=timeout).decode("utf-8", "replace"))


def _ollama_loaded():
    """Names of models Ollama currently holds on the GPU (empty list if none/down)."""
    try:
        j = _http_json(OLLAMA + "/api/ps", timeout=4)
    except Exception:
        return []
    out = []
    for m in (j.get("models") or []):
        n = m.get("name") or m.get("model")
        if n:
            out.append(n)
    return out


def _ollama_unload():
    """Ask Ollama to drop every model it is holding. Returns how many we asked for."""
    names = _ollama_loaded()
    for n in names:
        try:
            _http(OLLAMA + "/api/generate",
                  data=json.dumps({"model": n, "keep_alive": 0, "prompt": ""}).encode(),
                  timeout=20)
        except Exception:
            pass
    if names:
        time.sleep(2.0)
    return len(names)


def _gpu_ready(need_mb, deadline=None, may_unload=True):
    """(ok, reason). Frees Ollama first if that is what is in the way."""
    free = vram_free_mb()
    if free is None:
        return False, "no GPU found (nvidia-smi did not answer)"
    if free >= need_mb:
        return True, "%d MB free" % free
    if may_unload and _ollama_loaded():
        n = _ollama_unload()
        _log("asked Ollama to unload %d model(s)" % n)
        for _ in range(8):
            if deadline and time.time() > deadline:
                break
            free2 = vram_free_mb() or 0
            if free2 >= need_mb:
                return True, "%d MB free after unloading %d Ollama model(s)" % (free2, n)
            time.sleep(1.0)
        free = vram_free_mb() or free
    return False, ("GPU busy - only %d MB free, need %d MB (something else is "
                   "generating; try again when it finishes)" % (free, need_mb))


# --------------------------------------------------------------------------- #
# the throwaway ComfyUI
# --------------------------------------------------------------------------- #

class _Comfy:
    """A ComfyUI we start, use and stop. Reuses one the owner already has up."""

    def __init__(self, port=None):
        self.port = port or _port()
        self.base = "http://127.0.0.1:%d" % self.port
        self.proc = None            # set only if *we* started it
        self.foreign = False        # someone else's server -> never stop it
        self.log_path = None
        self.last_used = 0.0
        self.loaded = None          # checkpoint this server currently holds

    # -- plumbing ---------------------------------------------------------- #
    def ping(self, timeout=2.5):
        try:
            _http_json(self.base + "/system_stats", timeout=timeout)
            return True
        except Exception:
            return False

    def alive(self):
        if self.foreign:
            return self.ping()
        return self.proc is not None and self.proc.poll() is None

    def start(self, deadline):
        if self.ping():
            self.foreign = self.proc is None
            _log("reusing a ComfyUI already listening on %d" % self.port)
            return True, "reused a ComfyUI already on port %d" % self.port

        root = _comfy_root()
        py = os.path.join(root, "python_embeded", "python.exe")
        main = os.path.join(root, "ComfyUI", "main.py")
        if not (os.path.isfile(py) and os.path.isfile(main)):
            return False, "ComfyUI portable not found at %s" % root

        work = _workdir()
        self.log_path = os.path.join(work, "comfyui.log")
        try:
            logf = open(self.log_path, "wb")
        except Exception:
            logf = subprocess.DEVNULL

        cmd = [py, "-s", main,
               "--port", str(self.port), "--listen", "127.0.0.1",
               "--disable-auto-launch", "--dont-print-server",
               "--disable-all-custom-nodes", "--disable-api-nodes",
               "--deterministic",
               "--output-directory", os.path.join(work, "out"),
               "--temp-directory", os.path.join(work, "tmp"),
               "--user-directory", os.path.join(work, "user")]
        if os.path.isfile(_PATHS_YAML):
            cmd += ["--extra-model-paths-config", _PATHS_YAML]

        try:
            self.proc = subprocess.Popen(
                cmd, cwd=os.path.join(root, "ComfyUI"),
                stdin=subprocess.DEVNULL, stdout=logf, stderr=subprocess.STDOUT,
                creationflags=CREATE_NO_WINDOW)
        except Exception as e:
            return False, "could not start ComfyUI (%s)" % e

        t0 = time.time()
        while time.time() < deadline:
            if self.proc.poll() is not None:
                return False, "ComfyUI exited on startup (rc=%s, see %s)" % (
                    self.proc.returncode, self.log_path)
            if self.ping():
                _log("ComfyUI up in %.1fs (pid %s)" % (time.time() - t0, self.proc.pid))
                return True, "started in %.0fs" % (time.time() - t0)
            time.sleep(0.75)
        self.stop()
        return False, "ComfyUI did not come up before the timeout"

    def free_models(self, wait=12.0):
        """Unload the checkpoint but leave the process; nothing stays resident.

        ComfyUI acts on /free from its worker loop, so the VRAM comes back a
        moment later - we wait for nvidia-smi to agree rather than guess.
        """
        before = vram_free_mb()
        try:
            _http(self.base + "/free",
                  data=json.dumps({"unload_models": True, "free_memory": True}).encode(),
                  timeout=30)
        except Exception:
            return
        self.loaded = None
        if not wait or before is None:
            return
        t0 = time.time()
        while time.time() - t0 < wait:
            time.sleep(0.8)
            now = vram_free_mb()
            if now is None or now >= before + 2000:
                break

    def interrupt(self):
        try:
            _http(self.base + "/interrupt", data=b"{}", timeout=5)
        except Exception:
            pass

    def stop(self):
        """Kill only the process we started. Never touches a foreign server."""
        p, self.proc = self.proc, None
        if p is None or p.poll() is not None:
            return
        try:
            _run(["taskkill", "/PID", str(p.pid), "/T", "/F"], timeout=15)
        except Exception:
            pass
        try:
            p.wait(timeout=8)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass

    # -- work -------------------------------------------------------------- #
    def submit(self, graph, client_id):
        j = _http_json(self.base + "/prompt",
                       {"prompt": graph, "client_id": client_id}, timeout=60)
        pid = j.get("prompt_id")
        if not pid:
            raise RuntimeError("ComfyUI refused the graph: %s" % str(j)[:300])
        return pid

    def wait(self, prompt_id, deadline, cancel=None):
        """Poll /history until the job lands. Returns the history entry."""
        while True:
            if cancel is not None and cancel.is_set():
                raise TimeoutError("cancelled")
            if time.time() > deadline:
                raise TimeoutError("ran out of time waiting for ComfyUI")
            if not self.alive():
                raise RuntimeError("ComfyUI stopped while rendering")
            try:
                h = _http_json("%s/history/%s" % (self.base, prompt_id), timeout=10)
            except Exception:
                h = {}
            entry = h.get(prompt_id)
            if entry:
                status = (entry.get("status") or {})
                if status.get("status_str") == "error" or status.get("completed") is False:
                    msgs = json.dumps(status.get("messages") or [])[:400]
                    if status.get("status_str") == "error":
                        raise RuntimeError("ComfyUI reported an error: %s" % msgs)
                return entry
            time.sleep(0.5)

    def fetch_image(self, info, deadline):
        q = urllib.parse.urlencode({"filename": info.get("filename", ""),
                                    "subfolder": info.get("subfolder", ""),
                                    "type": info.get("type", "output")})
        left = max(5.0, min(60.0, deadline - time.time()))
        return _http(self.base + "/view?" + q, timeout=left)


# One server at a time, one generation at a time.
_LOCK = threading.Lock()
_SESSION = None
_REAPER = None


def _session_get(deadline):
    global _SESSION
    s = _SESSION
    if s is not None and s.alive():
        return s, "reused session"
    s = _Comfy()
    ok, why = s.start(deadline)
    if not ok:
        _SESSION = None
        return None, why
    _SESSION = s
    return s, why


def _session_release(now=None):
    """Drop the model. Killing our own server is the fastest way to be sure."""
    global _SESSION, _REAPER
    s = _SESSION
    if s is None:
        return
    s.last_used = now or time.time()
    if _keep_alive() <= 0 or s.foreign:
        if s.foreign:
            s.free_models()              # not ours to kill - unload politely
        else:
            s.stop()                     # process death returns every byte
        _SESSION = None
        return
    s.free_models()                      # keep-alive: server stays, model does not
    if _REAPER is None or not _REAPER.is_alive():
        _REAPER = threading.Thread(target=_reap_loop, name="cover_ai-reaper", daemon=True)
        _REAPER.start()


def _reap_loop():
    global _SESSION
    while True:
        time.sleep(2.0)
        s = _SESSION
        if s is None:
            return
        if time.time() - (s.last_used or 0) > _keep_alive():
            with _LOCK:
                s = _SESSION
                if s is not None and time.time() - (s.last_used or 0) > _keep_alive():
                    _log("idle - shutting the ComfyUI down")
                    s.stop()
                    _SESSION = None
            return


def shutdown():
    """Stop any ComfyUI this module started. Safe to call any time."""
    global _SESSION
    s, _SESSION = _SESSION, None
    if s is None:
        return
    try:
        if s.foreign:
            s.free_models()      # someone else's server: unload, never kill
        else:
            s.stop()
    except Exception:
        pass


# --------------------------------------------------------------------------- #
# public API
# --------------------------------------------------------------------------- #

def _checkpoint_path():
    """Where the chosen checkpoint lives on disk, or None if we cannot tell."""
    name = _model_name()
    roots = [r"F:\StableDiffusion\stable-diffusion-webui\models\Stable-diffusion",
             os.path.join(_comfy_root(), "ComfyUI", "models", "checkpoints")]
    for r in roots:
        p = os.path.join(r, name)
        if os.path.isfile(p):
            return p
    return None


def available():
    """(usable_right_now, plain-words reason).

    Honest about a busy GPU: if something else is holding the card and Ollama
    is not the culprit, this says so instead of pretending.
    """
    try:
        if not _env_flag("WAIVEPULSE_COVER_AI", True):
            return False, "switched off (WAIVEPULSE_COVER_AI=0)"
        if Image is None:
            return False, "Pillow is not installed"
        root = _comfy_root()
        py = os.path.join(root, "python_embeded", "python.exe")
        if not os.path.isfile(py):
            return False, "ComfyUI portable not found at %s" % root
        if not os.path.isfile(os.path.join(root, "ComfyUI", "main.py")):
            return False, "ComfyUI is missing main.py under %s" % root
        if not os.path.isfile(_WORKFLOW):
            return False, "the cover workflow is missing (%s)" % _WORKFLOW
        if _checkpoint_path() is None:
            return False, "checkpoint %s is not on disk" % _model_name()

        need = _min_free_mb()
        free = vram_free_mb()
        if free is None:
            return False, "no usable GPU (nvidia-smi did not answer)"
        if free >= need:
            return True, "ready - %d MB of VRAM free, %s" % (free, _model_name())
        held = _ollama_loaded()
        if held:
            # we can reclaim that without hurting anyone
            return True, ("ready once Ollama drops %d idle model(s) - only %d MB free now"
                          % (len(held), free))
        return False, ("GPU busy - only %d MB free, need %d MB (another render or "
                       "separation has the card)" % (free, need))
    except Exception as e:                                   # never raise
        return False, "cover AI unavailable (%s)" % e


def warmup():
    """Cheap preflight: touch the paths and the GPU so the first real call is
    not also the first time we learn something is missing. Never loads a model,
    never starts a server, never raises."""
    try:
        available()
        if os.path.isfile(_WORKFLOW):
            _load_graph()
        _workdir()
    except Exception:
        pass


def _load_graph():
    with open(_WORKFLOW, "r", encoding="utf-8") as f:
        return json.load(f)


def _build_graph(plan, px, prefix):
    g = _load_graph()
    g.pop("_comment", None)
    g["4"]["inputs"]["ckpt_name"] = plan["model"]
    g["5"]["inputs"]["width"] = px
    g["5"]["inputs"]["height"] = px
    g["5"]["inputs"]["batch_size"] = 1
    g["6"]["inputs"]["text"] = plan["positive"]
    g["7"]["inputs"]["text"] = plan["negative"]
    g["3"]["inputs"]["seed"] = plan["seed"]
    g["3"]["inputs"]["steps"] = plan["steps"]
    g["3"]["inputs"]["cfg"] = plan["cfg"]
    g["3"]["inputs"]["sampler_name"] = plan["sampler"]
    g["3"]["inputs"]["scheduler"] = plan["scheduler"]
    g["9"]["inputs"]["filename_prefix"] = prefix
    return g


def _debleed(img, max_crop=0.16):
    """Crop a flat paper margin off the outside of the picture.

    SDXL loves to answer "screen print" with a photograph of a print lying on a
    sheet, complete with a white margin and a line of invented caption text.
    The prompt fights that; this is the safety net that removes it (and the tiny
    text living in the margin) when it slips through. Purely deterministic: it
    only cuts while the outermost ring of pixels is a flat, uniform colour.
    """
    try:
        px = img.convert("RGB").load()
        w, h = img.size
        if w < 64 or h < 64:
            return img
        limit_x, limit_y = int(w * max_crop), int(h * max_crop)
        step = max(1, w // 128)

        def var_of(vals):
            n = len(vals)
            if not n:
                return 1e9
            m = [sum(c[i] for c in vals) / n for i in range(3)]
            return sum((c[i] - m[i]) ** 2 for c in vals for i in range(3)) / (3 * n)

        # how busy is the picture itself? a flat margin has to be much calmer
        mid = [px[x, h // 2] for x in range(w // 4, 3 * w // 4, step)]
        thresh = max(22.0, min(90.0, var_of(mid) * 0.05))

        def edge(count, line, allow=16):
            """Last index from this edge that still looks like flat margin.

            A line or two of invented caption text sits inside the margin, so we
            step over a short busy run instead of stopping dead at it.
            """
            last, bad = -1, 0
            for i in range(count):
                if var_of(line(i)) < thresh:
                    last, bad = i, 0
                else:
                    bad += 1
                    if bad > allow:
                        break
            return last + 1

        left_line = lambda i: [px[i, y] for y in range(0, h, step)]          # noqa: E731
        right_line = lambda i: [px[w - 1 - i, y] for y in range(0, h, step)]  # noqa: E731
        top_line = lambda i: [px[x, i] for x in range(0, w, step)]            # noqa: E731
        bot_line = lambda i: [px[x, h - 1 - i] for x in range(0, w, step)]    # noqa: E731

        widths = [edge(limit_x, left_line), edge(limit_x, right_line),
                  edge(limit_y, top_line), edge(limit_y, bot_line)]

        # Only a margin on (nearly) every side is a printed sheet. A flat field
        # on one or two edges is the composition doing its job - that is the
        # empty area the caller sets type into, and cropping it would undo the
        # whole point. A colour-matched version of this test was tried and
        # rejected: it ate 30% of a foggy photograph.
        if sum(1 for x in widths if x >= 6) < 3:
            return img
        l, t = widths[0], widths[2]
        r, b = w - 1 - widths[1], h - 1 - widths[3]
        if r - l < w * 0.5 or b - t < h * 0.5:
            return img
        if (l or t or r != w - 1 or b != h - 1):
            # square the crop back up around the middle of what is left
            side = min(r - l + 1, b - t + 1)
            cx, cy = (l + r) // 2, (t + b) // 2
            x0 = max(0, min(w - side, cx - side // 2))
            y0 = max(0, min(h - side, cy - side // 2))
            if side < min(w, h):
                _log("debleed: cropped %dpx of flat margin" % ((min(w, h) - side) // 2))
                return img.crop((x0, y0, x0 + side, y0 + side))
        return img
    except Exception:
        return img


def _square(img, size):
    if img.width != img.height:
        s = min(img.width, img.height)
        l = (img.width - s) // 2
        t = (img.height - s) // 2
        img = img.crop((l, t, l + s, t + s))
    if size and img.width != size:
        img = img.resize((size, size), Image.LANCZOS)
    return img.convert("RGB")


def _render(plan, size, deadline, cancel, keep_session):
    """Do the work. Runs inside the worker thread, holds the lock."""
    t0 = time.time()
    # If our own session already holds this checkpoint, the "missing" VRAM is
    # ours - re-running the free-memory gate would lock us out of our own card.
    warm = (_SESSION is not None and _SESSION.alive()
            and _SESSION.loaded == plan["model"])
    if not warm:
        ok, why = _gpu_ready(_min_free_mb(), deadline=deadline)
        if not ok:
            return None, why
        _log("gpu: " + why)

    s, why = _session_get(deadline)
    if s is None:
        return None, why
    _log("server: " + why)

    prefix = "wp_%016x" % (plan["seed"] & 0xFFFFFFFFFFFFFFFF)
    graph = _build_graph(plan, NATIVE, prefix)
    client_id = hashlib.sha1(prefix.encode()).hexdigest()[:16]
    try:
        pid = s.submit(graph, client_id)
        entry = s.wait(pid, deadline, cancel)
        imgs = []
        for node in (entry.get("outputs") or {}).values():
            imgs += (node.get("images") or [])
        if not imgs:
            return None, "ComfyUI produced no image"
        raw = s.fetch_image(imgs[0], deadline)
        img = Image.open(io.BytesIO(raw))
        img.load()
        s.loaded = plan["model"]
    except TimeoutError as e:
        s.interrupt()
        return None, "timed out (%s)" % e
    except Exception as e:
        return None, "render failed (%s)" % e
    finally:
        if keep_session:
            s.last_used = time.time()    # batch run: the model stays for the next image
        else:
            _session_release()

    out = _square(_debleed(img), size)
    _log("done in %.1fs (%s / %s)" % (time.time() - t0, plan["direction"], plan["genre"]))
    return out, "ok in %.0fs" % (time.time() - t0)


def background(seed: int, size: int = 1024, style: dict | None = None, timeout: int = 180):
    """A square painted/photographic background with NO text in it, or None.

    Never raises and never blocks longer than ``timeout`` seconds: the render
    runs on a daemon thread, and if it overruns we abandon it (it interrupts
    ComfyUI and shuts the server down on its own) and return None.
    """
    try:
        if Image is None:
            return None
        ok, why = available()
        if not ok:
            _log("unavailable: " + why)
            return None
        try:
            size = int(size or NATIVE)
        except Exception:
            size = NATIVE
        size = max(128, min(4096, size))
        timeout = max(5.0, float(timeout or 180))

        box = {}
        cancel = threading.Event()

        def work():
            deadline = time.time() + timeout
            got = _LOCK.acquire(timeout=max(1.0, min(30.0, timeout)))
            if not got:
                box["why"] = "another cover is already rendering"
                return
            try:
                plan = describe(seed, style)
                img, why = _render(plan, size, deadline, cancel, False)
                box["img"], box["why"] = img, why
            except Exception as e:                    # belt and braces
                box["why"] = "unexpected: %s" % e
            finally:
                _LOCK.release()

        th = threading.Thread(target=work, name="cover_ai", daemon=True)
        th.start()
        th.join(timeout)
        if th.is_alive():
            cancel.set()
            _log("timeout after %.0fs - abandoning the render" % timeout)
            threading.Thread(target=_abandon, name="cover_ai-abandon", daemon=True).start()
            return None
        if box.get("img") is None:
            _log("no image: %s" % box.get("why"))
        return box.get("img")
    except Exception as e:
        _log("background() swallowed %s" % e)
        return None


def _abandon():
    """Timed-out render: stop the sampler, then make sure nothing stays resident."""
    s = _SESSION
    if s is not None:
        try:
            s.interrupt()
        except Exception:
            pass
    time.sleep(2.0)
    shutdown()


def background_batch(jobs, size: int = 1024, timeout_each: int = 240):
    """Render several covers in ONE ComfyUI session (tools, sheets, tests).

    ``jobs`` is a list of ``(seed, style)`` pairs. Yields ``(seed, style, image
    or None, note)`` in order. The checkpoint is freed after every image and the
    server is shut down when the batch ends, so nothing is left resident.
    """
    out = []
    try:
        ok, why = available()
        if not ok:
            return [(s, st, None, why) for s, st in jobs]
        for seed, st in jobs:
            deadline = time.time() + max(10.0, float(timeout_each))
            with _LOCK:
                try:
                    plan = describe(seed, st)
                    img, note = _render(plan, size, deadline, None, keep_session=True)
                except Exception as e:
                    img, note = None, "failed (%s)" % e
            out.append((seed, st, img, note))
    finally:
        shutdown()
    return out


if __name__ == "__main__":                      # tiny manual smoke test
    os.environ.setdefault("WAIVEPULSE_COVER_AI_DEBUG", "1")
    print(available())
    plan = describe(1234, {"genre": "sea shanty", "mood": "epic",
                           "tags": ["celtic", "fiddle"], "title": "Tarot Pigs",
                           "palette": ["#1a2648", "#cea82e", "#ece0c6"]})
    print(json.dumps(plan, indent=1))
    t = time.time()
    im = background(1234, 1024, {"genre": "sea shanty", "mood": "epic",
                                 "tags": ["celtic", "fiddle"]})
    print("image:", im, "in %.1fs" % (time.time() - t))
    if im:
        p = os.path.join(_workdir(), "smoke.png")
        im.save(p)
        print("saved", p)
