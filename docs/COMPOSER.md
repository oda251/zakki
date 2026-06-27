# 入力アーキテクチャ — Composer 抽象とプラットフォーム差し替え（2026-06-28 決定）

本書は「入力（書く・変換する・カーソル）」のアーキテクチャを再設計する決定記録。
将来の Web 版（`apps/web`）を見据え、**プラットフォーム非依存のロジックを共有し、
描画（markup）はプラットフォームごとに各自書く**方針へ寄せる。記録モデル
（`docs/RECORDS.md`）・ペイン/カーソルの操作モデル（`docs/PANES.md`）は不変で、
本書は「入力ロジックの置き場所と境界」を定める。

## 背景と問題

現状（`apps/tui/src/tui/App.tsx`, 1150 行）は入力に関して 3 つの関心事が絡まっている。

1. **ソフトウェア IME（ローマ字 → かな → 漢字 の自動変換）** — `convertRomaji`
   （`packages/core/src/romaji/convert.ts`）, `ConversionPipeline`
   （`apps/tui/src/conversion/pipeline.ts`）, corrections 学習, Tab ローテーション。
2. **カーソル機構** — `applyEditKey`（`apps/tui/src/tui/controller.ts`）,
   端末縦棒カーソル＋セル幅計算（`native-cursor.ts`, `width.ts`）。
3. **アプリ本体** — ペイン構成・チャンク表示・ダイアログ・検索・永続化・解析/export。

加えて `useKeyboard`（`App.tsx` の約 220 行）がモーダル優先
（menu→dialog→editing→search→cursor→input）を手続きで握り、状態は useState の山＋
ref 二重持ち（`bufferRef`/`editRef`/`cursorRef`）で管理されている。

### 素朴な分割では破綻する

「`Input.Tui` / `Input.Web` に分ける」だけでは不十分。さらに編集系の表示部品ごとに
プラットフォーム変種が要るため `Chunk.Edit.Tui` / `Chunk.Edit.Web` …と
**「部分 × プラットフォーム」のマトリクス爆発**を起こす。これは「markup を
プラットフォーム間で共有しよう」とするのが原因。

## 決定

### 1. headless 共有 + 描画は各自（マトリクスを作らない）

opentui の `<box>/<text>` と DOM は別物。**markup の共有は追わない**。共有するのは
**headless なロジック/状態**（変換・records・論理カーソル・intent・store）。
表示部品（`Chunk.View`/`Digest` など）はプラットフォームごとに薄く各自書く。
これにより跨プラットフォームの `Chunk` は存在せず、`Chunk.Edit.Tui` も発生しない。

> 先例: Radix / TanStack 系の headless 設計。ロジックは hook/関数、markup は利用側。

### 2. 自動変換は「ライブ末尾」だけの現象 → 汎用 IME は不要

このアプリの変換は**常に追記点（ライブ末尾）でのみ**走る。修正（Edit）は
変換しないプレーン編集（`controller.ts` のコメント「バッファ途中の非同期変換が
できない」）。よって「文の途中にカーソルを置いて IME 変換」という最難関は
**そもそも存在しない**。Web でも“ブラウザ内に汎用 IME を実装”する必要はなく、
追記面はカーソル末尾固定で `変換済みテキスト + 淡色 pending + 末尾キャレット` を
描くだけ。

### 3. New と Edit を `Composer` に統合

現在の `Chunk.New`（追記・IME あり）と `Chunk.Edit`（修正・プレーン）の分裂は
**端末の都合**であってドメイン概念ではない。1 つの `Composer`（唯一の編集面）に
統合し、`mode`（または target）で分岐する。

- `append` … 変換パイプラインを通す。カーソル末尾固定。pending あり。
- `correct` … プレーン編集。可動カーソル。変換なし。**両プラットフォーム共通**
  （Web で途中変換できても、TUI と挙動を揃えるためプレーンに統一）。

コンポーネントは 1 個。挙動は `mode` で分岐し、**プラットフォームでは分岐しない**。
`Chunk` は読み取り専用（`View`/`Digest`/`Surface`/`Status`）に純化する。

### 4. カーソルは「論理」と「視覚」の 2 層に割る

| 層 | 共有 | 実装 |
|---|---|---|
| 論理カーソル（text 内 offset・編集操作・移動 intent） | ✅ 共有 headless | `applyEditKey` 等を core へ |
| 視覚カーソル（画面上の位置） | ❌ 各自 | TUI=`native-cursor`+`width`／Web=ブラウザのキャレット |

`width.ts` / `native-cursor.ts` は **Web からは一切要らない**（DOM が描く）。
`Composer.Tui` の内側に封印し、store やシェルからは参照しない。

### 5. raw 模型は変更しない。Web の入力はゲートでルート分岐

