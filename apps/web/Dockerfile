# zakki Web（apps/web）: API サーバ + ビルド済み SPA 配信
#
# build:  docker compose build（または docker build -f apps/web/Dockerfile .）
# 引数:   ANCO_REF=vX.Y.Z（anco wasm Release タグ anco-wasm-<ref> の <ref>）
#
# かな漢字変換はクライアント wasm 実行（#26）。web サーバは変換エンジンを持たず、
# reactor wasm と辞書を同一オリジンで配信するだけなので、native anco / zenz は不要。

# ---- build: 依存解決と SPA ビルド ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile
RUN bun run web:build

# ---- runtime ----
FROM oven/bun:1 AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app /app

# anco wasm 変換アセット（reactor wasm + 辞書, brotli 済み）を dist/anco に焼く。
# scripts/install-anco-wasm.sh と同じ取得元（build-anco-wasm.yml の Release）。
ARG ANCO_REF=v0.11.2
RUN ZAKKI_ANCO_WASM_DIR=/app/apps/web/dist/anco \
      bash scripts/install-anco-wasm.sh "${ANCO_REF}"

# DB・キーファイルは /data（volume）へ。
# 3777 の既定値定義は packages/core/src/config/env.ts の DEFAULT_WEB_PORT（issue #56）。
# Dockerfile からは TS を参照できないため、変更時はここ（ENV/EXPOSE）と
# docker-compose.yml の ports も揃える
ENV XDG_DATA_HOME=/data \
    ZAKKI_WEB_PORT=3777

EXPOSE 3777
VOLUME /data
CMD ["bun", "apps/web/src/server/index.ts"]
