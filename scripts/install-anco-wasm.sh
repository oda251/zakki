#!/usr/bin/env bash
# zakki の Release から anco の wasm 変換アセット（ブラウザ実行用）を導入する（issue #26）。
# reactor wasm と辞書 tar（いずれも brotli 済み .br）を web サーバが同一オリジンで配信する
# ディレクトリ（既定 apps/web/dist/anco）へ置く。出自は .github/workflows/build-anco-wasm.yml。
set -euo pipefail

REPO="oda251/zakki"
ANCO_REF="${1:-v0.11.2}"
TAG="anco-wasm-${ANCO_REF}"
DEST="${ZAKKI_ANCO_WASM_DIR:-apps/web/dist/anco}"

mkdir -p "$DEST"
for asset in anco.reactor.wasm.br dict.tar.br; do
  echo "downloading ${TAG}/${asset} ..."
  curl -fL -o "${DEST}/${asset}" \
    "https://github.com/${REPO}/releases/download/${TAG}/${asset}"
done
# キャッシュバスティング用の ref マーカー（issue #89）。サーバが /anco/ref.txt を
# no-cache で配信し、クライアントはこの値でアセット URL と Cache API 名を versioning する。
printf '%s\n' "$ANCO_REF" > "${DEST}/ref.txt"
echo "installed: ${DEST}/{anco.reactor.wasm.br,dict.tar.br,ref.txt}"
