"""Train a LoKr adapter on your own songs, from the library you already have.

ACE-Step's own tutorial describes the hard part of this as data preparation: for every song
you need the audio, accurate lyrics, a caption, and measured BPM and key — and it tells you
to go and fetch BPM/key from an external website because asking a language model for them
produces hallucinations.

WAIvePulse already has all of it. Every generated song carries the lyrics that produced it,
the tag string that described it, and the BPM and key app.py measured when it finished. So
the annotation step that the tutorial spends half its length on is a file-format conversion
here, and the user picks songs and presses a button.

WHY LoKr AND NOT LoRA
---------------------
The tutorial's own recommendation for consumer cards: "LoKR has greatly improved training
efficiency. What used to take an hour now only takes 5 minutes — over 10 times faster. This
is crucial for training on consumer-grade GPUs." The hardware table asks for 16 GB minimum
for LoRA; this machine has 12 GB, so LoRA is out and LoKr plus gradient checkpointing is the
only configuration with a chance.

NOTHING HERE TOUCHES THE GPU
----------------------------
This module only builds the dataset. Preprocessing and training run in the ACE-Step venv
through engines/acestep.py's worker, the same way generation does.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional

# Audio ACE-Step's scanner recognises.
AUDIO_OK = {".mp3", ".wav", ".flac", ".ogg", ".opus"}

# Below this a LoKr has almost nothing to learn a style from. The tutorial's own smallest
# worked example is 10-20 songs, and its demo album is 13 tracks.
MIN_SONGS = 4
SUGGESTED_SONGS = 10


def _safe_stem(title: str, job_id: str) -> str:
    """A filename that is readable, unique, and free of anything a shell or path would eat."""
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", (title or "song").strip())[:48].strip("_.")
    return f"{base or 'song'}_{job_id}"


def _language_of(lyrics: str) -> Optional[str]:
    """'en' only when the lyrics really look like plain ASCII English.

    The alternative is to stamp "en" on everything, which would be a guess written into the
    training data. Anything with substantial non-ASCII is left unset and ACE-Step decides.
    """
    text = (lyrics or "").strip()
    if not text:
        return None
    letters = [c for c in text if c.isalpha()]
    if not letters:
        return None
    ascii_share = sum(c.isascii() for c in letters) / len(letters)
    return "en" if ascii_share > 0.95 else None


def _strip_markers(lyrics: str) -> str:
    """Keep the [Verse] / [Chorus] markers — ACE-Step's scanner treats them as structure
    tags and the tutorial lists them as an optional improvement, not something to remove."""
    return (lyrics or "").strip()


def describe(rec: Dict[str, Any]) -> str:
    """The caption for one song.

    The tag string is what described the song to the generator in the first place, so it is
    the honest caption rather than something re-invented here. Title and artist are left out:
    they are not a description of the sound.
    """
    tags = (rec.get("tags") or "").strip()
    return re.sub(r"\s*,\s*", ", ", tags)[:512]


def plan(jobs: Dict[str, Any], job_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    """What a dataset built from these songs would contain, and what is missing from it.

    Separate from export() so the UI can show the user the problems before anything is
    written: a song with no lyrics, or no tags to caption it, trains badly and silently.
    """
    chosen = [j for j in (job_ids or list(jobs)) if j in jobs]
    usable, skipped = [], []
    for jid in chosen:
        rec = jobs[jid]
        title = rec.get("title") or jid
        if rec.get("status") != "done" or not rec.get("file"):
            skipped.append({"job_id": jid, "title": title, "why": "no finished audio"})
            continue
        caption = describe(rec)
        if not caption:
            skipped.append({"job_id": jid, "title": title,
                            "why": "no style tags, so there is nothing to caption it with"})
            continue
        instrumental = bool(rec.get("instrumental"))
        lyrics = _strip_markers(rec.get("lyrics") or "")
        if not instrumental and not lyrics:
            skipped.append({"job_id": jid, "title": title, "why": "no lyrics on record"})
            continue
        usable.append({
            "job_id": jid, "title": title, "caption": caption,
            "has_lyrics": bool(lyrics), "instrumental": instrumental,
            "bpm": rec.get("bpm"), "keyscale": rec.get("key"),
            "language": _language_of(lyrics),
        })

    missing_bpm = [u["title"] for u in usable if not u["bpm"]]
    missing_key = [u["title"] for u in usable if not u["keyscale"]]
    return {
        "usable": usable,
        "skipped": skipped,
        "count": len(usable),
        "enough": len(usable) >= MIN_SONGS,
        "min_songs": MIN_SONGS,
        "suggested_songs": SUGGESTED_SONGS,
        "missing_bpm": missing_bpm,
        "missing_key": missing_key,
        "notes": _notes(len(usable), missing_bpm, missing_key, before_export=True),
    }


def _notes(count: int, missing_bpm: List[str], missing_key: List[str],
           before_export: bool = False) -> List[str]:
    """`before_export` distinguishes the two moments this is called.

    Planning sees the job records, where most older songs have no tempo or key, and saying
    "these will be left out" there would be wrong: export measures them off the audio first.
    Only what is still missing AFTER that is genuinely absent from the training data.
    """
    out = []
    if count < MIN_SONGS:
        out.append(f"{count} songs is too few to learn a style from. {MIN_SONGS} is the floor "
                   f"and about {SUGGESTED_SONGS} works better.")
    elif count < SUGGESTED_SONGS:
        out.append(f"{count} songs will train, but the tutorial's own examples use 10 to 20. "
                   "Expect it to copy those songs more than it generalises.")
    if missing_bpm or missing_key:
        n = len(set(missing_bpm) | set(missing_key))
        if before_export:
            out.append(f"{n} song(s) have no tempo or key on record. Those get measured from "
                       "the audio when the training set is built, so nothing is guessed and "
                       "nothing is lost.")
        else:
            out.append(f"{n} song(s) ended up with no tempo or key even after measuring. "
                       "Those fields are left out rather than guessed — the model still "
                       "trains, it just gets less to go on for them.")
    return out


def measure_missing(path: Path):
    """Measure BPM and key off the audio when the job record has none.

    15 of the 18 songs in this library predate BPM/key detection, and the tutorial is
    explicit that absent values are better than invented ones — but *measured* values are
    better than either, and the same librosa code app.py runs after a generation works just
    as well after the fact. CPU only, about a second a song.

    Returns (bpm, keyscale), either of which may be None if librosa is unavailable.
    """
    import sys as _sys
    app = _sys.modules.get("app")
    if app is None or not hasattr(app, "_detect_bpm_key"):
        return None, None
    try:
        bpm, key = app._detect_bpm_key(str(path))
        return bpm, key
    except Exception:                                    # noqa: BLE001
        return None, None


def export(jobs: Dict[str, Any], outputs_dir: Path, dest: Path,
           job_ids: Optional[List[str]] = None, measure: bool = True) -> Dict[str, Any]:
    """Write a dataset ACE-Step's scanner can read.

        <dest>/<stem>.mp3          the audio, copied
        <dest>/<stem>.lyrics.txt   lyrics (omitted for an instrumental)
        <dest>/<stem>.json         caption / bpm / keyscale / timesignature / language

    Only fields we actually know are written. A missing BPM is left out of the JSON rather
    than filled with a plausible number, because the tutorial is explicit that invented
    BPM and key values are worse than absent ones.
    """
    p = plan(jobs, job_ids)
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=True)

    written = []
    for item in p["usable"]:
        rec = jobs[item["job_id"]]
        src = Path(outputs_dir) / Path(str(rec["file"]).replace("\\", "/")).name
        if not src.exists():
            item["why"] = "the audio file is gone from disk"
            p["skipped"].append(item)
            continue
        if src.suffix.lower() not in AUDIO_OK:
            item["why"] = f"{src.suffix} is not an audio type the scanner reads"
            p["skipped"].append(item)
            continue

        stem = _safe_stem(item["title"], item["job_id"])
        shutil.copy2(src, dest / f"{stem}{src.suffix.lower()}")

        # fill in anything the job record never captured, by measuring it
        if measure and (not item["bpm"] or not item["keyscale"]):
            bpm, key = measure_missing(src)
            item["bpm"] = item["bpm"] or bpm
            item["keyscale"] = item["keyscale"] or key
            item["measured"] = True

        if item["has_lyrics"]:
            (dest / f"{stem}.lyrics.txt").write_text(
                _strip_markers(rec.get("lyrics") or ""), encoding="utf-8")

        meta: Dict[str, Any] = {"caption": item["caption"]}
        if item["bpm"]:
            try:
                meta["bpm"] = int(item["bpm"])
            except (TypeError, ValueError):
                pass
        if item["keyscale"]:
            meta["keyscale"] = str(item["keyscale"])
        if item["language"]:
            meta["language"] = item["language"]
        # 4/4 is not measured anywhere in WAIvePulse, so it is not claimed here either.
        (dest / f"{stem}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
        written.append({"stem": stem, "title": item["title"], **meta,
                        "lyrics": item["has_lyrics"]})

    usable_ids = {u["job_id"] for u in p["usable"]}
    # recompute what is still missing AFTER measuring, so the notes describe the dataset
    # that was actually written rather than the records it came from
    still_no_bpm = [w["title"] for w in written if not w.get("bpm")]
    still_no_key = [w["title"] for w in written if not w.get("keyscale")]
    return {
        "dest": str(dest),
        "written": written,
        "count": len(written),
        "skipped": p["skipped"],
        "enough": len(written) >= MIN_SONGS,
        "measured": sum(1 for u in p["usable"] if u.get("measured")),
        "notes": _notes(len(written), still_no_bpm, still_no_key),
        "job_ids": sorted(usable_ids),
    }
