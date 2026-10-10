"""Download the ACE-Step base checkpoint, which the Add a Part jobs need.

Rewrite Section uses the TURBO checkpoint, which ships with the normal ACE-Step install.
lego / complete / extract have no weights in turbo, so "Add a layer", "Build a backing track"
and "Isolate a track" need the base model as a separate ~4.5 GB download.

This is the 2B base (`acestep-v15-base`), NOT `acestep-v15-xl-base` — the XL one is the 4B
model that wants 24 GB of VRAM. Measured on a 12 GB RTX 3060 with the 2B base: a layer job
peaked at 7.3 GB and a backing track at 9.3 GB, both around 80 s for a 30 s song.

It installs next to the ACE-Step checkpoints already on disk, never the C: drive.

    python scripts/get_acestep_base.py            # download if missing
    python scripts/get_acestep_base.py --check    # just say whether it is here
"""
import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import engines.acestep as eng                                       # noqa: E402

MODEL = eng.BASE_MODEL


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true", help="report and exit")
    args = ap.parse_args()

    ckpt = eng.ACE_CKPT
    print(f"checkpoints: {ckpt}")
    if eng.base_weights_present():
        print(f"{MODEL} is already here — nothing to do.")
        return 0
    if args.check:
        print(f"{MODEL} is NOT installed. Run this without --check to download it.")
        return 1

    ok, reason = eng.available(check_vram=False)
    if not ok:
        print(f"ACE-Step itself is not installed yet: {reason}")
        print("Install it from Studio (Rewrite Section -> Install ACE-Step) first.")
        return 2

    sys.path.insert(0, str(eng.ACE_ROOT / "repo"))
    from acestep.model_downloader import download_submodel                  # noqa: E402

    print(f"downloading {MODEL} (~4.5 GB) -> {ckpt}")
    ok, msg = download_submodel(MODEL, checkpoints_dir=ckpt)
    print(f"{'done' if ok else 'FAILED'}: {msg}")
    if ok and not eng.base_weights_present():
        print("The download reported success but no .safetensors landed — check the folder.")
        return 1
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
