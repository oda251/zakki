# zakki

ジャーナリング用メモ TUI。最上位プリンシパルは「考えを入力する以外の操作を可能な限り省く」。

- ローマ字入力に対し、変換操作なしで文脈を勘案した自動かな漢字変換を行う（大文字で始まる単語は英単語としてそのまま残す）
- 入力を自動でチャンク化し、タグ付け・関連付けを行う
- 完全無料・ローカル完結で稼働する
- データは Obsidian vault へ Markdown として一方向エクスポートできる（SQLite が source of truth）

## 使い方

```sh
bun install
./scripts/install-anco.sh   # かな漢字変換エンジン（Release から導入、Linux x64）
./scripts/install-zenz.sh   # 文脈校正モデル zenz（任意、約74MB）
bun start
```

起動すると当日エントリの末尾から即入力できる（設定・引数なし）。ローマ字を打つだけで即時にかな表示され、句点・改行で完結した文からバックグラウンドで漢字に置換される（タイピングは一切ブロックしない）。自動保存・チャンク化・Obsidian vault（`~/obsidian-vault/zakki/`）へのエクスポートも自動。終了は Ctrl+C。

誤変換は Tab キーで直前の変換単位の候補をローテーションでき、選択は学習されて以後最優先される。anco 未導入の場合はかな表示のまま動作する（フォールバック）。zenz 導入時は文脈を考慮した校正変換になる。

チャンクには TF-IDF キーワードタグと関連リンク（キーワード共有 + 埋め込み類似）が自動付与され、Obsidian エクスポート（frontmatter タグ・`[[リンク]]`）に反映される。Ctrl+F でインクリメンタル全文検索（ローマ字のまま漢字本文を検索可能。意味が近いものも補完表示）、Esc で戻る。

句点・改行の一次区切りに加え、ローカル embedding（ruri-v3-30m、初回起動時に約37MB を自動取得）による話題転換検出で隣接文が同一チャンクにまとまる。入力中は関連する過去チャンクが右ペインに自動表示される。`ZAKKI_NO_EMBEDDING=1` で embedding 系機能を無効化できる。

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
