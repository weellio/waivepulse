"""Verify the Looper's STORE-only zip writer with Python's zipfile.

Run after `node frontend/js/looper/tests/pure.test.mjs` (which writes out/sample.zip).
Optionally pass a .wploop path to check a real saved project too:
    python frontend/js/looper/tests/zip_check.py [path/to/project.wploop]
"""
import json
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).parent


def check(path):
    with zipfile.ZipFile(path) as z:
        bad = z.testzip()                      # CRC-checks every member
        assert bad is None, f"CRC mismatch in {bad}"
        names = z.namelist()
        for info in z.infolist():
            assert info.compress_type == zipfile.ZIP_STORED, info.filename
        print(f"ok  {path.name}: {len(names)} entries, CRCs valid -> {names}")
        if "project.json" in names:
            proj = json.loads(z.read("project.json"))
            print(f"    project v{proj.get('version')} - {proj.get('transport', {}).get('bpm')} BPM - "
                  f"{len(proj.get('loops', []))} loops")
        return z


check(HERE / "out" / "sample.zip")
with zipfile.ZipFile(HERE / "out" / "sample.zip") as z:
    assert z.read("project.json") == b'{"a":1}'
    assert list(z.read("loops/loop1.wav")) == [(i * 37) & 255 for i in range(1000)]
for extra in sys.argv[1:]:
    check(Path(extra))
print("zip check passed")
