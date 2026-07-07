import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { Result, ResultAsync } from "neverthrow";
import { AAD } from "@zakki/core/crypto/aad.ts";
import type { Db, DbHandle } from "@zakki/data/db/client.ts";
import type { CryptoContext } from "@zakki/data/db/crypto-context.ts";
import { getCrypto } from "@zakki/data/db/crypto-context.ts";
import type { DbError } from "@zakki/data/db/error.ts";
import { tryDbAsync } from "@zakki/data/db/error.ts";
import { chunks, chunkTags, links, tags } from "@zakki/data/db/schema.ts";
import { computeLinks, computeLinksFor } from "./linker.ts";
import { LruCache } from "./lru.ts";
import type { WritePlan } from "./plan.ts";
import { planWrites } from "./plan.ts";
import type { TagScore } from "./tagger.ts";
import { computeTags } from "./tagger.ts";
import { extractNouns } from "./tokenizer.ts";

export interface AnalysisSummary {
  taggedChunks: number;
  links: number;
}

/**
 * content → 名詞列のメモ（同一内容の再解析を避ける。プロセス内キャッシュ）。
 * 長寿命プロセス（web サーバ）での無制限成長を防ぐため LRU で上限化する（issue #54）。
 */
const nounCache = new LruCache<string, string[]>(1000);

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

/**
 * プロセス内スナップショットを破棄し、次回の解析パスを全量（{@link analyzeAll}）へ
 * フォールバックさせる（issue #55）。増分解析は「本プロセスが唯一のライタ」を前提に
 * 差分基準を持つため、外部書き込み（Turso sync の pull、RxDB replication のサーバ
 * 書き込み #42-#45）を取り込んだ直後に呼んで正を回復する。両経路で共有する単一の口。
 * nounCache は content キーの決定的メモ（値は content のみの関数）なので破棄しない。
 */
export function invalidateAnalysisSnapshot(db: Db): void {
  snapshots.delete(db);
}

/**
 * DbHandle.sync を包み、リモートの変更を実際に取り込んだ（pulled）場合にだけ
 * スナップショットを破棄する sync 関数を返す（issue #55）。no-op sync では増分の
 * まま（全量の無駄打ちをしない）。合成点（web bootstrap / TUI）は生の sync では
 * なくこれを使い、単一ライタ前提の破れを取り込み時点で塞ぐ。
 */
