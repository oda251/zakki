# zakki — 技術候補調査記録

調査日: 2026-06-12。各領域を Web 調査（一次ソースを WebFetch で確認）した記録。要約と採否は `FEATURES.md` に反映済み。

## 1. かな漢字変換エンジン

### 主要候補

| 名称                                                                                             | 形態                                                   | ライセンス   | 文脈考慮       | Bun/Node                                                | 所見                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------ | -------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Google Transliterate API](https://developers.google.com/transliterate/v1/getting_started)       | 非公式 API                                             | Google ToS   | あり           | HTTP fetch で可                                         | **2011 年に公式廃止宣言済み**。現在も動作するが、商用不可・「powered by Google」表示必須・キャッシュ 15 日以内の規約。組み込みは規約リスクあり                                                                                                                                                                              |
| [Zenzai / zenz](https://huggingface.co/Miwa-Keita/zenz-v3.1-small-gguf)（azooKey の neural kkc） | GGUF + llama.cpp                                       | CC-BY-SA 4.0 | あり（LLM）    | llama.cpp server 経由で可                               | GPT-2 ベース 90M パラメータ、Q5_K_M で約 74MB・メモリ約 150MB。zenz-v2.5-medium は AJIMEE-Bench Acc@1 86.5% で Google 日本語入力（54.0%）を上回る（[さくらナレッジ](https://knowledge.sakura.ad.jp/42901/)）。公式 API は Swift（AzooKeyKanaKanjiConverter）のみで、入力フォーマット（特殊マーカー `` 等）の自前実装が必要 |
| [Mozc](https://github.com/google/mozc)                                                           | C++ / 外部プロセス IPC                                 | BSD-3-Clause | あり（統計）   | 子プロセス + S 式プロトコル（mozc_emacs_helper の方式） | 品質最高水準・ライセンス寛容。C++ ビルドまたはディストリのパッケージが前提。WASM ポートなし                                                                                                                                                                                                                                 |
| SKK 辞書引き自作                                                                                 | TS 自作 + [SKK-JISYO](https://github.com/skk-dev/dict) | 辞書: 下記   | なし           | 可                                                      | 純 JS/TS の変換エンジンは空白地帯。辞書引き（読み→候補）の自作は容易。[cwskk](https://github.com/rokoucha/cwskk)（MIT）のローマ字テーブル等が流用可能                                                                                                                                                                       |
| [libkkc](https://github.com/ueno/libkkc)                                                         | Vala/C                                                 | GPL-3.0+     | あり（N-gram） | 不可                                                    | 2014 年以降実質停止                                                                                                                                                                                                                                                                                                         |
| AzooKeyKanaKanjiConverter                                                                        | Swift                                                  | MIT          | あり           | 不可                                                    | Swift 専用。JS バインディングなし                                                                                                                                                                                                                                                                                           |

### SKK-JISYO ライセンス（skk-dev/dict committers.md 確認済み）

| 辞書                                   | ライセンス                    |
| -------------------------------------- | ----------------------------- |
| S / M / L / JIS2 / jinmei 等の主要辞書 | GPL v2+                       |
| pubdic+                                | Pubdic+ License（任意利用可） |
| okinawa / zipcode                      | パブリックドメイン            |
| emoji / ivd                            | Unicode License               |
| edict / edict2                         | CC BY-SA 3.0                  |

注意: 主要辞書（L 等）は GPL v2+。リポジトリを公開配布する場合、同梱するとライセンス伝播の検討が必要。

### 深掘り調査（2026-06-12 追加、実装コスト度外視で高精度・高 DX を再評価）

**結論: [AzooKeyKanaKanjiConverter](https://github.com/azooKey/AzooKeyKanaKanjiConverter) の公式 CLI `anco` が本命**。SKK 辞書引き自作と zenz プロンプト自前実装の両方が不要になる。

`anco` の確認事項（一次ソース: リポジトリの `Sources/CliTool/Anco.swift`、`.github/workflows/swift.yml`、`Package.swift`）:

- **Linux 公式サポート**: CI が ubuntu-24.04 + Swift 6.1 でビルド・テストを常時実行。llama.cpp はプレビルド `.so`（fkunn1326/llama.cpp のリリース）をダウンロード。CPU 専用ビルドは `--traits ZenzaiCPU`
- **外部プロセス IF**: `anco session` が stdin/stdout のライン指向プロトコル（1 行 1 コマンド: ひらがな入力 → 候補出力、`:n` 次ページ、`:3` 候補選択、`:ctx 前文` で左文脈設定、`:q` 終了）。TS からは `Bun.spawn` + stdin 書き込み / stdout 読み取りで統合できる
- **Zenzai 統合済み**: `--zenz <gguf path> --zenz_v3` フラグで有効化。`--config_topic`（トピック指定）、`--config_n_best` あり。zenz なしでも内蔵 N-gram エンジンで動作（自然なフォールバック）
- **ライセンス**: エンジン本体 MIT。辞書（azooKey_dictionary_storage サブモジュール）は **Apache-2.0**（2026-06-13 に LICENSE ファイルで確認。当初の MIT という記載は誤り）→ いずれにせよ SKK-JISYO の GPL 問題は消滅。絵文字辞書サブモジュール（azooKey_emoji_dictionary_storage）のみ LICENSE ファイルなし（Unicode データからの生成物）
- **プレビルドバイナリは配布されていない**（2026-06-13 確認: 全リリースで assets なし、CI artifacts なし）。fcitx5-hazkey が同エンジン + 辞書同梱の Linux バイナリを GitHub Releases で配布する先行例あり → zakki では自リポジトリの GitHub Actions（ubuntu-24.04 = ローカル WSL2 と同一環境・glibc 2.39）でビルドして Release に添付する方式を採用（`.github/workflows/build-anco.yml`）。バイナリ名は `CliTool`（公式 `install_cli.sh` がこれを `anco` として配置する）。ポータビリティのため `--static-swift-stdlib` を付与
- 留意点: `anco session` の出力に ANSI エスケープが含まれるためパース時に除去が必要。CPU での Zenzai 推論速度は未計測（未検証）。WSL2 固有の問題は未検証

zenz モデルのバリアント（GGUF 公式配布の確認結果）:

| モデル                                 | パラメータ | GGUF                                                                   | サイズ (Q5_K_M) |
| -------------------------------------- | ---------- | ---------------------------------------------------------------------- | --------------- |
| zenz-v3.1-small                        | 95.1M      | [公式配布あり](https://huggingface.co/Miwa-Keita/zenz-v3.1-small-gguf) | 73.9MB          |
| zenz-v2.5-medium（ベンチ最高値 86.5%） | 310M       | 公式 GGUF 未確認（safetensors のみ、自前量子化が必要な可能性）         | —               |

Mozc の DX 再評価: `sudo apt install emacs-mozc-bin` のみで `mozc_emacs_helper`（stdin/stdout の S 式プロトコル）が入手可能。ビルド不要で DX は最良だが、LLM 文脈補正がなく、プロトコル仕様の公式ドキュメントが無い（mozc.el のソースを読む必要）。zenz 系で精度が不足した場合の代替。

3 軸推奨:

| 軸               | 推奨                                                              |
| ---------------- | ----------------------------------------------------------------- |
| 精度最優先       | anco + zenz-v3.1-small（ZenzaiCPU）                               |
| DX 最優先        | Mozc（apt 2 コマンドで完成）                                      |
| バランス（採用） | anco + zenz-v3.1-small、zenz 未取得時は内蔵 N-gram フォールバック |

## 2. ローカル embedding

| 項目         | 採用候補                                                                                                                                                                       | 根拠                                                                                                                                                       |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ランタイム   | [@huggingface/transformers](https://github.com/huggingface/transformers.js) v4                                                                                                 | `bun run` での動作報告あり。`bun test` クラッシュ issue はクローズ済み。Apache-2.0                                                                         |
| モデル       | [cl-nagoya/ruri-v3-30m](https://huggingface.co/cl-nagoya/ruri-v3-30m)（ONNX は [sirasagi62/ruri-v3-30m-ONNX](https://huggingface.co/sirasagi62/ruri-v3-30m-ONNX)、非公式変換） | JMTEB avg 74.51 で OpenAI text-embedding-3-large（73.97）超え。256 次元、int8 で約 37MB。Apache-2.0。非公式 ONNX のため公式 PyTorch 出力との一致検証が必要 |
| 次点モデル   | [intfloat/multilingual-e5-small](https://huggingface.co/intfloat/multilingual-e5-small)（[Xenova 公式 ONNX](https://huggingface.co/Xenova/multilingual-e5-small) あり）        | MIT。JMTEB avg 約 67。ONNX が公式変換である安心感                                                                                                          |
| ベクトル検索 | [sqlite-vec](https://alexgarcia.xyz/sqlite-vec/js.html)                                                                                                                        | `bun:sqlite` からのロードを公式サポート。brute-force で 384 次元 × 10 万件 75ms 以下（M1 実測値、公式記載）。macOS は `Database.setCustomSQLite()` が必要  |

代替: 数万件規模なら Float32Array の総当たりコサイン類似でも成立（概算 10–30ms / 1 万件、未検証）。

- fastembed-js は 2026-01 にアーカイブ済み。後継 @mastra/fastembed はフレームワーク依存が強く単体利用は非推奨

## 3. 形態素解析・全文検索

### 形態素解析

| 名称                                                                               | 形態        | ライセンス     | メンテ                  | 所見                                                                                         |
| ---------------------------------------------------------------------------------- | ----------- | -------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| [lindera-wasm](https://github.com/lindera/lindera)（`lindera-wasm-nodejs-ipadic`） | WASM (Rust) | MIT            | 活発（v2.0.0、2026-01） | **推奨**。IPAdic 同梱（約 13MB）、ロード約 1 秒。品詞情報あり → 名詞抽出可。Bun 動作は未検証 |
| [@wangb/vibrato-wasm](https://jsr.io/@wangb/vibrato-wasm)                          | WASM (Rust) | Apache-2.0/MIT | 中                      | 次点。Bun 対応明記（JSR 配布）だが辞書は別途取得                                             |
| [kuromoji.js](https://github.com/takuyaa/kuromoji.js)                              | Pure JS     | Apache-2.0     | **停止（8 年超）**      | ESM 非対応・辞書ロードが遅い。当初候補だったが lindera-wasm に変更                           |
| Intl.Segmenter                                                                     | 標準 API    | —              | —                       | 単語分割のみ・品詞なし。名詞抽出には不十分                                                   |

### 全文検索

| 名称                                                                       | 日本語対応                 | 所見                                                                                                                                                                        |
| -------------------------------------------------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [MiniSearch](https://github.com/lucaong/minisearch) + lindera トークナイザ | カスタム `tokenize` で対応 | **推奨**。MIT、in-memory、型定義完備                                                                                                                                        |
| bun:sqlite FTS5 (trigram)                                                  | 限定的                     | 日本語 2 文字以下（UTF-8 9 バイト未満）がヒットしない制約を実測確認。macOS は FTS5 UPDATE/DELETE で破損バグ報告（[bun#31247](https://github.com/oven-sh/bun/issues/31247)） |
| FTS5 (unicode61) + 分かち書き格納                                          | 形態素解析前提             | トークン化済みテキストを格納すれば可。依存ゼロにしたい場合の代替                                                                                                            |

## 4. TUI フレームワーク

| 名称                                           | リアクティブモデル          | Bun 対応                                                                             | 日本語幅                          | メンテ                                               | 所見                                                                                                                 |
| ---------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------ | --------------------------------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [OpenTUI](https://github.com/sst/opentui) v0.4 | React / SolidJS（Zig コア） | **第一級**（`bun create tui` 公式、`Bun.stringWidth` 使用）                          | Zig 実装 wcwidth + CJK テストあり | 非常に活発（v0.4.1 2026-06-11）。OpenCode で本番使用 | **推奨**。`InputRenderable`（単行）/ `TextareaRenderable`（多行）実装済み。Yoga 相当の Flexbox。API は v0.x で不安定 |
| [Ink](https://github.com/vadimdemedes/ink) v7  | React 19                    | **非対応**（`stdin.ref()` 廃止で入力破損 [#696]、公式サポート "not planned" [#636]） | v7 で CJK 表示幅修正済み          | 活発                                                 | Bun では使えない。**Node で動かすなら次点**。多行エディタなし                                                        |
| blessed 系 / vue-termui                        | —                           | 未検証                                                                               | 不明                              | 実質停止                                             | 不採用                                                                                                               |
| 自前実装                                       | 任意                        | —                                                                                    | `get-east-asian-width` 等で可     | —                                                    | 差分描画は可能だが Flexbox 自作コストが高く非推奨                                                                    |

補足: Ink / OpenTUI とも IME composition 表示は未対応（ink#759, opentui#942）。**v2 はローマ字直接入力で IME を使わないため、この制約の影響を受けない**。

## 5. ローカル LLM（任意コンポーネント）

### ランタイム

| 名称                                                 | Bun 統合                                 | 所見                                                          |
| ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------- |
| [Ollama](https://github.com/ollama/ollama-js)        | 公式 npm `ollama`（MIT）、REST           | 最小摩擦。WSL2 動作（`OLLAMA_HOST` 設定に注意）               |
| [node-llama-cpp](https://node-llama-cpp.withcat.ai/) | **Bun 公式サポート明記**（MIT、v3.18.1） | プロセス内呼び出しでレイテンシ最小。GGUF 直接ロード。ESM 必須 |
| llama.cpp server                                     | HTTP（OpenAI 互換）                      | Zenzai 実行に使う場合の選択肢                                 |

### モデル（CPU 実行前提、目安: 7-8B Q4 で 5–15 tok/s）

| モデル                      | サイズ (Q4_K_M) | 日本語性能の根拠                       | ライセンス                      |
| --------------------------- | --------------- | -------------------------------------- | ------------------------------- |
| Qwen3-4B                    | 2.5GB           | Nejumi LB4 sub-10B 2 位（0.6612）      | Apache-2.0                      |
| Qwen3-8B                    | 5.0GB           | 同 1 位（0.6891）                      | Apache-2.0                      |
| TinySwallow-1.5B            | 986MB           | Qwen2.5-32B からの蒸留（定量値非公開） | Apache-2.0 + Gemma Terms 要確認 |
| LLM-jp-3.1-1.8B-instruct4   | 未検証          | MT-Bench JA 6.30                       | Apache-2.0                      |
| zenz-v3.1-small（変換特化） | 74MB (Q5_K_M)   | §1 参照                                | CC-BY-SA 4.0                    |

用途別推奨: 変換校正 = zenz（特化・軽量）、要約・タグ正規化 = Qwen3-4B + Ollama。

## 調査を受けた選定変更（FEATURES.md 反映済み）

1. **TUI: Ink → OpenTUI**。Ink は Bun 非対応（公式 "not planned"）。Bun 継続なら OpenTUI 一択。Ink を使うなら Node ランタイムへ変更
2. **Google CGI API を一次エンジンから降格**。廃止宣言済み + 規約リスク（商用不可・表示義務）。ローカルの Zenzai が品質・制約の両面で上回る
3. **変換の本命はローカル 2 段構成**: SKK 辞書引き（即時・自作）+ zenz による文脈変換（llama.cpp、74MB）
4. **kuromoji.js → lindera-wasm**（kuromoji.js はメンテ 8 年停止）
5. **embedding は ruri-v3-30m が有力**（JMTEB で有料 API 超え、37MB）
