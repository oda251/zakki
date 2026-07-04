/**
 * サーバ（Hono ルート）とクライアント（fetch ラッパ）で共有する API の型。
 * DB 由来の型は @zakki/data から type-only で再輸出する（JSON 直列化可能なもののみ）。
 */
import type { GraphData } from "@zakki/data/graph/queries.ts";
import type { SessionWithTags } from "@zakki/data/session/repository.ts";
import type { Chunk, Entry, Session } from "@zakki/data/db/schema.ts";
import type { RelatedChunk } from "@zakki/data/embedding/semantic.ts";

export type { GraphData, SessionWithTags, RelatedChunk };
export type { GraphEdge, GraphNode } from "@zakki/data/graph/queries.ts";
export type { Chunk, Entry, Session };

export interface HealthResponse {
  engine: string;
  embedder: boolean;
}

export interface CreateSessionRequest {
  name: string;
  /** 省略時はサーバのローカル日付（当日） */
  date?: string;
}

export interface DefaultSessionRequest {
  /** 省略時はサーバのローカル日付（当日） */
  date?: string;
}

export interface RenameSessionRequest {
  name: string;
}

export interface SetSessionTagsRequest {
  names: string[];
}

export interface SessionEntryResponse {
  entry: Entry | null;
  chunks: Chunk[];
}

export interface SaveEntryRequest {
  raw: string;
  converted: string;
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
