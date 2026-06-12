#!/usr/bin/env bash
# zakki の Release から anco（Linux x64 自前ビルド）を導入する。
# ビルドの出自は .github/workflows/build-anco.yml と Release の PROVENANCE.txt を参照。
set -euo pipefail

REPO="oda251/zakki"
ANCO_REF="${1:-v0.11.2}"
TAG="anco-${ANCO_REF}"
ASSET="anco-${ANCO_REF}-linux-x64.tar.gz"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/zakki/anco"

mkdir -p "$DEST"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "downloading ${TAG}/${ASSET} ..."
curl -fL -o "${tmp}/${ASSET}" \
  "https://github.com/${REPO}/releases/download/${TAG}/${ASSET}"
tar -xzf "${tmp}/${ASSET}" -C "$DEST"

"$DEST/anco" --version >/dev/null 2>&1 || true
echo "installed: ${DEST}/anco"
