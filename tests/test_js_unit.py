"""Run the frontend's own node unit tests as part of the Python suite.

frontend/js/**/tests/*.test.mjs are real unit tests (prosody: syllables and rhymes;
pronounce: respelling, heteronyms, numbers) but nothing ran them: pytest does not know
about .mjs, and the one pytest file that touches JS only parse-checks. So they passed or
failed entirely unobserved unless someone remembered the node incantation.

One pytest case per .mjs file, so a failure names the file that broke.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
NODE = shutil.which("node")


def _suites():
    base = ROOT / "frontend" / "js"
    return sorted(p for p in base.rglob("*.test.mjs") if "node_modules" not in p.parts)


SUITES = _suites()


def test_the_suites_are_found():
    """If a rename makes this list empty the tests below would silently all pass."""
    assert SUITES, "no *.test.mjs found under frontend/js — has the layout changed?"


@pytest.mark.parametrize("suite", SUITES, ids=lambda p: p.stem)
def test_node_suite_passes(suite):
    if not NODE:
        pytest.skip("node is not on PATH")
    r = subprocess.run([NODE, "--test", str(suite)], capture_output=True, text=True,
                       timeout=300, cwd=str(ROOT))
    if r.returncode != 0:
        failures = [l for l in (r.stdout or "").splitlines()
                    if l.strip().startswith(("not ok", "✖"))]
        detail = "\n  ".join(failures[:12]) or (r.stdout or r.stderr)[-1500:]
        pytest.fail(f"{suite.relative_to(ROOT)} failed:\n  {detail}")
