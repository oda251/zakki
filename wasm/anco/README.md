# anco wasm ブリッジ（issue #26）

anco（AzooKeyKanaKanjiConverter, Swift）を `wasm32-unknown-wasi` にビルドし、
ブラウザでかな漢字変換をクライアント側実行するための build ツールとブリッジ。
サーバに平文かなを送らずに変換するのが狙い（E2E 暗号方針と整合）。

ローカルに Swift toolchain は入れない方針（docs/FEATURES.md §163）のため、
ビルドは GitHub Actions（`.github/workflows/build-anco-wasm.yml`）で行う。

## 構成

```
wasm/anco/
├── patch/anco-wasi-gate.py       # 上流 Package.swift を WASI 用に加工（anchor 方式）
├── patch/list-wasm-exports.py    # wasm の export セクションを解析（CI の C ABI 検証用）
└── Sources/
    ├── AncoWasmBridge/Bridge.swift   # 変換ロジック + C ABI（@_expose(wasm) + @_cdecl）
    ├── AncoWasmSmoke/main.swift       # 実変換スモーク（command, wasmtime 実行）
    └── AncoWasmReactor/main.swift     # ブラウザ配布用 reactor（_initialize + export）
```

CI は上流を checkout → `anco-wasi-gate.py` で manifest を加工 → 上の Sources を
`anco/Sources/` へコピー → `AncoWasmSmoke`（command）をビルドして wasmtime で実変換を
検証し、`AncoWasmReactor` を `-mexec-model=reactor` でビルドして export を検証する。

`patch/` 配下がこのリポジトリで唯一の Python スクリプト。wasm の export セクション
（LEB128 可変長整数）の解析や Package.swift のバランス括弧を見た構文編集は bash では
壊れやすく、GitHub Actions ランナに `python3` が同梱されているため Python を使う
（追加依存なし）。

## 辞書ロード方式: 明示パス（Bundle.module 非経由）

上流の `withDefaultDictionary()` は `Bundle.module` で辞書 `.resources` を探すが、
これは WASI 上で解決できず fatal error になる（Phase 0 で実証）。本ブリッジは
public な `DicdataStore(dictionaryURL:)` / `KanaKanjiConverter(dictionaryURL:)` に
**辞書ディレクトリの明示パス**を渡す。ブラウザでは辞書を仮想 FS の固定パス
（例 `/dict/Dictionary`）に mount し、そのパスを渡す。上流ソースへのパッチは不要。

辞書ローダは `Data(contentsOf:options:[.mappedIfSafe])` 系で、mmap 不可の WASI では
通常 read にフォールバックする。zenz / llama.cpp / SwiftyMarisa は Zenzai trait off
で非リンク（v1 は zenz 非搭載）。

## manifest 加工（anco-wasi-gate.py）

上流 PR #241 の方針に準拠し、WASI でビルドできない CliTool（swift-argument-parser
依存）とホスト Linux 判定の objc リンカブロックを除去し、`AncoWasmBridge` /
`AncoWasmSmoke` ターゲットを注入する。**アンカーが上流ドリフトで一致しなくなったら
異常終了**して CI で気付ける（上流バージョンを上げたらここを追従）。

## C ABI（ブラウザから呼ぶ export）

| export | 役割 |
|---|---|
| `zakki_alloc(size) -> ptr` | 入力バイト列用に wasm メモリを確保 |
| `zakki_free(ptr)` | 確保／変換結果バッファを解放 |
| `zakki_anco_init(pathPtr, pathLen) -> i32` | 辞書ディレクトリ（UTF-8）で初期化。0=成功 |
| `zakki_anco_convert(kanaPtr,kanaLen,ctxPtr,ctxLen) -> i64` | 変換。候補の JSON 配列を `(ptr<<32)\|len` で返す |

文字列は UTF-8 バイト列で受け渡し。`zakki_anco_convert` の戻り値上位 32bit が
結果バッファのポインタ、下位 32bit が長さ。JS 側は unsigned 64bit として扱い、
`memory[ptr..<ptr+len]` を読んだ後 `zakki_free(ptr)` で解放する。

`zakki_anco_init` は辞書ディレクトリ構築後、既知の語を 1 回変換する probe を行い、
候補が出た場合のみ 0（成功）を返す。辞書欠損・mount ミスを初期化失敗として検出する
（issue #26: フォールバックなし・初期化失敗はブロッキングエラー）。

## reactor（ブラウザ配布実体）

ブラウザは `_start` を走らせず export を呼ぶため、Swift ランタイム初期化子が走らず
クラッシュしうる。そこで `AncoWasmReactor` を `-mexec-model=reactor` でビルドし、
エントリを `_initialize` にする。JS（WASI shim）は `initialize(instance)` で `_initialize`
を呼んだ後に C ABI export を叩く。export は `@_expose(wasm, "name")` で行い、明示
`--export` フラグは不要（`@_cdecl` は C ABI 呼び出しのため併記）。
