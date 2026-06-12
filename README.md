# zakki

ジャーナリング用メモ TUI。最上位プリンシパルは「考えを入力する以外の操作を可能な限り省く」。

- ローマ字入力に対し、変換操作なしで文脈を勘案した自動かな漢字変換を行う（大文字で始まる単語は英単語としてそのまま残す）
- 入力を自動でチャンク化し、タグ付け・関連付けを行う
- 完全無料・ローカル完結で稼働する
- データは Obsidian vault へ Markdown として一方向エクスポートできる（SQLite が source of truth）

## ドキュメント

- [構想・アーキテクチャ](docs/CONCEPT.md)
- [機能候補と実現方式](docs/FEATURES.md)
- [技術候補調査記録](docs/RESEARCH.md)

## 技術スタック（予定）

| 領域         | 採用                                                                                                                                                           |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ランタイム   | Bun + TypeScript                                                                                                                                               |
| TUI          | [OpenTUI](https://github.com/sst/opentui)                                                                                                                      |
| かな漢字変換 | [AzooKeyKanaKanjiConverter](https://github.com/azooKey/AzooKeyKanaKanjiConverter)（anco）+ [zenz-v3.1](https://huggingface.co/Miwa-Keita/zenz-v3.1-small-gguf) |
| 形態素解析   | [lindera-wasm](https://github.com/lindera/lindera)                                                                                                             |
| DB           | bun:sqlite（+ [sqlite-vec](https://github.com/asg017/sqlite-vec)）                                                                                             |

選定根拠は [docs/RESEARCH.md](docs/RESEARCH.md) を参照。
