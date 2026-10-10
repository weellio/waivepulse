"""ACE-Step 1.5 worker — runs in its OWN interpreter, never inside the WAIvePulse process.

WAIvePulse's main venv (F:\\HeartMuLa\\venv) is pinned to a torch/numba combination that
the whole app depends on. ACE-Step 1.5 needs torch 2.7.1+cu128 and Python >= 3.11, which
would break it. So ACE-Step lives in a separate venv (G:\\acestep\\venv) and we talk to it
the boring way: a JSON job file in, newline-delimited JSON events out on stdout, the GPU
released when the process exits.

Invoked as:  <ace_venv_python> acestep_worker.py <job.json>

Job JSON keys (all paths absolute):
    task         "probe" | "download" | "repaint" | "cover" | "generate"
                 | "layer" | "accompany" | "isolate"   (base-checkpoint only)
    repo         ACE-Step checkout root (added to sys.path, used as project_root)
    checkpoints  checkpoints directory (ACESTEP_CHECKPOINTS_DIR)
    out_dir      where generated audio is written
    src_audio    source song (repaint / cover)
    start_s/end_s  repaint window, seconds
    caption      style description handed to the model (NOT an instruction — see below)
    lyrics       lyrics for the regenerated span ("" = let the model decide)
    strength     0..1, mapped onto audio_cover_strength
    seconds      target length for a from-scratch generate
    ref_audio    optional reference clip for style
    seed, steps  optional overrides
    instruction  base tasks only: the literal instruction string (see BASE_TASKS)
    dit_model    checkpoint name; base tasks need "acestep-v15-base"
    bpm / keyscale / timesignature   pin the output to a known tempo and key

Events on stdout, one JSON object per line:
    {"ev":"log","msg":"..."}                  progress for the UI
    {"ev":"result", ...}                      exactly once on success
    {"ev":"error","msg":"...","trace":"..."}  exactly once on failure

Anything the worker prints that is not valid JSON is treated as a log line by the caller,
so library chatter (loguru, tqdm) is harmless.
"""

import json
import os
import sys
import time
import traceback


