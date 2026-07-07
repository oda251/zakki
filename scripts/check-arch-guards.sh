#!/usr/bin/env bash
# CI アーキテクチャガード（grep ベース、issue #59）
#
# oxlint / dependency-cruiser で表現できない規約を git grep で検査する。
# 違反が見つかった場合は該当行を出力して非 0 で終了する。
#
# 許可リストの運用:
# - 各ガードの ALLOW 配列（git pathspec の除外形式 ':!<path>'）にファイルを追加する
# - 追加時は理由をコメントで併記する
set -euo pipefail
cd "$(dirname "$0")/.."

status=0

# ---------------------------------------------------------------------------
# Guard 1: process.env の直接参照禁止（issue #48）
#
# 生の process.env は合成点（エントリポイント）と config 定義でのみ読み、
# 深層パッケージには parseZakkiConfig の結果を渡す。
# oxlint 1.x の node/no-process-env は dot/bracket とも検知しないため grep で縛る。
# ---------------------------------------------------------------------------
PROCESS_ENV_ALLOW=(
  ':!apps/tui/src/index.tsx'        # TUI エントリポイント（合成点）
  ':!apps/tui/src/cli/*.ts'         # CLI エントリポイント（合成点）
  ':!apps/tui/src/config.ts'        # config 定義（コメントでの言及のみ）
  ':!apps/web/src/server/index.ts'  # web サーバエントリポイント（合成点）
  ':!apps/web/vite.config.ts'       # vite dev サーバの合成点
  ':!packages/core/src/config/env.ts' # ZakkiConfig の定義本体
  ':!*.test.ts'                     # テストは CI 分岐等で環境変数を読んでよい
  ':!*.test.tsx'
)
if hits=$(git grep -n 'process\.env' -- '*.ts' '*.tsx' "${PROCESS_ENV_ALLOW[@]}"); then
  echo "NG: process.env を config 定義・合成点以外で参照しています（issue #48 / #59）"
  echo "    parseZakkiConfig / loadConfigOrExit の結果を引き回すか、"
  echo "    正当な合成点なら scripts/check-arch-guards.sh の PROCESS_ENV_ALLOW に理由付きで追加してください。"
  echo "$hits"
  status=1
else
  echo "OK: process.env guard (issue #48)"
fi

# ---------------------------------------------------------------------------
# Guard 2: AAD リテラルの直書き禁止（issue #47）
#
# AEAD の AAD ラベルは packages/core/src/crypto/aad.ts の AAD 定数が単一定義。
# 文字列リテラル（"chunk.content" 等）の直書きは定数とのズレ＝復号不能を招く。
# 引用符付きのみ検知する（chunk.content のようなプロパティアクセスは対象外）。
# ---------------------------------------------------------------------------
AAD_LITERALS='chunk\.content|tag\.name|chunkUserTag\.name|embedding\.vector'
AAD_PATTERN="[\"'\`](${AAD_LITERALS})[\"'\`]"
AAD_ALLOW=(
  ':!packages/core/src/crypto/aad.ts' # AAD 定数の定義本体
  ':!*.test.ts'                       # テストは期待値としてリテラルを書いてよい
  ':!*.test.tsx'
)
if hits=$(git grep -nE "$AAD_PATTERN" -- '*.ts' '*.tsx' "${AAD_ALLOW[@]}"); then
  echo "NG: AAD リテラルを直書きしています（issue #47 / #59）"
  echo "    packages/core/src/crypto/aad.ts の AAD 定数を import してください。"
  echo "$hits"
  status=1
else
  echo "OK: AAD literal guard (issue #47)"
fi

# ---------------------------------------------------------------------------
# Guard 3: web サーバの Bun 固有 API 禁止（issue #29）
#
# apps/web/src/server は標準 Fetch ハンドラ（Hono）で構成し、Workers/Node へ
# 可搬に保つ。Bun.serve / hono/bun（Bun.file 依存の静的配信）等の Bun 固有 API
# は bun 用起動アダプタ（index.ts）だけに置く。
# ---------------------------------------------------------------------------
BUN_API_PATTERN='Bun\.|hono/bun|from "bun"|from '\''bun'\'''
BUN_API_ALLOW=(
  ':!apps/web/src/server/index.ts' # bun 用起動アダプタ（Bun.serve・静的配信）
  ':!*.test.ts'                    # テストランナーは bun:test（bun 前提でよい）
  ':!*.test.tsx'
)
if hits=$(git grep -nE "$BUN_API_PATTERN" -- 'apps/web/src/server/*.ts' 'apps/web/src/server/**/*.ts' "${BUN_API_ALLOW[@]}"); then
  echo "NG: web サーバ本体で Bun 固有 API を使用しています（issue #29 / #59）"
  echo "    標準 Fetch / Hono の可搬 API に寄せるか、起動アダプタ（index.ts）へ移してください。"
  echo "$hits"
  status=1
else
  echo "OK: web server Bun API guard (issue #29)"
fi

# ---------------------------------------------------------------------------
# Guard 4: backend での drizzle-orm 直接使用禁止（issue #53）
#
# 解析結果の永続化・読み取りは packages/data の適用関数・クエリ
# （analysis/apply.ts・analysis/queries.ts 等）経由にする。schema.ts の直接
# import は dependency-cruiser（backend-no-schema-internals）で縛り、生 SQL
# （sql タグ・演算子）は drizzle-orm import の禁止で縛る（depcruise では
# 「schema を経由しない生 SQL」を検出できないため grep で補完する）。
# ---------------------------------------------------------------------------
DRIZZLE_ALLOW=(
  ':!*.test.ts'  # テストは DB 実体の検証で drizzle を使ってよい
  ':!*.test.tsx'
)
if hits=$(git grep -nE 'from "drizzle-orm' -- 'packages/backend/src/**/*.ts' "${DRIZZLE_ALLOW[@]}"); then
  echo "NG: packages/backend で drizzle-orm を直接使用しています（issue #53 / #59）"
  echo "    永続化・読み取りは packages/data の適用関数・クエリ（analysis/apply.ts 等）へ移してください。"
  echo "$hits"
  status=1
else
  echo "OK: backend drizzle-orm guard (issue #53)"
fi

exit $status
