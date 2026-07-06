# 統合チャンクモデル — chunk 自己参照ツリー（2026-07-06 決定）

`sessions` / `entries` を廃止し、**chunk 単一の自己参照ツリー**へ統合する決定記録。
`CONCEPT.md` データモデル素案（entries / sessions 前提）と、セッション導入
（PR #14）のモデルを本決定で上書きする。

## 動機

- グラフ描画で「セッション外チャンクへのリンク」を集約ノード（別形状）で出したい、
  という要件を詰めた結果、「子グラフを持つノードは集約形状・潜れる」という汎用
  ルールに一般化でき、セッションはその特殊ケースにすぎないと判明した
- `entries` は session と 1:1（`entries_session_unique`）で date も複製、純粋な
  冗長中間層だった
- `entries.raw` の凍結部分は変換後リテラル（PUA 包み）であり、ローマ字原文は
  freeze 時点で既に失われている。「再変換のため raw を残す」（CONCEPT.md）は
  現実装で成立していないため、raw を落としても失う能力はない

## データモデル

```
chunks(
  id            integer PK
  parent_id     integer? → chunks.id (cascade)   -- NULL = トップレベル（日付チャンク）
  position      integer                          -- 親バッファ内の出現順
  content       text                             -- 変換後テキスト（本文の唯一の保持者）
  date          text?                            -- 日付チャンクのみ YYYY-MM-DD（平文）
  polarity      real?
  created_at / updated_at
)
-- unique (parent_id, position)
-- unique (date) where parent_id is null        -- 日付チャンクは 1 日 1 件
links(from_chunk_id, to_chunk_id, score, origin) -- 変更なし。任意階層で張れる
```

- **entries / sessions テーブルは削除**。`raw` / `converted` 列も削除する
  - 打ちかけ行（Enter 前のライブ末尾ローマ字）はリロードで失われる。受容（2026-07-06 決定）
  - 編集バッファは子チャンクの content 列から再構成する（`wrapPaste(content)` を
    改行連結 = 全行が凍結リテラルの raw）
- `session_tags` → `chunk_user_tags(chunk_id, name, name_fingerprint)` に一般化
  （任意チャンクへのユーザ明示タグ。自動タグ `chunk_tags` とは従来どおり別名前空間）
- 「グラフノード」クラスは今後も**描画/転送 DTO**（`GraphNode`）にとどめる。
  `nodes` テーブルは作らない

### 日付チャンク

- content = 日付をタイトルとするトップレベルチャンク（`parent_id IS NULL`）。
  旧デフォルトセッションの後継。`date` 列は平文（旧 sessions.date と同方針、
  E2E でも日付はメタデータとして受容）
- 旧・名前付きセッションは「日付チャンク直下の、名前を content に持つ子チャンク」
  へ解消される。特別扱いする概念は残さない
- **時系列リンク**: 日付チャンク同士は前後方向で最も近接する最大 2 つ
  （直前の日付・直後の日付）とリンクする。**保存せずグラフクエリで導出**する
  （date 昇順に隣接チェーン。過去日の後挿入でも常に正しく、links の再張替えが不要）

## 導出値と描画

グラフクエリが再帰 CTE で付与する派生値（**列としては持たない**）:

| 派生値            | 定義       | 用途                                       |
| ----------------- | ---------- | ------------------------------------------ |
| `childCount`      | 直接の子数 | 形状: `0 → 〇`（葉）、`>0 → ◆`（コンテナ） |
| `descendantCount` | 総子孫数   | ノード半径（対数スケールで拡大）           |

- 色（series 8 スロット）は表示中階層の直下コンテナ単位で割当、8 超は neutral
  （現行のセッション色規則の一般化）
- **表示スコープ**（2026-07-06 改訂）: 描画上「セッション」と呼ぶのは子ノードを
  持つチャンク。ドリル中チャンク P の直下子に閉じた表示をベースとしつつ、
  表示中ノードからセッション外のノードへリンクがある場合は**そのノード自体を
  グラフ中に表示する**（祖先コンテナへの畳み込みはしない）。
  - 外部ノードのシングルクリック = セッション移動せず選択のみ
  - 外部ノードのダブルクリック = そのノードが所属するセッション（親チャンク）へ
    移動し、当該ノードが選択された状態に遷移する

## ナビゲーション

- クリック = 選択（従来どおり）
- ダブルクリック = そのチャンクの中へ潜る（ドリルイン。バッファも当該チャンクへ切替）
- Escape = 親階層へ戻る（親が日付チャンク以深ならバッファも親へ切替。トップレベル
  では表示のみ全体へ戻し、バッファは維持する）
- **パンくずリスト**を画面上に常置: `2026-07-06 > <チャンクtitle> > …`。
  セグメントクリックでその階層へジャンプ。title は `makeTitle(content)` を流用

## 入力・保存

