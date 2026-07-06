/**
 * サーバ（Hono ルート）とクライアント（fetch ラッパ）で共有する API の型。
 * DB 由来の型は @zakki/data から type-only で再輸出する（JSON 直列化可能なもののみ）。
 */
import type { AliveNode, GraphData, GraphDelta } from "@zakki/data/graph/queries.ts";
import type { Chunk, ChunkUserTag, Correction, Tag } from "@zakki/data/db/schema.ts";
import type { RelatedChunk } from "@zakki/data/embedding/semantic.ts";

export type { AliveNode, GraphData, GraphDelta, RelatedChunk };
export type { GraphEdge, GraphNode } from "@zakki/data/graph/queries.ts";
export type { Chunk, ChunkUserTag, Correction, Tag };

export interface HealthResponse {
  engine: string;
  embedder: boolean;
}

export interface DateChunkRequest {
  /** 省略時はサーバのローカル日付（当日） */
  date?: string;
}

/** バッファ読み出し（GET /api/chunks/:id）: チャンク本体 + 子チャンク列 */
export interface ChunkChildrenResponse {
  chunk: Chunk;
  children: Chunk[];
}

/** バッファ保存（PUT /api/chunks/:id/children）。converted は凍結リテラルマーカー付き可 */
export interface SaveChildrenRequest {
  converted: string;
}

export interface SaveChildrenResponse {
  children: Chunk[];
}

/** 本文（コンテナ名）変更（PATCH /api/chunks/:id） */
export interface RenameChunkRequest {
  content: string;
}

export interface SetUserTagsRequest {
  names: string[];
}

export interface ConvertRequest {
  kana: string;
  leftContext?: string;
}

export interface ConvertResponse {
  candidates: string[];
}

/** かな → 確定変換の学習・キャッシュ（ConversionPipeline のシード用） */
export interface ConversionStateResponse {
  corrections: Record<string, string>;
  cache: Record<string, string>;
}

export interface SaveConversionRequest {
  kana: string;
  converted: string;
}

export interface SaveCorrectionRequest {
  kana: string;
  chosen: string;
}

export interface RelatedResponse {
  items: RelatedChunk[];
}

export interface ApiError {
  error: string;
}
