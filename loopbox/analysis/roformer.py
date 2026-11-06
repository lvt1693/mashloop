"""Vocal separation with BS-RoFormer (band-split RoPE transformer, Lu et al.
2023), the ViperX checkpoint "ep_317_sdr_12.9755": vocal SDR about 12.9 dB on
MUSDB18, against about 8.5 for HTDemucs. Used for the vocal stem the player
hands over and the mashups sing with (mix minus it is their instrumental);
HTDemucs still gives the four stems the analysis reads.

The model is ZFTurbo's implementation (Music-Source-Separation-Training,
models/bs_roformer, MIT licence, Copyright (c) 2024 Roman Solovyev), cut down
to inference: no training losses, no linear attention, no checkpointing.
Audio goes through in 8 s chunks, four to a window, cross-faded."""
from functools import partial
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from einops import pack, rearrange, unpack
from rotary_embedding_torch import RotaryEmbedding
from torch import nn

from ..config import DATA_DIR, SAMPLE_RATE, STEMS_MODEL

CHECKPOINT = DATA_DIR / "models" / "bs_roformer_viperx_1297.ckpt"
URL = ("https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/"
       "model_bs_roformer_ep_317_sdr_12.9755.ckpt")
NAME = STEMS_MODEL  # what a song's meta records as its stem's model
CHUNK = 352800  # 8 s at 44.1 kHz, as trained
OVERLAP = 4
FREQS_PER_BANDS = (2,) * 24 + (4,) * 12 + (12,) * 8 + (24,) * 8 + (48,) * 8 + (128, 129)
CONFIG = dict(dim=512, depth=12, stereo=True, num_stems=1, time_transformer_depth=1, freq_transformer_depth=1,
              freqs_per_bands=FREQS_PER_BANDS, dim_head=64, heads=8, stft_n_fft=2048, stft_hop_length=441,
              stft_win_length=2048, mask_estimator_depth=2)


class RMSNorm(nn.Module):
    def __init__(self, dim):
        super().__init__()
        self.scale = dim ** 0.5
        self.gamma = nn.Parameter(torch.ones(dim))

    def forward(self, x):
        return F.normalize(x, dim=-1) * self.scale * self.gamma


class FeedForward(nn.Module):
    def __init__(self, dim, mult=4):
        super().__init__()
        inner = int(dim * mult)
        self.net = nn.Sequential(RMSNorm(dim), nn.Linear(dim, inner), nn.GELU(), nn.Dropout(0.0),
                                 nn.Linear(inner, dim), nn.Dropout(0.0))

    def forward(self, x):
        return self.net(x)


class Attention(nn.Module):
    def __init__(self, dim, heads, dim_head, rotary_embed):
        super().__init__()
        self.heads = heads
        self.rotary_embed = rotary_embed
        inner = heads * dim_head
        self.norm = RMSNorm(dim)
        self.to_qkv = nn.Linear(dim, inner * 3, bias=False)
        self.to_gates = nn.Linear(dim, heads)
        self.to_out = nn.Sequential(nn.Linear(inner, dim, bias=False), nn.Dropout(0.0))

    def forward(self, x):
        x = self.norm(x)
        q, k, v = rearrange(self.to_qkv(x), "b n (qkv h d) -> qkv b h n d", qkv=3, h=self.heads)
        q = self.rotary_embed.rotate_queries_or_keys(q)
        k = self.rotary_embed.rotate_queries_or_keys(k)
        out = F.scaled_dot_product_attention(q, k, v)
        out = out * rearrange(self.to_gates(x), "b n h -> b h n 1").sigmoid()
        return self.to_out(rearrange(out, "b h n d -> b n (h d)"))


class Transformer(nn.Module):
    def __init__(self, dim, depth, heads, dim_head, rotary_embed):
        super().__init__()
        self.layers = nn.ModuleList([nn.ModuleList([Attention(dim, heads, dim_head, rotary_embed), FeedForward(dim)])
                                     for _ in range(depth)])
        self.norm = nn.Identity()

    def forward(self, x):
        for attn, ff in self.layers:
            x = attn(x) + x
            x = ff(x) + x
        return self.norm(x)


class BandSplit(nn.Module):
    def __init__(self, dim, dim_inputs):
        super().__init__()
        self.dim_inputs = dim_inputs
        self.to_features = nn.ModuleList([nn.Sequential(RMSNorm(d), nn.Linear(d, dim)) for d in dim_inputs])

    def forward(self, x):
        return torch.stack([f(s) for s, f in zip(x.split(self.dim_inputs, dim=-1), self.to_features)], dim=-2)


def _mlp(dim_in, dim_out, dim_hidden, depth):
    dims = (dim_in, *((dim_hidden,) * (depth - 1)), dim_out)
    net = []
    for i, (a, b) in enumerate(zip(dims[:-1], dims[1:])):
        net.append(nn.Linear(a, b))
        if i < len(dims) - 2:
            net.append(nn.Tanh())
    return nn.Sequential(*net)


class MaskEstimator(nn.Module):
    def __init__(self, dim, dim_inputs, depth, expansion=4):
        super().__init__()
        self.to_freqs = nn.ModuleList([nn.Sequential(_mlp(dim, d * 2, dim * expansion, depth), nn.GLU(dim=-1))
                                       for d in dim_inputs])

    def forward(self, x):
        return torch.cat([mlp(band) for band, mlp in zip(x.unbind(dim=-2), self.to_freqs)], dim=-1)