- 「チャンクを開いて typing」= そのチャンクを親とする子バッファへの入力。
  `freezeLiveTail` / `chunkText`（Enter のみ区切り, docs/RECORDS.md）を
  **全階層で同一に再利用**する
- 保存（saveChildren）は **content 突き合わせで既存 id を安定させる**投影:
  content 完全一致（出現順）→ 残りは位置対応、で草稿へ既存 id を割り当て、
  どの草稿にも対応しない行だけを削除する。単純な position キー upsert だと
  上の行の削除で全行の id が付け替わり、無関係なコンテナのサブツリーが
  余剰削除されるため（2026-07-06 実装時決定）。
  **行そのものを消した場合は、その行の子孫ごと cascade で消える**
  （投影の破壊性は「消した行」に限定される）
- **コンテナ（子を持つチャンク）も親バッファの position 空間を共有する**:
  コンテナは「親バッファの 1 行が子を持ったもの」であり、行として編集・削除できる。
  これにより投影 upsert がコンテナを壊す position 衝突が原理的に起きない
  （旧・名前付きセッションは移行時にデフォルト本文行の直後の position に置かれる）
- **コンテナの作成に専用操作・API は無い**: 親バッファへ行を打ち、そのノードへ
  潜って書き始めることが作成。リネームは親バッファでの行編集（または
  `PATCH /api/chunks/:id`。親バッファを開いていない文脈用）
- **バッファ（raw）は子チャンクの content から再構成する**（`buildRaw`:
  各行を凍結リテラル + 改行で連結）。raw / converted 列は存在しない
- TUI は従来挙動を維持: 当日の日付チャンク直下への入力。詳細ペインの
  過去チャンク編集・削除は raw 再構成を経ず `updateChunkContent` / `deleteChunk`
  を id 直接で呼ぶ（当日バッファ内の行だけが in-memory raw 経由）

## web API（旧 /api/sessions の置き換え）

| メソッド | パス                     | 役割                                          |
| -------- | ------------------------ | --------------------------------------------- |
| POST     | /api/chunks/date         | 日付チャンクの取得/作成（クライアント起点）   |
| GET      | /api/chunks/:id          | バッファ読み出し（chunk + children）          |
| PUT      | /api/chunks/:id/children | バッファ保存（converted → chunkText 投影）    |
| PATCH    | /api/chunks/:id          | content（コンテナ名）変更                     |
| DELETE   | /api/chunks/:id          | サブツリー削除                                |
| PUT      | /api/chunks/:id/tags     | ユーザタグ全置換                              |
| GET      | /api/chunks/:id/related  | 末尾子（無ければ自身）の意味的近傍            |
| GET      | /api/graph(?since=)      | 全ノード + 派生値 + links + chrono 導出エッジ |

## 解析・E2E への影響

- タグ付け・極性・embedding・links は chunk id 基準のまま無変更。ただし
  **日付チャンク（date 非 NULL）は解析・埋め込みの対象外**（content = 日付の
  構造ノードであり、日付同士の見かけの類似で無意味なリンクが張られるため）
- **コンテナ行（子を持つチャンク）は本文チャンクとして扱う**（検索・極性集計・
  digest・エクスポート・解析に含める）: コンテナの content は「親バッファの
  1 行」として実在するユーザ入力であり、見出しも記録の一部（意図した挙動）
- E2E（Phase 5b）: `content` は暗号化（AAD は従来 `chunk.content`）、`date` は
  平文、ユーザタグは fingerprint 一意（AAD `chunkUserTag.name`）。
  **日付チャンクの content は date と同値の平文**（date 平文方針の帰結）
- 移行（0010）は SQL のみで復号できないため、移行前から暗号 ON だった DB では
  旧 AAD（session.name / sessionTag.name）の暗号文が残る。`aad_fixups` テーブルに
  付替え予約を残し、アンロック直後に `applyAadFixups` が新 AAD へ暗号化し直す
  （平文からの初回暗号化 `migratePlaintextToEncrypted` では予約を消すだけ）

## マイグレーション

1. 日付チャンクを sessions.date の distinct から生成（`date` 列に設定）
2. デフォルトセッションの chunks → 該当日付チャンクの子へ `parent_id` 付替え
3. 名前付きセッション → content = name の子チャンクを日付チャンク直下に作成し、
   その chunks をさらにその子へ
4. `session_tags` → 対応チャンクの `chunk_user_tags` へ移送
5. entries / sessions を drop（links / chunk_tags / embeddings は chunk id 不変のため無変更）

## 実装フェーズ

1. **スキーマ + data 層 + マイグレーション**（sessions/entries 廃止、repository 統合）
2. **グラフクエリ + API**（childCount / descendantCount、時系列リンク導出、集約畳み込み）
3. **web UI**（◆/〇 描画・サイズ、dblclick ドリル・Escape・パンくず、Composer の任意チャンク対応）
