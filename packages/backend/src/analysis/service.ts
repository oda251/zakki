import { and, eq, inArray, or, sql } from "drizzle-orm";
import type { ResultAsync } from "neverthrow";
import type { Db } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, chunkTags, links, tags } from "@zakki/data/db/schema.ts";
import { computeLinks, computeLinksFor } from "./linker.ts";
import { scoreSentiment } from "@zakki/core/analysis/sentiment.ts";
import type { TagScore } from "./tagger.ts";
import { computeTags } from "./tagger.ts";
import { extractNouns } from "./tokenizer.ts";

export interface AnalysisSummary {
  taggedChunks: number;
  links: number;
}

/** content → 名詞列のメモ（同一内容の再解析を避ける。プロセス内キャッシュ） */
const nounCache = new Map<string, string[]>();

function nounsOf(content: string): string[] {
  let nouns = nounCache.get(content);
  if (nouns === undefined) {
    nouns = extractNouns(content);
    nounCache.set(content, nouns);
  }
  return nouns;
}

/** 解析済みチャンク 1 件のプロセス内状態（増分検出と再解析回避に使う） */
interface ChunkState {
  updatedAt: string;
  /** DB 格納値（暗号 ON は暗号文）。updatedAt の同刻衝突に備えた第二の変化検知 */
  stored: string;
  /** 平文 content。暗号 ON でも平文を保持するのは nounCache と同水準の割り切り */
  content: string;
  nouns: readonly string[];
}

/**
 * 前回解析のプロセス内スナップショット（issue #24）。プロセスごとに
 * 「起動後初回は全量、以降は増分」で運用する（DB 側に解析メタは持たない）。
 * tags は前回 chunk_tags に書いた内容（平文名 + スコア）で、差分書き込みの基準。
 */
interface AnalysisSnapshot {
  chunks: Map<number, ChunkState>;
  tags: Map<number, TagScore[]>;
}

const snapshots = new WeakMap<Db, AnalysisSnapshot>();

/** 前回書き込んだタグ列と完全一致か（名前・スコア・順序。computeTags は決定的） */
function tagListEquals(a: readonly TagScore[], b: readonly TagScore[] | undefined): boolean {
  if (b === undefined || a.length !== b.length) return false;
  return a.every((t, i) => t.name === b[i]?.name && t.score === b[i]?.score);
}

/** SQL の IN 句パラメータ上限を避けるための分割 */
function batched<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

/** db.transaction のコールバック引数型（Db と同じクエリ面を持つ） */
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * tags テーブルへ名前を確保し、平文名 → tag id の対応を返す。
 * タグは平文名で一意化するが、格納は name=暗号文 / name_fingerprint=ブラインド
 * インデックス。暗号 OFF は fingerprint=平文名で従来どおりの重複排除になる。
 */
async function ensureTagIds(
  tx: Tx,
  crypto: CryptoContext | undefined,
  names: ReadonlySet<string>,
  now: string,
): Promise<Map<string, number | undefined>> {
  const fpOf = (name: string) => (crypto === undefined ? name : crypto.fingerprint(name));
  for (const name of names) {
    const stored = crypto === undefined ? name : crypto.encString(name, "tag.name");
    await tx
      .insert(tags)
      .values({ name: stored, nameFingerprint: fpOf(name), createdAt: now })
      .onConflictDoNothing({ target: tags.nameFingerprint });
  }
  // 平文タグ名 → id を引けるよう fingerprint で突き合わせる。今回必要な
  // fingerprint だけを IN 句で引き、tags 全件スキャンを避ける（増分解析での負荷対策）
  const fingerprints = [...names].map(fpOf);
  const idByFingerprint = new Map<string, number>();
  for (const fps of batched(fingerprints, 200)) {
    const rows = await tx
      .select({ id: tags.id, nameFingerprint: tags.nameFingerprint })
      .from(tags)
      .where(inArray(tags.nameFingerprint, fps));
    for (const row of rows) idByFingerprint.set(row.nameFingerprint, row.id);
  }
  return new Map([...names].map((name) => [name, idByFingerprint.get(fpOf(name))]));
}

