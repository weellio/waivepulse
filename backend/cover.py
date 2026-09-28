"""
WAIvePulse cover art — design-led album sleeves.

Twelve hand-authored art directions (Swiss grid, Brutalist, Risograph, Blue
Note, Metal, Neon horizon, Minimal, Pop cut-out, Label mono, Letterpress,
Bauhaus, Xerox zine).  The direction is chosen deterministically from the song
(seed = job id + tags) but steered by the genre / mood tags, so a metal track
gets a metal sleeve and a jazz track gets a Blue Note one.

Design rules enforced by this module, not left to luck:

* Typography is the design.  Real open-licence faces are vendored in
  ``assets/fonts`` (see ``assets/fonts/LICENSES.md``); variable axes are set
  per direction (weight / width / optical size), tracking is real per-character
  letter-spacing, and every block is optically aligned by its ink bbox rather
  than by font metrics.
* Titles are wrapped on word boundaries, balanced (min-max line width via DP),
  shrunk to fit a fixed box, capped at 3 lines and ellipsised beyond.  A single
  word longer than the box is hyphen-broken rather than overflowing.
* Contrast is measured, not assumed: ``place()`` renders the glyph mask, reads
  the canvas pixels *under the glyphs*, computes the WCAG ratio against the
  worst of them and drops a solid plate (never a blur, never a soft shadow)
  when the ratio falls under 4.5:1.
* Palettes are hand-picked per direction, never random HSV, and never more
  than three hues on one sleeve.
* Texture is print texture: halftone screens, paper fibre, ink misregistration,
  toner dither, scanlines, press distress.

Optional AI art background (built by ``backend/cover_ai.py``, entirely
optional) is used as the *art layer* under the typography; the type and layout
still have to carry the sleeve.  If the module is missing, disabled or slow,
nothing changes.
"""

from __future__ import annotations

import hashlib
import math
import random
import re
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont

ROOT = Path(__file__).resolve().parent.parent
FONT_DIR = ROOT / "assets" / "fonts"

MIN_CONTRAST = 4.5          # WCAG AA for large text; we hold *all* type to it
MAX_LINES = 3


# ══════════════════════════════════════════════════════════════════════════════
#  Colour
# ══════════════════════════════════════════════════════════════════════════════

def hx(c):
    """'#rrggbb' → (r, g, b).  Tuples pass through."""
    if isinstance(c, (tuple, list)):
        return tuple(int(v) for v in c[:3])
    c = c.lstrip("#")
    return (int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16))


def _chan(v):
    v /= 255.0
    return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    """WCAG relative luminance of an sRGB triple."""
    r, g, b = hx(rgb)
    return 0.2126 * _chan(r) + 0.7152 * _chan(g) + 0.0722 * _chan(b)


def contrast(a, b):
    """WCAG contrast ratio between two sRGB colours (>= 1.0)."""
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def _lum_array(arr):
    """WCAG relative luminance for an HxWx3 uint8 array."""
    a = arr.astype(np.float32) / 255.0
    a = np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)
    return 0.2126 * a[..., 0] + 0.7152 * a[..., 1] + 0.0722 * a[..., 2]


def mix(a, b, t):
    a, b = hx(a), hx(b)
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


def shade(c, t):
    """t < 0 darkens toward black, t > 0 lightens toward white."""
    return mix(c, (0, 0, 0) if t < 0 else (255, 255, 255), abs(t))


# ══════════════════════════════════════════════════════════════════════════════
#  Fonts
# ══════════════════════════════════════════════════════════════════════════════

# face key → (file under assets/fonts, default variable axes)
_FACES = {
    "archivo":      ("Archivo-VF.ttf",               {"wght": 600, "wdth": 100}),
    "archivo_black": ("ArchivoBlack-Regular.ttf",    {}),
    "anton":        ("Anton-Regular.ttf",            {}),
    "bebas":        ("BebasNeue-Regular.ttf",        {}),
    "oswald":       ("Oswald-VF.ttf",                {"wght": 500}),
    "shoulders":    ("BigShouldersDisplay-VF.ttf",   {"wght": 700}),
    "grotesk":      ("SpaceGrotesk-VF.ttf",          {"wght": 500}),
    "mono":         ("JetBrainsMono-VF.ttf",         {"wght": 500}),
    "courier":      ("CourierPrime-Regular.ttf",     {}),
    "instrument":   ("InstrumentSerif-Regular.ttf",  {}),
    "instrument_it": ("InstrumentSerif-Italic.ttf",  {}),
    "playfair":     ("PlayfairDisplay-VF.ttf",       {"wght": 700}),
    "dmserif":      ("DMSerifDisplay-Regular.ttf",   {}),
    "fraunces":     ("Fraunces-VF.ttf",              {"wght": 700, "opsz": 144, "SOFT": 0, "WONK": 0}),
    "syne":         ("Syne-VF.ttf",                  {"wght": 700}),
    "blackletter":  ("UnifrakturMaguntia-Book.ttf",  {}),
}

# Broad-coverage system faces, used only when a display face cannot draw the title.
_SYSTEM = [
    "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
]

_AXIS_KEY = {"weight": "wght", "width": "wdth", "optical size": "opsz",
             "softness": "SOFT", "wonky": "WONK"}


def _face_path(face):
    if face == "sys":
        for p in _SYSTEM:
            if Path(p).exists():
                return Path(p)
        return None
    spec = _FACES.get(face)
    if not spec:
        return None
    p = FONT_DIR / spec[0]
    return p if p.exists() else None


@lru_cache(maxsize=1024)
def _load_font(face, size, axes_items):
    path = _face_path(face)
    if path is None:
        for fb in ("grotesk", "sys"):
            path = _face_path(fb)
            if path:
                break
    if path is None:
        try:
            return ImageFont.load_default(size=size)
        except TypeError:
            return ImageFont.load_default()
    f = ImageFont.truetype(str(path), size)
    axes = dict(axes_items)
    if axes:
        try:
            available = f.get_variation_axes()
        except Exception:
            available = []
        if available:
            vals = []
            for ax in available:
                name = ax["name"]
                if isinstance(name, bytes):
                    name = name.decode("utf-8", "ignore")
                key = _AXIS_KEY.get(name.strip().lower(), name.strip())
                v = axes.get(key, ax["default"])
                vals.append(float(min(max(v, ax["minimum"]), ax["maximum"])))
            try:
                f.set_variation_by_axes(vals)
            except Exception:
                pass
    return f


def font(face, size, **axes):
    """Load a vendored face at *size* px with optional variable axes."""
    size = int(round(max(7, size)))
    base = dict(_FACES.get(face, ("", {}))[1])
    base.update({k: v for k, v in axes.items() if v is not None})
    return _load_font(face, size, tuple(sorted(base.items())))


@lru_cache(maxsize=64)
def _coverage(face):
    """Set of codepoints a face can draw (None = unknown → assume fine)."""
    path = _face_path(face)
    if path is None:
        return None
    try:
        from fontTools.ttLib import TTFont
        t = TTFont(str(path), fontNumber=0, lazy=True)
        pts = set()
        for tb in t["cmap"].tables:
            pts.update(tb.cmap.keys())
        t.close()
        return frozenset(pts)
    except Exception:
        return None


def usable_face(face, *texts, chain=("grotesk", "archivo", "sys")):
    """Return *face*, or the first fallback that can draw everything in *texts*."""
    need = {ord(ch) for t in texts for ch in (t or "") if not ch.isspace()}
    if not need:
        return face
    for cand in (face,) + tuple(chain):
        cov = _coverage(cand)
        if cov is None or need <= cov:
            return cand
    best, score = face, -1
    for cand in (face,) + tuple(chain):
        cov = _coverage(cand)
        s = len(need & cov) if cov else 0
        if s > score:
            best, score = cand, s
    return best


def strip_undrawable(text, face):
    """Drop characters no face in the chain can draw (emoji, astral plane)."""
    text = "".join(ch for ch in (text or "") if ch.isprintable() or ch == " ")
    covs = [c for c in (_coverage(face), _coverage("grotesk"), _coverage("sys")) if c]
    if not covs:
        return text.strip()
    out = []
    for ch in text:
        if ch.isspace() or any(ord(ch) in c for c in covs):
            out.append(ch)
    return re.sub(r"\s+", " ", "".join(out)).strip()


# ══════════════════════════════════════════════════════════════════════════════
#  Type setting
# ══════════════════════════════════════════════════════════════════════════════

def text_width(f, s, tracking=0.0):
    """Width of *s* in px including per-character tracking (1/1000 em units)."""
    if not s:
        return 0.0
    w = sum(f.getlength(ch) for ch in s)
    return w + tracking * f.size / 1000.0 * (len(s) - 1)


def draw_tracked(d, xy, s, f, fill, tracking=0.0):
    x, y = xy
    step = tracking * f.size / 1000.0
    for ch in s:
        d.text((x, y), ch, font=f, fill=fill)
        x += f.getlength(ch) + step


class Block:
    """A set typographic block: lines + face + tracking + leading."""

    __slots__ = ("lines", "font", "tracking", "line_h", "width", "align", "face")

    def __init__(self, lines, f, tracking, line_h, align="left", face=""):
        self.lines = lines
        self.font = f
        self.tracking = tracking
        self.line_h = line_h
        self.align = align
        self.face = face
        self.width = max((text_width(f, l, tracking) for l in lines), default=0.0)

    def __bool__(self):
        return bool(self.lines and any(l.strip() for l in self.lines))

    def mask(self):
        """Render to an L image, cropped tight to the ink (optical bounds)."""
        f = self.font
        pad = int(f.size * 0.6) + 6
        w = int(math.ceil(self.width)) + pad * 2
        h = int(math.ceil(self.line_h * (len(self.lines) - 1) + f.size * 2.0)) + pad * 2
        im = Image.new("L", (max(w, 2), max(h, 2)), 0)
        d = ImageDraw.Draw(im)
        for i, ln in enumerate(self.lines):
            lw = text_width(f, ln, self.tracking)
            if self.align == "right":
                x = pad + self.width - lw
            elif self.align == "center":
                x = pad + (self.width - lw) / 2.0
            else:
                x = pad
            draw_tracked(d, (x, pad + i * self.line_h), ln, f, 255, self.tracking)
        bb = im.getbbox()
        return im.crop(bb) if bb else im


def _tokenise(text, f, max_w, tracking, allow_break=True):
    """Words → tokens + separators.  A word wider than the box is hyphen-broken
    only when *allow_break*; otherwise None is returned so the caller can try a
    smaller size first (breaking mid-word is always the last resort)."""
    words = [w for w in re.split(r"\s+", text.strip()) if w]
    toks, seps = [], []
    for w in words:
        if seps or toks:
            seps.append(" ")
        if text_width(f, w, tracking) <= max_w:
            toks.append(w)
            continue
        if not allow_break:
            return None
        cur = ""
        for ch in w:
            if cur and text_width(f, cur + ch + "-", tracking) > max_w:
                toks.append(cur + "-")
                seps.append("")
                cur = ch
            else:
                cur += ch
        toks.append(cur if cur else w[:1])
    return toks, seps


def _join(toks, seps, i, j):
    out = toks[i]
    for t in range(i + 1, j):
        out += seps[t - 1] + toks[t]
    return out


