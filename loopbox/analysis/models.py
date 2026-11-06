"""Lazily loaded neural models, kept resident between tracks. Each worker process
analyses one track at a time and holds its own copy; several processes share
the GPU. When the GPU is out of memory (it is shared with other services), a
track is separated on the CPU instead: slower, same result."""
import threading
import warnings

import numpy as np
import torch

from ..config import DEVICE, SAMPLE_RATE

_lock = threading.Lock()
_beat_tracker = None
_separator = None
_vocal_model = None


def device() -> str:
    return DEVICE if DEVICE != "cuda" or torch.cuda.is_available() else "cpu"


def beat_tracker():
    global _beat_tracker
    with _lock:
        if _beat_tracker is None:
            from beat_this.inference import Audio2Beats
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                _beat_tracker = Audio2Beats(checkpoint_path="final0", device=device(), dbn=False)
        return _beat_tracker


def separator():
    global _separator
    with _lock:
        if _separator is None:
            from demucs.pretrained import get_model
            model = get_model("htdemucs")
            model.to(device()).eval()
            _separator = model
        return _separator


def _oom(e: Exception) -> bool:
    return isinstance(e, torch.cuda.OutOfMemoryError) or "out of memory" in str(e)


class NoRoom(RuntimeError):
    """The GPU has no room for the vocal model now (it is shared): try later."""


def vocals(y: np.ndarray) -> np.ndarray:
    """The vocal stem of y (frames, 2), by BS-RoFormer (roformer.py), the
    model kept resident. On a machine with a GPU it runs there or not at all
    (NoRoom when the GPU is full: on the CPU it takes the better part of an
    hour per song); without one, on the CPU."""
    global _vocal_model
    from . import roformer
    dev = device()
    with _lock:
        if _vocal_model is None:
            _vocal_model = roformer.load("cpu")
        model = _vocal_model
    if dev != "cuda":
        return _run_vocals(roformer, model, y, "cpu")
    try:
        model.to(dev)
        return roformer.separate(model, y, dev)
    except RuntimeError as e:
        if not _oom(e):
            raise
        model.cpu()
        raise NoRoom("no room on the GPU for the vocal model") from e
    finally:
        torch.cuda.empty_cache()


def _run_vocals(roformer, model, y: np.ndarray, on: str) -> np.ndarray:
    if on != "cpu":
        return roformer.separate(model, y, on)
    # On the CPU it is long: more threads than a worker usually takes.
    keep = torch.get_num_threads()
    torch.set_num_threads(max(keep, 8))
    try:
        return roformer.separate(model, y, "cpu")
    finally:
        torch.set_num_threads(keep)


def separate(y: np.ndarray, keep_stereo: tuple[str, ...] = ()) -> tuple[np.ndarray, list[str], dict]:
    """y: (frames, 2) float32 at SAMPLE_RATE. Returns stems (4, frames) mono,
    their names, and the stems named in keep_stereo as (frames, 2) arrays,
    sample-aligned with y (the player mixes them against the full track)."""
    from demucs.apply import apply_model
    model = separator()
    assert model.samplerate == SAMPLE_RATE
    wav = torch.from_numpy(np.ascontiguousarray(y.T))
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    dev = device()
    try:
        with torch.no_grad():
            out = apply_model(model, ((wav - mean) / std)[None].to(dev), device=dev,
                              split=True, overlap=0.1, progress=False)[0]
    except torch.cuda.OutOfMemoryError:
        torch.cuda.empty_cache()
        with torch.no_grad():
            out = apply_model(model.cpu(), ((wav - mean) / std)[None], device="cpu",
                              split=True, overlap=0.1, progress=False)[0]
        model.to(dev)
    full = (out * std + mean).cpu().numpy()  # (sources, channels, frames)
    names = list(model.sources)
    stereo = {s: np.ascontiguousarray(full[names.index(s)].T.astype(np.float32)) for s in keep_stereo}
    if dev == "cuda":
        torch.cuda.empty_cache()
    return full.mean(1), names, stereo