/**
 * 全チャンクのタグ付けと関連付けを再計算して永続化する（docs/CONCEPT.md §3）。
 * 決定的・冪等な全量再計算で、「正」を回復する手段（CLI の stats など）。
 * 保存ごとのバックグラウンド解析には {@link analyzeChanged} を使う。
 */
export function analyzeAll(db: Db): ResultAsync<AnalysisSummary, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    const rawChunks = await db
      .select({ id: chunks.id, content: chunks.content, updatedAt: chunks.updatedAt })
      .from(chunks);
    // 解析（名詞抽出・極性）は平文に対して行う。暗号 ON は復号した content を使う。
    const states = new Map<number, ChunkState>();
    for (const c of rawChunks) {
      const content =
        crypto === undefined ? c.content : crypto.decString(c.content, "chunk.content");
      states.set(c.id, {
        updatedAt: c.updatedAt,
        stored: c.content,
        content,
        nouns: nounsOf(content),
      });
    }

    const nounsByChunk = new Map([...states].map(([id, s]) => [id, s.nouns]));
    const tagsByChunk = computeTags(nounsByChunk);
    const linkCandidates = computeLinks(nounsByChunk);
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      const names = new Set([...tagsByChunk.values()].flat().map((t) => t.name));
      const idByName = await ensureTagIds(tx, crypto, names, now);

      await tx.delete(chunkTags);
      for (const [chunkId, tagList] of tagsByChunk) {
        for (const tag of tagList) {
          const tagId = idByName.get(tag.name);
          if (tagId !== undefined) {
            await tx.insert(chunkTags).values({ chunkId, tagId, score: tag.score });
          }
        }
      }
      // どのチャンクにも付かなくなったタグは削除する（乱立防止）
      await tx.run(sql`DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM chunk_tags)`);

      await tx.delete(links).where(eq(links.origin, "auto"));
      for (const link of linkCandidates) {
        await tx
          .insert(links)
          .values({ ...link, origin: "auto" })
          .onConflictDoNothing();
      }

      // ネガポジ極性（決定的, docs/FEATURES.md §整理・想起系 7）を算出して永続化する
      for (const [chunkId, state] of states) {
        await tx
          .update(chunks)
          .set({ polarity: scoreSentiment(state.content) })
          .where(eq(chunks.id, chunkId));
      }
    });

    snapshots.set(db, { chunks: states, tags: tagsByChunk });
    return { taggedChunks: tagsByChunk.size, links: linkCandidates.length };
  });
}

/**
 * 変更されたチャンクだけを再解析する増分パス（issue #24）。適用後の DB 状態は
 * {@link analyzeAll} の全量再計算と一致する（差分書き込みのみで達成）。
 * スナップショットが無い（起動後初回）は analyzeAll に委譲する。
 *
 * 前提: 本プロセス・本 Db インスタンスが唯一のライタであること。外部書き込み
 * （将来の Turso 同期など）を取り込んだ後は analyzeAll で正を回復すること。
 *
 * @returns taggedChunks = 再解析した変更チャンク数、links = 張り替えたリンク数
 */
