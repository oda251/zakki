# zakki

ジャーナリング用メモ TUI。最上位プリンシパルは「考えを入力する以外の操作を可能な限り省く」。

ローマ字を打つだけで、変換操作なしに文脈を勘案した自動かな漢字変換が走る。入力は自動でチャンク化され、タグ付け・関連付けされる。完全無料・ローカル完結で稼働し、データは SQLite（source of truth）に保存され、Obsidian vault へ Markdown として一方向エクスポートできる。

挙動・仕様の詳細は各モジュールのテスト（`*.test.ts`）と [docs/](docs/) の設計ドキュメントを正本とする。

## 使い方

```sh
just setup       # bun install + かな漢字変換エンジン anco（Release から導入、Linux x64）
just setup-zenz  # 文脈校正モデル zenz（任意、約74MB）
just tui
```

コマンドの入口は [justfile](justfile) に集約している（`just` で一覧）。起動すると当日エントリの末尾から即入力でき、設定・引数は不要。終了は Ctrl+C。

データは SQLite（`~/.local/share/zakki/`）と Obsidian vault（既定 `~/obsidian-vault/zakki/`）に書き出される。`ZAKKI_VAULT_DIR` / `XDG_DATA_HOME` で出力先を差し替えられる（お試しは別ディレクトリを指定すると本番データを汚さない）。環境変数の一覧は [`packages/core/src/config/env.ts`](packages/core/src/config/env.ts) を参照。

```sh
just digest      # 当日のふりかえりを vault へ書き出し（--week で直近7日）
just tags        # タグの統合提案（--apply で適用）
```

## Web UI

グラフビュー（ノード=チャンク、エッジ=関連リンク）を中心にした Web 版。右に TUI と同じ入力欄と関連表示、左に日付チャンク一覧・タグフィルタを持つ（データモデルは [docs/CHUNKS.md](docs/CHUNKS.md)）。かな漢字変換はブラウザ内 wasm で完結する（サーバ往復なし、issue #26）。

```sh
just setup-web   # クライアント（Vite）をビルドし、anco wasm 変換アセットを dist に導入
just web         # http://localhost:3777（ZAKKI_WEB_PORT で変更可）
just web-dev     # 開発時: vite dev サーバ（:5173）。別途 just web で API を起動
```

Docker で動かす場合（DB は `zakki-data` volume に永続化）:

```sh
docker compose up --build
# anco wasm Release のタグを変える場合: docker compose build --build-arg ANCO_REF=vX.Y.Z
```

留意:

- **TUI と Web サーバの同時起動は非推奨**（同一 SQLite への複数ライターとなり、解析パスが競合しうる）。どちらか一方を使う。
- Web サーバは DEK を持たず復号しない（暗号文の中継・封筒配布・静的配信のみ）。E2E 暗号のアンロックはブラウザ側、初回セットアップ・パスフレーズ操作は TUI（`just tui` / `just passphrase`）で行う。

TUI・Web とも OpenAI 互換のローカル LLM（LM Studio・Ollama・llama.cpp server 等）が起動していれば要約・類義判定が強化される。未指定時は LM Studio → Ollama の順に自動検出し、`ZAKKI_LLM_BASE_URL` / `ZAKKI_LLM_MODEL` で明示指定もできる。無ければ決定的な処理のみで動く。

## ドキュメント

- [構想・アーキテクチャ](docs/CONCEPT.md)
- [統合チャンクモデル](docs/CHUNKS.md)
- [入力アーキテクチャ](docs/COMPOSER.md)
- [機能候補と実現方式](docs/FEATURES.md)
- [技術候補調査記録](docs/RESEARCH.md)

## 技術スタック

| 領域         | 採用                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ランタイム   | Bun + TypeScript                                                                                                                                               |
| TUI          | [OpenTUI](https://github.com/sst/opentui)                                                                                                                      |
| かな漢字変換 | [AzooKeyKanaKanjiConverter](https://github.com/azooKey/AzooKeyKanaKanjiConverter)（anco）+ [zenz-v3.1](https://huggingface.co/Miwa-Keita/zenz-v3.1-small-gguf) |
| 形態素解析   | [lindera-wasm](https://github.com/lindera/lindera)                                                                                                             |
| 感情分析     | [negaposi](https://github.com/hata6502/negaposi)（日本語評価極性辞書 / 東北大 乾・岡崎研）                                                                     |
| DB           | bun:sqlite（+ [sqlite-vec](https://github.com/asg017/sqlite-vec)）                                                                                             |

選定根拠は [docs/RESEARCH.md](docs/RESEARCH.md) を参照。
