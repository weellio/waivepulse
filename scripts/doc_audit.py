"""What the app can do, versus what the README and waivepulse.com say it can do.

Written because the docs drifted twice: six features shipped to the app and never reached
the landing page, and the Looper's own in-app help grew to seventeen sections while the
README still described eight.

The app is the source of truth. Three things are read out of the frontend:

    help sections   the <div class="help-section-title"> blocks each page shows under H,
                    which is the closest thing to a feature list the app maintains itself
    controls        every <button> label a user can actually press
    pages           the top-level tabs

and each is checked against README.md and landing/index.php. Matching is loose on purpose
— emoji, entities and punctuation are stripped — because a false alarm every time someone
changes a glyph would get the whole thing ignored.

    python scripts/doc_audit.py            # report
    python scripts/doc_audit.py --strict   # exit 1 if a HELP SECTION is undocumented
"""
from __future__ import annotations

import argparse
import html
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
README = ROOT / "README.md"
LANDING = ROOT / "landing" / "index.php"

# Controls that are furniture, not features. Documenting "Close" helps nobody.
STOP = {"and", "the", "for", "with", "all", "your", "into", "from", "one"}

BORING = {
    "close", "cancel", "ok", "dismiss", "back", "save", "open", "copy", "copy again",
    "delete", "remove", "reset", "clear", "apply", "done", "next", "prev", "previous",
    "play", "pause", "stop", "start", "yes", "no", "all", "none", "up dn", "edit",
    "refresh", "retry", "hide", "show", "more", "less", "x",
}


def norm(s: str) -> str:
    """Lower-case alphanumerics and single spaces — glyph-insensitive."""
    s = html.unescape(s or "")
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"[^A-Za-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def help_sections() -> dict[str, list[str]]:
    """The feature list each page keeps for itself, in its help modal."""
    out: dict[str, list[str]] = {}
    for page in sorted(FRONTEND.glob("*.html")):
        text = page.read_text(encoding="utf-8", errors="replace")
        titles = re.findall(r'class="help-section-title"[^>]*>(.*?)</div>', text, re.S)
        # feature modules inject their own sections from JS
        for js in sorted((FRONTEND / "js").rglob("*.js")):
            if "vendor" in js.parts:
                continue
            body = js.read_text(encoding="utf-8", errors="replace")
            if page.stem in str(js) or f"/{page.stem}/" in str(js).replace("\\", "/"):
                titles += re.findall(r'class="help-section-title">(.*?)</div>', body, re.S)
        cleaned = [norm(t) for t in titles]
        if cleaned:
            out[page.stem] = sorted(set(c for c in cleaned if c))
    return out


def controls() -> list[str]:
    seen = set()
    for page in sorted(FRONTEND.glob("*.html")):
        text = page.read_text(encoding="utf-8", errors="replace")
        for m in re.finditer(r"<button[^>]*>(.*?)</button>", text, re.S):
            n = norm(m.group(1))
            if 2 < len(n) < 34 and n not in BORING and not n.isdigit():
                seen.add(n)
    return sorted(seen)


def documented(title: str, haystack: str) -> bool:
    """Is this feature described, under any reasonable name?

    Help titles are sentences ("mashup builder one song per instrument") while the README
    uses the feature's name ("Mashup builder"). Comparing the whole string reports a gap
    for everything that was merely worded differently, which is the fastest way to make an
    audit worthless. So: try the full title, then its first three words, then its first two.
    """
    if title in haystack:
        return True
    words = [w for w in title.split() if len(w) > 2 and w not in STOP]
    if not words:
        return True
    # leading words first: "mashup builder one song per instrument" is the README's
    # "Mashup builder"
    for n in (3, 2):
        if len(words) >= n and " ".join(words[:n]) in haystack:
            return True
    # otherwise fall back to coverage. A title whose words nearly all appear somewhere is
    # described under another name — "All Keyboard Shortcuts" against a Hotkey table — and
    # flagging it trains the reader to ignore this report.
    hits = sum(1 for w in words if w in haystack)
    return hits / len(words) >= 0.75


