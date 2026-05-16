"""Quick end-to-end test: load model, generate a short song, verify output.

Set HEARTMULA_PATH env var to your model checkpoint directory before running.
"""
import torch
import os
import sys
import platform
from pathlib import Path

_default_ckpt = (
    "F:/HeartMuLa/ckpt" if platform.system() == "Windows"
    else str(Path.home() / "HeartMuLa" / "ckpt")
)
CKPT = os.environ.get("HEARTMULA_PATH", _default_ckpt)
OUT  = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "outputs", "test_output.mp3"))

LYRICS = """[Verse]
The city lights shine bright tonight
I walk alone beneath the sky
The music plays inside my head
A melody that won't lie

[Chorus]
Feel the rhythm, feel the beat
Dancing through the crowded street
This is where we come alive
This is how we all survive
"""

TAGS = "pop,piano,happy,upbeat,synthesizer"

os.makedirs(os.path.dirname(OUT), exist_ok=True)

import tempfile, time
with tempfile.TemporaryDirectory() as tmpdir:
    lyrics_path = os.path.join(tmpdir, "lyrics.txt")
    tags_path   = os.path.join(tmpdir, "tags.txt")
    with open(lyrics_path, "w") as f:
        f.write(LYRICS)
    with open(tags_path, "w") as f:
        f.write(TAGS)

    print("Loading HeartMuLa pipeline...")
    t0 = time.time()
    from heartlib import HeartMuLaGenPipeline
    pipe = HeartMuLaGenPipeline.from_pretrained(
        CKPT,
        device={"mula": torch.device("cuda"), "codec": torch.device("cuda")},
        dtype={"mula": torch.bfloat16, "codec": torch.float32},
        version="3B",
        lazy_load=False,
    )
    print(f"Model loaded in {time.time()-t0:.1f}s")

    print("Generating music (60s max)...")
    t1 = time.time()
    with torch.no_grad():
        pipe(
            {"lyrics": lyrics_path, "tags": tags_path},
            max_audio_length_ms=60_000,
            save_path=OUT,
            topk=50,
            temperature=1.0,
            cfg_scale=1.5,
        )
    elapsed = time.time() - t1
    size = os.path.getsize(OUT)
    print(f"Generated in {elapsed:.1f}s -> {OUT} ({size//1024} KB)")
    print("SUCCESS" if size > 10000 else "FAIL: output too small")
