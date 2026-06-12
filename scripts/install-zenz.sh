#!/usr/bin/env bash
# zenz-v3.1-small（GGUF, CC-BY-SA 4.0）を Hugging Face から取得する。
# zakki はこのモデルを再配布せず、各自がここで取得する（docs/FEATURES.md §変換エンジン）。
set -euo pipefail

DEST_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/zakki/models"
DEST="${DEST_DIR}/zenz-v3.1-small-Q5_K_M.gguf"
URL="https://huggingface.co/Miwa-Keita/zenz-v3.1-small-gguf/resolve/main/ggml-model-Q5_K_M.gguf"

if [ -f "$DEST" ]; then
  echo "already installed: $DEST"
  exit 0
fi
mkdir -p "$DEST_DIR"
echo "downloading zenz-v3.1-small (about 74MB) ..."
curl -fL -o "${DEST}.tmp" "$URL"
mv "${DEST}.tmp" "$DEST"
echo "installed: $DEST"