DOC_MAP = ROOT / "docs" / "DOC_MAP.md"


def anchor_of(heading: str) -> str:
    """GitHub's anchor for a markdown heading."""
    a = heading.strip().lower()
    a = re.sub(r"[^\w\s-]", "", a)
    return re.sub(r"\s+", "-", a)


def check_map(readme_raw: str, landing_raw: str) -> list[str]:
    """Every cell in docs/DOC_MAP.md must point at something that exists.

    The map is only worth keeping if it is checked. A table of stale anchors is worse than
    no table, because it looks authoritative.
    """
    problems: list[str] = []
    if not DOC_MAP.exists():
        return ["docs/DOC_MAP.md is missing"]
    body = DOC_MAP.read_text(encoding="utf-8", errors="replace")
    block = re.search(r"<!-- doc-map:start -->(.*?)<!-- doc-map:end -->", body, re.S)
    if not block:
        return ["docs/DOC_MAP.md has no doc-map:start/end block"]

    anchors = {anchor_of(h) for h in re.findall(r"^#{2,4}\s+(.+)$", readme_raw, re.M)}
    rows = 0
    for line in block.group(1).splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if len(cells) != 5 or cells[0] in ("Feature", "") or set(cells[0]) <= {"-"}:
            continue
        rows += 1
        feature, readme_a, landing_s, _help, shot = cells
        if readme_a != "—" and readme_a.lstrip("#") not in anchors:
            problems.append(f"{feature}: README anchor {readme_a} does not exist")
        if landing_s != "—" and norm(landing_s) not in norm(landing_raw):
            problems.append(f"{feature}: landing page never says {landing_s!r}")
        if shot != "—" and not (ROOT / "scripts" / shot).exists():
            problems.append(f"{feature}: scripts/{shot} is missing")
    if not rows:
        problems.append("docs/DOC_MAP.md lists no features")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--strict", action="store_true",
                    help="exit 1 when a help section is missing from the README")
    args = ap.parse_args()

    readme = norm(README.read_text(encoding="utf-8", errors="replace"))
    landing = norm(LANDING.read_text(encoding="utf-8", errors="replace")) if LANDING.exists() else ""

    missing_sections: list[str] = []
    print("=== in-app help sections vs the README ===")
    for page, titles in help_sections().items():
        gaps = [t for t in titles if not documented(t, readme)]
        state = "all documented" if not gaps else f"{len(gaps)} missing"
        print(f"  {page:<10} {len(titles):>2} sections, {state}")
        for g in gaps:
            print(f"       - {g}")
            missing_sections.append(f"{page}: {g}")

    print("\n=== controls not mentioned in the README ===")
    gaps = [c for c in controls() if c not in readme]
    print(f"  {len(gaps)} of {len(controls())}")
    for g in gaps:
        print(f"       - {g}")

    if landing:
        print("\n=== the five pages, on the landing page ===")
        for page in ("generate", "lyrics", "studio", "looper", "karaoke"):
            print(f"  {page:<10} {'yes' if page in landing else 'NOT MENTIONED'}")

    readme_raw = README.read_text(encoding="utf-8", errors="replace")
    landing_raw = LANDING.read_text(encoding="utf-8", errors="replace") if LANDING.exists() else ""
    map_problems = check_map(readme_raw, landing_raw)
    print("\n=== docs/DOC_MAP.md ===")
    if map_problems:
        for m in map_problems:
            print(f"       - {m}")
    else:
        print("  every mapped feature resolves on every surface it claims")

    print(f"\n{len(missing_sections)} help section(s) undocumented in the README, "
          f"{len(map_problems)} broken map entries.")
    if args.strict and (missing_sections or map_problems):
        print("FAIL: --strict")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
