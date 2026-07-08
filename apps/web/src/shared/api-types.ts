/**
 * サーバ（Hono ルート）とクライアント（fetch ラッパ）で共有する API のレスポンス型。
 * DB 由来の型は @zakki/data から type-only で再輸出する（JSON 直列化可能なもののみ）。
 * リクエスト側の型は api-schemas.ts の valibot スキーマから派生する（issue #49）。
 */
import type { Chunk, ChunkUserTag, Correction, Link, Tag } from "@zakki/data/db/schema.ts";

export type { GraphData, GraphEdge, GraphNode } from "@zakki/data/graph/queries.ts";
export type { Chunk, ChunkUserTag, Correction, Link, Tag };

export interface ApiError {
  error: string;
}
