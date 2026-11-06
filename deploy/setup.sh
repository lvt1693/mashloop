#!/bin/bash
# Installs or updates Mash ∞ Loop on the box from /tmp/mashloop.tgz (made by
# deploy/pack.py). Safe to run again: data/, .venv/, bin/ and secrets/ (the
# YouTube cookies, put there by hand) are kept.
set -euo pipefail
APP=/root/truc_ai/mashloop
UV=${UV:-/root/.local/bin/uv}
# The torch the app is developed with. (Newer torch has no torchaudio, which
# Beat This needs for its mel spectrogram.)
TORCH_VERSION=${TORCH_VERSION:-2.6.0}
TORCH_INDEX=${TORCH_INDEX:-https://download.pytorch.org/whl/cu124}

mkdir -p "$APP/data" "$APP/bin" "$APP/secrets"
chmod 700 "$APP/secrets"
find "$APP" -mindepth 1 -maxdepth 1 ! -name data ! -name .venv ! -name bin ! -name secrets -exec rm -rf {} +
tar -xzf /tmp/mashloop.tgz -C "$APP"

[ -x "$APP/.venv/bin/python" ] || "$UV" venv "$APP/.venv" --python /usr/bin/python3.12
PY="$APP/.venv/bin/python"
if ! "$PY" -c "import torch, torchaudio" 2>/dev/null; then
    "$UV" pip install --python "$PY" "torch==$TORCH_VERSION" "torchaudio==$TORCH_VERSION" --index-url "$TORCH_INDEX"
fi
"$UV" pip install --python "$PY" -q -r "$APP/deploy/requirements-server.txt"
"$UV" pip install --python "$PY" -q --no-deps beat-this demucs

# Mashups are warped onto one tempo and key by Rubber Band (run as a program).
command -v rubberband >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q rubberband-cli

# yt-dlp solves YouTube's player challenges with a JS runtime.
if [ ! -x "$APP/bin/deno" ]; then
    curl -fsSL -o /tmp/deno.zip https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip
    unzip -o -q /tmp/deno.zip -d "$APP/bin"
    rm -f /tmp/deno.zip
fi
# The banners of deploy/ads, each once (one the admin deleted is not brought back).
(cd "$APP" && "$PY" -m loopbox.ads seed "$APP/deploy/ads")

install -m 644 "$APP/deploy/mashloop.service" /etc/systemd/system/mashloop.service
systemctl daemon-reload
systemctl enable mashloop >/dev/null 2>&1
systemctl restart mashloop
echo "mashloop: $(systemctl is-active mashloop)"
