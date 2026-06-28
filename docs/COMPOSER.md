# 入力アーキテクチャ — 二軸の切り分けと差し替え（2026-06-28 決定）

本書は「入力（書く・変換する・カーソル）」のアーキテクチャを再設計する決定記録。
将来の Web 版（`apps/web`）を見据え、次の**二軸**で分解し、それぞれを差し替え可能にする。

1. **デザイン（presentation）＝プラットフォーム切り分け**。`tui` / `web` で別実装。
2. **コアロジック＝機能切り分け**。変換・records・論理カーソル/intent・検索 …を機能単位で
   interface 化し DI で差し替え。

本体（`App`）は**両軸を受け取るだけの headless オーケストレーション**にし、
デザイン一式とロジック群を独立に差し替えられる状態にする。記録モデル
（`docs/RECORDS.md`）・ペイン/単一カーソルの操作モデル（`docs/PANES.md`）は不変。

## 背景と問題

現状（`apps/tui/src/tui/App.tsx`, 1150 行）は入力に関して 3 つの関心事が絡まる。

1. ソフトウェア IME（ローマ字→かな→漢字の自動変換）— `convertRomaji`,
   `ConversionPipeline`, corrections 学習, Tab ローテーション。
2. カーソル機構 — `applyEditKey`（論理）、端末縦棒＋セル幅（`native-cursor.ts`, `width.ts`）。
3. アプリ本体 — ペイン・チャンク表示・ダイアログ・検索・永続化・解析/export。

加えて `useKeyboard`（約 220 行）がモーダル優先を手続きで握り、状態は useState の山＋
ref 二重持ち（`bufferRef`/`editRef`/`cursorRef`）。「`Input.Tui`/`Input.Web` に割る」だけだと
表示部品ごとに platform 変種が要り `Chunk.Edit.Tui` …と**「部分×プラットフォーム」の
マトリクス爆発**を起こす。これは「デザインとロジックを同じ軸で割ろうとする」のが原因。

## 決定

### 軸1: デザイン＝プラットフォーム切り分け（差し替え可能）

presentation は platform 名前空間の compound にし、**要素とスタイルを一式**で持つ
（`Composer = { Tui, Web }` と対称）。**抽象 token レイヤは作らない**（「token か CSS class か」の
二重管理を避ける）。

```
Chunk.tui = { Shell, View, Digest }   // opentui style を内包。apps/tui が使う
Chunk.web = { Shell, View, Digest }   // CSS class / styled を内包。apps/web が使う
Composer.Tui / Composer.Web           // 編集面の platform 実装
```

- **viewer と composer の関連付け＝同じ platform 名前空間に同居**。`Chunk.web` の中で
  `View` も `Composer` host も同じ `.chunk` を参照する＝CSS が自然に共通要素になり、
  インライン編集の見た目一致が**構造的に**担保される。`Chunk.tui` も同 style を共有。
- `Chunk.Shell` が枠（`id`・余白・選択強調）を持ち、中身（`View` か `Composer`）だけ差し替える。
  これで `native-cursor` の対象 `id` と追従スクロールのアンカーが**編集状態に依らず安定**する
  （今は `View`/`Edit` を box で巻き直している, `App.tsx:1047-1060`）。
- 跨プラットフォームで共有するのは**型 contract だけ**（実値は cell と px で別物なので共有しない）。

```ts
// packages/core: 値も markup も持たない。状態の“形”だけ
interface ChunkPresentation<Style> { base: Style; selected: Style; pending: Style }
// apps/tui/.../chunk.tui.ts
export const chunkTui: ChunkPresentation<OpentuiStyle> = {
  base: { fg: "#ccc", wrapMode: "word" }, selected: { fg: "#fff" }, pending: { fg: "#777" },
};
// apps/web/.../chunk.web.ts
export const chunkWeb: ChunkPresentation<string> = {
  base: "chunk", selected: "chunk--selected", pending: "chunk--pending",
};
```

`opentui` と DOM を 1 モジュールに混ぜないため、`chunk.tui` は `apps/tui`、`chunk.web` は
`apps/web` に置く（バンドル分離）。core は型のみ。

### 軸2: コアロジック＝機能切り分け（差し替え可能）

機能単位の純粋モジュールを `packages/core` に置き、**各機能を interface 化して DI で差し替え**。

- 変換: `KanaKanjiEngine` interface（`identity` / `anco` を差し替え, 既存）＋ `ConversionPipeline`。
- records（raw 模型）/ 論理カーソル・intent（`controller`）/ keymap / 検索。
- 永続化・解析・埋め込み・export は `AppProps`（`db`/`engine`/`embedder`/`sync`）で注入済み＝
  既にこの DI パターン。新機能も同じ流儀で port を切る。

これらは React・opentui・DOM に非依存（headless）。両 platform から再利用する。

### App は両軸を受け取る headless オーケストレーション

