import { asc } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { toBytes } from "@zakki/data/db/blob.ts";
import type { Db } from "@zakki/data/db/client.ts";
import {
  aadFixups,
  chunkTags,
  chunks,
  chunkUserTags,
  conversionCache,
  corrections,
  cryptoMeta,
  embeddings,
  keyEnvelopes,
  links,
  replDocs,
  tags,
} from "@zakki/data/db/schema.ts";

/**
 * ジャーナル DB をまるごと別の DB へ写す（issue #136）。
 *
 * 単一ユーザ DB（`zakki-prod`）を per-user DB へ畳むための **一度きりの移行**。
 * 両者はスキーマが同じなので、行をそのまま運ぶだけで済む。
 *
 * 設計:
 * - **空の DB にしか入れない**。既存行があるところへ流すと id 衝突か重複になり、
 *   どちらも黙って壊れる（マージは意味論が決まらない）。移行は 1 回で、
 *   やり直すなら target を作り直す
 * - 順序は FK の親から。`chunks` は自己参照ツリーなので id 昇順で入れる
 *   （子は親より後に作られるため id が大きい）
 * - blob 列はトランスポートで表現が違う（blob.ts）ので、書く前に正規化する
 * - 照合は {@link verifyCopy}: 行数と内容ハッシュを両側で突き合わせる
 */

/** 写す順序。FK の親から並べる（chunks → それを参照するもの → 独立したもの） */
const TABLES = [
  { name: "chunks", table: chunks, order: chunks.id },
  { name: "tags", table: tags, order: tags.id },
  { name: "chunk_tags", table: chunkTags, order: chunkTags.chunkId },
  { name: "chunk_user_tags", table: chunkUserTags, order: chunkUserTags.id },
  { name: "links", table: links, order: links.fromChunkId },
  { name: "embeddings", table: embeddings, order: embeddings.chunkId },
  { name: "aad_fixups", table: aadFixups, order: aadFixups.id },
  { name: "corrections", table: corrections, order: corrections.kana },
  { name: "conversion_cache", table: conversionCache, order: conversionCache.kana },
  { name: "crypto_meta", table: cryptoMeta, order: cryptoMeta.id },
  { name: "key_envelopes", table: keyEnvelopes, order: keyEnvelopes.id },
  { name: "repl_docs", table: replDocs, order: replDocs.id },
] as const;

/** 1 回の INSERT に載せる行数。libSQL の文サイズ上限に当たらない範囲で大きめに */
const BATCH_ROWS = 200;

/** 表ごとの結果。移行ログにも照合にも使う */
export interface TableCount {
  readonly name: string;
  readonly rows: number;
}

/** 表ごとの照合結果 */
export interface TableComparison {
  readonly name: string;
  readonly sourceRows: number;
  readonly targetRows: number;
  /** 行の内容から作った SHA-256（16 進）。行数が同じでも中身が違えば割れる */
  readonly sourceHash: string;
  readonly targetHash: string;
  readonly matches: boolean;
}

/** blob（Buffer / ArrayBuffer）を書き込み前に揃える。それ以外はそのまま */
function normalizeValue(value: unknown): unknown {
  if (value instanceof ArrayBuffer) return Buffer.from(toBytes(value));
  if (value instanceof Uint8Array) return Buffer.from(toBytes(value));
  return value;
}

function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, normalizeValue(v)]));
}

/** ハッシュ用の安定した文字列。blob は 16 進、それ以外は JSON で表す */
function stableValue(value: unknown): string {
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) {
    return Array.from(toBytes(value), (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return JSON.stringify(value ?? null);
}

async function hashRows(rows: readonly Record<string, unknown>[]): Promise<string> {
  // 列順は drizzle の select が返すオブジェクトのキー順で、両側で同じ形になる。
  // 念のため名前で並べ替えてから畳む（片側だけ列順が変わっても割れないように）
  const text = rows
    .map((row) =>
      Object.keys(row)
        .sort()
        .map((key) => `${key}=${stableValue(row[key])}`)
        .join(""),
    )
    .join("");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// oxlint-disable-next-line typescript/no-explicit-any -- 表を一様に回すための最小限の緩め（列の型は表ごとに違う）
type AnyTable = SQLiteTable<any>;

/** 表の全行を決定的な順序で読む */
async function readAll(
  db: Db,
  table: AnyTable,
  order: Parameters<typeof asc>[0],
): Promise<Record<string, unknown>[]> {
  return await db.select().from(table).orderBy(asc(order));
}

/**
 * target が空（ジャーナルの表に 1 行も無い）かを確かめる。
 * 空でなければどの表に何行あるかを返す（呼び出し側が中止の理由に使う）。
 */
export async function findExistingRows(target: Db): Promise<TableCount[]> {
  const found: TableCount[] = [];
  for (const { name, table, order } of TABLES) {
    const rows = await readAll(target, table, order);
    if (rows.length > 0) found.push({ name, rows: rows.length });
  }
  return found;
}

/**
 * source の全行を target へ写す。**target は空である前提**
 * （{@link findExistingRows} で確かめてから呼ぶ）。
 *
 * 表ごとに読み切ってから書く。個人規模の日記（数千行）を想定した実装で、
 * ストリーミングはしない。
 */
export async function copyJournal(target: Db, source: Db): Promise<TableCount[]> {
  const copied: TableCount[] = [];
  for (const { name, table, order } of TABLES) {
    const rows = await readAll(source, table, order);
    for (let i = 0; i < rows.length; i += BATCH_ROWS) {
      const batch = rows.slice(i, i + BATCH_ROWS).map(normalizeRow);
      if (batch.length === 0) continue;
      // oxlint-disable-next-line typescript/no-explicit-any, typescript/consistent-type-assertions -- 表ごとに違う列型を一様に流す（列の対応は読み出したそのままで、写し替えはしない）
      await target.insert(table).values(batch as any);
    }
    copied.push({ name, rows: rows.length });
  }
  return copied;
}

/**
 * source と target を突き合わせる。行数だけでなく内容ハッシュも見る
 * （移行の受け入れ条件が「行数と内容ハッシュで照合」なので、片方だけでは足りない）。
 */
export async function verifyCopy(target: Db, source: Db): Promise<TableComparison[]> {
  const results: TableComparison[] = [];
  for (const { name, table, order } of TABLES) {
    const sourceRows = await readAll(source, table, order);
    const targetRows = await readAll(target, table, order);
    const sourceHash = await hashRows(sourceRows);
    const targetHash = await hashRows(targetRows);
    results.push({
      name,
      sourceRows: sourceRows.length,
      targetRows: targetRows.length,
      sourceHash,
      targetHash,
      matches: sourceRows.length === targetRows.length && sourceHash === targetHash,
    });
  }
  return results;
}
