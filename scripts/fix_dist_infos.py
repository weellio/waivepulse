"""Remove old .dist-info directories where a newer version exists in the same directory.

Usage:
    python fix_dist_infos.py [site-packages-path]

If no path is given, reads SITE_PACKAGES_DIR env var, then falls back to the
system Python's default site-packages directory.
"""
import os
import re
import sys
from pathlib import Path
from collections import defaultdict

if len(sys.argv) > 1:
    SITE_PACKAGES = Path(sys.argv[1])
else:
    SITE_PACKAGES = Path(os.environ.get(
        "SITE_PACKAGES_DIR",
        os.path.join(sys.prefix, "lib", "site-packages")
    ))

print(f"Scanning: {SITE_PACKAGES}")

dist_infos = defaultdict(list)
for d in SITE_PACKAGES.iterdir():
    if d.is_dir() and d.name.endswith(".dist-info"):
        m = re.match(r"^(.+?)-(\d[\d.]+)\.dist-info$", d.name)
        if m:
            pkg = m.group(1).lower().replace("-", "_")
            dist_infos[pkg].append((d.name, d))

removed = 0
for pkg, entries in dist_infos.items():
    if len(entries) > 1:
        from packaging.version import Version
        entries.sort(key=lambda x: Version(re.search(r"-([\d.]+)\.dist-info$", x[0]).group(1)))
        to_remove = entries[:-1]
        keep = entries[-1]
        for name, path in to_remove:
            print(f"  removing {name} (keeping {keep[0]})")
            import shutil
            shutil.rmtree(path)
            removed += 1

print(f"Removed {removed} stale dist-info directories.")