`App` は「状態・effect・intent」を持つが、**描画は注入された platform 一式**
（`Chunk.<platform>` / `Composer.<platform>`）に、**機能は注入された port**に委譲する。
合成点（`apps/tui` の entry / `apps/web` の entry）で platform デザインと機能実装を束ねる。

### 自動変換は「ライブ末尾」だけの現象 → 汎用 IME は不要

変換は**常に追記点（ライブ末尾）でのみ**走り、修正（correct）は変換しないプレーン編集
（`controller.ts` コメント「バッファ途中の非同期変換ができない」）。「文の途中で IME 変換」は
**存在しない**ので、Web でもブラウザ内に汎用 IME を実装する必要はない。追記面はカーソル
末尾固定で `変換済み + 淡色 pending + 末尾キャレット` を描くだけ。

### New と Edit を `Composer` に統合

現在の `Chunk.New`（追記・IME あり）と `Chunk.Edit`（修正・プレーン）の分裂は端末の都合。
1 つの `Composer`（唯一の編集面）に統合し `mode` で分岐する。

- `append` … 変換パイプラインを通す。末尾固定・pending あり。
- `correct` … プレーン編集。可動カーソル。変換なし。**両 platform 共通**（一貫性優先で
  Web も途中変換しない）。

コンポーネントは 1 個。挙動は `mode` で分岐し、**platform では分岐しない**。

### カーソルは「論理」と「視覚」の 2 層

| 層 | 軸 | 実装 |
|---|---|---|
| 論理カーソル（offset・編集操作・移動 intent） | 軸2（機能・共有） | `applyEditKey` 等を core へ |
| 視覚カーソル（画面位置） | 軸1（platform・各自） | TUI=`native-cursor`+`width` / Web=ブラウザのキャレット |

`width.ts`/`native-cursor.ts` は **Web からは不要**。`Composer.Tui` の内側に封印し、
ロジック層・`App` からは参照しない。

### raw 模型は不変。Web 入力はゲートでルート分岐

raw には既に「変換対象のローマ字ライブ末尾」と「verbatim な凍結リテラル（ペースト）」の
2 種がある。Web 入力はこれに乗せる:

- OS IME 入力（既に日本語）→ “打鍵ペースト”扱いで凍結リテラル直行。
- ローマ字入力（ASCII）→ ライブ末尾で自動変換。

ゲート（`Composer.Web` 内）: **UA 等で「PC（非モバイル）」かつ「本文が ASCII ローマ字のみ」の
ときだけ自動変換**。それ以外は OS IME → 凍結リテラル直行。モデル変更は不要。

### 状態管理を zustand へ（軸2 の一部・headless）

useState の山＋ref 二重持ちを **platform 非依存の zustand store** に統合する。

- `store.getState()` が常に最新を同期で返す → 連続キー取りこぼし回避の
  `bufferRef`/`editRef`/`cursorRef` を**撤去**。
- store は `opentui`/DOM を import しない。論理状態のみ（raw・editing・cursor・mode・dialog/menu・search）。
  視覚系（scrollbox ref・native-cursor・width・DOM キャレット）は platform 層に置く。
- 副作用（永続化 debounce・解析・埋め込み・export）は store を `subscribe` する effect 層へ。
- slice: `document` / `editing(composer)` / `cursor` / `ui` / `search`。vanilla store にして
  opentui-react と web-react の双方から `useStore(selector)`。テストは「store→action→assert」。

## 命名

| 役割 | 名前 | 補足 |
|---|---|---|
| デザイン名前空間（軸1） | `Chunk.<platform>` / `Composer.<platform>` | 要素＋style を内包 |
| デザイン契約（型・core） | `ChunkPresentation<Style>` / `ComposerProps` | 状態名・props の形だけ共有 |
| 入出力ドキュメント | `EntryDraft` | raw を型で隠す |
| 意図の列挙 | `ComposerIntent` | submit/cancel/edit/delete/navigate/search/exit |
| 編集面の headless ロジック | `useComposer(target)` | state + handlers |

## 移行シーケンス（各段で全テスト緑・独立 PR）

- **A. 純粋ロジックを core へ移設（軸2 の土台）** ✅
  `conversion/{engine,pipeline}`・`input/{controller,keymap}` を `packages/core` へ。
- **B. zustand store 導入**（core・platform 非依存）。ref 二重持ち撤去、effect は subscribe へ。
- **C. デザインの軸1 化**：`Chunk.Shell` + `Chunk.tui` 抽出、New+Edit → `Composer`（`useComposer` +
  `Composer.Tui`）、`native-cursor`/`width` を `Composer.Tui` 内へ封印。`App` を
  「platform 一式＋port を受け取る headless オーケストレーション」に整理。
- **D.（後日）`Composer.Web` + `Chunk.web` + `apps/web`**。ゲート（上記）を実装。

A→B→C の順は、store/Composer が core の純関数に乗るため。

## 不変条件

- 記録モデル（`docs/RECORDS.md`）・ペイン/単一カーソル（`docs/PANES.md`）は不変。
- 既存テスト（現状 280 件）を各段で緑に保つ。