def emit(ev, **kw):
    try:
        sys.stdout.write(json.dumps({"ev": ev, **kw}, default=str) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def log(msg):
    emit("log", msg=str(msg))


# ── Repaint is PROMPT-CONDITIONED, not instruction-following ──────────────────
# ACE-Step regenerates the masked span from a *description* of the desired result.
# It has no notion of "the chorus" and it does not transform what is already there.
# The caller is responsible for turning a user instruction ("make the chorus a gospel
# choir") into a description ("gospel choir, Hammond organ, big room reverb") before
# it gets here. This worker passes `caption` through untouched.


def _setup(job):
    repo = job["repo"]
    if repo not in sys.path:
        sys.path.insert(0, repo)
    os.environ["ACESTEP_CHECKPOINTS_DIR"] = job["checkpoints"]
    # Keep HF's own cache off C: even if the parent forgot to set it.
    os.environ.setdefault("HF_HOME", job.get("hf_home") or os.path.join(job["checkpoints"], "_hf"))
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    return repo


def task_probe(job):
    repo = _setup(job)
    out = {"repo": repo, "python": sys.version.split()[0]}
    try:
        import torch
        out["torch"] = torch.__version__
        out["cuda_available"] = bool(torch.cuda.is_available())
        if out["cuda_available"]:
            out["gpu"] = torch.cuda.get_device_name(0)
            free, total = torch.cuda.mem_get_info(0)
            out["vram_free_mb"] = round(free / 1048576)
            out["vram_total_mb"] = round(total / 1048576)
    except Exception as e:
        out["torch_error"] = f"{type(e).__name__}: {e}"
    try:
        from acestep.model_downloader import check_main_model_exists
        out["weights"] = bool(check_main_model_exists(job["checkpoints"]))
    except Exception as e:
        out["acestep_import_error"] = f"{type(e).__name__}: {e}"
    emit("result", **out)


def task_download(job):
    _setup(job)
    from acestep.model_downloader import check_main_model_exists, download_main_model

    if check_main_model_exists(job["checkpoints"]):
        log("Model weights are already on disk.")
        emit("result", downloaded=False, checkpoints=job["checkpoints"])
        return
    log("Downloading ACE-Step 1.5 weights (DiT 2B + VAE + text encoder + 5Hz LM).")
    log("This is a one-time ~9.4 GB download. Leave it running.")
    ok, msg = download_main_model(checkpoints_dir=job["checkpoints"])
    log(msg)
    if not ok:
        raise RuntimeError(f"Weight download failed: {msg}")
    emit("result", downloaded=True, checkpoints=job["checkpoints"])


def _init_handler(job):
    import torch
    from acestep.handler import AceStepHandler

    repo = job["repo"]
    if not torch.cuda.is_available():
        raise RuntimeError(
            "No CUDA GPU visible to the ACE-Step venv. ACE-Step needs the GPU; "
            "CPU-only generation would take hours."
        )
    free, total = torch.cuda.mem_get_info(0)
    log(f"GPU: {torch.cuda.get_device_name(0)} — {free // 1048576} MB free of {total // 1048576} MB")
    need_mb = int(os.environ.get("WP_ACESTEP_MIN_VRAM_MB") or 9200)
    if free < need_mb * 1048576:
        raise RuntimeError(
            f"Only {free // 1048576} MB of VRAM is free; ACE-Step needs about {need_mb} MB. "
            "Close whatever else is using the card (Ollama model, a Demucs separation, "
            "cover-art generation) and try again."
        )

    log("Loading ACE-Step 1.5 (2B DiT + VAE + text encoder)…")
    t0 = time.time()
    handler = AceStepHandler()
    # Tier 5 (12 GB) settings, minus the 5Hz LM: repaint/cover/extract skip the LM
    # entirely (acestep/inference.py: skip_lm_tasks), which frees ~3.5 GB, so the 2B
    # DiT fits on the GPU in bf16 without quantisation or torch.compile. Offloading
    # the VAE and text encoder to CPU between phases is still worth it on a 3060 that
    # is shared with the rest of WAIvePulse.
    handler.initialize_service(
        project_root=job["repo"],
        config_path=job.get("dit_model") or "acestep-v15-turbo",
        device="cuda",
        use_flash_attention=False,
        compile_model=False,
        offload_to_cpu=True,
        offload_dit_to_cpu=False,
        quantization=None,
    )
    log(f"Model ready in {time.time() - t0:.1f}s")
    return handler, repo


# The three base-only tasks, in the words the app uses for them. ACE-Step reads `instruction`
# literally and the phrasing is part of the conditioning, so the templates are the ones from
# the official docs (guides/INFERENCE.md) rather than something rewritten to read nicely.
TRACK_NAMES = ("vocals", "backing_vocals", "drums", "bass", "guitar", "keyboard",
               "percussion", "strings", "synth", "fx", "brass", "woodwinds")

BASE_TASKS = {
    # add ONE named instrument that plays along with what is already there
    "layer":    {"task_type": "lego",
                 "verb": "Adding a layer",
                 "template": "Generate the {track} track based on the audio context:"},
    # fill in a backing band behind a partial track (a bare vocal, say)
    "accompany": {"task_type": "complete",
                  "verb": "Building a backing track",
                  "template": "Complete the input track with {track}:"},
    # pull one instrument out of a finished mix
    "isolate":  {"task_type": "extract",
                 "verb": "Isolating a track",
                 "template": "Extract the {track} track from the audio:"},
}


def _musical_metadata(job):
    """bpm / keyscale / timesignature, when the caller knows them.

    These are NOT just prompt decoration for the language model: inference.py puts them into
    dit_generate_kwargs (the "bpm"/"key_scale"/"time_signature" keys), so they condition the
    DiT directly and still apply on repaint, where the LM is skipped entirely. They reach the
    model as a plain text block built by core/generation/handler/metadata_utils.py:

        - bpm: 128
        - timesignature: 4/4
        - keyscale: C major

    so free-form strings like "C major" are exactly right. Anything omitted is sent as N/A.

    The field names are `keyscale` and `timesignature`, with no underscore. GenerationParams is
    a dataclass, so the underscored spellings used elsewhere in ACE-Step's own internals would
    raise TypeError here rather than being quietly ignored.
    """
    out = {}
    bpm = job.get("bpm")
    try:
        if bpm and 30 <= int(bpm) <= 300:          # the documented range
            out["bpm"] = int(bpm)
    except (TypeError, ValueError):
        pass
    key = (job.get("keyscale") or "").strip()
    if key:
        out["keyscale"] = key[:32]
    ts = (job.get("timesignature") or "").strip()
    if ts:
        out["timesignature"] = ts[:16]
    return out


def _common_params(job):
    """Turbo-model parameter block shared by every generation task."""
    return dict(
        caption=(job.get("caption") or "").strip()[:512],
        lyrics=(job.get("lyrics") or "")[:4096],
        inference_steps=int(job.get("steps") or 8),
        # The turbo checkpoint bakes guidance into distillation; the pipeline
        # force-corrects guidance_scale to 1.0 but does NOT correct shift, and
        # 3.0 is the documented turbo value.
        shift=float(job.get("shift") or 3.0),
        seed=int(job.get("seed", -1)),
        # No LM: repaint/cover skip it, and asking for CoT with llm_handler=None
        # just logs noise.
        thinking=False,
        use_cot_metas=False,
        use_cot_caption=False,
        use_cot_language=False,
        enable_normalization=False,  # we splice into the user's mix; do not re-gain it
    )


def task_generate(job):
    repo = _setup(job)
    import torch
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    handler = None
    try:
        handler, repo = _init_handler(job)
        task = job["task"]
        kw = _common_params(job)
        kw.update(_musical_metadata(job))   # pin tempo/key when the caller knows them
        strength = float(job.get("strength", 0.6))
        strength = min(1.0, max(0.0, strength))

        if task == "repaint":
            start_s = float(job["start_s"])
            end_s = float(job["end_s"])
            kw.update(
                task_type="repaint",
                src_audio=job["src_audio"],
                repainting_start=start_s,
                repainting_end=end_s,
                # MANDATORY. With the default "auto" the chunk mask is overwritten with
                # 2.0 (acestep/core/generation/handler/conditioning_masks.py) and the
                # model regenerates the WHOLE song — this is the cause of upstream
                # issue #646, which only affects the Gradio path because Gradio is the
                # only caller that forgets to set this.
                chunk_mask_mode="explicit",
                # "conservative" keeps more of the source; strength 1.0 = conservative.
                repaint_mode="conservative",
                repaint_strength=strength,
                repaint_latent_crossfade_frames=int(job.get("latent_crossfade_frames") or 10),
                repaint_wav_crossfade_sec=float(job.get("wav_crossfade_sec") or 0.25),
                audio_cover_strength=1.0,
            )
            log(f"Repainting {start_s:.2f}s – {end_s:.2f}s (explicit chunk mask, conservative)")
        elif task == "cover":
            kw.update(
                task_type="cover",
                src_audio=job["src_audio"],
                audio_cover_strength=strength,
            )
            log(f"Covering the whole song (strength {strength:.2f})")
        elif task in BASE_TASKS:
            # lego / complete / extract exist only in the BASE checkpoint — the turbo one
            # has no weights for them. The caller must therefore have asked for
            # dit_model="acestep-v15-base", and base is not distilled, so the turbo
            # settings in _common_params are wrong for it: guidance is real here (turbo
            # forces it to 1.0) and 8 steps is far too few. Docs: base 32-64 steps,
            # guidance 7.0-9.0, shift 3.0.
            spec = BASE_TASKS[task]
            kw.update(
                task_type=spec["task_type"],
                src_audio=job["src_audio"],
                instruction=job["instruction"],
                inference_steps=int(job.get("steps") or 32),
                guidance_scale=float(job.get("guidance_scale") or 7.0),
                repainting_start=float(job.get("start_s") or 0.0),
                repainting_end=float(job.get("end_s") if job.get("end_s") is not None else -1),
                # _common_params turns normalisation OFF because a repaint is spliced into
                # the user's own mix and must not be re-gained. These jobs are the opposite:
                # the result is a standalone part that lands on its own mixer fader, and the
                # model's raw level is all over the place — a strings pad came back at
                # -39.6 dBFS, quiet enough to look like a failed render. Normalise to -6 so
                # it arrives audible, with headroom left for summing.
                enable_normalization=True,
                normalization_db=-6.0,
            )
            log(f"{spec['verb']}: {job['instruction']}")
            log(f"Base model, {kw['inference_steps']} steps at guidance {kw['guidance_scale']}")
        else:
            secs = float(job.get("seconds") or 30)
            kw.update(
                task_type="text2music",
                duration=secs,
                reference_audio=job.get("ref_audio") or None,
            )
            log(f"Generating {secs:.0f}s from scratch"
                + (" with a reference clip" if job.get("ref_audio") else ""))

        if job.get("ref_audio") and task in ("repaint", "cover"):
            kw["reference_audio"] = job["ref_audio"]
            log("Using the reference clip for style")

        params = GenerationParams(**kw)
        config = GenerationConfig(
            batch_size=1,
            use_random_seed=int(job.get("seed", -1)) < 0,
            seeds=None if int(job.get("seed", -1)) < 0 else [int(job["seed"])],
            audio_format="wav",
        )

        torch.cuda.reset_peak_memory_stats()
        t0 = time.time()
        result = generate_music(handler, None, params, config, save_dir=job["out_dir"])
        wall = time.time() - t0

        if not getattr(result, "success", False):
            raise RuntimeError(getattr(result, "error", None) or getattr(result, "status_message", "generation failed"))
        audios = getattr(result, "audios", None) or []
        paths = [a.get("path") for a in audios if a.get("path")]
        if not paths:
            raise RuntimeError("ACE-Step reported success but wrote no audio file")

        peak_alloc = torch.cuda.max_memory_allocated() / 1048576
        peak_res = torch.cuda.max_memory_reserved() / 1048576
        emit(
            "result",
            path=paths[0],
            all_paths=paths,
            seed=(audios[0].get("params") or {}).get("seed"),
            wall_s=round(wall, 2),
            peak_alloc_mb=round(peak_alloc),
            peak_reserved_mb=round(peak_res),
            time_costs=(getattr(result, "extra_outputs", None) or {}).get("time_costs"),
            status=getattr(result, "status_message", ""),
        )
    finally:
        # Drop every GPU reference we hold before the interpreter exits, so a crash in
        # the caller cannot leave 5 GB pinned on a 12 GB card.
        try:
            if handler is not None:
                for attr in ("dit", "transformer", "vae", "text_encoder", "ace_step_transformer",
                             "pipeline", "lm", "llm"):
                    if hasattr(handler, attr):
                        try:
                            setattr(handler, attr, None)
                        except Exception:
                            pass
            del handler
            import gc
            gc.collect()
            import torch as _t
            if _t.cuda.is_available():
                _t.cuda.empty_cache()
                _t.cuda.ipc_collect()
        except Exception:
            pass


TASKS = {
    "probe": task_probe,
    "download": task_download,
    "repaint": task_generate,
    "cover": task_generate,
    "generate": task_generate,
    # base-checkpoint multi-track jobs; all three run through task_generate
    **{name: task_generate for name in BASE_TASKS},
}


def main():
    if len(sys.argv) < 2:
        emit("error", msg="usage: acestep_worker.py <job.json>")
        return 2
    try:
        with open(sys.argv[1], "r", encoding="utf-8") as fh:
            job = json.load(fh)
    except Exception as e:
        emit("error", msg=f"could not read the job file: {e}")
        return 2
    fn = TASKS.get(job.get("task"))
    if fn is None:
        emit("error", msg=f"unknown task {job.get('task')!r}")
        return 2
    try:
        fn(job)
        return 0
    except Exception as e:
        emit("error", msg=f"{type(e).__name__}: {e}", trace=traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.exit(main())