export function analyzeChanged(db: Db): ResultAsync<AnalysisSummary, DbError> {
  const snapshot = snapshots.get(db);
  if (snapshot === undefined) {
    return analyzeAll(db);
  }
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    // 第 1 段: id + updatedAt だけを取得し、スナップショットとの比較で「動いた候補」を
    // 絞る。updatedAt が一致する行は content を取得しない（変更ゼロのパスでは
    // content 転送が一切発生しない）
    const idRows = await db.select({ id: chunks.id, updatedAt: chunks.updatedAt }).from(chunks);
    const candidateIds = idRows
      .filter((row) => {
        const prev = snapshot.chunks.get(row.id);
        return prev === undefined || prev.updatedAt !== row.updatedAt;
      })
      .map((row) => row.id);

    // 第 2 段: 候補行だけ content を追加取得する
    const storedById = new Map<number, string>();
    for (const ids of batched(candidateIds, 200)) {
      const rows = await db
        .select({ id: chunks.id, content: chunks.content })
        .from(chunks)
        .where(inArray(chunks.id, ids));
      for (const row of rows) storedById.set(row.id, row.content);
    }

    const states = new Map<number, ChunkState>();
    const changed = new Set<number>();
    for (const row of idRows) {
      const prev = snapshot.chunks.get(row.id);
      const stored = storedById.get(row.id);
      if (stored === undefined) {
        // 候補外 = updatedAt 一致。単一ライタ前提の下では内容も不変とみなす
        if (prev !== undefined) states.set(row.id, prev);
        continue;
      }
      // stored 比較（候補に対する第二の変化検知）。updatedAt は動いたが格納バイト列が
      // 一致するなら内容は不変（暗号 OFF での同一内容再保存など）で復号もスキップ
      if (prev !== undefined && prev.stored === stored) {
        states.set(row.id, {
          updatedAt: row.updatedAt,
          stored,
          content: prev.content,
          nouns: prev.nouns,
        });
        continue;
      }
      const content = crypto === undefined ? stored : crypto.decString(stored, "chunk.content");
      if (prev !== undefined && prev.content === content) {
        // 再保存で updatedAt だけ進んだ（内容は同一）。名詞列を引き継ぎ変更扱いにしない
        states.set(row.id, { updatedAt: row.updatedAt, stored, content, nouns: prev.nouns });
        continue;
      }
      states.set(row.id, { updatedAt: row.updatedAt, stored, content, nouns: nounsOf(content) });
      changed.add(row.id);
    }
    let removedCount = 0;
    for (const id of snapshot.chunks.keys()) {
      if (!states.has(id)) removedCount += 1;
    }

    if (changed.size === 0 && removedCount === 0) {
      snapshots.set(db, { chunks: states, tags: snapshot.tags });
      return { taggedChunks: 0, links: 0 };
    }

    const nounsByChunk = new Map([...states].map(([id, s]) => [id, s.nouns]));
    const tagsByChunk = computeTags(nounsByChunk);
    const dirtyTagChunks = [...tagsByChunk]
      .filter(([id, list]) => !tagListEquals(list, snapshot.tags.get(id)))
      .map(([id]) => id);
    const linkCandidates = computeLinksFor(nounsByChunk, changed);
    const now = new Date().toISOString();

    await db.transaction(async (tx) => {
      // タグ: 変わったチャンク分だけ delete → insert（削除チャンク分は FK cascade 済み）
      const names = new Set(
        dirtyTagChunks.flatMap((id) => (tagsByChunk.get(id) ?? []).map((t) => t.name)),
      );
      const idByName = await ensureTagIds(tx, crypto, names, now);
      for (const chunkId of dirtyTagChunks) {
        await tx.delete(chunkTags).where(eq(chunkTags.chunkId, chunkId));
        for (const tag of tagsByChunk.get(chunkId) ?? []) {
          const tagId = idByName.get(tag.name);
          if (tagId !== undefined) {
            await tx.insert(chunkTags).values({ chunkId, tagId, score: tag.score });
          }
        }
      }
      // どのチャンクにも付かなくなったタグは削除する（乱立防止）
      await tx.run(sql`DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM chunk_tags)`);

      // リンク: 変更チャンクが関与する auto リンクだけ張り替える
      for (const ids of batched([...changed], 200)) {
        await tx
          .delete(links)
          .where(
            and(
              eq(links.origin, "auto"),
              or(inArray(links.fromChunkId, ids), inArray(links.toChunkId, ids)),
            ),
          );
      }
      for (const link of linkCandidates) {
        await tx
          .insert(links)
          .values({ ...link, origin: "auto" })
          .onConflictDoNothing();
      }

      // 極性は content のみの関数なので変更チャンクだけ更新する
      for (const chunkId of changed) {
        const state = states.get(chunkId);
        if (state === undefined) continue;
        await tx
          .update(chunks)
          .set({ polarity: scoreSentiment(state.content) })
          .where(eq(chunks.id, chunkId));
      }
    });

    snapshots.set(db, { chunks: states, tags: tagsByChunk });
    return { taggedChunks: changed.size, links: linkCandidates.length };
  });
}
