import type { Chunk, Link } from "@zakki/data/db/schema.ts";

/**
 * グラフビューの型定義。かつてここにあったサーバ側 SQL クエリ（getGraph /
 * getGraphDelta。getCrypto による復号込み）は #45 で撤去された: グラフの
 * 読み出しは web クライアントが RxDB replication のローカルレプリカから導出する
 * （apps/web/src/client/store/graph-docs.ts）。型はモデル（schema.ts の
 * {@link Chunk} / {@link Link}）から派生させたまま残し、schema の列変更を
 * 型エラーとして検出する（#50）。
 */

/**
 * グラフビューのノード = chunk ツリーの全ノード（日付チャンク・コンテナ・本文）。
 * childCount / descendantCount は列に持たない派生値（docs/CHUNKS.md §導出値と描画）。
 * parentId が null = 日付チャンク（トップレベル）。
 */
export interface GraphNode extends Pick<
  Chunk,
  "id" | "parentId" | "position" | "content" | "polarity"
> {
  /** 祖先（自身を含む）の日付チャンクの date */
  date: NonNullable<Chunk["date"]>;
  /** 自動タグ（chunk_tags 由来、スコア降順） */
  tags: string[];
  /** ユーザ明示タグ（chunk_user_tags 由来） */
  userTags: string[];
  /** 直接の子数。0 なら葉（〇）、>0 ならコンテナ（◆） */
  childCount: number;
  /** 総子孫数。ノード半径のスケールに使う */
  descendantCount: number;
}

/**
 * グラフビューのエッジ。links（from < to 正規化済み）+ 導出の時系列リンク（chrono）。
 * 列は {@link Link} から派生（"chrono" のみ保存しない導出 origin）。
 */
export interface GraphEdge {
  from: Link["fromChunkId"];
  to: Link["toChunkId"];
  score: Link["score"];
  origin: Link["origin"] | "chrono";
}

export interface GraphData {
  /** 差分取得（撤去済み）の名残り。RxDB 由来のローカル導出では空文字固定 */
  version: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}
