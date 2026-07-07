import { eq, inArray, isNull } from "drizzle-orm";
import { AAD } from "@zakki/core/crypto/aad.ts";
import type { Db } from "@zakki/data/db/client.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import { chunks, chunkTags, tags } from "@zakki/data/db/schema.ts";
import { batched } from "@zakki/data/util/batch.ts";
import type { TagScore } from "./apply.ts";

/**
 * 解析パス（backend/analysis の analyzeAll / analyzeChanged）専用の読み取りクエリ
 * （issue #53）。schema への依存を data に封じ、backend は結果の平文解析に徹する。
 * DbError への写像は呼び出し側（解析サービス）の tryDbAsync 境界で行う。
 */

/** 解析対象チャンク 1 件。content は格納値のまま（暗号 ON は暗号文。復号は呼び出し側） */
export interface AnalyzableChunk {
  id: number;
  content: string;
  updatedAt: string;
  polarity: number | null;
}

/** 解析対象チャンクの全件読み（全量パス用）。日付チャンク（構造ノード, content = 日付）は含めない */
export async function listAnalyzableChunks(db: Db): Promise<AnalyzableChunk[]> {
  return await db
    .select({
      id: chunks.id,
      content: chunks.content,
      updatedAt: chunks.updatedAt,
      polarity: chunks.polarity,
    })
    .from(chunks)
    .where(isNull(chunks.date));
}

/**
 * 解析対象チャンクの id + updatedAt だけを読む（増分パスの第 1 段）。
 * 変更ゼロのパスでは content 転送が一切発生しないよう、content は取得しない。
 */
export async function listAnalyzableChunkHeads(
  db: Db,
): Promise<{ id: number; updatedAt: string }[]> {
  return await db
    .select({ id: chunks.id, updatedAt: chunks.updatedAt })
    .from(chunks)
    .where(isNull(chunks.date));
}

/** 指定チャンクの格納 content を読む（増分パスの第 2 段。暗号 ON は暗号文のまま） */
export async function readChunkContents(
  db: Db,
  chunkIds: readonly number[],
): Promise<Map<number, string>> {
  const result = new Map<number, string>();
  for (const ids of batched(chunkIds, 200)) {
    const rows = await db
      .select({ id: chunks.id, content: chunks.content })
      .from(chunks)
      .where(inArray(chunks.id, ids));
    for (const row of rows) result.set(row.id, row.content);
  }
  return result;
}

/** 指定チャンクの永続化済み極性を読む（増分パスの旧極性 = 変化判定の基準） */
export async function readChunkPolarities(
  db: Db,
  chunkIds: readonly number[],
): Promise<Map<number, number | null>> {
  const result = new Map<number, number | null>();
  for (const ids of batched(chunkIds, 200)) {
    const rows = await db
      .select({ id: chunks.id, polarity: chunks.polarity })
      .from(chunks)
      .where(inArray(chunks.id, ids));
    for (const row of rows) result.set(row.id, row.polarity);
  }
  return result;
}

/**
 * DB に現在書き込まれているタグを「チャンク id → タグ列（平文名+スコア）」で読む。
 * 全量パスが plan の差分・bump 判定に使う旧状態（スナップショットに頼らない実体）。
 * 順序は computeTags と同じ（スコア降順・名前昇順）に揃え、tagListEquals での比較を
 * 決定的にする。暗号 ON はタグ名を復号する（全量パスは全 content を復号済みで、
 * 追加コストは無視できる）。
 */
export async function readChunkTagScores(db: Db): Promise<Map<number, TagScore[]>> {
  const crypto = getCrypto(db);
  const rows = await db
    .select({ chunkId: chunkTags.chunkId, score: chunkTags.score, name: tags.name })
    .from(chunkTags)
    .innerJoin(tags, eq(chunkTags.tagId, tags.id));
  const result = new Map<number, TagScore[]>();
  for (const row of rows) {
    const name = crypto === undefined ? row.name : crypto.decString(row.name, AAD.tagName);
    const list = result.get(row.chunkId) ?? [];
    list.push({ name, score: row.score });
    result.set(row.chunkId, list);
  }
  for (const list of result.values()) {
    list.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }
  return result;
}
