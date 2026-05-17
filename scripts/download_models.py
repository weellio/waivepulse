#!/usr/bin/env python3
"""Download HeartMuLa model weights from HuggingFace.

Set the HEARTMULA_PATH environment variable (or edit the default below)
to the directory where you want the model weights stored.
"""
from huggingface_hub import snapshot_download
import os
import sys
import platform
from pathlib import Path

_default_ckpt = (
    "F:/HeartMuLa/ckpt" if platform.system() == "Windows"
    else str(Path.home() / "HeartMuLa" / "ckpt")
)
CKPT = os.environ.get("HEARTMULA_PATH", _default_ckpt)

models = [
    ("HeartMuLa/HeartMuLaGen",                    f"{CKPT}"),
    ("HeartMuLa/HeartMuLa-oss-3B-happy-new-year", f"{CKPT}/HeartMuLa-oss-3B"),
    ("HeartMuLa/HeartCodec-oss-20260123",          f"{CKPT}/HeartCodec-oss"),
]

for repo_id, local_dir in models:
    print(f"Downloading {repo_id} -> {local_dir} ...")
    sys.stdout.flush()
    try:
        snapshot_download(repo_id=repo_id, local_dir=local_dir)
        print(f"Done: {repo_id}")
        sys.stdout.flush()
    except Exception as e:
        print(f"ERROR: {repo_id}: {e}")
        sys.stdout.flush()

print("All downloads complete.")