class BSRoformer(nn.Module):
    def __init__(self, dim, *, depth, stereo, num_stems, time_transformer_depth, freq_transformer_depth,
                 freqs_per_bands, dim_head, heads, stft_n_fft, stft_hop_length, stft_win_length,
                 mask_estimator_depth):
        super().__init__()
        self.channels = 2 if stereo else 1
        time_rot, freq_rot = RotaryEmbedding(dim=dim_head), RotaryEmbedding(dim=dim_head)
        self.layers = nn.ModuleList([nn.ModuleList([
            Transformer(dim, time_transformer_depth, heads, dim_head, time_rot),
            Transformer(dim, freq_transformer_depth, heads, dim_head, freq_rot)]) for _ in range(depth)])
        self.final_norm = RMSNorm(dim)
        self.stft_kwargs = dict(n_fft=stft_n_fft, hop_length=stft_hop_length, win_length=stft_win_length,
                                normalized=False)
        self.window = partial(torch.hann_window, stft_win_length)
        dims = tuple(2 * f * self.channels for f in freqs_per_bands)
        self.band_split = BandSplit(dim, dims)
        self.mask_estimators = nn.ModuleList([MaskEstimator(dim, dims, mask_estimator_depth)
                                              for _ in range(num_stems)])

    def forward(self, audio):
        """audio (b, channels, t) -> the target stem (b, channels, t)."""
        window = self.window(device=audio.device)
        x, shape = pack([audio], "* t")
        spec = torch.view_as_real(torch.stft(x.float(), **self.stft_kwargs, window=window, return_complex=True))
        spec = unpack(spec, shape, "* f t c")[0]
        spec = rearrange(spec, "b s f t c -> b (f s) t c")
        x = self.band_split(rearrange(spec, "b f t c -> b t (f c)"))
        for time_tf, freq_tf in self.layers:
            x = rearrange(x, "b t f d -> b f t d")
            x, ps = pack([x], "* t d")
            x = unpack(time_tf(x), ps, "* t d")[0]
            x = rearrange(x, "b f t d -> b t f d")
            x, ps = pack([x], "* f d")
            x = unpack(freq_tf(x), ps, "* f d")[0]
        x = self.final_norm(x)
        mask = rearrange(self.mask_estimators[0](x).float(), "b t (f c) -> b f t c", c=2)
        out = torch.view_as_complex(spec.contiguous()) * torch.view_as_complex(mask.contiguous())
        out = rearrange(out, "b (f s) t -> (b s) f t", s=self.channels)
        out[:, 0] = 0.0  # no DC
        y = torch.istft(out, **self.stft_kwargs, window=window, return_complex=False, length=audio.shape[-1])
        return rearrange(y, "(b s) t -> b s t", s=self.channels)


def ensure_checkpoint() -> Path:
    if not CHECKPOINT.exists():
        import urllib.request
        CHECKPOINT.parent.mkdir(parents=True, exist_ok=True)
        tmp = CHECKPOINT.with_suffix(".part")
        urllib.request.urlretrieve(URL, tmp)
        tmp.replace(CHECKPOINT)
    return CHECKPOINT


def load(device: str) -> BSRoformer:
    model = BSRoformer(**CONFIG)
    state = torch.load(ensure_checkpoint(), map_location="cpu", weights_only=True)
    state = state.get("state_dict", state)
    missing, unexpected = model.load_state_dict(state, strict=False)
    # The rotary frequencies are fixed by their size; nothing else may differ.
    bad = [k for k in [*missing, *unexpected] if not k.endswith("freqs")]
    if bad:
        raise RuntimeError(f"BS-RoFormer checkpoint does not fit the model: {bad[:5]}")
    model.eval()
    return model.to(device)


@torch.no_grad()
def separate(model: BSRoformer, y: np.ndarray, device: str) -> np.ndarray:
    """y (frames, 2) float32 at 44.1 kHz -> the vocal stem, same shape."""
    assert SAMPLE_RATE == 44100
    x = torch.from_numpy(np.ascontiguousarray(y.T, dtype=np.float32))
    n = x.shape[1]
    step = CHUNK // OVERLAP
    pad = CHUNK - step
    xp = F.pad(x, (pad, pad + CHUNK), mode="constant")
    out = torch.zeros_like(xp)
    weight = torch.zeros(xp.shape[1])
    # A window that rises and falls over the chunk's edges, flat in its middle.
    fade = CHUNK // 10
    win = torch.ones(CHUNK)
    win[:fade] = torch.linspace(0, 1, fade)
    win[-fade:] = torch.linspace(1, 0, fade)
    # Mixed precision as it was trained (all fp16 overflows into NaN).
    amp = torch.autocast("cuda", dtype=torch.float16, enabled=device == "cuda")
    for s in range(0, n + pad, step):
        piece = xp[:, s:s + CHUNK]
        if piece.shape[1] < CHUNK:
            piece = F.pad(piece, (0, CHUNK - piece.shape[1]))
        with amp:
            res = model(piece[None].to(device))[0].float().cpu()
        out[:, s:s + CHUNK] += res * win
        weight[s:s + CHUNK] += win
    out = out / weight.clamp(min=1e-3)
    return out[:, pad:pad + n].T.contiguous().numpy().astype(np.float32)
