"""Every frontend JS file must parse.

A stray apostrophe in a single-quoted string ("the browser's") took the whole Looper page down
with `Uncaught SyntaxError: missing ) after argument list`. Nothing else catches it: the file is
never imported by a test, and the page just dies in the browser.

Run: F:\\HeartMuLa\\venv\\Scripts\\python.exe tests\\test_js_syntax.py
"""
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JS = ROOT / "frontend" / "js"
WORKLETS = ROOT / "frontend" / "worklets"
NODE = shutil.which("node")


def js_files():
    for base in (JS, WORKLETS):
        if base.is_dir():
            for p in sorted(base.rglob("*.js")):
                if "vendor" in p.parts or "node_modules" in p.parts:
                    continue          # third-party bundles are not ours to parse-check
                yield p


def test_all_frontend_js_parses():
    """The module had no test_ function, so pytest collected the file and ran nothing —
    the parse check that exists to stop a stray apostrophe killing a page was only ever
    run by hand. This is the same check, as a real test."""
    import pytest
    if not NODE:
        pytest.skip("node is not on PATH")
    bad = []
    for p in js_files():
        r = subprocess.run([NODE, "--check", str(p)], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            first = next((l for l in (r.stderr or "").splitlines() if "Error" in l), "").strip()
            bad.append(f"{p.relative_to(ROOT)}: {first}")
    assert not bad, "JS files that do not parse:\n  " + "\n  ".join(bad)


def main():
    if not NODE:
        print("SKIP: node is not on PATH")
        return 0
    bad = []
    files = list(js_files())
    for p in files:
        r = subprocess.run([NODE, "--check", str(p)], capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            first = next((l for l in (r.stderr or "").splitlines() if "Error" in l), "").strip()
            bad.append((p.relative_to(ROOT), first))
    for rel, err in bad:
        print(f"  FAIL {rel}: {err}")
    print(f"{len(files) - len(bad)} of {len(files)} JS files parse" + ("" if not bad else f" ({len(bad)} broken)"))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