def _partition(toks, seps, f, tracking, k):
    """Split tokens into exactly k contiguous lines minimising the widest line."""
    n = len(toks)
    if k > n:
        return None
    wid = [[0.0] * (n + 1) for _ in range(n)]
    for i in range(n):
        for j in range(i + 1, n + 1):
            wid[i][j] = text_width(f, _join(toks, seps, i, j), tracking)
    INF = float("inf")
    best = [[INF] * (n + 1) for _ in range(k + 1)]
    cut = [[0] * (n + 1) for _ in range(k + 1)]
    best[0][n] = 0.0
    for kk in range(1, k + 1):
        for i in range(n - 1, -1, -1):
            for j in range(i + 1, n + 1):
                if best[kk - 1][j] == INF:
                    continue
                v = max(wid[i][j], best[kk - 1][j])
                if v < best[kk][i]:
                    best[kk][i] = v
                    cut[kk][i] = j
    if best[k][0] == INF:
        return None
    lines, i, kk = [], 0, k
    while kk > 0:
        j = cut[kk][i]
        lines.append(_join(toks, seps, i, j))
        i, kk = j, kk - 1
    return lines, best[k][0]


def set_type(text, face, box_w, box_h, size_hi, size_lo, *, tracking=0.0,
             leading=1.0, max_lines=MAX_LINES, align="left", caps=False, axes=None):
    """Largest size at which *text* wraps into <= max_lines balanced lines
    inside (box_w, box_h).  Falls back to an ellipsised block."""
    axes = axes or {}
    face = usable_face(face, text)
    text = strip_undrawable(text, face)
    if caps:
        text = text.upper()
    if not text.strip():
        return Block([], font(face, int(size_lo), **axes), tracking,
                     size_lo * leading, align, face)
    # Pass 1 keeps words whole; only if nothing fits at the floor size do we
    # allow a hyphen break mid-word (pass 2).
    for allow_break in (False, True):
        size = float(size_hi)
        while size >= size_lo - 0.5:
            f = font(face, size, **axes)
            tk = _tokenise(text, f, box_w, tracking, allow_break)
            if tk is None:
                size *= 0.955
                continue
            toks, seps = tk
            for k in range(1, min(max_lines, len(toks)) + 1):
                p = _partition(toks, seps, f, tracking, k)
                if not p:
                    continue
                lines, widest = p
                if widest > box_w:
                    continue
                lh = f.size * leading
                height = lh * (k - 1) + f.size * 1.02
                if height <= box_h:
                    return Block(lines, f, tracking, lh, align, face)
            size *= 0.955
    # Nothing fits: set at the floor size, fill max_lines, ellipsise the last.
    f = font(face, int(size_lo), **axes)
    toks, seps = _tokenise(text, f, box_w, tracking, True)
    lines, cur = [], ""
    for i, t in enumerate(toks):
        trial = (cur + (seps[i - 1] if i and cur else "") + t) if cur else t
        if text_width(f, trial, tracking) <= box_w:
            cur = trial
        else:
            lines.append(cur)
            cur = t
        if len(lines) >= max_lines:
            break
    if len(lines) < max_lines and cur:
        lines.append(cur)
    lines = lines[:max_lines]
    if lines:
        last = lines[-1]
        while last and text_width(f, last + "…", tracking) > box_w:
            last = last[:-1]
        lines[-1] = (last + "…") if last else "…"
    return Block(lines, f, tracking, f.size * leading, align, face)


def _join_words(words, i, j):
    out = words[i]
    for t in range(i + 1, j):
        out += ("" if out.endswith("-") else " ") + words[t]
    return out


def fill_lines(text, k):
    """Split *text* into exactly k lines balanced by character count.

    Used by the directions that scale every line to the same measure (each line
    ends up the same width, so characters-per-line — not pixels — is what makes
    the lines look even).  Words are only broken when there are not enough of
    them, and a broken piece keeps its hyphen.
    """
    words = [w for w in re.split(r"\s+", text.strip()) if w] or [""]
    while len(words) < k:
        i = max(range(len(words)), key=lambda j: len(words[j]))
        w = words[i]
        if len(w) < 14:      # never hyphenate a word that already fits a line
            break
        half = (len(w) + 1) // 2
        words[i:i + 1] = [w[:half] + "-", w[half:]]
    n = len(words)
    k = min(k, n)
    if k <= 1:
        return [_join_words(words, 0, n)]
    lens = [len(w) for w in words]
    INF = float("inf")
    best = [[INF] * (n + 1) for _ in range(k + 1)]
    cut = [[0] * (n + 1) for _ in range(k + 1)]
    best[0][n] = 0
    for kk in range(1, k + 1):
        for i in range(n - 1, -1, -1):
            for j in range(i + 1, n + 1):
                if best[kk - 1][j] == INF:
                    continue
                tot = sum(lens[i:j]) + (j - i - 1)
                v = max(tot, best[kk - 1][j])
                if v < best[kk][i]:
                    best[kk][i] = v
                    cut[kk][i] = j
    if best[k][0] == INF:
        return [_join_words(words, 0, n)]
    lines, i, kk = [], 0, k
    while kk > 0:
        j = cut[kk][i]
        lines.append(_join_words(words, i, j))
        i, kk = j, kk - 1
    return lines


def justified_stack(text, face, target_w, *, max_lines=MAX_LINES, max_stack=640.0,
                    gap=0.0, tracking=0.0, hi=420, lo=14, axes=None):
    """Poster lock-up: each line scaled to exactly *target_w*, using as many
    lines as fit in *max_stack* px (more lines = bigger type).  Returns
    [L-mask, …] ready to paste."""
    best = None
    for k in range(1, max_lines + 1):
        lines = fill_lines(text, k)
        if len(lines) != k:
            continue
        masks = [scale_to_width(ln, face, target_w, tracking=tracking,
                                hi=hi, lo=lo, axes=axes).mask() for ln in lines]
        stack = sum(m.size[1] for m in masks) + gap * (k - 1)
        if stack <= max_stack or best is None:
            best = masks
        if stack > max_stack:
            break
    return best or []


def scale_to_width(text, face, target_w, *, tracking=0.0, hi=420, lo=14, axes=None):
    """Binary-search the size at which *text* measures exactly target_w."""
    axes = axes or {}
    face = usable_face(face, text)
    lo_f, hi_f = float(lo), float(hi)
    for _ in range(26):
        mid = (lo_f + hi_f) / 2.0
        w = text_width(font(face, mid, **axes), text, tracking)
        if w > target_w:
            hi_f = mid
        else:
            lo_f = mid
    f = font(face, lo_f, **axes)
    return Block([text], f, tracking, f.size, "left", face)


# ══════════════════════════════════════════════════════════════════════════════
#  Texture
# ══════════════════════════════════════════════════════════════════════════════

def _noise(rng, size, cells, smooth=True):
    """Value noise in [0,1] as a float32 HxW array."""
    c = max(2, int(cells))
    small = rng.random((c, c)).astype(np.float32)
    im = Image.fromarray((small * 255).astype(np.uint8), "L")
    im = im.resize((size, size), Image.BICUBIC if smooth else Image.NEAREST)
    return np.asarray(im).astype(np.float32) / 255.0


