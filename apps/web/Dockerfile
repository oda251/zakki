# zakki Web（apps/web）: API サーバ + ビルド済み SPA 配信
#
# build:  docker compose build（または docker build -f apps/web/Dockerfile .）
# 引数:   ANCO_REF=vX.Y.Z（anco Release タグ）、WITH_ZENZ=1（zenz GGUF を焼く）、
#         WARMUP_EMBEDDER=0（embedding モデルの焼き込みを省く）

# ---- build: 依存解決と SPA ビルド ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock bunfig.toml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
RUN bun install --frozen-lockfile
RUN bun run web:build

# ---- runtime ----
# anco は Ubuntu 24.04 の CI でビルドした Swift バイナリ（glibc 依存）のため、
# ランタイムも ubuntu:24.04 を使う（oven/bun は Debian で glibc が古い）
FROM ubuntu:24.04 AS runtime
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates coreutils curl unzip && \
    rm -rf /var/lib/apt/lists/*

# Bun（バージョンは bun.lock を作った環境に合わせて固定）
ARG BUN_VERSION=1.3.12
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    ln -s /root/.bun/bin/bun /usr/local/bin/bun

# anco（Release の自前ビルド, scripts/install-anco.sh と同じ取得元）。
# /data（volume）に隠れないよう /opt に置き、ZAKKI_ANCO_PATH で参照する
ARG ANCO_REF=v0.11.2
RUN mkdir -p /opt/zakki/anco && \
    curl -fL "https://github.com/oda251/zakki/releases/download/anco-${ANCO_REF}/anco-${ANCO_REF}-linux-x64.tar.gz" \
    | tar -xz -C /opt/zakki/anco

# zenz GGUF（CC-BY-SA 4.0）。再配布を避けるため既定では焼かない（WITH_ZENZ=1 でオプトイン）
ARG WITH_ZENZ=0
RUN if [ "$WITH_ZENZ" = "1" ]; then \
      mkdir -p /opt/zakki/models && \
      curl -fL -o /opt/zakki/models/zenz-v3.1-small-Q5_K_M.gguf \
        "https://huggingface.co/Miwa-Keita/zenz-v3.1-small-gguf/resolve/main/ggml-model-Q5_K_M.gguf"; \
    fi

WORKDIR /app
COPY --from=build /app /app

# DB・キーファイルは /data（volume）へ。anco/zenz は env で /opt を指す。
# 3777 の既定値定義は packages/core/src/config/env.ts の DEFAULT_WEB_PORT（issue #56）。
# Dockerfile からは TS を参照できないため、変更時はここ（ENV/EXPOSE）と
# docker-compose.yml の ports も揃える
ENV XDG_DATA_HOME=/data \
    ZAKKI_ANCO_PATH=/opt/zakki/anco/anco \
    ZAKKI_ZENZ_PATH=/opt/zakki/models/zenz-v3.1-small-Q5_K_M.gguf \
    ZAKKI_WEB_PORT=3777

# embedding モデル（約37MB）をイメージへ焼き込み、初回リクエストのダウンロード待ちを避ける
ARG WARMUP_EMBEDDER=1
RUN if [ "$WARMUP_EMBEDDER" = "1" ]; then bun apps/web/src/server/warmup.ts; fi

EXPOSE 3777
VOLUME /data
CMD ["bun", "apps/web/src/server/index.ts"]
