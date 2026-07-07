/**
 * サーバ（Hono ルート）とクライアント（fetch ラッパ）で共有する API のレスポンス型。
 * DB 由来の型は @zakki/data から type-only で再輸出する（JSON 直列化可能なもののみ）。
 * リクエスト側の型は api-schemas.ts の valibot スキーマから派生する（issue #49）。
 */
import type { AliveNode, GraphData, GraphDelta } from "@zakki/data/graph/queries.ts";
import type { Chunk, ChunkUserTag, Correction, Tag } from "@zakki/data/db/schema.ts";
import type { RelatedChunk } from "@zakki/data/embedding/semantic.ts";

export type { AliveNode, GraphData, GraphDelta, RelatedChunk };
export type { GraphEdge, GraphNode } from "@zakki/data/graph/queries.ts";
export type { Chunk, ChunkUserTag, Correction, Tag };

/** バッファ読み出し（GET /api/chunks/:id）: チャンク本体 + 子チャンク列 */
export interface ChunkChildrenResponse {
  chunk: Chunk;
  children: Chunk[];
}

export interface SaveChildrenResponse {
  children: Chunk[];
}

export interface ConvertResponse {
  candidates: string[];
}

/** かな → 確定変換の学習・キャッシュ（ConversionPipeline のシード用） */
export interface ConversionStateResponse {
  corrections: Record<string, string>;
  cache: Record<string, string>;
}

export interface RelatedResponse {
  items: RelatedChunk[];
}

export interface ApiError {
  error: string;
}