raw には既に 2 種類の中身がある: 「変換対象のローマ字ライブ末尾」と
「verbatim な凍結リテラル（ペースト, `App.tsx` の `usePaste`）」。Web の入力は
これに乗せる:

- **OS IME 入力（既に日本語）** → “打鍵ペースト”扱いで **凍結リテラル直行**。
- **ローマ字入力（ASCII）** → ライブ末尾で **自動変換**。

自動変換を有効化するゲート（`Composer.Web` 内のロジック）:

> **UA 等で「PC（非モバイル）」かつ「本文が ASCII ローマ字のみ」のときだけ自動変換。**
> それ以外は OS IME / プレーン（凍結リテラル直行）。

モバイルや OS IME 直接入力と自然に共存でき、記録モデルの変更は不要。

### 6. 状態管理を zustand へ寄せる

useState の山＋ref 二重持ちを、**プラットフォーム非依存の zustand store** に統合する。

- **ref 二重持ちの撤去**: 連続キーの取りこぼし回避で `bufferRef`/`editRef`/`cursorRef`
  を使っているが、`store.getState()` が常に最新を同期で返すため不要になる。
  キーハンドラは `getState().<action>()` を同期で叩く。
- **store はプラットフォーム非依存**（`opentui`/DOM を import しない）。論理状態のみ:
  raw・editing(target/text/論理cursor)・global cursor・mode・dialog/menu・search。
- **視覚系は store に入れない**: scrollbox ref・`native-cursor`・`width`・DOM キャレットは
  platform 層に置く。
- **副作用は store の外**: 永続化 debounce・解析・埋め込み・export は store の
  `raw`/`conversionVersion` を `subscribe` する effect 層に逃がす。`db`/`engine`/
  `embedder`/`sync` は現状どおり props DI（`AppProps`）で注入。
- **slice 分割**: `document` / `editing(composer)` / `cursor` / `ui` / `search`。
- **vanilla store** にして opentui-react と web-react の両方から `useStore(selector)`
  で使う。テストは「store 生成 → action → assert」で純粋に書ける。
- `conversionVersion` の手動 bump は、pipeline 解決時に store action を叩く形へ置換。

### 7. レイヤ / ディレクトリ

```
packages/core（純粋・headless・React 非依存。多くは既にテスト済み）
  romaji/ records/ conversion/（pipeline を移設） controller intent/cursor ロジック
  editor store（zustand, platform 非依存）
        ▲ 参照のみ（副作用なし・opentui/DOM 非依存）
apps/tui                                  apps/web（将来）
  Composer.Tui（キー購読/IME/native-cursor/width）  Composer.Web（textarea等/OS IME/ゲート）
  Chunk.*（読み取り表示, opentui markup）            Web 用 View（DOM markup）
  effect 層（persist/analyze/export, packages/data） effect 層（同 packages/data）
```

## 命名

| 役割 | 名前 | 補足 |
|---|---|---|
| 編集面（差し替え族の名前空間） | `Composer` | `Composer.Tui` / `Composer.Web` |
| 契約（props/port） | `ComposerProps` | 両実装が満たす単一インターフェース |
| 入出力ドキュメント | `EntryDraft` | raw を型で隠す（TUI=ローマ字ログ / Web=確定テキスト） |
| 意図の列挙 | `ComposerIntent` | submit/cancel/edit/delete/navigate/search/exit |
| headless ロジック | `useComposer(target)` | state + handlers を返す |

`Chunk` は読み取り表示の名前空間として残す（`New`/`Edit` は撤去）。

## 移行シーケンス（各段で全テスト緑を維持・独立 PR）

- **A. 純粋ロジックを core へ移設**
  `conversion/pipeline` と `controller` の intent/cursor ロジックを `packages/core` へ。
  （romaji/records は既に core。`width`/`native-cursor` は TUI 専用なので残す）
- **B. zustand store 導入**（core に platform 非依存で）
  `document`/`cursor`/`editing` slice から。ref 二重持ちを撤去。effect 層は subscribe に。
- **C. New+Edit → Composer 統合**（headless `useComposer` + `Composer.Tui`）
  `native-cursor`/`width` を `Composer.Tui` の内側へ封印。`Chunk` を読み取り専用に純化。
- **D.（後日）`Composer.Web` + `apps/web`**
  決定 5 のゲートをここで実装。

A→B の順序は、store の action が core の純関数を呼ぶため core が先に要ることによる。

## 不変条件（この設計が壊してはいけないもの）

- 記録モデル（raw・凍結リテラル・freeze, `docs/RECORDS.md`）は不変。
- ペイン/単一カーソルの操作モデル（`docs/PANES.md`）は不変。
- 既存テスト（現状 280 件）を各段で緑に保つ。
