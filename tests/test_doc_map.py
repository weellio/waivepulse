"""The docs must keep up with the app.

Twice now they did not: six features shipped and never reached waivepulse.com, and the
Looper's own in-app help grew to seventeen sections while the README described eight. Both
times a person had to notice. This makes the suite notice instead.

Deliberately coarse. It checks that every feature the app documents to *itself* — the help
sections each page shows under H — is described somewhere in the README, and that every row
of docs/DOC_MAP.md points at something real. It does not check wording, and it does not
fail over a new button, because a doc test that cries wolf gets deleted.
"""
import importlib.util
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
AUDIT = ROOT / "scripts" / "doc_audit.py"


def _audit():
    spec = importlib.util.spec_from_file_location("doc_audit", AUDIT)
    mod = importlib.util.module_from_spec(spec)
    sys.modules["doc_audit"] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture(scope="module")
def audit():
    if not AUDIT.exists():
        pytest.skip("scripts/doc_audit.py is missing")
    return _audit()


def test_the_doc_map_exists_and_lists_features(audit):
    assert audit.DOC_MAP.exists(), "docs/DOC_MAP.md is the index for all of this"
    body = audit.DOC_MAP.read_text(encoding="utf-8")
    assert "<!-- doc-map:start -->" in body and "<!-- doc-map:end -->" in body


def test_every_doc_map_row_resolves(audit):
    """A README anchor that does not exist, a landing claim the page never makes, or a
    missing shot script. The map is worse than useless if it is stale."""
    readme = audit.README.read_text(encoding="utf-8", errors="replace")
    landing = (audit.LANDING.read_text(encoding="utf-8", errors="replace")
               if audit.LANDING.exists() else "")
    problems = audit.check_map(readme, landing)
    assert not problems, "docs/DOC_MAP.md is out of date:\n  " + "\n  ".join(problems)


def test_every_in_app_help_section_is_in_the_readme(audit):
    readme = audit.norm(audit.README.read_text(encoding="utf-8", errors="replace"))
    missing = []
    for page, titles in audit.help_sections().items():
        missing += [f"{page}: {t}" for t in titles if not audit.documented(t, readme)]
    assert not missing, (
        "the app documents these to itself but the README does not mention them:\n  "
        + "\n  ".join(missing))


def test_the_five_pages_are_all_on_the_landing_page(audit):
    if not audit.LANDING.exists():
        pytest.skip("no landing page in this checkout")
    landing = audit.norm(audit.LANDING.read_text(encoding="utf-8", errors="replace"))
    for page in ("generate", "lyrics", "studio", "looper", "karaoke"):
        assert page in landing, f"the landing page never mentions {page}"


def test_shot_scripts_in_the_map_are_runnable_files(audit):
    """Not executed — they need a live server and a GPU — but they must at least exist and
    parse, so a rename does not leave the map pointing at nothing."""
    import ast
    body = audit.DOC_MAP.read_text(encoding="utf-8")
    import re
    block = re.search(r"<!-- doc-map:start -->(.*?)<!-- doc-map:end -->", body, re.S)
    shots = set()
    for line in block.group(1).splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        # skip the header and the |---|---| separator, same rule check_map uses
        if len(cells) != 5 or cells[0] in ("Feature", "") or set(cells[0]) <= {"-"}:
            continue
        if cells[4] != "—":
            shots.add(cells[4])
    assert shots, "no shot scripts mapped at all — did the table change shape?"
    for s in sorted(shots):
        p = ROOT / "scripts" / s
        assert p.exists(), f"scripts/{s} is in the map but not on disk"
        ast.parse(p.read_text(encoding="utf-8", errors="replace"))