export function syncWithAnalysisReset(handle: DbHandle): () => Promise<Result<void, DbError>> {
  return async () => {
    const result = await handle.sync();
    return result.map((outcome) => {
      if (outcome.pulled) invalidateAnalysisSnapshot(handle.db);
    });
  };
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
    const stored = crypto === undefined ? name : crypto.encString(name, AAD.tagName);
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
 * DB に現在書き込まれているタグを「チャンク id → タグ列（平文名+スコア）」で読む。
 * 全量パスが plan の差分・bump 判定に使う旧状態（スナップショットに頼らない実体）。
 * 順序は computeTags と同じ（スコア降順・名前昇順）に揃え、tagListEquals での比較を
 * 決定的にする。暗号 ON はタグ名を復号する（全量パスは全 content を復号済みで、
 * 追加コストは無視できる）。
 */
async function readOldTags(
  db: Db,
  crypto: CryptoContext | undefined,
): Promise<Map<number, TagScore[]>> {
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

/** {@link planWrites} の出力を tx で機械的に適用する（全量・増分で共通の書き込み面）。 */
async function applyPlan(
  tx: Tx,
  crypto: CryptoContext | undefined,
  plan: WritePlan,
  now: string,
): Promise<void> {
  // タグ: 変わったチャンクだけ delete → insert（削除チャンク分は FK cascade 済み）。
  const idByName = await ensureTagIds(tx, crypto, plan.tagNames, now);
  for (const { chunkId, tags: tagList } of plan.tagRewrites) {
    await tx.delete(chunkTags).where(eq(chunkTags.chunkId, chunkId));
    for (const tag of tagList) {
      const tagId = idByName.get(tag.name);
      if (tagId !== undefined) {
        await tx.insert(chunkTags).values({ chunkId, tagId, score: tag.score });
      }
    }
  }
  // どのチャンクにも付かなくなったタグは削除する（乱立防止）
  await tx.run(sql`DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM chunk_tags)`);

  // リンク: 全量は全 auto を張り替え、増分は対象チャンクが関与する auto だけ張り替える。
  if (plan.relinkChunkIds === "all") {
    await tx.delete(links).where(eq(links.origin, "auto"));
  } else {
    for (const ids of batched(plan.relinkChunkIds, 200)) {
      await tx
        .delete(links)
        .where(
          and(
            eq(links.origin, "auto"),
            or(inArray(links.fromChunkId, ids), inArray(links.toChunkId, ids)),
          ),
        );
    }
  }
  for (const link of plan.insertLinks) {
    await tx
      .insert(links)
      .values({ ...link, origin: "auto" })
      .onConflictDoNothing();
  }

  // 極性: bump するチャンクは updatedAt も進める（差分取得が変更ノードを拾えるように）。
  for (const { chunkId, polarity, bump } of plan.polarityWrites) {
    const set = bump ? { polarity, updatedAt: now } : { polarity };
    await tx.update(chunks).set(set).where(eq(chunks.id, chunkId));
  }
}

/**
 * 全チャンクのタグ付けと関連付けを再計算して永続化する（docs/CONCEPT.md §3）。
 * 決定的・冪等な全量再計算で、「正」を回復する手段（CLI の stats など）。
 * 保存ごとのバックグラウンド解析には {@link analyzeChanged} を使う。
 */
export function analyzeAll(db: Db): ResultAsync<AnalysisSummary, DbError> {
  const crypto = getCrypto(db);
  return tryDbAsync(async () => {
    // 日付チャンク（構造ノード, content = 日付）は解析対象にしない
    const rawChunks = await db
      .select({
        id: chunks.id,
        content: chunks.content,
        updatedAt: chunks.updatedAt,
        polarity: chunks.polarity,
      })
      .from(chunks)
      .where(isNull(chunks.date));
    const oldPolarity = new Map(rawChunks.map((c) => [c.id, c.polarity]));
    // 解析（名詞抽出・極性）は平文に対して行う。暗号 ON は復号した content を使う。
    const states = new Map<number, ChunkState>();
    for (const c of rawChunks) {
      const content =
        crypto === undefined ? c.content : crypto.decString(c.content, AAD.chunkContent);
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
    // 旧タグは DB 実体から読む（全量パスは「正」の回復手段で、スナップショットに頼らない）。
    const oldTags = await readOldTags(db, crypto);
    const now = new Date().toISOString();

    // 極性（決定的, docs/FEATURES.md §整理・想起系 7）は全 content から算出する。
    const contentById = new Map([...states].map(([id, s]) => [id, s.content]));
    const plan = planWrites({
      newTags: tagsByChunk,
      oldTags,
      contentById,
      oldPolarity,
      changed: "all",
      links: linkCandidates,
    });
    await db.transaction((tx) => applyPlan(tx, crypto, plan, now));

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
 * （Turso sync の pull 等）を取り込んだ後は {@link invalidateAnalysisSnapshot} で
 * スナップショットを破棄し、次パスを全量へフォールバックさせて正を回復する（issue #55）。
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
    const idRows = await db
      .select({ id: chunks.id, updatedAt: chunks.updatedAt })
      .from(chunks)
      .where(isNull(chunks.date));
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
      const content = crypto === undefined ? stored : crypto.decString(stored, AAD.chunkContent);
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
    const linkCandidates = computeLinksFor(nounsByChunk, changed);

    // 極性は content のみの関数なので changed のチャンクだけ再計算する。旧極性も
    // changed に限って読む（変更ゼロのパスでは polarity 取得も発生しない）。
    const contentById = new Map([...changed].map((id) => [id, states.get(id)?.content ?? ""]));
    const oldPolarity = new Map<number, number | null>();
    for (const ids of batched([...changed], 200)) {
      const rows = await db
        .select({ id: chunks.id, polarity: chunks.polarity })
        .from(chunks)
        .where(inArray(chunks.id, ids));
      for (const row of rows) oldPolarity.set(row.id, row.polarity);
    }
    const now = new Date().toISOString();

    // 旧タグは前回のスナップショット（前回 chunk_tags に書いた内容）。増分パスは
    // 本プロセスが唯一のライタである前提で、DB を読み直さずスナップショットで差分を取る。
    const plan = planWrites({
      newTags: tagsByChunk,
      oldTags: snapshot.tags,
      contentById,
      oldPolarity,
      changed,
      links: linkCandidates,
    });
    await db.transaction((tx) => applyPlan(tx, crypto, plan, now));

    snapshots.set(db, { chunks: states, tags: tagsByChunk });
    return { taggedChunks: changed.size, links: linkCandidates.length };
  });
}