def paper_ground(size, rgb, rng, *, fibre=0.55, grain=6.0, blotch=0.06):
    """A sheet of paper: base colour, low-frequency blotching, fibre, grain."""
    base = np.zeros((size, size, 3), np.float32) + np.array(hx(rgb), np.float32)
    if blotch:
        n = _noise(rng, size, max(3, size // 120))
        base *= (1.0 + (n - 0.5) * 2.0 * blotch)[..., None]
    if fibre:
        f = rng.normal(0.0, 1.0, (size, size)).astype(np.float32)
        f = np.asarray(Image.fromarray(((f * 0.5 + 0.5) * 255).clip(0, 255).astype(np.uint8), "L")
                       .filter(ImageFilter.GaussianBlur(0.4))).astype(np.float32) / 255.0
        streak = _noise(rng, size, max(4, size // 24), smooth=False)
        base += ((f - 0.5) * 9.0 * fibre + (streak - 0.5) * 3.0 * fibre)[..., None]
    if grain:
        base += rng.normal(0.0, grain, (size, size))[..., None]
    return Image.fromarray(base.clip(0, 255).astype(np.uint8), "RGB")


def add_grain(img, rng, amount=5.0, colour=0.0):
    a = np.asarray(img).astype(np.float32)
    n = rng.normal(0.0, amount, a.shape[:2])[..., None]
    if colour:
        n = n + rng.normal(0.0, amount * colour, a.shape)
    return Image.fromarray((a + n).clip(0, 255).astype(np.uint8), "RGB")


def halftone(mask_L, cell, angle_deg, rng=None):
    """Screen an L coverage mask into a dot pattern.  Returns an L mask."""
    a = np.asarray(mask_L).astype(np.float32) / 255.0
    h, w = a.shape
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    th = math.radians(angle_deg)
    u = (xx * math.cos(th) + yy * math.sin(th)) / max(1.5, cell)
    v = (-xx * math.sin(th) + yy * math.cos(th)) / max(1.5, cell)
    screen = (np.cos(2 * math.pi * u) + np.cos(2 * math.pi * v)) * 0.25 + 0.5
    ink = np.clip((a - screen) * max(4.0, cell * 0.9) + 0.5, 0.0, 1.0)
    return Image.fromarray((ink * 255).astype(np.uint8), "L")


def scanlines(img, period, alpha, rgb=(0, 0, 0)):
    size = img.size[0]
    lay = Image.new("RGBA", img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(lay)
    y = 0.0
    while y < img.size[1]:
        d.rectangle((0, y, size, y + max(1.0, period * 0.45)), fill=hx(rgb) + (int(alpha),))
        y += period
    return Image.alpha_composite(img.convert("RGBA"), lay).convert("RGB")


def distress(img, rng, amount=1.0, ink=(0, 0, 0)):
    """Press distress: blotchy ink loss, dust, hairline scratches."""
    size = img.size[0]
    a = np.asarray(img).astype(np.float32)
    n = _noise(rng, size, max(6, size // 40))
    n2 = _noise(rng, size, max(20, size // 8))
    loss = np.clip((n * 0.65 + n2 * 0.35 - 0.42) * 3.2, 0.0, 1.0) * 0.22 * amount
    a *= (1.0 - loss)[..., None]
    a += (np.clip((0.5 - n2) * 2.4, 0, 1) * 10.0 * amount)[..., None]
    img = Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGB")
    d = ImageDraw.Draw(img)
    r = random.Random(int(n.sum() * 1000) & 0xFFFFFFF)
    for _ in range(int(26 * amount)):
        x, y = r.random() * size, r.random() * size
        ln = size * (0.02 + r.random() * 0.16)
        ang = r.random() * math.pi
        d.line((x, y, x + math.cos(ang) * ln, y + math.sin(ang) * ln),
               fill=hx(ink), width=1)
    return img


def vignette(img, strength=0.5, power=1.6):
    size = img.size[0]
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32)
    r = np.sqrt(((xx / size - 0.5) ** 2 + (yy / size - 0.5) ** 2) * 2.0)
    m = 1.0 - strength * np.clip(r, 0, 1) ** power
    a = np.asarray(img).astype(np.float32) * m[..., None]
    return Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGB")


def duotone(img, dark, light):
    """Map an image's luminance onto a two-colour ramp."""
    g = np.asarray(img.convert("L")).astype(np.float32) / 255.0
    d, l = np.array(hx(dark), np.float32), np.array(hx(light), np.float32)
    out = d[None, None, :] + (l - d)[None, None, :] * g[..., None]
    return Image.fromarray(out.clip(0, 255).astype(np.uint8), "RGB")


def tonal_field(size, rng, *, blobs=4, contrast_boost=1.5, light=True):
    """A soft abstract tonal plate — the stand-in for a photograph.  A single
    directional light keeps it reading as a lit subject rather than as noise."""
    yy, xx = np.mgrid[0:size, 0:size].astype(np.float32) / size
    f = np.zeros((size, size), np.float32) + 0.42
    for _ in range(blobs):
        cx, cy = rng.random(), rng.random()
        r = 0.16 + rng.random() * 0.3
        amp = (rng.random() - 0.35) * 0.9
        f += amp * np.exp(-(((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * r * r)))
    if light:
        ang = rng.random() * 2 * math.pi
        f += (math.cos(ang) * (xx - 0.5) + math.sin(ang) * (yy - 0.5)) * 0.55
    f += (_noise(rng, size, max(4, size // 90)) - 0.5) * 0.22
    f = (f - f.min()) / max(1e-6, f.max() - f.min())
    f = np.clip((f - 0.5) * contrast_boost + 0.5, 0, 1)
    return Image.fromarray((f * 255).astype(np.uint8), "L")


# ══════════════════════════════════════════════════════════════════════════════
#  Tag reading
# ══════════════════════════════════════════════════════════════════════════════

_DARK = ("dark", "sad", "melanchol", "haunting", "metal", "desperate", "lonely",
         "doom", "gothic", "grief", "sorrow", "brooding", "sinister", "eerie",
         "noir", "cold", "bleak", "grim", "heavy", "industrial", "dirge")
_BRIGHT = ("happy", "upbeat", "energetic", "euphoric", "playful", "summer",
           "party", "bright", "sunny", "joy", "dance", "cheerful", "pop",
           "feel-good", "anthemic", "celebration")
_CALM = ("ambient", "calm", "peaceful", "smooth", "mellow", "dreamy", "chill",
         "soft", "gentle", "lo-fi", "lofi", "meditative", "drone", "sleep",
         "minimal", "spacious", "serene")

# direction id → keywords that pull toward it
_PULL = {
    "metal":      ("metal", "doom", "death", "black metal", "thrash", "sludge",
                   "hardcore", "screaming", "brutal", "heavy", "gothic", "horror",
                   "nu-metal", "riff", "growl", "occult"),
    "bluenote":   ("jazz", "blues", "soul", "swing", "bebop", "saxophone", "trumpet",
                   "double bass", "rhodes", "organ", "lounge", "motown", "funk",
                   "smoky", "noir", "bossa"),
    "techno":     ("techno", "idm", "glitch", "minimal techno", "acid", "electro",
                   "industrial", "dub techno", "breakbeat", "drum and bass",
                   "experimental", "modular", "machine", "robotic", "clinical"),
    "synthwave":  ("synthwave", "retrowave", "outrun", "80s", "eighties", "synth",
                   "synthpop", "vaporwave", "neon", "arcade", "cyber", "chiptune",
                   "night drive", "sci-fi"),
    "ambient":    ("ambient", "drone", "meditative", "new age", "sleep", "field recording",
                   "minimal", "spacious", "peaceful", "calm", "serene", "piano solo",
                   "cinematic", "score", "atmospheric"),
    "pop":        ("pop", "k-pop", "j-pop", "hyperpop", "bubblegum", "dance-pop",
                   "electropop", "girl group", "boy band", "catchy", "playful",
                   "upbeat", "euphoric", "teen", "summer"),
    "folk":       ("folk", "acoustic", "country", "bluegrass", "celtic", "sea shanty",
                   "americana", "singer-songwriter", "gospel", "ukulele", "banjo",
                   "mandolin", "fiddle", "hymn", "traditional", "campfire", "waltz"),
    "hiphop":     ("hip-hop", "hip hop", "rap", "trap", "boom bap", "grime", "drill",
                   "turntable", "mc", "r&b", "rnb", "crunk", "g-funk"),
    "brutalist":  ("punk", "post-punk", "noise rock", "hardcore punk", "garage",
                   "grunge", "alternative", "rock", "protest", "riot", "raw",
                   "distorted", "angular", "stadium"),
    "riso":       ("indie", "indie pop", "indie rock", "bedroom", "dream pop",
                   "shoegaze", "twee", "art pop", "quirky", "jangle", "surf"),
    "swiss":      ("classical", "orchestral", "modern classical", "chamber",
                   "electronic", "house", "deep house", "downtempo", "trip-hop",
                   "sophisticated", "elegant", "clean", "corporate"),
    "bauhaus":    ("krautrock", "avant-garde", "post-rock", "math rock", "prog",
                   "progressive", "art rock", "motorik", "geometric", "kosmische"),
    "xerox":      ("lo-fi", "lofi", "demo", "garage rock", "zine", "underground",
                   "bootleg", "tape", "cassette", "diy", "sludge punk", "emo"),
}


def read_tags(tags, title=""):
    t = (tags or "").lower()
    words = [w.strip() for w in re.split(r"[,\n;/|]+", t) if w.strip()]
    mood = "neutral"
    if any(k in t for k in _DARK):
        mood = "dark"
    elif any(k in t for k in _CALM):
        mood = "calm"
    elif any(k in t for k in _BRIGHT):
        mood = "bright"
    genre = words[0] if words else ""
    return {"raw": t, "words": words, "mood": mood, "genre": genre, "title": title}


def choose_direction(seed, tags):
    """Deterministic weighted pick, steered by the tags."""
    info = read_tags(tags)
    t = info["raw"]
    scores = {}
    for d in DIRECTIONS:
        s = 1.0
        for kw in _PULL.get(d, ()):
            if kw in t:
                s += 6.0 if len(kw) > 4 else 3.5
        scores[d] = s
    if info["mood"] == "calm":
        scores["ambient"] += 3.0
        scores["swiss"] += 1.5
    if info["mood"] == "dark":
        scores["metal"] += 2.0
        scores["techno"] += 1.5
        scores["xerox"] += 1.0
    if info["mood"] == "bright":
        scores["pop"] += 2.5
        scores["riso"] += 1.5
    rng = random.Random(seed ^ 0x5EED)
    total = sum(scores.values())
    r = rng.random() * total
    for d, s in scores.items():
        r -= s
        if r <= 0:
            return d
    return "swiss"


# ══════════════════════════════════════════════════════════════════════════════
#  Palettes  (hand-picked; at most three hues per sleeve)
# ══════════════════════════════════════════════════════════════════════════════

def _p(paper, ink, accent, accent2=None, mood="any"):
    return {"paper": paper, "ink": ink, "accent": accent,
            "accent2": accent2 or accent, "mood": mood}


PALETTES = {
    "swiss": [
        _p("#F2F0EA", "#141414", "#E4002B", mood="bright"),
        _p("#EDEDEB", "#101010", "#1B4DFF", mood="any"),
        _p("#F4F1E6", "#1A1A18", "#0F7B5F", mood="calm"),
        _p("#121212", "#F2F0EA", "#FFD400", mood="dark"),
        _p("#E9E4DA", "#191713", "#D94E1F", mood="any"),
    ],
    "brutalist": [
        _p("#0C0C0C", "#F4F4F4", "#FF3B00", mood="dark"),
        _p("#0A0A0A", "#EDEDED", "#C8FF00", mood="any"),
        _p("#101014", "#F2F2F4", "#00E0FF", mood="any"),
        _p("#F2F2F2", "#0B0B0B", "#FF2E4D", mood="bright"),
        _p("#0B0D0B", "#E8E8E2", "#FF9F1C", mood="any"),
    ],
    "riso": [
        _p("#F2EADA", "#1A1A1A", "#FF48B0", "#0078BF", mood="bright"),
        _p("#EFE9D6", "#1A1A1A", "#0078BF", "#FFB700", mood="any"),
        _p("#F1ECE0", "#17181A", "#00A95C", "#FF6C2F", mood="calm"),
        _p("#EDE6D4", "#141414", "#FF6C2F", "#3D3AB5", mood="any"),
        _p("#E8E3D3", "#131313", "#3D3AB5", "#FF48B0", mood="dark"),
    ],
    "bluenote": [
        _p("#E8E0CC", "#131313", "#1F6FB2", mood="any"),
        _p("#E6DCC4", "#141210", "#C7451B", mood="any"),
        _p("#DED8C8", "#101010", "#0E7C6B", mood="calm"),
        _p("#E9DFC6", "#15120E", "#D39B12", mood="bright"),
        _p("#1A1815", "#EDE4CE", "#C7451B", mood="dark"),
    ],
    "metal": [
        _p("#07070A", "#D9D5CC", "#8E1B1B", mood="dark"),
        _p("#08090B", "#C9CBC6", "#3F5E4A", mood="dark"),
        _p("#0A0808", "#D6CBB5", "#6B4A1F", mood="any"),
        _p("#060608", "#C6C9D2", "#2C3E63", mood="any"),
        _p("#0A0A0A", "#E2DED4", "#5A5A5A", mood="any"),
    ],
    "synthwave": [
        _p("#120A2E", "#F3EEFF", "#FF2E88", mood="any"),
        _p("#0A1226", "#EAF6FF", "#00E5C0", mood="calm"),
        _p("#1A0B1E", "#FFF1E8", "#FF7A18", mood="bright"),
        _p("#070B1C", "#E9EEFF", "#6C5CE7", mood="dark"),
    ],
    "ambient": [
        _p("#E8E4DB", "#33342F", "#B9B3A4", mood="calm"),
        _p("#DFE2E1", "#24292B", "#A9B4B2", mood="calm"),
        _p("#22262A", "#DDE2E4", "#3C444A", mood="dark"),
        _p("#EDE7DE", "#3A3128", "#C9B79E", mood="any"),
        _p("#E3E6EA", "#242A33", "#AFBACA", mood="any"),
    ],
    "pop": [
        _p("#FFE44D", "#111111", "#FF3E6C", "#1B3BFF", mood="bright"),
        _p("#FF5C8A", "#141414", "#FFE44D", "#00C2A8", mood="bright"),
        _p("#00C2A8", "#0E1614", "#FFE44D", "#FF3E6C", mood="any"),
        _p("#1B3BFF", "#F6F4FF", "#FF9E2C", "#FFFFFF", mood="any"),
        _p("#F4F1EA", "#151515", "#FF3E6C", "#1B3BFF", mood="calm"),
    ],
    "techno": [
        _p("#0B0C0E", "#DCE0E4", "#C8FF00", mood="dark"),
        _p("#0A0A0A", "#D7D7D7", "#FF3C00", mood="any"),
        _p("#0C1013", "#D2E4E8", "#00FFD1", mood="any"),
        _p("#E7E7E4", "#101112", "#FF3C00", mood="bright"),
        _p("#101014", "#D6D6E0", "#7A5CFF", mood="calm"),
    ],
    "folk": [
        _p("#EFE6D2", "#2B241B", "#7A2418", mood="any"),
        _p("#EDE7D6", "#22281F", "#2F5138", mood="calm"),
        _p("#F0E8D6", "#241F1A", "#1F3A5F", mood="any"),
        _p("#E8DFC8", "#2A2118", "#8A5A18", mood="bright"),
        _p("#1E1B16", "#EDE4CE", "#8A5A18", mood="dark"),
    ],
    "bauhaus": [
        _p("#F0EDE4", "#121212", "#D62828", "#1D3FBF", mood="any"),
        _p("#EFE9DC", "#141414", "#F2B705", "#1D3FBF", mood="bright"),
        _p("#1D3FBF", "#F3F1EA", "#F2B705", "#121212", mood="any"),
        _p("#D62828", "#F5F2EA", "#121212", "#F2B705", mood="bright"),
        _p("#161616", "#EFEDE5", "#F2B705", "#D62828", mood="dark"),
    ],
    "xerox": [
        _p("#DFDDD6", "#0A0A0A", "#0A0A0A", mood="any"),
        _p("#E2E0D8", "#0A0A0A", "#FF2D55", mood="bright"),
        _p("#D9D9D4", "#0B0B0B", "#1B4DFF", mood="any"),
        _p("#1A1A1A", "#E4E2DA", "#E4E2DA", mood="dark"),
        _p("#DCDAD2", "#0A0A0A", "#C8FF00", mood="any"),
    ],
}


def choose_palette(direction, seed, tags):
    pals = PALETTES.get(direction) or PALETTES["swiss"]
    mood = read_tags(tags)["mood"]
    pref = [p for p in pals if p["mood"] == mood]
    pool = pref if len(pref) >= 2 else pals
    return dict(pool[random.Random(seed ^ 0xC01A).randrange(len(pool))])


# ══════════════════════════════════════════════════════════════════════════════
#  Canvas
# ══════════════════════════════════════════════════════════════════════════════

class Cover:
    def __init__(self, size, seed, title, artist, tags, direction, pal, ai=None):
        self.S = size
        self.u = size / 1000.0
        self.seed = seed
        self.rng = random.Random(seed)
        self.nrng = np.random.default_rng(seed & 0x7FFFFFFF)
        self.title = title
        self.artist = artist
        self.tags = tags
        self.info = read_tags(tags, title)
        self.direction = direction
        self.pal = pal
        self.ai = ai
        self.paper = hx(pal["paper"])
        self.ink = hx(pal["ink"])
        self.accent = hx(pal["accent"])
        self.accent2 = hx(pal["accent2"])
        self.img = Image.new("RGB", (size, size), self.paper)
        self.d = ImageDraw.Draw(self.img)
        self.catalogue = "WP-%03d" % (seed % 900 + 100)
        # every piece of type that lands on the sleeve records the contrast
        # ratio it actually achieved: (label, ratio).  tests/test_cover.py
        # asserts the whole list clears MIN_CONTRAST.
        self.audit: list = []

    # ---- geometry -----------------------------------------------------------
    def p(self, v):
        return v * self.u

    def r(self, x0, y0, x1, y1):
        return (x0 * self.u, y0 * self.u, x1 * self.u, y1 * self.u)

    def rect(self, x0, y0, x1, y1, fill=None, outline=None, width=2):
        self.d.rectangle(self.r(x0, y0, x1, y1), fill=fill, outline=outline,
                         width=max(1, int(round(width * self.u))))

    def ellipse(self, x0, y0, x1, y1, fill=None, outline=None, width=2):
        self.d.ellipse(self.r(x0, y0, x1, y1), fill=fill, outline=outline,
                       width=max(1, int(round(width * self.u))))

    def line(self, x0, y0, x1, y1, fill, width=2):
        self.d.line(self.r(x0, y0, x1, y1), fill=fill,
                    width=max(1, int(round(width * self.u))))

    def ground(self, rgb=None, **kw):
        self.img = paper_ground(self.S, rgb or self.paper, self.nrng, **kw)
        self.d = ImageDraw.Draw(self.img)

    def flat(self, rgb):
        self.img = Image.new("RGB", (self.S, self.S), hx(rgb))
        self.d = ImageDraw.Draw(self.img)

    def apply(self, img):
        self.img = img.convert("RGB")
        self.d = ImageDraw.Draw(self.img)

    # ---- AI art layer -------------------------------------------------------
    def paint_ai(self, treat="duotone"):
        """Paint the optional AI background full bleed, treated to match the
        direction.  Returns True when it painted (the direction then skips its
        own generated field but keeps its shapes and typography)."""
        if self.ai is None:
            return False
        im = self.ai.convert("RGB")
        w, h = im.size
        s = max(self.S / w, self.S / h)
        im = im.resize((max(1, int(w * s)), max(1, int(h * s))), Image.LANCZOS)
        left = (im.width - self.S) // 2
        top = (im.height - self.S) // 2
        im = im.crop((left, top, left + self.S, top + self.S))
        if treat == "duotone":
            im = duotone(im, shade(self.ink, -0.15), self.paper)
        elif treat == "duotone_accent":
            im = duotone(im, shade(self.accent, -0.55), self.paper)
        elif treat == "posterize":
            im = ImageOps_posterize(im, 3)
        elif treat == "halftone":
            g = im.convert("L")
            dots = halftone(Image.eval(g, lambda v: 255 - v), self.p(8), 15)
            im = Image.new("RGB", im.size, self.paper)
            im.paste(self.ink, (0, 0), dots)
        elif treat == "dither":
            im = duotone(im, self.ink, self.paper).convert("L").convert("1").convert("RGB")
            im = duotone(im, self.ink, self.paper)
        self.apply(im)
        return True

    # ---- typography ---------------------------------------------------------
    def _anchor_xy(self, mask, x, y, anchor):
        w, h = mask.size
        px, py = x * self.u, y * self.u
        if anchor[0] == "c":
            px -= w / 2.0
        elif anchor[0] == "r":
            px -= w
        if anchor[1] == "m":
            py -= h / 2.0
        elif anchor[1] == "b":
            py -= h
        return int(round(px)), int(round(py))

    def soft_ink(self, t=0.35, on=None, target=4.6):
        """The dimmest tint of the ink that still clears the contrast rule."""
        on = on or self.paper
        for tt in (t, t * 0.75, t * 0.5, t * 0.25, 0.0):
            col = mix(self.ink, on, tt)
            if contrast(col, on) >= target:
                return col
        return self.ink

    def pick_fill(self, block, x, y, anchor, candidates, *, rotate=0.0,
                  min_contrast=MIN_CONTRAST):
        """First candidate colour that clears the contrast rule where the block
        will land, or None (the caller then falls back to a plate)."""
        m = block.mask()
        if rotate:
            m = m.rotate(rotate, expand=True, resample=Image.BICUBIC)
        px, py = self._anchor_xy(m, x, y, anchor)
        for cand in candidates:
            if self._contrast_at(m, px, py, cand) >= min_contrast:
                return cand
        return None

    def place(self, block, x, y, fill, anchor="lt", *, rotate=0.0,
              plate=None, plate_pad=(0.35, 0.22), min_contrast=MIN_CONTRAST,
              plate_colour=None, align=None):
        """Paste a typographic block with measured contrast.

        anchor: two chars, horizontal l/c/r then vertical t/m/b, in u-space.
        plate:  None = only if contrast fails, "box"/"band" = always,
                False = never (the direction guarantees contrast itself).
        Returns the pasted (x0, y0, x1, y1) box in u-space.
        """
        if not block:
            return (x, y, x, y)
        if align:
            block.align = align
        m = block.mask()
        if rotate:
            m = m.rotate(rotate, expand=True, resample=Image.BICUBIC)
        w, h = m.size
        px, py = self._anchor_xy(m, x, y, anchor)

        if plate is not False:
            need = plate in ("box", "band")
            if not need:
                need = self._contrast_at(m, px, py, fill) < min_contrast
            if need:
                pc = plate_colour or self._plate_colour(fill, min_contrast)
                padx = int(block.font.size * plate_pad[0]) + 2
                pady = int(block.font.size * plate_pad[1]) + 2
                if plate == "band":
                    box = (0, py - pady, self.S, py + h + pady)
                else:
                    box = (px - padx, py - pady, px + w + padx, py + h + pady)
                self.d.rectangle(box, fill=pc)
        self.audit.append(("|".join(block.lines)[:40], self._contrast_at(m, px, py, fill)))
        self.img.paste(fill, (px, py), m)
        self.d = ImageDraw.Draw(self.img)
        return (px / self.u, py / self.u, (px + w) / self.u, (py + h) / self.u)

    def stamp(self, mask, px, py, fill, label="stamp"):
        """Paste a pre-rendered glyph mask (knockouts, justified bars, offset
        prints) and record the contrast it achieved, exactly like place()."""
        self.audit.append((label, self._contrast_at(mask, int(px), int(py), fill)))
        self.img.paste(hx(fill), (int(px), int(py)), mask)
        self.d = ImageDraw.Draw(self.img)

    def _contrast_at(self, mask, px, py, fill):
        """WCAG ratio of *fill* against the pixels actually under the glyphs.

        The per-pixel ratio is computed for every covered pixel and the 2nd
        percentile is returned, i.e. the honest worst case with a small
        allowance for glyph-edge antialiasing.
        """
        w, h = mask.size
        x0, y0 = max(0, px), max(0, py)
        x1, y1 = min(self.S, px + w), min(self.S, py + h)
        if x1 <= x0 or y1 <= y0:
            return 21.0
        region = np.asarray(self.img.crop((x0, y0, x1, y1)).convert("RGB"))
        mcrop = np.asarray(mask.crop((x0 - px, y0 - py, x1 - px, y1 - py)))
        sel = mcrop >= 150
        if not sel.any():
            return 21.0
        lum = _lum_array(region)[sel]
        lf = luminance(fill)
        hi = np.maximum(lum, lf) + 0.05
        lo = np.minimum(lum, lf) + 0.05
        return float(np.percentile(hi / lo, 2.0))

    def _plate_colour(self, fill, min_contrast):
        cands = [self.paper, self.ink, (0, 0, 0), (255, 255, 255),
                 shade(self.ink, -0.3), shade(self.paper, 0.35), self.accent]
        best, ratio = None, 0.0
        for c in cands:
            cr = contrast(fill, c)
            if cr >= min_contrast:
                return c
            if cr > ratio:
                best, ratio = c, cr
        return best or (0, 0, 0)

    # ---- house marks --------------------------------------------------------
    def wordmark(self, x, y, fill, anchor="lt", *, size=21, face="mono",
                 tracking=190, rule=False, catalogue=False, plate=None):
        txt = "WAIVEPULSE"
        b = Block([txt], font(face, self.p(size), wght=600), tracking,
                  self.p(size) * 1.2, "left", face)
        # a label mark should never need a plate: darken/lighten it until it reads
        fill = self.pick_fill(b, x, y, anchor, [fill, self.ink, self.paper]) or fill
        box = self.place(b, x, y, fill, anchor, plate=plate)
        if catalogue:
            c = Block([self.catalogue], font("mono", self.p(size * 0.92), wght=400),
                      120, self.p(size), "left", "mono")
            if anchor[0] == "r":
                self.place(c, box[0] - 22, y, fill, "r" + anchor[1], plate=plate)
            else:
                self.place(c, box[2] + 22, y, fill, "l" + anchor[1], plate=plate)
        if rule:
            self.line(box[0], box[3] + 10, box[2], box[3] + 10, fill, 2)
        return box


def ImageOps_posterize(im, bits):
    from PIL import ImageOps
    return ImageOps.posterize(im, bits)


# ══════════════════════════════════════════════════════════════════════════════
#  Art directions
# ══════════════════════════════════════════════════════════════════════════════

def _kicker(c, limit=2):
    """A short tag line used as a kicker / credit."""
    ws = [w for w in c.info["words"] if 2 < len(w) < 18][:limit]
    return " · ".join(ws).upper() if ws else ""


def _tag_column(c, n=4):
    return [w.upper() for w in c.info["words"][:n]]


# ── 1. Swiss / International ──────────────────────────────────────────────────
def d_swiss(c):
    c.paint_ai("duotone") or c.ground(grain=3.0, fibre=0.25, blotch=0.03)
    m, R = 84, c.rng
    variant = R.randrange(4)
    box_r, col_x, col_ink = 916, 916, c.ink
    # One accent shape, parked in its own grid cell so the type never fights it.
    if variant == 0:
        c.ellipse(646, 580, 916, 850, fill=c.accent)
    elif variant == 1:
        c.rect(700, 138, 916, 898, fill=c.accent)
        box_r = 656
        col_x = 900
        col_ink = c.paper if contrast(c.paper, c.accent) >= 4.5 else c.ink
    elif variant == 2:
        c.rect(616, 596, 916, 896, fill=c.accent)
    else:
        c.d.pieslice(c.r(556, 500, 1076, 1020), 180, 270, fill=c.accent)
    c.line(m, 138, 916, 138, c.ink, 2.5)
    c.line(m, 898, 916, 898, c.ink, 2.5)

    tw = box_r - m
    # the shape occupies the lower right, so the title lives in the upper band
    box_h = 470 if variant == 1 else 372
    title = set_type(c.title, "archivo", c.p(tw), c.p(box_h), c.p(168), c.p(48),
                     tracking=-24, leading=0.88,
                     axes={"wght": 800, "wdth": 92})
    tb = c.place(title, m, 200, c.ink, "lt")

    if c.artist:
        a = set_type(c.artist, "grotesk", c.p(tw), c.p(90), c.p(30), c.p(18),
                     tracking=170, leading=1.3, max_lines=2, caps=True,
                     axes={"wght": 500})
        c.place(a, m, tb[3] + 30, c.ink, "lt")

    col = _tag_column(c, 4)
    # the metadata column only exists when the title leaves room for it
    if col and tb[2] < (col_x - 190):
        b = Block(col, font("mono", c.p(19), wght=400), 90, c.p(30), "right", "mono")
        c.place(b, col_x, 196 if variant != 1 else 170, col_ink, "rt", plate=False)
    elif col:
        b = Block([" · ".join(col)[:64]], font("mono", c.p(17), wght=400), 90,
                  c.p(26), "right", "mono")
        c.place(b, 916, 940, c.ink, "rb", plate=False)

    c.wordmark(m, 126, c.ink, "lb", size=19, catalogue=True)
    c.apply(add_grain(c.img, c.nrng, 2.5))


# ── 2. Brutalist ──────────────────────────────────────────────────────────────
def d_brutalist(c):
    c.paint_ai("dither") or c.flat(c.paper)
    R, m = c.rng, 58
    tw = 1000 - 2 * m
    txt = strip_undrawable(c.title, "oswald").upper() or "UNTITLED"
    face = R.choice(["oswald", "shoulders", "anton"])
    axes = {"wght": 700} if face in ("oswald", "shoulders") else {}
    gap = c.p(10)
    masks = justified_stack(txt, face, c.p(tw), max_lines=MAX_LINES,
                            max_stack=c.p(620), gap=gap, tracking=-12,
                            hi=c.p(360), lo=c.p(20), axes=axes)
    total = sum(mk.size[1] for mk in masks) + gap * (len(masks) - 1)
    total = min(total, c.p(700))
    y = c.p(500) - total / 2.0

    bar_i = R.randrange(len(masks)) if R.random() < 0.7 else -1
    c.rect(m, (y / c.u) - 44, 1000 - m, (y / c.u) - 30, fill=c.ink)
    for i, mk in enumerate(masks):
        x = int(c.p(m))
        yi = int(round(y))
        if i == bar_i:
            c.d.rectangle((0, yi - c.p(14), c.S, yi + mk.size[1] + c.p(14)), fill=c.accent)
            fill = c.paper if contrast(c.paper, c.accent) >= 4.5 else (
                c.ink if contrast(c.ink, c.accent) >= 4.5 else (0, 0, 0))
        else:
            fill = c.ink
        c.stamp(mk, x, yi, fill, "title-line")
        y += mk.size[1] + gap
    c.rect(m, (y / c.u) + 18, 1000 - m, (y / c.u) + 32, fill=c.ink)

    if c.artist:
        a = Block([strip_undrawable(c.artist, "mono").upper()[:48]],
                  font("mono", c.p(24), wght=600), 220, c.p(30), "left", "mono")
        c.place(a, m, 942, c.accent if contrast(c.accent, c.paper) >= 4.5 else c.ink, "lb")
    c.wordmark(1000 - m, 942, c.ink, "rb", size=20, catalogue=True)
    kick = _kicker(c, 3)
    if kick:
        b = Block([kick[:52]], font("mono", c.p(19), wght=400), 180, c.p(24), "left", "mono")
        c.place(b, m, 78, c.ink, "lt")
    c.apply(scanlines(c.img, c.p(4), 16, c.ink if luminance(c.paper) > .5 else (255, 255, 255)))


# ── 3. Risograph ──────────────────────────────────────────────────────────────
def d_riso(c):
    R = c.rng
    if not c.paint_ai("halftone"):
        c.ground(fibre=1.0, grain=5.0, blotch=0.09)
    ink1, ink2 = c.accent, c.accent2
    if contrast(ink2, c.paper) < contrast(ink1, c.paper):
        ink1, ink2 = ink2, ink1          # ink2 = the darker one, used for type
    type_ink = ink2 if contrast(ink2, c.paper) >= 4.5 else c.ink
    S = c.S

    def layer(draw_fn, ink, cell, angle, off):
        mk = Image.new("L", (S, S), 0)
        draw_fn(ImageDraw.Draw(mk))
        if cell:
            mk = halftone(mk, cell, angle)
        mk = ImageChops.offset(mk, int(off[0]), int(off[1]))
        plate = Image.new("RGB", (S, S), hx(ink))
        # riso ink is transparent: multiply the plate over the sheet
        blended = ImageChops.multiply(c.img, plate)
        base = c.img.copy()
        base.paste(blended, (0, 0), mk)
        c.apply(base)

    shape = R.randrange(4)

    def shape_a(d):
        d.ellipse(c.r(90, 120, 610, 640), fill=255)

    def shape_b(d):
        for i in range(5):
            y = 150 + i * 130
            d.rectangle(c.r(70, y, 930, y + 78), fill=255)

    def shape_c(d):
        d.pieslice(c.r(-140, 40, 760, 940), 300, 90, fill=255)

    def shape_d(d):
        d.polygon([c.p(500), c.p(90), c.p(940), c.p(720), c.p(60), c.p(720)], fill=255)

    def shape_e(d):
        d.ellipse(c.r(330, 200, 900, 770), fill=255)

    first = [shape_a, shape_b, shape_c, shape_d][shape]
    layer(first, ink1, c.p(7.5), 15, (c.p(R.uniform(-5, 5)), c.p(R.uniform(-5, 5))))
    layer(shape_e if shape != 0 else shape_c, ink2, c.p(6.5), 75,
          (c.p(R.uniform(-6, 6)), c.p(R.uniform(-6, 6))))

    # Type prints as a solid (100 %) pass in the darker ink, with its own
    # slight misregistration — riso solids are solid, only tints get screened.
    m = 76
    title = set_type(c.title, "archivo_black", c.p(1000 - 2 * m), c.p(330),
                     c.p(146), c.p(44), tracking=-18, leading=0.94, caps=True)
    tb = c.place(title, m, 930, type_ink, "lb", plate_pad=(0.22, 0.14))
    if c.artist:
        a = set_type(c.artist, "mono", c.p(700), c.p(70), c.p(26), c.p(16),
                     tracking=200, leading=1.3, max_lines=1, caps=True, axes={"wght": 600})
        c.place(a, m, tb[1] - 22, c.ink, "lb", plate_pad=(0.3, 0.2))
    c.wordmark(1000 - m, 88, type_ink, "rt", size=19, catalogue=True)
    c.apply(add_grain(c.img, c.nrng, 4.0, colour=0.5))


# ── 4. Blue Note ──────────────────────────────────────────────────────────────
def d_bluenote(c):
    R = c.rng
    c.ground(fibre=0.5, grain=4.0, blotch=0.05)
    layout = R.randrange(3)
    if layout == 0:
        bx0, by0, bx1, by1 = 78, 92, 742, 592
    elif layout == 1:
        bx0, by0, bx1, by1 = 258, 92, 922, 592     # block pushed right
    else:
        bx0, by0, bx1, by1 = 78, 92, 922, 536      # wide letterbox
    bar_w = 34
    # offset colour bar, printed slightly out of register behind the block
    if R.random() < 0.5 and bx1 + 26 + bar_w < 980:
        c.rect(bx1 + 26, by0 + 40, bx1 + 26 + bar_w, by1 + 40, fill=c.accent)
    else:
        c.rect(max(0, bx0 - 44), by1 + 22, bx1 - 44, by1 + 22 + bar_w, fill=c.accent)

    block_px = (int(c.p(bx0)), int(c.p(by0)), int(c.p(bx1)), int(c.p(by1)))
    bw, bh = block_px[2] - block_px[0], block_px[3] - block_px[1]
    if c.ai is not None:
        src = c.ai.convert("L").resize((bw, bh), Image.LANCZOS)
    else:
        src = tonal_field(max(bw, bh), c.nrng, blobs=6, contrast_boost=1.35).resize((bw, bh))
        # weight the plate toward the mid-darks so the screen reads as a picture
        src = Image.eval(src, lambda v: int(((v / 255.0) ** 1.45) * 255))
    plate = Image.new("RGB", (bw, bh), c.paper)
    dots = halftone(Image.eval(src, lambda v: 255 - v), c.p(9), 45)
    plate.paste(hx(c.ink), (0, 0), dots)
    plate.paste(hx(shade(c.accent, -0.25)), (0, 0),
                Image.eval(src, lambda v: 255 if v < 46 else 0))
    c.img.paste(plate, (block_px[0], block_px[1]))
    c.d = ImageDraw.Draw(c.img)
    c.d.rectangle(block_px, outline=hx(c.ink), width=max(1, int(c.p(3))))

    m = 78
    ay = by1 + 56
    ty = ay + 56
    if c.artist:
        a = set_type(c.artist, "oswald", c.p(844), c.p(56), c.p(30), c.p(18),
                     tracking=300, leading=1.2, max_lines=1, caps=True, axes={"wght": 500})
        c.place(a, m, ay, c.accent if contrast(c.accent, c.paper) >= 4.5 else c.ink, "lt")
    title = set_type(c.title, "oswald", c.p(844), c.p(900 - ty), c.p(132), c.p(44),
                     tracking=-8, leading=0.92, caps=True, axes={"wght": 600})
    c.place(title, m, ty, c.ink, "lt")
    cred = _kicker(c, 3)
    if cred:
        b = Block([cred[:56]], font("mono", c.p(17), wght=400), 130, c.p(24), "right", "mono")
        c.place(b, 1000 - m, 946, c.ink, "rb")
    c.wordmark(m, 946, c.ink, "lb", size=18, catalogue=True)
    c.apply(add_grain(c.img, c.nrng, 3.0))


# ── 5. Metal ──────────────────────────────────────────────────────────────────
def d_metal(c):
    R = c.rng
    if not c.paint_ai("duotone"):
        c.flat(c.paper)
        # a single shaft of light behind the emblem — everything else stays black
        f = tonal_field(c.S, c.nrng, blobs=2, contrast_boost=0.5)
        f = f.filter(ImageFilter.GaussianBlur(c.p(28)))
        glow = Image.new("RGB", (c.S, c.S), hx(shade(c.paper, 0.20)))
        base = Image.new("RGB", (c.S, c.S), hx(c.paper))
        beam = Image.new("L", (c.S, c.S), 0)
        ImageDraw.Draw(beam).polygon(
            [c.p(500), c.p(-40), c.p(1080), c.p(1040), c.p(-80), c.p(1040)], fill=120)
        beam = beam.filter(ImageFilter.GaussianBlur(c.p(70)))
        base.paste(glow, (0, 0), ImageChops.multiply(beam, f))
        c.apply(base)
    cx, cy = 500, 352
    emblem = R.randrange(3)
    ac, ink = c.accent, c.ink

    if emblem == 0:                     # solar sigil: filled disc + heavy rays
        for i in range(24):
            a = i * math.pi / 12
            w = 274 if i % 2 == 0 else 228
            c.d.polygon([(c.p(cx + math.cos(a) * 170), c.p(cy + math.sin(a) * 170)),
                         (c.p(cx + math.cos(a + 0.085) * w), c.p(cy + math.sin(a + 0.085) * w)),
                         (c.p(cx + math.cos(a - 0.085) * w), c.p(cy + math.sin(a - 0.085) * w))],
                        fill=hx(ink))
        c.ellipse(cx - 180, cy - 180, cx + 180, cy + 180, fill=ink)
        c.ellipse(cx - 138, cy - 138, cx + 138, cy + 138, fill=c.paper)
        c.ellipse(cx - 84, cy - 84, cx + 84, cy + 84, fill=ac)
    elif emblem == 1:                   # gate: solid arch, barred
        c.d.pieslice(c.r(cx - 230, cy - 270, cx + 230, cy + 190), 180, 360, fill=hx(ink))
        c.rect(cx - 230, cy - 40, cx + 230, cy + 212, fill=ink)
        c.rect(cx - 270, cy + 212, cx + 270, cy + 252, fill=ink)
        c.d.pieslice(c.r(cx - 170, cy - 210, cx + 170, cy + 130), 180, 360, fill=hx(c.paper))
        c.rect(cx - 170, cy - 40, cx + 170, cy + 186, fill=c.paper)
        for i in range(5):
            x = cx - 144 + i * 72
            c.rect(x - 8, cy - 130, x + 8, cy + 186, fill=ac)
    else:                               # inverted triangle, heavy chalice
        c.ellipse(cx - 252, cy - 252, cx + 252, cy + 252, fill=ink)
        c.ellipse(cx - 214, cy - 214, cx + 214, cy + 214, fill=c.paper)
        c.d.polygon([c.p(cx - 216), c.p(cy - 132), c.p(cx + 216), c.p(cy - 132),
                     c.p(cx), c.p(cy + 250)], fill=hx(ink))
        c.d.polygon([c.p(cx - 140), c.p(cy - 72), c.p(cx + 140), c.p(cy - 72),
                     c.p(cx), c.p(cy + 176)], fill=hx(ac))

    txt = strip_undrawable(c.title, "blackletter")
    use_black = len(txt) <= 18 and usable_face("blackletter", txt) == "blackletter"
    if use_black:
        title = set_type(c.title, "blackletter", c.p(880), c.p(200), c.p(150), c.p(52),
                         tracking=6, leading=1.0, max_lines=2, align="center")
    else:
        title = set_type(c.title, "fraunces", c.p(880), c.p(200), c.p(120), c.p(38),
                         tracking=36, leading=0.96, align="center", caps=True,
                         max_lines=2, axes={"wght": 900, "opsz": 144, "WONK": 0})
    c.line(392, 676, 608, 676, c.accent, 4)
    c.place(title, 500, 712, c.ink, "ct")
    if c.artist:
        a = set_type(c.artist, "grotesk", c.p(760), c.p(50), c.p(26), c.p(16),
                     tracking=440, leading=1.2, max_lines=1, align="center",
                     caps=True, axes={"wght": 500})
        c.place(a, 500, 908, c.soft_ink(0.4), "cm")
    c.wordmark(500, 974, c.soft_ink(0.55), "cb", size=15, tracking=320)
    c.apply(distress(c.img, c.nrng, 1.25, c.paper))
    c.apply(vignette(c.img, 0.62, 1.35))
    c.apply(add_grain(c.img, c.nrng, 6.0))


# ── 6. Neon horizon ───────────────────────────────────────────────────────────
def d_synthwave(c):
    R = c.rng
    S = c.S
    # Set the title first: the ground band is cut to fit it, and the horizon is
    # then placed so the perspective grid always keeps a decent run-up.
    m = 76
    title = set_type(c.title, "anton", c.p(1000 - 2 * m), c.p(250), c.p(124), c.p(36),
                     tracking=8, leading=0.94, max_lines=2, caps=True)
    mk = title.mask()
    band_top = 942 - (mk.size[1] / c.u) - 38
    hz = min(596.0, band_top - 215)
    sky_top = shade(c.paper, -0.35)
    sky_bot = mix(c.paper, c.accent, 0.45)
    grad = np.zeros((S, S, 3), np.float32)
    t = np.linspace(0, 1, int(c.p(hz)))[:, None] ** 1.35
    top, bot = np.array(hx(sky_top), np.float32), np.array(hx(sky_bot), np.float32)
    grad[:int(c.p(hz))] = top + (bot - top) * t[..., None]
    grad[int(c.p(hz)):] = np.array(hx(shade(c.paper, -0.5)), np.float32)
    c.apply(Image.fromarray(grad.clip(0, 255).astype(np.uint8), "RGB"))
    if c.ai is not None:
        sky = c.ai.convert("RGB").resize((S, S), Image.LANCZOS)
        sky = duotone(sky, shade(c.paper, -0.4), c.accent)
        c.img.paste(sky.crop((0, 0, S, int(c.p(hz)))), (0, 0))
        c.d = ImageDraw.Draw(c.img)

    sky_only = c.img.copy()
    comp = R.choice([0, 0, 1, 2])
    if comp == 2:                       # angular ridgeline instead of a sun
        pts, x = [(0, hz)], 0.0
        while x < 1000:
            step = 120 + R.random() * 130
            x = min(1000.0, x + step * 0.5)
            pts.append((x, hz - 40 - R.random() ** 1.3 * 250))
            x = min(1000.0, x + step * 0.5)
            pts.append((x, hz - 12 - R.random() * 60))
        pts += [(1000, hz), (1000, hz + 4), (0, hz + 4)]
        c.d.polygon([(c.p(a), c.p(b)) for a, b in pts], fill=hx(c.accent))
    else:                               # sun with cut slits, punched back to sky
        sx, sy, sr = 500, 452, 208
        if comp == 1:
            c.ellipse(sx - sr, sy - sr, sx + sr, sy + sr, outline=c.accent, width=16)
        else:
            c.ellipse(sx - sr, sy - sr, sx + sr, sy + sr, fill=c.accent)
        cut = Image.new("L", (S, S), 0)
        cd = ImageDraw.Draw(cut)
        if comp == 0:                   # slits only cut a solid disc
            y, gap, hgt = sy + 10, 15, 7
            while y < sy + sr + 40:
                cd.rectangle(c.r(sx - sr - 6, y, sx + sr + 6, y + hgt), fill=255)
                y += hgt + gap
                hgt += 3.4
                gap += 1.5
        cd.rectangle((0, int(c.p(hz)), S, S), fill=255)   # the sun sets at the horizon
        c.img.paste(sky_only, (0, 0), cut)
        c.d = ImageDraw.Draw(c.img)

    # perspective grid
    gcol = mix(c.accent, c.ink, 0.35)
    for i in range(-14, 15):
        c.line(500, hz, 500 + i * 190, 1000, gcol, 2)
    k = 0.0
    while k < 1.0:
        y = hz + (1000 - hz) * (k ** 2.1)
        c.line(0, y, 1000, y, gcol, 2)
        k += 0.075
    band = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(band)
    y0 = int(c.p(band_top - 110))
    dark = hx(shade(c.paper, -0.66))
    for i in range(S - y0):
        a = int(255 * min(1.0, (i / max(1, int(c.p(110)))) * 1.35))
        bd.line((0, y0 + i, S, y0 + i), fill=dark + (a,))
    c.apply(Image.alpha_composite(c.img.convert("RGBA"), band))
    c.rect(0, band_top, 1000, 1000, fill=dark)
    c.line(0, band_top, 1000, band_top, c.accent, 2.5)

    off = int(c.p(5))
    tx, ty = int(c.p(m)), int(c.p(942)) - mk.size[1]
    # Offset print: the second colour shows as a fringe *around* the type, never
    # under it, so the glyphs always sit on the solid band.
    main = Image.new("L", (S, S), 0)
    main.paste(mk, (tx, ty))
    shifted = Image.new("L", (S, S), 0)
    shifted.paste(mk, (tx + off, ty + off))
    c.img.paste(hx(c.accent), (0, 0), ImageChops.subtract(shifted, main))
    c.d = ImageDraw.Draw(c.img)
    c.stamp(mk, tx, ty, c.ink, "title")
    if c.artist:
        a = set_type(c.artist, "mono", c.p(640), c.p(46), c.p(22), c.p(14),
                     tracking=340, leading=1.2, max_lines=1, caps=True, axes={"wght": 500})
        c.place(a, m, band_top - 22, c.accent, "lb")
    c.wordmark(1000 - m, 78, c.ink, "rt", size=17, catalogue=True)
    c.apply(scanlines(c.img, max(3.0, c.p(3.4)), 26))
    c.apply(add_grain(c.img, c.nrng, 3.5))


# ── 7. Minimal / ambient ──────────────────────────────────────────────────────
def d_ambient(c):
    R = c.rng
    c.paint_ai("duotone") or c.ground(grain=3.0, fibre=0.35, blotch=0.05)
    form = R.randrange(4)
    # the single form is a real value step, not a whisper; one hairline and one
    # small punctuation mark keep it composed rather than merely empty
    tone = mix(c.accent, c.ink, 0.28)
    rule = mix(c.ink, c.paper, 0.45)
    if form == 0:
        c.ellipse(268, 348, 902, 982, fill=tone)
        c.line(64, 348, 936, 348, rule, 2)
        c.rect(872, 92, 936, 156, fill=c.ink)
    elif form == 1:
        c.rect(0, 430, 1000, 648, fill=tone)
        c.rect(0, 648, 1000, 690, fill=mix(tone, c.ink, 0.45))
        c.line(0, 768, 1000, 768, rule, 2)
        c.ellipse(842, 726, 926, 810, fill=c.ink)
    elif form == 2:
        c.ellipse(196, 330, 900, 1034, outline=tone, width=30)
        c.line(64, 330, 196, 330, rule, 2)
        c.rect(872, 96, 936, 118, fill=c.ink)
    else:
        c.d.pieslice(c.r(150, 368, 900, 1118), 180, 360, fill=hx(tone))
        c.line(64, 368, 150, 368, rule, 2)
        c.line(900, 368, 936, 368, rule, 2)
        c.ellipse(870, 92, 936, 158, outline=c.ink, width=5)
    soft = c.img.filter(ImageFilter.GaussianBlur(c.p(1.1)))
    c.apply(Image.blend(c.img, soft, 0.45))

    m = 92
    title = set_type(c.title, "grotesk", c.p(700), c.p(210), c.p(62), c.p(26),
                     tracking=155, leading=1.5, caps=True, axes={"wght": 400})
    tb = c.place(title, m, m + 6, c.ink, "lt")
    if c.artist:
        a = set_type(c.artist, "grotesk", c.p(620), c.p(60), c.p(25), c.p(15),
                     tracking=330, leading=1.3, max_lines=1, caps=True, axes={"wght": 500})
        c.place(a, m, tb[3] + 38, c.soft_ink(0.28), "lt")
    c.wordmark(m, 1000 - m, c.soft_ink(0.35), "lb", size=16, tracking=340)
    kick = _kicker(c, 2)
    if kick:
        b = Block([kick[:34]], font("mono", c.p(16), wght=400), 260, c.p(22), "right", "mono")
        c.place(b, 1000 - m, 1000 - m, c.soft_ink(0.35), "rb")
    c.apply(add_grain(c.img, c.nrng, 3.2))


# ── 8. Pop cut-out ────────────────────────────────────────────────────────────
def d_pop(c):
    R = c.rng
    c.paint_ai("posterize") or c.flat(c.paper)
    split = R.randrange(3)
    if split == 0:
        c.d.polygon([(0, 0), (c.S, 0), (c.S, c.p(560)), (0, c.p(340))], fill=c.accent)
    elif split == 1:
        c.rect(0, 0, 1000, 420, fill=c.accent)
    else:
        c.ellipse(-180, -180, 760, 760, fill=c.accent)

    shapes = R.randrange(3)
    if shapes == 0:                     # one big half-disc + a punched hole
        c.d.pieslice(c.r(180, 540, 1180, 1540), 180, 360, fill=hx(c.accent2))
        c.ellipse(96, 118, 322, 344, fill=c.ink)
        c.ellipse(158, 180, 260, 282, fill=c.paper)
    elif shapes == 1:                   # quarter round + a leaning slab
        c.d.pieslice(c.r(430, -430, 1430, 570), 90, 180, fill=hx(c.accent2))
        c.d.polygon([c.p(90), c.p(880), c.p(300), c.p(560),
                     c.p(470), c.p(600), c.p(260), c.p(930)], fill=hx(c.ink))
        c.ellipse(700, 690, 960, 950, fill=c.accent2)
    else:                               # stacked lozenges
        c.d.pieslice(c.r(-260, 600, 500, 1360), 270, 360, fill=hx(c.accent2))
        c.d.pieslice(c.r(500, 600, 1260, 1360), 180, 270, fill=hx(c.ink))
        c.ellipse(620, 90, 950, 420, fill=c.accent2)

    rot = R.choice([0, 0, -3, 3])
    face = R.choice(["syne", "archivo_black"])
    axes = {"wght": 800} if face == "syne" else {}
    title = set_type(c.title, face, c.p(816), c.p(400), c.p(160), c.p(46),
                     tracking=-16, leading=0.92, caps=True, axes=axes)
    y = 320 if shapes != 1 else 250
    order = [[c.ink, c.paper], [c.paper, c.ink], [c.ink, c.paper]]
    for i, ln in enumerate(title.lines):
        b = Block([ln], title.font, title.tracking, title.line_h, "left", title.face)
        cands = order[i % len(order)]
        # prefer a colour that already clears the contrast rule over a plate
        fill = c.pick_fill(b, 84, y, "lt", cands, rotate=rot) or cands[0]
        box = c.place(b, 84, y, fill, "lt", rotate=rot, plate_pad=(0.16, 0.08))
        y = box[3] + 4
    if c.artist:
        a = Block([strip_undrawable(c.artist, "grotesk").upper()[:34]],
                  font("grotesk", c.p(25), wght=600), 180, c.p(32), "left", "grotesk")
        mk = a.mask()
        pad = int(c.p(20))
        x0, y0 = int(c.p(84)), int(c.p(y + 34))
        c.d.rounded_rectangle((x0, y0, x0 + mk.size[0] + pad * 2, y0 + mk.size[1] + pad * 2),
                              radius=int(c.p(26)), fill=hx(c.ink))
        c.stamp(mk, x0 + pad, y0 + pad, c.paper, "artist")
    c.wordmark(1000 - 84, 1000 - 72, c.ink, "rb", size=19, catalogue=True)
    c.apply(add_grain(c.img, c.nrng, 2.4))


# ── 9. Label mono (techno) ────────────────────────────────────────────────────
def d_techno(c):
    R = c.rng
    c.paint_ai("dither") or c.flat(c.paper)
    m = 80
    # corner registration marks
    for (x, y) in ((m, m), (1000 - m, m), (m, 1000 - m), (1000 - m, 1000 - m)):
        c.line(x - 16, y, x + 16, y, c.ink, 1.6)
        c.line(x, y - 16, x, y + 16, c.ink, 1.6)

    title = set_type(c.title, "mono", c.p(1000 - 2 * m), c.p(220), c.p(96), c.p(30),
                     tracking=40, leading=1.1, caps=True, axes={"wght": 700})
    tb = c.place(title, m, 150, c.ink, "lt")
    c.line(m, tb[3] + 26, 1000 - m, tb[3] + 26, c.ink, 2)
    if c.artist:
        a = set_type(c.artist, "mono", c.p(600), c.p(48), c.p(26), c.p(16),
                     tracking=260, leading=1.2, max_lines=1, caps=True, axes={"wght": 500})
        c.place(a, m, tb[3] + 44, c.accent if contrast(c.accent, c.paper) >= 4.5
                else c.ink, "lt")

    # seeded data matrix — the "sleeve art" is information, not illustration
    cols, rows = 24, 13
    gx0, gy0, gx1, gy1 = m, 470, 1000 - m, 790
    cw = (gx1 - gx0) / cols
    ch = (gy1 - gy0) / rows
    bits = random.Random(c.seed ^ 0xDA7A)
    for j in range(rows):
        for i in range(cols):
            v = bits.random() + 0.45 * math.sin((i / cols) * 6.0 + j * 0.7 +
                                                (c.seed % 97) * 0.13)
            x0 = gx0 + i * cw
            y0 = gy0 + j * ch
            if v > 1.02:
                c.rect(x0, y0, x0 + cw - 2, y0 + ch - 2, fill=c.accent)
            elif v > 0.72:
                c.rect(x0, y0, x0 + cw - 2, y0 + ch - 2, fill=c.ink)
            elif v > 0.46:
                c.rect(x0, y0, x0 + cw - 2, y0 + ch - 2, outline=c.ink, width=1.4)

    col = _tag_column(c, 5)
    if col:
        b = Block(col, font("mono", c.p(17), wght=400), 110, c.p(26), "right", "mono")
        c.place(b, 1000 - m, 846, shade(c.ink, -0.1 if luminance(c.ink) > .5 else 0.25), "rt")
    meta = Block([c.catalogue, "%d BPM" % (90 + c.seed % 60), "SIDE A"],
                 font("mono", c.p(17), wght=400), 110, c.p(26), "left", "mono")
    c.place(meta, m, 846, shade(c.ink, -0.1 if luminance(c.ink) > .5 else 0.25), "lt")
    c.wordmark(m, 1000 - m, c.ink, "lb", size=17)
    c.apply(add_grain(c.img, c.nrng, 2.6))


# ── 10. Letterpress / folk ────────────────────────────────────────────────────
def _ornament(c, y, colour, half=190):
    c.line(500 - half, y, 500 - 34, y, colour, 2.4)
    c.line(500 - half, y + 8, 500 - 34, y + 8, colour, 1.2)
    c.line(500 + 34, y, 500 + half, y, colour, 2.4)
    c.line(500 + 34, y + 8, 500 + half, y + 8, colour, 1.2)
    c.d.polygon([c.p(500), c.p(y - 11), c.p(512), c.p(y + 4),
                 c.p(500), c.p(y + 19), c.p(488), c.p(y + 4)], fill=hx(colour))


def d_folk(c):
    c.paint_ai("duotone") or c.ground(fibre=0.95, grain=5.0, blotch=0.08)
    kick = _kicker(c, 2)
    if kick:
        b = Block([kick[:38]], font("instrument_it", c.p(30)), 60, c.p(38),
                  "center", "instrument_it")
        c.place(b, 500, 146, c.ink, "cm")
    _ornament(c, 198, c.accent)
    title = set_type(c.title, c.rng.choice(["dmserif", "fraunces", "playfair"]),
                     c.p(780), c.p(370), c.p(142), c.p(48), tracking=6, leading=1.04,
                     align="center", axes={"wght": 700, "opsz": 144, "WONK": 0})
    tb = c.place(title, 500, 470, c.ink, "cm")
    c.line(424, tb[3] + 44, 576, tb[3] + 44, c.accent, 2.2)
    if c.artist:
        a = set_type(c.artist, "grotesk", c.p(700), c.p(54), c.p(25), c.p(15),
                     tracking=380, leading=1.3, max_lines=1, align="center",
                     caps=True, axes={"wght": 500})
        c.place(a, 500, tb[3] + 88, c.ink, "ct")
    _ornament(c, 792, c.accent)
    c.wordmark(500, 872, c.soft_ink(0.3), "ct", size=16, tracking=340)
    # letterpress: press the ink slightly into the sheet
    tex = paper_ground(c.S, "#FFFFFF", c.nrng, fibre=1.2, grain=8.0, blotch=0.10)
    c.apply(ImageChops.multiply(c.img, tex.point(lambda v: 150 + v * 0.41)))
    c.apply(vignette(c.img, 0.2, 2.2))


# ── 11. Bauhaus ───────────────────────────────────────────────────────────────
def d_bauhaus(c):
    R = c.rng
    c.paint_ai("posterize") or c.ground(grain=3.2, fibre=0.3, blotch=0.04)
    a, b = c.accent, c.accent2
    comp = R.randrange(4)
    if comp == 0:
        c.ellipse(0, 0, 500, 500, fill=a)
        c.rect(500, 0, 1000, 500, fill=b)
        c.d.pieslice(c.r(0, 500, 1000, 1500), 180, 270, fill=hx(c.ink))
        c.rect(0, 470, 1000, 500, fill=c.ink)
    elif comp == 1:
        c.d.pieslice(c.r(100, 100, 900, 900), 180, 360, fill=hx(a))
        c.d.polygon([c.p(500), c.p(500), c.p(900), c.p(900), c.p(100), c.p(900)],
                    fill=hx(b))
        c.ellipse(420, 420, 580, 580, fill=c.ink)
    elif comp == 2:
        c.rect(120, 0, 330, 1000, fill=a)
        c.ellipse(330, 180, 830, 680, fill=b)
        c.rect(330, 680, 1000, 740, fill=c.ink)
    else:
        for i in range(3):
            c.rect(0, 120 + i * 260, 1000, 120 + i * 260 + 90,
                   fill=[a, c.ink, b][i])
        c.ellipse(600, 560, 940, 900, fill=a)
        c.d.polygon([c.p(120), c.p(900), c.p(420), c.p(900), c.p(270), c.p(620)],
                    fill=hx(c.ink))

    vertical = R.random() < 0.45
    if vertical:
        title = set_type(c.title, "archivo", c.p(760), c.p(210), c.p(126), c.p(40),
                         tracking=-6, leading=0.92, caps=True,
                         axes={"wght": 900, "wdth": 66})
        c.place(title, 92, 940, c.ink if contrast(c.ink, c.paper) >= 4.5 else c.paper,
                "lb", rotate=90)
    else:
        c.rect(0, 760, 1000, 1000, fill=c.paper)
        title = set_type(c.title, "archivo", c.p(840), c.p(150), c.p(110), c.p(38),
                         tracking=-8, leading=0.9, caps=True,
                         axes={"wght": 900, "wdth": 70})
        c.place(title, 80, 800, c.ink, "lt")
    if c.artist:
        ar = set_type(c.artist, "grotesk", c.p(560), c.p(44), c.p(22), c.p(14),
                      tracking=260, leading=1.2, max_lines=1, caps=True,
                      axes={"wght": 500})
        c.place(ar, 80 if not vertical else 1000 - 80, 950,
                c.ink, "lb" if not vertical else "rb")
    c.wordmark(1000 - 80, 80, c.ink, "rt", size=18, catalogue=True)
    c.apply(add_grain(c.img, c.nrng, 2.8))


# ── 12. Xerox zine ────────────────────────────────────────────────────────────
def d_xerox(c):
    R = c.rng
    S = c.S
    if c.ai is not None:
        src = c.ai.convert("L").resize((S, S), Image.LANCZOS)
    else:
        src = tonal_field(S, c.nrng, blobs=4, contrast_boost=1.9)
        sd = ImageDraw.Draw(src)
        kind = R.randrange(3)
        if kind == 0:
            sd.ellipse(c.r(160, 90, 820, 750), fill=30)
        elif kind == 1:
            for i in range(7):
                sd.rectangle(c.r(0, 70 + i * 120, 1000, 70 + i * 120 + 56), fill=20)
        else:
            sd.polygon([c.p(500), c.p(60), c.p(960), c.p(760), c.p(40), c.p(760)], fill=25)
    onebit = src.convert("1").convert("L")
    sheet = Image.new("RGB", (S, S), hx(c.paper))
    sheet.paste(hx(c.ink), (0, 0), Image.eval(onebit, lambda v: 255 - v))
    # skewed photocopy: rotate the whole plate a hair, leave a white edge
    sheet = sheet.rotate(R.uniform(-1.8, 1.8), resample=Image.BICUBIC,
                         fillcolor=hx(shade(c.paper, 0.4)))
    c.apply(sheet)
    # toner streaks down one edge
    lay = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(lay)
    edge = R.choice([0, 1])
    for i in range(70):
        x = (R.random() ** 2) * c.p(150) + (0 if edge == 0 else c.p(850))
        ld.line((x, 0, x + R.uniform(-8, 8), S), fill=hx(c.ink) + (R.randrange(10, 60),),
                width=max(1, int(c.p(R.uniform(0.6, 3)))))
    c.apply(Image.alpha_composite(c.img.convert("RGBA"), lay))

    if c.accent != c.ink and c.accent != c.paper:
        sw = Image.new("RGB", (S, S), (255, 255, 255))
        swd = ImageDraw.Draw(sw)
        y = c.p(R.uniform(120, 700))
        swd.rectangle((0, y, S, y + c.p(R.uniform(70, 150))), fill=hx(c.accent))
        c.apply(ImageChops.multiply(c.img, sw))

    m = 66
    txt = strip_undrawable(c.title, "archivo_black").upper() or "UNTITLED"
    face = R.choice(["archivo_black", "anton"])
    gap = c.p(9)
    masks = justified_stack(txt, face, c.p(1000 - 2 * m) * 0.96,
                            max_lines=MAX_LINES, max_stack=c.p(560),
                            gap=gap + c.p(26), tracking=-14,
                            hi=c.p(250), lo=c.p(18))
    bars = [(mk, mk.size[1] + int(c.p(26))) for mk in masks]
    stack = sum(h for _, h in bars) + gap * (len(bars) - 1)
    at_top = R.random() < 0.42
    y_px = c.p(104) if at_top else min(c.p(900) - stack, c.p(560))
    y_px = max(c.p(70), y_px)
    for mk, bar_h in bars:
        yy = int(round(y_px))
        c.d.rectangle((int(c.p(m - 16)), yy, S - int(c.p(m - 16)), yy + bar_h),
                      fill=hx(c.ink))
        c.stamp(mk, int(c.p(m)), yy + int(c.p(13)), c.paper, "title-line")
        y_px += bar_h + gap
    y = y_px / c.u
    if c.artist and y < 880:
        a = Block([strip_undrawable(c.artist, "mono").upper()[:32]],
                  font("mono", c.p(24), wght=600), 130, c.p(30), "left", "mono")
        mk = a.mask()
        pad = int(c.p(16))
        card = Image.new("RGB", (mk.size[0] + pad * 2, mk.size[1] + pad * 2), hx(c.paper))
        ImageDraw.Draw(card).rectangle((0, 0, card.size[0] - 1, card.size[1] - 1),
                                       outline=hx(c.ink), width=max(2, int(c.p(4))))
        card.paste(hx(c.ink), (pad, pad), mk)
        card = card.rotate(R.uniform(-3.5, 3.5), expand=True,
                           resample=Image.BICUBIC, fillcolor=hx(c.paper))
        c.img.paste(card, (int(c.p(m)), int(c.p(y + 26))))
        c.d = ImageDraw.Draw(c.img)
    c.wordmark(1000 - m, 1000 - m, c.ink, "rb", size=18, catalogue=True, plate="box")
    a = np.asarray(c.img).astype(np.float32)
    sp = c.nrng.random(a.shape[:2])
    a[sp > 0.9985] = 0
    a[sp < 0.0012] = 255
    c.apply(Image.fromarray(a.clip(0, 255).astype(np.uint8), "RGB"))
    c.apply(add_grain(c.img, c.nrng, 4.0))


DIRECTIONS = {
    "swiss":     {"label": "Swiss grid",    "fn": d_swiss},
    "brutalist": {"label": "Brutalist",     "fn": d_brutalist},
    "riso":      {"label": "Risograph",     "fn": d_riso},
    "bluenote":  {"label": "Blue Note",     "fn": d_bluenote},
    "metal":     {"label": "Metal",         "fn": d_metal},
    "synthwave": {"label": "Neon horizon",  "fn": d_synthwave},
    "ambient":   {"label": "Minimal",       "fn": d_ambient},
    "pop":       {"label": "Pop cut-out",   "fn": d_pop},
    "techno":    {"label": "Label mono",    "fn": d_techno},
    "folk":      {"label": "Letterpress",   "fn": d_folk},
    "bauhaus":   {"label": "Bauhaus",       "fn": d_bauhaus},
    "xerox":     {"label": "Xerox zine",    "fn": d_xerox},
}


def directions():
    """[{'id', 'label'}] for the UI, in menu order."""
    return [{"id": k, "label": v["label"]} for k, v in DIRECTIONS.items()]


# ══════════════════════════════════════════════════════════════════════════════
#  Optional AI art layer
# ══════════════════════════════════════════════════════════════════════════════

def _import_cover_ai():
    try:
        import cover_ai                      # flat layout (uvicorn app:app)
        return cover_ai
    except ImportError:
        pass
    try:
        from . import cover_ai               # package layout
        return cover_ai
    except Exception:
        return None


def ai_status():
    """(available, reason) — never raises."""
    mod = _import_cover_ai()
    if mod is None:
        return False, "cover_ai module is not installed"
    try:
        ok, reason = mod.available()
        return bool(ok), str(reason or "")
    except Exception as e:
        return False, f"cover_ai.available() failed: {e}"


def _ai_background(seed, size, style, timeout=180):
    mod = _import_cover_ai()
    if mod is None:
        return None
    try:
        ok, _ = mod.available()
        if not ok:
            return None
        img = mod.background(seed=seed, size=size, style=style, timeout=timeout)
        return img if isinstance(img, Image.Image) else None
    except Exception:
        return None


# ══════════════════════════════════════════════════════════════════════════════
#  Public API
# ══════════════════════════════════════════════════════════════════════════════

def seed_for(job_id, tags, nonce=""):
    key = f"waivepulse-cover|{job_id}|{tags}|{nonce}"
    return int.from_bytes(hashlib.sha256(key.encode("utf-8")).digest()[:8], "big")


def resolve_style(job_id, tags, style=None, nonce=""):
    """(direction_id, use_ai).  *style* may be None/'auto'/'ai'/a direction id."""
    s = (style or "").strip().lower()
    seed = seed_for(job_id, tags, nonce)
    if s in DIRECTIONS:
        return s, False
    if s == "ai":
        return choose_direction(seed, tags), True
    return choose_direction(seed, tags), False


def render(job_id, job, size=1200, style=None, nonce=None):
    """Render a square cover.  Returns a PIL RGB image."""
    return render_audited(job_id, job, size, style, nonce)[0]


def render_audited(job_id, job, size=1200, style=None, nonce=None):
    """render() plus the contrast audit: (image, [(label, ratio), …]).

    Every piece of type on the sleeve is in the list with the WCAG ratio it
    actually achieved against the pixels behind it.  tests/test_cover.py
    asserts they all clear MIN_CONTRAST.
    """
    size = int(max(128, min(3000, size)))
    tags = job.get("tags", "") or ""
    nonce = str(nonce if nonce is not None else (job.get("cover_nonce") or ""))
    style = style if style is not None else job.get("cover_style")
    direction, want_ai = resolve_style(job_id, tags, style, nonce)
    seed = seed_for(job_id, tags, nonce)
    pal = choose_palette(direction, seed, tags)

    title = strip_undrawable(job.get("title") or "", "archivo") or "Untitled"
    artist = strip_undrawable(job.get("artist") or "", "grotesk")

    ai = None
    if want_ai:
        ai = _ai_background(seed, size, {
            "direction": direction, "genre": read_tags(tags)["genre"],
            "mood": read_tags(tags)["mood"],
            "tags": [w for w in read_tags(tags)["words"]],
            "title": title,
            "palette": [pal["paper"], pal["ink"], pal["accent"], pal["accent2"]],
        })

    c = Cover(size, seed, title, artist, tags, direction, pal, ai=ai)
    try:
        DIRECTIONS[direction]["fn"](c)
    except Exception:                       # never fail a cover request
        import sys, traceback
        traceback.print_exc(file=sys.stderr)
        c = Cover(size, seed, title, artist, tags, "swiss",
                  choose_palette("swiss", seed, tags))
        d_swiss(c)
    return c.img.convert("RGB"), c.audit


def render_fitted(job_id, job, w, h, style=None, nonce=None):
    """Square design cropped to an arbitrary w×h (used by the video still)."""
    s = max(int(w), int(h))
    img = render(job_id, job, s, style=style, nonce=nonce)
    if (w, h) == (s, s):
        return img
    left = (s - int(w)) // 2
    top = (s - int(h)) // 2
    return img.crop((left, top, left + int(w), top + int(h)))
