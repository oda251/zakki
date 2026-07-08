# zakki のコマンド入口。`just` で一覧表示。
# 実体は package.json の scripts と scripts/ に置き、ここは入口の集約だけを担う
# （二重定義しない。手順が変わったら実体側を直す）。

# レシピ一覧を表示
default:
    @just --list

# ---- セットアップ ----

# 依存導入 + TUI 用かな漢字変換エンジン（anco, Linux x64）を導入
setup:
    bun install
    ./scripts/install-anco.sh

# 文脈校正モデル zenz を導入（任意、約74MB。TUI 専用）
setup-zenz:
    ./scripts/install-zenz.sh

# web の配信物一式を dist に用意（SPA ビルド + anco wasm 変換アセット）
setup-web:
    bun run web:build
    ./scripts/install-anco-wasm.sh

# ---- 起動 ----

# TUI を起動（当日エントリの末尾から即入力。終了は Ctrl+C）
tui:
    bun start

# web サーバを起動（API + SPA + anco wasm 配信、既定 :3777）。初回は先に `just setup-web`
web:
    bun run web

# web 開発サーバ（vite, :5173）。API は別途 `just web` で起動しておく
web-dev:
    bun run web:dev

# Docker で web を起動（DB は zakki-data volume に永続化）
docker:
    docker compose up --build

# ---- CLI ----

# 当日のふりかえりを vault へ書き出し（--week で直近7日）
digest *args:
    bun run digest {{args}}

# 記録の統計を表示
stats *args:
    bun run stats {{args}}

# タグの統合提案（--apply で適用）
tags *args:
    bun run tags {{args}}

# E2E 暗号のパスフレーズ操作（初回セットアップ・変更）
passphrase *args:
    bun run passphrase {{args}}

# ---- 検証 ----

# テストのみ実行
test:
    bun test

# フォーマット
fmt:
    bun run fmt

# CI と同一セットの全チェック（.github/workflows/ci.yml と対応）
check:
    bun run lint
    bun run typecheck
    bun run depcruise
    bash scripts/check-arch-guards.sh
    bun run knip
    bun test
    bun run web:build
