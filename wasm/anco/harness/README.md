# anco wasm 計測ハーネス（issue #26 Phase 2）

ブラウザ配布用 reactor wasm を仮想 FS に辞書 mount して初期化・変換を実測する。
Phase 3 で `packages/core` の `KanaKanjiEngine` 実装に置き換える際の参照実装でもある。

## 入力アーティファクト

`build-anco-wasm` ワークフローの artifact `anco-wasm` から取得する:
- `anco.reactor.opt.wasm` … ブラウザ配布用 reactor（_initialize + C ABI）
- `dict.tar.br` … 辞書（brotli 圧縮 tar）。`brotli -d dict.tar.br -o dict.tar` で展開

（大きいためリポジトリには含めない。CI 実行の artifact か Release から落とす。）

## node(V8) で計測（CI でも実行）

```
node measure.mjs <reactor.wasm> <dict.tar>
```

V8 は Chrome と同一の wasm エンジンなので compile/変換の計算コストは代表値になる。
実ブラウザは streaming compile + ネットワーク取得で経路が異なる点に注意。
`build-anco-wasm.yml` の「Measure browser-engine init time」ステップが CI で毎回これを走らせ、
所要時間をジョブサマリに出す。

## 実ブラウザで計測

`index.html` `browser.mjs` を `anco.reactor.wasm` `dict.tar` と同一ディレクトリに置いて
同一オリジンで配信し、開いて `result` を見る（`window.__ANCO_RESULT__` にも入る）。
`compileStreaming` を使うため、サーバは `.wasm` を `application/wasm` で返すこと。

```
# 例（wasm/dict をこのディレクトリに配置後）
python3 -m http.server 8080
```

## 構成

- `vendor/browser_wasi_shim.mjs` … [bjorn3/browser_wasi_shim](https://github.com/bjorn3/browser_wasi_shim) v0.4.2 の
  バンドル（MIT/Apache-2.0）。ブラウザ WASI shim。仮想 FS(`PreopenDirectory`/`File`) と reactor(`initialize`) を提供。
- `lib/tar.mjs` … 辞書 tar を Directory ツリーに展開
- `lib/engine.mjs` … reactor インスタンス化 + C ABI ラッパ（init / convert）
- `measure.mjs` … node 計測ランナ
- `browser.mjs` + `index.html` … 実ブラウザ計測ページ

辞書パス・C ABI の仕様は `wasm/anco/README.md` を参照。
