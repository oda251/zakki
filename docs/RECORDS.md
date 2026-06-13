# 記録モデル — 変換後テキストを正本に（2026-06-14 決定）

本書は変換・編集・永続化の中核設計を更新する決定記録。`CONCEPT.md` の一部記述
（「raw がエントリの正本」「話題転換検出で隣接文をまとめる」）を本決定で上書きする。

## 背景と問題

現行は **`raw`（ローマ字打鍵ログ）がエントリ全体の正本**で、起動・保存のたびに
`raw` → かな（`convertRomaji`, `src/romaji/convert.ts`）→ 漢字
（`ConversionPipeline.apply`, `src/conversion/pipeline.ts`）と全文を再導出している。
変換は**かなセグメント文字列をキー**にキャッシュ・学習する（pipeline の cache、
`corrections` テーブル）ため**位置に依存しない**。

この設計では「特定箇所の誤変換だけを手動で直す」が自然に書けない:

- `corrections`（かな→確定表記）はグローバルで、同音異義（橋/箸）が暴発する。
- 位置限定の上書きは、変換がかなキーのため別機構（位置→上書き）が要る。
- 本文上のクリック修正は、OpenTUI で折り返し＋スクロール下の x,y→文字位置 対応が
  取りにくく、要素技術リスクが高い。

## 決定

**確定したチャンクは「変換後テキスト」を凍結記録とする。**
末尾の入力中チャンクだけがライブ（raw＋変換パイプライン）で、それ以外は確定＝
凍結された変換後テキストとする。

### 実装: 凍結リテラルを raw に埋め込む（採用）

`raw` を引き続き正本としつつ、確定したチャンクは raw 内に**凍結リテラル**
（ペースト機構の PUA マーカー `PASTE_OPEN…PASTE_CLOSE`, `src/conversion/paste.ts`）
として埋め込む。リテラルは `convertRomaji` / `segmentKana` / `chunkText` /
`deleteLastUnit` の各段で「変換せず素通し」されるため確定後は再変換されない
（＝誤変換の手動修正がそのまま固定される）。既存の変換・チャンク化・永続化・
起動ロードがそのまま動き、専用の committed/tail 分離やスキーマ変更・移行を要しない。
当初案（committed[] と tail raw の分離）より変更が小さく安全なため採用する。
凍結ロジックは `src/entry/records.ts`。

### データモデル

- `raw`（entries.raw）が正本。確定チャンク＝raw 内の凍結リテラル領域、
  末尾の入力中チャンク＝最後のリテラル以降のローマ字。
- **確定境界**: 末尾の入力中チャンク以外はすべて確定。保存（デバウンス）時に
  `freezeLiveTail` が、完結かつ変換 settled な文を（最後の1文を除き）リテラルへ畳む。
- 永続化・チャンク化は従来どおり `chunkText(converted)` 由来（`chunks.content`）。
  リテラルは atomic チャンクとして 1 チャンク 1 行になる。

### 永続化

- `raw`（凍結リテラル込み）を `entries.raw` に保存。`chunks` は従来どおり
  `chunkText(converted)` 由来で `chunks.content` に保存（検索・エクスポート・解析が読む）。
- 起動: `entries.raw` を読み、凍結リテラルは素通し（再変換されない）、ライブ末尾のみ
  `conversion_cache`（`src/conversion/cache.ts`）をシードして変換する。
- 移行不要: 既存 raw はリテラル無しの全ローマ字。初回保存時に `freezeLiveTail` が
  確定文を順次リテラルへ畳む（破壊的変更なし）。

### 修正 UX（専用機構なし）

- 確定チャンク（メイン本文の各行）をクリック → 修正モードへ。元テキストを参照表示し、
  ローマ字で打ち直す（`src/tui/App.tsx` の `editing` / `commitEdit`）。
- 確定で、その**凍結リテラル領域を打ち直した確定テキストで置換**（空確定なら削除）。
  箇所限定・専用上書きテーブル不要・かなキー問題なし・グローバル学習を汚さない。

### 話題グルーピング: 廃止

embedding で隣接文を 1 チャンクにまとめる二次区切り（`TopicGrouper`
`src/chunk/grouper.ts`、`groupCompleted` `src/entry/autosave.ts`）は「全文を raw から
再チャンク化」する前提で凍結記録と噛み合わないため**廃止**する。チャンク＝
**句点（。！？）・改行の決定的区切りのみ**（`chunkText` `src/chunk/chunker.ts` の
一次区切り）。embedding は関連表示・セマンティック検索でのみ使う。

### 帰結（受容するトレードオフ）

- 確定済みテキストへのエンジン改善の**遡及再変換は不可**（普通のノートアプリと同じ）。
- raw による「全文決定的再導出」性は末尾のみに縮小する。

### azooKey / OS IME との関係

将来 変換を OS IME（azooKey 等、GUI / モバイル前提）へ委譲する場合も、
**記録形式（確定テキスト）は同一**。入力部（ライブ末尾の生成）だけ差し替えればよく
移行が容易。TUI 継続中は端末が IME プリエディットを扱えない（`CONCEPT.md` §形態）ため
自前変換を維持する。

## 実装（実施済み）

- 凍結ロジック `src/entry/records.ts`（`parseBlocks` / `liveTailStart` /
  `firstSentenceRomajiLen` / `freezeLiveTail`）＋テスト。
- `src/tui/App.tsx`: 確定チャンクを 1 行ずつクリック可能に描画＋ライブ末尾入力、
  保存時に `freezeLiveTail` で凍結、クリックで修正モード（打ち直し）。
- 廃止: `TopicGrouper` / `groupCompleted` と依存 `src/embedding/topics.ts`、
  `displayTail` / `countChunks`（旧表示モデル）。`persistEntry` から grouper 引数を除去。
- 据え置き: `convertRomaji` / `ConversionPipeline` / `segmentKana` / エンジン
  （anco / zenz）。`corrections`（グローバル学習）はライブ入力の初手品質向上として残す。

## 既知の限界 / 今後

- 修正は「打ち直し」（カーソル移動が無い追記専用モデルのため、文中の一語だけを
  ピンポイント編集はできない）。
- 凍結時の変換は settled を待つ（未変換のうちは畳まない）。確定文の変換が
  遅延中はライブのまま残り、変換到着後に凍結される。
