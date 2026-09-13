#!/usr/bin/env python3
"""
Generates the game's sound effects with Stable Audio 3 (small-sfx model) and
writes them into public/sfx/, where the game can fetch them at runtime.

Notes learned the hard way:
- Sub-second generation is unreliable (not enough diffusion "room" to form
  real transient structure -> comes out as loud broadband noise). Each
  sound's "duration" in prompts.json is generated directly (not trimmed
  down from something longer) - keep it >=1s.
- Prompts should read like natural descriptions of a real/game sound
  ("cartoon explosion boom, retro arcade video game sound effect"), not
  synthesizer jargon ("square wave, 220Hz to 60Hz sawtooth") - the model
  responds much better to the former.
- cfg_scale must stay at the model's default of 1.0. This is an 8-step
  distilled model calibrated for it; raising cfg_scale for "better prompt
  adherence" causes saturation/noise instead - do not bump this.

Usage:
  uv run python generate.py             # generate all sounds
  uv run python generate.py --only jump # regenerate one
  uv run python generate.py --force     # overwrite existing files
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

TOOLS_DIR = Path(__file__).resolve().parent
OUTPUT_DIR = TOOLS_DIR.parent.parent / "public" / "sfx"
PROMPTS_FILE = TOOLS_DIR / "prompts.json"

SAMPLE_RATE = 44100
# This is an 8-step distilled model calibrated for cfg_scale=1.0 (its default).
# Raising cfg_scale without also raising steps causes saturation/noise - do not "improve"
# prompt adherence by bumping this, it was tried and breaks the output.
CFG_SCALE = 1.0
STEPS = 8


def normalize(audio):
    """Peak-normalize only - no trimming, the raw generation is used as-is."""
    peak = np.max(np.abs(audio))
    if peak > 1e-6:
        audio = audio * (0.85 / peak)
    return audio


def trim_to_onset(audio, sr, max_duration, fade_out=0.02):
    """For percussive one-shots (gunshot, bullet impact) where the model's
    minimum reliable duration (1s) is much longer than the actual sound -
    cut from the onset transient down to max_duration, with a short fade-out
    so the cut isn't a click."""
    mono = audio.mean(axis=0)
    win = max(1, int(0.005 * sr))
    n_windows = max(1, (len(mono) - win) // win)
    env = np.array([
        np.sqrt(np.mean(mono[i * win:i * win + win] ** 2))
        for i in range(n_windows)
    ])
    peak_env = max(env.max(), 1e-6)
    onset_idx = next((i for i, e in enumerate(env) if e >= 0.1 * peak_env), 0)
    onset_sample = max(0, onset_idx * win - int(0.01 * sr))

    end_sample = min(audio.shape[1], onset_sample + int(max_duration * sr))
    trimmed = audio[:, onset_sample:end_sample].copy()

    n = trimmed.shape[1]
    fo = min(int(fade_out * sr), n // 4)
    if fo > 0:
        envelope = np.ones(n)
        envelope[-fo:] *= np.linspace(1, 0, fo)
        trimmed *= envelope[None, :]
    return trimmed


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--only", help="generate a single sound by name")
    parser.add_argument("--force", action="store_true", help="overwrite existing files")
    parser.add_argument("--model", default="small-sfx", help="model id (default: small-sfx)")
    args = parser.parse_args()

    prompts = json.loads(PROMPTS_FILE.read_text())
    if args.only:
        if args.only not in prompts:
            sys.exit(f"unknown sound '{args.only}', options: {', '.join(prompts)}")
        prompts = {args.only: prompts[args.only]}

    pending = {
        name: spec for name, spec in prompts.items()
        if args.force or not (OUTPUT_DIR / f"{name}.wav").exists()
    }
    if not pending:
        print("Nothing to do (all files exist, use --force to regenerate).")
        return

    from stable_audio_3 import StableAudioModel
    print(f"Loading model '{args.model}'...")
    model = StableAudioModel.from_pretrained(args.model)

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    for name, spec in pending.items():
        duration = spec["duration"]
        print(f"[gen]  {name}: {spec['prompt']!r} ({duration:.1f}s)")

        audio = model.generate(
            prompt=spec["prompt"],
            duration=duration,
            steps=STEPS,
            cfg_scale=CFG_SCALE,
        )
        arr = audio.float().cpu().numpy()[0]  # (channels, samples)
        arr = normalize(arr)
        if "trim" in spec:
            arr = trim_to_onset(arr, SAMPLE_RATE, spec["trim"])

        out_path = OUTPUT_DIR / f"{name}.wav"
        sf.write(out_path, arr.T, SAMPLE_RATE, subtype="PCM_16")
        print(f"       -> {out_path.name} ({arr.shape[1] / SAMPLE_RATE:.2f}s)")

    print(f"\nDone. Files written to {OUTPUT_DIR}")


if __name__ == "__main__":
    main()
